import { Component, EventEmitter, Input, OnDestroy, Output, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ARQUIVOS_ACEITOS, formatoDoArquivo } from '../pdf-mapeamento/documento-texto';
import { PdfDocumentoService } from '../pdf-mapeamento/pdf-documento.service';
import { normalizarTexto } from '../pdf-mapeamento/extrator';
import { CAMPOS } from '../pdf-mapeamento/pdf-mapeamento.model';
import { MapeamentoPdfV2, baseParaEditar, termoPresente } from '../pdf-mapeamento-v2/mapeamento-v2';
import { converterParaPlanilha } from '../pdf-mapeamento-v2/planilha';
import { PdfMapeamentoV2ModalComponent } from '../pdf-mapeamento-v2/pdf-mapeamento-v2-modal.component';
import { MAXIMO_MODELOS, MINIMO_MODELOS, testarNosModelos } from '../pdf-mapeamento-v4/mapeamento-v4';
import { MapeamentoSalvo } from '../armazenamento/mapeamentos-db.service';
import { BITS_MAPA, paraBits } from './aparencia';
import { MapeamentoPdfV5, ModeloV5, PARECIDO_MINIMO, compararComOutrosTipos, gerarAssinaturaV5, outrosTipos } from './mapeamento-v5';

interface ModeloCarregado extends ModeloV5 {
  arquivo: File;
  semTexto: boolean;
}

/**
 * v5: igual à v4 (vários modelos, campos e termos no 1º), mas também desenha cada modelo para
 * aprender a aparência e compara com os outros tipos salvos para sugerir termos e exclusões.
 */
@Component({
  selector: 'app-pdf-mapeamento-v5-modal',
  standalone: true,
  imports: [CommonModule, PdfMapeamentoV2ModalComponent],
  providers: [PdfDocumentoService],
  templateUrl: './pdf-mapeamento-v5-modal.component.html',
  styleUrls: ['../pdf-mapeamento-v4/pdf-mapeamento-v4-modal.component.scss'],
})
export class PdfMapeamentoV5ModalComponent implements OnDestroy {
  readonly aceitos = ARQUIVOS_ACEITOS;
  /** Mapeamentos já salvos, para o contraste entre tipos. */
  @Input() set outros(lista: MapeamentoSalvo[]) {
    this.salvos.set(lista);
  }
  /** "Mapear Documentos" de um serviço já mapeado: reabre com campos, termos e exclusões dele. */
  @Input() set anterior(registro: MapeamentoSalvo | null) {
    this.base.set(baseParaEditar(registro?.mapeamento));
    const mapeamento = registro?.mapeamento;
    if (mapeamento && 'exclusoes' in mapeamento) this.textoExclusoes.set(mapeamento.exclusoes.join('\n'));
  }
  @Output() salvar = new EventEmitter<MapeamentoPdfV5>();
  @Output() cancelar = new EventEmitter<void>();

  readonly minimoModelos = MINIMO_MODELOS;
  readonly maximoModelos = MAXIMO_MODELOS;
  readonly parecidoMinimo = PARECIDO_MINIMO;
  readonly bitsMapa = BITS_MAPA;
  readonly campos = CAMPOS;

  readonly etapa = signal<'arquivos' | 'mapear' | 'revisao'>('arquivos');
  readonly modelos = signal<ModeloCarregado[]>([]);
  readonly carregando = signal(false);
  readonly erro = signal('');

  readonly salvos = signal<MapeamentoSalvo[]>([]);
  /** Resultado do modal v2 (feito no 1º modelo); volta para ele ao editar. */
  readonly base = signal<MapeamentoPdfV2 | null>(null);
  readonly textoExclusoes = signal('');
  /** Textos das sugestões marcadas para virar termos. */
  readonly sugestoesEscolhidas = signal<ReadonlySet<string>>(new Set());

  readonly validos = computed(() => this.modelos().filter(m => !m.semTexto));
  readonly podeAvancar = computed(() => this.validos().length >= MINIMO_MODELOS);

  readonly gerado = computed(() => (this.validos().length ? gerarAssinaturaV5(this.validos()) : null));
  readonly bordasEstaveis = computed(() => {
    const visual = this.gerado()?.assinatura.visual;
    return visual ? paraBits(visual.bordas).filter(Boolean).length : 0;
  });
  readonly testes = computed(() => {
    const base = this.base();
    return base ? testarNosModelos(base, this.validos()) : [];
  });
  readonly algumModeloFalhou = computed(() => this.testes().some(t => !t.ok));
  readonly comparacao = computed(() => {
    const base = this.base();
    const gerado = this.gerado();
    if (!base || !gerado) return null;
    return compararComOutrosTipos(gerado.assinatura, this.validos(), base.termos, outrosTipos(this.salvos(), base.nome));
  });

  readonly exclusoes = computed(() => {
    const vistos = new Set<string>();
    return this.textoExclusoes()
      .split('\n')
      .map(t => t.trim().replace(/\s+/g, ' '))
      .filter(t => t && !vistos.has(normalizarTexto(t)) && vistos.add(normalizarTexto(t)))
      .map(texto => ({ texto, nosModelos: this.validos().filter(m => termoPresente(m.planilha, texto)).map(m => m.nome) }));
  });
  readonly podeSalvar = computed(() => !!this.base() && !!this.gerado() && this.exclusoes().every(e => !e.nosModelos.length));

  constructor(private readonly pdf: PdfDocumentoService) {}

  ngOnDestroy(): void {
    this.pdf.fechar();
  }

  async aoSelecionarArquivos(evento: Event): Promise<void> {
    const input = evento.target as HTMLInputElement;
    const arquivos = Array.from(input.files ?? []);
    input.value = '';
    if (!arquivos.length) return;

    this.erro.set('');
    const vagas = MAXIMO_MODELOS - this.modelos().length;
    if (arquivos.length > vagas) this.erro.set(`No máximo ${MAXIMO_MODELOS} modelos; ${arquivos.length - vagas} arquivo(s) ignorado(s).`);
    this.carregando.set(true);
    try {
      for (const arquivo of arquivos.slice(0, Math.max(0, vagas))) {
        if (!formatoDoArquivo(arquivo)) {
          this.erro.set(`${arquivo.name} não é PDF, CSV nem TXT.`);
          continue;
        }
        if (this.modelos().some(m => m.nome === arquivo.name)) continue;
        try {
          const { tokens, dimensoes } = await this.pdf.abrir(arquivo);
          const aparencia = await this.pdf.aparencia().catch(() => null);
          const planilha = converterParaPlanilha(tokens, dimensoes);
          this.modelos.update(lista => [...lista, { nome: arquivo.name, arquivo, planilha, dimensoes, aparencia, semTexto: !tokens.length }]);
        } catch {
          this.erro.set(`Não foi possível abrir ${arquivo.name}.`);
        }
      }
    } finally {
      await this.pdf.fechar();
      this.carregando.set(false);
    }
  }

  removerModelo(indice: number): void {
    this.modelos.update(lista => lista.filter((_, i) => i !== indice));
  }

  /** O 1º modelo é o usado para marcar os campos. */
  tornarPrincipal(indice: number): void {
    this.modelos.update(lista => [lista[indice], ...lista.filter((_, i) => i !== indice)]);
  }

  aoMapear(mapeamento: MapeamentoPdfV2): void {
    this.base.set(mapeamento);
    this.sugestoesEscolhidas.set(new Set());
    this.etapa.set('revisao');
  }

  alternarSugestao(texto: string): void {
    this.sugestoesEscolhidas.update(atual => {
      const novo = new Set(atual);
      if (!novo.delete(texto)) novo.add(texto);
      return novo;
    });
  }

  exclusaoMarcada(texto: string): boolean {
    return this.exclusoes().some(e => normalizarTexto(e.texto) === normalizarTexto(texto));
  }

  /** Inclui ou tira a exclusão sugerida da caixa de texto, para passar pela mesma conferência. */
  alternarExclusao(texto: string): void {
    const linhas = this.textoExclusoes()
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);
    const restantes = linhas.filter(l => normalizarTexto(l) !== normalizarTexto(texto));
    this.textoExclusoes.set((restantes.length < linhas.length ? restantes : [...linhas, texto]).join('\n'));
  }

  confirmar(): void {
    const base = this.base();
    const gerado = this.gerado();
    if (!base || !gerado || !this.podeSalvar()) return;
    const extras = (this.comparacao()?.termos ?? [])
      .filter(s => this.sugestoesEscolhidas().has(s.texto))
      .map(({ texto, celula }) => ({ texto, celula }));
    this.salvar.emit({
      ...base,
      versao: 5,
      termos: [...base.termos, ...extras],
      assinatura: gerado.assinatura,
      exclusoes: this.exclusoes().map(e => e.texto),
      arquivosModelo: this.validos().map(m => m.nome),
    });
  }
}
