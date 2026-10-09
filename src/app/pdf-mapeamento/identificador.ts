/**
 * Identificadores do contribuinte aceitos no campo "identificador" do mapeamento. As regex rodam
 * sobre texto normalizado (minúsculo, sem acento), como as de `PADROES`.
 */
export type TipoIdentificador = 'cnpj' | 'cpf' | 'caepf' | 'cno' | 'ie' | 'im';

export interface FormatoIdentificador {
  tipo: TipoIdentificador;
  nome: string;
  mascara: string;
  regex: RegExp;
  padronizar(bruto: string): string;
  /** Dígito verificador quando a regra é pública e única; senão, só a quantidade de dígitos. */
  validar(valor: string): boolean;
  /**
   * Reconhecido sozinho pelo formato. IE e IM não: variam por estado e por município e se
   * confundem com qualquer número, então o usuário escolhe o tipo e a posição/rótulo fazem o resto.
   */
  automatico: boolean;
}

const digitos = (texto: string) => texto.replace(/\D/g, '');
const repetido = (texto: string) => /^(.)\1+$/.test(texto);
const mascarar = (valor: string, partes: number[], separadores: string[]) => {
  let i = 0;
  return partes.map((n, p) => valor.slice(i, (i += n)) + (separadores[p] ?? '')).join('');
};
/** Não começa no meio de uma data (dd/mm/aaaa), comum perto de IE/IM. */
const SEM_DATA = String.raw`(?!\d{1,2}\/\d{1,2}\/\d{2,4}(?!\d))`;

/** Módulo 11 com pesos 2..9 da direita para a esquerda; cada caractere vale `código - 48` (CNPJ alfanumérico). */
function dvModulo11(base: string): number {
  let soma = 0;
  for (let i = base.length - 1, peso = 2; i >= 0; i--, peso = peso === 9 ? 2 : peso + 1) soma += (base.charCodeAt(i) - 48) * peso;
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

/** CNPJ numérico ou alfanumérico (a partir de julho/2026): 12 caracteres [0-9A-Z] + 2 dígitos verificadores. */
export function cnpjValido(cnpj: string): boolean {
  const c = cnpj.toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (!/^[0-9A-Z]{12}\d{2}$/.test(c) || repetido(c)) return false;
  return dvModulo11(c.slice(0, 12)) === Number(c[12]) && dvModulo11(c.slice(0, 13)) === Number(c[13]);
}

export function cpfValido(cpf: string): boolean {
  const d = digitos(cpf);
  if (d.length !== 11 || repetido(d)) return false;
  const dv = (base: string) => {
    const soma = [...base].reduce((t, n, i) => t + Number(n) * (base.length + 1 - i), 0);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  return dv(d.slice(0, 9)) === Number(d[9]) && dv(d.slice(0, 10)) === Number(d[10]);
}

const faixaDeDigitos = (minimo: number, maximo: number) => (valor: string) => {
  const d = digitos(valor);
  return d.length >= minimo && d.length <= maximo && !repetido(d);
};

export const IDENTIFICADORES: Record<TipoIdentificador, FormatoIdentificador> = {
  cnpj: {
    tipo: 'cnpj',
    nome: 'CNPJ',
    mascara: '00.000.000/0000-00',
    regex: /(?<!\d)\d{2}\s*\.?\s*\d{3}\s*\.?\s*\d{3}\s*\/?\s*\d{4}\s*-?\s*\d{2}(?!\d)|(?<![0-9a-z])[0-9a-z]{2}\.[0-9a-z]{3}\.[0-9a-z]{3}\/[0-9a-z]{4}-\d{2}(?![0-9a-z])/,
    padronizar: bruto => mascarar(bruto.toUpperCase().replace(/[^0-9A-Z]/g, ''), [2, 3, 3, 4, 2], ['.', '.', '/', '-']),
    validar: cnpjValido,
    automatico: true,
  },
  cpf: {
    tipo: 'cpf',
    nome: 'CPF',
    mascara: '000.000.000-00',
    regex: /(?<![\d.\/])\d{3}\s*\.?\s*\d{3}\s*\.?\s*\d{3}\s*-?\s*\d{2}(?!\d)/,
    padronizar: bruto => mascarar(digitos(bruto), [3, 3, 3, 2], ['.', '.', '-']),
    validar: cpfValido,
    automatico: true,
  },
  caepf: {
    tipo: 'caepf',
    nome: 'CAEPF',
    mascara: '000.000.000/000-00',
    regex: /(?<![\d.\/])\d{3}\s*\.?\s*\d{3}\s*\.?\s*\d{3}\s*\/?\s*\d{3}\s*-?\s*\d{2}(?!\d)/,
    padronizar: bruto => mascarar(digitos(bruto), [3, 3, 3, 3, 2], ['.', '.', '/', '-']),
    validar: faixaDeDigitos(14, 14),
    automatico: true,
  },
  cno: {
    tipo: 'cno',
    nome: 'CNO',
    mascara: '00.000.00000/00',
    regex: /(?<![\d.\/])\d{2}\s*\.?\s*\d{3}\s*\.?\s*\d{5}\s*\/?\s*\d{2}(?!\d)/,
    padronizar: bruto => mascarar(digitos(bruto), [2, 3, 5, 2], ['.', '.', '/']),
    validar: faixaDeDigitos(12, 12),
    automatico: true,
  },
  ie: {
    tipo: 'ie',
    nome: 'Inscrição Estadual',
    mascara: '8 a 14 dígitos',
    regex: new RegExp(String.raw`(?<![\d.\/-])${SEM_DATA}\d(?:[.\/-]?\d){7,13}(?!\d)`),
    padronizar: bruto => bruto.replace(/\s/g, ''),
    validar: faixaDeDigitos(8, 14),
    automatico: false,
  },
  im: {
    tipo: 'im',
    nome: 'Inscrição Municipal',
    mascara: '3 a 15 dígitos',
    regex: new RegExp(String.raw`(?<![\d.\/-])${SEM_DATA}\d(?:[.\/-]?\d){2,14}(?!\d)`),
    padronizar: bruto => bruto.replace(/\s/g, ''),
    validar: faixaDeDigitos(3, 15),
    automatico: false,
  },
};

export const TIPOS_IDENTIFICADOR = Object.keys(IDENTIFICADORES) as TipoIdentificador[];

/** "CNPJ", "CPF"...; mapeamentos antigos (sem tipo) são CNPJ. */
export const nomeIdentificador = (tipo: TipoIdentificador = 'cnpj') => IDENTIFICADORES[tipo].nome;

/**
 * Tipo do identificador no texto (normalizado) selecionado. Prefere o que está escrito com a
 * máscara do tipo (14 dígitos podem ser CNPJ ou CAEPF); sem máscara, o que tiver DV válido.
 * IE e IM nunca são detectados.
 */
export function detectarIdentificador(texto: string): TipoIdentificador | null {
  const candidatos = TIPOS_IDENTIFICADOR.filter(t => IDENTIFICADORES[t].automatico)
    .map(tipo => ({ formato: IDENTIFICADORES[tipo], m: IDENTIFICADORES[tipo].regex.exec(texto) }))
    .filter((c): c is { formato: FormatoIdentificador; m: RegExpExecArray } => !!c.m);
  const comMascara = candidatos.find(c => c.m[0].replace(/\s/g, '').toUpperCase() === c.formato.padronizar(c.m[0]));
  const valido = candidatos.find(c => c.formato.validar(c.formato.padronizar(c.m[0])));
  return (comMascara ?? valido ?? candidatos[0])?.formato.tipo ?? null;
}
