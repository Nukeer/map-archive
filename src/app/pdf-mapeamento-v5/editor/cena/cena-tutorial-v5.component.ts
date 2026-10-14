import { Component, computed, input } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import type { EtapaV5 } from '../editor-v5.state';
import { CELULAS_GUIA, Caixa, MiniGuiaComponent } from './mini-guia.component';

/** Onde a guia fica nas cenas de marcar um campo (a lateral mostra o que foi lido). */
const GUIA_CAMPO = { x: 20, y: 6 };
/** Na cena Termos a guia vai para a esquerda, e a lista de termos fica à direita. */
const GUIA_TERMOS = { x: 4, y: 6 };

interface Marcacao {
  tipo: 'cnpj' | 'competencia' | 'valor';
  celula: Caixa;
  rotulo: Caixa;
  titulo: string;
  lido: string;
  onde: string;
}

/** Cenas de marcar um campo: mesma coreografia, outra célula. */
const MARCACOES: Partial<Record<EtapaV5, Marcacao>> = {
  identificador: { tipo: 'cnpj', celula: CELULAS_GUIA.cpf, rotulo: CELULAS_GUIA.rotuloCpf, titulo: 'CPF', lido: '529.982.247-25', onde: 'Pág.1!B3' },
  competencia: { tipo: 'competencia', celula: CELULAS_GUIA.competencia, rotulo: CELULAS_GUIA.rotuloPeriodo, titulo: 'Competência', lido: '09/2026', onde: 'Pág.1!B4' },
  valor: { tipo: 'valor', celula: CELULAS_GUIA.valor, rotulo: CELULAS_GUIA.rotuloValor, titulo: 'Valor a pagar', lido: 'R$ 1.100,00', onde: 'Pág.1!B6' },
};

/** Guias da cena Conferir: o mesmo mapeamento lido em cada uma. */
const CONFERIDAS = [
  { guia: '★ alfa.pdf', id: '529.982.247-25', competencia: '09/2026', valor: 'R$ 1.100,00' },
  { guia: 'beta.pdf', id: '111.444.777-35', competencia: '08/2026', valor: 'R$ 250,00' },
  { guia: 'gama.pdf', id: '935.411.347-80', competencia: '07/2026', valor: 'R$ 99,90' },
];

/**
 * Animação do tutorial de cada etapa, em SVG com CSS: um cursor fazendo a ação da etapa sobre
 * uma guia de exemplo. O estilo base de cada elemento é o quadro final; com "reduzir movimento"
 * (sem animação) a cena mostra o resultado.
 */
@Component({
  selector: 'app-cena-tutorial-v5',
  standalone: true,
  imports: [MiniGuiaComponent, NgTemplateOutlet],
  templateUrl: './cena-tutorial-v5.component.html',
  styleUrls: ['./cena-tutorial-v5.component.scss'],
})
export class CenaTutorialV5Component {
  readonly etapa = input.required<EtapaV5>();

  readonly guiaCampo = `translate(${GUIA_CAMPO.x}, ${GUIA_CAMPO.y})`;
  readonly guiaTermos = `translate(${GUIA_TERMOS.x}, ${GUIA_TERMOS.y})`;
  readonly celulas = CELULAS_GUIA;
  readonly conferidas = CONFERIDAS;
  readonly arquivos = ['alfa.pdf', 'beta.pdf', 'gama.pdf'];

  readonly marcacao = computed(() => MARCACOES[this.etapa()] ?? null);
  /** Ponta do cursor sobre a célula marcada (coordenadas da cena). */
  readonly alvo = computed(() => {
    const m = this.marcacao();
    if (!m) return null;
    return { x: GUIA_CAMPO.x + m.celula.x + Math.min(12, m.celula.w / 3), y: GUIA_CAMPO.y + m.celula.y + m.celula.h * 0.65 };
  });
}
