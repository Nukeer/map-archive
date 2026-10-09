import type { MapeamentoSalvo } from '../armazenamento/mapeamentos-db.service';
import { normalizarTexto } from '../pdf-mapeamento/extrator';
import { IDENTIFICADORES, nomeIdentificador } from '../pdf-mapeamento/identificador';
import { CAMPOS, CampoMapeavel } from '../pdf-mapeamento/pdf-mapeamento.model';
import { campoValido } from '../pdf-mapeamento-v3/mapeamento-v3';
import { CampoMapeadoV2, MapeamentoPdfV2, extrairCampoV2, termoPresente } from './mapeamento-v2';
import { Planilha, descreverIntervalo } from './planilha';

/**
 * Etapa "Validação" do assistente: confere o mapeamento no próprio documento e contra o
 * mapeamento anterior do mesmo layout (serviço). O que não confere é divergência: o usuário
 * volta e corrige, ou conclui com divergência.
 */
export interface ItemVerificacao {
  /** Etapa do assistente onde o item é corrigido. */
  etapa: CampoMapeavel | 'termos';
  titulo: string;
  ok: boolean;
  /** Divergências, cada uma pronta para exibir; vazio quando `ok`. */
  divergencias: string[];
  /** Resumo do que foi conferido (ou mudanças que não são divergência). */
  detalhe: string;
}

const PREFIXO = 'Divergência Encontrada: ';

export function verificarMapeamento(
  planilha: Planilha,
  mapeamento: MapeamentoPdfV2,
  anterior: MapeamentoSalvo | null,
  hoje = new Date(),
): ItemVerificacao[] {
  const campos = Object.fromEntries(CAMPOS.map(c => [c.chave, verificarCampo(planilha, mapeamento, c.chave, anterior, hoje)]));
  return [campos['cnpj'], campos['competencia'], verificarTermos(planilha, mapeamento, anterior), campos['valor']];
}

function verificarCampo(
  planilha: Planilha,
  mapeamento: MapeamentoPdfV2,
  chave: CampoMapeavel,
  anterior: MapeamentoSalvo | null,
  hoje: Date,
): ItemVerificacao {
  const campo = mapeamento[chave];
  const identificador = mapeamento.cnpj.identificador;
  const titulo = chave === 'cnpj' ? nomeIdentificador(identificador) : CAMPOS.find(c => c.chave === chave)!.rotulo;
  const onde = descreverIntervalo(campo.inicio, campo.fim);
  const divergencias: string[] = [];

  const relido = extrairCampoV2(planilha, chave, campo);
  if (relido?.valor !== campo.exemplo) {
    divergencias.push(`${titulo} marcado em ${onde} (${campo.exemplo}) não é relido pelo mapeamento; foi lido ${relido?.valor ?? 'nada'}.`);
  }
  if (!campoValido(chave, campo.exemplo, hoje, identificador)) divergencias.push(invalido(chave, campo.exemplo, titulo, hoje, mapeamento));

  const campoAnterior = anterior?.mapeamento[chave];
  if (chave === 'cnpj' && anterior) {
    const tipoAnterior = anterior.mapeamento.cnpj.identificador ?? 'cnpj';
    if (tipoAnterior !== (identificador ?? 'cnpj')) {
      divergencias.push(`o mapeamento anterior deste layout usava ${nomeIdentificador(tipoAnterior)}; agora foi marcado ${titulo}.`);
    }
  }
  if (campoAnterior && 'inicio' in campoAnterior) {
    const pelaRegraAnterior = extrairCampoV2(planilha, chave, campoAnterior as CampoMapeadoV2);
    const ondeAntes = descreverIntervalo(campoAnterior.inicio, campoAnterior.fim);
    if (!pelaRegraAnterior) {
      divergencias.push(`o mapeamento anterior (${ondeAntes}) não encontra ${titulo} neste documento.`);
    } else if (pelaRegraAnterior.valor !== campo.exemplo) {
      divergencias.push(`o mapeamento anterior lê ${titulo} em ${ondeAntes} (${pelaRegraAnterior.valor}), diferente do marcado agora em ${onde} (${campo.exemplo}).`);
    }
  }

  return {
    etapa: chave,
    titulo,
    ok: !divergencias.length,
    divergencias: divergencias.map(d => PREFIXO + d),
    detalhe: `${onde} → ${campo.exemplo}`,
  };
}

function invalido(chave: CampoMapeavel, valor: string, titulo: string, hoje: Date, mapeamento: MapeamentoPdfV2): string {
  if (chave === 'competencia') return `a competência ${valor} está fora do período aceito (01/2000 a 12/${hoje.getFullYear() + 1}).`;
  if (chave === 'valor') return 'o valor a pagar marcado é zero.';
  const formato = IDENTIFICADORES[mapeamento.cnpj.identificador ?? 'cnpj'];
  return formato.tipo === 'cnpj' || formato.tipo === 'cpf'
    ? `o ${titulo} ${valor} tem dígito verificador inválido.`
    : `o ${titulo} ${valor} não tem o formato esperado (${formato.mascara}).`;
}

function verificarTermos(planilha: Planilha, mapeamento: MapeamentoPdfV2, anterior: MapeamentoSalvo | null): ItemVerificacao {
  const atuais = mapeamento.termos.map(t => t.texto);
  const divergencias: string[] = [];
  let detalhe = `${atuais.length} termos: ${atuais.join(', ')}`;

  if (anterior) {
    const anteriores = (anterior.mapeamento.termos as Array<string | { texto: string }>).map(t => (typeof t === 'string' ? t : t.texto));
    for (const termo of anteriores.filter(t => !termoPresente(planilha, t))) {
      divergencias.push(`${PREFIXO}O termo identificado no documento não corresponde ao mapeado anteriormente para este layout ("${termo}" não aparece neste documento).`);
    }
    const chaves = (lista: string[]) => new Set(lista.map(normalizarTexto));
    const [antes, agora] = [chaves(anteriores), chaves(atuais)];
    const incluidos = atuais.filter(t => !antes.has(normalizarTexto(t)));
    const removidos = anteriores.filter(t => !agora.has(normalizarTexto(t)));
    if (incluidos.length || removidos.length) {
      detalhe += ` · em relação ao mapeamento anterior: ${[...incluidos.map(t => `+ ${t}`), ...removidos.map(t => `− ${t}`)].join('; ')}`;
    }
  }
  return { etapa: 'termos', titulo: 'Termos de integração', ok: !divergencias.length, divergencias, detalhe };
}
