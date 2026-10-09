import type { MapeamentoSalvo } from '../armazenamento/mapeamentos-db.service';
import { CampoMapeavel } from '../pdf-mapeamento/pdf-mapeamento.model';
import { normalizarTexto } from '../pdf-mapeamento/extrator';
import type { DimensaoPagina } from '../pdf-mapeamento/pdf-documento.service';
import { TermoV2, regexFlexivel } from '../pdf-mapeamento-v2/mapeamento-v2';
import { CelulaPlanilha, Planilha, paraReferencia } from '../pdf-mapeamento-v2/planilha';
import { AvaliacaoV3, OpcoesAvaliacao, SinalV3, consolidar, limitar, pct } from '../pdf-mapeamento-v3/mapeamento-v3';
import { AssinaturaV4, MapeamentoPdfV4, ModeloV4, avaliarV4, gerarAssinaturaV4 } from '../pdf-mapeamento-v4/mapeamento-v4';
import { AparenciaPdf, paraBits, paraHex } from './aparencia';

/**
 * v5 = v4 + aparência do PDF (desenho da 1ª página, fontes, programa gerador) e contraste com
 * os outros tipos já salvos, que sugere termos exclusivos deste tipo e exclusões tiradas dos
 * tipos parecidos.
 */
export interface MapeamentoPdfV5 extends Omit<MapeamentoPdfV4, 'versao' | 'assinatura'> {
  versao: 5;
  assinatura: AssinaturaV5;
}

export interface AssinaturaV5 extends AssinaturaV4 {
  /** Bordas da 1ª página iguais em todos os modelos; ausente se poucas se repetiram. */
  visual?: AssinaturaVisual;
  /** Fontes usadas em todos os modelos. */
  fontes: string[];
  /** Fontes de qualquer modelo, aceitas na precisão. */
  fontesConhecidas: string[];
  /** Programa gerador, se for o mesmo em todos os modelos. */
  produtor?: string;
}

export interface AssinaturaVisual {
  /** Bits que deram borda em todos os modelos (hex, mesmo formato de `mapaDeBordas`). */
  bordas: string;
  /** Bits iguais em todos os modelos (borda ou não); só esses entram na comparação. */
  mascara: string;
}

export interface ModeloV5 extends ModeloV4 {
  /** null se o PDF não pôde ser desenhado. */
  aparencia: AparenciaPdf | null;
}

/** Com menos bordas estáveis o desenho não diz muito e o sinal visual fica de fora. */
const BORDAS_MINIMAS = 12;
const PESOS = { visual: 2, fontes: 1, produtor: 0.5 } as const;
/** Tipo salvo com pelo menos essa fração dos rótulos presente nos modelos é "parecido". */
export const PARECIDO_MINIMO = 0.3;
const MAXIMO_SUGESTOES = 8;
const MAXIMO_EXCLUSOES = 6;
const EXCLUSOES_POR_TIPO = 3;

const textoCompleto = (planilha: Planilha) => normalizarTexto(planilha.celulas.map(c => c.texto).join(' '));

// ---- Assinatura ----

export function gerarAssinaturaV5(modelos: ModeloV5[]): { assinatura: AssinaturaV5; avisos: string[] } {
  const { assinatura, avisos } = gerarAssinaturaV4(modelos);
  const semAparencia = modelos.filter(m => !m.aparencia);
  if (semAparencia.length) avisos.push(`Não foi possível desenhar ${semAparencia.map(m => m.nome).join(', ')}.`);
  const aparencias = modelos.flatMap(m => (m.aparencia ? [m.aparencia] : []));

  const visual = aprenderVisual(aparencias.map(a => a.hash));
  if (aparencias.length && !visual) avisos.push('Poucas bordas do desenho se repetem em todos os modelos; o sinal visual foi desativado.');

  const listas = aparencias.map(a => a.fontes).filter(l => l.length);
  const fontes = listas.length ? listas[0].filter(f => listas.every(l => l.includes(f))) : [];
  if (listas.length && !fontes.length) avisos.push('Nenhuma fonte é comum a todos os modelos; o sinal de fontes foi desativado.');

  const produtores = aparencias.map(a => a.produtor);
  const produtor = produtores.length && produtores.every(p => p && p === produtores[0]) ? produtores[0] : undefined;
  if (!produtor && produtores.some(Boolean)) avisos.push('Os modelos foram gerados por programas diferentes; o sinal do produtor foi desativado.');

  return {
    assinatura: { ...assinatura, visual, fontes, fontesConhecidas: [...new Set(listas.flat())], produtor },
    avisos,
  };
}

/** Bordas presentes em todos os mapas; o que muda entre os modelos (texto variável) sai pela máscara. */
export function aprenderVisual(hashes: string[]): AssinaturaVisual | undefined {
  if (!hashes.length) return undefined;
  const mapas = hashes.map(paraBits);
  const mascara = mapas[0].map((bit, i) => mapas.every(m => m[i] === bit));
  const bordas = mapas[0].map((bit, i) => bit && mascara[i]);
  if (bordas.filter(Boolean).length < BORDAS_MINIMAS) return undefined;
  return { bordas: paraHex(bordas), mascara: paraHex(mascara) };
}

// ---- Match ----

/** Jaccard entre as bordas do modelo e as do PDF, só nas posições estáveis. */
export function avaliarVisual(visual: AssinaturaVisual, hash: string): SinalV3 {
  const mascara = paraBits(visual.mascara);
  const modelo = paraBits(visual.bordas);
  const pdf = paraBits(hash);
  let comuns = 0;
  let uniao = 0;
  mascara.forEach((estavel, i) => {
    if (!estavel) return;
    if (modelo[i] && pdf[i]) comuns++;
    if (modelo[i] || pdf[i]) uniao++;
  });
  const similaridade = uniao ? comuns / uniao : 0;
  return {
    chave: 'visual',
    titulo: 'Desenho da página',
    // 80%+ das bordas em comum conta a favor; 50% é neutro; 20% ou menos, contra.
    nota: limitar((similaridade - 0.5) / 0.3),
    peso: PESOS.visual,
    detalhe: `${pct(similaridade)} das bordas em comum · ${modelo.filter(Boolean).length} bordas estáveis no modelo`,
  };
}

export function avaliarFontes(assinatura: AssinaturaV5, fontes: string[]): SinalV3 | null {
  if (!assinatura.fontes.length || !fontes.length) return null;
  const cobertura = assinatura.fontes.filter(f => fontes.includes(f)).length / assinatura.fontes.length;
  const novas = fontes.filter(f => !assinatura.fontesConhecidas.includes(f));
  const precisao = 1 - novas.length / fontes.length;
  const f1 = cobertura + precisao ? (2 * cobertura * precisao) / (cobertura + precisao) : 0;
  return {
    chave: 'fontes',
    titulo: 'Fontes',
    nota: limitar((f1 - 0.5) / 0.3),
    peso: PESOS.fontes,
    detalhe: `${pct(cobertura)} das ${assinatura.fontes.length} fontes do modelo${novas.length ? ` · novas: ${novas.slice(0, 3).join(', ')}` : ''}`,
  };
}

export function avaliarProdutor(esperado: string, produtor?: string): SinalV3 {
  const base = { chave: 'produtor' as const, titulo: 'Programa gerador' };
  if (!produtor) return { ...base, nota: 0, peso: 0, detalhe: `modelo: ${esperado}; este PDF não informa` };
  const igual = produtor === esperado;
  return { ...base, nota: igual ? 1 : -1, peso: PESOS.produtor, detalhe: igual ? produtor : `esperado ${esperado}, veio ${produtor}` };
}

/** Sinais da aparência; sem `aparencia` (PDF não desenhado) ficam só informativos. */
export function sinaisDeAparencia(assinatura: AssinaturaV5, aparencia?: AparenciaPdf): SinalV3[] {
  if (!aparencia) {
    const usa = assinatura.visual || assinatura.fontes.length || assinatura.produtor;
    return usa ? [{ chave: 'visual', titulo: 'Aparência', nota: 0, peso: 0, detalhe: 'não foi possível desenhar este PDF' }] : [];
  }
  const fontes = avaliarFontes(assinatura, aparencia.fontes);
  return [
    ...(assinatura.visual ? [avaliarVisual(assinatura.visual, aparencia.hash)] : []),
    ...(fontes ? [fontes] : []),
    ...(assinatura.produtor ? [avaliarProdutor(assinatura.produtor, aparencia.produtor)] : []),
  ];
}

/** Score da v4 mais desenho, fontes e programa gerador. */
export function avaliarV5(
  mapeamento: MapeamentoPdfV5,
  planilha: Planilha,
  dimensoes: DimensaoPagina[],
  termos: ReadonlyArray<{ encontrado: boolean; naPosicao?: boolean }>,
  campos: ReadonlyArray<{ chave: CampoMapeavel; rotulo: string; valor: string | null }>,
  aparencia?: AparenciaPdf,
  opcoes: OpcoesAvaliacao = {},
): AvaliacaoV3 {
  const v4 = avaliarV4({ ...mapeamento, versao: 4 }, planilha, dimensoes, termos, campos, opcoes);
  return consolidar([...v4.sinais, ...sinaisDeAparencia(mapeamento.assinatura, aparencia)], v4.codigoBarras);
}

// ---- Contraste com os outros tipos salvos ----

/** Outro tipo de documento já mapeado, reduzido aos textos que o identificam. */
export interface OutroTipo {
  nome: string;
  /** Rótulos da assinatura (v3+) e termos identificadores, normalizados. */
  rotulos: string[];
}

/** Agrupa os mapeamentos salvos por nome, deixando de fora o tipo que está sendo mapeado. */
export function outrosTipos(registros: MapeamentoSalvo[], nomeAtual: string): OutroTipo[] {
  const atual = normalizarTexto(nomeAtual);
  const porNome = new Map<string, OutroTipo>();
  for (const { nome, mapeamento } of registros) {
    const chave = normalizarTexto(nome);
    if (chave === atual) continue;
    const termos = (mapeamento.termos as Array<string | TermoV2>).map(t => normalizarTexto(typeof t === 'string' ? t : t.texto));
    const rotulos = 'assinatura' in mapeamento ? mapeamento.assinatura.rotulos : [];
    const tipo = porNome.get(chave) ?? { nome, rotulos: [] };
    tipo.rotulos = [...new Set([...tipo.rotulos, ...rotulos, ...termos])];
    porNome.set(chave, tipo);
  }
  return [...porNome.values()];
}

export interface SugestaoTermo extends TermoV2 {
  /** Outros tipos que também têm esse texto; vazio = exclusivo deste tipo. */
  tambemEm: string[];
}

export interface ComparacaoTipos {
  /** Do mais parecido para o menos; `parecido` = fração dos rótulos do outro tipo presente em todos os modelos. */
  tipos: Array<{ nome: string; parecido: number }>;
  /** Rótulos estáveis prontos para virar termos, os exclusivos primeiro. */
  termos: SugestaoTermo[];
  /** Rótulos de tipos parecidos que nenhum modelo tem: candidatos a termos de exclusão. */
  exclusoes: Array<{ texto: string; tipo: string }>;
}

/**
 * Compara os modelos com os outros tipos salvos. Termo bom é o que só este tipo tem (o outro
 * tipo não passa nos termos); exclusão boa é o que só o tipo parecido tem (este mapeamento
 * deixa de aceitar PDFs dele).
 */
export function compararComOutrosTipos(
  assinatura: AssinaturaV4,
  modelos: ModeloV4[],
  termos: TermoV2[],
  outros: OutroTipo[],
): ComparacaoTipos {
  const textos = modelos.map(m => textoCompleto(m.planilha));
  const emTodos = (r: string) => textos.every(t => regexFlexivel(r).test(t));
  const emAlgum = (r: string) => textos.some(t => regexFlexivel(r).test(t));

  const tipos = outros
    .filter(o => o.rotulos.length)
    .map(o => ({ ...o, parecido: o.rotulos.filter(emTodos).length / o.rotulos.length }))
    .sort((a, b) => b.parecido - a.parecido);

  const atuais = new Set(termos.map(t => normalizarTexto(t.texto)));
  const textosOutros = tipos.map(o => ({ nome: o.nome, texto: o.rotulos.join(' | ') }));
  const termosSugeridos = assinatura.rotulos
    .filter(r => r.includes(' ') && r.length <= 60 && !atuais.has(r))
    .map(r => ({ r, celula: celulasDoRotulo(modelos[0].planilha, r)[0] }))
    .filter((s): s is { r: string; celula: CelulaPlanilha } => !!s.celula)
    .map(s => ({
      texto: s.celula.texto,
      celula: paraReferencia(s.celula),
      tambemEm: textosOutros.filter(o => regexFlexivel(s.r).test(o.texto)).map(o => o.nome),
    }))
    .sort((a, b) => a.tambemEm.length - b.tambemEm.length || b.texto.length - a.texto.length)
    .slice(0, MAXIMO_SUGESTOES);

  const exclusoes = tipos
    .filter(o => o.parecido >= PARECIDO_MINIMO)
    .flatMap(o =>
      o.rotulos
        .filter(r => r.includes(' ') && r.length <= 60 && !emAlgum(r))
        .sort((a, b) => b.length - a.length)
        .slice(0, EXCLUSOES_POR_TIPO)
        .map(texto => ({ texto, tipo: o.nome })),
    )
    .filter((e, i, lista) => lista.findIndex(x => x.texto === e.texto) === i)
    .slice(0, MAXIMO_EXCLUSOES);

  return { tipos: tipos.map(({ nome, parecido }) => ({ nome, parecido })), termos: termosSugeridos, exclusoes };
}

const celulasDoRotulo = (planilha: Planilha, rotulo: string) => planilha.celulas.filter(c => normalizarTexto(c.texto) === rotulo);
