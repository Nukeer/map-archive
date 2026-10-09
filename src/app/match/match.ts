import { CAMPOS, CampoMapeavel, TokenPdf } from '../pdf-mapeamento/pdf-mapeamento.model';
import { contemTermo, criarDocumentoTexto, extrairCampo } from '../pdf-mapeamento/extrator';
import type { DimensaoPagina } from '../pdf-mapeamento/pdf-documento.service';
import { MapeamentoPdfV2, extrairCampoV2, termoNaPosicao, termoPresente } from '../pdf-mapeamento-v2/mapeamento-v2';
import { Planilha, converterParaPlanilha, descreverIntervalo, referencia } from '../pdf-mapeamento-v2/planilha';
import { MapeamentoPdf } from '../pdf-mapeamento/pdf-mapeamento.model';
import { MapeamentoSalvo } from '../armazenamento/mapeamentos-db.service';
import { AvaliacaoV3, MapeamentoPdfV3, avaliarV3 } from '../pdf-mapeamento-v3/mapeamento-v3';
import { MapeamentoPdfV4, avaliarV4 } from '../pdf-mapeamento-v4/mapeamento-v4';
import { MapeamentoPdfV5, avaliarV5 } from '../pdf-mapeamento-v5/mapeamento-v5';
import type { AparenciaPdf } from '../pdf-mapeamento-v5/aparencia';
import { nomeIdentificador } from '../pdf-mapeamento/identificador';

export interface ResultadoTermo {
  texto: string;
  encontrado: boolean;
  /** Só v2: o termo continua na mesma célula (linha/coluna) do mapeamento. */
  naPosicao?: boolean;
  /** Só v2: célula esperada, ex.: "Pág.1!A1". */
  celula?: string;
}

export interface ResultadoCampo {
  chave: CampoMapeavel;
  rotulo: string;
  /** Valor padronizado, ou null se não encontrado. */
  valor: string | null;
  /** Como foi encontrado (v1: pelo rótulo; v2: posição, rótulo ou vizinhança). */
  origem?: string;
  /** Só v2: células onde o valor foi lido, ex.: "Pág.1!E7". */
  celulas?: string;
}

export interface ResultadoMatch {
  mapeamento: MapeamentoSalvo;
  /** O PDF tem todos os termos identificadores do tipo de documento. */
  corresponde: boolean;
  /** Todos os campos foram extraídos. */
  camposCompletos: boolean;
  termos: ResultadoTermo[];
  campos: ResultadoCampo[];
  /** O PDF não tem texto (provavelmente digitalizado). */
  semTexto: boolean;
  /** v3 em diante: score com todos os sinais; `corresponde` = veredito "corresponde". */
  avaliacao?: AvaliacaoV3;
}

/**
 * Verifica se o PDF (já convertido em tokens) é do tipo mapeado e extrai os campos.
 * `aparencia` só é usada pela v5; sem ela, os sinais de aparência ficam informativos.
 */
export function verificarDocumento(
  registro: MapeamentoSalvo,
  tokens: TokenPdf[],
  dimensoes: DimensaoPagina[],
  aparencia?: AparenciaPdf,
): ResultadoMatch {
  if (temScore(registro)) return verificarComScore(registro, tokens, dimensoes, aparencia);

  const { termos, campos } =
    registro.versao === 2
      ? verificarV2(registro.mapeamento as MapeamentoPdfV2, converterParaPlanilha(tokens, dimensoes))
      : verificarV1(registro.mapeamento as MapeamentoPdf, tokens);

  return {
    mapeamento: registro,
    corresponde: termos.length > 0 && termos.every(t => t.encontrado),
    camposCompletos: campos.every(c => c.valor !== null),
    termos,
    campos,
    semTexto: tokens.length === 0,
  };
}

function verificarV1(mapeamento: MapeamentoPdf, tokens: TokenPdf[]) {
  const doc = criarDocumentoTexto(tokens);
  return {
    termos: mapeamento.termos.map(texto => ({ texto, encontrado: contemTermo(doc, texto) })),
    campos: CAMPOS.map(({ chave, rotulo }) => {
      const r = extrairCampo(doc, chave, mapeamento[chave]);
      return {
        chave,
        rotulo: chave === 'cnpj' ? nomeIdentificador(mapeamento.cnpj.identificador) : rotulo,
        valor: r?.valor ?? null,
        origem: r ? `após "${mapeamento[chave].rotulo || 'início'}"` : undefined,
      };
    }),
  };
}

const ORDEM_VEREDITO = { corresponde: 0, duvidoso: 1, nao: 2 } as const;

/**
 * v3 em diante: compara o PDF com todos os mapeamentos que têm score e ordena do mais provável para o menos
 * (veredito e, depois, confiança). Serve para descobrir o tipo sem escolher o mapeamento antes.
 */
export function identificarDocumento(
  registros: MapeamentoSalvo[],
  tokens: TokenPdf[],
  dimensoes: DimensaoPagina[],
  aparencia?: AparenciaPdf,
): ResultadoMatch[] {
  return registros
    .filter(temScore)
    .map(r => verificarDocumento(r, tokens, dimensoes, aparencia))
    .sort(
      (a, b) =>
        ORDEM_VEREDITO[a.avaliacao!.veredito] - ORDEM_VEREDITO[b.avaliacao!.veredito] ||
        b.avaliacao!.confianca - a.avaliacao!.confianca,
    );
}

/** Mapeamentos que decidem por score (e podem ser ranqueados). */
export const temScore = (registro: MapeamentoSalvo) => registro.versao >= 3;

/** Mapeamentos que precisam da aparência do PDF (`PdfDocumentoService.aparencia`). */
export const usaAparencia = (registro: MapeamentoSalvo) => registro.versao === 5;

/** v3 em diante extraem termos e campos como a v2 e decidem pelo score de sinais. */
function verificarComScore(
  registro: MapeamentoSalvo,
  tokens: TokenPdf[],
  dimensoes: DimensaoPagina[],
  aparencia?: AparenciaPdf,
): ResultadoMatch {
  const mapeamento = registro.mapeamento as MapeamentoPdfV3 | MapeamentoPdfV4 | MapeamentoPdfV5;
  const planilha = converterParaPlanilha(tokens, dimensoes);
  const { termos, campos } = verificarV2({ ...mapeamento, versao: 2 }, planilha);
  const avaliacao =
    mapeamento.versao === 5
      ? avaliarV5(mapeamento, planilha, dimensoes, termos, campos, aparencia)
      : mapeamento.versao === 4
        ? avaliarV4(mapeamento, planilha, dimensoes, termos, campos)
        : avaliarV3(mapeamento, planilha, dimensoes, termos, campos);
  return {
    mapeamento: registro,
    corresponde: tokens.length > 0 && avaliacao.veredito === 'corresponde',
    camposCompletos: campos.every(c => c.valor !== null),
    termos,
    campos,
    semTexto: tokens.length === 0,
    avaliacao,
  };
}

function verificarV2(mapeamento: MapeamentoPdfV2, planilha: Planilha) {
  const origens = { posicao: 'mesma linha/coluna', rotulo: 'pelo rótulo', vizinhanca: 'linha vizinha', unico: 'único valor no documento' };
  return {
    termos: mapeamento.termos.map(t => ({
      texto: t.texto,
      encontrado: termoPresente(planilha, t.texto),
      naPosicao: termoNaPosicao(planilha, t),
      celula: `Pág.${t.celula.pagina}!${referencia(t.celula)}`,
    })),
    campos: CAMPOS.map(({ chave, rotulo }) => {
      const r = extrairCampoV2(planilha, chave, mapeamento[chave]);
      const primeira = r?.celulas[0];
      const ultima = r?.celulas[r.celulas.length - 1];
      return {
        chave,
        rotulo: chave === 'cnpj' ? nomeIdentificador(mapeamento.cnpj.identificador) : rotulo,
        valor: r?.valor ?? null,
        origem: r ? origens[r.origem] : undefined,
        celulas: primeira && ultima ? descreverIntervalo(primeira, ultima) : undefined,
      };
    }),
  };
}
