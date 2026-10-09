import { CampoMapeavel, PADROES } from '../pdf-mapeamento/pdf-mapeamento.model';
import { FormatoCampo, escaparRegex, formatoDoCampo, normalizarTexto, palavrasFinaisSemDigitos } from '../pdf-mapeamento/extrator';
import { TipoIdentificador, detectarIdentificador } from '../pdf-mapeamento/identificador';
import type { MapeamentoQualquer } from '../armazenamento/mapeamentos-db.service';
import { CelulaPlanilha, Planilha, ReferenciaCelula, celulaEm, celulasEntre, paraReferencia } from './planilha';

/**
 * Onde o rótulo fica em relação ao valor. Usa relações (célula ao lado, cabeçalho acima)
 * em vez de distância em colunas, que muda quando o tamanho dos valores muda.
 */
export interface RotuloV2 {
  texto: string;
  /** `celula`: rótulo dentro da própria célula ("CNPJ: 12.345..."); `esquerda`: N blocos à esquerda na linha; `acima`: cabeçalho N linhas acima. */
  posicao: 'celula' | 'esquerda' | 'acima';
  distancia: number;
}

/** Campo mapeado pela posição na planilha gerada a partir do PDF. */
export interface CampoMapeadoV2 {
  /** Primeira e última célula do conteúdo (iguais quando cabe numa célula só). */
  inicio: ReferenciaCelula;
  fim: ReferenciaCelula;
  /** Quantas células o conteúdo ocupou no exemplo. */
  celulas?: number;
  exemplo: string;
  /** Rótulo vizinho, usado para confirmar a posição e para achar o valor se o layout mudar. */
  rotulo?: RotuloV2;
  /** Só no campo `cnpj`: tipo do identificador. Ausente = CNPJ (mapeamentos antigos). */
  identificador?: TipoIdentificador;
}

export interface TermoV2 {
  texto: string;
  celula: ReferenciaCelula;
}

export interface MapeamentoPdfV2 {
  versao: 2;
  nome: string;
  cnpj: CampoMapeadoV2;
  competencia: CampoMapeadoV2;
  valor: CampoMapeadoV2;
  termos: TermoV2[];
  /** Nome do PDF usado como modelo. */
  arquivoExemplo?: string;
  /**
   * Divergências aceitas em "Concluir com Divergência". Só viaja do assistente até o app, que
   * as registra no histórico; não é gravado no mapeamento nem usado na extração.
   */
  divergencias?: string[];
}

/**
 * Campos e termos de um mapeamento salvo, para reabrir no assistente ("Mapear Documentos" de um
 * serviço já mapeado). A v1 não guarda posição na planilha e não pode ser reaberta assim.
 */
export function baseParaEditar(mapeamento: MapeamentoQualquer | null | undefined): MapeamentoPdfV2 | null {
  if (!mapeamento || !('versao' in mapeamento)) return null;
  const { nome, cnpj, competencia, valor, termos, arquivoExemplo } = mapeamento;
  return { versao: 2, nome, cnpj, competencia, valor, termos, arquivoExemplo };
}

export interface ResultadoV2 {
  valor: string;
  celulas: CelulaPlanilha[];
  /**
   * Como foi encontrado: `posicao` (linha/coluna ou posição na linha), `rotulo` (a partir do rótulo),
   * `vizinhanca` (linha próxima) ou `unico` (único valor desse formato no documento).
   */
  origem: 'posicao' | 'rotulo' | 'vizinhanca' | 'unico';
}

/** Até quantas linhas acima/abaixo procurar quando a posição exata não tem o valor. */
const LINHAS_VIZINHAS = 3;
/** Células a mais que podem ser lidas quando o valor quebrou em outra linha. */
const CELULAS_EXTRAS = 2;
/** Quantos blocos à direita do rótulo verificar. */
const BLOCOS_A_DIREITA = 4;

/**
 * @param identificador só no campo `cnpj`: tipo escolhido pelo usuário. Sem ele, o tipo é
 * detectado pelo formato (CNPJ, CPF, CAEPF ou CNO; IE e IM precisam ser escolhidos).
 */
export function construirCampoV2(
  planilha: Planilha,
  tipo: CampoMapeavel,
  inicioId: number,
  fimId: number,
  identificador?: TipoIdentificador,
): { campo?: CampoMapeadoV2; erro?: string; celulas?: CelulaPlanilha[]; celulaRotulo?: CelulaPlanilha } {
  const celulas = celulasEntre(planilha, inicioId, fimId);
  const texto = normalizarTexto(celulas.map(c => c.texto).join(' '));
  const tipoIdentificador = tipo === 'cnpj' ? (identificador ?? detectarIdentificador(texto)) : undefined;
  if (tipo === 'cnpj' && !tipoIdentificador) {
    return { erro: 'Não reconheci CNPJ, CPF, CAEPF ou CNO nas células selecionadas. Para IE ou IM, escolha o tipo.' };
  }
  const formato = formatoDoCampo(tipo, tipoIdentificador ?? undefined);
  const m = formato.regex.exec(texto);
  if (!m) return { erro: 'As células selecionadas não contêm um valor neste formato.' };

  const primeira = celulas[0];
  const ultima = celulas[celulas.length - 1];
  const campo: CampoMapeadoV2 = {
    inicio: paraReferencia(primeira),
    fim: paraReferencia(ultima),
    celulas: celulas.length,
    exemplo: formato.padronizar(m),
    ...(tipoIdentificador ? { identificador: tipoIdentificador } : {}),
  };

  // Rótulo dentro da própria célula, à esquerda na linha, ou cabeçalho acima.
  const rotuloInterno = palavrasFinaisSemDigitos(texto.slice(0, m.index)).join(' ');
  let celulaRotulo: CelulaPlanilha | undefined;
  if (rotuloInterno) {
    campo.rotulo = { texto: rotuloInterno, posicao: 'celula', distancia: 0 };
    celulaRotulo = primeira;
  } else {
    celulaRotulo = rotuloVizinho(planilha, primeira);
    if (celulaRotulo) {
      const naLinha = celulaRotulo.linha === primeira.linha;
      campo.rotulo = {
        texto: normalizarTexto(celulaRotulo.texto),
        posicao: naLinha ? 'esquerda' : 'acima',
        distancia: naLinha ? primeira.ordem - celulaRotulo.ordem : primeira.linha - celulaRotulo.linha,
      };
    }
  }
  return { campo, celulas, celulaRotulo };
}

/**
 * Texto fixo que pode servir de rótulo: predominam letras (aceita numeração como "03 NÚMERO DO CNPJ")
 * e não contém nenhum valor de CNPJ, competência ou moeda.
 */
export function ehRotulo(c?: CelulaPlanilha): boolean {
  if (!c) return false;
  const texto = normalizarTexto(c.texto);
  const letras = texto.replace(/[^a-z]/g, '').length;
  const digitos = texto.replace(/\D/g, '').length;
  return letras >= 3 && letras > digitos * 2 && !Object.values(PADROES).some(p => p.test(texto));
}

const sobrepoe = (a: CelulaPlanilha, b: CelulaPlanilha) =>
  a.caixa.x < b.caixa.x + b.caixa.largura && b.caixa.x < a.caixa.x + a.caixa.largura;

/**
 * Célula só com texto (sem dígitos) imediatamente à esquerda; senão, o cabeçalho logo acima
 * (que se sobrepõe na horizontal, pois números alinhados à direita podem não começar junto).
 */
function rotuloVizinho(planilha: Planilha, celula: CelulaPlanilha): CelulaPlanilha | undefined {
  const esquerda = planilha.celulas[celula.id - 1];
  if (esquerda?.pagina === celula.pagina && esquerda.linha === celula.linha && ehRotulo(esquerda)) return esquerda;
  for (let id = celula.id - 1; id >= 0; id--) {
    const c = planilha.celulas[id];
    if (c.pagina !== celula.pagina || celula.linha - c.linha > LINHAS_VIZINHAS) break;
    if (c.linha < celula.linha && sobrepoe(c, celula)) return ehRotulo(c) ? c : undefined;
  }
  return undefined;
}

/** Aplica o mapeamento na planilha de outro PDF. */
export function extrairCampoV2(planilha: Planilha, tipo: CampoMapeavel, campo: CampoMapeadoV2): ResultadoV2 | null {
  const rotulo = normalizarRotulo(campo.rotulo);
  const maximo = (campo.celulas ?? campo.fim.linha - campo.inicio.linha + 1) + CELULAS_EXTRAS;
  const formato = formatoDoCampo(tipo, campo.identificador);
  const ler = (c: CelulaPlanilha | undefined) => (c ? lerAPartir(planilha, formato, c, maximo) : null);

  // Mesma linha: pela coluna e, se não bater, pela posição do bloco na linha.
  const naPosicao = [celulaEm(planilha, campo.inicio), celulaNaOrdem(planilha, campo.inicio)].filter(
    (c, i, lista): c is CelulaPlanilha => !!c && lista.indexOf(c) === i,
  );

  // 1. Posição mapeada, confirmada pelo rótulo ao redor.
  for (const c of naPosicao) {
    const r = !rotulo || rotuloPerto(planilha, c, rotulo) ? ler(c) : null;
    if (r) return { ...r, origem: 'posicao' };
  }

  // 2. A partir do rótulo (o layout mudou: linhas a mais, blocos maiores, etc.).
  if (rotulo) {
    for (const celulaRotulo of procurarRotulo(planilha, campo, rotulo)) {
      for (const c of candidatosDoRotulo(planilha, celulaRotulo, rotulo)) {
        const r = ler(c);
        if (r) return { ...r, origem: 'rotulo' };
      }
    }
  }

  // 3. Posição mapeada sem confirmação.
  for (const c of naPosicao) {
    const r = ler(c);
    if (r) return { ...r, origem: 'posicao' };
  }

  // 4. Linhas vizinhas, mesma coluna ou mesma posição na linha.
  for (let d = 1; d <= LINHAS_VIZINHAS; d++) {
    for (const delta of [d, -d]) {
      const ref = { ...campo.inicio, linha: campo.inicio.linha + delta };
      for (const c of [celulaEm(planilha, ref), celulaNaOrdem(planilha, ref)]) {
        const r = ler(c);
        if (r) return { ...r, origem: 'vizinhanca' };
      }
    }
  }

  // 5. Único valor desse formato no documento.
  const encontrados = planilha.celulas.map(c => ler(c)).filter((r): r is NonNullable<typeof r> => !!r);
  if (encontrados.length && encontrados.every(r => r.valor === encontrados[0].valor)) {
    return { ...encontrados[0], origem: 'unico' };
  }
  return null;
}

/**
 * Lê o valor começando numa célula. Se não fechar o formato (ex.: CNPJ quebrado em mais
 * uma linha), junta as células seguintes na ordem de leitura. O valor precisa começar na
 * célula inicial, para não "pegar emprestado" o valor de outra célula.
 */
function lerAPartir(
  planilha: Planilha,
  formato: FormatoCampo,
  inicio: CelulaPlanilha,
  maximo: number,
): Omit<ResultadoV2, 'origem'> | null {
  const limite = normalizarTexto(inicio.texto).length;
  for (let n = 1; n <= maximo; n++) {
    const ultima = planilha.celulas[inicio.id + n - 1];
    if (!ultima || ultima.pagina !== inicio.pagina) break;
    const celulas = celulasEntre(planilha, inicio.id, ultima.id);
    const m = formato.regex.exec(normalizarTexto(celulas.map(c => c.texto).join(' ')));
    if (m) return m.index < limite ? { valor: formato.padronizar(m), celulas } : null;
  }
  return null;
}

function celulaNaOrdem(planilha: Planilha, ref: ReferenciaCelula): CelulaPlanilha | undefined {
  if (!ref.ordem) return undefined;
  return planilha.celulas.find(c => c.pagina === ref.pagina && c.linha === ref.linha && c.ordem === ref.ordem);
}

/** O rótulo está na própria célula, à esquerda na mesma linha ou acima (até a distância mapeada + 1). */
function rotuloPerto(planilha: Planilha, celula: CelulaPlanilha, rotulo: RotuloV2): boolean {
  const regex = regexFlexivel(rotulo.texto);
  if (rotulo.posicao === 'celula') return regex.test(normalizarTexto(celula.texto));
  return planilha.celulas.some(
    c =>
      c.pagina === celula.pagina &&
      regex.test(normalizarTexto(c.texto)) &&
      (rotulo.posicao === 'esquerda'
        ? c.linha === celula.linha && c.ordem < celula.ordem
        : c.linha < celula.linha && celula.linha - c.linha <= rotulo.distancia + 1 && sobrepoe(c, celula)),
  );
}

/** Células onde procurar o valor a partir de um rótulo encontrado, da mais provável para a menos. */
function candidatosDoRotulo(planilha: Planilha, celulaRotulo: CelulaPlanilha, rotulo: RotuloV2): CelulaPlanilha[] {
  if (rotulo.posicao === 'celula') return [celulaRotulo];
  const mesmaPagina = planilha.celulas.filter(c => c.pagina === celulaRotulo.pagina);

  if (rotulo.posicao === 'esquerda') {
    const esperado = celulaRotulo.ordem + rotulo.distancia;
    return mesmaPagina
      .filter(c => c.linha === celulaRotulo.linha && c.ordem > celulaRotulo.ordem && c.ordem - celulaRotulo.ordem <= BLOCOS_A_DIREITA)
      .sort((a, b) => Math.abs(a.ordem - esperado) - Math.abs(b.ordem - esperado));
  }

  // Acima: linhas abaixo do cabeçalho, começando pela distância mapeada; na linha, quem mais se sobrepõe.
  const linhas = Array.from({ length: LINHAS_VIZINHAS + rotulo.distancia }, (_, i) => i + 1).sort(
    (a, b) => Math.abs(a - rotulo.distancia) - Math.abs(b - rotulo.distancia),
  );
  const sobreposicao = (c: CelulaPlanilha) =>
    Math.min(c.caixa.x + c.caixa.largura, celulaRotulo.caixa.x + celulaRotulo.caixa.largura) -
    Math.max(c.caixa.x, celulaRotulo.caixa.x);
  return linhas.flatMap(d =>
    mesmaPagina
      .filter(c => c.linha === celulaRotulo.linha + d && sobrepoe(c, celulaRotulo))
      .sort((a, b) => sobreposicao(b) - sobreposicao(a)),
  );
}

/** Células que contêm o texto do rótulo, da mais próxima da posição original para a mais distante. */
function procurarRotulo(planilha: Planilha, campo: CampoMapeadoV2, rotulo: RotuloV2): CelulaPlanilha[] {
  const regex = regexFlexivel(rotulo.texto);
  const distancia = (c: CelulaPlanilha) => Math.abs(c.pagina - campo.inicio.pagina) * 10000 + Math.abs(c.linha - campo.inicio.linha);
  return planilha.celulas.filter(c => regex.test(normalizarTexto(c.texto))).sort((a, b) => distancia(a) - distancia(b));
}

/** Aceita mapeamentos salvos no formato antigo ({ texto, linhas, colunas }). */
function normalizarRotulo(rotulo: CampoMapeadoV2['rotulo'] | { texto: string; linhas: number; colunas: number }): RotuloV2 | undefined {
  if (!rotulo) return undefined;
  if ('posicao' in rotulo) return rotulo;
  if (!rotulo.linhas && !rotulo.colunas) return { texto: rotulo.texto, posicao: 'celula', distancia: 0 };
  if (!rotulo.linhas) return { texto: rotulo.texto, posicao: 'esquerda', distancia: 1 };
  return { texto: rotulo.texto, posicao: 'acima', distancia: rotulo.linhas };
}

// ---- Termos ----

export function termoPresente(planilha: Planilha, texto: string): boolean {
  const regex = regexFlexivel(texto);
  return regex.test(normalizarTexto(planilha.celulas.map(c => c.texto).join(' ')));
}

/** Termo continua na célula mapeada (mesma linha, e mesma coluna ou posição na linha). */
export function termoNaPosicao(planilha: Planilha, termo: TermoV2): boolean {
  const regex = regexFlexivel(termo.texto);
  return [celulaEm(planilha, termo.celula), celulaNaOrdem(planilha, termo.celula)].some(
    c => !!c && regex.test(normalizarTexto(c.texto)),
  );
}

/** O PDF é deste tipo quando contém todos os termos (em qualquer posição). */
export function documentoCorrespondeV2(planilha: Planilha, termos: TermoV2[]): boolean {
  return termos.length > 0 && termos.every(t => termoPresente(planilha, t.texto));
}

/** Ignora maiúsculas, acentos e espaços/quebras entre os caracteres. */
export function regexFlexivel(texto: string): RegExp {
  const caracteres = [...normalizarTexto(texto).replace(/\s+/g, '')];
  return new RegExp(caracteres.map(escaparRegex).join('\\s*'));
}
