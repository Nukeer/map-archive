import { PdfDocumentoService } from './pdf-documento.service';
import { BITS_MAPA, paraBits } from '../pdf-mapeamento-v5/aparencia';

/** PDF de uma página A4 com um retângulo e um texto em Helvetica, montado à mão. */
function pdfMinimo(texto: string, produtor: string): File {
  const conteudo = `2 w 40 500 515 300 re S 40 650 m 555 650 l S BT /F1 18 Tf 60 700 Td (${texto}) Tj ET`;
  const objetos = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${conteudo.length} >>\nstream\n${conteudo}\nendstream`,
    `<< /Producer (${produtor}) >>`,
  ];
  let pdf = '%PDF-1.4\n';
  const posicoes = objetos.map((objeto, i) => {
    const posicao = pdf.length;
    pdf += `${i + 1} 0 obj\n${objeto}\nendobj\n`;
    return posicao;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`;
  pdf += posicoes.map(p => `${String(p).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new File([pdf], 'teste.pdf', { type: 'application/pdf' });
}

describe('PdfDocumentoService', () => {
  let servico: PdfDocumentoService;

  beforeEach(() => (servico = new PdfDocumentoService()));
  afterEach(() => servico.fechar());

  it('lê o texto e a aparência da 1ª página', async () => {
    const { tokens, dimensoes } = await servico.abrir(pdfMinimo('RECEITA FEDERAL', 'Gerador Teste 1.2.3'));
    expect(tokens.map(t => t.texto)).toEqual(['RECEITA', 'FEDERAL']);
    expect(dimensoes).toEqual([{ largura: 595, altura: 842 }]);

    const aparencia = await servico.aparencia();
    expect(aparencia.fontes).toEqual(['helvetica']);
    expect(aparencia.produtor).toBe('gerador teste');
    expect(aparencia.hash.length).toBe(BITS_MAPA / 4);
    expect(paraBits(aparencia.hash).filter(Boolean).length).toBeGreaterThan(10);
  });

  it('exige um PDF aberto', async () => {
    await expectAsync(servico.aparencia()).toBeRejectedWithError('Nenhum PDF aberto.');
  });
});
