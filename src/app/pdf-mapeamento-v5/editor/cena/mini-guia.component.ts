import { Component } from '@angular/core';

/** Retângulo no espaço da guia (200 × 168, origem no canto do papel). */
export interface Caixa {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Onde ficam, na guia desenhada, as células que as cenas marcam. */
export const CELULAS_GUIA = {
  titulo: { x: 24, y: 7, w: 64, h: 9 },
  documento: { x: 24, y: 17, w: 86, h: 7 },
  rotuloCpf: { x: 127, y: 34, w: 12, h: 6 },
  cpf: { x: 127, y: 42, w: 58, h: 8 },
  rotuloPeriodo: { x: 127, y: 56, w: 50, h: 6 },
  competencia: { x: 127, y: 64, w: 30, h: 8 },
  codigoReceita: { x: 9, y: 56, w: 46, h: 6 },
  rotuloValor: { x: 127, y: 100, w: 30, h: 6 },
  valor: { x: 127, y: 108, w: 50, h: 10 },
} satisfies Record<string, Caixa>;

/** Barras do código de barras: largura alternando, sempre a mesma sequência. */
const BARRAS = Array.from({ length: 58 }, (_, i) => ({ x: 8 + i * 3.2, w: [0.8, 1.6, 0.8, 2.2, 1.2][i % 5] }));

/**
 * Guia de arrecadação desenhada em SVG (texto de verdade, letra pequena): cabeçalho, caixas
 * com rótulo e valor, linha digitável e código de barras. Papel branco, como o documento no
 * visualizador. Usado dentro do `<svg>` das cenas: `<svg:g appMiniGuia></svg:g>`.
 */
@Component({
  selector: 'g[appMiniGuia]',
  standalone: true,
  template: `
    <svg:rect class="papel" x="0" y="0" width="200" height="168" rx="3"></svg:rect>
    <svg:circle class="brasao" cx="13" cy="13" r="7"></svg:circle>
    <svg:text class="titulo" x="26" y="14">RECEITA FEDERAL</svg:text>
    <svg:text class="sub" x="26" y="22">DOCUMENTO DE ARRECADAÇÃO</svg:text>
    <svg:text class="mini" x="194" y="12" text-anchor="end">Ministério da Fazenda</svg:text>
    <svg:rect class="regua" x="6" y="28" width="188" height="0.6"></svg:rect>

    @for (caixa of caixas; track $index) {
      <svg:rect class="caixa" [attr.x]="caixa[0]" [attr.y]="caixa[1]" [attr.width]="caixa[2]" [attr.height]="caixa[3]" rx="1.5"></svg:rect>
    }
    <svg:text class="rotulo" x="10" y="39">Nome / Razão social</svg:text>
    <svg:text class="valor" x="10" y="48">ALFA COMÉRCIO LTDA</svg:text>
    <svg:text class="rotulo" x="128" y="39">CPF</svg:text>
    <svg:text class="valor" x="128" y="48">529.982.247-25</svg:text>

    <svg:text class="rotulo" x="10" y="61">Código da Receita</svg:text>
    <svg:text class="valor" x="10" y="70">0190</svg:text>
    <svg:text class="rotulo" x="128" y="61">Período de apuração</svg:text>
    <svg:text class="valor" x="128" y="70">09/2026</svg:text>

    <svg:text class="rotulo" x="10" y="83">Número do documento</svg:text>
    <svg:text class="valor" x="10" y="92">07.18.26252.0019876-3</svg:text>
    <svg:text class="rotulo" x="128" y="83">Vencimento</svg:text>
    <svg:text class="valor" x="128" y="92">20/10/2026</svg:text>

    <svg:text class="rotulo" x="10" y="105">Observações</svg:text>
    <svg:text class="rotulo" x="128" y="105">Valor total</svg:text>
    <svg:text class="total" x="128" y="116">R$ 1.100,00</svg:text>

    <svg:rect class="regua" x="6" y="128" width="188" height="0.6"></svg:rect>
    <svg:text class="digitos" x="8" y="137">85890000011-0 00640115202-6 60901123456-7 89012345678-2</svg:text>
    @for (b of barras; track $index) {
      <svg:rect class="barra" [attr.x]="b.x" y="141" [attr.width]="b.w" height="17"></svg:rect>
    }
    <svg:text class="mini" x="100" y="165" text-anchor="middle">Pague nos bancos autorizados</svg:text>
  `,
  styles: `
    .papel { fill: #fff; stroke: #d5d9df; stroke-width: 0.6; }
    .brasao { fill: #c7d2e5; }
    .regua { fill: #d5d9df; }
    .caixa { fill: none; stroke: #e2e5ea; stroke-width: 0.6; }
    .barra { fill: #2f3b4c; }
    text { font-family: system-ui, 'Segoe UI', Roboto, sans-serif; font-variant-numeric: tabular-nums; }
    .titulo { font-size: 7px; font-weight: 700; fill: #2f3b4c; }
    .sub { font-size: 5px; font-weight: 600; fill: #4b5563; }
    .mini { font-size: 4.2px; fill: #8b929c; }
    .rotulo { font-size: 4.4px; fill: #6b7380; }
    .valor { font-size: 5.6px; fill: #2f3b4c; }
    .total { font-size: 7px; font-weight: 700; fill: #2f3b4c; }
    .digitos { font-size: 4.2px; letter-spacing: 0.02em; fill: #4b5563; }
  `,
})
export class MiniGuiaComponent {
  /** Caixas do formulário: [x, y, largura, altura]. */
  readonly caixas = [
    [6, 32, 116, 20], [124, 32, 70, 20],
    [6, 54, 116, 20], [124, 54, 70, 20],
    [6, 76, 116, 20], [124, 76, 70, 20],
    [6, 98, 116, 26], [124, 98, 70, 26],
  ];
  readonly barras = BARRAS;
}
