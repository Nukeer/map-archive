import { IDENTIFICADORES, cnpjValido, cpfValido, detectarIdentificador } from './identificador';
import { normalizarTexto } from './extrator';

const detectar = (texto: string) => detectarIdentificador(normalizarTexto(texto));
const padronizar = (tipo: keyof typeof IDENTIFICADORES, texto: string) => {
  const m = IDENTIFICADORES[tipo].regex.exec(normalizarTexto(texto));
  return m && IDENTIFICADORES[tipo].padronizar(m[0]);
};

describe('identificadores', () => {
  it('detecta o tipo pela máscara', () => {
    expect(detectar('CNPJ: 11.222.333/0001-81')).toBe('cnpj');
    expect(detectar('CPF 529.982.247-25')).toBe('cpf');
    expect(detectar('CAEPF 529.982.247/001-90')).toBe('caepf');
    expect(detectar('CNO 51.234.56789/01')).toBe('cno');
    expect(detectar('Inscrição Estadual 110.042.490.114')).toBeNull();
  });

  it('sem máscara, usa o dígito verificador', () => {
    expect(detectar('11222333000181')).toBe('cnpj');
    expect(detectar('52998224725')).toBe('cpf');
  });

  it('aceita CNPJ alfanumérico (a partir de julho/2026)', () => {
    expect(detectar('CNPJ 12.ABC.345/01DE-35')).toBe('cnpj');
    expect(padronizar('cnpj', '12.abc.345/01de-35')).toBe('12.ABC.345/01DE-35');
    expect(cnpjValido('12.ABC.345/01DE-35')).toBeTrue();
    expect(cnpjValido('12.ABC.345/01DE-36')).toBeFalse();
  });

  it('valida dígitos verificadores de CNPJ e CPF', () => {
    expect(cnpjValido('11.222.333/0001-81')).toBeTrue();
    expect(cnpjValido('11.111.111/1111-11')).toBeFalse();
    expect(cpfValido('529.982.247-25')).toBeTrue();
    expect(cpfValido('529.982.247-24')).toBeFalse();
    expect(cpfValido('111.111.111-11')).toBeFalse();
  });

  it('padroniza com a máscara de cada tipo', () => {
    expect(padronizar('cpf', '52998224725')).toBe('529.982.247-25');
    expect(padronizar('caepf', '52998224700190')).toBe('529.982.247/001-90');
    expect(padronizar('cno', '512345678901')).toBe('51.234.56789/01');
    expect(padronizar('ie', 'IE: 110.042.490.114')).toBe('110.042.490.114');
  });

  it('IE e IM não confundem datas', () => {
    expect(padronizar('ie', 'Vencimento 20/10/2026')).toBeNull();
    expect(padronizar('im', 'Emissão 01/09/2026 IM 1234567')).toBe('1234567');
  });

  it('não confunde CPF dentro de CNPJ nem de CAEPF', () => {
    expect(IDENTIFICADORES.cpf.regex.exec('11.222.333/0001-81')).toBeNull();
    expect(IDENTIFICADORES.cpf.regex.exec('529.982.247/001-90')).toBeNull();
  });
});
