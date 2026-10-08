import { CAMPOS, CampoMapeavel } from '../pdf-mapeamento/pdf-mapeamento.model';
import { normalizarTexto } from '../pdf-mapeamento/extrator';
import type { DimensaoPagina } from '../pdf-mapeamento/pdf-documento.service';
import { MapeamentoPdfV2, TermoV2, extrairCampoV2, regexFlexivel, termoPresente } from '../pdf-mapeamento-v2/mapeamento-v2';
import { CelulaPlanilha, Planilha, paraReferencia } from '../pdf-mapeamento-v2/planilha';
import {
  AssinaturaV3,
  AvaliacaoV3,
  MapeamentoPdfV3,
  OpcoesAvaliacao,
  SinalV3,
  avaliarV3,
  campoValido,
  consolidar,
  lerCodigoBarras,
  limitar,
  pct,
  rotulosDoLayout,
} from '../pdf-mapeamento-v3/mapeamento-v3';

/**
 * v4 = v3 aprendida de vários PDFs modelo do mesmo tipo. O que se repete em todos os modelos é
 * layout fixo; o que muda é dado (nome da empresa, valores) e sai da assinatura. Com mais de um
 * modelo também dá para medir quanto cada rótulo se desloca e comparar a disposição da página.
 */
export interface MapeamentoPdfV4 extends Omit<MapeamentoPdfV3, 'versao' | 'assinatura'> {
  versao: 4;
  assinatura: AssinaturaV4;
  /** Nomes de todos os PDFs usados como modelo (o primeiro é o `arquivoExemplo`). */
  arquivosModelo: string[];
}

export interface AssinaturaV4 extends AssinaturaV3 {
  modelos: number;
  /**
   * Rótulos de qualquer modelo, inclusive os que variaram; usados na precisão do layout.
   * (`rotulos`, herdado da v3, guarda só os estáveis: presentes em todos os modelos.)
   */
  rotulosConhecidos: string[];
  /** Textos sem números que mudaram entre os modelos (dados, não layout). Só informativo. */
  rotulosVariaveis: string[];
  /** Posição dos rótulos estáveis que ficaram no mesmo lugar em todos os modelos. */
  geometria: RotuloPosicionado[];
}

export interface RotuloPosicionado {
  texto: string;
  pagina: number;
  /** Centro do rótulo na página (0..1), média dos modelos. */
  x: number;
  y: number;
  /** Deslocamento aceito em cada eixo (0..1), aprendido da variação entre os modelos. */
  tolerancia: number;
}

export interface ModeloV4 {
  nome: string;
  planilha: Planilha;
  dimensoes: DimensaoPagina[];
}

export const MINIMO_MODELOS = 2;
export const MAXIMO_MODELOS = 5;

/** Menor tolerância de posição (fração da página), mesmo que os modelos sejam idênticos. */
const TOLERANCIA_MINIMA = 0.015;
/** Rótulo que varia mais que isso entre os modelos não serve para a geometria. */
const DESVIO_MAXIMO = 0.05;
/** Menos rótulos que isso para comparar e a geometria fica só informativa. */
const GEOMETRIA_MINIMA = 3;
const PESO_GEOMETRIA = 2;
/** Diferença máxima, em pontos, para considerar o mesmo tamanho de página. */
const TOLERANCIA_PAGINA = 2;

const textoCompleto = (planilha: Planilha) => normalizarTexto(planilha.celulas.map(c => c.texto).join(' '));
const centro = (c: CelulaPlanilha) => ({ x: c.caixa.x + c.caixa.largura / 2, y: c.caixa.y + c.caixa.altura / 2 });
const arredondar = (n: number) => Math.round(n * 10000) / 10000;

function mediana(valores: number[]): number {
  if (!valores.length) return 0;
  const ordenados = [...valores].sort((a, b) => a - b);
  const meio = ordenados.length >> 1;
  return ordenados.length % 2 ? ordenados[meio] : (ordenados[meio - 1] + ordenados[meio]) / 2;
}

/** Células cujo texto é exatamente o rótulo. */
const celulasDoRotulo = (planilha: Planilha, rotulo: string) => planilha.celulas.filter(c => normalizarTexto(c.texto) === rotulo);

// ---- Assinatura ----

export function gerarAssinaturaV4(modelos: ModeloV4[]): { assinatura: AssinaturaV4; avisos: string[] } {
  const avisos: string[] = [];
  const textos = modelos.map(m => textoCompleto(m.planilha));

  // Rótulos: estáveis (em todos os modelos) × variáveis (dados).
  const conhecidos = [...new Set(modelos.flatMap(m => rotulosDoLayout(m.planilha)))];
  const estaveis = conhecidos.filter(r => textos.every(t => regexFlexivel(r).test(t)));
  const variaveis = conhecidos.filter(r => !estaveis.includes(r));

  // Código de barras: os modelos que têm precisam concordar.
  const codigos = modelos.map(m => lerCodigoBarras(m.planilha));
  const presentes = codigos.filter((c): c is NonNullable<typeof c> => !!c);
  const chave = (c: (typeof presentes)[number]) => `${c.tipo}|${c.segmento ?? ''}|${c.emissor}`;
  let codigoBarras: AssinaturaV3['codigoBarras'];
  if (presentes.length && presentes.every(c => chave(c) === chave(presentes[0]))) {
    const { tipo, segmento, emissor } = presentes[0];
    codigoBarras = { tipo, segmento, emissor };
    if (presentes.length < modelos.length) {
      avisos.push(`Linha digitável não encontrada em ${modelos.filter((_, i) => !codigos[i]).map(m => m.nome).join(', ')}.`);
    }
  } else if (presentes.length) {
    avisos.push('Os modelos têm códigos de barras de emissores diferentes; o sinal do código de barras foi desativado.');
  }

  // Página: mesmo tamanho em todos os modelos.
  const primeiras = modelos.map(m => m.dimensoes[0]).filter(Boolean);
  const mesmoTamanho = primeiras.every(
    d => Math.abs(d.largura - primeiras[0].largura) <= TOLERANCIA_PAGINA && Math.abs(d.altura - primeiras[0].altura) <= TOLERANCIA_PAGINA,
  );
  if (!mesmoTamanho) avisos.push('Os modelos têm tamanhos de página diferentes; o sinal de páginas foi desativado.');

  const geometria = aprenderGeometria(modelos, estaveis);
  if (estaveis.length < 5) avisos.push(`Só ${estaveis.length} rótulos se repetem em todos os modelos; o layout terá pouco peso.`);

  return {
    assinatura: {
      codigoBarras,
      rotulos: estaveis,
      paginas: modelos[0]?.dimensoes.length ?? 0,
      tamanhoPagina: mesmoTamanho && primeiras[0] ? { largura: Math.round(primeiras[0].largura), altura: Math.round(primeiras[0].altura) } : undefined,
      modelos: modelos.length,
      rotulosConhecidos: conhecidos,
      rotulosVariaveis: variaveis,
      geometria,
    },
    avisos,
  };
}

/**
 * Posição média de cada rótulo estável que aparece uma única vez, na mesma página, em todos os
 * modelos. Antes de comparar, desconta o deslocamento geral de cada modelo em relação ao
 * primeiro (margens diferentes deslocam a página inteira, não o layout).
 */
function aprenderGeometria(modelos: ModeloV4[], estaveis: string[]): RotuloPosicionado[] {
  const candidatos = estaveis
    .map(texto => ({ texto, celulas: modelos.map(m => celulasDoRotulo(m.planilha, texto)) }))
    .filter(r => r.celulas.every(lista => lista.length === 1) && r.celulas.every(l => l[0].pagina === r.celulas[0][0].pagina))
    .map(r => ({ texto: r.texto, pagina: r.celulas[0][0].pagina, posicoes: r.celulas.map(l => centro(l[0])) }));

  const deslocamentos = modelos.map((_, i) => ({
    x: mediana(candidatos.map(c => c.posicoes[i].x - c.posicoes[0].x)),
    y: mediana(candidatos.map(c => c.posicoes[i].y - c.posicoes[0].y)),
  }));

  return candidatos.flatMap(c => {
    const pontos = c.posicoes.map((p, i) => ({ x: p.x - deslocamentos[i].x, y: p.y - deslocamentos[i].y }));
    const x = pontos.reduce((t, p) => t + p.x, 0) / pontos.length;
    const y = pontos.reduce((t, p) => t + p.y, 0) / pontos.length;
    const desvio = Math.max(...pontos.map(p => Math.max(Math.abs(p.x - x), Math.abs(p.y - y))));
    if (desvio > DESVIO_MAXIMO) return [];
    return [{ texto: c.texto, pagina: c.pagina, x: arredondar(x), y: arredondar(y), tolerancia: arredondar(Math.max(TOLERANCIA_MINIMA, desvio * 2)) }];
  });
}

// ---- Conferência do mapeamento nos outros modelos ----

export interface TesteModelo {
  nome: string;
  campos: Array<{ chave: CampoMapeavel; rotulo: string; valor: string | null; valido: boolean }>;
  termosAusentes: string[];
  ok: boolean;
}

/** Aplica o mapeamento (feito no 1º modelo) em cada modelo, para ver se generaliza. */
export function testarNosModelos(mapeamento: MapeamentoPdfV2, modelos: ModeloV4[], hoje = new Date()): TesteModelo[] {
  return modelos.map(m => {
    const campos = CAMPOS.map(({ chave, rotulo }) => {
      const valor = extrairCampoV2(m.planilha, chave, mapeamento[chave])?.valor ?? null;
      return { chave, rotulo, valor, valido: campoValido(chave, valor, hoje) };
    });
    const termosAusentes = mapeamento.termos.filter(t => !termoPresente(m.planilha, t.texto)).map(t => t.texto);
    return { nome: m.nome, campos, termosAusentes, ok: campos.every(c => c.valido) && !termosAusentes.length };
  });
}

/** Quantos termos sugerir, no máximo. */
const MAXIMO_SUGESTOES = 8;

/**
 * Rótulos estáveis com mais de uma palavra (mais específicos) que ainda não são termos,
 * com a célula do 1º modelo, prontos para virar termos identificadores.
 */
export function sugerirTermos(assinatura: AssinaturaV4, planilha: Planilha, termos: TermoV2[]): TermoV2[] {
  const atuais = new Set(termos.map(t => normalizarTexto(t.texto)));
  return assinatura.rotulos
    .filter(r => r.includes(' ') && r.length <= 60 && !atuais.has(r))
    .map(r => ({ r, celula: celulasDoRotulo(planilha, r)[0] }))
    .filter((s): s is { r: string; celula: CelulaPlanilha } => !!s.celula)
    .sort((a, b) => b.r.length - a.r.length)
    .slice(0, MAXIMO_SUGESTOES)
    .map(s => ({ texto: s.celula.texto, celula: paraReferencia(s.celula) }));
}

// ---- Match ----

/** Rótulos estáveis no lugar esperado, descontando o deslocamento geral da página. */
export function avaliarGeometria(geometria: RotuloPosicionado[], planilha: Planilha): SinalV3 {
  const comparados = geometria.flatMap(g => {
    const mesmaPagina = planilha.celulas.filter(c => c.pagina === g.pagina);
    const exatas = mesmaPagina.filter(c => normalizarTexto(c.texto) === g.texto);
    const regex = regexFlexivel(g.texto);
    const celulas = exatas.length ? exatas : mesmaPagina.filter(c => regex.test(normalizarTexto(c.texto)));
    if (!celulas.length) return [];
    const distancia = (c: CelulaPlanilha) => Math.hypot(centro(c).x - g.x, centro(c).y - g.y);
    const maisPerto = celulas.reduce((a, b) => (distancia(b) < distancia(a) ? b : a));
    return [{ dx: centro(maisPerto).x - g.x, dy: centro(maisPerto).y - g.y, tolerancia: g.tolerancia }];
  });

  const base = { chave: 'geometria' as const, titulo: 'Posição dos rótulos' };
  if (comparados.length < GEOMETRIA_MINIMA) {
    return { ...base, nota: 0, peso: 0, detalhe: `só ${comparados.length} de ${geometria.length} rótulos posicionados encontrados` };
  }
  const dx = mediana(comparados.map(c => c.dx));
  const dy = mediana(comparados.map(c => c.dy));
  const noLugar = comparados.filter(c => Math.abs(c.dx - dx) <= c.tolerancia && Math.abs(c.dy - dy) <= c.tolerancia).length;
  const fracao = noLugar / comparados.length;
  const deslocada = Math.max(Math.abs(dx), Math.abs(dy)) > TOLERANCIA_MINIMA;
  return {
    ...base,
    // 80%+ no lugar conta a favor; 50% é neutro; 20% ou menos, contra.
    nota: limitar((fracao - 0.5) / 0.3),
    peso: PESO_GEOMETRIA,
    detalhe: `${noLugar}/${comparados.length} no lugar esperado${deslocada ? ` · página deslocada ${pct(Math.abs(dx))} × ${pct(Math.abs(dy))}` : ''}`,
  };
}

/** Score da v3 (com os rótulos estáveis e conhecidos) mais a geometria. */
export function avaliarV4(
  mapeamento: MapeamentoPdfV4,
  planilha: Planilha,
  dimensoes: DimensaoPagina[],
  termos: ReadonlyArray<{ encontrado: boolean; naPosicao?: boolean }>,
  campos: ReadonlyArray<{ chave: CampoMapeavel; rotulo: string; valor: string | null }>,
  opcoes: OpcoesAvaliacao = {},
): AvaliacaoV3 {
  const { assinatura } = mapeamento;
  const v3 = avaliarV3({ ...mapeamento, versao: 3 }, planilha, dimensoes, termos, campos, {
    ...opcoes,
    rotulosConhecidos: assinatura.rotulosConhecidos,
  });
  const sinais = assinatura.geometria.length ? [...v3.sinais, avaliarGeometria(assinatura.geometria, planilha)] : v3.sinais;
  return consolidar(sinais, v3.codigoBarras);
}
