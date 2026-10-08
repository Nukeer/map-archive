import {
  Component,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  OnDestroy,
  OnInit,
  Output,
  ViewChild,
  computed,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { PdfDocumentoService } from '../pdf-mapeamento/pdf-documento.service';
import { normalizarTexto } from '../pdf-mapeamento/extrator';
import { CAMPOS, CampoMapeavel, Faixa, MINIMO_TERMOS } from '../pdf-mapeamento/pdf-mapeamento.model';
import {
  CampoMapeadoV2,
  MapeamentoPdfV2,
  construirCampoV2,
  extrairCampoV2,
  termoNaPosicao,
  termoPresente,
} from './mapeamento-v2';
import {
  CelulaPlanilha,
  Planilha,
  celulaEm,
  celulasEntre,
  converterParaPlanilha,
  descreverIntervalo,
  exportarCsv,
  grade,
  nomeColuna,
  paraReferencia,
  referencia,
} from './planilha';

type Etapa = 'documento' | CampoMapeavel | 'termos' | 'revisao';

const ETAPAS: ReadonlyArray<{ chave: Etapa; titulo: string }> = [
  { chave: 'documento', titulo: 'Documento' },
  { chave: 'cnpj', titulo: 'CNPJ' },
  { chave: 'competencia', titulo: 'Competência' },
  { chave: 'valor', titulo: 'Valor a pagar' },
  { chave: 'termos', titulo: 'Termos' },
  { chave: 'revisao', titulo: 'Revisão' },
];

interface Marca {
  tipo: CampoMapeavel | 'termo';
  papel: 'valor' | 'rotulo' | 'termo' | 'selecao' | 'erro';
}

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;

@Component({
  selector: 'app-pdf-mapeamento-v2-modal',
  standalone: true,
  imports: [CommonModule],
  providers: [PdfDocumentoService],
  templateUrl: './pdf-mapeamento-v2-modal.component.html',
  styleUrls: ['./pdf-mapeamento-v2-modal.component.scss'],
})
export class PdfMapeamentoV2ModalComponent implements OnInit, OnDestroy {
  /** PDF de exemplo já selecionado. Se ausente, o modal pede o arquivo. */
  @Input() arquivo: File | null = null;
  /** Mapeamento existente, para edição. */
  @Input() mapeamento: MapeamentoPdfV2 | null = null;
  /** Versões que reaproveitam este modal (ex.: v3) trocam o subtítulo e o botão final. */
  @Input() subtitulo = 'v2 · planilha';
  @Input() rotuloSalvar = 'Salvar mapeamento';

  @Output() salvar = new EventEmitter<MapeamentoPdfV2>();
  @Output() cancelar = new EventEmitter<void>();

  @ViewChild('canvas', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;

  readonly etapas = ETAPAS;
  readonly minimoTermos = MINIMO_TERMOS;
  readonly referencia = referencia;
  readonly nomeColuna = nomeColuna;
  readonly descreverIntervalo = descreverIntervalo;

  readonly indiceEtapa = signal(0);
  readonly etapa = computed(() => ETAPAS[this.indiceEtapa()].chave);
  readonly campoDaEtapa = computed(() => CAMPOS.find(c => c.chave === this.etapa()) ?? null);
  readonly selecionavel = computed(() => !!this.campoDaEtapa() || this.etapa() === 'termos');

  readonly nome = signal('');
  readonly nomeArquivo = signal('');
  readonly carregando = signal(false);
  readonly erroArquivo = signal('');

  readonly planilha = signal<Planilha | null>(null);
  readonly visao = signal<'pdf' | 'planilha'>('pdf');
  readonly pagina = signal(1);
  readonly totalPaginas = signal(0);
  readonly zoom = signal(1.25);
  readonly tamanhoPagina = signal({ largura: 0, altura: 0 });

  /** Intervalo de células (ids, em ordem de leitura) escolhido para cada campo. */
  readonly selecoes = signal<Partial<Record<CampoMapeavel, Faixa>>>({});
  readonly termos = signal<Array<{ texto: string; celula: number }>>([]);
  readonly arraste = signal<Faixa | null>(null);
  private inicioShift: number | null = null;

  readonly celulasDaPagina = computed(() => this.planilha()?.celulas.filter(c => c.pagina === this.pagina()) ?? []);
  readonly gradeDaPagina = computed(() => {
    const planilha = this.planilha();
    return planilha ? grade(planilha, this.pagina()) : [];
  });
  readonly colunasDaPagina = computed(() =>
    Array.from({ length: this.planilha()?.abas[this.pagina() - 1]?.colunas ?? 0 }, (_, i) => nomeColuna(i)),
  );

  readonly construidos = computed(() => {
    const planilha = this.planilha();
    const resultado: Partial<Record<CampoMapeavel, ReturnType<typeof construirCampoV2>>> = {};
    if (!planilha) return resultado;
    for (const { chave } of CAMPOS) {
      const faixa = this.selecoes()[chave];
      if (faixa) resultado[chave] = construirCampoV2(planilha, chave, faixa.inicio, faixa.fim);
    }
    return resultado;
  });

  readonly termosInfo = computed(() => {
    const planilha = this.planilha();
    const vistos = new Set<string>();
    return this.termos().map(t => {
      const chave = normalizarTexto(t.texto);
      const duplicado = vistos.has(chave);
      vistos.add(chave);
      const celula = planilha?.celulas[t.celula];
      return {
        ...t,
        duplicado,
        ref: celula ? `Pág.${celula.pagina}!${referencia(celula)}` : '',
        encontrado: !!planilha && !!chave && termoPresente(planilha, t.texto),
      };
    });
  });
  readonly termosValidos = computed(() => this.termosInfo().filter(t => !t.duplicado && t.encontrado).length);

  readonly revisao = computed(() => {
    const planilha = this.planilha();
    return CAMPOS.map(c => {
      const campo = this.construidos()[c.chave]?.campo;
      const teste = planilha && campo ? extrairCampoV2(planilha, c.chave, campo) : null;
      return { ...c, campo, teste, ok: !!campo && teste?.valor === campo.exemplo };
    });
  });

  readonly mapeamentoFinal = computed<MapeamentoPdfV2 | null>(() => {
    const planilha = this.planilha();
    const [cnpj, competencia, valor] = CAMPOS.map(c => this.construidos()[c.chave]?.campo);
    if (!planilha || !this.nome().trim() || !cnpj || !competencia || !valor || this.termosValidos() < MINIMO_TERMOS) return null;
    const termos = this.termosInfo()
      .filter(t => !t.duplicado && t.encontrado)
      .map(t => ({ texto: t.texto, celula: paraReferencia(planilha.celulas[t.celula]) }));
    return { versao: 2, nome: this.nome().trim(), cnpj, competencia, valor, termos, arquivoExemplo: this.nomeArquivo() };
  });

  readonly marcas = computed(() => {
    const mapa = new Map<number, Marca>();
    const pintar = (celulas: CelulaPlanilha[] | undefined, marca: Marca) => celulas?.forEach(c => mapa.set(c.id, marca));
    const planilha = this.planilha();
    if (!planilha) return mapa;
    const etapa = this.etapa();

    for (const c of CAMPOS) {
      const construido = this.construidos()[c.chave];
      if (!construido) continue;
      const emFoco = etapa === c.chave || etapa === 'revisao';
      if (emFoco && construido.celulaRotulo) pintar([construido.celulaRotulo], { tipo: c.chave, papel: 'rotulo' });
      if (construido.celulas) pintar(construido.celulas, { tipo: c.chave, papel: 'valor' });
      else if (emFoco) {
        const faixa = this.selecoes()[c.chave]!;
        pintar(celulasEntre(planilha, faixa.inicio, faixa.fim), { tipo: c.chave, papel: 'erro' });
      }
    }
    if (etapa === 'termos' || etapa === 'revisao') {
      pintar(this.termos().map(t => planilha.celulas[t.celula]), { tipo: 'termo', papel: 'termo' });
    }
    const arraste = this.arraste();
    if (arraste) {
      pintar(celulasEntre(planilha, arraste.inicio, arraste.fim), { tipo: this.campoDaEtapa()?.chave ?? 'termo', papel: 'selecao' });
    }
    return mapa;
  });

  constructor(private readonly pdf: PdfDocumentoService) {}

  ngOnInit(): void {
    if (this.mapeamento) this.nome.set(this.mapeamento.nome);
    if (this.arquivo) this.carregar(this.arquivo);
  }

  ngOnDestroy(): void {
    this.pdf.fechar();
  }

  @HostListener('document:keydown.escape')
  aoPressionarEsc(): void {
    if (this.arraste()) this.arraste.set(null);
    else this.cancelar.emit();
  }

  // ---- Etapas ----

  etapaConcluida(chave: Etapa): boolean {
    switch (chave) {
      case 'documento':
        return !!this.planilha()?.celulas.length && !!this.nome().trim();
      case 'termos':
        return this.termosValidos() >= MINIMO_TERMOS;
      case 'revisao':
        return !!this.mapeamentoFinal() && this.revisao().every(r => r.ok);
      default:
        return !!this.construidos()[chave]?.campo;
    }
  }

  podeIrPara(indice: number): boolean {
    return ETAPAS.slice(0, indice).every(e => this.etapaConcluida(e.chave));
  }

  irParaEtapa(indice: number): void {
    if (indice < 0 || indice >= ETAPAS.length || !this.podeIrPara(indice)) return;
    this.indiceEtapa.set(indice);
    this.arraste.set(null);
    this.inicioShift = null;
    const campo = this.campoDaEtapa();
    const faixa = campo && this.selecoes()[campo.chave];
    if (faixa) this.irPara(this.planilha()!.celulas[faixa.inicio].pagina);
  }

  // ---- Arquivo e visualização ----

  aoSelecionarArquivo(evento: Event): void {
    const input = evento.target as HTMLInputElement;
    const arquivo = input.files?.[0];
    input.value = '';
    if (arquivo) this.carregar(arquivo);
  }

  async carregar(arquivo: File): Promise<void> {
    if (arquivo.type && arquivo.type !== 'application/pdf') {
      this.erroArquivo.set('Selecione um arquivo PDF.');
      return;
    }
    this.erroArquivo.set('');
    this.carregando.set(true);
    try {
      const { totalPaginas, tokens, dimensoes } = await this.pdf.abrir(arquivo);
      const planilha = converterParaPlanilha(tokens, dimensoes);
      this.planilha.set(planilha);
      this.nomeArquivo.set(arquivo.name);
      this.totalPaginas.set(totalPaginas);
      this.pagina.set(1);
      this.restaurar(planilha);
      if (!tokens.length) this.erroArquivo.set('Este PDF não tem texto selecionável (provavelmente é digitalizado). Use um PDF com texto ou aplique OCR antes.');
      await this.renderizar();
    } catch {
      this.planilha.set(null);
      this.totalPaginas.set(0);
      this.erroArquivo.set('Não foi possível abrir o PDF.');
    } finally {
      this.carregando.set(false);
    }
  }

  /** Ao editar, reaplica o mapeamento salvo na planilha do PDF. */
  private restaurar(planilha: Planilha): void {
    const mapeamento = this.mapeamento;
    if (!mapeamento) {
      this.selecoes.set({});
      this.termos.set([]);
      return;
    }
    const selecoes: Partial<Record<CampoMapeavel, Faixa>> = {};
    for (const { chave } of CAMPOS) {
      const celulas = extrairCampoV2(planilha, chave, mapeamento[chave] as CampoMapeadoV2)?.celulas;
      if (celulas?.length) selecoes[chave] = { inicio: celulas[0].id, fim: celulas[celulas.length - 1].id };
    }
    this.selecoes.set(selecoes);
    this.termos.set(
      mapeamento.termos
        .filter(t => termoNaPosicao(planilha, t))
        .map(t => ({ texto: t.texto, celula: celulaEm(planilha, t.celula)!.id })),
    );
  }

  irPara(pagina: number): void {
    if (pagina < 1 || pagina > this.totalPaginas() || pagina === this.pagina()) return;
    this.pagina.set(pagina);
    this.renderizar();
  }

  alterarZoom(delta: number): void {
    const novo = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, +(this.zoom() + delta).toFixed(2)));
    if (novo === this.zoom()) return;
    this.zoom.set(novo);
    this.renderizar();
  }

  baixarCsv(): void {
    const planilha = this.planilha();
    if (!planilha) return;
    const blob = new Blob(['﻿' + exportarCsv(planilha, this.pagina())], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${this.nomeArquivo().replace(/\.pdf$/i, '')}-pagina-${this.pagina()}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  private async renderizar(): Promise<void> {
    this.tamanhoPagina.set(await this.pdf.renderizar(this.pagina(), this.canvasRef.nativeElement, this.zoom()));
  }

  // ---- Seleção por clique / arraste (no PDF ou na planilha) ----

  aoPressionar(evento: PointerEvent): void {
    const id = celulaDoEvento(evento);
    if (!this.selecionavel() || id === null || evento.button !== 0) return;
    evento.preventDefault();
    if (evento.shiftKey && this.inicioShift !== null) {
      this.aplicarSelecao(ordenar(this.inicioShift, id));
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
    this.aplicarSelecao(ordenar(arraste.inicio, arraste.fim));
  }

  private aplicarSelecao(faixa: Faixa): void {
    const campo = this.campoDaEtapa();
    if (campo) {
      this.selecoes.update(s => ({ ...s, [campo.chave]: faixa }));
    } else if (this.etapa() === 'termos') {
      const celulas = celulasEntre(this.planilha()!, faixa.inicio, faixa.fim);
      this.adicionarTermo(celulas.map(c => c.texto).join(' '), faixa.inicio);
    }
  }

  limparCampo(chave: CampoMapeavel): void {
    this.selecoes.update(s => {
      const { [chave]: _removido, ...resto } = s;
      return resto;
    });
  }

  // ---- Termos ----

  private adicionarTermo(texto: string, celula: number): void {
    const limpo = texto.trim().replace(/\s+/g, ' ');
    if (!limpo || this.termos().some(t => normalizarTexto(t.texto) === normalizarTexto(limpo))) return;
    this.termos.update(lista => [...lista, { texto: limpo, celula }]);
  }

  removerTermo(indice: number): void {
    this.termos.update(lista => lista.filter((_, i) => i !== indice));
  }

  // ---- Conclusão ----

  confirmar(): void {
    const mapeamento = this.mapeamentoFinal();
    if (mapeamento && this.etapaConcluida('revisao')) this.salvar.emit(mapeamento);
  }

  descreverRotulo(campo: CampoMapeadoV2): string {
    const r = campo.rotulo;
    if (!r) return 'sem rótulo (só posição)';
    if (r.posicao === 'celula') return `"${r.texto}" na mesma célula`;
    if (r.posicao === 'esquerda') return `"${r.texto}" ${r.distancia === 1 ? 'logo à esquerda' : `${r.distancia} blocos à esquerda`}`;
    return `"${r.texto}" ${r.distancia} linha(s) acima`;
  }

}

function ordenar(a: number, b: number): Faixa {
  return { inicio: Math.min(a, b), fim: Math.max(a, b) };
}

function celulaDoEvento(evento: Event): number | null {
  const alvo = (evento.target as Element | null)?.closest?.('[data-celula]');
  return alvo ? Number(alvo.getAttribute('data-celula')) : null;
}
