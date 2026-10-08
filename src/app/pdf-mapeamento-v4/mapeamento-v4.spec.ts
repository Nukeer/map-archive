import { TokenPdf } from '../pdf-mapeamento/pdf-mapeamento.model';
import { MapeamentoPdfV2, construirCampoV2 } from '../pdf-mapeamento-v2/mapeamento-v2';
import { converterParaPlanilha } from '../pdf-mapeamento-v2/planilha';
import { MapeamentoSalvo } from '../armazenamento/mapeamentos-db.service';
import { identificarDocumento, verificarDocumento } from '../match/match';
import { MapeamentoPdfV3, gerarAssinatura, modulo10, similaridadeLayout } from '../pdf-mapeamento-v3/mapeamento-v3';
import { MapeamentoPdfV4, ModeloV4, gerarAssinaturaV4, sugerirTermos, testarNosModelos } from './mapeamento-v4';

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

function linhaArrecadacao(orgao: string, centavos: number): string {
  const resto = String(centavos).padStart(11, '0') + orgao + '2026090112345678901234567';
  const codigo = '856' + modulo10('856' + resto) + resto;
  return [0, 1, 2, 3]
    .map(i => codigo.slice(i * 11, i * 11 + 11))
    .map(b => `${b}-${modulo10(b)}`)
    .join(' ');
}

interface Guia {
  empresa: string;
  cnpj: string;
  competencia: string;
  valor: string;
  centavos: number;
  orgao?: string;
  /** Desloca a página inteira (margem diferente), em pontos. */
  dx?: number;
}

function darf({ empresa, cnpj, competencia, valor, centavos, orgao = '0064', dx = 0 }: Guia): TokenPdf[] {
  const t = (y: number, x: number, texto: string): Trecho => [y, x + dx, texto];
  return tokens(
    t(50, 50, 'RECEITA FEDERAL'),
    t(70, 50, 'DOCUMENTO DE ARRECADAÇÃO'),
    t(90, 50, 'Ministério da Fazenda'),
    t(110, 50, 'Nome / Telefone'),
    t(110, 150, empresa),
    t(130, 50, 'CNPJ:'),
    t(130, 150, cnpj),
    t(150, 50, `Período de apuração: ${competencia}`),
    t(170, 50, 'Código da Receita'),
    t(200, 50, 'Principal'),
    t(200, 250, 'Total'),
    t(215, 50, valor),
    t(215, 250, valor),
    t(260, 50, 'Número do documento'),
    t(280, 50, 'Pague nos bancos autorizados'),
    t(300, 50, linhaArrecadacao(orgao, centavos)),
  );
}

const guias: Guia[] = [
  { empresa: 'ALFA COMERCIO LTDA', cnpj: '11.222.333/0001-81', competencia: '09/2026', valor: '1.100,00', centavos: 110000 },
  { empresa: 'BETA SERVICOS ME', cnpj: '11.444.777/0001-61', competencia: '08/2026', valor: '2.345,67', centavos: 234567, dx: 12 },
  { empresa: 'GAMA INDUSTRIA SA', cnpj: '11.222.333/0001-81', competencia: '07/2026', valor: '99,90', centavos: 9990 },
];

const modelo = (g: Guia, nome: string): ModeloV4 => ({ nome, planilha: converterParaPlanilha(darf(g), DIMENSOES), dimensoes: DIMENSOES });
const modelos = guias.map((g, i) => modelo(g, `modelo${i + 1}.pdf`));

/** Campos e termos marcados no 1º modelo, como o modal v2 faria. */
function base(): MapeamentoPdfV2 {
  const p = modelos[0].planilha;
  const campo = (tipo: 'cnpj' | 'competencia' | 'valor', texto: string) => {
    const celulas = p.celulas.filter(c => c.texto === texto);
    const alvo = celulas[celulas.length - 1].id;
    return construirCampoV2(p, tipo, alvo, alvo).campo!;
  };
  return {
    versao: 2,
    nome: 'DARF',
    cnpj: campo('cnpj', '11.222.333/0001-81'),
    competencia: campo('competencia', 'Período de apuração: 09/2026'),
    valor: campo('valor', '1.100,00'),
    termos: [
      { texto: 'RECEITA FEDERAL', celula: { pagina: 1, linha: 1, coluna: 0 } },
      { texto: 'DOCUMENTO DE ARRECADAÇÃO', celula: { pagina: 1, linha: 2, coluna: 0 } },
    ],
  };
}

function registroV4(lista = modelos, nome = 'DARF'): MapeamentoSalvo {
  const mapeamento: MapeamentoPdfV4 = {
    ...base(),
    versao: 4,
    nome,
    assinatura: gerarAssinaturaV4(lista).assinatura,
    exclusoes: [],
    arquivosModelo: lista.map(m => m.nome),
  };
  return { id: `${nome}-v4`, versao: 4, nome, criadoEm: '', atualizadoEm: '', mapeamento };
}

function registroV3(): MapeamentoSalvo {
  const mapeamento: MapeamentoPdfV3 = {
    ...base(),
    versao: 3,
    assinatura: gerarAssinatura(modelos[0].planilha, DIMENSOES),
    exclusoes: [],
  };
  return { id: 'v3', versao: 3, nome: 'DARF', criadoEm: '', atualizadoEm: '', mapeamento };
}

const sinal = (r: ReturnType<typeof verificarDocumento>, chave: string) => r.avaliacao!.sinais.find(s => s.chave === chave)!;

const novaGuia = darf({ empresa: 'DELTA TRANSPORTES EIRELI', cnpj: '11.444.777/0001-61', competencia: '06/2026', valor: '3.210,00', centavos: 321000 });

describe('mapeamento v4', () => {
  describe('assinatura', () => {
    const { assinatura, avisos } = gerarAssinaturaV4(modelos);

    it('separa rótulos estáveis dos que variam entre os modelos', () => {
      expect(assinatura.rotulos).toContain('ministerio da fazenda');
      expect(assinatura.rotulos).toContain('nome / telefone');
      expect(assinatura.rotulos).not.toContain('alfa comercio ltda');
      expect(assinatura.rotulosVariaveis).toEqual(jasmine.arrayContaining(['alfa comercio ltda', 'beta servicos me', 'gama industria sa']));
      expect(assinatura.rotulosConhecidos.length).toBe(assinatura.rotulos.length + assinatura.rotulosVariaveis.length);
      expect(assinatura.modelos).toBe(3);
      expect(avisos).toEqual([]);
    });

    it('guarda o código de barras comum a todos os modelos', () => {
      expect(assinatura.codigoBarras).toEqual({ tipo: 'arrecadacao', segmento: '5', emissor: '0064' });
    });

    it('aprende a posição dos rótulos descontando o deslocamento da página', () => {
      const ministerio = assinatura.geometria.find(g => g.texto === 'ministerio da fazenda')!;
      expect(ministerio).toBeDefined();
      // O 2º modelo está 12pt à direita; sem descontar, a tolerância passaria de 0,015.
      expect(ministerio.tolerancia).toBe(0.015);
      expect(assinatura.geometria.length).toBeGreaterThanOrEqual(5);
    });

    it('desativa o código de barras quando os modelos discordam', () => {
      const outro = modelo({ ...guias[1], orgao: '0328' }, 'das.pdf');
      const r = gerarAssinaturaV4([modelos[0], outro]);
      expect(r.assinatura.codigoBarras).toBeUndefined();
      expect(r.avisos.length).toBe(1);
    });
  });

  it('confere o mapeamento em cada modelo', () => {
    const testes = testarNosModelos(base(), modelos);
    expect(testes.every(t => t.ok)).toBeTrue();
    expect(testes[1].campos.map(c => c.valor)).toEqual(['11.444.777/0001-61', '08/2026', '2345.67']);
  });

  it('sugere rótulos estáveis como termos', () => {
    const { assinatura } = gerarAssinaturaV4(modelos);
    const sugestoes = sugerirTermos(assinatura, modelos[0].planilha, base().termos).map(s => s.texto);
    expect(sugestoes).toContain('Pague nos bancos autorizados');
    expect(sugestoes).not.toContain('RECEITA FEDERAL');
    expect(sugestoes).not.toContain('ALFA COMERCIO LTDA');
  });

  describe('match', () => {
    it('aceita guia de outra empresa com layout mais parecido que na v3', () => {
      const v4 = verificarDocumento(registroV4(), novaGuia, DIMENSOES);
      expect(v4.avaliacao!.veredito).toBe('corresponde');
      expect(v4.campos.map(c => c.valor)).toEqual(['11.444.777/0001-61', '06/2026', '3210.00']);
      // O nome da empresa do modelo não conta mais como rótulo que "faltou".
      const planilha = converterParaPlanilha(novaGuia, DIMENSOES);
      const a4 = (registroV4().mapeamento as MapeamentoPdfV4).assinatura;
      const a3 = (registroV3().mapeamento as MapeamentoPdfV3).assinatura;
      expect(similaridadeLayout(a4.rotulos, planilha, a4.rotulosConhecidos).cobertura).toBe(1);
      expect(similaridadeLayout(a3.rotulos, planilha).cobertura).toBeLessThan(1);
      expect(sinal(v4, 'geometria').nota).toBe(1);
    });

    it('tolera a página inteira deslocada', () => {
      const deslocada = darf({ ...guias[0], empresa: 'OMEGA LTDA', dx: 40 });
      const r = verificarDocumento(registroV4(), deslocada, DIMENSOES);
      expect(sinal(r, 'geometria').nota).toBe(1);
      expect(r.corresponde).toBeTrue();
    });

    it('percebe os mesmos textos em outra disposição', () => {
      const embaralhado = tokens(
        [50, 300, 'RECEITA FEDERAL'],
        [400, 50, 'DOCUMENTO DE ARRECADAÇÃO'],
        [90, 350, 'Ministério da Fazenda'],
        [500, 300, 'Nome / Telefone'],
        [130, 50, 'CNPJ: 11.444.777/0001-61'],
        [150, 50, 'Período de apuração: 06/2026'],
        [600, 50, 'Código da Receita'],
        [650, 300, 'Principal'],
        [200, 400, 'Total'],
        [215, 400, '3.210,00'],
        [700, 300, 'Número do documento'],
        [20, 50, 'Pague nos bancos autorizados'],
      );
      const r = verificarDocumento(registroV4(), embaralhado, DIMENSOES);
      expect(sinal(r, 'geometria').nota).toBe(-1);
      expect(r.corresponde).toBeFalse();
    });

    it('entra na identificação automática junto com a v3', () => {
      const ranking = identificarDocumento([registroV3(), registroV4()], novaGuia, DIMENSOES);
      expect(ranking.map(r => r.mapeamento.versao)).toEqual(jasmine.arrayWithExactContents([3, 4]));
      expect(ranking.every(r => r.corresponde)).toBeTrue();
    });
  });
});
