import { TokenPdf, MapeamentoPdf } from '../pdf-mapeamento/pdf-mapeamento.model';
import { construirCampo, criarDocumentoTexto, DocumentoTexto } from '../pdf-mapeamento/extrator';
import { construirCampoV2, MapeamentoPdfV2 } from '../pdf-mapeamento-v2/mapeamento-v2';
import { converterParaPlanilha, Planilha } from '../pdf-mapeamento-v2/planilha';
import { MapeamentoSalvo } from '../armazenamento/mapeamentos-db.service';
import { verificarDocumento } from './match';

const DIMENSOES = [{ largura: 600, altura: 800 }];

/** Texto posicionado: [y (pt), x (pt), texto]. */
type Trecho = [number, number, string];

function tokens(...trechos: Trecho[]): TokenPdf[] {
  const lista: TokenPdf[] = [];
  const linhas = [...new Set(trechos.map(t => t[0]))].sort((a, b) => a - b);
  for (const [trecho, [y, x, texto]] of [...trechos].sort((a, b) => a[0] - b[0] || a[1] - b[1]).entries()) {
    let cursor = x;
    for (const palavra of texto.split(' ')) {
      lista.push({
        indice: lista.length,
        pagina: 1,
        linha: linhas.indexOf(y),
        trecho,
        texto: palavra,
        caixa: { x: cursor / 600, y: y / 800, largura: (palavra.length * 5) / 600, altura: 11.5 / 800 },
      });
      cursor += (palavra.length + 1) * 5;
    }
  }
  return lista;
}

const exemplo = tokens(
  [50, 50, 'RECEITA FEDERAL'],
  [70, 50, 'DOCUMENTO DE ARRECADAÇÃO'],
  [120, 50, 'CNPJ:'],
  [120, 150, '12.345.678/0001-90'],
  [140, 50, 'Período de apuração: 09/2026'],
  [200, 50, 'Principal'],
  [200, 250, 'Total'],
  [215, 50, '1.000,00'],
  [215, 250, '1.100,00'],
);

const outroDarf = tokens(
  [50, 50, 'RECEITA FEDERAL'],
  [70, 50, 'DOCUMENTO DE ARRECADAÇÃO'],
  [120, 50, 'CNPJ:'],
  [120, 150, '98.765.432/0001-10'],
  [140, 50, 'Período de apuração: 08/2026'],
  [200, 50, 'Principal'],
  [200, 250, 'Total'],
  [215, 50, '2.000,00'],
  [215, 250, '2.000,00'],
);

const boleto = tokens([50, 50, 'BANCO EXEMPLO S.A.'], [70, 50, 'Beneficiário CNPJ: 11.111.111/0001-11'], [90, 50, 'Valor 50,00']);

function registro(versao: 1 | 2, mapeamento: MapeamentoPdf | MapeamentoPdfV2): MapeamentoSalvo {
  return { id: 'x', versao, nome: 'DARF', criadoEm: '', atualizadoEm: '', mapeamento };
}

function mapeamentoV1(): MapeamentoSalvo {
  const doc: DocumentoTexto = criarDocumentoTexto(exemplo);
  const faixa = (texto: string) => {
    const i = doc.tokens.findIndex(t => t.texto === texto);
    return { inicio: i, fim: i };
  };
  return registro(1, {
    nome: 'DARF',
    cnpj: construirCampo(doc, 'cnpj', faixa('12.345.678/0001-90')).campo!,
    competencia: construirCampo(doc, 'competencia', faixa('09/2026')).campo!,
    valor: construirCampo(doc, 'valor', faixa('1.100,00')).campo!,
    termos: ['RECEITA FEDERAL', 'DOCUMENTO DE ARRECADAÇÃO'],
  });
}

function mapeamentoV2(): MapeamentoSalvo {
  const planilha: Planilha = converterParaPlanilha(exemplo, DIMENSOES);
  const id = (texto: string) => planilha.celulas.find(c => c.texto === texto)!.id;
  const campo = (tipo: 'cnpj' | 'competencia' | 'valor', texto: string) => construirCampoV2(planilha, tipo, id(texto), id(texto)).campo!;
  return registro(2, {
    versao: 2,
    nome: 'DARF',
    cnpj: campo('cnpj', '12.345.678/0001-90'),
    competencia: campo('competencia', 'Período de apuração: 09/2026'),
    valor: campo('valor', '1.100,00'),
    termos: [
      { texto: 'RECEITA FEDERAL', celula: { pagina: 1, linha: 1, coluna: 0 } },
      { texto: 'DOCUMENTO DE ARRECADAÇÃO', celula: { pagina: 1, linha: 2, coluna: 0 } },
    ],
  });
}

describe('match', () => {
  for (const [nome, criar] of [['v1', mapeamentoV1], ['v2', mapeamentoV2]] as const) {
    describe(nome, () => {
      it('reconhece outro PDF do mesmo tipo e extrai os campos', () => {
        const r = verificarDocumento(criar(), outroDarf, DIMENSOES);
        expect(r.corresponde).toBeTrue();
        expect(r.camposCompletos).toBeTrue();
        expect(r.campos.map(c => c.valor)).toEqual(['98.765.432/0001-10', '08/2026', '2000.00']);
      });

      it('recusa PDF de outro tipo e aponta os termos ausentes', () => {
        const r = verificarDocumento(criar(), boleto, DIMENSOES);
        expect(r.corresponde).toBeFalse();
        expect(r.termos.filter(t => !t.encontrado).map(t => t.texto)).toEqual(['RECEITA FEDERAL', 'DOCUMENTO DE ARRECADAÇÃO']);
      });
    });
  }

  it('v2 informa célula e posição dos termos e dos campos', () => {
    const r = verificarDocumento(mapeamentoV2(), outroDarf, DIMENSOES);
    expect(r.termos[0]).toEqual({ texto: 'RECEITA FEDERAL', encontrado: true, naPosicao: true, celula: 'Pág.1!A1' });
    expect(r.campos[0].celulas).toBe('Pág.1!B3');
    expect(r.campos[0].origem).toBe('mesma linha/coluna');
  });

  it('marca PDF sem texto', () => {
    const r = verificarDocumento(mapeamentoV1(), [], DIMENSOES);
    expect(r.semTexto).toBeTrue();
    expect(r.corresponde).toBeFalse();
  });
});
