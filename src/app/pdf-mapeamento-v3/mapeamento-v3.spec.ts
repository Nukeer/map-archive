import { TokenPdf } from '../pdf-mapeamento/pdf-mapeamento.model';
import { construirCampoV2 } from '../pdf-mapeamento-v2/mapeamento-v2';
import { converterParaPlanilha } from '../pdf-mapeamento-v2/planilha';
import { MapeamentoSalvo } from '../armazenamento/mapeamentos-db.service';
import { identificarDocumento, verificarDocumento } from '../match/match';
import {
  MapeamentoPdfV3,
  cnpjValido,
  competenciaValida,
  gerarAssinatura,
  lerCodigoBarras,
  modulo10,
  modulo11Boleto,
} from './mapeamento-v3';

const DIMENSOES = [{ largura: 600, altura: 800 }];

/** Texto posicionado: [y (pt), x (pt), texto]. */
type Trecho = [number, number, string];

function tokens(...trechos: Trecho[]): TokenPdf[] {
  const lista: TokenPdf[] = [];
  const linhas = [...new Set(trechos.map(t => t[0]))].sort((a, b) => a - b);
  for (const [trecho, [y, x, texto]] of [...trechos].sort((a, b) => a[0] - b[0] || a[1] - b[1]).entries()) {
    let cursor = x;
    for (const palavra of texto.split(' ')) {
      lista.push({
        indice: lista.length,
        pagina: 1,
        linha: linhas.indexOf(y),
        trecho,
        texto: palavra,
        caixa: { x: cursor / 600, y: y / 800, largura: (palavra.length * 5) / 600, altura: 11.5 / 800 },
      });
      cursor += (palavra.length + 1) * 5;
    }
  }
  return lista;
}

const planilha = (...trechos: Trecho[]) => converterParaPlanilha(tokens(...trechos), DIMENSOES);

/** Linha digitável de arrecadação válida (valor efetivo, DV módulo 10), como aparece impressa. */
function linhaArrecadacao(segmento: string, orgao: string, centavos: number): string {
  const resto = String(centavos).padStart(11, '0') + orgao + '2026090112345678901234567';
  const codigo = '8' + segmento + '6' + modulo10('8' + segmento + '6' + resto) + resto;
  return [0, 1, 2, 3]
    .map(i => codigo.slice(i * 11, i * 11 + 11))
    .map(b => `${b}-${modulo10(b)}`)
    .join(' ');
}

/** Linha digitável de boleto válida. */
function linhaBoleto(banco: string, centavos: number): string {
  const livre = '1234567890123456789012345';
  const fatorValor = '9999' + String(centavos).padStart(10, '0');
  const dvGeral = modulo11Boleto(banco + '9' + fatorValor + livre);
  const campo = (s: string) => s + modulo10(s);
  return [campo(banco + '9' + livre.slice(0, 5)), campo(livre.slice(5, 15)), campo(livre.slice(15, 25)), dvGeral, fatorValor].join(' ');
}

describe('mapeamento v3', () => {
  describe('código de barras', () => {
    it('lê linha digitável de arrecadação com hífens e espaços', () => {
      const r = lerCodigoBarras(planilha([50, 50, 'Pague até 30/09/2026'], [300, 50, linhaArrecadacao('5', '0064', 110000)]));
      expect(r).toEqual(jasmine.objectContaining({ tipo: 'arrecadacao', segmento: '5', emissor: '0064', valor: '1100.00' }));
      expect(r!.codigo.length).toBe(44);
    });

    it('lê linha digitável de boleto', () => {
      const r = lerCodigoBarras(planilha([300, 50, linhaBoleto('001', 5000)]));
      expect(r).toEqual(jasmine.objectContaining({ tipo: 'boleto', emissor: '001', valor: '50.00' }));
    });

    it('recusa sequência com dígito verificador errado', () => {
      const linha = linhaArrecadacao('5', '0064', 110000);
      const errada = linha.slice(0, 12) + ((Number(linha[12]) + 1) % 10) + linha.slice(13);
      expect(lerCodigoBarras(planilha([300, 50, errada]))).toBeNull();
    });

    it('não confunde CNPJ e valores com código de barras', () => {
      expect(lerCodigoBarras(planilha([50, 50, '11.222.333/0001-81 1.100,00 12345678901234']))).toBeNull();
    });
  });

  it('valida CNPJ e competência', () => {
    expect(cnpjValido('11.222.333/0001-81')).toBeTrue();
    expect(cnpjValido('11.222.333/0001-82')).toBeFalse();
    expect(cnpjValido('11.111.111/1111-11')).toBeFalse();
    const hoje = new Date(2026, 9, 2);
    expect(competenciaValida('09/2026', hoje)).toBeTrue();
    expect(competenciaValida('13/2026', hoje)).toBeFalse();
    expect(competenciaValida('01/1990', hoje)).toBeFalse();
    expect(competenciaValida('01/2030', hoje)).toBeFalse();
  });

  describe('match por score', () => {
    function darf(cnpj: string, competencia: string, valor: string, linha: string, ...extras: Trecho[]): TokenPdf[] {
      return tokens(
        [50, 50, 'RECEITA FEDERAL'],
        [70, 50, 'DOCUMENTO DE ARRECADAÇÃO'],
        [90, 50, 'Ministério da Fazenda'],
        [120, 50, 'CNPJ:'],
        [120, 150, cnpj],
        [140, 50, `Período de apuração: ${competencia}`],
        [160, 50, 'Código da Receita'],
        [200, 50, 'Principal'],
        [200, 250, 'Total'],
        [215, 50, valor],
        [215, 250, valor],
        [260, 50, 'Número do documento'],
        [280, 50, 'Pague nos bancos autorizados'],
        [300, 50, linha],
        ...extras,
      );
    }

    const modelo = darf('11.222.333/0001-81', '09/2026', '1.100,00', linhaArrecadacao('5', '0064', 110000));

    function registro(exclusoes: string[] = [], exemplo = modelo, nome = 'DARF'): MapeamentoSalvo {
      const p = converterParaPlanilha(exemplo, DIMENSOES);
      const campo = (tipo: 'cnpj' | 'competencia' | 'valor', texto: string) => {
        const celulas = p.celulas.filter(c => c.texto === texto);
        const alvo = celulas[celulas.length - 1].id;
        return construirCampoV2(p, tipo, alvo, alvo).campo!;
      };
      const mapeamento: MapeamentoPdfV3 = {
        versao: 3,
        nome,
        cnpj: campo('cnpj', '11.222.333/0001-81'),
        competencia: campo('competencia', 'Período de apuração: 09/2026'),
        valor: campo('valor', '1.100,00'),
        termos: [
          { texto: 'RECEITA FEDERAL', celula: { pagina: 1, linha: 1, coluna: 0 } },
          { texto: 'DOCUMENTO DE ARRECADAÇÃO', celula: { pagina: 1, linha: 2, coluna: 0 } },
        ],
        assinatura: gerarAssinatura(p, DIMENSOES),
        exclusoes,
      };
      return { id: nome, versao: 3, nome, criadoEm: '', atualizadoEm: '', mapeamento };
    }

    const sinal = (r: ReturnType<typeof verificarDocumento>, chave: string) => r.avaliacao!.sinais.find(s => s.chave === chave)!;

    it('gera assinatura com código de barras e rótulos do layout', () => {
      const a = (registro().mapeamento as MapeamentoPdfV3).assinatura;
      expect(a.codigoBarras).toEqual({ tipo: 'arrecadacao', segmento: '5', emissor: '0064' });
      expect(a.rotulos).toContain('ministerio da fazenda');
      expect(a.rotulos).not.toContain('11.222.333/0001-81');
      expect(a.paginas).toBe(1);
    });

    it('aceita outra guia do mesmo tipo com confiança alta', () => {
      const outro = darf('11.444.777/0001-61', '08/2026', '2.345,67', linhaArrecadacao('5', '0064', 234567));
      const r = verificarDocumento(registro(), outro, DIMENSOES);
      expect(r.avaliacao!.veredito).toBe('corresponde');
      expect(r.corresponde).toBeTrue();
      expect(r.avaliacao!.confianca).toBeGreaterThan(0.95);
      expect(r.campos.map(c => c.valor)).toEqual(['11.444.777/0001-61', '08/2026', '2345.67']);
      expect(sinal(r, 'valorCodigo').nota).toBe(1);
    });

    it('reprova guia com mesmos termos mas outro órgão no código de barras', () => {
      const das = darf('11.444.777/0001-61', '08/2026', '2.345,67', linhaArrecadacao('5', '0328', 234567));
      const r = verificarDocumento(registro(), das, DIMENSOES);
      expect(r.termos.every(t => t.encontrado)).toBeTrue();
      expect(r.avaliacao!.veredito).toBe('nao');
      expect(sinal(r, 'codigoBarras').eliminatorio).toBeTrue();
    });

    it('reprova quando aparece um termo de exclusão', () => {
      const das = darf('11.444.777/0001-61', '08/2026', '2.345,67', linhaArrecadacao('5', '0064', 234567), [330, 50, 'Simples Nacional']);
      const r = verificarDocumento(registro(['Simples Nacional']), das, DIMENSOES);
      expect(r.avaliacao!.veredito).toBe('nao');
      expect(sinal(r, 'exclusoes').nota).toBe(-1);
    });

    it('aponta valor diferente do código de barras sem reprovar', () => {
      const outro = darf('11.444.777/0001-61', '08/2026', '2.345,67', linhaArrecadacao('5', '0064', 999));
      const r = verificarDocumento(registro(), outro, DIMENSOES);
      expect(sinal(r, 'valorCodigo').nota).toBe(-1);
      expect(r.avaliacao!.veredito).toBe('corresponde');
    });

    it('fica em dúvida quando só os termos batem', () => {
      const parecido = tokens(
        [50, 50, 'RECEITA FEDERAL'],
        [70, 50, 'DOCUMENTO DE ARRECADAÇÃO'],
        [100, 50, 'Extrato de débitos'],
        [120, 50, 'CNPJ:'],
        [120, 150, '11.444.777/0001-61'],
        [140, 50, 'Período de apuração: 08/2026'],
        [170, 50, 'Tributos devidos no período'],
        [200, 50, 'Observações gerais'],
        [200, 250, 'Total'],
        [215, 250, '2.345,67'],
        [260, 50, 'Instruções para recolhimento'],
      );
      const r = verificarDocumento(registro(), parecido, DIMENSOES);
      expect(r.avaliacao!.veredito).toBe('duvidoso');
      expect(r.corresponde).toBeFalse();
    });

    it('reprova boleto', () => {
      const boleto = tokens([50, 50, 'BANCO EXEMPLO S.A.'], [70, 50, 'Beneficiário CNPJ: 11.222.333/0001-81'], [90, 50, 'Valor 50,00'], [300, 50, linhaBoleto('001', 5000)]);
      const r = verificarDocumento(registro(), boleto, DIMENSOES);
      expect(r.avaliacao!.veredito).toBe('nao');
      expect(sinal(r, 'codigoBarras').nota).toBe(-1);
    });

    it('identifica automaticamente o tipo entre vários mapeamentos v3', () => {
      const modeloDas = darf('11.222.333/0001-81', '09/2026', '1.100,00', linhaArrecadacao('5', '0328', 110000));
      const registros = [registro(), registro([], modeloDas, 'DAS'), { ...registro(), id: 'v2', versao: 2 as const }];
      const das = darf('11.444.777/0001-61', '08/2026', '2.345,67', linhaArrecadacao('5', '0328', 234567));
      const ranking = identificarDocumento(registros, das, DIMENSOES);
      // O registro v2 fica de fora: só a v3 tem score comparável.
      expect(ranking.map(r => r.mapeamento.nome)).toEqual(['DAS', 'DARF']);
      expect(ranking[0].corresponde).toBeTrue();
      expect(ranking[1].avaliacao!.veredito).toBe('nao');
    });
  });
});
