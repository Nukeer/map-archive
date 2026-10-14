import { Injectable, computed, signal } from '@angular/core';
import type { MapeamentoSalvo } from '../../armazenamento/mapeamentos-db.service';
import { normalizarTexto } from '../../pdf-mapeamento/extrator';
import { IDENTIFICADORES, TipoIdentificador, nomeIdentificador } from '../../pdf-mapeamento/identificador';
import { CAMPOS, CampoMapeavel, Faixa, MINIMO_TERMOS } from '../../pdf-mapeamento/pdf-mapeamento.model';
import {
  CampoMapeadoV2,
  MapeamentoPdfV2,
  TermoV2,
  baseParaEditar,
  construirCampoV2,
  extrairCampoV2,
  regexFlexivel,
  termoPresente,
} from '../../pdf-mapeamento-v2/mapeamento-v2';
import { CelulaPlanilha, Planilha, celulaEm, celulasEntre, descreverIntervalo, paraReferencia } from '../../pdf-mapeamento-v2/planilha';
import { verificarMapeamento } from '../../pdf-mapeamento-v2/verificacao';
import { MAXIMO_MODELOS, MINIMO_MODELOS, testarNosModelos } from '../../pdf-mapeamento-v4/mapeamento-v4';
import { MapeamentoPdfV5, ModeloV5, compararComOutrosTipos, gerarAssinaturaV5, outrosTipos } from '../mapeamento-v5';

export type EtapaV5 = 'documentos' | 'identificador' | 'competencia' | 'termos' | 'valor' | 'conferir' | 'concluir';

export interface DefinicaoEtapa {
  id: EtapaV5;
  titulo: string;
  instrucao: string;
  /** Etapa em que se marca no documento, e o que se marca. */
  marca?: CampoMapeavel | 'termo';
}

export const ETAPAS_V5: readonly DefinicaoEtapa[] = [
  { id: 'documentos', titulo: 'Documentos', instrucao: 'Dê um nome ao serviço e escolha de 2 a 5 guias do mesmo tipo, de preferência de empresas e meses diferentes.' },
  { id: 'identificador', titulo: 'Identificador', instrucao: 'Clique no CNPJ, CPF, CAEPF, CNO, IE ou IM do contribuinte no documento.', marca: 'cnpj' },
  { id: 'competencia', titulo: 'Competência', instrucao: 'Clique no mês de competência (ou período de apuração) no documento.', marca: 'competencia' },
  { id: 'termos', titulo: 'Termos', instrucao: 'Clique em textos fixos que só este tipo de guia tem. Arraste para juntar células.', marca: 'termo' },
  { id: 'valor', titulo: 'Valor', instrucao: 'Clique no valor a pagar no documento.', marca: 'valor' },
  { id: 'conferir', titulo: 'Conferir', instrucao: 'Clique em Verificar e eu aplico o mapeamento em todas as guias e comparo com o mapeamento anterior do serviço.' },
  { id: 'concluir', titulo: 'Concluir', instrucao: 'Confira o resumo e conclua. Se quiser, diga textos que não podem aparecer nesta guia.' },
];

/** Guia escolhida como modelo, já lida (texto, planilha e aparência). */
export interface ModeloCarregado extends ModeloV5 {
  arquivo: File;
  semTexto: boolean;
}

export interface Marca {
  tipo: CampoMapeavel | 'termo';
  papel: 'valor' | 'rotulo' | 'termo' | 'selecao' | 'erro';
}

/** O que dá para desfazer: tudo o que o usuário marca. */
interface Retrato {
  selecoes: Partial<Record<CampoMapeavel, Faixa>>;
  termos: Array<{ texto: string; celula: number }>;
  tipoIdentificador: TipoIdentificador | 'auto';
  exclusoes: string[];
}

const LIMITE_DESFAZER = 50;

/**
 * Estado do assistente v5: modelos, marcações no modelo principal (o 1º), verificação e o
 * mapeamento final. Sem acesso a arquivos nem a tela, para poder ser testado sozinho.
 */
@Injectable()
export class EditorV5State {
  readonly etapas = ETAPAS_V5;

  // ---- Entrada ----
  readonly salvos = signal<MapeamentoSalvo[]>([]);
  /** Serviço reaberto por "Mapear Documentos": as marcações dele são reaplicadas no principal. */
  readonly anteriorAberto = signal<MapeamentoSalvo | null>(null);

  // ---- Documentos ----
  readonly nome = signal('');
  readonly modelos = signal<ModeloCarregado[]>([]);
  readonly validos = computed(() => this.modelos().filter(m => !m.semTexto));
  /** O 1º modelo válido: é nele que se marca. */
  readonly principal = computed(() => this.validos()[0] ?? null);
  /** Modelo mostrado no visualizador (índice em `validos`). */
  readonly exibido = signal(0);
  readonly modeloExibido = computed(() => this.validos()[Math.min(this.exibido(), this.validos().length - 1)] ?? null);
  readonly centro = signal<'documento' | 'conferencia'>('documento');
  /** Lendo guias recém-escolhidas (texto e aparência). */
  readonly carregando = signal(false);
  readonly erroArquivos = signal('');

  // ---- Marcações (no principal) ----
  readonly selecoes = signal<Partial<Record<CampoMapeavel, Faixa>>>({});
  readonly tipoIdentificador = signal<TipoIdentificador | 'auto'>('auto');
  readonly termos = signal<Array<{ texto: string; celula: number }>>([]);
  readonly exclusoes = signal<string[]>([]);
  /** Seleção em andamento (arraste), só para pintar. */
  readonly arraste = signal<Faixa | null>(null);

  // ---- Etapas ----
  readonly indice = signal(0);
  readonly atual = computed(() => ETAPAS_V5[this.indice()]);

  private readonly passado = signal<Retrato[]>([]);
  private readonly futuro = signal<Retrato[]>([]);
  readonly podeDesfazer = computed(() => this.passado().length > 0);
  readonly podeRefazer = computed(() => this.futuro().length > 0);

  // ---- Derivados ----

  /** Mapeamento salvo do mesmo serviço (o reaberto ou o mais recente com o mesmo nome). */
  readonly anterior = computed(() => {
    const nome = normalizarTexto(this.nome());
    return this.anteriorAberto() ?? ((nome && this.salvos().find(r => normalizarTexto(r.nome) === nome)) || null);
  });

  readonly construidos = computed(() => {
    const planilha = this.principal()?.planilha;
    const resultado: Partial<Record<CampoMapeavel, ReturnType<typeof construirCampoV2>>> = {};
    if (!planilha) return resultado;
    const tipo = this.tipoIdentificador();
    for (const { chave } of CAMPOS) {
      const faixa = this.selecoes()[chave];
      if (faixa) resultado[chave] = construirCampoV2(planilha, chave, faixa.inicio, faixa.fim, chave === 'cnpj' && tipo !== 'auto' ? tipo : undefined);
    }
    return resultado;
  });

  readonly termosV2 = computed<TermoV2[]>(() => {
    const planilha = this.principal()?.planilha;
    if (!planilha) return [];
    return this.termos()
      .filter(t => planilha.celulas[t.celula] && termoPresente(planilha, t.texto))
      .map(t => ({ texto: t.texto, celula: paraReferencia(planilha.celulas[t.celula]) }));
  });

  /** Mapeamento dos campos e termos; null enquanto falta algo. */
  readonly base = computed<MapeamentoPdfV2 | null>(() => {
    const principal = this.principal();
    const [cnpj, competencia, valor] = CAMPOS.map(c => this.construidos()[c.chave]?.campo);
    if (!principal || !this.nome().trim() || !cnpj || !competencia || !valor || this.termosV2().length < MINIMO_TERMOS) return null;
    return { versao: 2, nome: this.nome().trim(), cnpj, competencia, valor, termos: this.termosV2(), arquivoExemplo: principal.nome };
  });

  readonly gerado = computed(() => (this.validos().length ? gerarAssinaturaV5(this.validos()) : null));

  /** Sugestões a partir dos outros tipos salvos: termos exclusivos deste tipo e exclusões dos parecidos. */
  readonly comparacao = computed(() => {
    const gerado = this.gerado();
    if (!gerado) return null;
    return compararComOutrosTipos(gerado.assinatura, this.validos(), this.termosV2(), outrosTipos(this.salvos(), this.nome()));
  });

  readonly exclusoesInfo = computed(() =>
    this.exclusoes().map(texto => ({ texto, nosModelos: this.validos().filter(m => termoPresente(m.planilha, texto)).map(m => m.nome) })),
  );

  /** Mapeamento aplicado em cada modelo (o que foi lido e se vale). */
  readonly testes = computed(() => {
    const base = this.base();
    return base ? testarNosModelos(base, this.validos()) : [];
  });

  private readonly verificacao = signal<{ para: MapeamentoPdfV2; itens: ReturnType<typeof verificarMapeamento> } | null>(null);
  /** Itens do último Verificar, se ainda valem para o mapeamento atual. */
  readonly itensVerificados = computed(() => {
    const v = this.verificacao();
    return v && v.para === this.base() ? v.itens : null;
  });
  /** Verificou, mas mudou algo depois. */
  readonly verificacaoVencida = computed(() => !!this.verificacao() && !this.itensVerificados());

  /** Divergências do Verificar mais os modelos em que o mapeamento não funcionou. */
  readonly divergencias = computed(() => {
    const itens = this.itensVerificados();
    if (!itens) return [];
    const modelos = this.testes()
      .filter(t => !t.ok)
      .map(t => {
        const faltas = [
          ...t.campos.filter(c => !c.valido).map(c => `${c.chave === 'cnpj' ? this.nomeDoIdentificador() : c.rotulo} ${c.valor ? `inválido (${c.valor})` : 'não lido'}`),
          ...t.termosAusentes.map(termo => `termo "${termo}" ausente`),
        ];
        return `Divergência Encontrada: na guia ${t.nome}, ${faltas.join(', ')}.`;
      });
    return [...itens.flatMap(i => i.divergencias), ...modelos];
  });

  // ---- Regras das etapas ----

  valida(id: EtapaV5): boolean {
    switch (id) {
      case 'documentos':
        return this.validos().length >= MINIMO_MODELOS && !!this.nome().trim();
      case 'identificador':
        return !!this.construidos().cnpj?.campo;
      case 'competencia':
        return !!this.construidos().competencia?.campo;
      case 'valor':
        return !!this.construidos().valor?.campo;
      case 'termos':
        return this.termosV2().length >= MINIMO_TERMOS;
      case 'conferir':
        return !!this.itensVerificados();
      case 'concluir':
        return false;
    }
  }

  /** Feita = válida e com as anteriores válidas. */
  feita(indice: number): boolean {
    return ETAPAS_V5.slice(0, indice + 1).every(e => this.valida(e.id));
  }

  podeAbrir(indice: number): boolean {
    return indice === 0 || this.feita(indice - 1);
  }

  readonly podeAvancar = computed(() => this.indice() < ETAPAS_V5.length - 1 && this.valida(this.atual().id));

  /** "Próximo: Competência" quando dá para avançar. */
  readonly rotuloProximo = computed(() => {
    const proxima = ETAPAS_V5[this.indice() + 1];
    return this.podeAvancar() && proxima ? `Próximo: ${proxima.titulo}` : 'Próximo';
  });

  /** Com o Próximo bloqueado, o que falta. */
  readonly oQueFalta = computed<string | null>(() => {
    if (this.podeAvancar() || this.atual().id === 'concluir') return null;
    switch (this.atual().id) {
      case 'documentos': {
        const faltam = MINIMO_MODELOS - this.validos().length;
        if (faltam > 0) return `Adicione mais ${faltam} guia${faltam > 1 ? 's' : ''} para continuar.`;
        return 'Dê um nome ao serviço para continuar.';
      }
      case 'identificador':
      case 'competencia':
      case 'valor': {
        const chave = this.atual().marca as CampoMapeavel;
        const erro = this.construidos()[chave]?.erro;
        if (erro) return erro;
        return `Clique ${chave === 'cnpj' ? 'no identificador' : chave === 'competencia' ? 'na competência' : 'no valor'} no documento para continuar.`;
      }
      case 'termos': {
        const faltam = MINIMO_TERMOS - this.termosV2().length;
        return `Marque mais ${faltam} termo${faltam > 1 ? 's' : ''} para continuar.`;
      }
      case 'conferir':
        return this.verificacaoVencida() ? 'Você mudou o mapeamento. Verifique de novo para continuar.' : 'Clique em Verificar para continuar.';
      default:
        return null;
    }
  });

  /** Resumo curto de uma etapa feita. */
  resumo(id: EtapaV5): string {
    const campo = (chave: CampoMapeavel) => this.construidos()[chave]?.campo;
    switch (id) {
      case 'documentos':
        return `${this.validos().length} guias · ${this.nome().trim()}`;
      case 'identificador':
        return `${this.nomeDoIdentificador()} ${campo('cnpj')?.exemplo ?? ''}`;
      case 'competencia':
        return campo('competencia')?.exemplo ?? '';
      case 'valor': {
        const valor = Number(campo('valor')?.exemplo);
        return Number.isFinite(valor) ? valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '';
      }
      case 'termos':
        return `${this.termosV2().length} termos`;
      case 'conferir': {
        const n = this.divergencias().length;
        return n ? `${n} divergência${n > 1 ? 's' : ''}` : 'Sem divergência';
      }
      default:
        return '';
    }
  }

  nomeDoIdentificador(): string {
    return nomeIdentificador(this.construidos().cnpj?.campo?.identificador ?? (this.tipoIdentificador() === 'auto' ? 'cnpj' : (this.tipoIdentificador() as TipoIdentificador)));
  }

  // ---- Navegação ----

  irPara(indice: number): void {
    if (indice < 0 || indice >= ETAPAS_V5.length || !this.podeAbrir(indice)) return;
    this.indice.set(indice);
    this.arraste.set(null);
    // Etapas de marcação precisam do documento principal à vista.
    if (ETAPAS_V5[indice].marca) {
      this.centro.set('documento');
      this.exibido.set(0);
    }
  }

  irParaEtapa(id: EtapaV5): void {
    this.irPara(ETAPAS_V5.findIndex(e => e.id === id));
  }

  proximo(): void {
    if (this.podeAvancar()) this.irPara(this.indice() + 1);
  }

  voltar(): void {
    if (this.indice() > 0) this.irPara(this.indice() - 1);
  }

  // ---- Documentos ----

  readonly maximoModelos = MAXIMO_MODELOS;

  adicionarModelo(modelo: ModeloCarregado): void {
    if (this.modelos().some(m => m.nome === modelo.nome) || this.modelos().length >= MAXIMO_MODELOS) return;
    const primeiroValido = !this.principal() && !modelo.semTexto;
    this.modelos.update(lista => [...lista, modelo]);
    if (primeiroValido) this.restaurarAnterior();
  }

  removerModelo(nome: string): void {
    const eraPrincipal = this.principal()?.nome === nome;
    const base = eraPrincipal ? this.base() ?? this.parcial() : null;
    this.modelos.update(lista => lista.filter(m => m.nome !== nome));
    this.exibido.set(0);
    if (eraPrincipal) this.reaplicar(base);
  }

  /** Torna outro modelo o principal, levando para ele o que já foi marcado. */
  tornarPrincipal(nome: string): void {
    const base = this.base() ?? this.parcial();
    this.modelos.update(lista => [...lista.filter(m => m.nome === nome), ...lista.filter(m => m.nome !== nome)]);
    this.exibido.set(0);
    this.reaplicar(base);
  }

  /** Abre o serviço reaberto: nome, exclusões e as marcações reaplicadas no principal. */
  abrirAnterior(registro: MapeamentoSalvo | null): void {
    this.anteriorAberto.set(registro);
    if (!registro) return;
    this.nome.set(registro.nome);
    const mapeamento = registro.mapeamento;
    if ('exclusoes' in mapeamento) this.exclusoes.set([...mapeamento.exclusoes]);
    this.restaurarAnterior();
  }

  private restaurarAnterior(): void {
    const base = baseParaEditar(this.anteriorAberto()?.mapeamento);
    if (base && this.principal() && !Object.keys(this.selecoes()).length && !this.termos().length) this.reaplicar(base);
  }

  /** O que já foi marcado, mesmo incompleto, no formato do mapeamento (para levar a outro principal). */
  private parcial(): Partial<MapeamentoPdfV2> {
    const construidos = this.construidos();
    return { cnpj: construidos.cnpj?.campo, competencia: construidos.competencia?.campo, valor: construidos.valor?.campo, termos: this.termosV2() };
  }

  /** Lê, no principal atual, os campos e termos de um mapeamento e os transforma em marcações. */
  private reaplicar(base: Partial<MapeamentoPdfV2> | null): void {
    const planilha = this.principal()?.planilha;
    const selecoes: Partial<Record<CampoMapeavel, Faixa>> = {};
    const termos: Array<{ texto: string; celula: number }> = [];
    if (planilha && base) {
      for (const { chave } of CAMPOS) {
        const campo = base[chave] as CampoMapeadoV2 | undefined;
        const celulas = campo && extrairCampoV2(planilha, chave, campo)?.celulas;
        if (celulas?.length) selecoes[chave] = { inicio: celulas[0].id, fim: celulas[celulas.length - 1].id };
      }
      for (const termo of base.termos ?? []) {
        const celula = celulaEm(planilha, termo.celula) ?? celulaDoTexto(planilha, termo.texto);
        if (celula) termos.push({ texto: termo.texto, celula: celula.id });
      }
      const identificador = base.cnpj?.identificador;
      this.tipoIdentificador.set(identificador && !IDENTIFICADORES[identificador].automatico ? identificador : 'auto');
    }
    this.selecoes.set(selecoes);
    this.termos.set(termos);
    this.passado.set([]);
    this.futuro.set([]);
  }

  // ---- Marcações ----

  /** Seleção feita no documento principal, na etapa atual. */
  aplicarSelecao(faixa: Faixa): void {
    const marca = this.atual().marca;
    const planilha = this.principal()?.planilha;
    if (!marca || !planilha) return;
    if (marca === 'termo') {
      const texto = celulasEntre(planilha, faixa.inicio, faixa.fim).map(c => c.texto).join(' ');
      this.adicionarTermo(texto, faixa.inicio);
      return;
    }
    this.registrar();
    this.selecoes.update(s => ({ ...s, [marca]: faixa }));
  }

  limparCampo(chave: CampoMapeavel): void {
    if (!this.selecoes()[chave]) return;
    this.registrar();
    this.selecoes.update(({ [chave]: _removido, ...resto }) => resto);
  }

  definirTipoIdentificador(tipo: TipoIdentificador | 'auto'): void {
    this.registrar();
    this.tipoIdentificador.set(tipo);
  }

  adicionarTermo(texto: string, celula: number): void {
    const limpo = texto.trim().replace(/\s+/g, ' ');
    if (!limpo || this.termos().some(t => normalizarTexto(t.texto) === normalizarTexto(limpo))) return;
    this.registrar();
    this.termos.update(lista => [...lista, { texto: limpo, celula }]);
  }

  /** Termo sugerido (célula no principal). */
  adicionarSugestao(sugestao: TermoV2): void {
    const celula = this.principal() && celulaEm(this.principal()!.planilha, sugestao.celula);
    if (celula) this.adicionarTermo(sugestao.texto, celula.id);
  }

  removerTermo(texto: string): void {
    this.registrar();
    this.termos.update(lista => lista.filter(t => t.texto !== texto));
  }

  alternarExclusao(texto: string): void {
    const limpo = texto.trim().replace(/\s+/g, ' ');
    if (!limpo) return;
    this.registrar();
    const chave = normalizarTexto(limpo);
    this.exclusoes.update(lista =>
      lista.some(e => normalizarTexto(e) === chave) ? lista.filter(e => normalizarTexto(e) !== chave) : [...lista, limpo],
    );
  }

  temExclusao(texto: string): boolean {
    return this.exclusoes().some(e => normalizarTexto(e) === normalizarTexto(texto));
  }

  desfazer(): void {
    const [ultimo, ...resto] = this.passado();
    if (!ultimo) return;
    this.futuro.update(f => [this.retrato(), ...f]);
    this.passado.set(resto);
    this.restaurar(ultimo);
  }

  refazer(): void {
    const [proximo, ...resto] = this.futuro();
    if (!proximo) return;
    this.passado.update(p => [this.retrato(), ...p]);
    this.futuro.set(resto);
    this.restaurar(proximo);
  }

  private registrar(): void {
    this.passado.update(p => [this.retrato(), ...p].slice(0, LIMITE_DESFAZER));
    this.futuro.set([]);
  }

  private retrato(): Retrato {
    return { selecoes: this.selecoes(), termos: this.termos(), tipoIdentificador: this.tipoIdentificador(), exclusoes: this.exclusoes() };
  }

  private restaurar(r: Retrato): void {
    this.selecoes.set(r.selecoes);
    this.termos.set(r.termos);
    this.tipoIdentificador.set(r.tipoIdentificador);
    this.exclusoes.set(r.exclusoes);
  }

  // ---- Marcas no visualizador ----

  /** No principal, o que foi marcado; nos outros modelos, onde o mapeamento leu. */
  readonly marcas = computed(() => {
    const modelo = this.modeloExibido();
    const mapa = new Map<number, Marca>();
    if (!modelo) return mapa;
    const pintar = (celulas: CelulaPlanilha[] | undefined, marca: Marca) => celulas?.forEach(c => mapa.set(c.id, marca));
    const etapa = this.atual();

    if (modelo !== this.principal()) {
      const base = this.base() ?? this.parcial();
      for (const { chave } of CAMPOS) {
        const campo = base[chave] as CampoMapeadoV2 | undefined;
        if (campo) pintar(extrairCampoV2(modelo.planilha, chave, campo)?.celulas, { tipo: chave, papel: 'valor' });
      }
      for (const termo of base.termos ?? []) pintar(celulasComTexto(modelo.planilha, termo.texto), { tipo: 'termo', papel: 'termo' });
      return mapa;
    }

    for (const { chave } of CAMPOS) {
      const construido = this.construidos()[chave];
      if (!construido) continue;
      const emFoco = etapa.marca === chave || etapa.id === 'conferir';
      if (emFoco && construido.celulaRotulo) pintar([construido.celulaRotulo], { tipo: chave, papel: 'rotulo' });
      if (construido.celulas) pintar(construido.celulas, { tipo: chave, papel: 'valor' });
      else if (emFoco) {
        const faixa = this.selecoes()[chave]!;
        pintar(celulasEntre(modelo.planilha, faixa.inicio, faixa.fim), { tipo: chave, papel: 'erro' });
      }
    }
    pintar(
      this.termos().map(t => modelo.planilha.celulas[t.celula]).filter(Boolean),
      { tipo: 'termo', papel: 'termo' },
    );
    const arraste = this.arraste();
    if (arraste && etapa.marca) pintar(celulasEntre(modelo.planilha, arraste.inicio, arraste.fim), { tipo: etapa.marca, papel: 'selecao' });
    return mapa;
  });

  /** Célula a mostrar ao entrar numa etapa de campo (para abrir na página certa). */
  readonly foco = computed(() => {
    const marca = this.atual().marca;
    if (!marca || marca === 'termo' || this.modeloExibido() !== this.principal()) return null;
    return this.selecoes()[marca]?.inicio ?? null;
  });

  descreverCelulas(chave: CampoMapeavel): string {
    const campo = this.construidos()[chave]?.campo;
    return campo ? descreverIntervalo(campo.inicio, campo.fim) : '';
  }

  // ---- Conferir e concluir ----

  verificar(): void {
    const principal = this.principal();
    const base = this.base();
    if (principal && base) this.verificacao.set({ para: base, itens: verificarMapeamento(principal.planilha, base, this.anterior()) });
  }

  /** Concluir exige verificação atual e nenhuma exclusão presente nos próprios modelos. */
  readonly podeConcluir = computed(() => !!this.itensVerificados() && !!this.gerado() && this.exclusoesInfo().every(e => !e.nosModelos.length));

  /** Mapeamento final, com as divergências aceitas (o app as move para o histórico). */
  mapeamentoFinal(): MapeamentoPdfV5 | null {
    const base = this.base();
    const gerado = this.gerado();
    if (!base || !gerado || !this.podeConcluir()) return null;
    const divergencias = this.divergencias();
    return {
      ...base,
      versao: 5,
      assinatura: gerado.assinatura,
      exclusoes: this.exclusoes(),
      arquivosModelo: this.validos().map(m => m.nome),
      ...(divergencias.length ? { divergencias } : {}),
    };
  }

  /** Há o que perder ao sair. */
  readonly alterado = computed(() => this.modelos().length > 0 || this.termos().length > 0 || Object.keys(this.selecoes()).length > 0);
}

/** Primeira célula cujo texto contém o termo (para termos de mapeamentos antigos que mudaram de lugar). */
function celulaDoTexto(planilha: Planilha, texto: string): CelulaPlanilha | undefined {
  return celulasComTexto(planilha, texto)[0];
}

function celulasComTexto(planilha: Planilha, texto: string): CelulaPlanilha[] {
  const regex = regexFlexivel(texto);
  return planilha.celulas.filter(c => regex.test(normalizarTexto(c.texto)));
}
