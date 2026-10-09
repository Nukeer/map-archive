import { CampoMapeavel } from '../pdf-mapeamento/pdf-mapeamento.model';
import { normalizarTexto } from '../pdf-mapeamento/extrator';
import type { DimensaoPagina } from '../pdf-mapeamento/pdf-documento.service';
import { MapeamentoPdfV2, ehRotulo, regexFlexivel, termoPresente } from '../pdf-mapeamento-v2/mapeamento-v2';
import { Planilha } from '../pdf-mapeamento-v2/planilha';
import { IDENTIFICADORES, TipoIdentificador } from '../pdf-mapeamento/identificador';

export { cnpjValido } from '../pdf-mapeamento/identificador';

/**
 * v3 = mapeamento v2 (campos e termos por célula) + assinatura do PDF modelo, gerada
 * automaticamente, e termos de exclusão. O match deixa de ser "tem todos os termos" e vira
 * um score que soma vários sinais independentes.
 */
export interface MapeamentoPdfV3 extends Omit<MapeamentoPdfV2, 'versao'> {
  versao: 3;
  assinatura: AssinaturaV3;
  /** Textos que não podem aparecer (ex.: "Simples Nacional" num mapeamento de DARF). */
  exclusoes: string[];
}

export interface AssinaturaV3 {
  /** Identificação do emissor tirada da linha digitável do modelo, se houver. */
  codigoBarras?: Pick<CodigoBarras, 'tipo' | 'segmento' | 'emissor'>;
  /** Textos fixos do layout (rótulos), normalizados. */
  rotulos: string[];
  paginas: number;
  /** Tamanho da 1ª página em pontos, arredondado. */
  tamanhoPagina?: DimensaoPagina;
}

// ---- Código de barras / linha digitável ----

export interface CodigoBarras {
  /** `arrecadacao`: guias de tributos e concessionárias (começa com 8); `boleto`: cobrança bancária. */
  tipo: 'arrecadacao' | 'boleto';
  /** Arrecadação: 2º dígito (5 = órgãos governamentais, 1 = prefeituras...). */
  segmento?: string;
  /** Arrecadação: código do órgão/empresa (raiz do CNPJ no segmento 6). Boleto: código do banco. */
  emissor: string;
  /** Valor em reais no formato de `padronizar` ("1100.00"), quando o código traz o valor. */
  valor?: string;
  /** Código de barras com 44 dígitos. */
  codigo: string;
}

/** Módulo 10 (FEBRABAN): pesos 2,1 a partir da direita, somando os dígitos de cada produto. */
export function modulo10(numero: string): number {
  let soma = 0;
  for (let i = numero.length - 1, peso = 2; i >= 0; i--, peso = peso === 2 ? 1 : 2) {
    const produto = Number(numero[i]) * peso;
    soma += produto > 9 ? produto - 9 : produto;
  }
  return (10 - (soma % 10)) % 10;
}

/** Módulo 11 da arrecadação: pesos 2..9 a partir da direita; resto 0 ou 1 vira 0. */
export function modulo11Arrecadacao(numero: string): number {
  let soma = 0;
  for (let i = numero.length - 1, peso = 2; i >= 0; i--, peso = peso === 9 ? 2 : peso + 1) {
    soma += Number(numero[i]) * peso;
  }
  const resto = soma % 11;
  return resto <= 1 ? 0 : 11 - resto;
}

/** Módulo 11 do boleto (DV geral): resto 0, 1 ou 10 vira 1. */
export function modulo11Boleto(numero: string): number {
  let soma = 0;
  for (let i = numero.length - 1, peso = 2; i >= 0; i--, peso = peso === 9 ? 2 : peso + 1) {
    soma += Number(numero[i]) * peso;
  }
  const dv = 11 - (soma % 11);
  return dv === 0 || dv === 10 || dv === 11 ? 1 : dv;
}

function valorEmReais(centavos: string): string | undefined {
  const n = Number(centavos);
  return n > 0 ? (n / 100).toFixed(2) : undefined;
}

/** Interpreta 44 dígitos de arrecadação, conferindo o DV geral. */
function lerArrecadacao(codigo: string): CodigoBarras | null {
  if (codigo.length !== 44 || codigo[0] !== '8') return null;
  const referencia = codigo[2];
  const modulo = referencia === '6' || referencia === '7' ? modulo10 : referencia === '8' || referencia === '9' ? modulo11Arrecadacao : null;
  if (!modulo || modulo(codigo.slice(0, 3) + codigo.slice(4)) !== Number(codigo[3])) return null;
  const segmento = codigo[1];
  return {
    tipo: 'arrecadacao',
    segmento,
    emissor: segmento === '6' ? codigo.slice(15, 23) : codigo.slice(15, 19),
    valor: referencia === '6' || referencia === '8' ? valorEmReais(codigo.slice(4, 15)) : undefined,
    codigo,
  };
}

/** Linha digitável de arrecadação: 4 blocos de 11 dígitos + DV. */
function lerLinhaArrecadacao(linha: string): CodigoBarras | null {
  if (linha.length !== 48 || linha[0] !== '8') return null;
  const modulo = linha[2] === '6' || linha[2] === '7' ? modulo10 : modulo11Arrecadacao;
  const blocos = [0, 1, 2, 3].map(i => linha.slice(i * 12, i * 12 + 12));
  if (blocos.some(b => modulo(b.slice(0, 11)) !== Number(b[11]))) return null;
  return lerArrecadacao(blocos.map(b => b.slice(0, 11)).join(''));
}

/** Linha digitável de boleto (47 dígitos): campos 1–3 com DV módulo 10, DV geral módulo 11. */
function lerLinhaBoleto(linha: string): CodigoBarras | null {
  if (linha.length !== 47) return null;
  const campos = [linha.slice(0, 10), linha.slice(10, 21), linha.slice(21, 32)];
  if (campos.some(c => modulo10(c.slice(0, -1)) !== Number(c[c.length - 1]))) return null;
  const codigo = linha.slice(0, 4) + linha[32] + linha.slice(33, 47) + campos[0].slice(4, 9) + campos[1].slice(0, 10) + campos[2].slice(0, 10);
  if (modulo11Boleto(codigo.slice(0, 4) + codigo.slice(5)) !== Number(codigo[4])) return null;
  return { tipo: 'boleto', emissor: linha.slice(0, 3), valor: valorEmReais(linha.slice(37, 47)), codigo };
}

/**
 * Procura uma linha digitável válida no texto. Junta grupos seguidos de dígitos (aceitando
 * ".", "-" e espaços entre eles) e só aceita a sequência se os dígitos verificadores baterem,
 * o que evita confundir com CNPJ, valores ou outros números.
 */
export function lerCodigoBarras(planilha: Planilha): CodigoBarras | null {
  const grupos = planilha.celulas
    .flatMap(c => c.texto.split(/\s+/))
    .map(p => (/^[\d.\-]+$/.test(p) ? p.replace(/\D/g, '') : null));

  for (let inicio = 0; inicio < grupos.length; inicio++) {
    // Sequências que começam aqui, por tamanho; a mais longa é testada primeiro para que os
    // 44 primeiros dígitos de uma linha de 48 não passem por código de barras por acaso.
    const porTamanho = new Map<number, string>();
    let digitos = '';
    for (let i = inicio; i < grupos.length && grupos[i] !== null && digitos.length < 48; i++) {
      digitos += grupos[i];
      porTamanho.set(digitos.length, digitos);
    }
    const r =
      (porTamanho.has(48) && lerLinhaArrecadacao(porTamanho.get(48)!)) ||
      (porTamanho.has(47) && lerLinhaBoleto(porTamanho.get(47)!)) ||
      (porTamanho.has(44) && lerArrecadacao(porTamanho.get(44)!));
    if (r) return r;
  }
  return null;
}

// ---- Assinatura do layout ----

/** Rótulos curtos demais ("de", "R$") aparecem em qualquer documento e não ajudam. */
const LETRAS_MINIMAS_ROTULO = 4;

export function rotulosDoLayout(planilha: Planilha): string[] {
  const rotulos = planilha.celulas
    .filter(c => ehRotulo(c))
    .map(c => normalizarTexto(c.texto))
    .filter(t => t.replace(/[^a-z]/g, '').length >= LETRAS_MINIMAS_ROTULO);
  return [...new Set(rotulos)];
}

export function gerarAssinatura(planilha: Planilha, dimensoes: DimensaoPagina[]): AssinaturaV3 {
  const codigo = lerCodigoBarras(planilha);
  const primeira = dimensoes[0];
  return {
    codigoBarras: codigo ? { tipo: codigo.tipo, segmento: codigo.segmento, emissor: codigo.emissor } : undefined,
    rotulos: rotulosDoLayout(planilha),
    paginas: dimensoes.length,
    tamanhoPagina: primeira ? { largura: Math.round(primeira.largura), altura: Math.round(primeira.altura) } : undefined,
  };
}

/**
 * Quanto o layout do PDF novo se parece com o do modelo.
 * `cobertura`: rótulos do modelo presentes no PDF novo; `precisao`: rótulos do PDF novo presentes
 * no modelo (cai quando o PDF novo tem muito texto que o modelo não tem). `f1` combina os dois.
 * `rotulosConhecidos` (v4): rótulos aceitos na precisão; por padrão, os próprios rótulos do modelo.
 */
export function similaridadeLayout(
  rotulosModelo: string[],
  planilha: Planilha,
  rotulosConhecidos = rotulosModelo,
): { cobertura: number; precisao: number; f1: number } {
  const textoNovo = normalizarTexto(planilha.celulas.map(c => c.texto).join(' '));
  const textoModelo = rotulosConhecidos.join(' ');
  const rotulosNovos = rotulosDoLayout(planilha);
  const fracao = (lista: string[], texto: string) =>
    lista.length ? lista.filter(r => regexFlexivel(r).test(texto)).length / lista.length : 0;

  const cobertura = fracao(rotulosModelo, textoNovo);
  const precisao = fracao(rotulosNovos, textoModelo);
  const f1 = cobertura + precisao ? (2 * cobertura * precisao) / (cobertura + precisao) : 0;
  return { cobertura, precisao, f1 };
}

// ---- Validação dos campos ----

/** "MM/AAAA" com mês válido e ano entre 2000 e o ano seguinte ao atual. */
export function competenciaValida(competencia: string, hoje = new Date()): boolean {
  const m = /^(\d{2})\/(\d{4})$/.exec(competencia);
  if (!m) return false;
  const mes = Number(m[1]);
  const ano = Number(m[2]);
  return mes >= 1 && mes <= 12 && ano >= 2000 && ano <= hoje.getFullYear() + 1;
}

/** `identificador`: tipo do campo `cnpj` (CNPJ, CPF...); ausente = CNPJ. */
export function campoValido(chave: CampoMapeavel, valor: string | null, hoje: Date, identificador: TipoIdentificador = 'cnpj'): boolean {
  if (!valor) return false;
  if (chave === 'cnpj') return IDENTIFICADORES[identificador].validar(valor);
  if (chave === 'competencia') return competenciaValida(valor, hoje);
  return Number(valor) > 0;
}

// ---- Score ----

export interface SinalV3 {
  /** `geometria` só existe a partir da v4; `visual`, `fontes` e `produtor`, a partir da v5. */
  chave: 'exclusoes' | 'codigoBarras' | 'layout' | 'termos' | 'campos' | 'valorCodigo' | 'paginas' | 'geometria' | 'visual' | 'fontes' | 'produtor';
  titulo: string;
  /** -1 (contra) a 1 (a favor). */
  nota: number;
  /** 0 = só informativo, não entra no score. */
  peso: number;
  detalhe: string;
  /** Com nota negativa, reprova o documento sozinho. */
  eliminatorio?: boolean;
}

export type VereditoV3 = 'corresponde' | 'duvidoso' | 'nao';

export interface AvaliacaoV3 {
  veredito: VereditoV3;
  /** 0 a 1. */
  confianca: number;
  sinais: SinalV3[];
  codigoBarras: CodigoBarras | null;
}

/** A partir de quanta confiança o PDF é aceito, ou fica para revisão. */
export const CONFIANCA_ACEITA = 0.75;
export const CONFIANCA_DUVIDOSA = 0.5;

const PESOS = { codigoBarras: 3, layout: 3, termos: 2, campos: 2, valorCodigo: 1, paginas: 1 } as const;
/** Com poucos rótulos no modelo a similaridade de layout é pouco confiável. */
const ROTULOS_MINIMOS_LAYOUT = 5;
/** Diferença máxima, em pontos, para considerar o mesmo tamanho de página. */
const TOLERANCIA_PAGINA = 2;

export const pct = (n: number) => `${Math.round(n * 100)}%`;
export const limitar = (n: number) => Math.max(-1, Math.min(1, n));

export interface OpcoesAvaliacao {
  hoje?: Date;
  /** v4: rótulos vistos em algum modelo, usados na precisão do layout. */
  rotulosConhecidos?: string[];
}

export function avaliarV3(
  mapeamento: MapeamentoPdfV3,
  planilha: Planilha,
  dimensoes: DimensaoPagina[],
  termos: ReadonlyArray<{ encontrado: boolean; naPosicao?: boolean }>,
  campos: ReadonlyArray<{ chave: CampoMapeavel; rotulo: string; valor: string | null }>,
  { hoje = new Date(), rotulosConhecidos }: OpcoesAvaliacao = {},
): AvaliacaoV3 {
  const { assinatura } = mapeamento;
  const sinais: SinalV3[] = [];
  const codigo = lerCodigoBarras(planilha);

  // Termos de exclusão.
  const excluidos = (mapeamento.exclusoes ?? []).filter(t => termoPresente(planilha, t));
  if (excluidos.length) {
    sinais.push({ chave: 'exclusoes', titulo: 'Termos de exclusão', nota: -1, peso: 0, eliminatorio: true, detalhe: `encontrado: ${excluidos.map(t => `"${t}"`).join(', ')}` });
  } else if (mapeamento.exclusoes?.length) {
    sinais.push({ chave: 'exclusoes', titulo: 'Termos de exclusão', nota: 1, peso: 0, detalhe: 'nenhum encontrado' });
  }

  // Código de barras: mesmo tipo, segmento e órgão/banco do modelo.
  const esperado = assinatura.codigoBarras;
  const descrever = (c: Pick<CodigoBarras, 'tipo' | 'segmento' | 'emissor'>) =>
    c.tipo === 'boleto' ? `boleto do banco ${c.emissor}` : `arrecadação segmento ${c.segmento}, órgão ${c.emissor}`;
  if (esperado && codigo) {
    const igual = esperado.tipo === codigo.tipo && esperado.segmento === codigo.segmento && esperado.emissor === codigo.emissor;
    sinais.push({
      chave: 'codigoBarras',
      titulo: 'Código de barras',
      nota: igual ? 1 : -1,
      peso: PESOS.codigoBarras,
      eliminatorio: true,
      detalhe: igual ? descrever(codigo) : `esperado ${descrever(esperado)}, veio ${descrever(codigo)}`,
    });
  } else if (esperado) {
    sinais.push({ chave: 'codigoBarras', titulo: 'Código de barras', nota: -0.5, peso: 1, detalhe: `modelo tem ${descrever(esperado)}; nenhuma linha digitável válida neste PDF` });
  } else if (codigo) {
    sinais.push({ chave: 'codigoBarras', titulo: 'Código de barras', nota: 0, peso: 0, detalhe: `${descrever(codigo)} (o modelo não tinha código para comparar)` });
  }

  // Layout: rótulos fixos em comum.
  if (assinatura.rotulos.length) {
    const s = similaridadeLayout(assinatura.rotulos, planilha, rotulosConhecidos);
    sinais.push({
      chave: 'layout',
      titulo: 'Layout',
      // f1 0,8+ conta a favor; 0,5 é neutro; 0,2 ou menos, contra.
      nota: limitar((s.f1 - 0.5) / 0.3),
      peso: assinatura.rotulos.length >= ROTULOS_MINIMOS_LAYOUT ? PESOS.layout : 1,
      detalhe: `similaridade ${pct(s.f1)} · ${pct(s.cobertura)} dos ${assinatura.rotulos.length} rótulos do modelo presentes`,
    });
  }

  // Termos identificadores escolhidos pelo usuário.
  if (termos.length) {
    const encontrados = termos.filter(t => t.encontrado).length;
    const naPosicao = termos.filter(t => t.naPosicao).length;
    const todos = encontrados === termos.length;
    sinais.push({
      chave: 'termos',
      titulo: 'Termos identificadores',
      nota: !todos ? -1 : naPosicao === termos.length ? 1 : 0.5,
      peso: PESOS.termos,
      detalhe: `${encontrados}/${termos.length} presentes, ${naPosicao} na posição mapeada`,
    });
  }

  // Campos extraídos e válidos (DV do CNPJ, data plausível, valor positivo).
  const validos = campos.filter(c => campoValido(c.chave, c.valor, hoje, mapeamento.cnpj.identificador));
  const invalidos = campos.filter(c => !validos.includes(c));
  sinais.push({
    chave: 'campos',
    titulo: 'Campos extraídos',
    nota: campos.length ? (2 * validos.length) / campos.length - 1 : 0,
    peso: PESOS.campos,
    detalhe: invalidos.length
      ? `${validos.length}/${campos.length} válidos · ${invalidos.map(c => `${c.rotulo} ${c.valor ? 'inválido' : 'ausente'}`).join(', ')}`
      : `${campos.length}/${campos.length} válidos`,
  });

  // Valor extraído igual ao valor do código de barras.
  const valor = campos.find(c => c.chave === 'valor')?.valor;
  if (codigo?.valor && valor) {
    const igual = Number(codigo.valor) === Number(valor);
    sinais.push({
      chave: 'valorCodigo',
      titulo: 'Valor × código de barras',
      nota: igual ? 1 : -1,
      peso: PESOS.valorCodigo,
      detalhe: igual ? `ambos ${codigo.valor}` : `extraído ${valor}, código de barras ${codigo.valor}`,
    });
  }

  // Páginas: tamanho e quantidade.
  const tamanho = assinatura.tamanhoPagina;
  const primeira = dimensoes[0];
  if (tamanho && primeira) {
    const mesmoTamanho =
      Math.abs(primeira.largura - tamanho.largura) <= TOLERANCIA_PAGINA && Math.abs(primeira.altura - tamanho.altura) <= TOLERANCIA_PAGINA;
    const mesmaQuantidade = dimensoes.length === assinatura.paginas;
    sinais.push({
      chave: 'paginas',
      titulo: 'Páginas',
      nota: !mesmoTamanho ? -1 : mesmaQuantidade ? 1 : 0,
      peso: PESOS.paginas,
      detalhe: `${dimensoes.length} pág. de ${Math.round(primeira.largura)}×${Math.round(primeira.altura)} pt (modelo: ${assinatura.paginas} de ${tamanho.largura}×${tamanho.altura})`,
    });
  }

  return consolidar(sinais, codigo);
}

/** Junta os sinais em confiança (média ponderada das notas, de 0 a 1) e veredito. */
export function consolidar(sinais: SinalV3[], codigo: CodigoBarras | null): AvaliacaoV3 {
  const pesoTotal = sinais.reduce((t, s) => t + s.peso, 0);
  const pontos = sinais.reduce((t, s) => t + s.peso * s.nota, 0);
  const confianca = pesoTotal ? (pontos / pesoTotal + 1) / 2 : 0;
  const reprovado = sinais.some(s => s.eliminatorio && s.nota < 0);
  const veredito: VereditoV3 = reprovado
    ? 'nao'
    : confianca >= CONFIANCA_ACEITA ? 'corresponde'
    : confianca >= CONFIANCA_DUVIDOSA ? 'duvidoso'
    : 'nao';

  return { veredito, confianca: reprovado ? Math.min(confianca, CONFIANCA_DUVIDOSA - 0.01) : confianca, sinais, codigoBarras: codigo };
}
