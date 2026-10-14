import { AfterViewInit, Component, ElementRef, HostListener, OnDestroy, ViewChild, computed, effect, input, output, signal, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { PdfDocumentoService } from '../../pdf-mapeamento/pdf-documento.service';
import { Faixa } from '../../pdf-mapeamento/pdf-mapeamento.model';
import { BlocosPlanilhaComponent } from '../../pdf-mapeamento-v2/blocos-planilha.component';
import { dividirEmBlocos } from '../../pdf-mapeamento-v2/blocos';
import { Planilha, celulasEntre, grade, nomeColuna, referencia } from '../../pdf-mapeamento-v2/planilha';
import { Marca } from './editor-v5.state';

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const PASSO_ZOOM = 0.25;
/** Fichas de página mostradas; acima disso, só as primeiras. */
const MAXIMO_FICHAS = 20;

/**
 * Documento com as células clicáveis, em três visões (documento, blocos, planilha). Emite a
 * faixa de células escolhida (clique, arraste ou Shift+clique); quem usa decide o que ela é.
 */
@Component({
  selector: 'app-visualizador-documento',
  standalone: true,
  imports: [CommonModule, BlocosPlanilhaComponent],
  providers: [PdfDocumentoService],
  templateUrl: './visualizador-documento.component.html',
  styleUrls: ['./visualizador-documento.component.scss'],
})
export class VisualizadorDocumentoComponent implements AfterViewInit, OnDestroy {
  readonly arquivo = input.required<File>();
  readonly planilha = input.required<Planilha>();
  readonly marcas = input<ReadonlyMap<number, Marca>>(new Map());
  readonly selecionavel = input(false);
  /** O que está sendo marcado (cor da seleção). */
  readonly tipo = input<string>('termo');
  /** Célula a mostrar: o visualizador abre a página dela. */
  readonly foco = input<number | null>(null);
  /** Frase sobre o que se vê (ex.: "Guia de conferência: só mostro onde li"). */
  readonly aviso = input<string | null>(null);
  readonly podeDesfazer = input(false);
  readonly podeRefazer = input(false);

  readonly selecionar = output<Faixa>();
  readonly desfazer = output<void>();
  readonly refazer = output<void>();

  @ViewChild('canvas', { static: true }) private canvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('viewport', { static: true }) private viewportRef!: ElementRef<HTMLElement>;

  readonly visao = signal<'documento' | 'blocos' | 'planilha'>('documento');
  readonly pagina = signal(1);
  readonly totalPaginas = signal(0);
  /** `ajustar` acompanha a largura do painel. */
  readonly zoom = signal<number | 'ajustar'>('ajustar');
  readonly escala = signal(1);
  readonly tamanhoPagina = signal({ largura: 0, altura: 0 });
  readonly contornarBlocos = signal(false);
  readonly carregando = signal(false);
  readonly erro = signal('');
  readonly maisAbaixo = signal(false);
  private readonly arraste = signal<Faixa | null>(null);
  private inicioShift: number | null = null;
  private observador: ResizeObserver | null = null;

  readonly referencia = referencia;
  readonly paginas = computed(() => Array.from({ length: Math.min(this.totalPaginas(), MAXIMO_FICHAS) }, (_, i) => i + 1));
  readonly celulasDaPagina = computed(() => this.planilha().celulas.filter(c => c.pagina === this.pagina()));
  readonly blocosDaPagina = computed(() => dividirEmBlocos(this.planilha(), this.pagina()));
  readonly gradeDaPagina = computed(() => (this.totalPaginas() ? grade(this.planilha(), this.pagina()) : []));
  readonly colunas = computed(() => Array.from({ length: this.planilha().abas[this.pagina() - 1]?.colunas ?? 0 }, (_, i) => nomeColuna(i)));
  /** Páginas com algo marcado: a ficha ganha um ponto. */
  readonly paginasMarcadas = computed(() => {
    const celulas = this.planilha().celulas;
    return new Set([...this.marcas().keys()].map(id => celulas[id]?.pagina));
  });
  /** Marcas de quem usa mais a seleção em andamento. */
  readonly marcasVisiveis = computed(() => {
    const arraste = this.arraste();
    if (!arraste) return this.marcas();
    const mapa = new Map(this.marcas());
    for (const c of celulasEntre(this.planilha(), arraste.inicio, arraste.fim)) mapa.set(c.id, { tipo: this.tipo() as Marca['tipo'], papel: 'selecao' });
    return mapa;
  });
  readonly percentual = computed(() => Math.round(this.escala() * 100));

  constructor(private readonly pdf: PdfDocumentoService) {
    // Outro arquivo: abre e mostra a 1ª página (ou a da célula em foco).
    effect(() => {
      const arquivo = this.arquivo();
      untracked(() => this.abrir(arquivo));
    });
    // Foco numa célula: vai para a página dela.
    effect(() => {
      const foco = this.foco();
      const celula = foco === null ? null : this.planilha().celulas[foco];
      if (celula) untracked(() => this.irPara(celula.pagina));
    });
  }

  ngAfterViewInit(): void {
    if (typeof ResizeObserver === 'undefined') return;
    this.observador = new ResizeObserver(() => {
      if (this.zoom() === 'ajustar') this.renderizar();
      else this.atualizarMaisAbaixo();
    });
    this.observador.observe(this.viewportRef.nativeElement);
  }

  ngOnDestroy(): void {
    this.observador?.disconnect();
    this.pdf.fechar();
  }

  private async abrir(arquivo: File): Promise<void> {
    this.carregando.set(true);
    this.erro.set('');
    try {
      const { totalPaginas } = await this.pdf.abrir(arquivo);
      this.totalPaginas.set(totalPaginas);
      const foco = this.foco();
      this.pagina.set(foco !== null ? (this.planilha().celulas[foco]?.pagina ?? 1) : 1);
      await this.renderizar();
    } catch {
      this.totalPaginas.set(0);
      this.erro.set('Não foi possível abrir o documento.');
    } finally {
      this.carregando.set(false);
    }
  }

  irPara(pagina: number): void {
    if (pagina < 1 || pagina > this.totalPaginas() || pagina === this.pagina()) return;
    this.pagina.set(pagina);
    this.viewportRef.nativeElement.scrollTop = 0;
    this.renderizar();
  }

  alterarZoom(direcao: 1 | -1): void {
    const novo = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, +(this.escala() + direcao * PASSO_ZOOM).toFixed(2)));
    this.zoom.set(novo);
    this.renderizar();
  }

  ajustar(): void {
    this.zoom.set('ajustar');
    this.renderizar();
  }

  get podeDiminuir(): boolean {
    return this.escala() > ZOOM_MIN;
  }

  get podeAumentar(): boolean {
    return this.escala() < ZOOM_MAX;
  }

  private async renderizar(): Promise<void> {
    if (!this.totalPaginas()) return;
    const zoom = this.zoom();
    const larguraPagina = this.planilha().abas[this.pagina() - 1]?.largura || 595;
    const disponivel = this.viewportRef.nativeElement.clientWidth - 32;
    const escala = zoom === 'ajustar' ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, disponivel / larguraPagina)) : zoom;
    this.escala.set(escala);
    this.tamanhoPagina.set(await this.pdf.renderizar(this.pagina(), this.canvasRef.nativeElement, escala));
    requestAnimationFrame(() => this.atualizarMaisAbaixo());
  }

  atualizarMaisAbaixo(): void {
    const v = this.viewportRef.nativeElement;
    this.maisAbaixo.set(this.visao() === 'documento' && v.scrollTop + v.clientHeight < v.scrollHeight - 8);
  }

  rolarParaBaixo(): void {
    const v = this.viewportRef.nativeElement;
    v.scrollBy({ top: v.clientHeight * 0.8, behavior: 'smooth' });
  }

  trocarVisao(visao: 'documento' | 'blocos' | 'planilha'): void {
    this.visao.set(visao);
    requestAnimationFrame(() => this.atualizarMaisAbaixo());
  }

  // ---- Seleção ----

  aoPressionar(evento: PointerEvent): void {
    const id = celulaDoEvento(evento);
    if (!this.selecionavel() || id === null || evento.button !== 0) return;
    evento.preventDefault();
    if (evento.shiftKey && this.inicioShift !== null) {
      this.selecionar.emit(ordenar(this.inicioShift, id));
      return;
    }
    this.arraste.set({ inicio: id, fim: id });
  }

  aoPassar(evento: PointerEvent): void {
    const arraste = this.arraste();
    const id = celulaDoEvento(evento);
    if (arraste && id !== null && id !== arraste.fim) this.arraste.set({ ...arraste, fim: id });
  }

  @HostListener('document:pointerup')
  aoSoltar(): void {
    const arraste = this.arraste();
    if (!arraste) return;
    this.arraste.set(null);
    this.inicioShift = arraste.inicio;
    this.selecionar.emit(ordenar(arraste.inicio, arraste.fim));
  }

  /** Atalhos com o foco no documento (nunca enquanto se digita num campo). */
  aoTeclar(evento: KeyboardEvent): void {
    if ((evento.target as HTMLElement).closest?.('input, textarea, select')) return;
    const tecla = evento.key.toLowerCase();
    const modificador = evento.ctrlKey || evento.metaKey;
    if (modificador && (tecla === 'y' || (tecla === 'z' && evento.shiftKey))) {
      evento.preventDefault();
      this.refazer.emit();
    } else if (modificador && tecla === 'z') {
      evento.preventDefault();
      this.desfazer.emit();
    } else if (tecla === 'escape' && this.arraste()) {
      evento.stopPropagation();
      this.arraste.set(null);
    } else if (!modificador && (tecla === 'pagedown' || tecla === 'pageup') && this.visao() !== 'documento') {
      this.irPara(this.pagina() + (tecla === 'pagedown' ? 1 : -1));
    }
  }
}

function ordenar(a: number, b: number): Faixa {
  return { inicio: Math.min(a, b), fim: Math.max(a, b) };
}

function celulaDoEvento(evento: Event): number | null {
  const alvo = (evento.target as Element | null)?.closest?.('[data-celula]');
  return alvo ? Number(alvo.getAttribute('data-celula')) : null;
}
