import { Component, EventEmitter, Input, OnDestroy, Output, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ARQUIVOS_ACEITOS, formatoDoArquivo } from '../pdf-mapeamento/documento-texto';
import { PdfDocumentoService } from '../pdf-mapeamento/pdf-documento.service';
import { normalizarTexto } from '../pdf-mapeamento/extrator';
import { CAMPOS } from '../pdf-mapeamento/pdf-mapeamento.model';
import { MapeamentoPdfV2, baseParaEditar, termoPresente } from '../pdf-mapeamento-v2/mapeamento-v2';
import { MapeamentoSalvo } from '../armazenamento/mapeamentos-db.service';
import { converterParaPlanilha } from '../pdf-mapeamento-v2/planilha';
import { PdfMapeamentoV2ModalComponent } from '../pdf-mapeamento-v2/pdf-mapeamento-v2-modal.component';
import {
  MAXIMO_MODELOS,
  MINIMO_MODELOS,
  MapeamentoPdfV4,
  ModeloV4,
  gerarAssinaturaV4,
  sugerirTermos,
  testarNosModelos,
} from './mapeamento-v4';

interface ModeloCarregado extends ModeloV4 {
  arquivo: File;
  semTexto: boolean;
}

/**
 * v4: recebe vários PDFs modelo do mesmo tipo, usa o 1º no modal v2 para marcar campos e termos
 * e aprende a assinatura comparando todos (rótulos estáveis, código de barras, posições).
 */
@Component({
  selector: 'app-pdf-mapeamento-v4-modal',
  standalone: true,
  imports: [CommonModule, PdfMapeamentoV2ModalComponent],
  providers: [PdfDocumentoService],
  templateUrl: './pdf-mapeamento-v4-modal.component.html',
  styleUrls: ['./pdf-mapeamento-v4-modal.component.scss'],
})
export class PdfMapeamentoV4ModalComponent implements OnDestroy {
  readonly aceitos = ARQUIVOS_ACEITOS;
  /** Mapeamentos salvos, para a validação comparar com o anterior do mesmo serviço. */
  @Input() salvos: MapeamentoSalvo[] = [];
  /** "Mapear Documentos" de um serviço já mapeado: reabre com campos, termos e exclusões dele. */
  @Input() set anterior(registro: MapeamentoSalvo | null) {
    this.base.set(baseParaEditar(registro?.mapeamento));
    const mapeamento = registro?.mapeamento;
    if (mapeamento && 'exclusoes' in mapeamento) this.textoExclusoes.set(mapeamento.exclusoes.join('\n'));
  }
  @Output() salvar = new EventEmitter<MapeamentoPdfV4>();
  @Output() cancelar = new EventEmitter<void>();

  readonly minimoModelos = MINIMO_MODELOS;
  readonly maximoModelos = MAXIMO_MODELOS;
  readonly campos = CAMPOS;

  readonly etapa = signal<'arquivos' | 'mapear' | 'revisao'>('arquivos');
  readonly modelos = signal<ModeloCarregado[]>([]);
  readonly carregando = signal(false);
  readonly erro = signal('');

  /** Resultado do modal v2 (feito no 1º modelo); volta para ele ao editar. */
  readonly base = signal<MapeamentoPdfV2 | null>(null);
  readonly textoExclusoes = signal('');
  /** Textos das sugestões marcadas para virar termos. */
  readonly sugestoesEscolhidas = signal<ReadonlySet<string>>(new Set());

  readonly validos = computed(() => this.modelos().filter(m => !m.semTexto));
  readonly podeAvancar = computed(() => this.validos().length >= MINIMO_MODELOS);

  readonly gerado = computed(() => (this.validos().length ? gerarAssinaturaV4(this.validos()) : null));
  readonly testes = computed(() => {
    const base = this.base();
    return base ? testarNosModelos(base, this.validos()) : [];
  });
  readonly algumModeloFalhou = computed(() => this.testes().some(t => !t.ok));
  readonly sugestoes = computed(() => {
    const base = this.base();
    const gerado = this.gerado();
    return base && gerado ? sugerirTermos(gerado.assinatura, this.validos()[0].planilha, base.termos) : [];
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
          const planilha = converterParaPlanilha(tokens, dimensoes);
          this.modelos.update(lista => [...lista, { nome: arquivo.name, arquivo, planilha, dimensoes, semTexto: !tokens.length }]);
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

  confirmar(): void {
    const base = this.base();
    const gerado = this.gerado();
    if (!base || !gerado || !this.podeSalvar()) return;
    const extras = this.sugestoes().filter(s => this.sugestoesEscolhidas().has(s.texto));
    this.salvar.emit({
      ...base,
      versao: 4,
      termos: [...base.termos, ...extras],
      assinatura: gerado.assinatura,
      exclusoes: this.exclusoes().map(e => e.texto),
      arquivosModelo: this.validos().map(m => m.nome),
    });
  }
}
