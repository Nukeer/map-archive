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
import { PdfDocumentoService } from './pdf-documento.service';
import {
  CampoConstruido,
  DocumentoTexto,
  construirCampo,
  contemTermo,
  criarDocumentoTexto,
  extrairCampo,
  localizarTexto,
  normalizarTexto,
  textoDaFaixa,
} from './extrator';
import { CAMPOS, CampoMapeavel, Faixa, MINIMO_TERMOS, MapeamentoPdf } from './pdf-mapeamento.model';

type Etapa = 'documento' | CampoMapeavel | 'termos' | 'revisao';

const ETAPAS: ReadonlyArray<{ chave: Etapa; titulo: string }> = [
  { chave: 'documento', titulo: 'Documento' },
  { chave: 'cnpj', titulo: 'CNPJ' },
  { chave: 'competencia', titulo: 'Competência' },
  { chave: 'valor', titulo: 'Valor a pagar' },
  { chave: 'termos', titulo: 'Termos' },
  { chave: 'revisao', titulo: 'Revisão' },
];

interface SelecaoCampo {
  valor: Faixa;
  /** Rótulo escolhido manualmente; sem ele, usa a sugestão automática. */
  rotulo?: Faixa;
}

interface Marca {
  tipo: CampoMapeavel | 'termo';
  papel: 'valor' | 'rotulo' | 'termo' | 'selecao' | 'erro';
}

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;

@Component({
  selector: 'app-pdf-mapeamento-modal',
  standalone: true,
  imports: [CommonModule],
  providers: [PdfDocumentoService],
  templateUrl: './pdf-mapeamento-modal.component.html',
  styleUrls: ['./pdf-mapeamento-modal.component.scss'],
})
export class PdfMapeamentoModalComponent implements OnInit, OnDestroy {
  /** PDF de exemplo já selecionado. Se ausente, o modal pede o arquivo. */
  @Input() arquivo: File | null = null;
  /** Mapeamento existente, para edição. */
  @Input() mapeamento: MapeamentoPdf | null = null;

  @Output() salvar = new EventEmitter<MapeamentoPdf>();
  @Output() cancelar = new EventEmitter<void>();

  @ViewChild('canvas', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;

  readonly etapas = ETAPAS;
  readonly campos = CAMPOS;
  readonly minimoTermos = MINIMO_TERMOS;

  readonly indiceEtapa = signal(0);
  readonly etapa = computed(() => ETAPAS[this.indiceEtapa()].chave);
  readonly campoDaEtapa = computed(() => CAMPOS.find(c => c.chave === this.etapa()) ?? null);
  readonly selecionavel = computed(() => !!this.campoDaEtapa() || this.etapa() === 'termos');

  readonly nome = signal('');
  readonly nomeArquivo = signal('');
  readonly carregando = signal(false);
  readonly erroArquivo = signal('');

  readonly doc = signal<DocumentoTexto | null>(null);
  readonly pagina = signal(1);
  readonly totalPaginas = signal(0);
  readonly zoom = signal(1.25);
  readonly tamanhoPagina = signal({ largura: 0, altura: 0 });

  readonly selecoes = signal<Partial<Record<CampoMapeavel, SelecaoCampo>>>({});
  readonly escolhendoRotulo = signal(false);
  readonly termos = signal<string[]>([]);
  readonly termoDigitado = signal('');
  /** Seleção em andamento enquanto o usuário arrasta (inicio = onde começou). */
  readonly arraste = signal<Faixa | null>(null);
  private inicioShift: number | null = null;

  readonly tokensDaPagina = computed(() => this.doc()?.tokens.filter(t => t.pagina === this.pagina()) ?? []);

  readonly construidos = computed(() => {
    const doc = this.doc();
    const resultado: Partial<Record<CampoMapeavel, CampoConstruido>> = {};
    if (!doc) return resultado;
    for (const campo of CAMPOS) {
      const selecao = this.selecoes()[campo.chave];
      if (selecao) resultado[campo.chave] = construirCampo(doc, campo.chave, selecao.valor, selecao.rotulo);
    }
    return resultado;
  });

  readonly termosInfo = computed(() => {
    const doc = this.doc();
    const vistos = new Set<string>();
    return this.termos().map(texto => {
      const chave = normalizarTexto(texto);
      const duplicado = vistos.has(chave);
      vistos.add(chave);
      return { texto, vazio: !chave, duplicado, encontrado: !!doc && !!chave && contemTermo(doc, texto) };
    });
  });

  readonly termosValidos = computed(() => this.termosInfo().filter(t => !t.vazio && !t.duplicado && t.encontrado).length);

  /** Teste do mapeamento aplicado ao próprio PDF de exemplo. */
  readonly revisao = computed(() => {
    const doc = this.doc();
    return CAMPOS.map(c => {
      const campo = this.construidos()[c.chave]?.campo;
      const teste = doc && campo ? extrairCampo(doc, c.chave, campo) : null;
      return { ...c, campo, teste, ok: !!campo && teste?.valor === campo.exemplo };
    });
  });

  readonly mapeamentoFinal = computed<MapeamentoPdf | null>(() => {
    const [cnpj, competencia, valor] = CAMPOS.map(c => this.construidos()[c.chave]?.campo);
    if (!this.nome().trim() || !cnpj || !competencia || !valor || this.termosValidos() < MINIMO_TERMOS) return null;
    const termos = this.termosInfo()
      .filter(t => !t.vazio && !t.duplicado && t.encontrado)
      .map(t => t.texto.trim());
    return { nome: this.nome().trim(), cnpj, competencia, valor, termos, arquivoExemplo: this.nomeArquivo() };
  });

  readonly marcas = computed(() => {
    const mapa = new Map<number, Marca>();
    const pintar = (faixa: Faixa | null | undefined, marca: Marca) => {
      if (faixa) for (let i = faixa.inicio; i <= faixa.fim; i++) mapa.set(i, marca);
    };
    const doc = this.doc();
    const etapa = this.etapa();

    for (const c of CAMPOS) {
      const construido = this.construidos()[c.chave];
      if (!construido) continue;
      const emFoco = etapa === c.chave || etapa === 'revisao';
      if (emFoco) pintar(construido.tokensRotulo, { tipo: c.chave, papel: 'rotulo' });
      if (construido.valor) pintar(construido.valor.tokens, { tipo: c.chave, papel: 'valor' });
      else if (emFoco) pintar(this.selecoes()[c.chave]?.valor, { tipo: c.chave, papel: 'erro' });
    }
    if (doc && (etapa === 'termos' || etapa === 'revisao')) {
      for (const termo of this.termos()) pintar(localizarTexto(doc, termo), { tipo: 'termo', papel: 'termo' });
    }
    const arraste = this.arraste();
    if (arraste) pintar(ordenar(arraste.inicio, arraste.fim), { tipo: this.campoDaEtapa()?.chave ?? 'termo', papel: 'selecao' });
    return mapa;
  });

  constructor(private readonly pdf: PdfDocumentoService) {}

  ngOnInit(): void {
    if (this.mapeamento) {
      this.nome.set(this.mapeamento.nome);
      this.termos.set([...this.mapeamento.termos]);
    }
    if (this.arquivo) this.carregar(this.arquivo);
  }

  ngOnDestroy(): void {
    this.pdf.fechar();
  }

  @HostListener('document:keydown.escape')
  aoPressionarEsc(): void {
    if (this.arraste() || this.escolhendoRotulo()) {
      this.arraste.set(null);
      this.escolhendoRotulo.set(false);
    } else {
      this.cancelar.emit();
    }
  }

  // ---- Etapas ----

  etapaConcluida(chave: Etapa): boolean {
    switch (chave) {
      case 'documento':
        return !!this.doc()?.tokens.length && !!this.nome().trim();
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
    this.escolhendoRotulo.set(false);
    this.arraste.set(null);
    this.inicioShift = null;

    const campo = this.campoDaEtapa();
    const faixa = campo && this.selecoes()[campo.chave]?.valor;
    if (faixa) this.irPara(this.doc()!.tokens[faixa.inicio].pagina);
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
      const { totalPaginas, tokens } = await this.pdf.abrir(arquivo);
      const doc = criarDocumentoTexto(tokens);
      this.doc.set(doc);
      this.nomeArquivo.set(arquivo.name);
      this.totalPaginas.set(totalPaginas);
      this.pagina.set(1);
      this.selecoes.set(this.mapeamento ? restaurarSelecoes(doc, this.mapeamento) : {});
      if (!tokens.length) this.erroArquivo.set('Este PDF não tem texto selecionável (provavelmente é digitalizado). Use um PDF com texto ou aplique OCR antes.');
      await this.renderizar();
    } catch {
      this.doc.set(null);
      this.totalPaginas.set(0);
      this.erroArquivo.set('Não foi possível abrir o PDF.');
    } finally {
      this.carregando.set(false);
    }
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

  private async renderizar(): Promise<void> {
    this.tamanhoPagina.set(await this.pdf.renderizar(this.pagina(), this.canvasRef.nativeElement, this.zoom()));
  }

  // ---- Seleção por clique / arraste ----

  aoPressionar(evento: PointerEvent): void {
    const indice = indiceDoEvento(evento);
    if (!this.selecionavel() || indice === null || evento.button !== 0) return;
    evento.preventDefault();
    if (evento.shiftKey && this.inicioShift !== null) {
      this.aplicarSelecao(ordenar(this.inicioShift, indice));
      return;
    }
    this.arraste.set({ inicio: indice, fim: indice });
  }

  aoPassar(evento: PointerEvent): void {
    const arraste = this.arraste();
    const indice = indiceDoEvento(evento);
    if (arraste && indice !== null && indice !== arraste.fim) this.arraste.set({ ...arraste, fim: indice });
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
      if (this.escolhendoRotulo()) {
        const atual = this.selecoes()[campo.chave];
        if (atual) this.selecoes.update(s => ({ ...s, [campo.chave]: { ...atual, rotulo: faixa } }));
        this.escolhendoRotulo.set(false);
      } else {
        this.selecoes.update(s => ({ ...s, [campo.chave]: { valor: faixa } }));
      }
    } else if (this.etapa() === 'termos') {
      this.adicionarTermo(textoDaFaixa(this.doc()!, faixa));
    }
  }

  // ---- Rótulo ----

  escolherRotulo(): void {
    this.escolhendoRotulo.set(!this.escolhendoRotulo());
  }

  usarRotuloSugerido(chave: CampoMapeavel): void {
    this.selecoes.update(s => ({ ...s, [chave]: { valor: s[chave]!.valor } }));
  }

  limparCampo(chave: CampoMapeavel): void {
    this.selecoes.update(s => {
      const { [chave]: _removido, ...resto } = s;
      return resto;
    });
  }

  // ---- Termos ----

  adicionarTermo(texto: string): void {
    const limpo = texto.trim().replace(/\s+/g, ' ');
    if (!limpo || this.termos().some(t => normalizarTexto(t) === normalizarTexto(limpo))) return;
    this.termos.update(lista => [...lista, limpo]);
  }

  adicionarTermoDigitado(): void {
    this.adicionarTermo(this.termoDigitado());
    this.termoDigitado.set('');
  }

  removerTermo(indice: number): void {
    this.termos.update(lista => lista.filter((_, i) => i !== indice));
  }

  // ---- Conclusão ----

  confirmar(): void {
    const mapeamento = this.mapeamentoFinal();
    if (mapeamento && this.etapaConcluida('revisao')) this.salvar.emit(mapeamento);
  }
}

function ordenar(a: number, b: number): Faixa {
  return { inicio: Math.min(a, b), fim: Math.max(a, b) };
}

function indiceDoEvento(evento: Event): number | null {
  const alvo = (evento.target as Element | null)?.closest?.('[data-indice]');
  return alvo ? Number(alvo.getAttribute('data-indice')) : null;
}

/** Reaplica um mapeamento salvo no PDF para mostrar as seleções ao editar. */
function restaurarSelecoes(doc: DocumentoTexto, mapeamento: MapeamentoPdf): Partial<Record<CampoMapeavel, SelecaoCampo>> {
  const selecoes: Partial<Record<CampoMapeavel, SelecaoCampo>> = {};
  for (const { chave } of CAMPOS) {
    const campo = mapeamento[chave];
    const encontrado = extrairCampo(doc, chave, campo);
    if (!encontrado) continue;
    const sugestao = construirCampo(doc, chave, encontrado.tokens).campo;
    const rotulo = campo.rotulo && sugestao?.rotulo !== campo.rotulo ? localizarTexto(doc, campo.rotulo, campo.ocorrenciaRotulo) : null;
    selecoes[chave] = rotulo ? { valor: encontrado.tokens, rotulo } : { valor: encontrado.tokens };
  }
  return selecoes;
}
