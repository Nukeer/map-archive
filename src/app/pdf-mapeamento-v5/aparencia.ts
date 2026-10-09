/**
 * O que a v5 lê do PDF além do texto: o desenho da 1ª página (mapa de bordas), as fontes e o
 * programa que gerou o arquivo. Lido por `PdfDocumentoService.aparencia()`.
 */
export interface AparenciaPdf {
  /** Mapa de bordas da 1ª página em hexadecimal (ver `mapaDeBordas`). */
  hash: string;
  /** Fontes da 1ª página, normalizadas por `normalizarFonte`. */
  fontes: string[];
  /** Producer (ou Creator) dos metadados, sem versão; ver `normalizarProdutor`. */
  produtor?: string;
}

/** Pixels RGBA, como `ImageData`. */
export type ImagemRgba = Pick<ImageData, 'width' | 'height' | 'data'>;

/** A página vira uma grade de LADO_MAPA × LADO_MAPA comparações em cada direção. */
export const LADO_MAPA = 16;
export const BITS_MAPA = 2 * LADO_MAPA * LADO_MAPA;
/** Largura, em px, em que a 1ª página é desenhada: 8 px por célula da grade. */
export const LARGURA_MINIATURA = 8 * (LADO_MAPA + 1);
/** Diferença mínima de cinza (0–255) entre células vizinhas para contar como borda. */
const LIMIAR_BORDA = 8;

/** Média de cinza (0 = preto, 255 = branco) de cada célula; transparente conta como branco. */
export function gradeCinza(imagem: ImagemRgba, colunas: number, linhas: number): number[][] {
  const soma = Array.from({ length: linhas }, () => new Array<number>(colunas).fill(0));
  const quantidade = Array.from({ length: linhas }, () => new Array<number>(colunas).fill(0));
  const { width, height, data } = imagem;
  for (let y = 0; y < height; y++) {
    const linha = Math.min(linhas - 1, Math.floor((y * linhas) / height));
    for (let x = 0; x < width; x++) {
      const coluna = Math.min(colunas - 1, Math.floor((x * colunas) / width));
      const i = (y * width + x) * 4;
      const alfa = data[i + 3] / 255;
      const cinza = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      soma[linha][coluna] += cinza * alfa + 255 * (1 - alfa);
      quantidade[linha][coluna]++;
    }
  }
  return soma.map((l, i) => l.map((s, j) => (quantidade[i][j] ? s / quantidade[i][j] : 255)));
}

/**
 * Variação do dHash: reduz a página a uma grade e marca 1 onde duas células vizinhas diferem
 * (em qualquer direção), primeiro na horizontal, depois na vertical. Diferente do dHash comum,
 * áreas brancas dão 0 dos dois lados, então a comparação olha só as bordas (`avaliarVisual`).
 */
export function mapaDeBordas(imagem: ImagemRgba): string {
  const horizontal = gradeCinza(imagem, LADO_MAPA + 1, LADO_MAPA);
  const vertical = gradeCinza(imagem, LADO_MAPA, LADO_MAPA + 1);
  const bits: boolean[] = [];
  for (let l = 0; l < LADO_MAPA; l++) {
    for (let c = 0; c < LADO_MAPA; c++) bits.push(Math.abs(horizontal[l][c] - horizontal[l][c + 1]) > LIMIAR_BORDA);
  }
  for (let l = 0; l < LADO_MAPA; l++) {
    for (let c = 0; c < LADO_MAPA; c++) bits.push(Math.abs(vertical[l][c] - vertical[l + 1][c]) > LIMIAR_BORDA);
  }
  return paraHex(bits);
}

export function paraHex(bits: boolean[]): string {
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    hex += ((+!!bits[i] << 3) | (+!!bits[i + 1] << 2) | (+!!bits[i + 2] << 1) | +!!bits[i + 3]).toString(16);
  }
  return hex;
}

export function paraBits(hex: string): boolean[] {
  return [...hex].flatMap(c => {
    const n = parseInt(c, 16);
    return [!!(n & 8), !!(n & 4), !!(n & 2), !!(n & 1)];
  });
}

/** "ABCDEF+Arial-BoldMT" → "arial-boldmt". O prefixo de 6 letras muda a cada subconjunto embutido. */
export function normalizarFonte(nome: string): string {
  return nome
    .replace(/^[A-Z]{6}\+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** "iText® 5.5.13" → "itext". Versões mudam com atualizações do mesmo programa. */
export function normalizarProdutor(texto?: string): string | undefined {
  const t = texto
    ?.normalize('NFD')
    .toLowerCase()
    .replace(/\d+([._-]\d+)*/g, ' ')
    .replace(/[^a-z]+/g, ' ')
    .trim();
  return t || undefined;
}
