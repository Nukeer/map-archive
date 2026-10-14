import { AfterViewInit, Component, ElementRef, input, output, signal } from '@angular/core';
import { TutorialEtapa } from './tutorial-v5';
import type { EtapaV5 } from './editor-v5.state';
import { CenaTutorialV5Component } from './cena/cena-tutorial-v5.component';

export interface FechamentoTutorial {
  /** "Pular tutorial": não mostra mais nesta tela. */
  pularTudo: boolean;
  /** "Não mostrar de novo": não mostra mais neste navegador. */
  nuncaMais: boolean;
}

/** Introdução (sem `etapa`) ou cartão da etapa, sobre a tela. */
@Component({
  selector: 'app-tutorial-v5',
  standalone: true,
  imports: [CenaTutorialV5Component],
  templateUrl: './tutorial-v5.component.html',
  styleUrls: ['./tutorial-v5.component.scss'],
})
export class TutorialV5Component implements AfterViewInit {
  readonly etapa = input<TutorialEtapa | null>(null);
  /** Etapa cuja animação aparece no cartão. */
  readonly cena = input<EtapaV5 | null>(null);
  /** Ex.: "Etapa 2 de 7 · Identificador". */
  readonly rotulo = input('');
  readonly fechado = output<FechamentoTutorial>();

  readonly nuncaMais = signal(false);

  constructor(private readonly host: ElementRef<HTMLElement>) {}

  ngAfterViewInit(): void {
    this.host.nativeElement.querySelector<HTMLElement>('[data-foco-inicial]')?.focus();
  }

  fechar(pularTudo: boolean): void {
    this.fechado.emit({ pularTudo, nuncaMais: this.nuncaMais() });
  }
}
