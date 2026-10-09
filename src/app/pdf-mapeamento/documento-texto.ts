import type { DimensaoPagina } from './pdf-documento.service';
import { TokenPdf } from './pdf-mapeamento.model';

/**
 * CSV e TXT viram "páginas" de texto em fonte monoespaçada: cada palavra ganha uma caixa como
 * as do PDF, então planilha, blocos, extração e a camada clicável funcionam igual.
 */
export type FormatoDocumento = 'pdf' | 'csv' | 'txt';

/** Para o `accept` dos campos de arquivo. */
export const ARQUIVOS_ACEITOS = '.pdf,.csv,.txt,application/pdf,text/csv,text/plain';

/** Pela extensão; o tipo (MIME) só vale para arquivo sem extensão. */
export function formatoDoArquivo(arquivo: File): FormatoDocumento | null {
  const extensao = /\.([a-z0-9]+)$/i.exec(arquivo.name)?.[1]?.toLowerCase();
  if (extensao) return extensao === 'pdf' || extensao === 'csv' || extensao === 'txt' ? extensao : null;
  if (arquivo.type === 'application/pdf') return 'pdf';
  if (arquivo.type === 'text/csv') return 'csv';
  if (arquivo.type === 'text/plain') return 'txt';
  return null;
}

/** Tamanho da fonte, largura de cada caractere, altura da linha e margem, em pontos. */
export const FONTE = 10;
/** Menor que 0,6 × fonte: palavras separadas por um espaço continuam na mesma célula da planilha. */
export const LARGURA_CARACTERE = 5.5;
export const ALTURA_LINHA = 14;
const MARGEM = 20;
const LINHAS_POR_PAGINA_TXT = 60;
const LINHAS_POR_PAGINA_CSV = 50;
/** Espaço entre colunas do CSV, em caracteres. */
const ESPACO_COLUNAS = 2;

export interface DocumentoTextual {
  tokens: TokenPdf[];
  dimensoes: DimensaoPagina[];
}

/** UTF-8; se não for UTF-8 válido, Windows-1252 (comum em arquivos gerados no Brasil). */
export function decodificarTexto(bytes: Uint8Array): string {
  let texto: string;
  try {
    texto = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    texto = new TextDecoder('windows-1252').decode(bytes);
  }
  return texto.replace(/^﻿/, '');
}

const linhasDe = (texto: string) => texto.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');

/**
 * TXT: cada linha do arquivo vira uma linha da página, com as palavras na coluna em que estão
 * (relatórios de largura fixa ficam alinhados). Trechos separados por 2+ espaços são células diferentes.
 */
export function lerTxt(texto: string): DocumentoTextual {
  const linhas = linhasDe(texto).map(l => l.replace(/\t/g, '        ').trimEnd());
  return paginar(linhas, LINHAS_POR_PAGINA_TXT, (linha, adicionar) => {
    for (const trecho of linha.matchAll(/\S+(?: \S+)*/g)) {
      for (const palavra of trecho[0].matchAll(/\S+/g)) adicionar(palavra[0], trecho.index! + palavra.index!, trecho.index!);
    }
  });
}

/** CSV: cada célula na sua coluna, com largura da maior célula da coluna. */
export function lerCsv(texto: string): DocumentoTextual {
  const registros = separarCsv(texto).map(r => r.map(c => c.trim().replace(/\s+/g, ' ')));
  const larguras: number[] = [];
  for (const r of registros) r.forEach((c, i) => (larguras[i] = Math.max(larguras[i] ?? 0, c.length)));
  const inicios = larguras.map((_, i) => larguras.slice(0, i).reduce((t, l) => t + l + ESPACO_COLUNAS, 0));

  return paginar(registros, LINHAS_POR_PAGINA_CSV, (registro, adicionar) => {
    registro.forEach((celula, coluna) => {
      for (const palavra of celula.matchAll(/\S+/g)) adicionar(palavra[0], inicios[coluna] + palavra.index!, coluna);
    });
  });
}

/** Separa registros e células, com aspas ("a;b" e "" dentro de aspas) e delimitador detectado. */
export function separarCsv(texto: string): string[][] {
  const delimitador = detectarDelimitador(texto);
  const registros: string[][] = [];
  let registro: string[] = [];
  let celula = '';
  let aspas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (aspas) {
      if (c === '"' && texto[i + 1] === '"') (celula += '"'), i++;
      else if (c === '"') aspas = false;
      else celula += c;
    } else if (c === '"') aspas = true;
    else if (c === delimitador) registro.push(celula), (celula = '');
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && texto[i + 1] === '\n') i++;
      registro.push(celula);
      registros.push(registro);
      (registro = []), (celula = '');
    } else celula += c;
  }
  if (celula || registro.length) registros.push([...registro, celula]);
  return registros.filter(r => r.some(c => c.trim()));
}

/** O delimitador mais frequente e constante nas primeiras linhas: `;`, `,`, tab ou `|`. */
function detectarDelimitador(texto: string): string {
  const amostra = linhasDe(texto).slice(0, 10).filter(l => l.trim());
  const pontuar = (d: string) => {
    const contagens = amostra.map(l => l.split(d).length - 1);
    return contagens.every(c => c > 0 && c === contagens[0]) ? contagens[0] + 1000 : Math.min(...contagens);
  };
  return [';', ',', '\t', '|'].reduce((melhor, d) => (pontuar(d) > pontuar(melhor) ? d : melhor));
}

/**
 * Distribui as linhas em páginas e monta os tokens. `colocar` chama `adicionar(palavra, coluna
 * em caracteres, trecho)`; palavras do mesmo trecho podem virar uma célula só.
 */
function paginar<T>(
  linhas: T[],
  porPagina: number,
  colocar: (linha: T, adicionar: (palavra: string, coluna: number, trecho: number) => void) => void,
): DocumentoTextual {
  const tokens: TokenPdf[] = [];
  const dimensoes: DimensaoPagina[] = [];
  let maiorColuna = 0;
  linhas.forEach(linha => colocar(linha, (palavra, coluna) => (maiorColuna = Math.max(maiorColuna, coluna + palavra.length))));
  const largura = MARGEM * 2 + Math.max(maiorColuna, 40) * LARGURA_CARACTERE;
  const paginas = Math.max(1, Math.ceil(linhas.length / porPagina));
  for (let p = 0; p < paginas; p++) {
    const daPagina = linhas.slice(p * porPagina, (p + 1) * porPagina);
    const altura = MARGEM * 2 + Math.max(daPagina.length, 10) * ALTURA_LINHA;
    dimensoes.push({ largura, altura });
    daPagina.forEach((linha, l) => {
      const indiceLinha = p * porPagina + l;
      const base = MARGEM + l * ALTURA_LINHA + FONTE;
      colocar(linha, (palavra, coluna, trecho) =>
        tokens.push({
          indice: tokens.length,
          pagina: p + 1,
          linha: indiceLinha,
          trecho: (p + 1) * 1_000_000 + indiceLinha * 1000 + trecho,
          texto: palavra,
          caixa: {
            x: (MARGEM + coluna * LARGURA_CARACTERE) / largura,
            y: (base - FONTE * 0.9) / altura,
            largura: (palavra.length * LARGURA_CARACTERE) / largura,
            altura: (FONTE * 1.15) / altura,
          },
        }),
      );
    });
  }
  return { tokens, dimensoes };
}

/** Desenha as palavras da página no canvas (o "preview" de CSV e TXT). `escala` = px por ponto. */
export function desenharTexto(
  contexto: CanvasRenderingContext2D,
  tokens: TokenPdf[],
  pagina: number,
  dimensao: DimensaoPagina,
  escala: number,
): void {
  contexto.fillStyle = '#fff';
  contexto.fillRect(0, 0, dimensao.largura * escala, dimensao.altura * escala);
  contexto.fillStyle = '#1f2328';
  contexto.font = `${FONTE * escala}px ui-monospace, Consolas, monospace`;
  for (const t of tokens) {
    if (t.pagina !== pagina) continue;
    const x = t.caixa.x * dimensao.largura * escala;
    const base = (t.caixa.y * dimensao.altura + FONTE * 0.9) * escala;
    contexto.fillText(t.texto, x, base, t.caixa.largura * dimensao.largura * escala);
  }
}
