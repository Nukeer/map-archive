import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterOutlet } from '@angular/router';
import { PdfMapeamentoModalComponent } from './pdf-mapeamento/pdf-mapeamento-modal.component';
import { PdfMapeamentoV2ModalComponent } from './pdf-mapeamento-v2/pdf-mapeamento-v2-modal.component';
import { PdfMapeamentoV3ModalComponent } from './pdf-mapeamento-v3/pdf-mapeamento-v3-modal.component';
import { PdfMapeamentoV4ModalComponent } from './pdf-mapeamento-v4/pdf-mapeamento-v4-modal.component';
import { MatchPdfComponent } from './match/match-pdf.component';
import { MapeamentoQualquer, MapeamentoSalvo, MapeamentosDbService } from './armazenamento/mapeamentos-db.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, RouterOutlet, PdfMapeamentoModalComponent, PdfMapeamentoV2ModalComponent, PdfMapeamentoV3ModalComponent, PdfMapeamentoV4ModalComponent, MatchPdfComponent],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss']
})
export class AppComponent implements OnInit {
  readonly modalAberto = signal<'v1' | 'v2' | 'v3' | 'v4' | null>(null);
  readonly mapeamentos = signal<MapeamentoSalvo[]>([]);
  readonly erro = signal('');

  constructor(private readonly db: MapeamentosDbService) {}

  ngOnInit(): void {
    this.recarregar();
  }

  async aoSalvar(mapeamento: MapeamentoQualquer): Promise<void> {
    try {
      await this.db.salvar(mapeamento);
      this.modalAberto.set(null);
      await this.recarregar();
    } catch (e) {
      this.erro.set(`Não foi possível salvar no banco local: ${(e as Error).message}`);
    }
  }

  async excluir(registro: MapeamentoSalvo): Promise<void> {
    if (!confirm(`Excluir o mapeamento "${registro.nome}"?`)) return;
    await this.db.excluir(registro.id);
    await this.recarregar();
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
