import { Component, Input, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ARQUIVOS_ACEITOS, formatoDoArquivo } from '../pdf-mapeamento/documento-texto';
import { PdfDocumentoService } from '../pdf-mapeamento/pdf-documento.service';
import { MapeamentoSalvo } from '../armazenamento/mapeamentos-db.service';
import { ResultadoMatch, identificarDocumento, temScore, usaAparencia, verificarDocumento } from './match';

/** Valor do seletor para comparar com todos os mapeamentos com score (v3 em diante). */
const AUTOMATICO = '__automatico__';

/** Escolhe um mapeamento salvo, recebe outro PDF e verifica se é daquele tipo de documento. */
@Component({
  selector: 'app-match-pdf',
  standalone: true,
  imports: [CommonModule],
  providers: [PdfDocumentoService],
  templateUrl: './match-pdf.component.html',
  styleUrls: ['./match-pdf.component.scss'],
})
export class MatchPdfComponent {
  readonly aceitos = ARQUIVOS_ACEITOS;
  @Input({ required: true }) set mapeamentos(lista: MapeamentoSalvo[]) {
    this.lista.set(lista);
    const id = this.selecionadoId();
    if (id === AUTOMATICO ? !lista.some(temScore) : !lista.some(m => m.id === id)) {
      this.selecionadoId.set(lista[0]?.id ?? '');
      this.resultado.set(null);
    }
  }

  readonly lista = signal<MapeamentoSalvo[]>([]);
  readonly selecionadoId = signal('');
  readonly selecionado = computed(() => this.lista().find(m => m.id === this.selecionadoId()) ?? null);
  readonly automatico = AUTOMATICO;
  readonly modoAutomatico = computed(() => this.selecionadoId() === AUTOMATICO);
  readonly totalComScore = computed(() => this.lista().filter(temScore).length);

  readonly nomeArquivo = signal('');
  readonly verificando = signal(false);
  readonly erro = signal('');
  readonly resultado = signal<ResultadoMatch | null>(null);
  /** Modo automático: todos os mapeamentos com score, do mais provável para o menos. */
  readonly ranking = signal<ResultadoMatch[]>([]);
  /** Mais de um mapeamento aceitou o PDF: os mapeamentos estão parecidos demais. */
  readonly ambiguo = computed(() => this.ranking().filter(r => r.corresponde).length > 1);

  constructor(private readonly pdf: PdfDocumentoService) {}

  selecionar(id: string): void {
    this.selecionadoId.set(id);
    this.resultado.set(null);
    this.ranking.set([]);
    this.nomeArquivo.set('');
  }

  async aoSelecionarArquivo(evento: Event): Promise<void> {
    const input = evento.target as HTMLInputElement;
    const arquivo = input.files?.[0];
    input.value = '';
    const registro = this.selecionado();
    if (!arquivo || (!registro && !this.modoAutomatico())) return;

    this.erro.set('');
    this.resultado.set(null);
    this.ranking.set([]);
    this.nomeArquivo.set(arquivo.name);
    if (!formatoDoArquivo(arquivo)) {
      this.erro.set('Selecione um arquivo PDF, CSV ou TXT.');
      return;
    }
    this.verificando.set(true);
    try {
      const { tokens, dimensoes } = await this.pdf.abrir(arquivo);
      // Desenhar a página custa; só quando algum mapeamento v5 vai ser usado.
      const precisaAparencia = registro ? usaAparencia(registro) : this.lista().some(usaAparencia);
      const aparencia = precisaAparencia ? await this.pdf.aparencia().catch(() => undefined) : undefined;
      if (registro) {
        this.resultado.set(verificarDocumento(registro, tokens, dimensoes, aparencia));
      } else {
        const ranking = identificarDocumento(this.lista(), tokens, dimensoes, aparencia);
        this.ranking.set(ranking);
        this.resultado.set(ranking[0] ?? null);
      }
    } catch {
      this.erro.set('Não foi possível abrir o PDF.');
    } finally {
      await this.pdf.fechar();
      this.verificando.set(false);
    }
  }

  duvidoso(r: ResultadoMatch): boolean {
    return r.avaliacao?.veredito === 'duvidoso';
  }

  classe(r: ResultadoMatch): string {
    return r.corresponde ? 'ok' : this.duvidoso(r) ? 'duvidoso' : 'falha';
  }

  formatar(chave: string, valor: string): string {
    return chave === 'valor'
      ? Number(valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
      : valor;
  }
}
