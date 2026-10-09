import { TokenPdf } from '../pdf-mapeamento/pdf-mapeamento.model';
import { MapeamentoPdfV2, construirCampoV2 } from '../pdf-mapeamento-v2/mapeamento-v2';
import { converterParaPlanilha } from '../pdf-mapeamento-v2/planilha';
import { MapeamentoSalvo } from '../armazenamento/mapeamentos-db.service';
import { identificarDocumento, verificarDocumento } from '../match/match';
import { modulo10 } from '../pdf-mapeamento-v3/mapeamento-v3';
import { MapeamentoPdfV4, gerarAssinaturaV4 } from '../pdf-mapeamento-v4/mapeamento-v4';
import { AparenciaPdf, BITS_MAPA, LARGURA_MINIATURA, mapaDeBordas, normalizarFonte, normalizarProdutor, paraBits, paraHex } from './aparencia';
import { MapeamentoPdfV5, ModeloV5, avaliarVisual, compararComOutrosTipos, gerarAssinaturaV5, outrosTipos } from './mapeamento-v5';

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
}

function darf({ empresa, cnpj, competencia, valor, centavos }: Guia): TokenPdf[] {
  return tokens(
    [50, 50, 'RECEITA FEDERAL'],
    [70, 50, 'DOCUMENTO DE ARRECADAÇÃO'],
    [90, 50, 'Ministério da Fazenda'],
    [110, 50, 'Nome / Telefone'],
    [110, 150, empresa],
    [130, 50, 'CNPJ:'],
    [130, 150, cnpj],
    [150, 50, `Período de apuração: ${competencia}`],
    [170, 50, 'Código da Receita'],
    [200, 50, 'Principal'],
    [200, 250, 'Total'],
    [215, 50, valor],
    [215, 250, valor],
    [260, 50, 'Número do documento'],
    [280, 50, 'Pague nos bancos autorizados'],
    [300, 50, linhaArrecadacao('0064', centavos)],
  );
}

// ---- Desenho: formulários de 595 × 842 pt desenhados num canvas, como o pdf.js faria ----

type Caixa = [number, number, number, number];

const caixasDarf: Caixa[] = [
  [30, 30, 535, 380],
  [30, 30, 300, 120],
  [30, 150, 300, 260],
  ...[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i): Caixa => [330, 30 + i * 42, 235, 42]),
];
const caixasDas: Caixa[] = [
  [40, 60, 515, 60],
  [40, 140, 515, 200],
  [40, 360, 250, 120],
  [305, 360, 250, 120],
  [40, 500, 515, 80],
];

function desenhar(caixas: Caixa[], textos: Array<[number, number, string]>): string {
  const escala = LARGURA_MINIATURA / 595;
  const canvas = document.createElement('canvas');
  canvas.width = LARGURA_MINIATURA;
  canvas.height = Math.ceil(842 * escala);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(escala, escala);
  ctx.lineWidth = 1.5;
  for (const [x, y, w, h] of caixas) ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = '#000';
  ctx.font = '10px sans-serif';
  for (const [x, y, t] of textos) ctx.fillText(t, x, y);
  return mapaDeBordas(ctx.getImageData(0, 0, canvas.width, canvas.height));
}

const textosDarf = (g: Guia): Array<[number, number, string]> => [
  [40, 50, 'RECEITA FEDERAL'],
  [40, 180, g.empresa],
  [340, 55, g.cnpj],
  [340, 97, g.competencia],
  [340, 139, g.valor],
];

const aparenciaDarf = (g: Guia, extra: Partial<AparenciaPdf> = {}): AparenciaPdf => ({
  hash: desenhar(caixasDarf, textosDarf(g)),
  fontes: ['helvetica', 'helvetica-bold'],
  produtor: 'sicalc',
  ...extra,
});

const guias: Guia[] = [
  { empresa: 'ALFA COMERCIO LTDA', cnpj: '11.222.333/0001-81', competencia: '09/2026', valor: '1.100,00', centavos: 110000 },
  { empresa: 'BETA SERVICOS ME', cnpj: '11.444.777/0001-61', competencia: '08/2026', valor: '2.345,67', centavos: 234567 },
  { empresa: 'GAMA INDUSTRIA SA', cnpj: '11.222.333/0001-81', competencia: '07/2026', valor: '99,90', centavos: 9990 },
];
const nova: Guia = { empresa: 'DELTA TRANSPORTES EIRELI', cnpj: '11.444.777/0001-61', competencia: '06/2026', valor: '3.210,00', centavos: 321000 };

const modelo = (g: Guia, nome: string, aparencia: AparenciaPdf | null = aparenciaDarf(g)): ModeloV5 => ({
  nome,
  planilha: converterParaPlanilha(darf(g), DIMENSOES),
  dimensoes: DIMENSOES,
  aparencia,
});
const modelos = guias.map((g, i) =>
  // O 2º modelo usa uma fonte a mais: fica nas conhecidas, mas não nas comuns.
  modelo(g, `modelo${i + 1}.pdf`, aparenciaDarf(g, i === 1 ? { fontes: ['helvetica', 'helvetica-bold', 'courier'] } : {})),
);

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

function registroV5(): MapeamentoSalvo {
  const mapeamento: MapeamentoPdfV5 = {
    ...base(),
    versao: 5,
    assinatura: gerarAssinaturaV5(modelos).assinatura,
    exclusoes: [],
    arquivosModelo: modelos.map(m => m.nome),
  };
  return { id: 'v5', versao: 5, nome: 'DARF', criadoEm: '', atualizadoEm: '', mapeamento };
}

function registroV4(nome: string, rotulos: string[]): MapeamentoSalvo {
  const { assinatura } = gerarAssinaturaV4(modelos);
  const mapeamento: MapeamentoPdfV4 = {
    ...base(),
    versao: 4,
    nome,
    termos: [],
    assinatura: { ...assinatura, rotulos },
    exclusoes: [],
    arquivosModelo: [],
  };
  return { id: `${nome}-v4`, versao: 4, nome, criadoEm: '', atualizadoEm: '', mapeamento };
}

const sinal = (r: ReturnType<typeof verificarDocumento>, chave: string) => r.avaliacao!.sinais.find(s => s.chave === chave);

describe('mapeamento v5', () => {
  describe('aparência', () => {
    it('converte bits para hexadecimal e de volta', () => {
      const bits = Array.from({ length: BITS_MAPA }, (_, i) => i % 3 === 0);
      expect(paraBits(paraHex(bits))).toEqual(bits);
      expect(aparenciaDarf(guias[0]).hash.length).toBe(BITS_MAPA / 4);
    });

    it('página em branco não tem bordas', () => {
      expect(paraBits(desenhar([], [])).some(Boolean)).toBeFalse();
    });

    it('reconhece o mesmo desenho com outros dados e separa um desenho diferente', () => {
      const visual = gerarAssinaturaV5(modelos).assinatura.visual!;
      expect(visual).toBeDefined();
      expect(avaliarVisual(visual, aparenciaDarf(nova).hash).nota).toBeGreaterThan(0.5);
      expect(avaliarVisual(visual, desenhar(caixasDas, textosDarf(nova))).nota).toBeLessThan(0);
    });

    it('normaliza fontes e programa gerador', () => {
      expect(normalizarFonte('ABCDEF+Arial-BoldMT')).toBe('arial-boldmt');
      expect(normalizarFonte('Helvetica')).toBe('helvetica');
      expect(normalizarProdutor('iText® 5.5.13')).toBe('itext');
      expect(normalizarProdutor('  ')).toBeUndefined();
    });
  });

  describe('assinatura', () => {
    it('aprende desenho, fontes comuns e programa gerador', () => {
      const { assinatura, avisos } = gerarAssinaturaV5(modelos);
      expect(assinatura.visual).toBeDefined();
      expect(assinatura.fontes).toEqual(['helvetica', 'helvetica-bold']);
      expect(assinatura.fontesConhecidas).toContain('courier');
      expect(assinatura.produtor).toBe('sicalc');
      expect(assinatura.rotulos).toContain('ministerio da fazenda');
      expect(avisos).toEqual([]);
    });

    it('desativa o que não dá para aprender', () => {
      const semDesenho = guias.map((g, i) => modelo(g, `m${i}.pdf`, null));
      const r = gerarAssinaturaV5(semDesenho);
      expect(r.assinatura.visual).toBeUndefined();
      expect(r.assinatura.fontes).toEqual([]);
      expect(r.avisos.length).toBe(1);

      const outroProdutor = [modelos[0], modelo(guias[1], 'b.pdf', aparenciaDarf(guias[1], { produtor: 'word' }))];
      expect(gerarAssinaturaV5(outroProdutor).assinatura.produtor).toBeUndefined();
    });
  });

  describe('match', () => {
    it('aceita guia do mesmo tipo com todos os sinais de aparência a favor', () => {
      const r = verificarDocumento(registroV5(), darf(nova), DIMENSOES, aparenciaDarf(nova));
      expect(r.avaliacao!.veredito).toBe('corresponde');
      expect(sinal(r, 'visual')!.nota).toBeGreaterThan(0.5);
      expect(sinal(r, 'fontes')!.nota).toBe(1);
      expect(sinal(r, 'produtor')!.nota).toBe(1);
      expect(r.campos.map(c => c.valor)).toEqual(['11.444.777/0001-61', '06/2026', '3210.00']);
    });

    it('perde confiança quando o texto confere mas a aparência não', () => {
      const igual = verificarDocumento(registroV5(), darf(nova), DIMENSOES, aparenciaDarf(nova));
      const outra = verificarDocumento(registroV5(), darf(nova), DIMENSOES, {
        hash: desenhar(caixasDas, textosDarf(nova)),
        fontes: ['times-roman'],
        produtor: 'microsoft word',
      });
      expect(sinal(outra, 'visual')!.nota).toBeLessThan(0);
      expect(sinal(outra, 'fontes')!.nota).toBe(-1);
      expect(sinal(outra, 'produtor')!.nota).toBe(-1);
      expect(outra.avaliacao!.confianca).toBeLessThan(igual.avaliacao!.confianca - 0.1);
    });

    it('sem aparência, os sinais dela ficam só informativos', () => {
      const r = verificarDocumento(registroV5(), darf(nova), DIMENSOES);
      expect(sinal(r, 'visual')!.peso).toBe(0);
      expect(sinal(r, 'fontes')).toBeUndefined();
      expect(r.corresponde).toBeTrue();
    });

    it('entra na identificação automática', () => {
      const ranking = identificarDocumento([registroV5()], darf(nova), DIMENSOES, aparenciaDarf(nova));
      expect(ranking.length).toBe(1);
      expect(sinal(ranking[0], 'visual')!.peso).toBeGreaterThan(0);
    });
  });

  describe('contraste com outros tipos', () => {
    const das = registroV4('DAS', [
      'receita federal',
      'ministerio da fazenda',
      'pague nos bancos autorizados',
      'nome / telefone',
      'documento de arrecadacao do simples nacional',
      'apuracao simples nacional',
    ]);
    const boleto = registroV4('Boleto', ['beneficiario', 'nosso numero', 'local de pagamento']);
    const darfAntigo = registroV4('darf', ['qualquer coisa']);
    const campoV1 = { rotulo: '', ocorrenciaRotulo: 1, indiceAposRotulo: 1, exemplo: '' };
    const v1: MapeamentoSalvo = {
      ...boleto,
      id: 'v1',
      versao: 1,
      mapeamento: { nome: 'Boleto', cnpj: campoV1, competencia: campoV1, valor: campoV1, termos: ['Local de pagamento', 'Agência'] },
    };

    it('agrupa os outros tipos por nome e ignora o próprio tipo', () => {
      const tipos = outrosTipos([das, boleto, darfAntigo, v1], 'DARF');
      expect(tipos.map(t => t.nome)).toEqual(['DAS', 'Boleto']);
      expect(tipos[1].rotulos).toEqual(jasmine.arrayWithExactContents(['beneficiario', 'nosso numero', 'local de pagamento', 'agencia']));
    });

    it('sugere termos exclusivos primeiro e exclusões dos tipos parecidos', () => {
      const { assinatura } = gerarAssinaturaV5(modelos);
      const r = compararComOutrosTipos(assinatura, modelos, base().termos, outrosTipos([das, boleto], 'DARF'));

      expect(r.tipos.map(t => t.nome)).toEqual(['DAS', 'Boleto']);
      expect(r.tipos[0].parecido).toBeCloseTo(4 / 6);
      expect(r.tipos[1].parecido).toBe(0);

      const exclusivos = r.termos.filter(t => !t.tambemEm.length).map(t => t.texto);
      expect(exclusivos).toEqual(jasmine.arrayWithExactContents(['Código da Receita', 'Número do documento']));
      expect(r.termos.slice(0, 2).every(t => !t.tambemEm.length)).toBeTrue();
      expect(r.termos.find(t => t.texto === 'Ministério da Fazenda')!.tambemEm).toEqual(['DAS']);

      // Boleto não é parecido: não vira exclusão.
      expect(r.exclusoes).toEqual([
        { texto: 'documento de arrecadacao do simples nacional', tipo: 'DAS' },
        { texto: 'apuracao simples nacional', tipo: 'DAS' },
      ]);
    });
  });
});
