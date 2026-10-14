import { Component, ElementRef, Injector, afterNextRender, computed, effect, inject, output, signal, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ARQUIVOS_ACEITOS } from '../../pdf-mapeamento/documento-texto';
import { normalizarTexto } from '../../pdf-mapeamento/extrator';
import { IDENTIFICADORES, TIPOS_IDENTIFICADOR, TipoIdentificador, nomeIdentificador } from '../../pdf-mapeamento/identificador';
import { CAMPOS, CampoMapeavel, MINIMO_TERMOS } from '../../pdf-mapeamento/pdf-mapeamento.model';
import { CampoMapeadoV2 } from '../../pdf-mapeamento-v2/mapeamento-v2';
import { ItemVerificacao } from '../../pdf-mapeamento-v2/verificacao';
import { MINIMO_MODELOS } from '../../pdf-mapeamento-v4/mapeamento-v4';
import { BITS_MAPA, paraBits } from '../aparencia';
import { EditorV5State, EtapaV5 } from './editor-v5.state';
import { TUTORIAIS_V5, ocultarTutorial, tutorialOculto } from './tutorial-v5';
import { FechamentoTutorial, TutorialV5Component } from './tutorial-v5.component';

/** Etapa do assistente onde se corrige cada item da verificação. */
const ETAPA_DO_ITEM: Record<ItemVerificacao['etapa'], EtapaV5> = {
  cnpj: 'identificador',
  competencia: 'competencia',
  valor: 'valor',
  termos: 'termos',
};

/**
 * Painel de etapas: lista vertical com a etapa atual aberta, resumo das feitas e o rodapé com
 * "Próximo: …" (que diz o que falta quando bloqueado). Tutorial na primeira vez.
 */
@Component({
  selector: 'app-passos-v5',
  standalone: true,
  imports: [CommonModule, TutorialV5Component],
  templateUrl: './passos-v5.component.html',
  styleUrls: ['./passos-v5.component.scss'],
})
export class PassosV5Component {
  readonly state = inject(EditorV5State);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  readonly adicionar = output<Event>();
  readonly concluir = output<void>();
  /** Mostrar uma guia de conferência no visualizador. */
  readonly mostrarGuia = output<string>();

  readonly aceitos = ARQUIVOS_ACEITOS;
  readonly minimoModelos = MINIMO_MODELOS;
  readonly minimoTermos = MINIMO_TERMOS;
  readonly bitsMapa = BITS_MAPA;
  readonly tiposIdentificador = TIPOS_IDENTIFICADOR.map(t => IDENTIFICADORES[t]);
  readonly nomeIdentificador = nomeIdentificador;

  /** Termos sugeridos que ainda não foram marcados, os exclusivos deste tipo primeiro. */
  readonly sugestoes = computed(() => {
    const atuais = new Set(this.state.termos().map(t => normalizarTexto(t.texto)));
    return (this.state.comparacao()?.termos ?? []).filter(s => !atuais.has(normalizarTexto(s.texto)));
  });
  readonly testesComFalha = computed(() => this.state.testes().filter(t => !t.ok));
  readonly bordasEstaveis = computed(() => {
    const visual = this.state.gerado()?.assinatura.visual;
    return visual ? paraBits(visual.bordas).filter(Boolean).length : 0;
  });
  readonly novaExclusao = signal('');

  // ---- Tutorial ----
  private readonly oculto = signal(tutorialOculto());
  private readonly pulado = signal(false);
  private readonly introVista = signal(false);
  private readonly vistos = signal<ReadonlySet<EtapaV5>>(new Set(['documentos']));
  private readonly reaberto = signal<EtapaV5 | null>(null);
  readonly mostrarIntro = computed(() => !this.introVista() && !this.oculto() && !this.pulado());
  readonly tutorialDaEtapa = computed(() => {
    if (this.mostrarIntro()) return null;
    const id = this.state.atual().id;
    const mostrar = this.reaberto() === id || (!this.oculto() && !this.pulado() && !this.vistos().has(id));
    return mostrar ? TUTORIAIS_V5[id] : null;
  });

  constructor() {
    // Ao abrir outra etapa, ela vai para o meio da lista.
    effect(() => {
      this.state.indice();
      untracked(() => this.centralizarEtapa());
    });
  }

  fecharIntro(fechamento: FechamentoTutorial): void {
    this.introVista.set(true);
    this.aplicar(fechamento);
  }

  fecharTutorial(fechamento: FechamentoTutorial): void {
    const id = this.state.atual().id;
    this.vistos.update(v => new Set(v).add(id));
    this.reaberto.set(null);
    this.aplicar(fechamento);
  }

  reabrirTutorial(): void {
    this.reaberto.set(this.state.atual().id);
  }

  private aplicar({ pularTudo, nuncaMais }: FechamentoTutorial): void {
    if (pularTudo) this.pulado.set(true);
    if (nuncaMais) {
      this.oculto.set(true);
      ocultarTutorial();
    }
  }

  rotuloTutorial(): string {
    return `Etapa ${this.state.indice() + 1} de ${this.state.etapas.length} · ${this.state.atual().titulo}`;
  }

  // ---- Etapas ----

  campo(chave: CampoMapeavel): CampoMapeadoV2 | undefined {
    return this.state.construidos()[chave]?.campo;
  }

  erroDoCampo(chave: CampoMapeavel): string | undefined {
    return this.state.construidos()[chave]?.erro;
  }

  descreverRotulo(campo: CampoMapeadoV2): string {
    const r = campo.rotulo;
    if (!r) return 'sem rótulo (só a posição)';
    if (r.posicao === 'celula') return `"${r.texto}" na mesma célula`;
    if (r.posicao === 'esquerda') return `"${r.texto}" ${r.distancia === 1 ? 'logo à esquerda' : `${r.distancia} blocos à esquerda`}`;
    return `"${r.texto}" ${r.distancia} linha(s) acima`;
  }

  rotuloCampo(chave: CampoMapeavel): string {
    return chave === 'cnpj' ? this.state.nomeDoIdentificador() : CAMPOS.find(c => c.chave === chave)!.rotulo;
  }

  formatarValor(valor: string): string {
    const numero = Number(valor);
    return Number.isFinite(numero) ? numero.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : valor;
  }

  definirTipo(valor: string): void {
    this.state.definirTipoIdentificador(valor as TipoIdentificador | 'auto');
  }

  corrigir(item: ItemVerificacao): void {
    this.state.irParaEtapa(ETAPA_DO_ITEM[item.etapa]);
  }

  verificar(): void {
    this.state.verificar();
    this.state.centro.set('conferencia');
  }

  incluirExclusao(): void {
    if (!this.novaExclusao().trim() || this.state.temExclusao(this.novaExclusao())) return;
    this.state.alternarExclusao(this.novaExclusao());
    this.novaExclusao.set('');
  }

  /** Depois de abrir a etapa, rola a lista para deixá-la no meio do painel (sem rolar a página). */
  private centralizarEtapa(): void {
    afterNextRender(
      () => {
        const lista = this.host.nativeElement.querySelector<HTMLElement>('.etapas');
        const etapa = lista?.querySelector<HTMLElement>('.etapa.atual');
        if (!lista || !etapa) return;
        const deslocamento = etapa.getBoundingClientRect().top - lista.getBoundingClientRect().top + lista.scrollTop;
        const sobra = lista.clientHeight - etapa.offsetHeight;
        const topo = sobra > 0 ? deslocamento - sobra / 2 : deslocamento;
        const suave = !(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
        lista.scrollTo({ top: Math.max(0, topo), behavior: suave ? 'smooth' : 'auto' });
      },
      { injector: this.injector },
    );
  }
}
