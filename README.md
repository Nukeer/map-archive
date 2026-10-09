# MapArchive

Mapeia documentos de guias (DARF, DAS, GPS, boletos...) em PDF, CSV ou TXT a partir de um documento
modelo e depois verifica se outros documentos são do mesmo tipo, extraindo o **identificador**
(CNPJ, CPF, CAEPF, CNO, IE ou IM), a **competência** e o **valor a pagar**.

É o protótipo do assistente **Mapear Documentos** do Tareffa (Cadastros Gerais › Serviços ›
Integrações); ver [Fluxo do assistente](#fluxo-do-assistente-mapear-documentos).

Tudo roda no navegador: os mapeamentos ficam no IndexedDB (`map-archive`), o PDF é lido com
`pdfjs-dist` e nada é enviado para servidor.

Cada forma de mapear/validar é uma **versão** separada, para comparar qual funciona melhor.
As versões convivem: mapeamentos antigos continuam funcionando e o match escolhe a lógica
pela versão salva (`versao` no registro).

## Fluxo do assistente "Mapear Documentos"

Segue as premissas do Tareffa. O assistente é o modal da v2, reaproveitado pela v3, v4 e v5.

| Premissa | Como está no protótipo |
|---|---|
| Documento visível à esquerda, etapas à direita | Abas PDF, Blocos e Planilha à esquerda; etapas no painel da direita |
| Etapas: identificador → competência → termos → valor → validação | Nessa ordem, depois de "Documento" (arquivo e nome do serviço) |
| Identificador CNPJ/CPF/CAEPF/CNO/IE/IM | `pdf-mapeamento/identificador.ts`. Detecta CNPJ (inclusive o alfanumérico de jul/2026), CPF, CAEPF e CNO pela máscara ou, sem máscara, pelo DV. IE e IM são escolhidos no seletor da etapa, porque variam por estado e município e se confundem com qualquer número |
| Mínimo de 2 termos | Mantido |
| **Verificar** → **Concluir Mapeamento** | Na etapa Validação, o botão Verificar roda `pdf-mapeamento-v2/verificacao.ts`. Sem divergência, libera Concluir Mapeamento. Qualquer edição depois exige verificar de novo |
| Divergência + **Concluir com Divergência** | Cada item mostra o que divergiu e um link "Voltar e editar". Com divergência, o botão vira Concluir com Divergência |
| Alerta em tela + notificação ao gestor | Alerta na página ao concluir. A notificação pela Central de Notificações é do Tareffa: aqui fica registrada no histórico ("gestor notificado") |
| **Histórico de Mapeamentos** (termos, data/hora, responsável) | Botão em cada serviço. Uma entrada por conclusão, com ação (criado/alterado), versão, arquivo e divergências. O responsável vem do campo no topo da página (no Tareffa, o usuário logado) |
| **Mapear Documentos** de um serviço existente | Reabre o assistente da mesma versão com o que estava marcado. Concluir atualiza o mesmo registro e soma ao histórico (um layout por serviço e versão) |
| PDF editável, CSV, TXT | `pdf-mapeamento/documento-texto.ts`. CSV (`;`, `,`, tab ou `|`, com aspas) e TXT (UTF-8 ou Windows-1252) viram páginas de texto monoespaçado com as mesmas caixas do PDF, então planilha, blocos, extração e a seleção por clique funcionam igual |

O que a validação confere:

- **No próprio documento:** o mapeamento relê cada campo na posição marcada; DV do CNPJ/CPF (ou formato dos outros identificadores); competência entre 01/2000 e dezembro do ano seguinte; valor maior que zero.
- **Contra o mapeamento anterior do mesmo serviço** (mesmo nome): os termos anteriores precisam aparecer no documento. Se não aparecerem: "Divergência Encontrada: O termo identificado no documento não corresponde ao mapeado anteriormente para este layout". Também conferem o mesmo tipo de identificador e se o mapeamento anterior lê os campos no mesmo lugar que o novo. Termos incluídos ou removidos aparecem como informação, sem divergência.

Fora do protótipo, por dependerem do Tareffa ou de decisão:

- **Imagem e PDF digitalizado:** precisam de OCR. Hoje o assistente avisa que o documento não tem texto.
- **ZIP/RAR/com senha:** continua a regra do nome do arquivo.
- **Campos legados:** fechar os campos legados da aba Integrações quando o cliente adota o assistente. O mapeamento aqui é um "modelo mapeado" que estende a configuração (posições, rótulos, assinatura) e não cabe nos campos legados.
- **Log de Documentos Publicados:** coluna Valor Documento, status Pendente de mapeamento / Mapeado / Com divergência e ação Mapear Documentos. Na verificação, o veredito "duvidoso" (v3+) é o candidato natural a "Com divergência no mapeamento".
- **CAEPF e CNO:** são conferidos só pelo formato. O DV deles tem regra própria, que não foi implementada.
- **v1:** detecta CNPJ/CPF/CAEPF/CNO, mas não tem as etapas novas (é o modal legado de texto corrido).

## Bancada de testes

Aba **Bancada de testes** (`src/app/bancada/`). Mede quanto cada versão acerta nos mesmos documentos, para comparar v1 a v5 e
para ter um número antes e depois de qualquer ajuste (limites, pesos, blocos).

1. **Adicionar documentos** (PDF, CSV, TXT): guias de vários tipos, inclusive de tipos que não devem ser reconhecidos.
2. **Gabarito:** o tipo certo de cada documento (um dos serviços salvos ou "Outro tipo") e, opcionalmente, os valores certos
   de identificador, competência e valor. "Usar valores lidos" copia o que o mapeamento leu, para conferir e corrigir.
3. **Executar bancada:** roda todos os mapeamentos salvos em todos os documentos com gabarito.

Cada documento recebe, em cada versão, um desfecho:

| Desfecho | Quando | Conta como |
|---|---|---|
| Tipo certo | Só mapeamentos do tipo certo aceitaram | acerto |
| Rejeitado corretamente | Documento de "outro tipo" e ninguém aceitou | acerto |
| Não reconhecido | A versão tem o tipo certo mapeado, mas ninguém aceitou | erro |
| Tipo errado | Só mapeamento de outro tipo aceitou | erro |
| Ambíguo | Mais de um tipo aceitou | erro |
| Falso positivo | Documento de outro tipo (ou de tipo que a versão não mapeou) aceito | erro |
| Sem mapeamento | A versão não tem o tipo do documento e não aceitou nada | fora da conta |

O placar mostra, por versão:
- a taxa de acerto, que é (tipo certo + rejeitado corretamente) ÷ avaliados;
- a contagem de cada erro;
- os "duvidosos" (v3+);
- os campos certos contra o gabarito;
- a variação em relação à execução anterior.

A versão com maior taxa ganha ★. Abaixo do placar vem a lista de documentos que mudaram de desfecho
(▲ melhorou, ▼ piorou). Documentos, gabarito e as 20 últimas execuções ficam no IndexedDB
(versão 2 do banco, criada sem perder os mapeamentos da versão 1). O CSV exporta uma linha por documento e versão.

## Versões

| | v1 · texto | v2 · planilha | v3 · assinatura + score | v4 · vários modelos | v5 · aparência + contraste |
|---|---|---|---|---|---|
| Pasta | `src/app/pdf-mapeamento/` | `src/app/pdf-mapeamento-v2/` | `src/app/pdf-mapeamento-v3/` | `src/app/pdf-mapeamento-v4/` | `src/app/pdf-mapeamento-v5/` |
| Como o PDF é visto | Texto corrido (sequência de palavras) | Planilha: uma aba por página, linhas e colunas por posição | Planilha (igual à v2) | Planilha, de 2 a 5 PDFs modelo | Planilha (igual à v4) + miniatura da 1ª página, fontes e metadados |
| Como acha os campos | Rótulo antes do valor + "N-ésimo valor depois do rótulo" | Célula mapeada, confirmada pelo rótulo vizinho; se o layout mudar, procura pelo rótulo, linhas vizinhas ou valor único | Igual à v2 | Igual à v2, conferido em todos os modelos | Igual à v4 |
| Como decide se é o mesmo tipo | Todos os termos escolhidos aparecem no texto | Todos os termos aparecem (a posição só é informada) | **Score** de vários sinais, ver abaixo | Score da v3 + posição dos rótulos | Score da v4 + desenho da página, fontes e programa gerador |
| Resultado | sim / não | sim / não | **corresponde / duvidoso / não** + confiança (%) | Igual à v3 | Igual à v3 |
| O que o usuário informa | Campos e termos | Campos e termos (clicando nas células) | Campos e termos (modal da v2) + termos de exclusão | Igual à v3 + escolhe termos sugeridos | Igual à v4 + escolhe termos e exclusões sugeridos a partir dos outros tipos salvos |
| O que é gerado sozinho | — | Referência de célula e rótulo de cada campo | + assinatura do PDF modelo | Assinatura aprendida: rótulos estáveis × variáveis, posições e tolerâncias, termos sugeridos | + bordas estáveis do desenho, fontes comuns, programa gerador; termos exclusivos e exclusões por contraste com os outros tipos |
| Identificação automática | — | — | Compara o PDF com todos os mapeamentos v3 em diante e ranqueia | Igual à v3 | Igual à v3 |
| Ponto fraco | Quebra se a ordem do texto mudar; termos genéricos dão falso positivo | Termos genéricos ("Receita Federal") aparecem em várias guias e dão falso positivo | Um só PDF modelo: texto variável sem números (ex.: nome da empresa) entra como "rótulo fixo"; código de barras só como imagem não é lido | Pede mais PDFs para mapear; se os modelos forem quase iguais (mesma empresa e mês), aprende pouco | PDF reimpresso ("Imprimir para PDF", digitalizado) muda fontes, produtor e desenho; página muito deslocada muda as bordas; limites calibrados só com dados sintéticos |

### v1 · texto

Concatena as palavras do PDF em um texto normalizado (minúsculo, sem acento). Para cada campo
guarda o rótulo que vem antes do valor, qual ocorrência desse rótulo usar e quantos valores com
o formato do campo pular depois dele. Termos identificadores: todos precisam aparecer.

### v2 · planilha

Converte o PDF numa planilha (`planilha.ts`): linhas visuais e blocos de palavras viram células,
alinhados em colunas pela borda esquerda, direita ou centro. O campo é guardado como célula
(`Pág.1!B3`) mais o rótulo vizinho (na própria célula, à esquerda ou cabeçalho acima). Na
extração tenta, em ordem: posição confirmada pelo rótulo → a partir do rótulo → posição sem
confirmação → linhas vizinhas → único valor daquele formato no documento.

Como as colunas valem para a página inteira, a planilha completa fica larga e esparsa (uma guia
com 65 textos vira uma grade de 23 × 22). Por isso o modal tem também a aba **Blocos**
(`blocos.ts`): a página é dividida nas regiões do documento por cortes recursivos (XY-cut). Primeiro
vêm faixas separadas por espaços verticais grandes, depois colunas separadas por corredores em
branco e, por último, trechos separados por espaços menores. Não há corte entre colunas de uma
tabela (linhas alinhadas dos dois lados), no meio de uma linha de texto (ex.: linha digitável)
nem entre linhas da mesma tabela (bordas de coluna em comum, ex.: linha de totais). Cada bloco
tem colunas próprias. É só exibição: as referências (`Pág.1!B3`) continuam as da planilha
completa, então os mapeamentos salvos não mudam. A seleção de campos e termos funciona nas três
abas, o CSV da aba Blocos sai com um bloco embaixo do outro e a aba PDF pode contornar os blocos.

### v3 · assinatura + score

Reaproveita o modal e a extração da v2 e acrescenta, ao salvar, uma **assinatura** gerada a partir
do PDF modelo (`mapeamento-v3.ts`):

- **Código de barras / linha digitável**: arrecadação (48 dígitos, começa com 8) ou boleto
  (47 dígitos). Só aceita a sequência se os dígitos verificadores (módulo 10/11 FEBRABAN)
  baterem. Guarda tipo, segmento e órgão (arrecadação) ou banco (boleto).
- **Rótulos do layout**: todo texto fixo do modelo (células com letras e sem valores).
- **Páginas**: quantidade e tamanho da 1ª página.
- **Termos de exclusão** (informados pelo usuário): não podem aparecer no PDF.

No match, cada sinal recebe nota de -1 a 1 e um peso:

| Sinal | Peso | Regra |
|---|---|---|
| Código de barras | 3 | Tipo + segmento + órgão/banco iguais ao modelo. Diferente **reprova**. Ausente: nota -0,5, peso 1 |
| Layout | 3 | F1 entre rótulos do modelo e do PDF (≥ 0,8 a favor, 0,5 neutro, ≤ 0,2 contra). Peso 1 se o modelo tiver menos de 5 rótulos |
| Termos identificadores | 2 | Todos presentes e na posição: 1; presentes fora da posição: 0,5; faltando: -1 |
| Campos extraídos | 2 | Proporção de campos válidos: DV do CNPJ, competência entre 2000 e o ano seguinte, valor > 0 |
| Valor × código de barras | 1 | Valor extraído igual ao valor dentro do código de barras |
| Páginas | 1 | Mesmo tamanho e quantidade: 1; só o tamanho: 0; tamanho diferente: -1 |
| Termos de exclusão | — | Algum encontrado **reprova** |

`confiança = (Σ peso × nota / Σ peso + 1) / 2`. Com confiança ≥ 75% o PDF **corresponde**,
entre 50% e 75% fica **duvidoso** (aparece em amarelo, para revisão) e abaixo disso **não**.
Os limites e pesos ficam no topo de `mapeamento-v3.ts` (`PESOS`, `CONFIANCA_ACEITA`,
`CONFIANCA_DUVIDOSA`).

No match, a opção **Identificar automaticamente** roda todos os mapeamentos v3 em diante contra o PDF e
mostra um ranking. Se mais de um aceitar o PDF, avisa que os mapeamentos estão parecidos demais
(sinal de que faltam termos de exclusão).

### v4 · vários modelos

Recebe de 2 a 5 PDFs do mesmo tipo (de preferência de empresas e meses diferentes). Os campos e
termos são marcados no 1º, no modal da v2, e a assinatura é **aprendida comparando todos**
(`mapeamento-v4.ts`):

- **Rótulos estáveis × variáveis**: só entra na assinatura o texto fixo que aparece em todos os
  modelos. O que muda (nome da empresa, por exemplo) fica em `rotulosVariaveis` e sai da conta.
  Isso resolve o ponto fraco da v3. Na precisão do layout valem todos os rótulos já vistos
  (`rotulosConhecidos`).
- **Código de barras**: só é usado se os modelos que têm linha digitável concordarem no emissor.
- **Posição dos rótulos**: para cada rótulo estável que aparece uma vez só, guarda o centro na
  página (0..1) e uma tolerância de `max(1,5%, 2 × variação entre os modelos)`. O deslocamento
  geral de cada modelo (margens diferentes) é descontado antes, pela mediana.
- **Conferência**: o mapeamento é aplicado em todos os modelos e a tela mostra os campos
  extraídos de cada um. Se falhar em algum, o mapeamento provavelmente não generaliza.
- **Termos sugeridos**: rótulos estáveis com mais de uma palavra. É só marcar para virarem termos.

No match usa o score da v3 (com os rótulos estáveis) e um sinal a mais:

| Sinal | Peso | Regra |
|---|---|---|
| Posição dos rótulos | 2 | Fração dos rótulos posicionados que estão no lugar, descontando o deslocamento da página (≥ 80% a favor, 50% neutro, ≤ 20% contra). Informativo se forem menos de 3 |

Pega PDFs com os mesmos textos em outra disposição, que a v3 aceitaria.

### v5 · aparência + contraste

Mesmo fluxo da v4 (2 a 5 modelos, campos e termos no 1º). Ao carregar, cada modelo também é
**desenhado** (`PdfDocumentoService.aparencia()`, `aparencia.ts`), e a assinatura ganha
(`mapeamento-v5.ts`):

- **Desenho da página**: a 1ª página vira uma miniatura em tons de cinza, reduzida a uma grade
  16 × 16. Cada par de células vizinhas (na horizontal e na vertical, 512 comparações) vira 1 se
  elas diferem, ou seja, se ali passa uma borda (linha, caixa, bloco de texto). É uma variação do
  dHash: área branca dá 0 dos dois lados e não conta. Só ficam as bordas **iguais em todos os
  modelos** (máscara), então o texto que muda (empresa, valores) sai da conta, como os rótulos
  variáveis da v4.
- **Fontes**: nomes das fontes da 1ª página, sem o prefixo de subconjunto (`ABCDEF+Arial-BoldMT`
  → `arial-boldmt`). Entram as comuns a todos os modelos; as de qualquer modelo são "conhecidas".
- **Programa gerador**: `Producer` (ou `Creator`) dos metadados, sem número de versão, se for o
  mesmo em todos os modelos.
- **Contraste com os outros tipos salvos**: os mapeamentos de outros nomes são agrupados por tipo
  (rótulos da assinatura + termos). Para cada tipo, mostra quanto dos rótulos dele aparece nos
  modelos. Sugere como **termos** os rótulos estáveis deste tipo, os exclusivos primeiro (um
  termo que o outro tipo também tem não separa nada). Dos tipos **parecidos** (≥ 30% dos rótulos
  presentes), sugere como **exclusões** os rótulos que nenhum modelo tem. Ataca direto o caso
  DARF × DAS.

No match usa o score da v4 e mais três sinais:

| Sinal | Peso | Regra |
|---|---|---|
| Desenho da página | 2 | Jaccard entre as bordas estáveis do modelo e as do PDF, só nas posições da máscara (≥ 80% a favor, 50% neutro, ≤ 20% contra) |
| Fontes | 1 | F1 entre as fontes comuns do modelo e as do PDF (precisão contra as conhecidas), mesma escala |
| Programa gerador | 0,5 | Igual: 1; diferente: -1; PDF sem metadado: informativo |

A aparência só é lida quando algum mapeamento v5 vai ser usado, porque desenhar a página custa.
Se o PDF não puder ser desenhado, os sinais ficam informativos e vale o score da v4. Pesos e
limites ficam no topo de `mapeamento-v5.ts` e `aparencia.ts`. Por enquanto foram calibrados só
com formulários sintéticos dos testes, onde o mesmo formulário com outros dados dá cerca de 97%
das bordas em comum e um formulário diferente, cerca de 18%. Confira com guias reais.

## Ideias para a v6

1. **Aprender com as correções.** Quando o usuário confirma ou recusa um resultado "duvidoso",
   o caso vira mais um modelo ou um contraexemplo, e os pesos/limites daquele mapeamento são
   ajustados. Exige guardar os dados dos modelos (planilha e aparência), não só a assinatura.
2. **Linhas e caixas do formulário.** Ler os retângulos e linhas da lista de operações do pdf.js
   (`getOperatorList`) em vez da miniatura: mais preciso que a grade 16 × 16 e não depende da
   resolução.
3. **Contraste no match.** Usar os outros tipos também na verificação: um rótulo exclusivo do
   tipo vizinho presente no PDF pesa contra, sem precisar virar termo de exclusão.

## Desenvolvimento

```bash
npm install
npm start          # http://localhost:4200
npm test           # Karma (Chrome)
npm run build      # saída em dist/
```

Para testar sem abrir o navegador: `npx ng test --watch=false --browsers=ChromeHeadless`.

### Criando uma nova versão

1. Criar `src/app/pdf-mapeamento-vN/` com o modelo (`MapeamentoPdfVN`, `versao: N`), o modal
   e o spec.
2. Incluir o tipo em `MapeamentoQualquer` e `versao` em `armazenamento/mapeamentos-db.service.ts`.
3. Adicionar o ramo `versao === N` em `verificarComScore` ou `verificarDocumento` (`match/match.ts`).
   Versões a partir da 3 decidem por score (`temScore`) e entram na identificação automática. Se
   precisar da aparência do PDF, incluir em `usaAparencia`.
4. Adicionar o botão e o modal em `app.component`.
5. Documentar a versão na tabela acima.
