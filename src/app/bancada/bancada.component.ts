import { Component, Input, OnDestroy, OnInit, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { PdfDocumentoService } from '../pdf-mapeamento/pdf-documento.service';
import { ARQUIVOS_ACEITOS, formatoDoArquivo } from '../pdf-mapeamento/documento-texto';
import { CAMPOS, CampoMapeavel } from '../pdf-mapeamento/pdf-mapeamento.model';
import { MapeamentoSalvo, MapeamentosDbService } from '../armazenamento/mapeamentos-db.service';
import { usaAparencia, verificarDocumento } from '../match/match';
import {
  AvaliacaoDocumento,
  DESFECHOS,
  DocumentoBancada,
  ExecucaoBancada,
  ResumoVersao,
  avaliarDocumento,
  compararExecucoes,
  exportarCsv,
  resumir,
} from './bancada';

type Versao = MapeamentoSalvo['versao'];

/** Valor do seletor para "outro tipo": nenhum mapeamento deve aceitar o documento. */
const OUTRO_TIPO = '__outro__';

/**
 * Bancada de testes: documentos com gabarito rodados contra todos os mapeamentos salvos, com
 * placar por versão e o que mudou desde a execução anterior.
 */
@Component({
  selector: 'app-bancada',
  standalone: true,
  imports: [CommonModule],
  providers: [PdfDocumentoService],
  templateUrl: './bancada.component.html',
  styleUrls: ['./bancada.component.scss'],
})
export class BancadaComponent implements OnInit, OnDestroy {
  @Input({ required: true }) set mapeamentos(lista: MapeamentoSalvo[]) {
    this.registros.set(lista);
  }

  readonly aceitos = ARQUIVOS_ACEITOS;
  readonly outroTipo = OUTRO_TIPO;
  readonly campos = CAMPOS;
  readonly desfechos = DESFECHOS;

  readonly registros = signal<MapeamentoSalvo[]>([]);
  readonly documentos = signal<DocumentoBancada[]>([]);
  readonly execucoes = signal<ExecucaoBancada[]>([]);
  /** Avaliações da execução feita nesta sessão: documento → uma por versão. */
  readonly avaliacoes = signal<Record<string, AvaliacaoDocumento[]>>({});
  /** Valores lidos pelo mapeamento do tipo certo, para preencher o gabarito de campos. */
  readonly lidos = signal<Record<string, Partial<Record<CampoMapeavel, string>>>>({});
  readonly falhas = signal<Record<string, string>>({});
  readonly executando = signal<{ atual: number; total: number } | null>(null);
  readonly expandido = signal<string | null>(null);
  readonly erro = signal('');

  readonly tipos = computed(() => [...new Set(this.registros().map(r => r.nome))].sort((a, b) => a.localeCompare(b)));
  readonly versoes = computed(() => [...new Set(this.registros().map(r => r.versao))].sort() as Versao[]);
  /** Documentos com o tipo do gabarito definido (os outros ficam fora da execução). */
  readonly prontos = computed(() => this.documentos().filter(d => d.gabarito.tipo !== undefined));
  readonly temResultado = computed(() => Object.keys(this.avaliacoes()).length > 0);

  /** Placar da execução mais recente, com a variação em relação à anterior. */
  readonly placar = computed(() => {
    const [atual, anterior] = this.execucoes();
    if (!atual) return null;
    const avaliadas = atual.resumos.filter(r => r.avaliados);
    const melhor = avaliadas.length ? avaliadas.reduce((a, b) => (b.taxaAcerto > a.taxaAcerto ? b : a)).versao : null;
    return {
      execucao: atual,
      resumos: atual.resumos,
      melhor,
      anterior: (versao: Versao) => anterior?.resumos.find(r => r.versao === versao),
    };
  });
  readonly mudancas = computed(() => {
    const [atual, anterior] = this.execucoes();
    if (!atual || !anterior) return null;
    const nomes = new Map(this.documentos().map(d => [d.id, d.nome]));
    return compararExecucoes(anterior, atual).map(m => ({ ...m, nome: nomes.get(m.documento) ?? 'documento removido' }));
  });

  constructor(
    private readonly db: MapeamentosDbService,
    private readonly pdf: PdfDocumentoService,
  ) {}

  async ngOnInit(): Promise<void> {
    try {
      this.documentos.set(await this.db.listarBancada());
      this.execucoes.set(await this.db.listarExecucoes());
    } catch (e) {
      this.erro.set(`Banco local indisponível: ${(e as Error).message}`);
    }
  }

  ngOnDestroy(): void {
    this.pdf.fechar();
  }

  // ---- Documentos e gabarito ----

  async adicionar(evento: Event): Promise<void> {
    const input = evento.target as HTMLInputElement;
    const arquivos = Array.from(input.files ?? []);
    input.value = '';
    const recusados = arquivos.filter(a => !formatoDoArquivo(a));
    this.erro.set(recusados.length ? `Ignorados (não são PDF, CSV nem TXT): ${recusados.map(a => a.name).join(', ')}` : '');
    for (const arquivo of arquivos.filter(a => formatoDoArquivo(a))) {
      await this.db.salvarDocumentoBancada({
        id: crypto.randomUUID(),
        nome: arquivo.name,
        arquivo,
        gabarito: { campos: {} },
        adicionadoEm: new Date().toISOString(),
      });
    }
    this.documentos.set(await this.db.listarBancada());
  }

  async definirTipo(documento: DocumentoBancada, valor: string): Promise<void> {
    const tipo = valor === '' ? undefined : valor === OUTRO_TIPO ? null : valor;
    await this.atualizar({ ...documento, gabarito: { ...documento.gabarito, tipo } });
  }

  async definirCampo(documento: DocumentoBancada, chave: CampoMapeavel, valor: string): Promise<void> {
    await this.atualizar({ ...documento, gabarito: { ...documento.gabarito, campos: { ...documento.gabarito.campos, [chave]: valor.trim() } } });
  }

  /** Copia para o gabarito o que o mapeamento do tipo certo leu (para conferir e corrigir à mão). */
  async usarLidos(documento: DocumentoBancada): Promise<void> {
    const lidos = this.lidos()[documento.id];
    if (lidos) await this.atualizar({ ...documento, gabarito: { ...documento.gabarito, campos: { ...lidos } } });
  }

  async remover(documento: DocumentoBancada): Promise<void> {
    if (!confirm(`Tirar "${documento.nome}" da bancada?`)) return;
    await this.db.excluirDocumentoBancada(documento.id);
    this.documentos.update(lista => lista.filter(d => d.id !== documento.id));
  }

  private async atualizar(documento: DocumentoBancada): Promise<void> {
    await this.db.salvarDocumentoBancada(documento);
    this.documentos.update(lista => lista.map(d => (d.id === documento.id ? documento : d)));
  }

  // ---- Execução ----

  async executar(): Promise<void> {
    const documentos = this.prontos();
    const registros = this.registros();
    if (!documentos.length || !registros.length || this.executando()) return;
    const precisaAparencia = registros.some(usaAparencia);
    const avaliacoes: Record<string, AvaliacaoDocumento[]> = {};
    const lidos: Record<string, Partial<Record<CampoMapeavel, string>>> = {};
    const falhas: Record<string, string> = {};

    for (const [i, documento] of documentos.entries()) {
      this.executando.set({ atual: i + 1, total: documentos.length });
      try {
        const { tokens, dimensoes } = await this.pdf.abrir(new File([documento.arquivo], documento.nome));
        const aparencia = precisaAparencia ? await this.pdf.aparencia().catch(() => undefined) : undefined;
        const resultados = registros.map(r => verificarDocumento(r, tokens, dimensoes, aparencia));
        avaliacoes[documento.id] = this.versoes().map(v =>
          avaliarDocumento(v, resultados.filter(r => r.mapeamento.versao === v), documento.gabarito),
        );
        if (!tokens.length) falhas[documento.id] = 'sem texto selecionável (digitalizado?)';

        // O que o tipo certo leu, do resultado mais confiável entre as versões.
        const doTipo = resultados
          .filter(r => r.mapeamento.nome === documento.gabarito.tipo)
          .sort((a, b) => Number(b.corresponde) - Number(a.corresponde) || (b.avaliacao?.confianca ?? 0) - (a.avaliacao?.confianca ?? 0))[0];
        if (doTipo) lidos[documento.id] = Object.fromEntries(doTipo.campos.filter(c => c.valor).map(c => [c.chave, c.valor!]));
      } catch {
        falhas[documento.id] = 'não foi possível abrir';
      } finally {
        await this.pdf.fechar();
      }
    }

    const execucao: ExecucaoBancada = {
      id: crypto.randomUUID(),
      dataHora: new Date().toISOString(),
      resumos: this.versoes().map(v => resumir(v, Object.values(avaliacoes).flatMap(a => a.filter(x => x.versao === v)))),
      desfechos: Object.fromEntries(Object.entries(avaliacoes).map(([id, lista]) => [id, Object.fromEntries(lista.map(a => [a.versao, a.desfecho]))])),
    };
    this.avaliacoes.set(avaliacoes);
    this.lidos.set(lidos);
    this.falhas.set(falhas);
    try {
      await this.db.salvarExecucao(execucao);
      this.execucoes.set(await this.db.listarExecucoes());
    } catch (e) {
      this.erro.set(`Execução feita, mas não foi possível guardá-la: ${(e as Error).message}`);
      this.execucoes.update(lista => [execucao, ...lista]);
    }
    this.executando.set(null);
  }

  baixarCsv(): void {
    const blob = new Blob(['﻿' + exportarCsv(this.documentos(), this.avaliacoes())], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `bancada-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  // ---- Exibição ----

  alternar(id: string): void {
    this.expandido.update(atual => (atual === id ? null : id));
  }

  avaliacao(documento: DocumentoBancada, versao: Versao): AvaliacaoDocumento | undefined {
    return this.avaliacoes()[documento.id]?.find(a => a.versao === versao);
  }

  icone(a: AvaliacaoDocumento): string {
    const certo = DESFECHOS[a.desfecho].certo;
    return certo === null ? '–' : certo ? (a.duvidoso ? '?' : '✓') : '✗';
  }

  camposCertos(a: AvaliacaoDocumento): string {
    return a.campos.length ? `${a.campos.filter(c => c.certo).length}/${a.campos.length} campos` : '';
  }

  /** Variação da taxa de acerto em pontos percentuais; vazio sem execução anterior comparável. */
  variacao(atual: ResumoVersao, anterior: ResumoVersao | undefined): number | null {
    return anterior?.avaliados ? Math.round((atual.taxaAcerto - anterior.taxaAcerto) * 100) : null;
  }

  rotuloCampo(chave: CampoMapeavel): string {
    return CAMPOS.find(c => c.chave === chave)!.rotulo;
  }
}
