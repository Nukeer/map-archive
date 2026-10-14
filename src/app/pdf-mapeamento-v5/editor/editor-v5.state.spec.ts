import { MapeamentoSalvo } from '../../armazenamento/mapeamentos-db.service';
import { lerCsv } from '../../pdf-mapeamento/documento-texto';
import { converterParaPlanilha } from '../../pdf-mapeamento-v2/planilha';
import { EditorV5State, ModeloCarregado } from './editor-v5.state';

const guia = (cpf: string, valor: string, titulo = 'RECEITA FEDERAL') =>
  `${titulo};;\nDOCUMENTO DE ARRECADACAO;;\nCPF;Competência;Valor\n${cpf};09/2026;${valor}\n`;

function modelo(nome: string, texto: string): ModeloCarregado {
  const { tokens, dimensoes } = lerCsv(texto);
  return { nome, arquivo: new File([texto], nome), planilha: converterParaPlanilha(tokens, dimensoes), dimensoes, aparencia: null, semTexto: !tokens.length };
}

const celula = (estado: EditorV5State, texto: string) => {
  const c = estado.principal()!.planilha.celulas.find(c => c.texto === texto)!;
  return { inicio: c.id, fim: c.id };
};

/** Estado com duas guias e nome, pronto para marcar. */
function preparado(): EditorV5State {
  const estado = new EditorV5State();
  estado.adicionarModelo(modelo('a.csv', guia('529.982.247-25', '1.100,00')));
  estado.adicionarModelo(modelo('b.csv', guia('111.444.777-35', '250,00')));
  estado.nome.set('DARF');
  return estado;
}

/** Marca identificador, competência, dois termos e valor, avançando pelas etapas. */
function marcarTudo(estado: EditorV5State): void {
  estado.proximo();
  estado.aplicarSelecao(celula(estado, '529.982.247-25'));
  estado.proximo();
  estado.aplicarSelecao(celula(estado, '09/2026'));
  estado.proximo();
  estado.aplicarSelecao(celula(estado, 'RECEITA FEDERAL'));
  estado.aplicarSelecao(celula(estado, 'DOCUMENTO DE ARRECADACAO'));
  estado.proximo();
  estado.aplicarSelecao(celula(estado, '1.100,00'));
  estado.proximo();
}

describe('assistente v5 (estado)', () => {
  it('diz o que falta e o que vem depois', () => {
    const estado = new EditorV5State();
    expect(estado.oQueFalta()).toBe('Adicione mais 2 guias para continuar.');
    estado.adicionarModelo(modelo('a.csv', guia('529.982.247-25', '1.100,00')));
    estado.adicionarModelo(modelo('b.csv', guia('111.444.777-35', '250,00')));
    expect(estado.oQueFalta()).toBe('Dê um nome ao serviço para continuar.');
    estado.nome.set('DARF');
    expect(estado.oQueFalta()).toBeNull();
    expect(estado.rotuloProximo()).toBe('Próximo: Identificador');

    estado.proximo();
    expect(estado.atual().id).toBe('identificador');
    expect(estado.oQueFalta()).toBe('Clique no identificador no documento para continuar.');
    estado.aplicarSelecao(celula(estado, 'RECEITA FEDERAL'));
    expect(estado.oQueFalta()).toContain('Não reconheci CNPJ, CPF, CAEPF ou CNO');
    estado.aplicarSelecao(celula(estado, '529.982.247-25'));
    expect(estado.resumo('identificador')).toBe('CPF 529.982.247-25');
    expect(estado.rotuloProximo()).toBe('Próximo: Competência');
  });

  it('não deixa pular etapas, mas deixa voltar', () => {
    const estado = preparado();
    estado.irPara(4);
    expect(estado.atual().id).toBe('documentos');
    estado.proximo();
    estado.voltar();
    expect(estado.atual().id).toBe('documentos');
  });

  it('termos: mínimo de dois, sem repetir, e desfazer/refazer', () => {
    const estado = preparado();
    estado.irParaEtapa('identificador');
    estado.aplicarSelecao(celula(estado, '529.982.247-25'));
    estado.proximo();
    estado.aplicarSelecao(celula(estado, '09/2026'));
    estado.proximo();
    expect(estado.oQueFalta()).toBe('Marque mais 2 termos para continuar.');
    estado.aplicarSelecao(celula(estado, 'RECEITA FEDERAL'));
    estado.aplicarSelecao(celula(estado, 'RECEITA FEDERAL'));
    expect(estado.termos().length).toBe(1);
    expect(estado.oQueFalta()).toBe('Marque mais 1 termo para continuar.');

    estado.desfazer();
    expect(estado.termos().length).toBe(0);
    estado.refazer();
    expect(estado.termos().map(t => t.texto)).toEqual(['RECEITA FEDERAL']);
    estado.desfazer();
    estado.desfazer();
    expect(estado.selecoes().competencia).toBeUndefined();
    expect(estado.podeRefazer()).toBeTrue();
  });

  it('verifica em todas as guias e conclui', () => {
    const estado = preparado();
    marcarTudo(estado);
    expect(estado.atual().id).toBe('conferir');
    expect(estado.oQueFalta()).toBe('Clique em Verificar para continuar.');
    estado.verificar();
    expect(estado.divergencias()).toEqual([]);
    expect(estado.testes().map(t => t.ok)).toEqual([true, true]);
    expect(estado.resumo('conferir')).toBe('Sem divergência');

    estado.proximo();
    const final = estado.mapeamentoFinal()!;
    expect(final.versao).toBe(5);
    expect(final.arquivosModelo).toEqual(['a.csv', 'b.csv']);
    expect(final.cnpj.identificador).toBe('cpf');
    expect(final.divergencias).toBeUndefined();
  });

  it('mudar depois de verificar exige verificar de novo', () => {
    const estado = preparado();
    marcarTudo(estado);
    estado.verificar();
    estado.irParaEtapa('termos');
    estado.removerTermo('DOCUMENTO DE ARRECADACAO');
    estado.aplicarSelecao(celula(estado, 'CPF'));
    estado.irParaEtapa('valor');
    estado.irParaEtapa('conferir');
    expect(estado.verificacaoVencida()).toBeTrue();
    expect(estado.oQueFalta()).toBe('Você mudou o mapeamento. Verifique de novo para continuar.');
  });

  it('guia em que o mapeamento não funciona vira divergência', () => {
    const estado = new EditorV5State();
    estado.adicionarModelo(modelo('a.csv', guia('529.982.247-25', '1.100,00')));
    estado.adicionarModelo(modelo('b.csv', guia('111.444.777-35', '250,00', 'SIMPLES NACIONAL')));
    estado.nome.set('DARF');
    marcarTudo(estado);
    estado.verificar();
    expect(estado.divergencias()).toEqual(['Divergência Encontrada: na guia b.csv, termo "RECEITA FEDERAL" ausente.']);
    expect(estado.mapeamentoFinal()?.divergencias?.length).toBe(1);
  });

  it('trocar a guia principal leva as marcações junto', () => {
    const estado = preparado();
    marcarTudo(estado);
    estado.tornarPrincipal('b.csv');
    expect(estado.principal()!.nome).toBe('b.csv');
    expect(estado.construidos().cnpj?.campo?.exemplo).toBe('111.444.777-35');
    expect(estado.construidos().valor?.campo?.exemplo).toBe('250.00');
    expect(estado.termos().length).toBe(2);
  });

  it('nas guias de conferência, marca onde o mapeamento leu', () => {
    const estado = preparado();
    marcarTudo(estado);
    estado.exibido.set(1);
    const marcadas = [...estado.marcas().entries()].map(([id, m]) => [estado.modeloExibido()!.planilha.celulas[id].texto, m.papel]);
    expect(marcadas).toEqual(jasmine.arrayWithExactContents([
      ['RECEITA FEDERAL', 'termo'],
      ['DOCUMENTO DE ARRECADACAO', 'termo'],
      ['111.444.777-35', 'valor'],
      ['09/2026', 'valor'],
      ['250,00', 'valor'],
    ]));
  });

  it('reabre um serviço: nome, exclusões e marcações na guia principal', () => {
    const feito = preparado();
    marcarTudo(feito);
    feito.verificar();
    const salvo: MapeamentoSalvo = { id: 'x', versao: 5, nome: 'DARF', criadoEm: '', atualizadoEm: '', mapeamento: { ...feito.mapeamentoFinal()!, exclusoes: ['SIMPLES NACIONAL'] } };

    const estado = new EditorV5State();
    estado.abrirAnterior(salvo);
    expect(estado.nome()).toBe('DARF');
    estado.adicionarModelo(modelo('c.csv', guia('529.982.247-25', '77,00')));
    expect(estado.construidos().valor?.campo?.exemplo).toBe('77.00');
    expect(estado.termos().length).toBe(2);
    expect(estado.exclusoes()).toEqual(['SIMPLES NACIONAL']);
    expect(estado.anterior()).toBe(salvo);
  });

  it('exclusão que aparece nas próprias guias impede concluir', () => {
    const estado = preparado();
    marcarTudo(estado);
    estado.verificar();
    expect(estado.podeConcluir()).toBeTrue();
    estado.alternarExclusao('receita federal');
    expect(estado.exclusoesInfo()[0].nosModelos).toEqual(['a.csv', 'b.csv']);
    expect(estado.podeConcluir()).toBeFalse();
    estado.alternarExclusao('RECEITA FEDERAL');
    expect(estado.exclusoes()).toEqual([]);
  });
});
