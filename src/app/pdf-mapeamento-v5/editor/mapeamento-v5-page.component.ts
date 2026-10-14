import { Component, OnDestroy, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MapeamentoSalvo } from '../../armazenamento/mapeamentos-db.service';
import { ARQUIVOS_ACEITOS, formatoDoArquivo } from '../../pdf-mapeamento/documento-texto';
import { PdfDocumentoService } from '../../pdf-mapeamento/pdf-documento.service';
import { CAMPOS, CampoMapeavel } from '../../pdf-mapeamento/pdf-mapeamento.model';
import { converterParaPlanilha } from '../../pdf-mapeamento-v2/planilha';
import { MapeamentoPdfV5 } from '../mapeamento-v5';
import { EditorV5State } from './editor-v5.state';
import { PassosV5Component } from './passos-v5.component';
import { VisualizadorDocumentoComponent } from './visualizador-documento.component';

/**
 * v5 em tela inteira, no formato da validação de layouts: documento à esquerda, etapas à
 * direita, "Próximo" que diz o que falta, tutorial e conferência de todas as guias no centro.
 */
@Component({
  selector: 'app-mapeamento-v5',
  standalone: true,
  imports: [CommonModule, PassosV5Component, VisualizadorDocumentoComponent],
  providers: [EditorV5State, PdfDocumentoService],
  templateUrl: './mapeamento-v5-page.component.html',
  styleUrls: ['./mapeamento-v5-page.component.scss'],
})
export class MapeamentoV5PageComponent implements OnInit, OnDestroy {
  readonly state = inject(EditorV5State);
  private readonly pdf = inject(PdfDocumentoService);

  /** Serviço reaberto por "Mapear Documentos"; null = mapeamento novo. */
  readonly anterior = input<MapeamentoSalvo | null>(null);
  /** Mapeamentos salvos: comparação com o anterior do serviço e sugestões a partir dos outros tipos. */
  readonly salvos = input<MapeamentoSalvo[]>([]);
  readonly salvar = output<MapeamentoPdfV5>();
  readonly cancelar = output<void>();

  readonly aceitos = ARQUIVOS_ACEITOS;
  readonly campos = CAMPOS;
  readonly arrastando = signal(false);

  readonly podeMarcar = computed(() => !!this.state.atual().marca && this.state.modeloExibido() === this.state.principal());
  readonly avisoVisualizador = computed(() => {
    if (this.state.modeloExibido() !== this.state.principal()) {
      return 'Guia de conferência: mostro onde o mapeamento leu nesta guia. Para marcar, volte à guia principal (★).';
    }
    return null;
  });
  readonly guiasComFalha = computed(() => new Set(this.state.testes().filter(t => !t.ok).map(t => t.nome)));

  private overflowAnterior = '';

  ngOnInit(): void {
    this.state.salvos.set(this.salvos());
    this.state.abrirAnterior(this.anterior());
    // A tela cobre a página: a página de trás não rola junto.
    this.overflowAnterior = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }

  ngOnDestroy(): void {
    document.body.style.overflow = this.overflowAnterior;
    this.pdf.fechar();
  }

  // ---- Arquivos ----

  aoEscolher(evento: Event): void {
    const input = evento.target as HTMLInputElement;
    const arquivos = Array.from(input.files ?? []);
    input.value = '';
    this.carregar(arquivos);
  }

  aoArrastarPorCima(evento: DragEvent): void {
    evento.preventDefault();
    this.arrastando.set(true);
  }

  aoSoltar(evento: DragEvent): void {
    evento.preventDefault();
    this.arrastando.set(false);
    this.carregar(Array.from(evento.dataTransfer?.files ?? []));
  }

  async carregar(arquivos: File[]): Promise<void> {
    if (!arquivos.length || this.state.carregando()) return;
    const vagas = this.state.maximoModelos - this.state.modelos().length;
    const avisos: string[] = [];
    if (arquivos.length > vagas) avisos.push(`No máximo ${this.state.maximoModelos} guias: ${arquivos.length - Math.max(0, vagas)} ficaram de fora.`);
    this.state.carregando.set(true);
    try {
      for (const arquivo of arquivos.slice(0, Math.max(0, vagas))) {
        if (!formatoDoArquivo(arquivo)) {
          avisos.push(`${arquivo.name} não é PDF, CSV nem TXT.`);
          continue;
        }
        if (this.state.modelos().some(m => m.nome === arquivo.name)) continue;
        try {
          const { tokens, dimensoes } = await this.pdf.abrir(arquivo);
          const aparencia = await this.pdf.aparencia().catch(() => null);
          const planilha = converterParaPlanilha(tokens, dimensoes);
          this.state.adicionarModelo({ nome: arquivo.name, arquivo, planilha, dimensoes, aparencia, semTexto: !tokens.length });
        } catch {
          avisos.push(`Não foi possível abrir ${arquivo.name}.`);
        }
      }
    } finally {
      await this.pdf.fechar();
      this.state.carregando.set(false);
      this.state.erroArquivos.set(avisos.join(' '));
    }
  }

  // ---- Centro ----

  mostrar(indice: number): void {
    this.state.exibido.set(indice);
    this.state.centro.set('documento');
  }

  mostrarPorNome(nome: string): void {
    const indice = this.state.validos().findIndex(m => m.nome === nome);
    if (indice >= 0) this.mostrar(indice);
  }

  rotuloCampo(chave: CampoMapeavel): string {
    return chave === 'cnpj' ? this.state.nomeDoIdentificador() : CAMPOS.find(c => c.chave === chave)!.rotulo;
  }

  formatar(chave: CampoMapeavel, valor: string | null): string {
    if (valor === null) return 'não lido';
    const numero = Number(valor);
    return chave === 'valor' && Number.isFinite(numero) ? numero.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : valor;
  }

  // ---- Saída ----

  /** Voltar, X: pergunta antes de perder o que foi marcado. */
  sair(): void {
    if (this.state.alterado() && !confirm('Sair sem concluir? O que você marcou nesta tela será perdido.')) return;
    this.cancelar.emit();
  }

  concluir(): void {
    const mapeamento = this.state.mapeamentoFinal();
    if (mapeamento) this.salvar.emit(mapeamento);
  }
}
