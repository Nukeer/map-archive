import { TestBed } from '@angular/core/testing';
import { MAPEAMENTOS_DB_NOME, MapeamentosDbService } from './mapeamentos-db.service';
import { MapeamentoPdf } from '../pdf-mapeamento/pdf-mapeamento.model';
import { MapeamentoPdfV2 } from '../pdf-mapeamento-v2/mapeamento-v2';

const v1: MapeamentoPdf = {
  nome: 'DARF',
  arquivoExemplo: 'darf.pdf',
  cnpj: { rotulo: 'cnpj:', ocorrenciaRotulo: 1, indiceAposRotulo: 1, exemplo: '12.345.678/0001-90' },
  competencia: { rotulo: 'apuracao:', ocorrenciaRotulo: 1, indiceAposRotulo: 1, exemplo: '09/2026' },
  valor: { rotulo: 'total', ocorrenciaRotulo: 1, indiceAposRotulo: 4, exemplo: '1134.56' },
  termos: ['RECEITA FEDERAL', 'DOCUMENTO DE ARRECADAÇÃO'],
};

const celula = { pagina: 1, linha: 1, coluna: 0 };
const v2: MapeamentoPdfV2 = {
  versao: 2,
  nome: 'Guia DAS',
  cnpj: { inicio: celula, fim: celula, exemplo: '12.345.678/0001-90' },
  competencia: { inicio: celula, fim: celula, exemplo: '09/2026' },
  valor: { inicio: celula, fim: celula, exemplo: '10.00' },
  termos: [{ texto: 'SIMPLES NACIONAL', celula }],
};

describe('MapeamentosDbService', () => {
  let db: MapeamentosDbService;
  let nomeBanco: string;

  beforeEach(() => {
    nomeBanco = `map-archive-teste-${Math.random().toString(36).slice(2)}`;
    TestBed.configureTestingModule({ providers: [{ provide: MAPEAMENTOS_DB_NOME, useValue: nomeBanco }] });
    db = TestBed.inject(MapeamentosDbService);
  });

  afterEach(async () => {
    await db.fechar();
    await new Promise(resolve => {
      const pedido = indexedDB.deleteDatabase(nomeBanco);
      pedido.onsuccess = pedido.onerror = resolve;
    });
  });

  it('salva e lista mapeamentos v1 e v2 com a versão detectada', async () => {
    const a = await db.salvar(v1);
    const b = await db.salvar(v2);
    expect(a.versao).toBe(1);
    expect(b.versao).toBe(2);
    expect(a.arquivoExemplo).toBe('darf.pdf');

    const todos = await db.listar();
    expect(todos.map(r => r.id).sort()).toEqual([a.id, b.id].sort());
    expect((await db.obter(a.id))?.mapeamento).toEqual(v1);
  });

  it('filtra por nome do tipo de documento', async () => {
    await db.salvar(v1);
    await db.salvar(v2);
    const darfs = await db.listarPorNome('DARF');
    expect(darfs.length).toBe(1);
    expect(darfs[0].mapeamento).toEqual(v1);
  });

  it('atualiza mantendo a data de criação e exclui', async () => {
    const original = await db.salvar(v1);
    const atualizado = await db.salvar({ ...v1, termos: ['RECEITA FEDERAL', 'DARF'] }, original.id);
    expect(atualizado.criadoEm).toBe(original.criadoEm);
    expect((await db.listar()).length).toBe(1);
    expect((await db.obter(original.id))?.mapeamento.termos).toEqual(['RECEITA FEDERAL', 'DARF']);

    await db.excluir(original.id);
    expect(await db.listar()).toEqual([]);
  });

  it('registra cada conclusão no histórico, com divergências e responsável', async () => {
    const criado = await db.salvar(v2, undefined, { responsavel: 'Ana' });
    expect(criado.situacao).toBe('mapeado');
    expect(criado.historico).toEqual([
      jasmine.objectContaining({ acao: 'criado', responsavel: 'Ana', termos: ['SIMPLES NACIONAL'], divergencias: [], gestorNotificado: false }),
    ]);

    const divergencia = 'Divergência Encontrada: O termo identificado no documento não corresponde ao mapeado anteriormente para este layout.';
    const alterado = await db.salvar(v2, criado.id, { responsavel: 'Bruno', divergencias: [divergencia] });
    expect(alterado.situacao).toBe('com-divergencia');
    expect(alterado.historico!.map(h => [h.acao, h.responsavel, h.gestorNotificado])).toEqual([
      ['criado', 'Ana', false],
      ['alterado', 'Bruno', true],
    ]);
    expect(alterado.historico![1].divergencias).toEqual([divergencia]);
    expect((await db.obter(criado.id))?.historico?.length).toBe(2);
  });
});
