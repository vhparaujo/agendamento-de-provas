# Deploy das rodadas + troca de senhas do AVA — análise de 21/08/2026

## A pergunta

Tendo em vista as últimas modificações — rodadas no período e troca de senhas das provas do
AVA — dá para mandar as alterações para o servidor? As alterações no banco vão apagar os dados
já salvos? As migrations vão passar limpas?

## Resposta curta

**Pode mandar.** As 4 migrations pendentes são todas aditivas: nenhum `DROP`, nenhuma coluna
removida ou renomeada, nenhum índice único derrubado. O servidor está **exatamente 4 migrations
atrás**, com o histórico limpo.

Os riscos reais deste deploy **não estão no banco** — estão no consentimento OAuth do D2L e no
fato de que as duas imagens (API e frontend) precisam subir juntas.

---

## O que foi verificado

| Checagem | Resultado |
|---|---|
| `prisma migrate status` (local) | 14 migrations, "Database schema is up to date" |
| `prisma migrate diff` banco ↔ `schema.prisma` | **"No difference detected"** — sem drift |
| `npm test` | **515 testes passando**, 35 suítes |
| Migration antiga editada após ser aplicada? | Não — cada `migration.sql` foi tocado só no commit que o criou |
| `prisma migrate status` (servidor) | **10 migrations**, "Database schema is up to date!" |
| Volume do MySQL em produção | `agendamento-mysql-data`, nomeado e externo ao ciclo do build |

### O que o status do servidor estabelece

```
10 migrations found in prisma/migrations
Database schema is up to date!
```

- **10 migrations** = a imagem em produção é o build de 13/08, indo até
  `20260813150000_snapshot_modalidade_polo_agendamento`. O servidor está 4 atrás — as 4 novas,
  nenhuma a mais nem a menos.
- **"up to date"** = sem migration falhada, sem checksum divergente, e **sem o
  `20260730202746_init` órfão** no `_prisma_migrations`. Essa migration foi renomeada para
  `20260730100000_init` em 03/08; se o banco fosse anterior à troca, o `migrate status`
  reclamaria de migration aplicada que não existe mais na pasta. Não reclamou — o banco foi
  criado depois. Risco descartado.

---

## Migration por migration: por que nenhum dado se perde

### `20260818191200_senha_dos_questionarios`

Só `CREATE TABLE` — `senha_de_prova`, `configuracao_senha_quiz`, `execucao_senha_quiz`,
`item_senha_quiz` — e as FKs entre elas. Não encosta em nenhuma tabela existente.

### `20260819120000_horarios_do_cron_no_banco`

`MODIFY nomeQuiz` para NULL-ável (afrouxa, não aperta: linhas existentes mantêm o valor) e três
`ADD COLUMN` NULL. Tudo numa tabela criada na migration anterior.

### `20260819170000_rodada_da_prova`

`ADD COLUMN rodada` em três tabelas:

- `periodo_agendamento` e `execucao_compulsorio`: `NOT NULL DEFAULT 'N2'` — as linhas existentes
  recebem `'N2'`, que é o que elas de fato são (até aqui só havia a prova regular).
- `agendamento`: o caminho explícito e correto — nasce NULL, `UPDATE ... SET rodada = 'N2'`, e
  só então `MODIFY ... NOT NULL`. Toda reserva já gravada vira N2; nenhuma linha é perdida.

Detalhe que evita o pior cenário: **não existe** `@@unique([alunoId, periodoLetivoId])` no
schema. A trava de "uma prova por semestre" é regra de aplicação, não índice de banco — logo
nenhum índice único precisou ser derrubado e recriado, que é justamente onde uma migration de
rodada costuma dar problema.

### `20260820120000_filtro_de_nota_da_rodada`

`ADD COLUMN` NULL em `periodo_agendamento` (`notaMinima`, `notaMaxima`) e em
`agendamento_disciplina` (`notaFinal`), mais um `MODIFY` no ENUM `excecao_compulsorio.motivo`
acrescentando `NAO_ELEGIVEL_PELA_NOTA`.

> ⚠️ **O único ponto que merece atenção no deploy inteiro.** O valor novo entra **no meio** da
> lista do ENUM (entre `SEM_DISCIPLINA_AGENDAVEL` e `SEM_FAIXA_NO_POLO`), o que impede o MySQL
> de fazer o ALTER in-place. Ele cai para `ALGORITHM=COPY`, que reescreve a tabela convertendo
> os valores **pela string**, não pelo índice — então os motivos já gravados são preservados
> corretamente. É a única migration que reescreve tabela existente, e `excecao_compulsorio` é
> pequena, então o lock é curto. É também o motivo de o backup não ser opcional.

---

## Riscos que não estão nas migrations

### 1. As DUAS imagens precisam ir, não só a da API

`SenhasDeProvaView.vue` é tela nova e `PeriodosView.vue` mudou para rodada e faixa de nota. Se
só a API subir, os endpoints novos existem sem nenhuma UI que os alcance. O repositório do
frontend foi iniciado em 14/08 — **tudo** que está nele é posterior ao último deploy.

### 2. `D2L_SCOPES` mudou — e o escopo vive no consentimento, não no `.env`

Entraram `quizzing:quizzes:read`, `quizzing:quizzes:write` e `grades:gradevalues:read`. Editar
a variável e subir o container **não muda nada sozinho**: é preciso refazer a autorização OAuth
no browser (`npm run d2l:autorizar`).

Como a SUB não entra agora, isso não bloqueia o deploy — nenhum aluno é afetado, porque o filtro
de nota só liga quando `notaMinima`/`notaMaxima` estão preenchidas, e toda janela já cadastrada
nasce com os dois NULL. Mas continua sendo **pré-requisito da troca de senhas**: sem
`quizzing:*`, todo `PUT` em quiz volta 403.

Para guardar, quando for abrir a SUB: sem `grades:gradevalues:read`, o
`GET .../grades/final/values/...` volta 403 e **nenhum aluno consegue agendar a substitutiva** —
o filtro é fail-closed de propósito (`elegibilidade-de-nota.service.ts:225`).

### 3. `D2L_HABILITADO` inverteu o default para `true`

Era `false` por padrão; desde 18/08 é `true`, e desligar exige dizer `'false'` em voz alta
(`d2l.config.ts:142`). Se o `.env` do servidor já declara `D2L_HABILITADO=true`, nada muda. Se
ele **omite** a variável contando com o default antigo, a integração passa a subir.

### 4. As variáveis `SENHA_QUIZ_*` são todas opcionais

Confirmado em `src/config/env.validation.ts`: todas `@IsOptional()`, a API sobe sem elas. E
`SENHA_QUIZ_CRON_HABILITADO` tem default `false` — **o cron não dispara sozinho**. O deploy não
vai trocar senha de prova por conta própria.

### 5. O build usa a árvore de trabalho, não um commit

Fora do git no momento da análise: backend `src/periodo/service/periodo.service.ts` (só um
acento numa mensagem — inofensivo); frontend `EntradaView.vue`, `PortalView.vue` e o novo
`FormularioTesteToken.vue`. Vale commitar antes, para o `.tar` corresponder a um commit
conhecido.

O `FormularioTesteToken.vue` **não vaza para produção**: `EntradaView` só o carrega sob
`import.meta.env.DEV`, que o Vite substitui por `false` no build de produção — o import dinâmico
inteiro sai na eliminação de código morto.

---

## Passo a passo do deploy

### Na máquina local — construir e empacotar as duas imagens

O Mac é arm64 e o servidor é amd64, então o `--platform` não é opcional:

```bash
cd /Users/vhparaujo/Documents/Trabalho-UCB/agendamento

docker buildx build --platform linux/amd64 \
  -t agendamento-api:latest --load ./agendamento-de-provas
docker buildx build --platform linux/amd64 \
  -t agendamento-web:latest --load ./agendamento-frontend

docker save agendamento-api:latest -o agendamento-api-amd64.tar
docker save agendamento-web:latest -o agendamento-web-amd64.tar
```

O build do frontend roda `vue-tsc --noEmit` antes do `vite build` — erro de tipo quebra aqui,
não em produção. Depois, `scp` dos dois tars para `/opt/agendamento`.

### No servidor

**1. Anotar a imagem atual — é o rollback:**

```bash
docker inspect agendamento-api --format '{{.Image}}'
docker inspect agendamento-web --format '{{.Image}}'
```

Guarde os dois sha256. Depois do `docker load`, a imagem antiga vira `<none>` e só esse id a
recupera.

**2. Descobrir de onde o compose é orquestrado** (não está em `/opt/agendamento`):

```bash
docker inspect agendamento-api \
  --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}'
```

**3. Backup do banco — não pule:**

```bash
docker exec agendamento-mysql mysqldump -u root -p"$MYSQL_ROOT_PASSWORD" \
  --single-transaction --routines --triggers agendamento \
  > /opt/agendamento/bkp/backup-$(date +%Y%m%d-%H%M).sql
```

**4. Atualizar o `.env` do servidor** (`agendamento-de-provas/.env`), copiando de `.env.example`:

- `D2L_SCOPES` — a linha inteira, com os três escopos novos;
- conferir que `D2L_HABILITADO` está declarado explicitamente;
- bloco `SENHA_QUIZ_*` (`CRON_TOLERANCIA_MIN`, `CRON_MAX_TENTATIVAS`, `CONCORRENCIA`,
  `DELAY_MS`, `TIMEOUT_MS`, `MAX_PAGINAS`), com **`SENHA_QUIZ_CRON_HABILITADO=false`** neste
  deploy — liga depois, com a configuração conferida na tela.

**5. Carregar e subir:**

```bash
cd /opt/agendamento
docker load -i agendamento-api-amd64.tar
docker load -i agendamento-web-amd64.tar

cd <working_dir do passo 2>
docker compose -f docker-compose.prod.yml up -d
```

Sem `--build`: as imagens já vieram prontas. O compose detecta que o id mudou e recria os
containers. **Nunca** `down -v` — é o único comando aqui que destruiria o volume
`agendamento-mysql-data`.

O `CMD` do container roda `npx prisma migrate deploy && node dist/main`. Se uma migration
falhar, a API **não sobe** (reinicia em loop) — falha visível, não silenciosa, e sem risco de
rodar com o schema pela metade.

**6. Reautorizar o OAuth do D2L** (necessário para a troca de senhas; obrigatório antes de um
dia abrir a SUB):

```bash
docker exec -it agendamento-api npm run d2l:autorizar
```

E completar o consentimento no browser.

---

## Verificação pós-deploy

1. `docker exec agendamento-api npx prisma migrate status` → agora **14 migrations found** e
   "Database schema is up to date!". O `14` é o que prova que a imagem nova entrou.
2. `curl -s https://<dominio>/api/health` → `status: ok`
3. **Nada foi perdido** — comparar com as contagens de antes do deploy:
   ```sql
   SELECT rodada, COUNT(*) FROM agendamento GROUP BY rodada;
   SELECT rodada, COUNT(*) FROM periodo_agendamento GROUP BY rodada;
   SELECT motivo, COUNT(*) FROM excecao_compulsorio GROUP BY motivo;
   ```
   A última é o que confirma que o `MODIFY` do ENUM preservou os motivos.
4. **Portal do aluno continua igual:** entrar por um launch LTI real e confirmar que as
   disciplinas aparecem como antes — janela sem faixa de nota = comportamento de hoje.
5. **Frontend novo chegou:** a tela *Senhas de prova* existe no menu do admin e *Períodos*
   mostra o campo de rodada.
6. **Troca de senhas em simulação:** cadastrar uma célula dia×turno, escolher o
   questionário-alvo e os horários, e rodar com `simulacao = true` (o default) — percorre tudo e
   **não grava nada no AVA**. É o que valida os escopos de quizzing sem risco. Só depois
   considerar `SENHA_QUIZ_CRON_HABILITADO=true`.

Fora do escopo deste deploy, para quando a SUB entrar: rodar
`npm run d2l:notas -- <orgUnitId> <userId>` e confirmar que devolve a nota (não 403) **antes** de
cadastrar a janela com `notaMinima = 1,50` e `notaMaxima = 6,75`.

## Rollback

As migrations são aditivas, então a versão anterior **continua funcionando** contra o schema
novo — as colunas novas ou têm default ou são NULL-áveis. Reverter é só voltar as imagens:

```bash
docker tag <sha256 anotado no passo 1> agendamento-api:latest
docker tag <sha256 anotado no passo 1> agendamento-web:latest
docker compose -f docker-compose.prod.yml up -d
```

Sem tocar no banco. O `mysqldump` do passo 3 é a rede de segurança para o caso do `MODIFY` do
ENUM em `excecao_compulsorio`.

---

# Perguntas que surgiram no caminho

## Como sair do `.tar`?

O `.tar` resolve de uma vez só duas coisas que são separadas: *onde a imagem é construída* e
*como ela chega no servidor*.

### Opção A — build no próprio servidor

O `docker-compose.prod.yml` **já** está escrito para isso (`build.context:
./agendamento-de-provas` e `./agendamento-frontend`). O que falta é o código-fonte dos dois
projetos estar no servidor, lado a lado com o compose:

```bash
git pull        # nos dois repos
docker compose -f docker-compose.prod.yml up -d --build
```

- **Ganha:** acaba o `--platform linux/amd64` (build nativo) e o `scp` de centenas de MB.
- **Custa:** o build passa a consumir RAM/CPU **de produção** — `npm ci` dos dois projetos +
  `nest build` + `vue-tsc` + `vite build`, com picos de 2–4 GB. Conferir a folga da VPS antes; o
  build do frontend é o que costuma morrer por OOM. E a falha de build passa a acontecer no
  servidor, não na máquina local.

### Opção B — registry (o build continua local)

Troca só o transporte: `push`/`pull` no lugar do `scp` do tar.

```bash
# na máquina local
docker buildx build --platform linux/amd64 \
  -t ghcr.io/<usuario>/agendamento-api:$(git rev-parse --short HEAD) \
  --push ./agendamento-de-provas

# no servidor
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

Exige mudar o `image:` no compose de `agendamento-api:latest` para o caminho do registry, com a
tag vindo de `${TAG}`. GHCR privado é gratuito.

### O ganho maior, que vale para as duas: parar de usar `latest`

Com a imagem marcada por `:<commit-sha>` em vez de `:latest`, o rollback deixa de depender de
ter anotado um sha256 antes do `docker load` e vira:

```bash
TAG=<sha-anterior> docker compose -f docker-compose.prod.yml up -d
```

Também acaba a ambiguidade de "qual código está rodando lá?", que hoje só se responde olhando o
número de migrations dentro do container.

> **Não fazer junto com este deploy.** Trocar o método de entrega no mesmo dia em que 4
> migrations sobem misturaria duas variáveis se algo der errado.

## Os dois `docker-compose` devem ser unificados?

**Não.** São arquivos diferentes para finalidades diferentes.

| | `agendamento-de-provas/docker-compose.yml` | raiz `docker-compose.prod.yml` |
|---|---|---|
| Escopo | só o backend | sistema inteiro |
| Serviços | `mysql`, `app` | `mysql`, `api`, `web` |
| Porta do MySQL | **publicada** (3306) | fechada, só rede interna |
| `docker/mysql/init` | montado | não |

O de dentro é o de **desenvolvimento**: é o que `npm run db:up` sobe, é de onde vem o
`localhost:3306` do `.env` local, e é ele que monta `./docker/mysql/init` — o grant do **shadow
database**, sem o qual `prisma migrate dev` para de conseguir criar migration nova.
Substituí-lo pelo de produção quebraria o ambiente de desenvolvimento.

O de produção fica na raiz por necessidade: seus build contexts são `./agendamento-de-provas` e
`./agendamento-frontend`, então ele precisa enxergar as duas pastas como irmãs.

## A infraestrutura não está versionada

`docker-compose.prod.yml`, `docker-compose.tls.yml` e `Caddyfile` **não estão em repositório
nenhum** — a pasta `agendamento/` não é um repo git, só as duas subpastas são. Hoje a descrição
de como o sistema sobe existe apenas na máquina local, sem histórico e sem cópia. A pasta
`/home/infra` no servidor é provavelmente uma cópia manual, que pode já ter divergido.

Correção sugerida: um terceiro repo `agendamento-infra` com os três arquivos, um
`.env.prod.example` e um `DEPLOY.md` com os passos acima. **Nunca commitar o `.env` real** — ele
tem JWT, LTI e credenciais da Valence.

---

## Decisões desta rodada

| Decisão | |
|---|---|
| Janela da SUB | **Não** entra neste deploy — só o código sobe |
| Método de deploy | `.tar` + `docker load`, como de costume; mudança fica para depois |
| `SENHA_QUIZ_CRON_HABILITADO` | `false` neste deploy; ligar só após validar em simulação |
