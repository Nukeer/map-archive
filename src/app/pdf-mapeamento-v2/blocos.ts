import { CelulaPlanilha, Planilha, atribuirColunas } from './planilha';

/**
 * Região da página com informações próximas (uma caixa do formulário, uma tabela, o canhoto).
 * Só serve para exibir e exportar: as referências das células (`Pág.1!B3`), usadas pelos
 * mapeamentos, continuam sendo as da planilha da página inteira.
 */
export interface BlocoPlanilha {
  pagina: number;
  /** 1 = primeiro bloco da página, em ordem de leitura. */
  numero: number;
  /** Grade compacta do bloco, com colunas próprias: [linha][coluna] → célula ou null. */
  grade: Array<Array<CelulaPlanilha | null>>;
  /** Área do bloco na página (0..1). */
  caixa: CelulaPlanilha['caixa'];
}

/** Espaço vertical (em alturas de texto) a partir do qual a página é cortada em faixas. */
const ESPACO_ENTRE_FAIXAS = 1.8;
/** Espaço vertical menor, que separa trechos dentro de uma faixa (cabeçalho × tabela, por exemplo). */
const ESPACO_ENTRE_TRECHOS = 1;
/** Corredor vertical em branco (em alturas de texto) a partir do qual uma faixa pode virar colunas. */
const ESPACO_ENTRE_COLUNAS = 1.5;
/** Numa mesma linha, palavras mais próximas que isso (em alturas de texto) não são separadas. */
const ESPACO_NA_LINHA = 3;
/**
 * Lado do corredor com pelo menos essa fração das linhas (e no mínimo 2) na mesma altura de
 * linhas do outro lado: é uma tabela ou uma lista "rótulo: valor", e não é cortada.
 */
const LINHAS_ALINHADAS = 0.5;
/** Trechos seguidos com tantas bordas de coluna em comum são a mesma tabela (ex.: linha de totais). */
const BORDAS_EM_COMUM = 3;
/** Diferença máxima, em pontos, para duas bordas de coluna serem a mesma. */
const TOLERANCIA_BORDA = 2;

/** Célula em pontos, para medir espaços nas mesmas unidades na horizontal e na vertical. */
interface Item {
  celula: CelulaPlanilha;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/**
 * Divide a página em blocos por cortes recursivos (XY-cut): faixas separadas por espaços
 * verticais grandes, colunas separadas por corredores em branco (sem atravessar tabelas) e,
 * por último, trechos separados por espaços menores (sem separar linhas da mesma tabela).
 */
export function dividirEmBlocos(planilha: Planilha, pagina: number): BlocoPlanilha[] {
  const aba = planilha.abas[pagina - 1];
  if (!aba) return [];
  const itens: Item[] = planilha.celulas
    .filter(c => c.pagina === pagina)
    .map(celula => ({
      celula,
      x0: celula.caixa.x * aba.largura,
      x1: (celula.caixa.x + celula.caixa.largura) * aba.largura,
      y0: celula.caixa.y * aba.altura,
      y1: (celula.caixa.y + celula.caixa.altura) * aba.altura,
    }));
  if (!itens.length) return [];

  const alturaTexto = mediana(itens.map(i => i.y1 - i.y0));
  return cortar(itens, alturaTexto).map((grupo, i) => montarBloco(grupo, pagina, i + 1));
}

function cortar(itens: Item[], alturaTexto: number): Item[][] {
  const faixas = dividir(itens, i => [i.y0, i.y1], alturaTexto * ESPACO_ENTRE_FAIXAS);
  if (faixas.length > 1) return faixas.flatMap(f => cortar(f, alturaTexto));
  const colunas = cortarColunas(itens, alturaTexto);
  if (colunas.length > 1) return colunas.flatMap(c => cortar(c, alturaTexto));
  const trechos = juntarTabelas(dividir(itens, i => [i.y0, i.y1], alturaTexto * ESPACO_ENTRE_TRECHOS));
  if (trechos.length > 1) return trechos.flatMap(t => cortar(t, alturaTexto));
  return [itens];
}

/** Separa nos espaços vazios ≥ `minimo` entre os intervalos projetados num eixo. */
function dividir(itens: Item[], intervalo: (i: Item) => [number, number], minimo: number): Item[][] {
  const ordenados = [...itens].sort((a, b) => intervalo(a)[0] - intervalo(b)[0]);
  const grupos: Item[][] = [];
  let fim = -Infinity;
  for (const item of ordenados) {
    const [inicio, termino] = intervalo(item);
    if (!grupos.length || inicio - fim >= minimo) grupos.push([]);
    grupos[grupos.length - 1].push(item);
    fim = Math.max(fim, termino);
  }
  return grupos;
}

/**
 * Corta no corredor vertical mais largo que não atravesse uma tabela nem quebre uma linha de
 * texto no meio. A conferência é feita trecho a trecho: um cabeçalho ao lado de uma coluna de
 * valores não deve esconder que, mais abaixo, o mesmo corredor passa entre colunas de uma tabela.
 */
function cortarColunas(itens: Item[], alturaTexto: number): Item[][] {
  const trechos = dividir(itens, i => [i.y0, i.y1], alturaTexto * ESPACO_ENTRE_TRECHOS);
  const bloqueado = (x: number) =>
    trechos.some(t => {
      const esquerda = t.filter(i => i.x0 < x);
      const direita = t.filter(i => i.x0 >= x);
      return esquerda.length > 0 && direita.length > 0 && (alinhadas(esquerda, direita, alturaTexto) || quebraLinha(t, x, alturaTexto));
    });
  const corte = dividir(itens, i => [i.x0, i.x1], alturaTexto * ESPACO_ENTRE_COLUNAS)
    .slice(1)
    .map(coluna => Math.min(...coluna.map(i => i.x0)))
    .map(x => ({ x, largura: x - Math.max(...itens.filter(i => i.x0 < x).map(i => i.x1)) }))
    .sort((a, b) => b.largura - a.largura)
    .find(c => !bloqueado(c.x));
  return corte ? [itens.filter(i => i.x0 < corte.x), itens.filter(i => i.x0 >= corte.x)] : [itens];
}

/** As linhas do lado com menos linhas têm par na mesma altura do outro lado (como numa tabela)? */
function alinhadas(a: Item[], b: Item[], alturaTexto: number): boolean {
  const centros = (lado: Item[]) => dividir(lado, i => [i.y0, i.y1], 0).map(l => mediana(l.map(i => (i.y0 + i.y1) / 2)));
  const [menor, maior] = [centros(a), centros(b)].sort((x, y) => x.length - y.length);
  const comPar = menor.filter(y => maior.some(o => Math.abs(o - y) <= alturaTexto / 2)).length;
  return comPar >= 2 && comPar / menor.length >= LINHAS_ALINHADAS;
}

/** Alguma linha do trecho tem palavras próximas dos dois lados do corredor (ex.: grupos da linha digitável)? */
function quebraLinha(trecho: Item[], x: number, alturaTexto: number): boolean {
  return dividir(trecho, i => [i.y0, i.y1], 0).some(linha => {
    const fimEsquerda = Math.max(...linha.filter(i => i.x0 < x).map(i => i.x1));
    const inicioDireita = Math.min(...linha.filter(i => i.x0 >= x).map(i => i.x0));
    return inicioDireita - fimEsquerda < alturaTexto * ESPACO_NA_LINHA;
  });
}

/** Junta trechos seguidos que continuam a mesma tabela (bordas de coluna em comum). */
function juntarTabelas(trechos: Item[][]): Item[][] {
  const bordas = (trecho: Item[]) => trecho.flatMap(i => [i.x0, i.x1]);
  const grupos: Item[][] = [];
  for (const trecho of trechos) {
    const anterior = grupos[grupos.length - 1];
    if (anterior && bordasEmComum(bordas(anterior), bordas(trecho)) >= BORDAS_EM_COMUM) anterior.push(...trecho);
    else grupos.push([...trecho]);
  }
  return grupos;
}

/** Quantas bordas diferentes de `b` (bordas a menos de TOLERANCIA_BORDA contam uma vez) existem em `a`. */
function bordasEmComum(a: number[], b: number[]): number {
  const comuns = b.filter(x => a.some(y => Math.abs(x - y) <= TOLERANCIA_BORDA)).sort((x, y) => x - y);
  return comuns.filter((x, i) => i === 0 || x - comuns[i - 1] > TOLERANCIA_BORDA).length;
}

/** Linhas do bloco são as linhas da planilha; as colunas são recalculadas só com as células do bloco. */
function montarBloco(itens: Item[], pagina: number, numero: number): BlocoPlanilha {
  const porLinha = new Map<number, CelulaPlanilha[]>();
  for (const { celula } of [...itens].sort((a, b) => a.celula.id - b.celula.id)) {
    porLinha.set(celula.linha, [...(porLinha.get(celula.linha) ?? []), celula]);
  }
  const linhas = [...porLinha.keys()].sort((a, b) => a - b).map(l => porLinha.get(l)!);
  const colunas = atribuirColunas(linhas.map(l => l.map(c => c.caixa)));
  const total = Math.max(0, ...colunas.flat().map(c => c + 1));
  const grade = linhas.map((linha, l) => {
    const valores = new Array<CelulaPlanilha | null>(total).fill(null);
    linha.forEach((celula, o) => (valores[colunas[l][o]] = celula));
    return valores;
  });

  const x = Math.min(...itens.map(i => i.celula.caixa.x));
  const y = Math.min(...itens.map(i => i.celula.caixa.y));
  const direita = Math.max(...itens.map(i => i.celula.caixa.x + i.celula.caixa.largura));
  const baixo = Math.max(...itens.map(i => i.celula.caixa.y + i.celula.caixa.altura));
  return { pagina, numero, grade, caixa: { x, y, largura: direita - x, altura: baixo - y } };
}

function mediana(valores: number[]): number {
  const ordenados = [...valores].sort((a, b) => a - b);
  const meio = ordenados.length >> 1;
  return ordenados.length % 2 ? ordenados[meio] : (ordenados[meio - 1] + ordenados[meio]) / 2;
}

/** Blocos um embaixo do outro, separados por uma linha em branco, cada um com o título "Bloco N". */
export function exportarBlocosCsv(planilha: Planilha, pagina: number): string {
  const celula = (texto: string) => `"${texto.replace(/"/g, '""')}"`;
  return dividirEmBlocos(planilha, pagina)
    .map(b => [celula(`Bloco ${b.numero}`), ...b.grade.map(linha => linha.map(c => celula(c?.texto ?? '')).join(';'))].join('\r\n'))
    .join('\r\n\r\n');
}
