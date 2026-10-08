import { CampoMapeado, CampoMapeavel, Faixa, PADROES, TokenPdf } from './pdf-mapeamento.model';

/**
 * Texto corrido do PDF: tokens normalizados unidos por um espaço. Quebras de linha viram espaço,
 * então rótulos e valores quebrados em mais de uma linha continuam sendo encontrados.
 */
export interface DocumentoTexto {
  tokens: TokenPdf[];
  texto: string;
  inicios: number[];
  fins: number[];
}

export interface ResultadoExtracao {
  /** Trecho como aparece no texto normalizado. */
  bruto: string;
  /** Valor padronizado: CNPJ "00.000.000/0000-00", competência "MM/AAAA", valor "1234.56". */
  valor: string;
  tokens: Faixa;
}

export interface CampoConstruido {
  campo?: CampoMapeado;
  erro?: string;
  valor?: ResultadoExtracao;
  tokensRotulo?: Faixa;
}

/** Distância máxima (em caracteres) entre o rótulo e o valor. */
const DISTANCIA_MAXIMA = 1500;
const PALAVRAS_ROTULO = 6;

const MESES: Record<string, number> = {
  jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12,
};

export function normalizarTexto(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function criarDocumentoTexto(tokens: TokenPdf[]): DocumentoTexto {
  let texto = '';
  const inicios: number[] = [];
  const fins: number[] = [];
  for (const token of tokens) {
    if (texto) texto += ' ';
    inicios.push(texto.length);
    texto += normalizarTexto(token.texto);
    fins.push(texto.length);
  }
  return { tokens, texto, inicios, fins };
}

/** Texto original de uma faixa de tokens, como o usuário vê no PDF. */
export function textoDaFaixa(doc: DocumentoTexto, faixa: Faixa): string {
  return doc.tokens
    .slice(faixa.inicio, faixa.fim + 1)
    .map(t => t.texto)
    .join(' ');
}

/** Ocorrências de um texto ignorando maiúsculas, acentos e qualquer espaço/quebra de linha entre os caracteres. */
export function encontrarOcorrencias(doc: DocumentoTexto, texto: string): Array<{ inicio: number; fim: number }> {
  const caracteres = [...normalizarTexto(texto).replace(/\s+/g, '')];
  if (!caracteres.length) return [];
  const regex = new RegExp(caracteres.map(escaparRegex).join('\\s*'), 'g');
  return [...doc.texto.matchAll(regex)].map(m => ({ inicio: m.index!, fim: m.index! + m[0].length }));
}

/** Tokens da N-ésima ocorrência (1 = primeira) de um texto. */
export function localizarTexto(doc: DocumentoTexto, texto: string, ocorrencia = 1): Faixa | null {
  const alvo = encontrarOcorrencias(doc, texto)[ocorrencia - 1];
  return alvo ? faixaDeTexto(doc, alvo.inicio, alvo.fim) : null;
}

export function contemTermo(doc: DocumentoTexto, termo: string): boolean {
  return encontrarOcorrencias(doc, termo).length > 0;
}

/** O documento é do tipo mapeado quando contém todos os termos identificadores. */
export function documentoCorresponde(doc: DocumentoTexto, termos: string[]): boolean {
  return termos.length > 0 && termos.every(t => contemTermo(doc, t));
}

/** Aplica um mapeamento a um documento qualquer. */
export function extrairCampo(doc: DocumentoTexto, tipo: CampoMapeavel, campo: CampoMapeado): ResultadoExtracao | null {
  let desde = 0;
  if (campo.rotulo) {
    const rotulo = encontrarOcorrencias(doc, campo.rotulo)[campo.ocorrenciaRotulo - 1];
    if (!rotulo) return null;
    desde = rotulo.fim;
  }
  const regex = new RegExp(PADROES[tipo].source, 'g');
  regex.lastIndex = desde;
  let contador = 0;
  for (let m = regex.exec(doc.texto); m; m = regex.exec(doc.texto)) {
    if (m.index - desde > DISTANCIA_MAXIMA) return null;
    if (++contador === campo.indiceAposRotulo) return montarResultado(doc, tipo, m);
  }
  return null;
}

/**
 * Monta o mapeamento de um campo a partir do que o usuário clicou no PDF de exemplo.
 * @param selecao tokens que contêm o valor (pode incluir texto extra e atravessar linhas)
 * @param selecaoRotulo rótulo escolhido manualmente; se ausente, é sugerido a partir do texto antes do valor
 */
export function construirCampo(
  doc: DocumentoTexto,
  tipo: CampoMapeavel,
  selecao: Faixa,
  selecaoRotulo?: Faixa,
): CampoConstruido {
  const inicioSelecao = doc.inicios[selecao.inicio];
  const fimSelecao = doc.fins[selecao.fim];
  const regex = new RegExp(PADROES[tipo].source, 'g');
  regex.lastIndex = inicioSelecao;
  const m = regex.exec(doc.texto);
  if (!m || m.index + m[0].length > fimSelecao) {
    return { erro: 'O trecho selecionado não contém um valor neste formato.' };
  }

  let rotulo: string;
  if (selecaoRotulo) {
    if (doc.fins[selecaoRotulo.fim] > m.index) return { erro: 'O rótulo precisa estar antes do valor.' };
    rotulo = doc.texto.slice(doc.inicios[selecaoRotulo.inicio], doc.fins[selecaoRotulo.fim]);
  } else {
    rotulo = sugerirRotulo(doc, m.index);
  }

  // Usa a ocorrência do rótulo mais próxima antes do valor.
  const ocorrencias = encontrarOcorrencias(doc, rotulo);
  let ocorrencia = -1;
  ocorrencias.forEach((o, i) => o.fim <= m.index && (ocorrencia = i));
  if (ocorrencia < 0) rotulo = '';

  const desde = rotulo ? ocorrencias[ocorrencia].fim : 0;
  const contagem = new RegExp(PADROES[tipo].source, 'g');
  contagem.lastIndex = desde;
  let indice = 0;
  for (let c = contagem.exec(doc.texto); c && c.index <= m.index; c = contagem.exec(doc.texto)) indice++;

  const campo: CampoMapeado = {
    rotulo,
    ocorrenciaRotulo: ocorrencia + 1,
    indiceAposRotulo: indice,
    exemplo: padronizar(tipo, m),
  };
  return {
    campo,
    valor: montarResultado(doc, tipo, m),
    tokensRotulo: rotulo ? faixaDeTexto(doc, ocorrencias[ocorrencia].inicio, ocorrencias[ocorrencia].fim) : undefined,
  };
}

/**
 * Rótulo sugerido: palavras sem dígitos logo antes do valor na mesma linha (ex.: "cnpj:");
 * se não houver, a linha anterior (ex.: cabeçalho de tabela). Palavras com dígitos são
 * ignoradas porque costumam ser dados variáveis. Usa o menor final que seja único no
 * documento, para tolerar textos diferentes ao redor em outros PDFs.
 */
function sugerirRotulo(doc: DocumentoTexto, posicaoValor: number): string {
  const tokenValor = tokenNaPosicao(doc, posicaoValor);
  const linha = doc.tokens[tokenValor].linha;
  let inicioLinha = tokenValor;
  while (inicioLinha > 0 && doc.tokens[inicioLinha - 1].linha === linha) inicioLinha--;

  let palavras = palavrasFinaisSemDigitos(doc.texto.slice(doc.inicios[inicioLinha], posicaoValor));
  if (!palavras.length && inicioLinha > 0) {
    const linhaAnterior = doc.tokens[inicioLinha - 1].linha;
    let inicioAnterior = inicioLinha - 1;
    while (inicioAnterior > 0 && doc.tokens[inicioAnterior - 1].linha === linhaAnterior) inicioAnterior--;
    palavras = palavrasFinaisSemDigitos(doc.texto.slice(doc.inicios[inicioAnterior], doc.fins[inicioLinha - 1]));
  }

  for (let n = 1; n <= palavras.length; n++) {
    const candidato = palavras.slice(-n).join(' ');
    const letras = candidato.replace(/[^a-z]/g, '').length;
    if (letras >= 3 && encontrarOcorrencias(doc, candidato).length === 1) return candidato;
  }
  return palavras.join(' ');
}

export function palavrasFinaisSemDigitos(texto: string): string[] {
  const palavras = texto.split(' ').filter(Boolean);
  const rotulo: string[] = [];
  for (let i = palavras.length - 1; i >= 0 && rotulo.length < PALAVRAS_ROTULO; i--) {
    if (/\d/.test(palavras[i])) {
      if (rotulo.length) break;
      continue;
    }
    rotulo.unshift(palavras[i]);
  }
  return /[a-z]/.test(rotulo.join('')) ? rotulo : [];
}

function montarResultado(doc: DocumentoTexto, tipo: CampoMapeavel, m: RegExpExecArray): ResultadoExtracao {
  return { bruto: m[0], valor: padronizar(tipo, m), tokens: faixaDeTexto(doc, m.index, m.index + m[0].length) };
}

export function padronizar(tipo: CampoMapeavel, m: RegExpExecArray): string {
  if (tipo === 'cnpj') {
    return m[0].replace(/\D/g, '').replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  }
  if (tipo === 'competencia') {
    const mes = m[1] ? Number(m[1]) : MESES[m[3].slice(0, 3)];
    return `${String(mes).padStart(2, '0')}/${m[2] ?? m[4]}`;
  }
  return m[0].replace(/[\s.]/g, '').replace(',', '.');
}

function faixaDeTexto(doc: DocumentoTexto, inicio: number, fim: number): Faixa {
  return { inicio: tokenNaPosicao(doc, inicio), fim: tokenNaPosicao(doc, fim - 1) };
}

/** Índice do token que contém (ou vem logo depois de) uma posição do texto. */
function tokenNaPosicao(doc: DocumentoTexto, posicao: number): number {
  let esquerda = 0;
  let direita = doc.tokens.length - 1;
  while (esquerda < direita) {
    const meio = (esquerda + direita) >> 1;
    if (doc.fins[meio] <= posicao) esquerda = meio + 1;
    else direita = meio;
  }
  return esquerda;
}

export function escaparRegex(texto: string): string {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
