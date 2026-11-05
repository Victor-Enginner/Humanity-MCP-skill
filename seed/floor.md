# Piso visual — inalienavel

Nao e sugestao. Se a tarefa nao da para cumprir isto, reporte em `## Blocked` em vez de improvisar.

Em quatro das dez linhas abaixo a gate de tarefa (`lib/sloplint.js`) tem regra deterministica, e o
id dela esta citado junto da linha. Um achado desses reprova a tarefa inteira, exatamente como um
arquivo fora do lote: o id aparece aqui para voce poder discordar do numero, nunca da impressao.

- Cor e tipografia saem dos tokens do tema. Nenhum hex literal fora de `tokens.css`.
  (SLOP-OFF-TOKEN-COLOR — hex em declaracao comum de propriedade; `--ink: #...` dentro do token nao conta.)
- Escala de espacamento: multiplos de 4px. Sem 3px, 13px, 27px.
  (SLOP-SPACING-RHYTHM — checa `margin`, `padding` e `gap` em qualquer `.css` seu; `border-radius` nao entra.)
- Nenhum gradiente roxo/violeta/indigo. Nenhum glow padrao de template de IA.
  (SLOP-PURPLE-GRADIENT — pega nome de cor e hex da familia, dentro do gradiente.)
- Rotulo pequeno em CAIXA ALTA com letter-spacing largo nao e hierarquia, e tique.
  (SLOP-EYEBROW-CAPS — `text-transform: uppercase` + `letter-spacing` largo no MESMO bloco.)
- Titulo de secao tem que sobrevir a 1280px de largura de leitura, nao so a 1920px.
- Contraste de texto: 4.5:1 no corpo, 3:1 em titulo >= 24px.
- Todo elemento interativo tem estado visivel de foco. Sem `outline: none` sem substituto.
- Imagem decorativa entra com `alt=""`; imagem com informacao entra com `alt` descrito.
- Layout em grid/flex com uma fonte de verdade para a largura do conteudo.
- Nenhum texto de placeholder tipo "Lorem ipsum" ou "Your awesome product" no resultado.

As seis linhas sem id a gate nao mede: quem confere elas e o humano, na integracao. Cumpra-as do
mesmo jeito — sao as que a maquina nao ve e as que alguem vai cobrar na revisao. Se alguma delas
briga com o que a tarefa pede, o caminho e `## Blocked`, nao um "depois ajeito".
