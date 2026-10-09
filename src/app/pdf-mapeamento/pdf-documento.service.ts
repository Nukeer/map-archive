import { Injectable } from '@angular/core';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { TokenPdf } from './pdf-mapeamento.model';
import { AparenciaPdf, LARGURA_MINIATURA, mapaDeBordas, normalizarFonte, normalizarProdutor } from '../pdf-mapeamento-v5/aparencia';
import { DocumentoTextual, decodificarTexto, desenharTexto, formatoDoArquivo, lerCsv, lerTxt } from './documento-texto';

/** Tamanho da página em pontos PDF (escala 1). */
export interface DimensaoPagina {
  largura: number;
  altura: number;
}

pdfjsLib.GlobalWorkerOptions.workerSrc = 'assets/pdfjs/pdf.worker.min.mjs';

/**
 * Abre o documento (PDF, CSV ou TXT), renderiza páginas e quebra o texto em palavras clicáveis.
 * CSV e TXT são desenhados como texto monoespaçado (ver `documento-texto.ts`).
 */
@Injectable()
export class PdfDocumentoService {
  private documento: PDFDocumentProxy | null = null;
  private textual: DocumentoTextual | null = null;
  private tarefaRender: RenderTask | null = null;
  private readonly medidor = document.createElement('canvas').getContext('2d')!;

  async abrir(arquivo: File): Promise<{ totalPaginas: number; tokens: TokenPdf[]; dimensoes: DimensaoPagina[] }> {
    await this.fechar();
    const formato = formatoDoArquivo(arquivo);
    if (!formato) throw new Error('Formato não suportado.');
    const dados = new Uint8Array(await arquivo.arrayBuffer());
    if (formato !== 'pdf') {
      const texto = decodificarTexto(dados);
      this.textual = formato === 'csv' ? lerCsv(texto) : lerTxt(texto);
      return { totalPaginas: this.textual.dimensoes.length, ...this.textual };
    }
    this.documento = await pdfjsLib.getDocument({ data: dados }).promise;

    const tokens: TokenPdf[] = [];
    const dimensoes: DimensaoPagina[] = [];
    let linha = -1;
    for (let p = 1; p <= this.documento.numPages; p++) {
      const { width, height } = (await this.documento.getPage(p)).getViewport({ scale: 1 });
      dimensoes.push({ largura: width, altura: height });
      linha = await this.extrairTokens(p, tokens, linha);
    }
    return { totalPaginas: this.documento.numPages, tokens, dimensoes };
  }

  async fechar(): Promise<void> {
    this.tarefaRender?.cancel();
    await this.documento?.destroy();
    this.documento = null;
    this.textual = null;
  }

  /**
   * v5: desenha a 1ª página em miniatura (mapa de bordas) e lê as fontes e o programa gerador.
   * Chamar depois de `abrir` e antes de `fechar`.
   */
  async aparencia(): Promise<AparenciaPdf> {
    if (this.textual) return this.aparenciaTextual(this.textual);
    if (!this.documento) throw new Error('Nenhum PDF aberto.');
    const pagina = await this.documento.getPage(1);
    const viewport = pagina.getViewport({ scale: LARGURA_MINIATURA / pagina.getViewport({ scale: 1 }).width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const contexto = canvas.getContext('2d', { willReadFrequently: true })!;
    contexto.fillStyle = '#fff';
    contexto.fillRect(0, 0, canvas.width, canvas.height);
    await pagina.render({ canvasContext: contexto, viewport }).promise;

    // Depois de desenhada, as fontes da página ficam em `commonObjs`, com o nome original (BaseFont).
    const { styles } = await pagina.getTextContent();
    const fontes = Object.keys(styles)
      .filter(id => pagina.commonObjs.has(id))
      .map(id => normalizarFonte((pagina.commonObjs.get(id) as { name?: string }).name ?? ''))
      .filter(Boolean);
    const { info } = (await this.documento.getMetadata()) as { info: { Producer?: string; Creator?: string } };
    return {
      hash: mapaDeBordas(contexto.getImageData(0, 0, canvas.width, canvas.height)),
      fontes: [...new Set(fontes)].sort(),
      produtor: normalizarProdutor(info.Producer || info.Creator),
    };
  }

  /** CSV e TXT: desenho da 1ª página; não há fontes embutidas nem programa gerador. */
  private aparenciaTextual({ tokens, dimensoes }: DocumentoTextual): AparenciaPdf {
    const escala = LARGURA_MINIATURA / dimensoes[0].largura;
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(dimensoes[0].largura * escala);
    canvas.height = Math.ceil(dimensoes[0].altura * escala);
    const contexto = canvas.getContext('2d', { willReadFrequently: true })!;
    desenharTexto(contexto, tokens, 1, dimensoes[0], escala);
    return { hash: mapaDeBordas(contexto.getImageData(0, 0, canvas.width, canvas.height)), fontes: [] };
  }

  /** Renderiza a página no canvas e devolve o tamanho exibido (px CSS). */
  async renderizar(numero: number, canvas: HTMLCanvasElement, escala: number): Promise<{ largura: number; altura: number }> {
    if (this.textual) return this.renderizarTexto(this.textual, numero, canvas, escala);
    if (!this.documento) return { largura: 0, altura: 0 };
    this.tarefaRender?.cancel();

    const pagina = await this.documento.getPage(numero);
    const viewport = pagina.getViewport({ scale: escala });
    const escalaTela = window.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.width * escalaTela);
    canvas.height = Math.floor(viewport.height * escalaTela);

    const tarefa = pagina.render({
      canvasContext: canvas.getContext('2d')!,
      viewport,
      transform: escalaTela !== 1 ? [escalaTela, 0, 0, escalaTela, 0, 0] : undefined,
    });
    this.tarefaRender = tarefa;
    try {
      await tarefa.promise;
    } catch (erro) {
      if ((erro as Error)?.name !== 'RenderingCancelledException') throw erro;
    } finally {
      if (this.tarefaRender === tarefa) this.tarefaRender = null;
    }
    return { largura: Math.floor(viewport.width), altura: Math.floor(viewport.height) };
  }

  private renderizarTexto({ tokens, dimensoes }: DocumentoTextual, numero: number, canvas: HTMLCanvasElement, escala: number) {
    const dimensao = dimensoes[numero - 1];
    const escalaTela = window.devicePixelRatio || 1;
    canvas.width = Math.floor(dimensao.largura * escala * escalaTela);
    canvas.height = Math.floor(dimensao.altura * escala * escalaTela);
    desenharTexto(canvas.getContext('2d')!, tokens, numero, dimensao, escala * escalaTela);
    return { largura: Math.floor(dimensao.largura * escala), altura: Math.floor(dimensao.altura * escala) };
  }

  /** Adiciona as palavras da página em `tokens` e devolve o número da última linha usada. */
  private async extrairTokens(numero: number, tokens: TokenPdf[], linha: number): Promise<number> {
    const pagina = await this.documento!.getPage(numero);
    const viewport = pagina.getViewport({ scale: 1 });
    const conteudo = await pagina.getTextContent();

    let novaLinha = true;
    let baseAnterior = 0;
    for (const [indiceItem, item] of conteudo.items.entries()) {
      if (!('str' in item)) continue;
      const trecho = numero * 1_000_000 + indiceItem;
      const texto = item as TextItem;
      const tx = pdfjsLib.Util.transform(viewport.transform, texto.transform);
      const altura = Math.hypot(tx[2], tx[3]);
      const base = tx[5];

      if (texto.str.trim()) {
        if (novaLinha || Math.abs(base - baseAnterior) > altura / 2) linha++;
        novaLinha = false;
        baseAnterior = base;

        // Mede cada palavra na fonte do trecho e ajusta à largura real informada pelo PDF.
        const fonte = conteudo.styles[texto.fontName]?.fontFamily ?? 'sans-serif';
        this.medidor.font = `${altura}px ${fonte}`;
        const fator = texto.width / (this.medidor.measureText(texto.str).width || 1);

        for (const palavra of texto.str.matchAll(/\S+/g)) {
          const deslocamento = this.medidor.measureText(texto.str.slice(0, palavra.index)).width * fator;
          const largura = this.medidor.measureText(palavra[0]).width * fator;
          tokens.push({
            indice: tokens.length,
            pagina: numero,
            linha,
            trecho,
            texto: palavra[0],
            caixa: {
              x: (tx[4] + deslocamento) / viewport.width,
              y: (base - altura * 0.9) / viewport.height,
              largura: largura / viewport.width,
              altura: (altura * 1.15) / viewport.height,
            },
          });
        }
      }
      if (texto.hasEOL) novaLinha = true;
    }
    return linha;
  }
}
