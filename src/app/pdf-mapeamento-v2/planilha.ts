import { Faixa, TokenPdf } from '../pdf-mapeamento/pdf-mapeamento.model';
import type { DimensaoPagina } from '../pdf-mapeamento/pdf-documento.service';

/**
 * PDF convertido em planilha: uma aba por página, uma linha por linha visual do texto
 * e uma célula por bloco (palavras próximas). Colunas agrupam blocos alinhados entre as
 * linhas pela borda esquerda, direita ou pelo centro (o alinhamento mais repetido vence),
 * para que valores alinhados à direita continuem na mesma coluna mesmo mudando de largura.
 */
export interface Planilha {
  /** Em ordem de leitura: página, linha, coluna. O índice no array é o `id`. */
  celulas: CelulaPlanilha[];
  abas: AbaPlanilha[];
  /** Célula de cada token do PDF (índice do token → id da célula). */
  celulaDoToken: number[];
}

export interface AbaPlanilha {
  pagina: number;
  linhas: number;
  colunas: number;
  /** Tamanho da página em pontos; as caixas das células são frações dele. */
  largura: number;
  altura: number;
}

export interface CelulaPlanilha {
  id: number;
  pagina: number;
  /** 1 = primeira linha da página. */
  linha: number;
  /** 0 = coluna A. */
  coluna: number;
  /** Posição do bloco na linha (1 = primeiro da esquerda). Não depende do alinhamento das colunas. */
  ordem: number;
  texto: string;
  tokens: Faixa;
  /** Área da célula na página (0..1), usada só para desenhar o preview. */
  caixa: { x: number; y: number; largura: number; altura: number };
}

export interface ReferenciaCelula {
  pagina: number;
  linha: number;
  coluna: number;
  /** Posição do bloco na linha; usada quando a coluna não bate. */
  ordem?: number;
}

/** Espaço entre palavras do mesmo trecho do PDF (em "alturas de fonte") a partir do qual começa outra célula. */
const ESPACO_NOVA_CELULA = 0.6;
/**
 * Entre trechos diferentes (desenhados separadamente no PDF, ex.: rótulo e valor) o limite é menor;
 * sobreposição (valor largo invadindo o rótulo) também separa.
 */
const ESPACO_ENTRE_TRECHOS = 0.4;
const SOBREPOSICAO_ENTRE_TRECHOS = -0.1;
/** Diferença máxima entre bordas (fração da largura da página) para blocos ficarem na mesma coluna. */
const TOLERANCIA_COLUNA = 0.012;

export function converterParaPlanilha(tokens: TokenPdf[], dimensoes: DimensaoPagina[]): Planilha {
  const celulas: CelulaPlanilha[] = [];
  const abas: AbaPlanilha[] = [];
  const celulaDoToken: number[] = new Array(tokens.length);

  dimensoes.forEach((dimensao, i) => {
    const pagina = i + 1;
    const linhas = agruparLinhas(tokens.filter(t => t.pagina === pagina));
    const blocos = linhas.map(linha => separarBlocos(linha, dimensao));
    const colunas = atribuirColunas(blocos.map(linha => linha.map(uniao)));

    blocos.forEach((blocosDaLinha, l) => {
      for (const [o, bloco] of blocosDaLinha.entries()) {
        const celula: CelulaPlanilha = {
          id: celulas.length,
          pagina,
          linha: l + 1,
          coluna: colunas[l][o],
          ordem: o + 1,
          texto: bloco.map(t => t.texto).join(' '),
          tokens: { inicio: bloco[0].indice, fim: bloco[bloco.length - 1].indice },
          caixa: uniao(bloco),
        };
        celulas.push(celula);
        for (const t of bloco) celulaDoToken[t.indice] = celula.id;
      }
    });
    abas.push({
      pagina,
      linhas: linhas.length,
      colunas: Math.max(0, ...celulas.filter(c => c.pagina === pagina).map(c => c.coluna + 1)),
      largura: dimensao.largura,
      altura: dimensao.altura,
    });
  });

  return { celulas, abas, celulaDoToken };
}

/** Agrupa tokens da página em linhas pela altura (centro vertical) e ordena cada linha da esquerda para a direita. */
function agruparLinhas(tokens: TokenPdf[]): TokenPdf[][] {
  const centro = (t: TokenPdf) => t.caixa.y + t.caixa.altura / 2;
  const ordenados = [...tokens].sort((a, b) => centro(a) - centro(b));
  const linhas: TokenPdf[][] = [];
  let referencia = -Infinity;
  for (const token of ordenados) {
    const atual = linhas[linhas.length - 1];
    if (atual && Math.abs(centro(token) - referencia) <= token.caixa.altura / 2) {
      atual.push(token);
    } else {
      linhas.push([token]);
      referencia = centro(token);
    }
  }
  // Da esquerda para a direita, mantendo juntas (e em ordem) as palavras de um mesmo trecho,
  // mesmo que um trecho vizinho se sobreponha a ele.
  return linhas.map(linha => {
    const inicioDoTrecho = new Map<number | undefined, number>();
    for (const t of linha) inicioDoTrecho.set(t.trecho, Math.min(inicioDoTrecho.get(t.trecho) ?? Infinity, t.caixa.x));
    const chave = (t: TokenPdf) => (t.trecho === undefined ? t.caixa.x : inicioDoTrecho.get(t.trecho)!);
    return linha.sort((a, b) => chave(a) - chave(b) || a.caixa.x - b.caixa.x);
  });
}

/** Quebra uma linha em blocos onde o espaço entre palavras é bem maior que um espaço comum. */
function separarBlocos(linha: TokenPdf[], dimensao: DimensaoPagina): TokenPdf[][] {
  const blocos: TokenPdf[][] = [];
  for (const token of linha) {
    const bloco = blocos[blocos.length - 1];
    const anterior = bloco?.[bloco.length - 1];
    if (anterior) {
      const espaco = (token.caixa.x - (anterior.caixa.x + anterior.caixa.largura)) * dimensao.largura;
      const alturaFonte = (Math.max(token.caixa.altura, anterior.caixa.altura) * dimensao.altura) / 1.15;
      const mesmoTrecho = token.trecho === anterior.trecho;
      const junta = mesmoTrecho
        ? espaco <= alturaFonte * ESPACO_NOVA_CELULA
        : espaco <= alturaFonte * ESPACO_ENTRE_TRECHOS && espaco >= alturaFonte * SOBREPOSICAO_ENTRE_TRECHOS;
      if (junta) {
        bloco.push(token);
        continue;
      }
    }
    blocos.push([token]);
  }
  return blocos;
}

type Alinhamento = 'esquerda' | 'direita' | 'centro';

/**
 * Coluna de cada bloco (por linha). Cada bloco entra no grupo de alinhamento com mais
 * blocos na página (borda esquerda, direita ou centro parecidas); grupos viram colunas
 * ordenadas da esquerda para a direita. Em cada linha as colunas são sempre crescentes.
 */
export function atribuirColunas(linhas: Array<Array<CelulaPlanilha['caixa']>>): number[][] {
  const bordas: Record<Alinhamento, (c: CelulaPlanilha['caixa']) => number> = {
    esquerda: c => c.x,
    direita: c => c.x + c.largura,
    centro: c => c.x + c.largura / 2,
  };
  const todas = linhas.flat();
  const agrupamentos = (Object.keys(bordas) as Alinhamento[]).map(alinhamento => ({
    alinhamento,
    grupo: agrupar(todas.map(bordas[alinhamento])),
  }));

  // Escolhe, para cada bloco, o alinhamento com mais apoio (empate: esquerda, direita, centro).
  const chaves = linhas.map(linha =>
    linha.map(caixa => {
      let melhor = { chave: '', apoio: -1 };
      for (const { alinhamento, grupo } of agrupamentos) {
        const indice = grupo.indice(bordas[alinhamento](caixa));
        const apoio = grupo.tamanho[indice];
        if (apoio > melhor.apoio) melhor = { chave: `${alinhamento}:${indice}`, apoio };
      }
      return melhor.chave;
    }),
  );

  // Ordena os grupos pela borda esquerda mais à esquerda de seus blocos.
  const posicao = new Map<string, number>();
  linhas.forEach((linha, l) =>
    linha.forEach((caixa, o) => {
      const chave = chaves[l][o];
      posicao.set(chave, Math.min(posicao.get(chave) ?? Infinity, caixa.x));
    }),
  );
  const ordem = [...posicao.keys()].sort((a, b) => posicao.get(a)! - posicao.get(b)!);
  const coluna = new Map(ordem.map((chave, i) => [chave, i]));

  return chaves.map(linha => {
    let anterior = -1;
    return linha.map(chave => (anterior = Math.max(coluna.get(chave)!, anterior + 1)));
  });
}

/** Agrupa valores próximos (dentro da tolerância) e informa o grupo de cada valor e o tamanho dos grupos. */
function agrupar(valores: number[]): { indice: (v: number) => number; tamanho: number[] } {
  const inicios: number[] = [];
  const tamanho: number[] = [];
  for (const v of [...valores].sort((a, b) => a - b)) {
    if (!inicios.length || v - inicios[inicios.length - 1] > TOLERANCIA_COLUNA) {
      inicios.push(v);
      tamanho.push(0);
    }
    tamanho[tamanho.length - 1]++;
  }
  const indice = (v: number) => {
    let i = 0;
    while (i + 1 < inicios.length && inicios[i + 1] <= v + 1e-9) i++;
    return i;
  };
  return { indice, tamanho };
}

function uniao(tokens: TokenPdf[]): CelulaPlanilha['caixa'] {
  const x = Math.min(...tokens.map(t => t.caixa.x));
  const y = Math.min(...tokens.map(t => t.caixa.y));
  const direita = Math.max(...tokens.map(t => t.caixa.x + t.caixa.largura));
  const baixo = Math.max(...tokens.map(t => t.caixa.y + t.caixa.altura));
  return { x, y, largura: direita - x, altura: baixo - y };
}

// ---- Referências ----

export function nomeColuna(coluna: number): string {
  let nome = '';
  for (let n = coluna + 1; n > 0; n = Math.floor((n - 1) / 26)) nome = String.fromCharCode(65 + ((n - 1) % 26)) + nome;
  return nome;
}

export function referencia(c: ReferenciaCelula): string {
  return `${nomeColuna(c.coluna)}${c.linha}`;
}

/** Ex.: "Pág.1!C5" ou "Pág.1!C5:A6". */
export function descreverIntervalo(inicio: ReferenciaCelula, fim: ReferenciaCelula): string {
  const base = `Pág.${inicio.pagina}!${referencia(inicio)}`;
  if (inicio.pagina === fim.pagina && inicio.linha === fim.linha && inicio.coluna === fim.coluna) return base;
  return `${base}:${fim.pagina !== inicio.pagina ? `Pág.${fim.pagina}!` : ''}${referencia(fim)}`;
}

export function paraReferencia(c: CelulaPlanilha): ReferenciaCelula {
  return { pagina: c.pagina, linha: c.linha, coluna: c.coluna, ordem: c.ordem };
}

export function celulaEm(planilha: Planilha, ref: ReferenciaCelula): CelulaPlanilha | undefined {
  return planilha.celulas.find(c => c.pagina === ref.pagina && c.linha === ref.linha && c.coluna === ref.coluna);
}

/** Células entre duas, em ordem de leitura (como uma seleção de texto). */
export function celulasEntre(planilha: Planilha, a: number, b: number): CelulaPlanilha[] {
  return planilha.celulas.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/** Matriz [linha][coluna] da aba, para exibir ou exportar. */
export function grade(planilha: Planilha, pagina: number): Array<Array<CelulaPlanilha | null>> {
  const aba = planilha.abas[pagina - 1];
  const matriz = Array.from({ length: aba.linhas }, () => new Array<CelulaPlanilha | null>(aba.colunas).fill(null));
  for (const c of planilha.celulas) if (c.pagina === pagina) matriz[c.linha - 1][c.coluna] = c;
  return matriz;
}

export function exportarCsv(planilha: Planilha, pagina: number): string {
  return grade(planilha, pagina)
    .map(linha => linha.map(c => `"${(c?.texto ?? '').replace(/"/g, '""')}"`).join(';'))
    .join('\r\n');
}
