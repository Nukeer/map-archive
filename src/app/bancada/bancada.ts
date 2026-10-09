import { normalizarTexto } from '../pdf-mapeamento/extrator';
import { CampoMapeavel } from '../pdf-mapeamento/pdf-mapeamento.model';
import type { MapeamentoSalvo } from '../armazenamento/mapeamentos-db.service';
import type { ResultadoMatch } from '../match/match';

/**
 * Bancada de testes: um conjunto de documentos com gabarito (tipo certo e, opcionalmente, os
 * valores certos), rodado contra todos os mapeamentos salvos. Mede cada versão (v1 a v5) com
 * os mesmos documentos e compara com a execução anterior.
 */
export interface DocumentoBancada {
  id: string;
  nome: string;
  arquivo: Blob;
  gabarito: Gabarito;
  adicionadoEm: string;
}

export interface Gabarito {
  /** Nome do tipo (serviço) certo; `null` = outro tipo, que nenhum mapeamento deve aceitar; `undefined` = ainda não definido. */
  tipo?: string | null;
  /** Valores certos, opcionais, no formato em que o usuário digitou. */
  campos: Partial<Record<CampoMapeavel, string>>;
}

export type Desfecho =
  /** Reconheceu o tipo certo, e só ele. */
  | 'acerto'
  /** Documento de outro tipo, nenhum mapeamento aceitou. */
  | 'rejeitado'
  /** A versão tem mapeamento do tipo certo, mas nenhum aceitou o documento. */
  | 'nao-reconhecido'
  /** Aceito só por mapeamento de outro tipo. */
  | 'tipo-errado'
  /** Aceito por mais de um tipo. */
  | 'ambiguo'
  /** Documento de outro tipo (ou de tipo que a versão não conhece) aceito por algum mapeamento. */
  | 'falso-positivo'
  /** A versão não tem mapeamento do tipo do documento e não aceitou nada: não entra na conta. */
  | 'sem-mapeamento';

export const DESFECHOS: Record<Desfecho, { titulo: string; certo: boolean | null }> = {
  acerto: { titulo: 'Tipo certo', certo: true },
  rejeitado: { titulo: 'Rejeitado corretamente', certo: true },
  'nao-reconhecido': { titulo: 'Não reconhecido', certo: false },
  'tipo-errado': { titulo: 'Tipo errado', certo: false },
  ambiguo: { titulo: 'Ambíguo', certo: false },
  'falso-positivo': { titulo: 'Falso positivo', certo: false },
  'sem-mapeamento': { titulo: 'Sem mapeamento desta versão', certo: null },
};

export interface CampoConferido {
  chave: CampoMapeavel;
  esperado: string;
  lido: string | null;
  certo: boolean;
}

export interface AvaliacaoDocumento {
  versao: MapeamentoSalvo['versao'];
  desfecho: Desfecho;
  /** Tipo escolhido pela versão (o aceito; com score, o de maior confiança). */
  previsto: string | null;
  confianca?: number;
  /** O mapeamento do tipo certo deu "duvidoso" (v3 em diante). */
  duvidoso: boolean;
  /** Valores do gabarito conferidos com o que o mapeamento do tipo certo leu. */
  campos: CampoConferido[];
  /** Veredito de cada mapeamento da versão, para o detalhe. */
  mapeamentos: Array<{ nome: string; veredito: 'corresponde' | 'duvidoso' | 'nao'; confianca?: number }>;
}

const chave = (nome: string) => normalizarTexto(nome);
const veredito = (r: ResultadoMatch) => r.avaliacao?.veredito ?? (r.corresponde ? 'corresponde' : 'nao');

/** Avalia o documento numa versão, a partir dos resultados de todos os mapeamentos dessa versão. */
export function avaliarDocumento(
  versao: MapeamentoSalvo['versao'],
  resultados: ResultadoMatch[],
  gabarito: Gabarito,
): AvaliacaoDocumento {
  const esperado = gabarito.tipo === undefined || gabarito.tipo === null ? null : chave(gabarito.tipo);
  const aceitos = resultados.filter(r => r.corresponde).sort((a, b) => (b.avaliacao?.confianca ?? 0) - (a.avaliacao?.confianca ?? 0));
  const tiposAceitos = [...new Set(aceitos.map(r => chave(r.mapeamento.nome)))];
  const conhece = esperado !== null && resultados.some(r => chave(r.mapeamento.nome) === esperado);

  let desfecho: Desfecho;
  if (esperado === null) desfecho = aceitos.length ? 'falso-positivo' : 'rejeitado';
  else if (!conhece) desfecho = aceitos.length ? 'falso-positivo' : 'sem-mapeamento';
  else if (!aceitos.length) desfecho = 'nao-reconhecido';
  else if (tiposAceitos.length > 1) desfecho = 'ambiguo';
  else desfecho = tiposAceitos[0] === esperado ? 'acerto' : 'tipo-errado';

  // Campos: lidos pelo mapeamento do tipo certo (o que aceitou, ou o de maior confiança).
  const doTipo = resultados
    .filter(r => esperado !== null && chave(r.mapeamento.nome) === esperado)
    .sort((a, b) => Number(b.corresponde) - Number(a.corresponde) || (b.avaliacao?.confianca ?? 0) - (a.avaliacao?.confianca ?? 0))[0];
  const campos = doTipo ? conferirCampos(gabarito.campos, doTipo) : [];

  return {
    versao,
    desfecho,
    previsto: aceitos[0]?.mapeamento.nome ?? null,
    confianca: aceitos[0]?.avaliacao?.confianca ?? doTipo?.avaliacao?.confianca,
    duvidoso: doTipo?.avaliacao?.veredito === 'duvidoso',
    campos,
    mapeamentos: resultados.map(r => ({ nome: r.mapeamento.nome, veredito: veredito(r), confianca: r.avaliacao?.confianca })),
  };
}

function conferirCampos(esperados: Gabarito['campos'], resultado: ResultadoMatch): CampoConferido[] {
  return (Object.keys(esperados) as CampoMapeavel[])
    .filter(c => esperados[c]?.trim())
    .map(c => {
      const lido = resultado.campos.find(x => x.chave === c)?.valor ?? null;
      return { chave: c, esperado: esperados[c]!.trim(), lido, certo: lido !== null && mesmoValor(c, esperados[c]!, lido) };
    });
}

/** Compara ignorando formatação: identificador só letras e dígitos, competência MM/AAAA, valor como número. */
export function mesmoValor(campo: CampoMapeavel, esperado: string, lido: string): boolean {
  const canonico = (texto: string): string | number | null => {
    if (campo === 'cnpj') return texto.replace(/[^0-9a-z]/gi, '').toUpperCase();
    if (campo === 'competencia') {
      const m = /(\d{1,2})\D+(\d{4})/.exec(texto);
      return m ? `${m[1].padStart(2, '0')}/${m[2]}` : null;
    }
    const limpo = texto.replace(/[^\d.,-]/g, '');
    const numero = Number(limpo.includes(',') ? limpo.replace(/\./g, '').replace(',', '.') : limpo);
    return Number.isFinite(numero) ? Math.round(numero * 100) : null;
  };
  const a = canonico(esperado);
  return a !== null && a === canonico(lido);
}

export interface ResumoVersao {
  versao: MapeamentoSalvo['versao'];
  /** Documentos que entram na conta (com gabarito e com mapeamento aplicável). */
  avaliados: number;
  porDesfecho: Record<Desfecho, number>;
  duvidosos: number;
  camposCertos: number;
  camposConferidos: number;
  /** (tipo certo + rejeitado corretamente) / avaliados. */
  taxaAcerto: number;
}

export function resumir(versao: MapeamentoSalvo['versao'], avaliacoes: AvaliacaoDocumento[]): ResumoVersao {
  const porDesfecho = Object.fromEntries(Object.keys(DESFECHOS).map(d => [d, 0])) as Record<Desfecho, number>;
  for (const a of avaliacoes) porDesfecho[a.desfecho]++;
  const avaliados = avaliacoes.filter(a => a.desfecho !== 'sem-mapeamento').length;
  const certos = porDesfecho.acerto + porDesfecho.rejeitado;
  const campos = avaliacoes.flatMap(a => a.campos);
  return {
    versao,
    avaliados,
    porDesfecho,
    duvidosos: avaliacoes.filter(a => a.duvidoso).length,
    camposCertos: campos.filter(c => c.certo).length,
    camposConferidos: campos.length,
    taxaAcerto: avaliados ? certos / avaliados : 0,
  };
}

/** Uma execução da bancada, guardada para comparar com a próxima. */
export interface ExecucaoBancada {
  id: string;
  dataHora: string;
  resumos: ResumoVersao[];
  /** documento (id) → versão → desfecho. */
  desfechos: Record<string, Partial<Record<MapeamentoSalvo['versao'], Desfecho>>>;
}

export interface Mudanca {
  documento: string;
  versao: MapeamentoSalvo['versao'];
  antes: Desfecho;
  depois: Desfecho;
  /** true = passou de errado para certo; false = piorou; null = trocou de erro ou saiu da conta. */
  melhorou: boolean | null;
}

/** O que mudou de uma execução para outra, documento a documento. */
export function compararExecucoes(anterior: ExecucaoBancada, atual: ExecucaoBancada): Mudanca[] {
  const mudancas: Mudanca[] = [];
  for (const [documento, porVersao] of Object.entries(atual.desfechos)) {
    for (const [v, depois] of Object.entries(porVersao) as Array<[string, Desfecho]>) {
      const versao = Number(v) as MapeamentoSalvo['versao'];
      const antes = anterior.desfechos[documento]?.[versao];
      if (!antes || antes === depois) continue;
      const [a, d] = [DESFECHOS[antes].certo, DESFECHOS[depois].certo];
      mudancas.push({ documento, versao, antes, depois, melhorou: a === false && d === true ? true : a === true && d === false ? false : null });
    }
  }
  return mudancas;
}

/** CSV com uma linha por documento e versão. */
export function exportarCsv(documentos: DocumentoBancada[], avaliacoes: Record<string, AvaliacaoDocumento[]>): string {
  const celula = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  const linhas = [['Documento', 'Tipo esperado', 'Versão', 'Desfecho', 'Tipo previsto', 'Confiança', 'Duvidoso', 'Campos certos'].map(celula).join(';')];
  for (const d of documentos) {
    for (const a of avaliacoes[d.id] ?? []) {
      linhas.push(
        [
          d.nome,
          d.gabarito.tipo === null ? 'outro tipo' : (d.gabarito.tipo ?? ''),
          `v${a.versao}`,
          DESFECHOS[a.desfecho].titulo,
          a.previsto ?? '',
          a.confianca === undefined ? '' : `${Math.round(a.confianca * 100)}%`,
          a.duvidoso ? 'sim' : '',
          a.campos.length ? `${a.campos.filter(c => c.certo).length}/${a.campos.length}` : '',
        ]
          .map(celula)
          .join(';'),
      );
    }
  }
  return linhas.join('\r\n');
}
