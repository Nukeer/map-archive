import { TokenPdf } from '../pdf-mapeamento/pdf-mapeamento.model';
import { MapeamentoSalvo } from '../armazenamento/mapeamentos-db.service';
import { MapeamentoPdfV2, construirCampoV2 } from './mapeamento-v2';
import { Planilha, converterParaPlanilha } from './planilha';
import { verificarMapeamento } from './verificacao';

const DIMENSOES = [{ largura: 600, altura: 800 }];
const HOJE = new Date(2026, 9, 9);

/** Texto posicionado: [y (pt), x (pt), texto]. */
type Trecho = [number, number, string];

function planilha(...trechos: Trecho[]): Planilha {
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
  return converterParaPlanilha(lista, DIMENSOES);
}

const guia = (identificador: string, competencia = '09/2026', valor = '1.100,00', titulo = 'RECEITA FEDERAL') =>
  planilha(
    [50, 50, titulo],
    [70, 50, 'DOCUMENTO DE ARRECADACAO'],
    [120, 50, 'Contribuinte:'],
    [120, 150, identificador],
    [140, 50, 'Periodo de apuracao:'],
    [140, 200, competencia],
    [160, 50, 'Valor total:'],
    [160, 200, valor],
  );

function mapear(p: Planilha, nome = 'DARF'): MapeamentoPdfV2 {
  const campo = (tipo: 'cnpj' | 'competencia' | 'valor', linha: number) => {
    const c = p.celulas.find(c => c.linha === linha && c.ordem === 2)!;
    return construirCampoV2(p, tipo, c.id, c.id).campo!;
  };
  const termo = (linha: number) => ({ texto: p.celulas.find(c => c.linha === linha)!.texto, celula: { pagina: 1, linha, coluna: 0 } });
  return { versao: 2, nome, cnpj: campo('cnpj', 3), competencia: campo('competencia', 4), valor: campo('valor', 5), termos: [termo(1), termo(2)] };
}

const registro = (mapeamento: MapeamentoPdfV2): MapeamentoSalvo => ({ id: 'a', versao: 2, nome: mapeamento.nome, criadoEm: '', atualizadoEm: '', mapeamento });
const divergencias = (itens: ReturnType<typeof verificarMapeamento>) => itens.flatMap(i => i.divergencias);

describe('verificação do mapeamento (etapa Validação)', () => {
  it('sem divergência quando tudo confere, na ordem do assistente', () => {
    const p = guia('11.222.333/0001-81');
    const itens = verificarMapeamento(p, mapear(p), null, HOJE);
    expect(itens.map(i => i.titulo)).toEqual(['CNPJ', 'Mês de competência', 'Termos de integração', 'Valor a pagar']);
    expect(divergencias(itens)).toEqual([]);
    expect(itens[0].detalhe).toBe('Pág.1!B3 → 11.222.333/0001-81');
  });

  it('aponta dígito verificador inválido, competência fora do período e valor zero', () => {
    const p = guia('11.222.333/0001-82', '09/2035', '0,00');
    const itens = verificarMapeamento(p, mapear(p), null, HOJE);
    expect(itens.filter(i => !i.ok).map(i => i.etapa)).toEqual(['cnpj', 'competencia', 'valor']);
    expect(divergencias(itens)).toEqual([
      'Divergência Encontrada: o CNPJ 11.222.333/0001-82 tem dígito verificador inválido.',
      'Divergência Encontrada: a competência 09/2035 está fora do período aceito (01/2000 a 12/2027).',
      'Divergência Encontrada: o valor a pagar marcado é zero.',
    ]);
  });

  it('usa o tipo do identificador (CPF) no título e na validação', () => {
    const p = guia('529.982.247-25');
    const itens = verificarMapeamento(p, mapear(p), null, HOJE);
    expect(itens[0].titulo).toBe('CPF');
    expect(itens[0].ok).toBeTrue();
  });

  it('compara com o mapeamento anterior do layout: termo que não aparece mais', () => {
    const antes = guia('11.222.333/0001-81');
    const agora = guia('11.222.333/0001-81', '09/2026', '1.100,00', 'SIMPLES NACIONAL');
    const itens = verificarMapeamento(agora, mapear(agora), registro(mapear(antes)), HOJE);
    const termos = itens.find(i => i.etapa === 'termos')!;
    expect(termos.ok).toBeFalse();
    expect(termos.divergencias).toEqual([
      'Divergência Encontrada: O termo identificado no documento não corresponde ao mapeado anteriormente para este layout ("RECEITA FEDERAL" não aparece neste documento).',
    ]);
    expect(termos.detalhe).toContain('+ SIMPLES NACIONAL; − RECEITA FEDERAL');
  });

  it('compara com o mapeamento anterior: campo marcado em outro lugar e tipo de identificador trocado', () => {
    const p = guia('11.222.333/0001-81');
    const anterior = mapear(p);
    // Agora a competência é marcada na linha do valor (por engano) e o identificador como CPF de outro documento.
    const errado: MapeamentoPdfV2 = { ...anterior, competencia: { ...anterior.valor, exemplo: '1100.00' } };
    const itens = verificarMapeamento(p, errado, registro(anterior), HOJE);
    expect(itens[1].divergencias.some(d => d.includes('o mapeamento anterior lê Mês de competência em Pág.1!B4 (09/2026)'))).toBeTrue();

    const cpf = guia('529.982.247-25');
    const comCpf = verificarMapeamento(cpf, mapear(cpf), registro(anterior), HOJE);
    expect(comCpf[0].divergencias).toContain('Divergência Encontrada: o mapeamento anterior deste layout usava CNPJ; agora foi marcado CPF.');
  });
});
