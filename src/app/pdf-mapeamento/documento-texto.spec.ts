import { converterParaPlanilha } from '../pdf-mapeamento-v2/planilha';
import { construirCampoV2, extrairCampoV2 } from '../pdf-mapeamento-v2/mapeamento-v2';
import { decodificarTexto, formatoDoArquivo, lerCsv, lerTxt, separarCsv } from './documento-texto';

const textosDaLinha = (texto: ReturnType<typeof converterParaPlanilha>, linha: number) =>
  texto.celulas.filter(c => c.linha === linha).map(c => c.texto);

describe('documentos de texto (CSV e TXT)', () => {
  it('reconhece o formato pela extensão e pelo tipo', () => {
    expect(formatoDoArquivo(new File([''], 'guia.PDF'))).toBe('pdf');
    expect(formatoDoArquivo(new File([''], 'relatorio.csv'))).toBe('csv');
    expect(formatoDoArquivo(new File([''], 'retorno', { type: 'text/plain' }))).toBe('txt');
    expect(formatoDoArquivo(new File([''], 'guias.zip'))).toBeNull();
  });

  it('lê UTF-8 e, se não for, Windows-1252', () => {
    expect(decodificarTexto(new TextEncoder().encode('﻿Período'))).toBe('Período');
    expect(decodificarTexto(new Uint8Array([0x50, 0x65, 0x72, 0xed, 0x6f, 0x64, 0x6f]))).toBe('Período');
  });

  it('separa CSV com ponto e vírgula, aspas e linhas em branco', () => {
    expect(separarCsv('a;"b;c";"d ""e"""\r\n\r\n1;2;3\n')).toEqual([
      ['a', 'b;c', 'd "e"'],
      ['1', '2', '3'],
    ]);
    expect(separarCsv('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('cada célula do CSV vira uma célula da planilha, e o mapeamento funciona igual', () => {
    const { tokens, dimensoes } = lerCsv('CNPJ;Razão Social;Competência;Valor\n11.222.333/0001-81;ALFA COMERCIO LTDA;09/2026;1.100,00\n');
    const planilha = converterParaPlanilha(tokens, dimensoes);
    expect(textosDaLinha(planilha, 1)).toEqual(['CNPJ', 'Razão Social', 'Competência', 'Valor']);
    expect(textosDaLinha(planilha, 2)).toEqual(['11.222.333/0001-81', 'ALFA COMERCIO LTDA', '09/2026', '1.100,00']);

    const celula = planilha.celulas.find(c => c.texto === '1.100,00')!;
    const { campo } = construirCampoV2(planilha, 'valor', celula.id, celula.id);
    expect(campo!.rotulo).toEqual({ texto: 'valor', posicao: 'acima', distancia: 1 });

    const outro = lerCsv('CNPJ;Razão Social;Competência;Valor\n11.444.777/0001-61;BETA;08/2026;250,00\n');
    expect(extrairCampoV2(converterParaPlanilha(outro.tokens, outro.dimensoes), 'valor', campo!)?.valor).toBe('250.00');
  });

  it('TXT mantém as colunas de relatórios de largura fixa e pagina linhas longas', () => {
    const relatorio = ['GUIA DE RECOLHIMENTO', '', 'CNPJ:  11.222.333/0001-81      Competência:  09/2026', 'Valor a pagar:       1.100,00'];
    const { tokens, dimensoes } = lerTxt(relatorio.join('\n'));
    const planilha = converterParaPlanilha(tokens, dimensoes);
    expect(textosDaLinha(planilha, 1)).toEqual(['GUIA DE RECOLHIMENTO']);
    expect(textosDaLinha(planilha, 2)).toEqual(['CNPJ:', '11.222.333/0001-81', 'Competência:', '09/2026']);
    expect(textosDaLinha(planilha, 3)).toEqual(['Valor a pagar:', '1.100,00']);

    const longo = lerTxt(Array.from({ length: 130 }, (_, i) => `linha ${i + 1}`).join('\n'));
    expect(longo.dimensoes.length).toBe(3);
    expect(longo.tokens[longo.tokens.length - 1].pagina).toBe(3);
  });
});
