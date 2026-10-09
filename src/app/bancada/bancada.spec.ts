import { MapeamentoSalvo } from '../armazenamento/mapeamentos-db.service';
import { ResultadoMatch } from '../match/match';
import { CampoMapeavel } from '../pdf-mapeamento/pdf-mapeamento.model';
import { AvaliacaoDocumento, ExecucaoBancada, Gabarito, avaliarDocumento, compararExecucoes, exportarCsv, mesmoValor, resumir } from './bancada';

type Veredito = 'corresponde' | 'duvidoso' | 'nao';

/** Resultado de um mapeamento num documento; com `confianca`, simula uma versão com score (v3+). */
function resultado(nome: string, veredito: Veredito, confianca?: number, valores: Partial<Record<CampoMapeavel, string>> = {}): ResultadoMatch {
  const versao = confianca === undefined ? 2 : 3;
  return {
    mapeamento: { id: nome, versao, nome, criadoEm: '', atualizadoEm: '' } as MapeamentoSalvo,
    corresponde: veredito === 'corresponde',
    camposCompletos: true,
    termos: [],
    campos: (['cnpj', 'competencia', 'valor'] as const).map(chave => ({ chave, rotulo: chave, valor: valores[chave] ?? null })),
    semTexto: false,
    avaliacao: confianca === undefined ? undefined : { veredito, confianca, sinais: [], codigoBarras: null },
  };
}

const gabarito = (tipo: string | null | undefined, campos: Gabarito['campos'] = {}): Gabarito => ({ tipo, campos });
const desfecho = (resultados: ResultadoMatch[], g: Gabarito) => avaliarDocumento(2, resultados, g).desfecho;

describe('bancada de testes', () => {
  describe('desfecho de cada documento numa versão', () => {
    it('tipo certo, tipo errado, ambíguo e não reconhecido', () => {
      const g = gabarito('DARF');
      expect(desfecho([resultado('DARF', 'corresponde'), resultado('DAS', 'nao')], g)).toBe('acerto');
      expect(desfecho([resultado('DARF', 'nao'), resultado('DAS', 'corresponde')], g)).toBe('tipo-errado');
      expect(desfecho([resultado('DARF', 'corresponde'), resultado('DAS', 'corresponde')], g)).toBe('ambiguo');
      expect(desfecho([resultado('DARF', 'nao'), resultado('DAS', 'nao')], g)).toBe('nao-reconhecido');
    });

    it('dois mapeamentos do mesmo tipo aceitando não é ambiguidade; o nome é comparado sem acento e caixa', () => {
      expect(desfecho([resultado('Guia DAS', 'corresponde'), resultado('guia das', 'corresponde')], gabarito('GUIA DAS'))).toBe('acerto');
    });

    it('documento de outro tipo: rejeitado ou falso positivo', () => {
      expect(desfecho([resultado('DARF', 'nao')], gabarito(null))).toBe('rejeitado');
      expect(desfecho([resultado('DARF', 'corresponde')], gabarito(null))).toBe('falso-positivo');
    });

    it('tipo que a versão não mapeou fica fora da conta, a menos que algo o aceite', () => {
      expect(desfecho([resultado('DARF', 'nao')], gabarito('FGTS'))).toBe('sem-mapeamento');
      expect(desfecho([resultado('DARF', 'corresponde')], gabarito('FGTS'))).toBe('falso-positivo');
    });

    it('com score, escolhe o aceito de maior confiança e marca duvidoso', () => {
      const a = avaliarDocumento(3, [resultado('DARF', 'duvidoso', 0.6), resultado('DAS', 'nao', 0.2)], gabarito('DARF'));
      expect(a.desfecho).toBe('nao-reconhecido');
      expect(a.duvidoso).toBeTrue();
      expect(a.confianca).toBe(0.6);
      expect(a.mapeamentos).toEqual([
        { nome: 'DARF', veredito: 'duvidoso', confianca: 0.6 },
        { nome: 'DAS', veredito: 'nao', confianca: 0.2 },
      ]);
    });
  });

  describe('valores do gabarito', () => {
    it('compara ignorando a formatação', () => {
      expect(mesmoValor('cnpj', '11222333000181', '11.222.333/0001-81')).toBeTrue();
      expect(mesmoValor('cnpj', '12.abc.345/01de-35', '12.ABC.345/01DE-35')).toBeTrue();
      expect(mesmoValor('competencia', '9/2026', '09/2026')).toBeTrue();
      expect(mesmoValor('valor', 'R$ 1.100,00', '1100.00')).toBeTrue();
      expect(mesmoValor('valor', '1100', '1100.00')).toBeTrue();
      expect(mesmoValor('valor', '1.100,01', '1100.00')).toBeFalse();
    });

    it('confere só os preenchidos, com o que o mapeamento do tipo certo leu', () => {
      const lidos = { cnpj: '11.222.333/0001-81', competencia: '09/2026', valor: '1100.00' };
      const a = avaliarDocumento(2, [resultado('DARF', 'corresponde', undefined, lidos), resultado('DAS', 'nao')], gabarito('DARF', { valor: '1.100,00', competencia: '08/2026', cnpj: '' }));
      expect(a.campos.map(c => [c.chave, c.certo])).toEqual([
        ['valor', true],
        ['competencia', false],
      ]);
    });
  });

  it('resume a versão: taxa de acerto sem os documentos fora da conta', () => {
    const avaliacoes: AvaliacaoDocumento[] = [
      avaliarDocumento(2, [resultado('DARF', 'corresponde', undefined, { valor: '10.00' })], gabarito('DARF', { valor: '10,00' })),
      avaliarDocumento(2, [resultado('DARF', 'nao')], gabarito(null)),
      avaliarDocumento(2, [resultado('DARF', 'nao')], gabarito('DARF')),
      avaliarDocumento(2, [resultado('DARF', 'nao')], gabarito('FGTS')),
    ];
    const r = resumir(2, avaliacoes);
    expect(r.avaliados).toBe(3);
    expect(r.porDesfecho.acerto).toBe(1);
    expect(r.porDesfecho.rejeitado).toBe(1);
    expect(r.porDesfecho['nao-reconhecido']).toBe(1);
    expect(r.porDesfecho['sem-mapeamento']).toBe(1);
    expect(r.taxaAcerto).toBeCloseTo(2 / 3);
    expect([r.camposCertos, r.camposConferidos]).toEqual([1, 1]);
  });

  it('compara com a execução anterior: o que melhorou e o que piorou', () => {
    const execucao = (desfechos: ExecucaoBancada['desfechos']): ExecucaoBancada => ({ id: '', dataHora: '', resumos: [], desfechos });
    const antes = execucao({ a: { 2: 'nao-reconhecido', 3: 'acerto' }, b: { 2: 'tipo-errado' }, c: { 2: 'acerto' } });
    const depois = execucao({ a: { 2: 'acerto', 3: 'falso-positivo' }, b: { 2: 'ambiguo' }, c: { 2: 'acerto' }, novo: { 2: 'acerto' } });
    expect(compararExecucoes(antes, depois)).toEqual([
      { documento: 'a', versao: 2, antes: 'nao-reconhecido', depois: 'acerto', melhorou: true },
      { documento: 'a', versao: 3, antes: 'acerto', depois: 'falso-positivo', melhorou: false },
      { documento: 'b', versao: 2, antes: 'tipo-errado', depois: 'ambiguo', melhorou: null },
    ]);
  });

  it('exporta uma linha por documento e versão', () => {
    const documento = { id: 'd', nome: 'guia.pdf', arquivo: new Blob(), gabarito: gabarito(null), adicionadoEm: '' };
    const csv = exportarCsv([documento], { d: [avaliarDocumento(3, [resultado('DARF', 'corresponde', 0.9)], gabarito(null))] }).split('\r\n');
    expect(csv[1]).toBe('"guia.pdf";"outro tipo";"v3";"Falso positivo";"DARF";"90%";"";""');
  });
});
