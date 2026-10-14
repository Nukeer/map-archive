import { Component, OnInit, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterOutlet } from '@angular/router';
import { PdfMapeamentoModalComponent } from './pdf-mapeamento/pdf-mapeamento-modal.component';
import { PdfMapeamentoV2ModalComponent } from './pdf-mapeamento-v2/pdf-mapeamento-v2-modal.component';
import { PdfMapeamentoV3ModalComponent } from './pdf-mapeamento-v3/pdf-mapeamento-v3-modal.component';
import { PdfMapeamentoV4ModalComponent } from './pdf-mapeamento-v4/pdf-mapeamento-v4-modal.component';
import { MapeamentoV5PageComponent } from './pdf-mapeamento-v5/editor/mapeamento-v5-page.component';
import { MatchPdfComponent } from './match/match-pdf.component';
import { BancadaComponent } from './bancada/bancada.component';
import { EntradaHistorico, MapeamentoQualquer, MapeamentoSalvo, MapeamentosDbService, versaoDoMapeamento } from './armazenamento/mapeamentos-db.service';
import { normalizarTexto } from './pdf-mapeamento/extrator';
import { MapeamentoPdf } from './pdf-mapeamento/pdf-mapeamento.model';
import { baseParaEditar } from './pdf-mapeamento-v2/mapeamento-v2';

type Versao = 'v1' | 'v2' | 'v3' | 'v4' | 'v5';

const CHAVE_RESPONSAVEL = 'map-archive:responsavel';

function lerResponsavel(): string {
  try {
    return localStorage.getItem(CHAVE_RESPONSAVEL) ?? '';
  } catch {
    return '';
  }
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, RouterOutlet, PdfMapeamentoModalComponent, PdfMapeamentoV2ModalComponent, PdfMapeamentoV3ModalComponent, PdfMapeamentoV4ModalComponent, MapeamentoV5PageComponent, MatchPdfComponent, BancadaComponent],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss']
})
export class AppComponent implements OnInit {
  readonly aba = signal<'servicos' | 'bancada'>('servicos');
  readonly modalAberto = signal<Versao | null>(null);
  /** Serviço reaberto por "Mapear Documentos"; null = mapeamento novo. */
  readonly anterior = signal<MapeamentoSalvo | null>(null);
  readonly mapeamentos = signal<MapeamentoSalvo[]>([]);
  readonly erro = signal('');
  /** Alerta em tela ao concluir; com divergência, lista o que divergiu. */
  readonly aviso = signal<{ texto: string; divergencias: string[] } | null>(null);
  /** Quem está mapeando (no Tareffa viria do usuário logado). */
  readonly responsavel = signal(lerResponsavel());
  readonly historicoAberto = signal<string | null>(null);

  /** Modais que reabrem pelos campos (v1 e v2); v3 em diante recebem o registro inteiro. */
  readonly mapeamentoV1Anterior = computed(() => {
    const a = this.anterior();
    return a?.versao === 1 ? (a.mapeamento as MapeamentoPdf) : null;
  });
  readonly baseAnterior = computed(() => baseParaEditar(this.anterior()?.mapeamento));

  constructor(private readonly db: MapeamentosDbService) {}

  ngOnInit(): void {
    this.recarregar();
  }

  novo(versao: Versao): void {
    this.anterior.set(null);
    this.modalAberto.set(versao);
  }

  /** "Mapear Documentos" de um serviço já mapeado: reabre o assistente da mesma versão com o que foi marcado. */
  mapearDocumentos(registro: MapeamentoSalvo): void {
    this.anterior.set(registro);
    this.modalAberto.set(`v${registro.versao}`);
  }

  fecharModal(): void {
    this.modalAberto.set(null);
    this.anterior.set(null);
  }

  definirResponsavel(nome: string): void {
    this.responsavel.set(nome.trim());
    try {
      localStorage.setItem(CHAVE_RESPONSAVEL, nome.trim());
    } catch {
      // Sem armazenamento local: vale só nesta sessão.
    }
  }

  async aoSalvar(recebido: MapeamentoQualquer): Promise<void> {
    const { divergencias = [], ...mapeamento } = recebido as MapeamentoQualquer & { divergencias?: string[] };
    const versao = versaoDoMapeamento(mapeamento as MapeamentoQualquer);
    const nome = normalizarTexto(mapeamento.nome);
    // Um layout por serviço e versão: mapear de novo atualiza o registro e acumula o histórico.
    const existente = this.anterior() ?? this.mapeamentos().find(m => m.versao === versao && normalizarTexto(m.nome) === nome);
    try {
      await this.db.salvar(mapeamento as MapeamentoQualquer, existente?.id, {
        responsavel: this.responsavel() || 'não informado',
        divergencias,
      });
      this.fecharModal();
      this.aviso.set(
        divergencias.length
          ? {
              texto:
                `Mapeamento de "${mapeamento.nome}" concluído com divergência. O gestor responsável pelo departamento do serviço ` +
                'será notificado pela Central de Notificações (no protótipo, a notificação fica registrada no histórico).',
              divergencias,
            }
          : { texto: `Mapeamento de "${mapeamento.nome}" concluído.`, divergencias: [] },
      );
      await this.recarregar();
    } catch (e) {
      this.erro.set(`Não foi possível salvar no banco local: ${(e as Error).message}`);
    }
  }

  async excluir(registro: MapeamentoSalvo): Promise<void> {
    if (!confirm(`Excluir o mapeamento "${registro.nome}" e o histórico dele?`)) return;
    await this.db.excluir(registro.id);
    await this.recarregar();
  }

  alternarHistorico(id: string): void {
    this.historicoAberto.update(atual => (atual === id ? null : id));
  }

  /** Do mais recente para o mais antigo. */
  historico(registro: MapeamentoSalvo): EntradaHistorico[] {
    return [...(registro.historico ?? [])].reverse();
  }

  private async recarregar(): Promise<void> {
    try {
      this.mapeamentos.set(await this.db.listar());
      this.erro.set('');
    } catch (e) {
      this.erro.set(`Banco local indisponível: ${(e as Error).message}`);
    }
  }
}
