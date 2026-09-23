# Timbrado da lista de presença

**`modelo-lista-presenca.png`** é o papel em que a lista de presença é impressa:
banda azul na lateral esquerda, marca Católica EAD no alto à esquerda, selo
Great Place to Work no alto à direita, o título **LISTA DE PRESENÇA** com o
risco embaixo, curvas no canto inferior direito e, no pé, o bloco de emissão
mais o **endereço da instituição**.

É irmã da arte da declaração de agendamento
([`../../agendamento/assets/modelo-declaracao.png`](../../agendamento/assets/modelo-declaracao.png)),
com outro título — mas **não é idêntica**: a declaração não tem o bloco de
endereço, e por isso as medidas de uma não servem para a outra.

- **Nome exato:** `modelo-lista-presenca.png` (só PNG ou JPEG; é o que o
  `pdfkit` embute).
- **Tamanho:** uma A4 inteira, de sangrar — a imagem é esticada de canto a canto
  (595,276 × 841,89 pt). Qualquer outra proporção sai distorcida.
- **Resolução:** 1414 × 2000 px (**171 dpi** numa A4), truecolor, sem canal
  alfa — 369 KB. O arquivo entra **uma vez** no PDF e é reaproveitado em todas
  as páginas (10 salas custam 388 KB contra 372 KB de uma), então o peso é por
  download, não por folha.
  ⚠️ **171 dpi é baixo para impressão.** É a resolução em que a arte foi
  entregue, e **não dá para recuperar detalhe ampliando** — reamostrar só
  inventa pixel. Se aparecer uma exportação maior da arte, vale trocar: o script
  avisa sempre que o material de origem fica abaixo de 200 dpi.
- **Sem canal alfa.** A arte é achatada sobre branco: o alfa vira uma máscara
  separada no PDF e engorda o arquivo à toa.

### Como regenerar a partir do PDF da instituição

A arte chega da instituição em **PNG** (já chegou em PDF vetorial antes). O
`pdfkit` não embute PDF — `doc.image()` aceita só JPEG e PNG, e um PDF ali
responde `Unknown image format` —, então em qualquer um dos casos o asset final
é PNG. A conversão é um script, para não virar folclore de quem a fez:

```bash
npm run timbrado -- "~/Downloads/LISTA DE PRESENÇA.png" \
  src/relatorio/assets/modelo-lista-presenca.png
```

Ele aceita **PNG ou PDF**: PDF é rasterizado a 300 dpi com o `sips` (do próprio
macOS, sem dependência nova); **PNG entra na resolução em que veio**, só perdendo
o alfa. Nos dois casos grava em `color type 2` e avisa se a proporção não for a
da A4 ou se o material estiver abaixo de 200 dpi. É determinístico: rodar duas
vezes sobre a mesma origem dá o mesmo arquivo, byte a byte.

⚠️ **NÃO quantize para 256 cores.** É tentador — corta o arquivo para ~315 KB —
e foi o que se tentou primeiro. As curvas do canto inferior direito são
fios de azul claro de menos de 1pt, e elas vivem do antialiasing: com a paleta
reduzida os tons intermediários caem para branco e **as curvas saem
pontilhadas**, como linha tracejada. Confira sempre essa região depois de mexer
no arquivo, ampliada — no tamanho real o defeito não aparece.

⚠️ **Não reamostre o PNG de origem para "chegar aos 300 dpi".** O detalhe que
não está lá não aparece: sai a mesma imagem borrada, três vezes maior. A
resolução de um PNG é a que veio, e subir de verdade é pedir outra exportação a
quem desenhou.

ℹ️ Para referência: a versão anterior desta arte veio em **PDF vetorial**, e
nela o selo Great Place to Work era um raster de ~130 dpi embutido — rasterizar
a 600 dpi só ampliava os próprios pixels dele, e o miolo ("ABR 2026-ABR 2027",
"Brasil") saía ilegível. No PNG atual o selo está nítido; foi o principal ganho
da troca.

## O que a arte manda no código

As medidas de [`../service/pdf-lista-presenca.ts`](../service/pdf-lista-presenca.ts)
foram tiradas **desta imagem**, e trocá-la por outra arte sem refazê-las
desalinha o documento:

| na arte                                  | no código                              |
| ---------------------------------------- | -------------------------------------- |
| coluna de texto: x 69 → 525 pt           | `MARGEM`, e a soma de `COLUNAS`        |
| risco do título termina em y 191,5 pt    | `AREA_UTIL.topo`, `IDENTIFICACAO`      |
| bloco de emissão começa em y 708,1 pt    | `AREA_UTIL.base`, `LIMITE_DAS_LINHAS`  |
| endereço ocupa de y 750,6 a 829,3 pt     | é ele que empurrou a emissão para cima |
| curvas do canto nunca passam de x 530 pt | por que a tabela não cresce à direita  |

O título **não é desenhado pelo código** — ele vem impresso na arte, na fonte da
marca. O `pdfkit` escreve só a identificação da sala (sala, câmpus, formato, dia
e horário) e a tabela.

## Por que ele é opcional

`carregarModelo` procura o arquivo em `dist/relatorio/assets/` e em
`src/relatorio/assets/`, nessa ordem, e **segue sem ele** se não achar: o
`nest build` copia `**/*.png` para o `dist` (ver `nest-cli.json`) e a imagem
Docker leva o `src` inteiro, mas derrubar o relatório inteiro por causa de um
arquivo de imagem ausente seria trocar um documento imperfeito por documento
nenhum.

⚠️ Sem a arte a folha sai **sem título e sem papel** — a identificação e a
tabela continuam lá, e o fiscal ainda consegue usar a folha. É razão para o
`.png` estar sempre no lugar, não para o download falhar quando ele não estiver.

# Marca da folha de identificação

**`logo-catolica-ead.png`** é a marca Católica EAD que vai no alto à esquerda da
folha de identificação (`../service/pdf-identificacao.ts`). Foi **extraída do
próprio modelo da instituição** ("07\_ FOLHA DE IDENTIFICAÇÃO.pdf", onde ela é
uma imagem embutida de 555 × 219 px) e achatada sobre branco — sem canal alfa,
pelo mesmo motivo do timbrado acima.

- Vai desenhada em **200,12 × 79,05 pt** a partir de (19,94; 9,32), a posição
  exata do modelo. Trocar por uma arte de outra proporção a distorce.
- É **opcional** como o timbrado: sem ela a folha sai sem a marca, mas com polo,
  dia e hora — que é tudo que ela precisa dizer.
- Não é o `logo-catolica.png` do front: aquele é **branco**, feito para o fundo
  escuro da barra do topo, e some numa folha branca.
