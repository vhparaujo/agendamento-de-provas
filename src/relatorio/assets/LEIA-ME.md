# Logo da lista de presença

Coloque aqui um arquivo chamado **`logo.png`** e ele passa a aparecer no canto
superior esquerdo de toda página do PDF de lista de presença. **Nada mais precisa
ser alterado** — nem código, nem configuração.

- **Nome exato:** `logo.png` (só PNG ou JPEG; é o que o `pdfkit` embute).
- **Tamanho:** o arquivo é encaixado numa caixa de 130 × 34 pontos sem distorcer
  (`fit`), então qualquer proporção funciona. Uma imagem larga e baixa, no
  formato da assinatura institucional, é a que fica melhor.
- **Resolução:** ~3× o tamanho final (≈390 × 102 px) já imprime nítido; arquivo
  maior que isso só engorda o PDF, que é gerado por sala.

## Por que ele é opcional

O documento é útil sem a marca — o cabeçalho de texto (polo, data, horário e
sala) já identifica a folha, que é o que importa para o fiscal. Fazer o
relatório inteiro falhar por causa de um arquivo de imagem ausente seria trocar
um documento imperfeito por documento nenhum.

A regra de leitura está em
[`../service/pdf-lista-presenca.ts`](../service/pdf-lista-presenca.ts)
(`carregarLogo`). Ela procura em `dist/relatorio/assets/` e em
`src/relatorio/assets/`, nessa ordem: o `nest build` copia `**/*.png` para o
`dist` (ver `nest-cli.json`), e a imagem Docker também leva o `src` inteiro.
