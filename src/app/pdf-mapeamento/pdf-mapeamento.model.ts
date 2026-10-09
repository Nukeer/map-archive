import type { TipoIdentificador } from './identificador';

/**
 * Campos de valor único que o usuário aponta no PDF. `cnpj` é o identificador do contribuinte:
 * o nome ficou por compatibilidade com os mapeamentos salvos, mas o tipo (CNPJ, CPF, CAEPF, CNO,
 * IE ou IM) vai em `identificador` no campo mapeado.
 */
export type CampoMapeavel = 'cnpj' | 'competencia' | 'valor';

/**
 * Como localizar um campo em qualquer PDF do mesmo tipo, sem depender de posição na página:
 * procura o rótulo (texto fixo antes do valor) e pega o N-ésimo valor com o formato do campo depois dele.
 */
export interface CampoMapeado {
  /** Texto fixo que antecede o valor, já normalizado (ex.: "cnpj:"). Vazio = início do documento. */
  rotulo: string;
  /** Qual ocorrência do rótulo usar (1 = primeira). */
  ocorrenciaRotulo: number;
  /** Qual valor com o formato do campo, contado a partir do rótulo (1 = o primeiro). */
  indiceAposRotulo: number;
  /** Valor encontrado no PDF de exemplo, apenas para referência. */
  exemplo: string;
  /** Só no campo `cnpj`: tipo do identificador. Ausente = CNPJ (mapeamentos antigos). */
  identificador?: TipoIdentificador;
}

export interface MapeamentoPdf {
  nome: string;
  cnpj: CampoMapeado;
  competencia: CampoMapeado;
  valor: CampoMapeado;
  /** Textos que identificam o tipo de documento; todos precisam estar presentes. */
  termos: string[];
  /** Nome do PDF usado como modelo. */
  arquivoExemplo?: string;
}

/** Palavra do PDF. A caixa (0..1 da página) serve só para desenhar a camada clicável; não vai para o mapeamento. */
export interface TokenPdf {
  indice: number;
  pagina: number;
  linha: number;
  /** Trecho de texto do PDF de onde a palavra veio (cada trecho é desenhado separadamente no PDF). */
  trecho?: number;
  texto: string;
  caixa: { x: number; y: number; largura: number; altura: number };
}

/** Intervalo inclusivo de índices de tokens. */
export interface Faixa {
  inicio: number;
  fim: number;
}

export const MINIMO_TERMOS = 2;

const MESES = 'janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro|jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez';

/**
 * Formatos dos campos, aplicados sobre texto normalizado (minúsculo, sem acento).
 * Aceitam espaços/quebras de linha entre as partes do valor.
 */
export const PADROES: Record<CampoMapeavel, RegExp> = {
  cnpj: /(?<!\d)\d{2}\s*\.?\s*\d{3}\s*\.?\s*\d{3}\s*\/?\s*\d{4}\s*-?\s*\d{2}(?!\d)/,
  competencia: new RegExp(
    `(?<![\\d/])(?:\\d{1,2}\\s*[/\\-.]\\s*)?(0?[1-9]|1[0-2])\\s*[/\\-.]\\s*(\\d{4})(?!\\d)|\\b(${MESES})\\.?\\s*(?:/|-|de)?\\s*(\\d{4})(?!\\d)`,
  ),
  valor: /(?<![\d.,])(?:\d{1,3}(?:\s*\.\s*\d{3})+|\d+)\s*,\s*\d{2}(?!\d)/,
};

export const CAMPOS: ReadonlyArray<{ chave: CampoMapeavel; rotulo: string; artigo: string; dica: string }> = [
  {
    chave: 'cnpj',
    rotulo: 'Identificador',
    artigo: 'o identificador (CNPJ, CPF, CAEPF, CNO, IE ou IM)',
    dica: 'CNPJ 00.000.000/0000-00, CPF 000.000.000-00, CAEPF 000.000.000/000-00, CNO 00.000.00000/00, IE ou IM',
  },
  { chave: 'competencia', rotulo: 'Mês de competência', artigo: 'o mês de competência', dica: 'MM/AAAA, DD/MM/AAAA ou "setembro/2026"' },
  { chave: 'valor', rotulo: 'Valor a pagar', artigo: 'o valor a pagar', dica: '1.234,56' },
];
