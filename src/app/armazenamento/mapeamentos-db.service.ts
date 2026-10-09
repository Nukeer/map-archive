import { Inject, Injectable, InjectionToken, Optional } from '@angular/core';
import { MapeamentoPdf } from '../pdf-mapeamento/pdf-mapeamento.model';
import { MapeamentoPdfV2 } from '../pdf-mapeamento-v2/mapeamento-v2';
import { MapeamentoPdfV3 } from '../pdf-mapeamento-v3/mapeamento-v3';
import { MapeamentoPdfV4 } from '../pdf-mapeamento-v4/mapeamento-v4';
import { MapeamentoPdfV5 } from '../pdf-mapeamento-v5/mapeamento-v5';

/** Nome do banco IndexedDB. Substituível em testes. */
export const MAPEAMENTOS_DB_NOME = new InjectionToken<string>('MAPEAMENTOS_DB_NOME');

const NOME_PADRAO = 'map-archive';
const VERSAO_DB = 1;
const STORE = 'mapeamentos';

export type MapeamentoQualquer = MapeamentoPdf | MapeamentoPdfV2 | MapeamentoPdfV3 | MapeamentoPdfV4 | MapeamentoPdfV5;

/** Registro salvo no navegador, com o resultado do mapeamento para o match de arquivos depois. */
export interface MapeamentoSalvo {
  id: string;
  /**
   * 1 = rótulo/texto, 2 = linha/coluna na planilha, 3 = v2 + assinatura do PDF e score, 4 = v3 com vários modelos,
   * 5 = v4 + aparência (desenho, fontes, programa gerador) e contraste com os outros tipos.
   */
  versao: 1 | 2 | 3 | 4 | 5;
  /** Nome do tipo de documento (ex.: "DARF"). */
  nome: string;
  arquivoExemplo?: string;
  criadoEm: string;
  atualizadoEm: string;
  mapeamento: MapeamentoQualquer;
  /** Situação do último mapeamento. Ausente em registros antigos = mapeado. */
  situacao?: SituacaoMapeamento;
  /** "Histórico de Mapeamentos": uma entrada por conclusão do assistente, da mais antiga para a mais nova. */
  historico?: EntradaHistorico[];
}

export type SituacaoMapeamento = 'mapeado' | 'com-divergencia';

export interface EntradaHistorico {
  /** ISO 8601. */
  dataHora: string;
  responsavel: string;
  acao: 'criado' | 'alterado';
  versao: MapeamentoSalvo['versao'];
  /** Termos de integração mapeados nesta conclusão. */
  termos: string[];
  arquivo?: string;
  /** Divergências aceitas em "Concluir com Divergência"; vazio = concluído sem divergência. */
  divergencias: string[];
  /** Com divergência, o gestor do departamento do serviço é notificado (no protótipo, só registrado). */
  gestorNotificado: boolean;
}

/** Quem concluiu e o que ficou divergente; vira uma entrada do histórico. */
export interface Conclusao {
  responsavel: string;
  divergencias?: string[];
}

export function versaoDoMapeamento(mapeamento: MapeamentoQualquer): MapeamentoSalvo['versao'] {
  return 'versao' in mapeamento ? mapeamento.versao : 1;
}

/** Guarda os mapeamentos no IndexedDB do navegador. */
@Injectable({ providedIn: 'root' })
export class MapeamentosDbService {
  private conexao: Promise<IDBDatabase> | null = null;
  private readonly nomeBanco: string;

  constructor(@Optional() @Inject(MAPEAMENTOS_DB_NOME) nomeBanco: string | null) {
    this.nomeBanco = nomeBanco ?? NOME_PADRAO;
  }

  /**
   * Cria um registro novo ou, se `id` for informado, substitui o existente mantendo a data de
   * criação e o histórico. Com `conclusao`, acrescenta uma entrada ao histórico.
   */
  async salvar(mapeamento: MapeamentoQualquer, id?: string, conclusao?: Conclusao): Promise<MapeamentoSalvo> {
    const agora = new Date().toISOString();
    const anterior = id ? await this.obter(id) : undefined;
    const divergencias = conclusao?.divergencias ?? [];
    const versao = versaoDoMapeamento(mapeamento);
    const termos = (mapeamento.termos as Array<string | { texto: string }>).map(t => (typeof t === 'string' ? t : t.texto));
    const entrada: EntradaHistorico | null = conclusao
      ? {
          dataHora: agora,
          responsavel: conclusao.responsavel,
          acao: anterior ? 'alterado' : 'criado',
          versao,
          termos,
          arquivo: mapeamento.arquivoExemplo,
          divergencias,
          gestorNotificado: divergencias.length > 0,
        }
      : null;
    const registro: MapeamentoSalvo = {
      id: id ?? crypto.randomUUID(),
      versao,
      nome: mapeamento.nome,
      arquivoExemplo: mapeamento.arquivoExemplo,
      criadoEm: anterior?.criadoEm ?? agora,
      atualizadoEm: agora,
      mapeamento,
      situacao: conclusao ? (divergencias.length ? 'com-divergencia' : 'mapeado') : anterior?.situacao,
      historico: [...(anterior?.historico ?? []), ...(entrada ? [entrada] : [])],
    };
    await this.executar('readwrite', store => store.put(registro));
    return registro;
  }

  /** Todos os mapeamentos, do mais recente para o mais antigo. */
  async listar(): Promise<MapeamentoSalvo[]> {
    const registros = await this.executar<MapeamentoSalvo[]>('readonly', store => store.getAll());
    return registros.sort((a, b) => b.atualizadoEm.localeCompare(a.atualizadoEm));
  }

  /** Mapeamentos de um tipo de documento (nome), para o match. */
  async listarPorNome(nome: string): Promise<MapeamentoSalvo[]> {
    return this.executar<MapeamentoSalvo[]>('readonly', store => store.index('nome').getAll(nome));
  }

  obter(id: string): Promise<MapeamentoSalvo | undefined> {
    return this.executar<MapeamentoSalvo | undefined>('readonly', store => store.get(id));
  }

  async excluir(id: string): Promise<void> {
    await this.executar('readwrite', store => store.delete(id));
  }

  /** Fecha a conexão (usado em testes antes de apagar o banco). */
  async fechar(): Promise<void> {
    const conexao = this.conexao;
    this.conexao = null;
    (await conexao)?.close();
  }

  private abrir(): Promise<IDBDatabase> {
    this.conexao ??= new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('Este navegador não suporta IndexedDB.'));
        return;
      }
      const pedido = indexedDB.open(this.nomeBanco, VERSAO_DB);
      pedido.onupgradeneeded = () => {
        const store = pedido.result.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('nome', 'nome');
        store.createIndex('versao', 'versao');
      };
      pedido.onsuccess = () => resolve(pedido.result);
      pedido.onerror = () => reject(pedido.error);
      pedido.onblocked = () => reject(new Error('Banco local bloqueado por outra aba aberta.'));
    });
    this.conexao.catch(() => (this.conexao = null));
    return this.conexao;
  }

  private async executar<T>(modo: IDBTransactionMode, operacao: (store: IDBObjectStore) => IDBRequest): Promise<T> {
    const db = await this.abrir();
    return new Promise<T>((resolve, reject) => {
      const transacao = db.transaction(STORE, modo);
      const pedido = operacao(transacao.objectStore(STORE));
      transacao.oncomplete = () => resolve(pedido.result as T);
      transacao.onerror = () => reject(transacao.error ?? pedido.error);
      transacao.onabort = () => reject(transacao.error ?? new Error('Operação no banco local cancelada.'));
    });
  }
}
