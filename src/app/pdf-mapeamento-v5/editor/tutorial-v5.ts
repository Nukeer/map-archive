import type { EtapaV5 } from './editor-v5.state';

export interface TutorialEtapa {
  /** Frase curta do cartão. */
  titulo: string;
  /** Explicação de uma ou duas linhas. */
  texto: string;
}

export const TUTORIAIS_V5: Record<EtapaV5, TutorialEtapa> = {
  documentos: {
    titulo: 'Escolha guias do mesmo tipo',
    texto: 'Duas a cinco guias, de preferência de empresas e meses diferentes: o que se repete em todas é o formato da guia; o que muda são os dados.',
  },
  identificador: {
    titulo: 'Onde está o contribuinte?',
    texto: 'Clique no CNPJ, CPF, CAEPF ou CNO. Eu reconheço o tipo pelo formato. Para IE ou IM, escolha o tipo antes.',
  },
  competencia: {
    titulo: 'De que mês é a guia?',
    texto: 'Clique na competência ou no período de apuração. Se ele quebrar em duas linhas, arraste da primeira à última.',
  },
  termos: {
    titulo: 'O que só esta guia tem?',
    texto: 'Clique em pelo menos dois textos fixos (ex.: "Documento de Arrecadação de Receitas Federais"). Os sugeridos já vêm conferidos contra os outros tipos.',
  },
  valor: {
    titulo: 'Quanto se paga?',
    texto: 'Clique no valor total a pagar.',
  },
  conferir: {
    titulo: 'Vamos ver se funciona em todas',
    texto: 'Clique em Verificar: eu leio cada guia com o que você marcou e comparo com o mapeamento anterior do serviço.',
  },
  concluir: {
    titulo: 'Confira e conclua',
    texto: 'Se algo divergiu, dá para voltar e corrigir ou concluir mesmo assim: fica no histórico e o gestor é avisado.',
  },
};

const CHAVE_OCULTO = 'map-archive.tutorialV5.oculto';

/** "Não mostrar de novo" fica neste navegador. Sem acesso ao armazenamento, o tutorial volta a aparecer. */
export function tutorialOculto(): boolean {
  try {
    return localStorage.getItem(CHAVE_OCULTO) === 'true';
  } catch {
    return false;
  }
}

export function ocultarTutorial(): void {
  try {
    localStorage.setItem(CHAVE_OCULTO, 'true');
  } catch {
    // Sem armazenamento: vale só até fechar a tela.
  }
}
