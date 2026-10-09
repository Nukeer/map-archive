import { TokenPdf } from '../pdf-mapeamento/pdf-mapeamento.model';
import { BlocoPlanilha, dividirEmBlocos, exportarBlocosCsv } from './blocos';
import { converterParaPlanilha } from './planilha';

const DIMENSOES = [{ largura: 600, altura: 800 }];

/** Texto posicionado: [y (pt), x (pt), texto]. Cada letra tem 5 pt; cada linha, 11,5 pt. */
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

/** Guia com as regiões típicas: título, dados à esquerda, coluna de vencimento/valor, tabela, linha digitável. */
const guia = tokens(
  [40, 400, 'DOCUMENTO DE ARRECADACAO'],

  [100, 50, 'CNPJ'],
  [100, 200, 'Razao Social'],
  [115, 50, '11.222.333/0001-81'],
  [115, 200, 'ALFA COMERCIO LTDA'],
  [135, 50, 'Periodo de Apuracao'],
  [135, 200, 'Vencimento'],
  [150, 50, '09/2026'],
  [150, 200, '20/10/2026'],

  [128, 450, 'Pagar ate'],
  [143, 450, '20/10/2026'],
  [163, 450, 'Valor Total'],
  [178, 450, '1.100,00'],

  [230, 50, 'Codigo'],
  [230, 110, 'Denominacao'],
  [230, 300, 'Principal'],
  [230, 400, 'Multa'],
  [230, 500, 'Total'],
  [245, 50, '1234'],
  [245, 110, 'COFINS'],
  [245, 300, '100,00'],
  [245, 500, '100,00'],
  [260, 50, '5678'],
  [260, 110, 'PIS'],
  [260, 300, '50,00'],
  [260, 500, '50,00'],
  [285, 110, 'Totais'],
  [285, 300, '150,00'],
  [285, 500, '150,00'],

  [400, 50, '85600000011'],
  [400, 130, '00006412026'],
  [400, 210, '09011234567'],
  [400, 450, 'AUTENTICACAO MECANICA'],
);

const textos = (b: BlocoPlanilha) => b.grade.map(linha => linha.map(c => c?.texto ?? ''));

describe('blocos (v2)', () => {
  const planilha = converterParaPlanilha(guia, DIMENSOES);
  const blocos = dividirEmBlocos(planilha, 1);

  it('separa a página nas regiões, em ordem de leitura', () => {
    expect(blocos.map(b => b.grade[0].find(c => c)!.texto)).toEqual([
      'DOCUMENTO DE ARRECADACAO',
      'CNPJ',
      'Pagar ate',
      'Codigo',
      '85600000011',
      'AUTENTICACAO MECANICA',
    ]);
    expect(blocos.map(b => b.numero)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('cada bloco tem colunas próprias, sem as colunas do resto da página', () => {
    const aba = planilha.abas[0];
    expect(aba.colunas).toBeGreaterThan(5);
    expect(textos(blocos[1])).toEqual([
      ['CNPJ', 'Razao Social'],
      ['11.222.333/0001-81', 'ALFA COMERCIO LTDA'],
      ['Periodo de Apuracao', 'Vencimento'],
      ['09/2026', '20/10/2026'],
    ]);
    expect(textos(blocos[2])).toEqual([['Pagar ate'], ['20/10/2026'], ['Valor Total'], ['1.100,00']]);
  });

  it('não corta a tabela entre colunas nem separa a linha de totais', () => {
    expect(textos(blocos[3])).toEqual([
      ['Codigo', 'Denominacao', 'Principal', 'Multa', 'Total'],
      ['1234', 'COFINS', '100,00', '', '100,00'],
      ['5678', 'PIS', '50,00', '', '50,00'],
      ['', 'Totais', '150,00', '', '150,00'],
    ]);
  });

  it('mantém numa linha só os grupos da linha digitável', () => {
    expect(textos(blocos[4])).toEqual([['85600000011', '00006412026', '09011234567']]);
  });

  it('cada célula da página aparece em exatamente um bloco', () => {
    const ids = blocos.flatMap(b => b.grade.flat().filter(c => c).map(c => c!.id)).sort((a, b) => a - b);
    expect(ids).toEqual(planilha.celulas.map(c => c.id));
  });

  it('exporta os blocos um embaixo do outro', () => {
    const csv = exportarBlocosCsv(planilha, 1).split('\r\n');
    expect(csv.slice(0, 4)).toEqual(['"Bloco 1"', '"DOCUMENTO DE ARRECADACAO"', '', '"Bloco 2"']);
    expect(csv).toContain('"";"Totais";"150,00";"";"150,00"');
  });

  it('página sem texto não tem blocos', () => {
    expect(dividirEmBlocos(converterParaPlanilha([], DIMENSOES), 1)).toEqual([]);
  });
});
