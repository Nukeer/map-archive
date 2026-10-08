# MapArchive

Mapeia PDFs de guias (DARF, DAS, GPS, boletos...) a partir de um PDF modelo e depois
verifica se outros PDFs são do mesmo tipo, extraindo **CNPJ**, **competência** e **valor a pagar**.

Tudo roda no navegador: os mapeamentos ficam no IndexedDB (`map-archive`), o PDF é lido com
`pdfjs-dist` e nada é enviado para servidor.

Cada forma de mapear/validar é uma **versão** separada, para comparar qual funciona melhor.
As versões convivem: mapeamentos antigos continuam funcionando e o match escolhe a lógica
pela versão salva (`versao` no registro).

## Versões

| | v1 · texto | v2 · planilha | v3 · assinatura + score | v4 · vários modelos |
|---|---|---|---|---|
| Pasta | `src/app/pdf-mapeamento/` | `src/app/pdf-mapeamento-v2/` | `src/app/pdf-mapeamento-v3/` | `src/app/pdf-mapeamento-v4/` |
| Como o PDF é visto | Texto corrido (sequência de palavras) | Planilha: uma aba por página, linhas e colunas por posição | Planilha (igual à v2) | Planilha, de 2 a 5 PDFs modelo |
| Como acha os campos | Rótulo antes do valor + "N-ésimo valor depois do rótulo" | Célula mapeada, confirmada pelo rótulo vizinho; se o layout mudar, procura pelo rótulo, linhas vizinhas ou valor único | Igual à v2 | Igual à v2, conferido em todos os modelos |
| Como decide se é o mesmo tipo | Todos os termos escolhidos aparecem no texto | Todos os termos aparecem (a posição só é informada) | **Score** de vários sinais, ver abaixo | Score da v3 + posição dos rótulos |
| Resultado | sim / não | sim / não | **corresponde / duvidoso / não** + confiança (%) | Igual à v3 |
| O que o usuário informa | Campos e termos | Campos e termos (clicando nas células) | Campos e termos (modal da v2) + termos de exclusão | Igual à v3 + escolhe termos sugeridos |
| O que é gerado sozinho | — | Referência de célula e rótulo de cada campo | + assinatura do PDF modelo | Assinatura aprendida: rótulos estáveis × variáveis, posições e tolerâncias, termos sugeridos |
| Identificação automática | — | — | Compara o PDF com todos os mapeamentos v3/v4 e ranqueia | Igual à v3 |
| Ponto fraco | Quebra se a ordem do texto mudar; termos genéricos dão falso positivo | Termos genéricos ("Receita Federal") aparecem em várias guias e dão falso positivo | Um só PDF modelo: texto variável sem números (ex.: nome da empresa) entra como "rótulo fixo"; código de barras só como imagem não é lido | Pede mais PDFs para mapear; se os modelos forem quase iguais (mesma empresa e mês), aprende pouco |

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

No match, a opção **Identificar automaticamente** roda todos os mapeamentos v3 e v4 contra o PDF e
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

## Ideias para a v5

1. **Assinatura visual.** Renderizar a 1ª página em miniatura (ex.: 32×32 em tons de cinza) e
   comparar por hash perceptual (dHash) ou pela posição das linhas e caixas do formulário.
   Funciona com pouco texto e pega guias com o mesmo texto mas desenho diferente.
2. **Termos distintivos entre tipos.** Usar os outros mapeamentos salvos para sugerir termos e
   exclusões: rótulo estável que só este tipo tem vira termo; o que só o tipo "vizinho" tem vira
   exclusão. Ataca direto o caso DARF × DAS.
3. **Fontes e metadados do PDF.** Lista de fontes usadas (`fontName` do pdf.js) e
   `Producer`/`Creator` dos metadados. Sinal fraco sozinho, bom para desempate.
4. **Aprender com as correções.** Quando o usuário confirma ou recusa um resultado "duvidoso",
   o caso vira mais um modelo (v4) ou um contraexemplo, e os pesos/limites daquele mapeamento
   são ajustados.

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
3. Adicionar o ramo `versao === N` em `verificarDocumento` (`match/match.ts`). Se a versão
   decidir por score, incluir em `temScore` para entrar na identificação automática.
4. Adicionar o botão e o modal em `app.component`.
5. Documentar a versão na tabela acima.
