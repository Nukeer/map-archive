import { construirCampo, criarDocumentoTexto, documentoCorresponde, extrairCampo, DocumentoTexto } from './extrator';
import { Faixa, TokenPdf } from './pdf-mapeamento.model';

/** Monta um documento a partir de linhas de texto (uma página). */
function documento(...linhas: string[]): DocumentoTexto {
  const tokens: TokenPdf[] = [];
  linhas.forEach((linha, l) =>
    linha
      .split(' ')
      .filter(Boolean)
      .forEach(texto =>
        tokens.push({ indice: tokens.length, pagina: 1, linha: l, texto, caixa: { x: 0, y: 0, largura: 0, altura: 0 } }),
      ),
  );
  return criarDocumentoTexto(tokens);
}

/** Faixa de tokens do trecho (texto original) informado. */
function faixa(doc: DocumentoTexto, trecho: string): Faixa {
  const partes = trecho.split(' ');
  const inicio = doc.tokens.findIndex((_, i) => partes.every((p, j) => doc.tokens[i + j]?.texto === p));
  expect(inicio).withContext(trecho).toBeGreaterThanOrEqual(0);
  return { inicio, fim: inicio + partes.length - 1 };
}

describe('extrator', () => {
  const exemplo = documento(
    'RECEITA FEDERAL',
    'DOCUMENTO DE ARRECADAÇÃO DE RECEITAS FEDERAIS',
    'Contribuinte CNPJ: 12.345.678/0001-90',
    'Período de apuração: 09/2026',
    'Principal Multa Juros Total',
    '1.000,00 100,00 34,56 1.134,56',
  );

  it('sugere o menor texto único antes do valor como rótulo', () => {
    const { campo } = construirCampo(exemplo, 'cnpj', faixa(exemplo, '12.345.678/0001-90'));
    expect(campo).toEqual({ rotulo: 'cnpj:', ocorrenciaRotulo: 1, indiceAposRotulo: 1, exemplo: '12.345.678/0001-90' });
  });

  it('aceita seleção com texto extra em volta do valor', () => {
    const { campo } = construirCampo(exemplo, 'competencia', faixa(exemplo, 'apuração: 09/2026'));
    expect(campo?.rotulo).toBe('apuracao:');
    expect(campo?.exemplo).toBe('09/2026');
  });

  it('usa a linha anterior (cabeçalho) quando o valor não tem rótulo na mesma linha', () => {
    const { campo } = construirCampo(exemplo, 'valor', faixa(exemplo, '1.134,56'));
    expect(campo?.rotulo).toBe('total');
    expect(campo?.indiceAposRotulo).toBe(4);
    expect(campo?.exemplo).toBe('1134.56');
  });

  it('recusa seleção sem valor no formato do campo', () => {
    expect(construirCampo(exemplo, 'cnpj', faixa(exemplo, 'RECEITA FEDERAL')).erro).toBeTruthy();
  });

  it('recusa rótulo depois do valor', () => {
    const r = construirCampo(exemplo, 'cnpj', faixa(exemplo, '12.345.678/0001-90'), faixa(exemplo, 'Período'));
    expect(r.erro).toBeTruthy();
  });

  it('aplica o mapeamento em outro PDF do mesmo tipo com valores e quebras de linha diferentes', () => {
    const cnpj = construirCampo(exemplo, 'cnpj', faixa(exemplo, '12.345.678/0001-90')).campo!;
    const competencia = construirCampo(exemplo, 'competencia', faixa(exemplo, '09/2026')).campo!;
    const valor = construirCampo(exemplo, 'valor', faixa(exemplo, '1.134,56')).campo!;

    const outro = documento(
      'MINISTÉRIO DA FAZENDA RECEITA',
      'FEDERAL Documento de Arrecadação de Receitas Federais',
      'Contribuinte: EMPRESA X LTDA CNPJ:',
      '98.765.432/',
      '0001-10 Período de',
      'apuração: setembro de 2026',
      'Principal Multa Juros Total',
      '2.000,00 0,00 0,00 2.000,00',
    );

    expect(documentoCorresponde(outro, ['RECEITA FEDERAL', 'DOCUMENTO DE ARRECADAÇÃO'])).toBeTrue();
    expect(extrairCampo(outro, 'cnpj', cnpj)?.valor).toBe('98.765.432/0001-10');
    expect(extrairCampo(outro, 'competencia', competencia)?.valor).toBe('09/2026');
    expect(extrairCampo(outro, 'valor', valor)?.valor).toBe('2000.00');
  });

  it('não reconhece documento sem todos os termos', () => {
    const outro = documento('BOLETO BANCÁRIO', 'CNPJ: 12.345.678/0001-90');
    expect(documentoCorresponde(outro, ['RECEITA FEDERAL', 'BOLETO'])).toBeFalse();
  });
});
