import { TokenPdf } from '../pdf-mapeamento/pdf-mapeamento.model';
import { construirCampoV2, documentoCorrespondeV2, extrairCampoV2 } from './mapeamento-v2';
import { Planilha, converterParaPlanilha, descreverIntervalo, exportarCsv, referencia } from './planilha';

const LARGURA = 600;
const ALTURA = 800;
const FONTE = 10;
const LETRA = 5;

/**
 * Texto posicionado: [y (pt), x (pt), texto, opções]. Palavras separadas por um espaço ficam no mesmo bloco.
 * `direita`: x é a borda direita (texto alinhado à direita); `letra`: largura de cada caractere.
 */
type Trecho = [number, number, string, { direita?: boolean; letra?: number }?];

function pdf(...trechos: Trecho[]): Planilha {
  const tokens: TokenPdf[] = [];
  for (const [trecho, [y, x, texto, opcoes]] of trechos.entries()) {
    const letra = opcoes?.letra ?? LETRA;
    let cursor = opcoes?.direita ? x - texto.length * letra : x;
    for (const palavra of texto.split(' ')) {
      tokens.push({
        indice: tokens.length,
        pagina: 1,
        linha: 0,
        trecho,
        texto: palavra,
        caixa: { x: cursor / LARGURA, y: y / ALTURA, largura: (palavra.length * letra) / LARGURA, altura: (FONTE * 1.15) / ALTURA },
      });
      cursor += (palavra.length + 1) * letra;
    }
  }
  return converterParaPlanilha(tokens, [{ largura: LARGURA, altura: ALTURA }]);
}

function celula(planilha: Planilha, texto: string) {
  const c = planilha.celulas.find(c => c.texto === texto);
  expect(c).withContext(texto).toBeDefined();
  return c!;
}

describe('planilha (v2)', () => {
  const exemplo = pdf(
    [50, 50, 'RECEITA FEDERAL'],
    [70, 50, 'DOCUMENTO DE ARRECADAÇÃO'],
    [120, 50, 'CNPJ:'],
    [120, 150, '12.345.678/0001-90'],
    [140, 50, 'Período de apuração: 09/2026'],
    [200, 50, 'Principal'],
    [200, 150, 'Multa'],
    [200, 250, 'Total'],
    [215, 50, '1.000,00'],
    [215, 150, '100,00'],
    [215, 250, '1.100,00'],
  );

  it('separa blocos em células com linha e coluna', () => {
    expect(referencia(celula(exemplo, 'CNPJ:'))).toBe('A3');
    expect(referencia(celula(exemplo, '12.345.678/0001-90'))).toBe('B3');
    expect(referencia(celula(exemplo, 'Total'))).toBe('C5');
    expect(referencia(celula(exemplo, '1.100,00'))).toBe('C6');
    expect(exportarCsv(exemplo, 1).split('\r\n')[2]).toBe('"CNPJ:";"12.345.678/0001-90";""');
  });

  it('separa rótulo e valor desenhados separadamente mesmo quando estão colados ou se sobrepõem', () => {
    // "CNPJ:" ocupa 50..75; valor a 4,5pt (< um espaço "grande", mas outro trecho do PDF)
    const colado = pdf([120, 50, 'CNPJ:'], [120, 79.5, '12.345.678/0001-90']);
    expect(colado.celulas.map(c => c.texto)).toEqual(['CNPJ:', '12.345.678/0001-90']);
    // valor largo começando antes do fim do rótulo: palavras não se misturam
    const sobreposto = pdf([120, 50, 'NÚMERO DO CNPJ'], [120, 110, '98.765.432/0001-10', { letra: 6 }]);
    expect(sobreposto.celulas.map(c => c.texto)).toEqual(['NÚMERO DO CNPJ', '98.765.432/0001-10']);
  });

  it('mapeia célula e rótulo vizinho', () => {
    const valor = celula(exemplo, '12.345.678/0001-90');
    const { campo } = construirCampoV2(exemplo, 'cnpj', valor.id, valor.id);
    expect(descreverIntervalo(campo!.inicio, campo!.fim)).toBe('Pág.1!B3');
    expect(campo!.rotulo).toEqual({ texto: 'cnpj:', posicao: 'esquerda', distancia: 1 });
  });

  it('usa cabeçalho acima como rótulo em tabelas e rótulo interno da célula', () => {
    const total = celula(exemplo, '1.100,00');
    expect(construirCampoV2(exemplo, 'valor', total.id, total.id).campo!.rotulo).toEqual({ texto: 'total', posicao: 'acima', distancia: 1 });
    const periodo = celula(exemplo, 'Período de apuração: 09/2026');
    const competencia = construirCampoV2(exemplo, 'competencia', periodo.id, periodo.id).campo!;
    expect(competencia.rotulo?.texto).toBe('periodo de apuracao:');
    expect(competencia.exemplo).toBe('09/2026');
  });

  it('acha o cabeçalho acima mesmo quando o número alinhado à direita cai em outra coluna', () => {
    const tabela = pdf([200, 50, 'Juros'], [200, 150, 'Total'], [215, 60, '34,56'], [215, 160, '1.100,00']);
    const total = celula(tabela, '1.100,00');
    expect(total.coluna).not.toBe(celula(tabela, 'Total').coluna);
    const { campo } = construirCampoV2(tabela, 'valor', total.id, total.id);
    expect(campo!.rotulo?.texto).toBe('total');
    const outra = pdf([200, 50, 'Juros'], [200, 150, 'Total'], [215, 60, '0,00'], [215, 160, '987,65']);
    expect(extrairCampoV2(outra, 'valor', campo!)?.valor).toBe('987.65');
  });

  it('recusa seleção sem o formato do campo', () => {
    const c = celula(exemplo, 'RECEITA FEDERAL');
    expect(construirCampoV2(exemplo, 'cnpj', c.id, c.id).erro).toBeTruthy();
  });

  it('intervalo em duas linhas continua funcionando quando o rótulo muda de coluna', () => {
    const modelo = pdf([120, 50, 'Contribuinte: EMPRESA'], [120, 200, 'CNPJ: 12.345.678/'], [135, 50, '0001-90']);
    const inicio = celula(modelo, 'CNPJ: 12.345.678/');
    const fim = celula(modelo, '0001-90');
    const { campo } = construirCampoV2(modelo, 'cnpj', inicio.id, fim.id);
    expect(descreverIntervalo(campo!.inicio, campo!.fim)).toBe('Pág.1!B1:A2');

    const outro = pdf(
      [100, 50, 'Código da receita:'],
      [100, 200, '2089'],
      [120, 50, 'Contribuinte: OUTRA EMPRESA S.A.'],
      [120, 300, 'CNPJ: 98.765.432/'],
      [135, 50, '0001-10'],
    );
    expect(referencia(celula(outro, 'CNPJ: 98.765.432/'))).toBe('C2');
    expect(extrairCampoV2(outro, 'cnpj', campo!)).toEqual(jasmine.objectContaining({ valor: '98.765.432/0001-10', origem: 'rotulo' }));
  });

  describe('em outro PDF do mesmo tipo', () => {
    const mapear = () => {
      const cnpj = celula(exemplo, '12.345.678/0001-90');
      const total = celula(exemplo, '1.100,00');
      return {
        cnpj: construirCampoV2(exemplo, 'cnpj', cnpj.id, cnpj.id).campo!,
        valor: construirCampoV2(exemplo, 'valor', total.id, total.id).campo!,
      };
    };

    it('lê pela mesma linha e coluna', () => {
      const outro = pdf(
        [50, 50, 'RECEITA FEDERAL'],
        [70, 50, 'DOCUMENTO DE ARRECADAÇÃO'],
        [120, 50, 'CNPJ:'],
        [120, 150, '98.765.432/0001-10'],
        [140, 50, 'Período de apuração: 08/2026'],
        [200, 50, 'Principal'],
        [200, 150, 'Multa'],
        [200, 250, 'Total'],
        [215, 50, '2.000,00'],
        [215, 150, '0,00'],
        [215, 250, '2.000,00'],
      );
      const { cnpj, valor } = mapear();
      expect(extrairCampoV2(outro, 'cnpj', cnpj)).toEqual(jasmine.objectContaining({ valor: '98.765.432/0001-10', origem: 'posicao' }));
      expect(extrairCampoV2(outro, 'valor', valor)?.valor).toBe('2000.00');
    });

    it('acha pelo rótulo quando uma linha extra desloca tudo e o CNPJ quebra em duas linhas', () => {
      const outro = pdf(
        [50, 50, 'RECEITA FEDERAL'],
        [70, 50, 'DOCUMENTO DE ARRECADAÇÃO'],
        [90, 50, 'Contribuinte: EMPRESA X LTDA'],
        [120, 50, 'CNPJ:'],
        [120, 150, '98.765.432/'],
        [135, 150, '0001-10'],
        [160, 50, 'Principal'],
        [160, 150, 'Multa'],
        [160, 250, 'Total'],
        [175, 50, '2.000,00'],
        [175, 150, '0,00'],
        [175, 250, '2.000,00'],
      );
      const cnpjExemplo = celula(exemplo, '12.345.678/0001-90');
      // CNPJ quebrado também pode ser mapeado como intervalo de células no exemplo
      const intervalo = pdf([120, 50, 'CNPJ:'], [120, 150, '12.345.678/'], [135, 150, '0001-90']);
      const inicio = celula(intervalo, '12.345.678/');
      const fim = celula(intervalo, '0001-90');
      const campoIntervalo = construirCampoV2(intervalo, 'cnpj', inicio.id, fim.id).campo!;
      expect(descreverIntervalo(campoIntervalo.inicio, campoIntervalo.fim)).toBe('Pág.1!B1:B2');

      const { valor } = mapear();
      const cnpjLido = extrairCampoV2(outro, 'cnpj', construirCampoV2(exemplo, 'cnpj', cnpjExemplo.id, cnpjExemplo.id).campo!);
      expect(cnpjLido).toEqual(jasmine.objectContaining({ valor: '98.765.432/0001-10', origem: 'rotulo' }));
      expect(extrairCampoV2(outro, 'cnpj', campoIntervalo)?.valor).toBe('98.765.432/0001-10');
      expect(extrairCampoV2(outro, 'valor', valor)?.valor).toBe('2000.00');
      expect(documentoCorrespondeV2(outro, [
        { texto: 'RECEITA FEDERAL', celula: { pagina: 1, linha: 1, coluna: 0 } },
        { texto: 'DOCUMENTO DE ARRECADAÇÃO', celula: { pagina: 1, linha: 2, coluna: 0 } },
      ])).toBeTrue();
    });
  });

  describe('layout com valores alinhados à direita (tipo DARF)', () => {
    const darf = (cnpj: string, valor: string, letraCnpj = LETRA) =>
      pdf(
        [50, 50, 'RECEITA FEDERAL'],
        [70, 50, 'DOCUMENTO DE ARRECADAÇÃO DE RECEITAS FEDERAIS'],
        [100, 50, 'NOME / TELEFONE'],
        [100, 320, '02 PERÍODO DE APURAÇÃO'],
        [100, 560, '30/09/2026', { direita: true }],
        [130, 320, '03 NÚMERO DO CPF OU CNPJ'],
        [130, 560, cnpj, { direita: true, letra: letraCnpj }],
        [160, 320, '04 CÓDIGO DA RECEITA'],
        [160, 560, '2089', { direita: true }],
        [190, 320, '07 VALOR DO PRINCIPAL'],
        [190, 560, valor, { direita: true }],
        [250, 320, '10 VALOR TOTAL'],
        [250, 560, valor, { direita: true }],
      );

    const mapear = (planilha: Planilha) => {
      const campo = (tipo: 'cnpj' | 'competencia' | 'valor', texto: string, n = 0) => {
        const c = planilha.celulas.filter(c => c.texto === texto)[n];
        return construirCampoV2(planilha, tipo, c.id, c.id).campo!;
      };
      return {
        cnpj: campo('cnpj', '12.345.678/0001-90'),
        competencia: campo('competencia', '30/09/2026'),
        valor: campo('valor', '1.134,56', 1),
      };
    };

    it('valores alinhados à direita ficam na mesma coluna e o rótulo é o bloco à esquerda', () => {
      const modelo = darf('12.345.678/0001-90', '1.134,56');
      const { cnpj, competencia, valor } = mapear(modelo);
      expect(cnpj.rotulo).toEqual({ texto: '03 numero do cpf ou cnpj', posicao: 'esquerda', distancia: 1 });
      expect(competencia.exemplo).toBe('09/2026');
      expect(valor.rotulo?.texto).toBe('10 valor total');
      const colunas = ['30/09/2026', '12.345.678/0001-90', '2089'].map(t => celula(modelo, t).coluna);
      expect(new Set(colunas).size).toBe(1);
    });

    it('acha CNPJ e valor quando ficam mais largos', () => {
      const mapeamento = mapear(darf('12.345.678/0001-90', '1.134,56'));
      const outro = darf('98.765.432/0001-10', '123.456.789,01', 7);
      expect(extrairCampoV2(outro, 'cnpj', mapeamento.cnpj)?.valor).toBe('98.765.432/0001-10');
      expect(extrairCampoV2(outro, 'competencia', mapeamento.competencia)?.valor).toBe('09/2026');
      expect(extrairCampoV2(outro, 'valor', mapeamento.valor)?.valor).toBe('123456789.01');
    });

    it('acha o valor total, e não o principal, quando uma linha extra desloca tudo', () => {
      const mapeamento = mapear(darf('12.345.678/0001-90', '1.134,56'));
      const outro = pdf(
        [50, 50, 'RECEITA FEDERAL'],
        [70, 50, 'DOCUMENTO DE ARRECADAÇÃO DE RECEITAS FEDERAIS'],
        [85, 50, 'Observação: pagamento em atraso'],
        [100, 50, 'NOME / TELEFONE'],
        [100, 320, '02 PERÍODO DE APURAÇÃO'],
        [100, 560, '31/08/2026', { direita: true }],
        [130, 320, '03 NÚMERO DO CPF OU CNPJ'],
        [130, 560, '98.765.432/0001-10', { direita: true, letra: 6 }],
        [190, 320, '07 VALOR DO PRINCIPAL'],
        [190, 560, '10.000,00', { direita: true }],
        [220, 320, '09 JUROS'],
        [220, 560, '2.345,67', { direita: true }],
        [250, 320, '10 VALOR TOTAL'],
        [250, 560, '12.345,67', { direita: true }],
      );
      expect(extrairCampoV2(outro, 'cnpj', mapeamento.cnpj)?.valor).toBe('98.765.432/0001-10');
      expect(extrairCampoV2(outro, 'competencia', mapeamento.competencia)?.valor).toBe('08/2026');
      expect(extrairCampoV2(outro, 'valor', mapeamento.valor)).toEqual(jasmine.objectContaining({ valor: '12345.67', origem: 'rotulo' }));
    });

    it('aceita mapeamento salvo no formato antigo do rótulo', () => {
      const atual = mapear(darf('12.345.678/0001-90', '1.134,56')).cnpj;
      const antigo = { ...atual, rotulo: { texto: '03 numero do cpf ou cnpj', linhas: 0, colunas: 3 } };
      const outro = darf('98.765.432/0001-10', '1,00', 7);
      expect(extrairCampoV2(outro, 'cnpj', antigo as never)?.valor).toBe('98.765.432/0001-10');
    });
  });
});