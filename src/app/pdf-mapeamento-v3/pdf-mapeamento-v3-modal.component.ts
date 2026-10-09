import { Component, EventEmitter, Input, OnDestroy, Output, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ARQUIVOS_ACEITOS, formatoDoArquivo } from '../pdf-mapeamento/documento-texto';
import { PdfDocumentoService } from '../pdf-mapeamento/pdf-documento.service';
import { normalizarTexto } from '../pdf-mapeamento/extrator';
import { MapeamentoPdfV2, baseParaEditar, termoPresente } from '../pdf-mapeamento-v2/mapeamento-v2';
import { MapeamentoSalvo } from '../armazenamento/mapeamentos-db.service';
import { Planilha, converterParaPlanilha } from '../pdf-mapeamento-v2/planilha';
import { PdfMapeamentoV2ModalComponent } from '../pdf-mapeamento-v2/pdf-mapeamento-v2-modal.component';
import { AssinaturaV3, MapeamentoPdfV3, gerarAssinatura } from './mapeamento-v3';

/**
 * v3: escolhe o PDF modelo, gera a assinatura (código de barras, rótulos do layout, páginas),
 * reaproveita o modal v2 para campos e termos e, no fim, pede os termos de exclusão.
 */
@Component({
  selector: 'app-pdf-mapeamento-v3-modal',
  standalone: true,
  imports: [CommonModule, PdfMapeamentoV2ModalComponent],
  providers: [PdfDocumentoService],
  templateUrl: './pdf-mapeamento-v3-modal.component.html',
  styleUrls: ['./pdf-mapeamento-v3-modal.component.scss'],
})
export class PdfMapeamentoV3ModalComponent implements OnDestroy {
  readonly aceitos = ARQUIVOS_ACEITOS;
  /** Mapeamentos salvos, para a validação comparar com o anterior do mesmo serviço. */
  @Input() salvos: MapeamentoSalvo[] = [];
  /** "Mapear Documentos" de um serviço já mapeado: reabre com campos, termos e exclusões dele. */
  @Input() set anterior(registro: MapeamentoSalvo | null) {
    this.base.set(baseParaEditar(registro?.mapeamento));
    const mapeamento = registro?.mapeamento;
    if (mapeamento && 'exclusoes' in mapeamento) this.textoExclusoes.set(mapeamento.exclusoes.join('\n'));
  }
  @Output() salvar = new EventEmitter<MapeamentoPdfV3>();
  @Output() cancelar = new EventEmitter<void>();

  readonly etapa = signal<'arquivo' | 'mapear' | 'assinatura'>('arquivo');
  readonly arquivo = signal<File | null>(null);
  readonly carregando = signal(false);
  readonly erro = signal('');

  private readonly planilha = signal<Planilha | null>(null);
  readonly assinatura = signal<AssinaturaV3 | null>(null);
  /** Resultado do modal v2; volta para ele ao editar. */
  readonly base = signal<MapeamentoPdfV2 | null>(null);
  readonly textoExclusoes = signal('');

  readonly exclusoes = computed(() => {
    const planilha = this.planilha();
    const vistos = new Set<string>();
    return this.textoExclusoes()
      .split('\n')
      .map(t => t.trim().replace(/\s+/g, ' '))
      .filter(t => t && !vistos.has(normalizarTexto(t)) && vistos.add(normalizarTexto(t)))
      .map(texto => ({ texto, noModelo: !!planilha && termoPresente(planilha, texto) }));
  });
  readonly podeSalvar = computed(() => !!this.base() && !!this.assinatura() && this.exclusoes().every(e => !e.noModelo));

  constructor(private readonly pdf: PdfDocumentoService) {}

  ngOnDestroy(): void {
    this.pdf.fechar();
  }

  async aoSelecionarArquivo(evento: Event): Promise<void> {
    const input = evento.target as HTMLInputElement;
    const arquivo = input.files?.[0];
    input.value = '';
    if (!arquivo) return;
    if (!formatoDoArquivo(arquivo)) {
      this.erro.set('Selecione um arquivo PDF, CSV ou TXT.');
      return;
    }
    this.erro.set('');
    this.carregando.set(true);
    try {
      const { tokens, dimensoes } = await this.pdf.abrir(arquivo);
      const planilha = converterParaPlanilha(tokens, dimensoes);
      this.planilha.set(planilha);
      this.assinatura.set(gerarAssinatura(planilha, dimensoes));
      this.arquivo.set(arquivo);
      this.etapa.set('mapear');
    } catch {
      this.erro.set('Não foi possível abrir o PDF.');
    } finally {
      await this.pdf.fechar();
      this.carregando.set(false);
    }
  }

  aoMapear(mapeamento: MapeamentoPdfV2): void {
    this.base.set(mapeamento);
    this.etapa.set('assinatura');
  }

  confirmar(): void {
    const base = this.base();
    const assinatura = this.assinatura();
    if (!base || !assinatura || !this.podeSalvar()) return;
    this.salvar.emit({ ...base, versao: 3, assinatura, exclusoes: this.exclusoes().map(e => e.texto) });
  }
}
