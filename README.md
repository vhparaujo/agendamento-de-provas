# Portal de Agendamento de Provas — UCB (Backend)

API que permite a **alunos** da UCB agendarem a data e o horário de suas provas
presenciais, e a **administradores** gerenciarem polos, salas, horários, turmas,
o período de agendamento e o **relatório de quem agendou o quê**.

A liberação das provas no Brightspace por *special access* (Valence API) está
implementada desde 15/09/2026, ao lado da troca de datas e grupos dos
questionários — ver [Special access por agendamento](#special-access-por-agendamento).
A entrada do aluno é por **LTI 1.3**.

- **Stack:** NestJS 11 · TypeScript · Prisma 7 (MySQL 8) · Docker
- **Autenticação:** LTI 1.3 (aluno, sem senha) · JWT (admin)
- **Documentação viva:** Swagger em `/api/docs`

---

## Índice

- [Como funciona](#como-funciona)
- [Conceitos de domínio](#conceitos-de-domínio)
- [Regras de negócio invioláveis](#regras-de-negócio-invioláveis)
- [Setup](#setup)
- [Comandos](#comandos)
- [Variáveis de ambiente](#variáveis-de-ambiente)
- [Endpoints](#endpoints)
- [Documentação da API (Swagger)](#documentação-da-api-swagger)
- [Segurança](#segurança)
- [Modelo de dados](#modelo-de-dados)
- [Importação dos CSVs](#importação-dos-csvs)
- [Autenticação em detalhe](#autenticação-em-detalhe)
- [Estrutura do código](#estrutura-do-código)
- [Notas de infraestrutura (Prisma 7)](#notas-de-infraestrutura-prisma-7)
- [Deploy em produção](#deploy-em-produção)
- [Testes](#testes)
- [Estado atual e roadmap](#estado-atual-e-roadmap)

---

## Como funciona

**Fluxo do aluno**

1. O aluno entra pelo Brightspace; o **launch LTI 1.3** traz o RA (matrícula) e o
   UserId do Valence. Ele nunca digita senha.
2. O RA é cruzado com a base de alunos importada do CSV, o que devolve os
   **vínculos** dele (um por curso) — cada vínculo carrega modalidade e polo.
3. Se houver mais de um vínculo, o portal pergunta de qual curso é a prova
   (`precisaEscolherCurso` na resposta do launch).
4. O aluno vê as **faixas** (horários) do polo dele, na modalidade dele, com vaga,
   com o período de agendamento aberto.
5. Escolhe uma faixa. O sistema aloca uma sala automaticamente, **em ordem
   sequencial** (enche a sala de menor `ordem` antes de abrir a próxima).
6. A reserva cobre **todas as disciplinas agendáveis daquele vínculo** de uma vez.
7. O agendamento já grava a fila de liberação (`SyncD2L`, uma linha por
   disciplina, em `PENDENTE`) — mas **nada é enviado ao Brightspace ainda**.
   Quando a integração for feita, a fila estará esperando; nada se perde.

**Fluxo do admin**

Login por e-mail/senha → JWT. Cadastra salas, monta faixas (data + horário +
quais salas atendem qual modalidade + vagas + ordem), importa os CSVs de alunos e
turmas, abre/fecha o período de agendamento, acompanha a ocupação de cada sala e
**exporta em CSV a lista de todos os alunos, com quem já agendou e quem não**.

---

## Conceitos de domínio

| Conceito | O que é |
|---|---|
| **Polo** | Unidade física onde as provas ocorrem. São 27, populados por seed. |
| **Sala** | Espaço físico dentro de um polo, com capacidade. **É neutra** — não tem modalidade fixa. |
| **Modalidade** | Formato do curso. Define a **duração da prova** (EaD 3h · Semipresencial 1h30 · Modular/Híbrido 1h30 · Presencial 2h) **e qual período letivo do Brightspace vale para o aluno** — ver *duas grades no mesmo ano*. |
| **Vínculo** | Aluno + curso. **É a unidade real do sistema.** Um mesmo RA pode ter dois vínculos (dois cursos, modalidades diferentes) e agenda uma prova para cada. |
| **Faixa** | Horário de prova que o admin abre para um polo (data + hora início + hora fim). **Também é neutra** — não tem modalidade fixa. |
| **SalaFaixa** | **O núcleo do modelo.** Associação `Sala + Faixa + Modalidade + vagas + ordem`. É aqui que modalidade e vagas existem de fato. |
| **Turma real** | Turma/disciplina que efetivamente terá prova (CSV de turmas). Filtro final do que aparece para o aluno. |

### Por que sala e faixa são neutras

A mesma sala física pode ser Presencial numa faixa e EaD em outra — o que a
trava numa modalidade é a linha de `SalaFaixa`, não a sala em si. Dentro de uma
mesma faixa, porém, a sala fica travada numa única modalidade (garantido pelo
índice único `[salaId, faixaId]`). O admin monta essa grade ao criar a faixa.

---

## Regras de negócio invioláveis

1. **Aluno não tem senha.** É reconhecido via LTI 1.3; a matrícula do launch é
   cruzada com o CSV. Nunca confie em dados auto-declarados pelo cliente.
2. **Só aluno ATIVO agenda.** O `STATUS CURSO` do CSV precisa ser `Ativo` — e
   nenhum outro valor serve. Desistente, Trancado, Cancelado, Formado, as
   situações de transição (`Transf. Interna`, `Transf. de Curriculo`,
   `Alter. de Habilitação`) e qualquer grafia desconhecida **bloqueiam**. A lista
   está em [`src/enums/status-curso.enum.ts`](src/enums/status-curso.enum.ts),
   ponto único de alteração; a checagem é por vínculo, não por RA. O status
   **não** impede o login — ver [CSV de alunos](#csv-de-alunos).
3. **O que o aluno vê** = faixas do polo dele, na modalidade dele, com vaga, com
   o período de agendamento aberto.
4. **Disciplinas agendáveis** = disciplinas do aluno na Valence ∩ turmas reais
   (CSV) ∩ período letivo vigente. **Não são todas as disciplinas do aluno.**
4b. **Na rodada com critérios de nota (a substitutiva), só entra a disciplina em
   que o aluno passa nos DOIS**: `N1 >= notaMinimaN1` **e**
   `nota final calculada < notaMaximaFinal` (1,5 e 7 no cadastro do cliente).
   São notas DIFERENTES — não é uma faixa. É por DISCIPLINA: um aluno com três
   matérias pode agendar só uma. O gatilho são os critérios cadastrados no
   período, **nunca** o texto da `rodada`. Sem eles (a N2), nada muda e nenhuma
   nota é consultada. Sem conseguir ler as notas, o aluno **não** agenda — é
   *fail-closed* de propósito. Ver
   [Período de agendamento](#período-de-agendamento).
5. **Um agendamento cobre todas as disciplinas agendáveis de UM vínculo**, no
   mesmo horário. Aluno com dois cursos faz dois agendamentos.
6. **Uma prova por PESSOA em cada horário** (decisão do cliente, 14/08/2026). O
   RA de dois cursos faz duas provas, mas **não pode marcar as duas na mesma
   faixa**: são provas diferentes e ninguém faz as duas ao mesmo tempo. Antes
   disso ele ocupava duas cadeiras e só fazia uma delas. Vale no portal, na
   troca, no **remanejo do admin** e no compulsório — a regra vive num lugar só
   (`exigirUmaProvaPorFaixa`). O recorte é a **faixa**, não a sobreposição de
   horário: 09:00-12:00 e 10:00-11:30 continuam permitidos.
7. **Alocação de sala é sequencial**: preenche a sala de menor `ordem` até lotar,
   só então usa a próxima. A vaga é da SalaFaixa (`count(agendamentos) < vagas`).
8. **Concorrência**: a checagem de vaga + criação do agendamento **deve** ocorrer
   na mesma transação, serializada por SalaFaixa. Nunca conte fora da transação.
   Feito com `SELECT ... FOR UPDATE` sob READ COMMITTED — há teste que prova:
   remover o lock faz 5 alunos entrarem na mesma vaga. O primeiro lock é por
   **matrícula**, não por vínculo: senão os dois cursos do mesmo RA passariam
   pela regra 6 em paralelo.
9. **Reagendamento tem dono.** O aluno só troca/cancela com o período **aberto**
   e só no período **vigente**. O admin remaneja a qualquer tempo (é a válvula de
   escape), marcando `alocadoManual = true`, mas nem ele muda polo, modalidade ou
   joga o aluno no horário da outra prova dele.
   **Toda alteração grava quem a fez** — aluno ou administrador — na mesma
   transação da mudança.
10. **O período fecha só por data/hora** (`dataFechamento`), nunca por esgotamento
    de vagas. A janela de agendamento e as datas das provas são linhas do tempo
    independentes.
11. **Sync com D2L é assíncrono e tolerante a falha**: 404 (aluno não matriculado)
    é estado **esperado** (`NAO_MATRICULADO`), não erro. *(fase adiada — a fila já
    é gravada, mas ninguém a consome ainda)*

---

## Setup

**Pré-requisitos:** Node 24+, Docker, npm.

```bash
git clone <repo> && cd agendamento-de-provas
npm install

cp .env.example .env
# preencha ao menos: JWT_SECRET, JWT_REFRESH_SECRET, SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD
# gere segredos com: openssl rand -hex 48

npm run db:up            # sobe só o MySQL (o app roda na sua máquina)
npm run prisma:generate  # gera o client em src/generated/prisma (não versionado)
npm run prisma:migrate   # aplica as migrations
npm run seed             # modalidades + polos + primeiro admin

npm run start:dev
```

A API sobe em `http://localhost:3000/api`. Confira com `GET /api/health` e abra a
documentação interativa em **http://localhost:3000/api/docs**.

**Tudo containerizado** (app + banco), útil para validar o build de produção:

```bash
docker compose up -d --build
```

O container do app roda `prisma migrate deploy` antes de subir. Dentro da rede do
compose o host do banco é `mysql`, não `localhost` — o `docker-compose.yml` já
sobrescreve a `DATABASE_URL` com isso.

### ⚠️ Sempre `--build` quando houver código ou migration nova

```bash
docker compose up -d --build app     # certo
docker compose up -d app             # reusa a imagem antiga, em silêncio
```

Sem o `--build`, o compose sobe a **imagem já construída** — com o código e as
migrations de quando ela foi gerada. Não há aviso: a API responde normalmente,
só que velha. Sintomas típicos: rota nova devolvendo `404`, comportamento antigo
de uma regra que você acabou de mudar, ou o erro `P3009` da seção abaixo.

Piora com dois detalhes deste compose:

- o serviço tem `restart: unless-stopped`, então o container **volta sozinho**
  depois de um restart do Docker;
- ele publica a porta **3000**, a mesma do `npm run start:dev`. Quem subir
  primeiro fica com ela, e o outro nem sobe.

Se algo se comportar de forma inexplicavelmente antiga, confira quem está
respondendo: `docker compose ps app`. Para trabalhar local, `docker compose stop app`.

---

## Comandos

```bash
# aplicação
npm run start:dev            # watch mode
npm run start:prod           # a partir de dist/
npm run build

# banco / Prisma
npm run db:up                # docker compose up -d mysql
npm run db:down
npm run db:reset             # prisma migrate reset (APAGA os dados)
npm run prisma:generate      # regenera o client (rode após clonar ou mudar o schema)
npm run prisma:migrate       # migrate dev
npm run prisma:deploy        # migrate deploy (produção/container)
npm run prisma:studio
npm run seed                 # seeds idempotentes

# LTI
npm run lti:keygen           # gera a chave RSA da ferramenta (LTI_TOOL_PRIVATE_KEY)

# token de aluno para testar o portal sem o Brightspace (SÓ DESENVOLVIMENTO)
npm run token:aluno -- <RA> [orgUnitId]

# por que o launch recusou este id_token: compara os claims com o .env
npm run lti:diagnosticar -- <id_token>

# link de autorização da Valence (refaça sempre que o D2L_REDIRECT_URI mudar)
npm run d2l:autorizar

# access token da Valence a partir do refresh gravado (SÓ DESENVOLVIMENTO)
npm run d2l:token

# qualidade
npm test                     # unitários (jest, rootDir=src)
npm run test:cov
npm run test:e2e             # exige banco de pé + migrations aplicadas
npm run lint                 # eslint --fix
npm run format               # prettier
```

---

## Variáveis de ambiente

O `.env` é **validado no boot** (`src/config/env.validation.ts`): faltando algo
essencial, a aplicação não sobe. Melhor falhar no start do que descobrir um
segredo ausente em produção.

| Variável | Obrigatória | Observação |
|---|:---:|---|
| `DATABASE_URL` | ✅ | `mysql://user:senha@host:3306/agendamento` |
| `JWT_SECRET` | ✅ | mínimo 16 caracteres |
| `JWT_REFRESH_SECRET` | ✅ | mínimo 16 caracteres, diferente do anterior |
| `PORT`, `API_PREFIX`, `NODE_ENV` | | default `3000`, `api`, `development` |
| `TRUST_PROXY` | prod | **obrigatória atrás de proxy** — nº de saltos confiáveis (`1` = um proxy, `2` = dois). Ausente, todo aluno chega com o IP do proxy e o rate limit por IP vira orçamento compartilhado pela instituição |
| `SWAGGER_ENABLED` | | vazio = ligado fora de produção; `true` publica também em produção |
| `THROTTLE_NOS_TESTES` | | só para teste: liga o rate limiting sob `NODE_ENV=test` |
| `JWT_EXPIRES_IN` / `JWT_REFRESH_EXPIRES_IN` | | default `15m` / `7d` |
| `JWT_ALUNO_EXPIRES_IN` | | default `2h` — token curto, só para navegação |
| `SEED_ADMIN_EMAIL` / `_PASSWORD` / `_NOME` | seed | lidos apenas por `npm run seed` |
| `PERIODO_LETIVO_ID` | | período letivo vigente no Brightspace (ex: `103`) |
| `TURMAS_FILTER_ENABLED` | | **default seguro `true`** — ver abaixo |
| `LTI_*` | LTI | issuer, client id, deployment, URLs, chave RSA, claims |
| `D2L_HABILITADO` | | **default `true`** (desde 18/08/2026) — só `false` desliga; ligado, as disciplinas do aluno passam a vir dos enrollments da Valence |
| `D2L_*` | D2L | credenciais OAuth, URL do tenant, versão da API e Type Ids de org unit |
| `SENHA_QUIZ_CRON_HABILITADO` | | **default `false`** — se **esta instância** pode disparar o cron. Opt-in mesmo com o D2L ligado |
| `SENHA_QUIZ_CRON_TOLERANCIA_MIN` | | default `30` — janela em que um restart ainda aplica o turno |
| `SENHA_QUIZ_CRON_MAX_TENTATIVAS` | | default `3` — teto de tentativas reais por célula |
| `SENHA_QUIZ_CONCORRENCIA` / `_DELAY_MS` / `_TIMEOUT_MS` / `_MAX_PAGINAS` | | ritmo do lote contra a Valence (default `4` / `400` / `30000` / `50`) |
| `INTEGRACAO_API_KEYS` | integração | `sistema:chave[,sistema:chave]`, chaves com 32+ caracteres (`openssl rand -hex 32`). **Vazia = rotas de integração recusam tudo (401).** Duas entradas do mesmo sistema = rotação |
| `INTEGRACAO_IPS_PERMITIDOS` | | IPs exatos, separados por vírgula. Vazio = qualquer origem. Depende de `TRUST_PROXY` correto |

⚠️ **Os horários do cron e o questionário-alvo não estão no `.env`** (desde
19/08/2026): o admin os cadastra na tela, e eles moram em
`configuracao_senha_quiz`. Os dois mudam por semestre, e quem os conhece é a
secretaria — pedir deploy para trocar `07:30` garantia que o horário ficasse
errado no primeiro dia em que a prova mudasse de hora. O que ficou no `.env` é
o que é **da instância**: se ela pode disparar, e a que ritmo fala com a Valence.

Lista completa e comentada em [`.env.example`](.env.example). **Nunca commite o
`.env`.**

### `TURMAS_FILTER_ENABLED` — o default é bloquear

Com `true` (default), só é agendável a disciplina que estiver na tabela de turmas
reais. Com a tabela vazia (CSV ainda não importado), **nada é agendável** — de
propósito: é melhor ninguém agendar do que liberar prova para a disciplina
errada. O serviço loga um aviso claro quando isso acontece.

Com `false`, o filtro não restringe nada. **Cuidado ao combinar com
`D2L_HABILITADO=true`**: aí não é uma disciplina que passa livre, é o semestre
inteiro do aluno — o CSV de turmas é justamente quem diz quais turmas têm prova.
O portal loga um aviso quando as duas coisas estão ligadas ao mesmo tempo.

---

## Endpoints

Todos sob o prefixo `/api`. Um `ValidationPipe` global com `whitelist` e
`forbidNonWhitelisted` rejeita qualquer campo não declarado no DTO.

### Público

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/health` | Status da API, do banco e da integração D2L (campo `d2l`) |

### Autenticação — admin

| Método | Rota | Auth | Descrição |
|---|---|:---:|---|
| `POST` | `/auth/login` | — | E-mail + senha → access token + refresh token |
| `POST` | `/auth/refresh` | — | Refresh token → novo par de tokens |
| `POST` | `/auth/trocar-senha` | JWT | Única rota liberada com senha provisória pendente |
| `GET` | `/auth/me` | JWT | Dados do admin logado |

### Autenticação — aluno (LTI 1.3)

Não passam por guard: quem autentica é a assinatura do próprio Brightspace.

| Método | Rota | Descrição |
|---|---|---|
| `GET`/`POST` | `/lti/login` | Iniciação OIDC (o Brightspace pode usar os dois verbos) |
| `POST` | `/lti/launch` | Recebe o `id_token`, valida e devolve os vínculos + JWT do aluno |
| `GET` | `/lti/jwks` | Chave pública da ferramenta, consumida pelo Brightspace |

Ao registrar a ferramenta no Brightspace, aponte:
`OpenID Connect Login URL` → `{API}/lti/login` ·
`Redirect / Target Link` → `{API}/lti/launch` ·
`Keyset (JWKS) URL` → `{API}/lti/jwks`.

### Administradores

Todas exigem JWT de admin. **Não há níveis**: qualquer admin autenticado pode
criar outro ou resetar a senha alheia.

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/admins` | Lista |
| `POST` | `/admins` | Cria (nasce com `mustChangePassword`) |
| `POST` | `/admins/:id/resetar-senha` | Gera senha provisória para outro admin |
| `PATCH` | `/admins/:id/ativo` | Ativa/desativa |

### Importação de CSV

Todas exigem JWT de admin. Upload `multipart/form-data`, campo `arquivo`,
limite de 15 MB, extensão `.csv` obrigatória.

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/importacao/alunos` | CSV de alunos + campo `modalidade` (dropdown) |
| `POST` | `/importacao/turmas` | CSV de turmas reais |
| `GET` | `/importacao` | Histórico de importações (auditoria) |

### Consulta do que foi importado

Todas exigem JWT de admin e **nada aqui edita um registro**: a planilha é a
fonte de verdade, e um ajuste feito por aqui seria desfeito no próximo upload sem
ninguém perceber. Para corrigir um campo, corrige-se o CSV e reimporta.

As duas exceções são de **apagar**, não de editar, e existem pelo mesmo motivo:
**a importação é `upsert` e nunca remove o que saiu do arquivo**. Sem uma ação
explícita, a linha errada fica no banco para sempre — reimportar não a apaga.

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/alunos` | Pesquisa os vínculos importados — paginada |
| `GET` | `/alunos/cursos` | Cursos distintos, para o dropdown do filtro |
| `GET` | `/alunos/:id` | O vínculo: origem, outros vínculos do mesmo RA e provas marcadas |
| `POST` | `/alunos/:id/mesclar` | Funde o vínculo duplicado pela troca de grafia do curso |
| `GET` | `/turmas` | Pesquisa as turmas/disciplinas do CSV — paginada |
| `GET` | `/turmas/:id` | A turma: origem e quantos agendamentos a cobrem |
| `DELETE` | `/turmas/:id` | Tira a turma do catálogo — ela deixa de ser agendável |

**`POST /alunos/:id/mesclar`** resolve a duplicata que a troca de grafia do curso
cria: quando o nome do curso muda, a linha antiga deixa de estar no arquivo e a
importação nunca apaga. O `:id` da URL é o vínculo que **fica** e `absorverId`
(no corpo) é o que será **apagado**, na mesma direção do relatório de importação.
Recusa matrículas diferentes (400) e recusa quando os dois têm prova confirmada
no mesmo período letivo (409); divergência de modalidade ou polo não bloqueia e
volta em `avisos`.

**`DELETE /turmas/:id`** desfaz carga errada — linha duplicada, turma que entrou
na planilha sem ter prova. O efeito é imediato: a disciplina sai do filtro final
e ninguém mais consegue agendá-la.

- **Não substitui corrigir a planilha.** Se a linha continuar no CSV, o próximo
  upload traz a turma de volta — com id novo e **sem o `orgUnitId`** que os
  launches já tinham aprendido. Apagar aqui conserta agora; tirar da planilha
  conserta de verdade. A resposta diz isso, e a tela avisa antes de confirmar.
- **Turma com prova marcada é recusada (409).** Apagar não desmarcaria nada — o
  agendamento aponta para a disciplina pelo `orgUnitId`, como fotografia e sem
  chave estrangeira —, só tiraria o nome da turma do relatório, que passaria a
  nomear o arquivo pelo número cru do D2L. Se as provas não deviam existir, o
  caminho é cancelá-las (`DELETE /agendamentos/:id`) antes.

**Cada item de `/alunos` é um vínculo (aluno + curso), não um aluno.** O mesmo RA
em dois cursos aparece como duas linhas, com modalidades possivelmente diferentes
e um agendamento para cada.

`busca` é um campo só e casa com vários ao mesmo tempo — matrícula, nome, e-mail
ou curso em `/alunos`; código da turma, nome da disciplina, código EAD ou
`orgUnitId` em `/turmas`. Quem atende no balcão nem sempre sabe qual dado a
pessoa tem em mãos.

Filtros úteis: `agendado=false` (quem ainda **não** marcou prova — a lista de
quem precisa ser cobrado), `ativo=false` (quem está na base mas o STATUS CURSO
bloqueia), `importacaoId` (o que veio de um upload específico) e
`comOrgUnitId=false` (turmas que nenhum launch alcançou ainda).

Parâmetro desconhecido na URL **não derruba a requisição** aqui: os filtros são
lidos à mão, sem DTO, porque URL de busca é coisa que se cola, edita e
compartilha.

### Estrutura física e oferta de vagas

Todas exigem JWT de admin. A oferta (`SalaFaixa`) nunca nasce solta: ela é criada
por dentro da faixa.

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/modalidades` | Lista (só leitura — vêm do seed) |
| `GET` `POST` `PATCH` `DELETE` | `/polos` · `/polos/:id` | `nome` não é editável: é a chave de casamento com o CSV. Ver "Campus que sai da oferta" |
| `GET` `POST` `PATCH` `DELETE` | `/salas` · `/salas/:id` | `poloId` imutável; só apaga o que nunca foi ofertado |
| `GET` `POST` `PATCH` `DELETE` | `/faixas` · `/faixas/:id` | Cria a faixa e a oferta numa transação |
| `POST` | `/faixas/:id/salas` | Adiciona sala a uma faixa existente |
| `GET` `PATCH` `DELETE` | `/sala-faixas/:id` | Ajusta vagas e ordem; modalidade é imutável |

**Uma sala não recebe duas provas ao mesmo tempo.** O `@@unique([salaId, faixaId])`
é por *faixa*, não por *horário*: ele impede a sala de entrar duas vezes na mesma
faixa, mas nada impedia `09:00-12:00 EAD` e `10:30-12:00 SEMI` na mesma sala e no
mesmo dia — duas ofertas válidas, e duas listas de presença para a mesma porta,
descobertas só no dia da prova. As três rotas que podem criar o choque
(`POST /faixas`, `POST /faixas/:id/salas` e `PATCH /faixas/:id`) respondem **409**.

Detalhes que importam: o intervalo é **semiaberto** (08:30-10:00 e 10:00-11:30
convivem — a sala vaga quando a prova acaba); uma faixa concorrente **inativa e
sem ninguém confirmado não ocupa** a sala, mas inativa **com** confirmado ocupa,
porque desativar não cancela prova nenhuma; e o `PATCH` só reconfere quando
`data`/`horaInicio`/`horaFim` mudam de fato — mover a faixa arrasta todas as
salas dela junto, e é o caminho menos óbvio para criar o choque.

### Período de agendamento

Exigem JWT de admin. A janela em que se pode agendar — **não confundir com as
datas das provas**, que são as faixas. São duas linhas do tempo independentes.

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/periodos` | Histórico; o primeiro da lista é o vigente |
| `GET` | `/periodos/:id` | Detalhe, com quantos já agendaram |
| `POST` | `/periodos` | Cria — **nasce fechado**, para conferir as faixas antes de liberar |
| `PATCH` | `/periodos/:id` | Abre, fecha ou ajusta o prazo |
| `DELETE` | `/periodos/:id` | Só apaga período **sem agendamento nenhum**; devolve quem virou vigente |

Fecha **só por data/hora**. Vaga esgotando é problema de capacidade (o admin abre
mais salas), nunca motivo para encerrar o agendamento de quem ainda não escolheu.

#### Duas grades no mesmo ano: o período letivo por modalidade

A UCB divide o ano de **duas formas ao mesmo tempo**:

| Modalidade | Divisão | Períodos por ano |
|---|---|---|
| EaD, Semipresencial, Modular | **módulo** | 4 — `2026/1` a `2026/4` |
| Presencial | **semestre** | 2 — `2026/1` e `2026/2` |

No Brightspace isso são **dois org units de Período Letivo diferentes e vivos ao
mesmo tempo**: em novembro de 2026 o aluno EaD está sob `2026/4` e o presencial
sob `2026/2`. Como as disciplinas agendáveis saem dos descendentes desse org
unit, uma janela com um `periodoLetivoId` único obrigaria a escolher uma das
grades — e a outra metade da universidade ficaria sem disciplina nenhuma, **sem
erro nenhum**: o id que não bate responde 200 com lista vazia.

Por isso uma janela guarda um **mapa `modalidade → periodoLetivoId`**:

```jsonc
POST /periodos
{
  "periodoLetivoId": "8811",          // o PRINCIPAL: rótulo da janela e fallback
  "rodada": "N2",
  "dataFechamento": "2026-11-20T23:59:00-03:00",
  "letivosPorModalidade": [
    { "modalidadeCodigo": "EAD",        "periodoLetivoId": "8811" },  // 2026/4
    { "modalidadeCodigo": "SEMI",       "periodoLetivoId": "8811" },
    { "modalidadeCodigo": "MODULAR",    "periodoLetivoId": "8811" },
    { "modalidadeCodigo": "PRESENCIAL", "periodoLetivoId": "8790" }   // 2026/2
  ]
}
```

- **O prazo continua único.** Datas, `rodada` e critérios de nota valem para todas as
  modalidades — é UMA janela. O que varia é só qual árvore do Brightspace
  consultar.
- **O mapa tem de cobrir TODAS as modalidades** (400 nomeando as que faltam).
  Cobrir pela metade é pior que não cobrir: a esquecida cairia no principal em
  silêncio. **Omitir o campo inteiro** põe todas no principal — o caso de quem
  tem uma grade só.
- **A reserva grava o período letivo da grade do aluno**, resolvido pela
  modalidade do vínculo. Um RA com um vínculo EaD e um Presencial tem duas provas
  nessa mesma janela, sob org units diferentes — e **continua valendo uma prova
  por pessoa em cada horário**, atravessando as duas grades.
- **O mapa só é editável com a janela vazia**, como a `rodada` e pelo mesmo
  motivo (o `periodoLetivoId` da reserva é fotografia). Reenviar o mapa igual não
  dispara a trava, então editar datas de uma janela cheia continua funcionando.
- **O filtro `periodoLetivoId` das rotas de admin aceita uma lista** separada por
  vírgula. As telas mandam a janela inteira; um id sozinho recorta aquela grade.
- **A migration fez o backfill** (toda janela × toda modalidade, apontando para o
  id que ela já tinha). Nada a fazer à mão.

#### `rodada`: duas provas no mesmo semestre

O Brightspace tem **um** `periodoLetivoId` por semestre, e existe mais de uma
prova nele — a regular e a **substitutiva**. O campo `rodada` (`"N2"` por padrão,
`"SUB"`, `"N1"`…) é a segunda metade da identidade do período: `2026/3 + N2` e
`2026/3 + SUB` são duas janelas distintas, cada uma com seu prazo e suas faixas.

- `POST /periodos` aceita `rodada` (opcional, default `"N2"`). O 409 de duplicata
  é do **par** `periodoLetivoId + rodada` — repetir o semestre com outra rodada é
  exatamente o caso de uso, não um erro.
- **O aluno agenda uma prova por curso em CADA rodada.** Quem marcou a N2 marca
  também a SUB, e `GET /portal/agendamentos` mostra só a da rodada vigente — a
  anterior já aconteceu e fica congelada (sem troca e sem declaração).
- **Mas continua sendo uma prova por pessoa em cada horário**, entre rodadas
  inclusive: quem fez a N2 às 08:30 não pode marcar a SUB no mesmo horário.
- O `Agendamento` guarda a rodada como **fotografia**, junto de `modalidadeId` e
  `poloId`: renomear a rodada da janela depois não remarca prova nenhuma.
- `rodada` só é editável **enquanto a janela não tiver prova nenhuma** (o `PATCH`
  responde 409 depois disso; cancelados contam). A rodada gravada na reserva é
  fotografia — trocar a da janela não renomearia nenhuma delas, e as provas
  sumiriam do portal do aluno como se ninguém tivesse agendado. O
  `periodoLetivoId` **principal** nunca muda; o mapa por modalidade segue a mesma
  regra da rodada (só com a janela vazia).
- **Os períodos que já existiam ganharam `rodada = "N2"` na migration**, junto com
  os agendamentos deles. Nada a fazer à mão.

#### `notaMinimaN1`/`notaMaximaFinal`: quem pode fazer a substitutiva

A `rodada` cria a segunda janela; os **critérios de nota** dizem quem entra nela.
Sem eles, aberta a SUB, o portal ofereceria a substitutiva a todo mundo —
inclusive a quem já passou —, porque o cruzamento de disciplinas filtra só pelo
semestre.

Preenchidos os dois campos, só entra na prova a disciplina em que o aluno passa
nos **dois** critérios:

| Critério | Nota olhada | Comparação |
|---|---|---|
| piso | **N1** | `>= notaMinimaN1` (1,50) |
| teto | **nota final calculada** | `< notaMaximaFinal` (7,00) |

Com 1,5 e 7: quem tirou exatamente 1,50 na N1 **entra**; quem tirou exatamente
7,00 na final **fica de fora**. É por DISCIPLINA — um aluno com três matérias
pode ver só uma na tela.

- ⚠️ **Os dois números NÃO formam um intervalo.** Eles olham notas diferentes:
  não há mínimo para a nota final, nem máximo para a N1. Quem tem final 2,0 com a
  N1 zerada **não** agenda; quem tem N1 9,0 e final 8,0 também não.
- ⚠️ **A regra mudou em 08/09/2026.** Antes os dois limites comparavam a mesma
  nota (a final, em `[1,5 ; 6,75)`), e os campos se chamavam
  `notaMinima`/`notaMaxima`. A migration renomeia as colunas e **não converte os
  números**: o `1,50` gravado vira piso da N1, e o teto continua o que estava lá.
  **Confira a janela da substitutiva na tela antes de abri-la.**
- **A N1 é achada pelo NOME da categoria de notas da turma** (`D2L_CATEGORIA_N1`,
  default `"N1"`) — o `CategoryId` é diferente em cada turma, então não há id
  fixo possível. Turma que nomear a categoria de outro jeito ("Nota 1") recusa
  **todos** os seus alunos, com um aviso por turma no log. `npm run d2l:notas`
  mostra isso antes do dia.
- **Nulos = sem filtro**, e é o caso da N2 e de todo período que já existia: a
  prova cobre as disciplinas do semestre e **nenhuma nota é consultada**.
- **Os dois andam juntos.** Mandar um só responde 400: meio critério seria lido
  como "sem filtro" e a prova abriria para todos, sem erro nenhum aparecendo.
- ⚠️ **O gatilho são estes campos, nunca `rodada === "SUB"`.** `rodada` é texto
  livre — quem a nomeia é a secretaria —, e amarrar a regra à string a faria
  parar de valer no dia em que alguém cadastrasse "Substitutiva".
- **São editáveis mesmo com a janela cheia**, ao contrário da `rodada`: não ficam
  gravados em reserva nenhuma. Mas as provas já marcadas **não** são revistas, e
  a alteração vai para a auditoria.
- **Sem conseguir ler as notas, ninguém agenda** (*fail-closed*). Valence fora,
  `D2L_HABILITADO=false` ou escopo faltando: a tela diz que não foi possível
  confirmar as notas e manda à secretaria. Não há degradação possível — liberar
  sem conferir é o que a regra existe para impedir. Na N2 o fallback de sempre
  continua valendo.
- **Exige os escopos `grades:gradevalues:read` e `grades:gradecategories:read`**
  (o segundo entrou com a N1), e escopo vive no **consentimento**: acrescentá-lo
  ao `.env` sem `npm run d2l:autorizar` deixa o GET correspondente em 403.
  Confira a leitura antes de abrir a janela com
  `npm run d2l:notas -- <orgUnitId> <userId>`.
- As notas que decidiram ficam gravadas em `AgendamentoDisciplina.notaFinal` e
  `.notaN1` — é a resposta para "por que ele agendou substitutiva desta matéria?"
  meses depois. A `notaN1` é nula nas reservas anteriores a 08/09/2026.
- ⚠️ **O aluno não vê os números.** Nem os limites, nem a nota dele: a tela só
  diz que a lista traz as disciplinas em que ele tem direito, e que ele deve
  **responder o formulário de suporte** se faltar alguma. A nota e o critério são
  assunto dele com a secretaria — a tela de agendamento só produziria discussão
  sobre o número com quem não decide nada. Vale para as duas mensagens: a do
  portal e a do backend (quando nenhuma disciplina passa).
- No compulsório, quem fica de fora por nota aparece no relatório como
  `NAO_ELEGIVEL_PELA_NOTA` — o único motivo que **não pede ação** da secretaria,
  e o mais numeroso num lote de substitutiva.

**Vigente = o cadastrado mais recentemente**, e não existe como marcar outro no
lugar. Por isso cadastrar o semestre seguinte com antecedência **rouba o vigente
do período em curso** — a linha nova passa a ser a única que o portal do aluno
consulta. O `DELETE` é a saída para isso e para cadastro errado, com duas travas:
a janela (`periodoLetivoId` + `rodada`) que já tem agendamento (**contando os
cancelados**) responde 409, e
a resposta traz `vigenteAgora` porque apagar o mais recente devolve o portal ao
semestre anterior, normalmente com o prazo já vencido. Para encerrar o prazo sem
perder o histórico, é o `PATCH` — não este.

### Relatório de agendamentos

Exigem JWT de admin. Todas aceitam os mesmos filtros: `poloId`, `faixaId`,
`salaId`, `modalidadeId`, `periodoLetivoId`, `rodada`, `de`, `ate` (data da
**prova**).

`periodoLetivoId` aceita uma **lista separada por vírgula** — uma janela cobre
mais de um período letivo ao mesmo tempo (o do módulo e o do semestre), e as
telas mandam a janela inteira. Sem ele, o recorte é a janela vigente completa.

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/agendamentos` | Listagem paginada (50/pág, máx. 200), com busca por matrícula, nome ou curso |
| `GET` | `/agendamentos/resumo` | Ocupação por sala: quais abrir, quantos fiscais, quais ficaram vazias |
| `GET` | `/agendamentos/estatisticas` | A tela de Início: adesão da rodada vigente (vínculos ativos com prova), por modalidade e por quem agendou (aluno, compulsório, admin), agendamentos por dia e vagas restantes x pendentes por polo + modalidade |
| `GET` | `/agendamentos/exportacao` | **CSV de TODOS os alunos** — agendados ou não |
| `GET` | `/agendamentos/:id` | Detalhe |
| `GET` | `/agendamentos/:id/historico` | **Quem alterou**: o próprio aluno ou qual administrador |
| `POST` | `/agendamentos` | **Agenda a prova de um aluno específico**, em nome da secretaria |
| `PATCH` | `/agendamentos/:id/remanejar` | Move de sala (`salaFaixaId`) ou de horário (`faixaId`) |
| `DELETE` | `/agendamentos/:id` | Cancela (vira `CANCELADO`, não apaga) |

O remanejo **não depende do período estar aberto** — consertar depois do
fechamento é justamente o caso de uso.

Sem `status` explícito, a **consulta** traz apenas os **confirmados** — um
cancelado na lista do dia da prova faria alguém procurar um aluno que não vem.

### Agendamento pelo admin (um aluno)

O atendimento de balcão, e a outra ponta do compulsório: lá é o lote inteiro (no
mínimo um polo), aqui é **uma pessoa**. É esta rota que fecha a fila de trabalho
do relatório de exceções — antes dela, depois de abrir a sala que faltava, a
única ação disponível era redisparar o lote do polo todo (`PATCH /remanejar`
exige um agendamento que já exista, e não cria nenhum).

```jsonc
// POST /api/agendamentos — um dos dois destinos, nunca os dois
{ "alunoId": 3120, "faixaId": 14 }      // a alocação escolhe a sala (menor ordem até lotar)
{ "alunoId": 3120, "salaFaixaId": 55 }  // o admin escolhe a sala exata

// resposta
{
  "agendamento": { "id": 512, "sala": "M114", "alocadoManual": true, ... },
  "origemDasDisciplinas": "BRIGHTSPACE",
  "avisos": []
}
```

**Fica registrado que foi o ADMIN, não o aluno**: `HistoricoAgendamento` grava
`CRIADO` com o e-mail de quem clicou, e o agendamento nasce com
`alocadoManual: true` — que aqui significa "isto não saiu do portal do aluno",
mesmo quando a alocação escolheu a sala.

**Recusa o mesmo que o remanejo** (outro polo, outra modalidade, sala lotada, e a
mesma pessoa duas vezes no mesmo horário), mais o que só faz sentido ao criar:
aluno que já tem prova no semestre (para mudar de horário existe o remanejo) e
situação de curso que bloqueia — esta última liberável com
`"ignorarStatusCurso": true`, que volta em `avisos` e vai para a auditoria.
Bloquear de vez trancaria a secretaria justamente no caso em que ela precisa da
válvula de escape.

**As disciplinas cobertas** vêm do Brightspace quando `D2L_HABILITADO`; sem ele,
ou se a Valence não responder, são copiadas da **reserva anterior do aluno neste
semestre — a cancelada serve**, e é o caso `CANCELOU_E_NAO_REMARCOU` que o
compulsório deixa de fora de propósito. `origemDasDisciplinas` diz qual das duas
foi (`BRIGHTSPACE` ou `RESERVA_ANTERIOR`) e `avisos` traz o motivo. Sem nenhuma
das duas fontes a rota **recusa**: `userIdD2L` é coluna obrigatória, e uma prova
que não cobre disciplina nenhuma não libera nada no LMS.

Como o remanejo, **não depende do período estar aberto**.

### Agendamento compulsório

Fechado o prazo, **quem não agendou não fica sem prova**: a secretaria dispara um
lote que aloca todo mundo automaticamente.

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/agendamentos/compulsorio` | Dispara. Responde na hora com um `id`; **simula por padrão** |
| `GET` | `/agendamentos/compulsorio/:id` | Andamento e contagem por motivo |
| `GET` | `/agendamentos/compulsorio/:id/relatorio` | CSV de quem ficou de fora |

```jsonc
// POST /api/agendamentos/compulsorio
{ "simulacao": true, "poloId": 27 }   // poloId é opcional; sem ele, roda para todos

// resposta imediata
{ "id": 3, "simulacao": true, "totalElegiveis": 4812 }
```

**Preenche em duas dimensões:** as **datas** da mais próxima para a mais distante
e, dentro de cada faixa, as **salas** por ordem até lotar. É a mesma lógica do
portal, uma dimensão acima — concentrar em vez de espalhar, para não manter o
campus mobilizado o período inteiro com fiscal em sala vazia.

**Quem entra:** vínculo `ativo` sem prova confirmada no período letivo. Ficam de
fora quem já agendou e quem **cancelou e não remarcou** — este último aparece no
relatório, porque ficar sem lugar nenhum é decisão a tomar caso a caso.

**Rode a simulação primeiro.** Ela percorre a alocação inteira contando as vagas e
não grava nada. É como se responde "cabe todo mundo?" — descobrir no meio de uma
execução real que não cabia deixaria metade dos alunos alocados e metade não.

**Demora**, e por isso responde na hora com um `id`: são ~1,5s por aluno (duas
chamadas ao Brightspace), ou ~25 min para 7 mil. A tela consulta o `GET` enquanto
o `status` for `EM_ANDAMENTO`. Se o processo morrer no meio, a consulta passa a
devolver `interrompida: true` — e rodar de novo **retoma de onde parou**, sem
duplicar ninguém.

**Exige `D2L_HABILITADO=true`**: é a integração que descobre as disciplinas de
quem nunca entrou pelo link do Brightspace. O `userIdD2L` dessas pessoas não está
gravado em lugar nenhum (ele só nasce no launch) e é resolvido pelo RA, via
`users/?orgDefinedId=`.

O relatório sai **ordenado por motivo**, porque cada bloco é uma ação diferente:
`SEM_VAGA` pede abrir sala, `SEM_CONTA_D2L` pede chamado no suporte do LMS,
`SEM_DISCIPLINA_AGENDAVEL` pede conferir o CSV de turmas (o detalhe traz o código
da oferta que não casou). `AVISO_CONTA_INATIVA_D2L` é o único que aparece para
quem **foi** alocado: tem lugar na sala, mas a conta está desativada no
Brightspace e do jeito que está não abriria a prova.

#### A exportação é de alunos, não de agendamentos

`GET /agendamentos/exportacao` responde outra pergunta: **com quem a secretaria
precisa falar.** Por isso a base são os **vínculos importados, todos eles**, e o
agendamento entra como coluna — quem ainda não marcou sai no arquivo com as
colunas da prova vazias e `Status = Não Agendado`.

| Coluna | |
|---|---|
| `Matricula` · `Aluno` · `E-mail` · `Curso` · `Modalidade` · `Polo` | do vínculo importado |
| `Rodada` | qual prova do semestre (`N2`, `SUB`…); vazia para quem não agendou |
| `Data da prova` · `Inicio` · `Fim` · `Sala` | vazias para quem não agendou |
| `Status` | **só dois valores**: `Agendado` ou `Não Agendado` |
| `Agendado em` | data/hora em que o aluno confirmou |

- **Cancelado conta como `Não Agendado`.** Quem cancelou e não remarcou precisa
  ser contatado igual a quem nunca entrou no portal. É também por isso que
  `status` não se aplica aqui: a coluna é **derivada**, não filtrada.
- **O recorte é uma prova: `periodoLetivoId` + `rodada`** — os da URL ou os do
  período vigente. Sem o semestre, quem fez prova no semestre passado apareceria
  como "agendado"; sem a rodada, quem fez a regular apareceria como "agendado"
  durante a substitutiva. Informar `periodoLetivoId` **sem** `rodada` traz o
  semestre inteiro, de propósito.
- `faixaId`, `salaId`, `de` e `ate` são filtros da **prova**: informá-los
  restringe o arquivo a quem tem prova ali (é a lista daquela sala/daquele dia).
  `poloId`, `modalidadeId` e `busca` filtram o **aluno** e continuam trazendo
  quem não agendou.

### Relatórios — grupos para o Brightspace

A aba **Relatorios** do painel tem **dois documentos**, com públicos opostos: os
grupos abaixo, lidos por máquina, e as [listas de presença](#listas-de-presença-pdf--o-papel-que-vai-para-a-sala),
lidas por gente, no papel. Este primeiro gera o arquivo que o *Groups Import* do
Brightspace consome, para criar um grupo por horário de prova **de cada turma**
(e depois liberar o quiz para o grupo).

Filtros comuns às três rotas: `poloId`, `periodoLetivoId`, `de`, `ate` (data da
**prova**). Na rota de um arquivo só, `poloId`/`de`/`ate` são ignorados — quem
pediu aquele grupo já escolheu a faixa, e um filtro esquecido na URL devolveria
404 em vez do arquivo.

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/relatorios/grupos-d2l` | Lista os grupos do recorte com quantos alunos cada um tem |
| `GET` | `/relatorios/grupos-d2l/zip` | Zip com o CSV de todos, em uma pasta por turma |
| `GET` | `/relatorios/grupos-d2l/:faixaId/:orgUnitId` | O CSV de uma turma num horário |

O arquivo tem **duas colunas**: `Nome de usuário` com a matrícula (RA) e
`Código do Grupo` **em branco** — o código é preenchido à mão depois de criar o
grupo no D2L.

```
Nome de usuário,Código do Grupo
UC25426847,
0009552430,
```

- **Um arquivo por HORÁRIO E TURMA.** O grupo vive *dentro* de uma disciplina do
  Brightspace (`orgUnitId`) e libera o quiz **dela**. Uma lista com o horário
  inteiro importaria sem erro nenhum e daria acesso à prova de HISTÓRIA para quem
  só cursa NUTRIÇÃO. O mesmo aluno sai em vários arquivos — um por disciplina que
  a prova dele cobre.
- **Nem a sala nem o polo entram**: o grupo libera o quiz numa janela de tempo, e
  onde a pessoa senta — que cadeira, que campus — não muda o acesso. A mesma
  prova aplicada em dois polos no mesmo dia e horário sai num **arquivo só**.
  Por isso `poloId` estreita a *listagem* e nunca o *conteúdo* do arquivo:
  filtrado, ele continua saindo com os alunos de todos os campi.
- **Cada matrícula aparece uma vez por arquivo.** Um RA com dois vínculos na
  mesma modalidade pode ter dois agendamentos na mesma janela cobrindo a mesma
  disciplina; o grupo é por *usuário*.
- **Só agendamentos `CONFIRMADO`**, no período letivo do recorte (ou o vigente).
- Nome do arquivo:
  **`20-08-2026 08h30-11h30 - GSPS0I10227 - HISTORIA E CULTURA.csv`** — horário,
  código da turma e disciplina, **sem acento** (só no nome; na tela e no conteúdo
  o nome fica inteiro). O `codigoTurma` vem de `TurmaImportada`, achada pelo
  `orgUnitId` que o launch ensinou; sem ele o nome cai em `orgUnit <id>`.
- O **zip é organizado em uma pasta por turma**, com o horário no arquivo:

  ```
  GSPS0I10227 - HISTORIA E CULTURA DO CORPO/
      20-08-2026 08h30-11h30.csv
      20-08-2026 14h00-17h00.csv
  ```

  O sufixo `#<orgUnitId>` só aparece no caso raro de duas disciplinas gerarem a
  mesma pasta depois do corte de 60 caracteres do nome. Dois polos no mesmo
  horário **não** produzem dois arquivos — são um grupo só.
- **Horário sem ninguém agendado não aparece**: as linhas nascem dos
  agendamentos, e uma faixa não "tem" disciplinas — são os alunos que as trazem.
  Ocupação por horário é `GET /agendamentos/resumo`.

#### ⚠️ Este CSV é o oposto do outro

| | `/agendamentos/exportacao` | `/relatorios/grupos-d2l/:faixaId/:orgUnitId` |
|---|---|---|
| Quem lê | Pessoa, no Excel pt-BR | O Brightspace |
| Separador | `;` | `,` |
| BOM UTF-8 | sim | **não** |
| Colunas | 12 | 2 |

Com `;` o D2L lê a linha inteira como um campo só; com BOM, os três bytes grudam
no cabeçalho e `Nome de usuário` deixa de casar com a coluna esperada. O
montador é o mesmo (`csv-relatorio.ts`), parametrizado por `{ separador, bom }`,
com **default no formato do Excel**.

### Grupos no Brightspace — criar e inscrever pela API

Tela **Grupos D2L**. Substitui o import manual dos CSVs da seção anterior (que
continuam disponíveis). O admin escreve os nomes dos grupos de cada bloco — **EaD**
(categoria `Provas Presenciais - EAD`), **Semipresencial/Modular** (categoria
`Provas Presenciais - Semi e Modular`) e **Presencial** (categoria
`Provas Presenciais - Presencial`) —, uma linha por sessão, e usa dois botões:
**Criar categorias e grupos** e **Inscrever alunos**.

| Método | Rota | O que faz |
|---|---|---|
| `GET` | `/grupos-d2l/painel?de=&ate=` | Nomes por bloco, horários válidos, pendências de horário e as últimas execuções. Sem intervalo, usa os dias de prova já agendados |
| `PUT` | `/grupos-d2l/nomes` | Substitui os nomes de **um** bloco no intervalo — o que não vier é apagado. Grava na grade de grupos (a mesma do disparo do quiz) |
| `POST` | `/grupos-d2l/horarios/resolver` | Faixa sem janela de mesmo horário: escolhe se vale o horário da faixa ou o da janela |
| `POST` | `/grupos-d2l/execucoes` | `CRIAR_GRUPOS` ou `INSCREVER_ALUNOS`. Responde na hora com um `id`; **simula por padrão** |
| `GET` | `/grupos-d2l/execucoes/:id` | Andamento e contagem por resultado |
| `GET` | `/grupos-d2l/execucoes/:id/relatorio` | CSV da execução, com as pendências primeiro |

```jsonc
// PUT /api/grupos-d2l/nomes
{
  "bloco": "SEMI_MODULAR",
  "de": "2026-09-14",
  "ate": "2026-09-19",
  "linhas": [
    { "data": "2026-09-16", "horaInicio": "08:30", "horaFim": "10:00", "nomeGrupo": "16/09 - 8h30 as 10h" }
  ]
}

// POST /api/grupos-d2l/execucoes
{ "tipo": "INSCREVER_ALUNOS", "simulacao": true, "de": "2026-09-14", "ate": "2026-09-19" }
```

- **A Valence não tem inscrição em lote**: é um POST por aluno. O lote lê os
  inscritos de cada turma numa chamada e só escreve a diferença; rodar de novo sem
  mudança nenhuma responde `nadaAFazer: true` sem chamar o Brightspace
  (`forcar: true` confere mesmo assim).
- **Remanejo**: na inscrição, o aluno entra no grupo do horário novo e sai do
  antigo. Usuário que o portal não conhece nunca é removido.
- **`orgUnitId` (opcional) roda só numa turma.** Use no primeiro uso real: a
  simulação não cria categoria, então o primeiro teste de verdade deve ser pequeno.
- **Escopos** (reautorize com `npm run d2l:autorizar` depois de acrescentar):
  `groups:group:create groups:enrollment:create groups:enrollment:delete`.
- Ritmo: `GRUPOS_D2L_DELAY_MS` (400) e `GRUPOS_D2L_TIMEOUT_MS` (30000).

### Special access por agendamento

Tela **Special access**. Em vez de trocar a data e o grupo do questionário a cada
sessão, a prova fica **sem data** e visível **só para quem tem special access**, e
cada aluno agendado recebe a janela da faixa dele. Convive com a troca de datas e
grupos até substituí-la.

| Campo gravado | Valor |
|---|---|
| Abertura | início da faixa, no **fuso do polo** (Cruzeiro do Sul = Acre, 2h depois de Brasília) |
| Fechamento | fim da faixa; **NIOP: + o tempo extra** |
| Tempo de prova | o da modalidade da reserva (editável na tela); **NIOP: + o tempo extra** (60 min por padrão) |

| Método | Rota | O que faz |
|---|---|---|
| `GET`/`PUT` | `/special-access/configuracao` | Tempo de prova por modalidade, extra do NIOP e "substituir as janelas" |
| `POST` | `/senhas-de-prova/execucoes` (`tipo: PREPARO`) | **Prepara** os questionários: sem data, restritos a special access, sem condição de grupo (com backup), com a senha da célula `data` + `turno` |
| `POST` | `/special-access/execucoes` | **Grava** o acesso de cada aluno agendado; atualiza remanejados e remove cancelados. Responde com um `id`; **simula por padrão** |
| `GET` | `/special-access/execucoes/ultima` · `/:id` · `/:id/relatorio` | Andamento, contagem por resultado e CSV (horários no relógio de Brasília) |
| `GET` | `/special-access/turmas` | As turmas com reserva na rodada, com alunos e acessos de cada uma. Só banco: escolher não custa chamada ao Brightspace |
| `PUT`/`DELETE` | `/alunos/niop/:matricula` | Marca/desmarca o NIOP da matrícula (todos os cursos dela) |
| `GET` | `/polos/fusos` | Fusos aceitos; `PATCH /polos/:id` grava `fuso` |

```jsonc
// POST /api/senhas-de-prova/execucoes — preparar duas turmas
{ "tipo": "PREPARO", "data": "2026-09-16", "turno": "MANHA", "simulacao": true,
  "orgUnitIds": ["156979", "156980"] }

// POST /api/special-access/execucoes — vazio ou ausente = todas as turmas
{ "simulacao": true, "orgUnitIds": ["156979"] }
```

- **Ordem de teste**: configurar tempos e NIOP → preparar **uma** turma → gravar a
  mesma turma → conferir no Brightspace → rodar em todas → ligar "substituir as
  janelas".
- **Enquanto "substituir as janelas" estiver desligado, o cron continua aplicando
  data e grupo**, inclusive nas turmas preparadas. Ligado, ele só troca a senha, e
  o lote manual de datas recusa.
- **Só a diferença é gravada**: rodar de novo é barato. Special access de quem não
  tem reserva na turma nunca é tocado.
- **`orgUnitIds` fatia a carga.** Os dois lotes aceitam uma lista de turmas
  (vazio = todas), e a tela a monta com `GET /special-access/turmas`, que mostra
  alunos e acessos por turma. Turma escolhida que não casa **recusa a execução
  inteira** — rodar nas outras esconderia a que ficou de fora até o dia da prova.
- **Escopo**: `quizzing:quizzes:read,write,delete` no consentimento (reautorize).
- Ritmo: `SPECIAL_ACCESS_DELAY_MS` (400) e `SPECIAL_ACCESS_TIMEOUT_MS` (30000).

### Listas de presença (PDF) — o papel que vai para a sala

O documento que a secretaria imprime, o fiscal leva para a sala e volta assinado.
**Uma página por sala de aplicação.** Mesma aba **Relatorios** do painel, mesmos
filtros (`poloId`, `periodoLetivoId`, `de`, `ate` — data da **prova**). Na rota de
uma sala só, `poloId`/`de`/`ate` são ignorados, pela mesma razão de sempre: quem
pediu aquela folha já escolheu o horário.

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/relatorios/listas-de-presenca` | Lista as salas que terão aplicação e quantos assinam em cada |
| `GET` | `/relatorios/listas-de-presenca/pdf` | O PDF do recorte, uma página por sala |
| `GET` | `/relatorios/listas-de-presenca/:salaFaixaId/pdf` | A folha avulsa de uma sala |

Cada página traz o cabeçalho (modalidade, polo, data, horário, sala) e a tabela:

```
              EaD    Câmpus Asa Sul
             11/06/2026 09:00 - 12:00
                   SALA 1 EAD

┌────┬────────────┬──────────────────────────┬────────────┬─────────────┐
│ Nº │     RA     │           Nome           │ Modalidade │ Assinatura  │
├────┼────────────┼──────────────────────────┼────────────┼─────────────┤
│ 1  │ UC26426197 │ ERIK MACEDO SANTOS       │ EaD        │             │
│ 2  │ UC26421421 │ MATEUS DA SILVA ALARÇÃO  │ EaD        │             │
└────┴────────────┴──────────────────────────┴────────────┴─────────────┘
```

- **O recorte é a SALA**, não o horário. Uma folha com a faixa inteira imprimiria
  sem erro nenhum, e o fiscal da SALA 1 receberia uma lista com quem está na
  SALA 2 — chamando nome de quem não está ali. É o oposto do grupo do D2L, onde
  a sala **não** entra porque não muda o acesso ao quiz.
- **Uma linha por pessoa.** A folha é assinada à mão: o mesmo RA duas vezes faria
  o fiscal chamar a mesma pessoa duas vezes e sobrar uma linha em branco no fim.
  Desde a regra "uma prova por pessoa em cada horário" o RA de dois cursos não
  consegue mais marcar as duas provas na mesma faixa, então um repetido só existe
  em agendamento anterior a ela — e nesse caso `totalAlunos` fica **menor** que
  `ocupadas` em `GET /agendamentos/resumo`. A divergência é o sintoma do dado
  velho; o certo é cancelar o agendamento duplicado.
- **Só agendamentos `CONFIRMADO`**, no período letivo do recorte (ou o vigente).
  Quem cancelou devolveu a vaga e não aparece.
- **Sala sem ninguém agendado não vira página** — não haverá aplicação ali, e
  folha em branco no meio da pilha só faz procurar o erro.
- **Ordem alfabética por nome** dentro da página (é por ele que o fiscal procura
  a pessoa na frente dele); as páginas saem por **dia → horário → polo → sala**,
  de modo que a pilha já sai separável por campus.
- **Sala grande continua na página seguinte**, com o cabeçalho repetido e marcado
  `(cont.)`, e a numeração seguindo de onde parou.
- **A coluna `Assinatura` é uma célula vazia com borda** — a linha da tabela é a
  linha em que se assina. Não há linha em branco no fim: a folha é a relação de
  quem tem lugar ali.
- Nome do arquivo:
  **`Lista de presenca - 11-06-2026 09h00-12h00 - Campus Asa Sul - SALA 1 EAD.pdf`**.
  Aqui **o polo entra** (ao contrário do CSV de grupos): as folhas de dois campi
  vão para lugares físicos diferentes, e sala homônima em dois polos é comum.

**O logo é opcional.** Coloque um `logo.png` em `src/relatorio/assets/` e ele
passa a aparecer no canto superior esquerdo de toda página — nada mais precisa
mudar. Sem o arquivo, o PDF sai só com o cabeçalho de texto, que já identifica a
folha. Detalhes de tamanho em `src/relatorio/assets/LEIA-ME.md`.

O PDF é gerado com **`pdfkit`**, usando a Helvetica padrão do formato
(`WinAnsiEncoding` cobre todo acento do português, sem embutir arquivo de fonte).
O desenho fica isolado num módulo puro (`pdf-lista-presenca.ts`, recebe dados e
devolve `Buffer`), separado das consultas (`lista-presenca.service.ts`).

### Senha das provas nos questionários do Brightspace

A secretaria cadastra uma grade **dia × turno → senha** e o sistema troca o campo
`Password` do questionário da prova em todas as turmas — manualmente por um botão,
ou sozinho por cron nos horários configurados.

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/senhas-de-prova?de=&ate=` | A grade do intervalo. **Nunca devolve o valor da senha** — só `temSenha` |
| `PUT` | `/senhas-de-prova` | Cadastra/atualiza a célula `(data, turno)` |
| `GET` | `/senhas-de-prova/:id/revelar` | O valor em texto claro. **Auditado e com throttle apertado** |
| `DELETE` | `/senhas-de-prova/:id` | Retenção: apaga a senha, preservando o histórico da execução |
| `GET`/`PUT` | `/senhas-de-prova/alvo` | Qual questionário o lote procura (nome + `EXATO`/`CONTEM`) |
| `GET`/`PUT` | `/senhas-de-prova/horarios` | A que horas o cron aplica cada turno. Turno em branco não dispara |
| `GET` | `/senhas-de-prova/turmas` | Pré-visualiza **quais turmas serão tocadas**, e quais não resolveram |
| `PUT`/`DELETE` | `/senhas-de-prova/turmas/:turmaId/modalidade` | Desempata a turma **ambígua** — e só ela. Ver abaixo |
| `POST` | `/senhas-de-prova/execucoes` | Dispara. Responde na hora com um `id`; **simula por padrão** |
| `GET` | `/senhas-de-prova/execucoes/ultima?origem=` | A execução mais recente. É por aqui que a tela **enxerga o cron** — ele não tem quem o acompanhe |
| `GET` | `/senhas-de-prova/execucoes/:id` | Andamento e contagens |
| `GET` | `/senhas-de-prova/execucoes/:id/relatorio` | CSV do que aconteceu em cada turma. **Sem coluna de senha** |

```jsonc
// PUT /api/senhas-de-prova
{ "data": "2026-09-16", "turno": "MANHA", "senha": "897325" }

// POST /api/senhas-de-prova/execucoes
{ "data": "2026-09-16", "turno": "MANHA", "simulacao": true }
// resposta imediata
{ "id": 12, "simulacao": true, "turmasResolvidas": 312 }
```

**Quais turmas.** Todas as do **CSV de turmas importado** que pertencem ao período
letivo vigente. Não se verifica se há agendamento na turma. O `orgUnitId`, que o
CSV não traz, é descoberto cruzando com os descendentes do período letivo e
gravado de volta — é o mesmo match por `Code` composto usado no portal do aluno, e
ele **nunca chuta**: linha ambígua não grava nada e vai para o relatório.

**A senha do turno sobrescreve a do turno anterior, de propósito** — é o que
impede o aluno da manhã de repassar a senha ao da tarde. Justamente por isso,
reprocessar a manhã depois da tarde põe a senha da manhã de volta em todas as
turmas; a reaplicação exige `forcar` e confirmação na tela.

**Rode a simulação primeiro.** Ela percorre tudo, lista cada questionário que
casou com o nome configurado e **não emite nenhum PUT**. É a única conferência
possível antes de mexer na prova de toda a instituição — sobretudo com
`matchQuiz: CONTEM`, em que "Prova" também casa "Prova de recuperação".

**Olhe `naoEncontradas` tanto quanto `falhas`.** Uma turma sem questionário com o
nome configurado não é erro de rede nem falha de ninguém: é uma turma inteira que
não abriria a prova no dia. O mesmo vale para as linhas de
`GET /senhas-de-prova/turmas` que não resolveram — **revise essa lista antes do
primeiro dia**, não depois.

**A turma ambígua tem saída na tela (10/09/2026).** Quando alunos de duas
modalidades têm prova na mesma turma, o sistema não escolhe — o questionário tem
uma janela só, e escolher a maioria trancaria a prova da minoria. Só que "não
escolher" tranca todo mundo: a turma fica fora do lote de datas e a prova
permanece no horário antigo. Foi o caso real de uma turma com **EAD (583) e
MODULAR (1)**.

Na conferência (*Senhas e datas > Conferir*) cada linha dessas agora traz um
seletor com as modalidades em disputa e quantos alunos cada uma tem. A escolha é
de uma **pessoa**, fica gravada com o e-mail e a hora, e vale para a rodada
vigente. Ela **caduca sozinha** se a turma deixar de ser ambígua ou se a
modalidade escolhida ficar sem nenhum aluno com prova ali — e o servidor recusa
(400) desempatar turma que não está ambígua ou escolher modalidade sem reserva
na turma. Isso é o que impede a rota de virar uma coluna de modalidade no
cadastro, que a decisão de 10/08/2026 recusou.

**A senha em texto claro existe em uma coluna só** (`senha_de_prova.senha`): o
Brightspace exige o valor literal e a secretaria imprime a folha dos fiscais. Ela
não entra em log, auditoria, tabela de execução nem no CSV, e a listagem da grade
devolve apenas `temSenha`. Ver o valor é uma rota separada e auditada, porque a
grade fica aberta num monitor compartilhado.

**O questionário-alvo não tem valor padrão.** Enquanto ninguém escolher pela
tela, `GET /senhas-de-prova/alvo` devolve `nomeQuiz: null` e o lote **recusa**
começar. Um default plausível ("Prova") seria pior que a ausência: ele rodaria,
casaria com o que estivesse por perto e ninguém saberia até o dia da prova.

**Os horários também vêm da tela.** Um tick de um minuto compara o relógio de São
Paulo com o que está em `configuracao_senha_quiz`, então corrigir o horário às
07:25 já vale às 07:30, sem reiniciar nada. Turno em branco não dispara. Formato
fora de `HH:MM` é **recusado** — um `7:30` aceito calado viraria um turno que
nunca dispara.

**O cron é opt-in por instância** (`SENHA_QUIZ_CRON_HABILITADO=false` por padrão)
e **nunca simula** — a rede de proteção é outra: nada acontece se ninguém tiver
digitado a senha daquela célula. A tolerância de **30 min** faz um restart às
07:41 ainda aplicar o turno das 07:30, e a idempotência fica no banco, não em
memória: reiniciar o servidor não reexecuta o turno.

⚠️ Com o cron **ligado no servidor e nenhum horário cadastrado**, o tick avisa
(`SENHA_QUIZ_CRON_SEM_HORARIO`) em vez de calar: um cron que parece armado e não
está é pior que um cron desligado. A tela também avisa o contrário — horários
cadastrados com `SENHA_QUIZ_CRON_HABILITADO=false`.

**Exige `D2L_HABILITADO`** e, no consentimento OAuth, os escopos
`quizzing:quizzes:read quizzing:quizzes:write`. ⚠️ Acrescentá-los ao `D2L_SCOPES`
**não basta** — o escopo vive no consentimento, então é preciso reautorizar
(`npm run d2l:autorizar`), senão o primeiro PUT volta 403.

### Autorização da Valence (D2L)

| Método | Rota | O que faz |
|:---:|---|---|
| `GET` | `/d2l/callback` | Recebe o `code` do Brightspace, troca por tokens e **grava o refresh token** |

Rota **pública** por natureza: quem chega nela é o browser do admin, redirecionado
pelo Brightspace depois da tela de autorização — não há como exigir o nosso JWT
nessa navegação. O que autoriza a operação é o `code`, que só o Brightspace emite,
vale uma vez e expira em minutos.

Para usar:

1. Registre o app em **Admin Tools → Manage Extensibility → OAuth 2.0**, com
   `URI de redirecionamento` = `{TOOL_URL}/api/d2l/callback` (HTTPS obrigatório —
   em desenvolvimento, o túnel do ngrok).
2. Preencha `D2L_CLIENT_ID`, `D2L_CLIENT_SECRET` e `D2L_REDIRECT_URI` no `.env`.
   O redirect é comparado **byte a byte**; uma barra final a mais já recusa.
3. Autorize uma vez pelo browser. `npm run d2l:autorizar` monta o link a partir
   do `.env` — o mesmo arquivo que o servidor usa, então o `redirect_uri` sai
   idêntico ao configurado:

   `https://auth.brightspace.com/oauth2/auth?response_type=code&client_id=…&redirect_uri=…&scope=…&state=…`

   ⚠️ **Não acrescente `offline_access` ao `D2L_SCOPES`.** É a convenção de
   outros provedores para pedir refresh token; a D2L valida o formato do escopo
   (`group:resource:permission`) e recusa a autorização inteira com
   `invalid_scope: Invalid scope format: offline_access`. Aqui o refresh token
   vem por padrão no `authorization_code`, sem escopo que o ligue.

**Trocou de URL (ngrok → produção, ou de domínio)? Refaça os 3 passos.** O
`redirect_uri` da autorização precisa bater com o que está registrado no
Brightspace **e** com o `D2L_REDIRECT_URI` do `.env` de produção — os três são a
mesma string. O refresh token gravado não é reaproveitável entre URLs diferentes;
a nova autorização sobrescreve a linha de `integracao_d2l` (é `upsert` em `id=1`),
então não há nada para apagar antes.

O **refresh token vai para a tabela `integracao_d2l`, não para o `.env`**: cada
refresh emite um token novo e invalida o anterior, então um valor em arquivo
funcionaria exatamente uma vez. O access token só volta na resposta **fora de
produção** — ele serve para conferir os endpoints da Valence por curl, mas é
credencial.

Depois dessa autorização única, `D2lOauthService.obterAccessToken()` resolve o
resto sozinho: reaproveita o token em cache enquanto ele durar (com 1 min de
margem) e só então usa o refresh gravado, **persistindo o token rotacionado na
mesma operação**. Renovações concorrentes compartilham a mesma promessa — duas
chamadas em paralelo com o mesmo refresh token fariam a segunda receber
`invalid_grant` depois de a primeira já ter rotacionado.

Para pegar um token na mão sem repetir a autorização: `npm run d2l:token`.
**Nunca fale com o token endpoint por fora do service** — o refresh do banco
viraria lixo e a integração morreria depois, longe da causa.

O CSV sai com **BOM UTF-8** e separado por **`;`**, para abrir direto no Excel em
português sem estragar os acentos. Células que começam com `=`, `+`, `-` ou `@`
são neutralizadas: os nomes vêm de planilhas de terceiros, e uma célula
começando com `=` **executa** ao abrir o arquivo.

### Portal do aluno

Exigem o JWT emitido pelo launch LTI. Quem tem mais de um curso passa `alunoId`;
quem tem um só pode omitir.

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/portal/periodo` | O agendamento está aberto? Fechado, `motivo` traz o texto a exibir |
| `GET` | `/portal/disciplinas` | O que a prova vai cobrir (disciplinas ∩ turmas ∩ período) |
| `GET` | `/portal/faixas` | Horários que ele pode escolher — **sem sala**, com o total de vagas livres |
| `POST` | `/portal/agendamentos` | Confirma a prova; a sala vem da alocação sequencial |
| `GET` | `/portal/agendamentos` | O que esta matrícula já marcou (um por curso) |
| `GET` | `/portal/agendamentos/:id/declaracao` | **Declaração de agendamento em PDF** — só depois de o prazo encerrar |
| `PATCH` | `/portal/agendamentos/:id` | **Troca de horário** — atômica: sem vaga no novo, mantém o antigo |

A troca vale **enquanto o prazo estiver aberto**. Depois disso, só a secretaria
remaneja.

**O aluno não cancela a própria prova** (17/08/2026): a troca é a única alteração
que ele faz, e `DELETE /portal/agendamentos/:id` **não existe mais**. Cancelar
devolve a vaga e o deixa *sem* prova — num período que está lotando, a vaga sai
em segundos e quem só queria mudar de dia chega ao balcão sem horário nenhum,
quando a troca resolvia o caso dele sem risco. Desmarcar é decisão da secretaria,
em `DELETE /agendamentos/:id`, que grava no histórico o e-mail de quem cancelou.

O aluno enxerga **apenas o período vigente**: provas de semestres anteriores não
aparecem nem podem ser alteradas. Mas fechar o prazo **não esconde** a prova dele
— ele continua vendo onde e quando é. Fechar tranca a escolha, não a consulta.

#### A declaração de agendamento

`GET /portal/agendamentos/:id/declaracao` devolve uma folha A4 em PDF declarando
que o aluno está matriculado sob aquele RA e marcou a prova presencial para tal
dia e hora. É o papel que ele leva ao trabalho para justificar a ausência — e o
único documento do sistema que sai pela mão do aluno, não da secretaria.

**Ela só existe depois de o prazo ENCERRAR.** Enquanto o período está aberto o
aluno ainda troca de horário, e o documento afirmaria uma data que o próprio
portador pode mudar cinco minutos depois; quem o recebeu não teria como conferir.
Antes disso a rota responde 403 e o portal nem mostra o botão.

Quem governa o botão é o campo **`encerrado`** de `GET /portal/periodo` — e ele
**não é `!aberto`**. "Ainda não configurado" e "ainda não abriu" também respondem
`aberto: false`, e em nenhum dos dois há agendamento a declarar:

| Estado | `aberto` | `encerrado` |
|---|:---:|:---:|
| Prazo correndo | `true` | `false` |
| Sem período cadastrado | `false` | `false` |
| Cadastrado, ainda não abriu | `false` | `false` |
| Prazo vencido | `false` | `true` |
| Fechado à mão pelo admin | `false` | `true` |

O recorte é o mesmo de `GET /portal/agendamentos`: prova sua, confirmada, do
semestre vigente — cancelada não emite. É **uma declaração por prova**, não por
pessoa: quem tem dois cursos faz duas provas, em dias diferentes, e cada uma
justifica uma ausência diferente.

O layout segue o **modelo oficial da declaração**, desenhado pela instituição: a
arte cobre a folha inteira (banda azul na lateral esquerda, a marca Católica EAD
no alto à esquerda, o selo Great Place to Work à direita, curvas no rodapé e o
endereço da unidade no pé) e traz impressos o **título** e o **bloco de
assinatura** ("Universidade Católica de Brasília" + "Documento emitido
automaticamente pelo Sistema de Agendamento"). O sistema escreve **uma única
coisa** na página: o parágrafo da declaração, na área branca entre os dois,
alinhado à mesma margem do título, com **o nome do aluno, o RA e a data/hora da
prova em negrito** — os três campos que quem recebe o papel procura. O texto
declarado é o de sempre — a troca foi só de layout. Ficam de fora o QR code e as duas linhas de validação do documento
antigo: apontavam para o serviço do fornecedor anterior, que não existe deste
lado. A arte fica em `src/agendamento/assets/modelo-declaracao.png`.

Toda alteração registra **quem a fez**, e o administrador consulta em
`GET /agendamentos/:id/historico`. É a resposta para "mudaram minha prova e não
fui eu".

O aluno não escolhe polo, modalidade nem sala. Polo e modalidade vêm do CSV; a
sala é resultado da alocação no instante da confirmação.

**De onde vêm as disciplinas de `/portal/disciplinas`.** A fonte é decidida em um
arquivo só (`agendamento/service/disciplinas-do-aluno.service.ts`):

| `D2L_HABILITADO` | Turmas consideradas |
|---|---|
| `false` | Só a turma de onde o aluno clicou (claim `context` do LTI) |
| `true` (default) | Todas as ofertas dele no período letivo cadastrado, lidas por `enrollments/users/{id}/orgUnits/` e cruzadas com os descendentes do Período Letivo |

O semestre é **o que o admin cadastrou** em `PeriodoAgendamento.periodoLetivoId`
(org unit tipo `103` neste tenant), não "o atual" segundo o relógio. Sem esse
recorte viriam também as disciplinas de semestres passados. A `rodada` **não**
entra aqui: a substitutiva é outra prova das mesmas matérias.

⚠️ **A lista não é separada por vínculo.** Turma não pertence a um curso, então
quem tem dois vínculos na mesma matrícula recebe as disciplinas dos dois juntas.
São 2 alunos em 7519 — ver "Turma não pertence a um curso".

### Integração — dados para outros sistemas

Autenticadas por **API key** no header `X-API-Key` (`INTEGRACAO_API_KEYS`), e não
por JWT. É o terceiro perfil do sistema: quem chama é um **servidor de outro
sistema**, sem ninguém logado. A chave só abre estas rotas — não vale como admin
nem como aluno, e nenhum JWT vale aqui.

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/integracao/alunos/:matricula/agendamentos` | Tudo o que a declaração e a tela "Prova agendada" mostram, por RA. `?periodo=atual` restringe à janela vigente |

Existe porque a **declaração de agendamento vai passar a ser emitida por outro
sistema da instituição**, assinada digitalmente — este deixa de ser a fonte do
documento e passa a ser a fonte dos dados. O PDF do portal continua de pé até lá.

A resposta traz o aluno (`nome`), os **vínculos** (curso, situação, formato e
polo da matrícula) e cada **prova confirmada** — rodada (`N2`/`SUB` e o nome por
extenso), período letivo, a janela de agendamento com `prazoEncerrado`, data
(`AAAA-MM-DD`), horário, formato, polo e sala da prova, disciplinas, quando foi
agendada e se a secretaria alocou.

- **Histórico completo**, só `CONFIRMADO`, da mais recente para a mais antiga.
  Cancelada não aparece: não reserva cadeira, e declará-la afirmaria uma prova
  que não existe.
- **`?periodo=atual`** = a janela vigente (N2 **ou** SUB, a cadastrada por
  último), o mesmo recorte do portal. Qualquer outro valor responde 400.
- **Emita a declaração só com `periodo.prazoEncerrado: true`.** Com o prazo
  aberto o aluno ainda troca de horário. Janela que não é a vigente vem sempre
  `true`.
- **404** = RA não importado; **200 com `agendamentos: []`** = existe e não tem
  prova no recorte.
- **Fica de fora:** e-mail e notas — a declaração não usa nenhum dos dois.
- **Toda consulta vai para a auditoria** (`INTEGRACAO_CONSULTA`), com o nome do
  sistema e a matrícula consultada. A chave nunca.

---

## Documentação da API (Swagger)

| Endereço | O que é |
|---|---|
| `/api/docs` | Swagger UI — navegável e executável |
| `/api/docs-json` | Spec OpenAPI 3, para gerar client ou importar no Postman/Insomnia |

Ligada por padrão fora de produção. Em produção fica desligada (a doc revela toda
a superfície da API); para publicar num ambiente interno, use `SWAGGER_ENABLED=true`.

**Como testar pela UI:** chame `POST /auth/login`, copie o `accessToken`, clique
em **Authorize** → `admin-jwt`. O token persiste entre reloads. Se a resposta
trouxer `mustChangePassword: true`, só `/auth/trocar-senha` e `/auth/me` respondem
até a troca. O launch LTI não é simulável pela UI — exige um `id_token` assinado
pelo Brightspace — mas o contrato de resposta está documentado para o front.

**A doc é obrigatória, não opcional.** Toda rota nova nasce com `@ApiOperation`,
resposta de sucesso tipada e um `@Api*Response` por erro que o handler realmente
lança; todo campo de DTO de entrada leva `@ApiProperty` com exemplo. Duas coisas
tornam isso barato:

- `@SomenteAdmin()` e `@SomenteAluno()` já aplicam o esquema de segurança e as
  respostas 401/403 — não repita `@ApiBearerAuth`.
- O plugin do `@nestjs/swagger` (ligado em `nest-cli.json`) lê os decorators do
  `class-validator` e o JSDoc dos campos, preenchendo o que faltar.

Os DTOs de resposta vivem em `<módulo>/dto/*.response.dto.ts` e declaram
`implements` da interface do service. Se a interface mudar, o build quebra ali —
a documentação não fica mentindo em silêncio.

**E a regra é cobrada automaticamente.** `test/openapi.e2e-spec.ts` varre o
documento OpenAPI real e falha quando uma rota entra sem `summary`, sem tag
registrada, sem resposta de sucesso tipada, sem corpo documentado, ou com campo
de schema sem `description`/`example`/`enum`/`format`. A mensagem de erro lista
todas as pendências de uma vez, não só a primeira. Casos legítimos entram como
exceção nomeada no próprio teste, com o motivo escrito.

---

## Segurança

| Controle | Como está |
|---|---|
| **Deny by default** | Guard global: rota sem `@SomenteAdmin()`/`@SomenteAluno()`/`@SomenteIntegracao()`/`@Publico()` é **negada** |
| **Integração** | API key por sistema (`X-API-Key`), comparada por hash em tempo constante; vazia = tudo recusado; lista opcional de IPs; cada consulta auditada |
| **Rate limiting** | 5/min em login, refresh, troca de senha e callback OAuth do D2L · 60/min no launch LTI · 10/5min em uploads · 120/min no resto |
| **Cabeçalhos** | `helmet` com CSP `default-src 'none'` na API (relaxada só na página do Swagger) |
| **Auditoria** | Log JSON por evento: login, falhas, troca de senha, ações administrativas, 401/403/429 |
| **Senhas** | bcrypt 12 rounds; comparação em tempo constante; mensagem uniforme no login |
| **Entrada** | `class-validator` + `whitelist` + `forbidNonWhitelisted` |
| **Injeção SQL** | Prisma parametrizado |
| **Erro 500** | Mensagem genérica + `erroId`; stack só no log |
| **CSRF** | Não se aplica — `Authorization: Bearer`, sem cookie |
| **CORS** | ⚠️ Não configurado. Desabilitado = seguro, mas o front não funciona até definirmos a origem |

Os controles são verificados por `test/seguranca.e2e-spec.ts` — comportamento
observado por request, não configuração declarada. O teste inclui um controller
sem decorator de acesso, criado só ali, para provar que o deny-by-default pega o
esquecimento humano.

**Front-end:** parte da segurança depende do cliente (onde guardar o token, XSS
ao renderizar dados do CSV, tratar 429 e `mustChangePassword`). Está tudo em
**[`docs/SEGURANCA-FRONTEND.md`](docs/SEGURANCA-FRONTEND.md)** — entregue esse
arquivo a quem for construir o portal.

---

## Modelo de dados

Fonte de verdade: [`prisma/schema.prisma`](prisma/schema.prisma), fortemente
comentado. DTOs, services e controllers derivam dele.

```
Polo ──┬── Sala ─────┐
       │             ├── SalaFaixa ── Agendamento ──┬── AgendamentoDisciplina
       └── Faixa ─────┘   (+ Modalidade)            └── SyncD2L
                                                     │
AlunoImportado (matrícula + curso) ──────────────────┘
   └── Modalidade, Polo, ImportacaoCsv

TurmaImportada ── ImportacaoCsv      Admin

PeriodoAgendamento ── PeriodoLetivoModalidade ── Modalidade
   (a janela: prazo, rodada,   (qual periodo letivo do
    criterios de nota)          Brightspace vale para cada uma)
```

**Tabelas e o que cada uma guarda**

| Modelo | Papel |
|---|---|
| `Admin` | Login administrativo (bcrypt, `mustChangePassword`, campos de reset) |
| `Modalidade` | `codigo` (EAD/SEMI/MODULAR/PRESENCIAL) + `duracaoMinutos` |
| `Polo` | Unidades do seed, `nome` **único** = chave de casamento com o CSV |
| `Sala` | Polo + nome + capacidade. Neutra |
| `Faixa` | Polo + data + horaInício + horaFim. Neutra |
| `SalaFaixa` | Sala + Faixa + Modalidade + `vagas` + `ordem`. **O núcleo** |
| `AlunoImportado` | Um registro **por vínculo** (matrícula + curso) |
| `TurmaImportada` | Turmas reais com prova, chaveadas por `codigoTurma + nomeDisciplina` |
| `ImportacaoCsv` | Auditoria: tipo, arquivo, linhas, quem, quando |
| `Agendamento` | A reserva, apontando para a `SalaFaixa` alocada. Guarda `rodada`, `modalidadeId` e `poloId` **do aluno na época** — ver abaixo |
| `AgendamentoDisciplina` | As N disciplinas cobertas pela reserva |
| `SyncD2L` | Fila de *special access* por agendamento — **sem uso** (o acesso é gravado pelo lote de `ExecucaoSpecialAccess`) |
| `AlunoNiop` | Matrículas do NIOP: tempo extra no special access. Fora do CSV, sobrevive à reimportação |
| `ConfiguracaoSpecialAccess` | Linha única: extra do NIOP e se o special access substitui as janelas |
| `ExecucaoSpecialAccess` / `ItemSpecialAccess` | O lote que grava o special access de cada aluno, e o que aconteceu com cada um |
| `HistoricoAgendamento` | Quem alterou o agendamento: evento, autor (aluno/admin), de → para |
| `PeriodoAgendamento` | Janela de agendamento; fecha por `dataFechamento`. Identidade = `periodoLetivoId` (o **principal**) + `rodada` |
| `PeriodoLetivoModalidade` | O mapa `modalidade → periodoLetivoId` de uma janela. Existe porque módulos e semestres correm em paralelo — ver *duas grades no mesmo ano* |
| `SenhaDeProva` | Uma célula da grade `(data, turno)` → senha da prova. **Única coluna do banco com a senha em texto claro** |
| `ConfiguracaoSenhaQuiz` | Linha única (`id=1`): o que o admin configura — questionário-alvo e os horários do cron |
| `ExecucaoSenhaQuiz` | Uma rodada do lote de troca de senhas. Guarda contadores e a `versaoAplicada`; **nunca a senha** |
| `ItemSenhaQuiz` | Uma linha por (turma, questionário) da execução, com o `resultado`. **Nunca a senha** |
| `JanelaDeProva` | Um disparo: a que horas o questionário abre/fecha, por modalidade, e o grupo que libera a prova |
| `ModalidadeEscolhidaDaTurma` | O desempate da turma **ambígua**: `(orgUnitId, rodada) → modalidade`, com quem decidiu. **Só é lida quando a turma continua ambígua** |

**Índices que importam para a regra**

- `SalaFaixa @@unique([salaId, faixaId])` — uma sala entra uma única vez por
  faixa, logo numa única modalidade. ⚠️ É por **faixa**, não por **horário**: não
  impede a mesma sala em duas faixas que se cruzam no relógio. Isso é regra de
  aplicação (`exigirSalaLivreNoHorario`), não de banco.
- `SalaFaixa @@unique([faixaId, modalidadeId, ordem])` — a ordem de preenchimento
  é única e não ambígua.
- `AlunoImportado @@unique([matricula, curso])` — chave de idempotência da
  importação. **`matricula` sozinha não é única**, porque um RA pode ter vários
  vínculos.
- `Agendamento @@index([salaFaixaId])` — usado na contagem de ocupação dentro da
  transação de alocação.
- `SenhaDeProva @@unique([data, turno])` — a célula da grade é a chave natural, e
  é o que faz o `PUT` ser upsert e o cron não duplicar execução no mesmo turno.
- `ExecucaoSenhaQuiz @@index([data, turno, simulacao, status])` — a consulta de
  idempotência que o cron faz a cada tick.
- `ExecucaoSenhaQuiz.senhaDeProvaId` é **`onDelete: SetNull`**, e `data`/`turno`
  ficam desnormalizados na própria execução: apagar a senha (retenção) não pode
  apagar a prova de que o lote rodou.
- `ModalidadeEscolhidaDaTurma @@unique([orgUnitId, rodada])` — uma decisão por
  turma em cada prova. O período letivo não entra na chave porque o `orgUnitId`
  já o carrega; a `rodada` entra porque a N2 e a SUB do mesmo semestre
  **compartilham** o org unit, e o desempate de uma não decide a outra.

**`Agendamento.modalidadeId` e `Agendamento.poloId` são fotografia**, não consulta
ao vínculo. `AlunoImportado` é tabela de **estado atual**: cada importação
sobrescreve modalidade e polo, e não há versão anterior. Sem essas colunas,
exportar um semestre passado mostrava a modalidade de **hoje** ao lado da data e
da sala corretas — duas colunas da mesma linha discordando sobre o mesmo fato.

São redundantes com `salaFaixa` **por construção** (a alocação só aceita oferta da
modalidade do aluno, e o portal recusa faixa de outro polo), e é essa redundância
que tornou o *backfill* da migration exato em vez de aproximado: os dois valores
já estavam gravados na reserva, só que indiretamente.

---

## Importação dos CSVs

Os polos vêm de **seed**, não de CSV. As salas são **cadastro manual** pelo admin
(nome + capacidade + polo por dropdown). Só dois arquivos são importados:

> **A importação nunca cria polo.** Ela procura o valor de `CAMPUS` entre os polos
> cadastrados; não achando, **a linha do aluno é rejeitada** (o vínculo não entra
> no banco) e o campus aparece em `polosNaoEncontrados[]` na resposta do upload.
> Para o aluno entrar, cadastre o polo antes — `POST /polos`, com o nome idêntico
> ao do arquivo.

#### Campus que sai da oferta

Um campus que deixa de ter prova **se desativa, não se apaga**:

| Ação | Efeito |
|---|---|
| `PATCH /polos/:id` `{ ativo: false }` | O polo para de aceitar **sala e faixa novas** (409). Nada do que já existe é afetado: salas, faixas e provas marcadas continuam valendo, e o aluno segue vendo a prova dele |
| `POST /polos` com o **mesmo nome** | **Reativa** o polo, com o mesmo id — salas, faixas passadas e alunos voltam junto. Só conflita (409) se já houver polo **ativo** com aquele nome |
| `DELETE /polos/:id` | Só apaga polo **virgem** (sem sala, sem faixa, sem aluno). Serve para desfazer cadastro errado, já que `nome` não é editável. Com histórico: 409 |

Sem faixa nova, ninguém agenda naquele polo, e o agendamento compulsório reporta
esses alunos como `SEM_FAIXA_NO_POLO` — a lista que a secretaria precisa ver.
O portal do aluno **não** consulta `Polo.ativo` de propósito: desativar um campus
no meio do semestre não pode esconder a prova de quem já agendou.

### CSV de alunos

Cabeçalhos reais, confirmados nos arquivos entregues:

| Coluna do arquivo | Vira | Observação |
|---|---|---|
| `RA` | `matricula` | Alfanumérico (`0009552430`, `A06103080`, `UC25426847`) — **String**, zeros à esquerda fazem parte do identificador |
| `ALUNO` | `nome` | |
| `EMAIL INSTITUCIONAL` | `email` | Alguns vazios |
| `CURSO` | `curso` | Exibição **e parte da chave do vínculo** |
| `STATUS CURSO` | `statusCurso` + `ativo` | Ver abaixo |
| `CAMPUS` | `polo` | Casa com `Polo.nome` por string exata |
| `CENTRO DE CUSTO` | — | Ignorado de propósito |

A **modalidade não é coluna**: vem do dropdown do upload, correspondendo à aba de
origem da planilha (`EaD`→`EAD`, `Semi`→`SEMI`, **`Híbrido`→`MODULAR`** — Híbrido
e Modular são a mesma coisa).

**Encoding:** os arquivos reais são ISO-8859-1. O parser detecta e decodifica
automaticamente (tenta UTF-8, cai para latin1 se houver caractere inválido), então
não é preciso converter nada à mão.

**Elegibilidade por `STATUS CURSO`** — definida numa lista explícita em
[`src/enums/status-curso.enum.ts`](src/enums/status-curso.enum.ts), único ponto a
alterar. Não é configurável por `.env`.

- **Permite agendar:** `Ativo` — e só ele (regra vigente desde 11/08/2026).
- **Bloqueiam:** `Desistente`, `Trancado`, `Cancelado`, `Formado`,
  `Transf. Interna`, `Transf. de Curriculo`, `Alter. de Habilitação`.
  As três últimas são situações de *transição*; estiveram na lista de permitidos
  entre 31/07 e 11/08/2026 e voltaram a barrar. Continuam **listadas** (e não
  tratadas como desconhecidas) porque são grafias reais dos arquivos.
- **Status desconhecido bloqueia por segurança** e é reportado no resultado da
  importação, para que alguém decida conscientemente em qual lista ele entra.

A comparação ignora acentos, caixa e espaços repetidos — um acento perdido numa
reexportação não pode mudar a situação de um aluno.

> ⚠️ **Mudar a lista não reclassifica quem já está no banco.** O campo `ativo` é
> derivado na importação e gravado, e é ele que o agendamento consulta. Como
> `statusCurso` fica gravado cru, dá para reclassificar sem reimportar:
> `npm run alunos:recalcular` (simulação) e `-- --gravar` para aplicar. O script
> também lista quem **perde a elegibilidade com prova já marcada** — sem cancelar
> nada, porque cancelar em massa é decisão de negócio.

O status **não bloqueia o login**: um aluno com matrícula cancelada é reconhecido
no launch e vê uma mensagem clara, em vez de um "não encontrado". O bloqueio
acontece no agendamento.

**Resposta do upload** — além de criados/atualizados, devolve o que precisa de
atenção humana: linhas rejeitadas com motivo, status desconhecidos com contagem,
valores de `CAMPUS` que não casaram com nenhum polo do seed, e
`alteracoesComAgendamento[]` (abaixo).

**A importação nunca apaga**: quem não está no arquivo não é tocado. Para incluir
uma pessoa, basta um CSV com a linha dela — o `upsert` é por `[matricula, curso]`.

> ⚠️ **`alteracoesComAgendamento[]` — mudança em quem já tem prova marcada.**
> São os três campos que a importação muda *por baixo* de uma reserva
> confirmada, sem que nada mais no sistema reclame:
>
> - **modalidade** (vem do dropdown e sobrescreve todas as linhas do arquivo) e
>   **polo** (segue a coluna `CAMPUS`): a reserva continua na sala antiga — prova
>   de outra duração, ou em outro campus. O sintoma aparece depois e disfarçado:
>   o remanejo passa a ser recusado com *"esta sala não é da modalidade do
>   aluno"*.
> - **`statusCurso`**: o aluno saiu de "Ativo" (ex.: `Transf. Interna`) e
>   **perdeu o direito de agendar** — não troca mais de horário, sai do
>   compulsório —, mas **a vaga continua reservada** e ele aparece na lista de
>   presença do dia. O vínculo **não é apagado** e a prova **não é cancelada**.
>   Só a *perda* de elegibilidade aparece aqui: recuperá-la, ou trocar entre dois
>   status que já bloqueavam, não gera aviso.
>
> O upload **não é bloqueado** (a planilha pode estar corrigindo um cadastro
> errado), mas cada linha dessas pede decisão: remanejar, cancelar, ou manter a
> vaga de quem perdeu a elegibilidade. A contagem considera só o **semestre
> vigente** — prova de semestre passado já aconteceu, e avisar sobre ela seria o
> ruído que faz o aviso ser ignorado.

> ⚠️ **`cursosRenomeados[]` — a grafia do curso mudou e o vínculo se duplicou.**
> A chave é `[matricula, curso]`, então `PSICOLOGIA` virando
> `Psicologia — Bacharelado` não é atualização: o `upsert` não encontra a linha
> antiga e cria **outra**. A prova já marcada continua presa à primeira, e daí em
> diante o aluno aparece duas vezes no atendimento, sai como **"Não Agendado" na
> exportação mesmo tendo agendado**, e o compulsório o aloca de novo — uma
> segunda vaga para a mesma pessoa.
>
> A comparação (`curso-renomeado.ts`) tem duas regras fechadas, ambas exatas
> depois de normalizar: `identico-normalizado` (só acento, caixa ou pontuação) e
> `tokens-contidos` (um nome é o outro com palavras a mais, comparado **por
> token** e sem exigir ordem). Não há distância de edição — "ENGENHARIA CIVIL" e
> "ENGENHARIA QUÍMICA" ficam a duas letras uma da outra e são cursos diferentes.
>
> Só é candidata a grafia que **sumiu da planilha**: se as duas aparecem no mesmo
> upload, a fonte de verdade está dizendo que são dois vínculos.
>
> **Avisa e não mescla** — fundir dois cursos distintos misturaria as provas dos
> dois numa pessoa só, e é irreversível. Resolve-se em `POST /alunos/:id/mesclar`.

### CSV de turmas

Formato real (`Tabela_Disciplinas_Turmas`), separado por **`;`**:

```
Código da Turma;Disciplina / Código EAD
GSPS0N10257;PRÁTICA PROFISSIONAL E ÉTICA EM NUTRIÇÃO (1-GSPS06EAD003)
```

`,` ou `;` e UTF-8/latin1 são detectados, não presumidos. `Código da Turma` é a
única coluna exigida no cabeçalho.

**Este arquivo é quem diz quais turmas têm prova.** Nada fora dele é agendável
(`TURMAS_FILTER_ENABLED`, default `true`).

#### A 3ª coluna traz duas informações

Nome e código da **disciplina**, na mesma célula, separados na importação. E esse
código não é decoração: o `Code` da oferta no Brightspace é **composto** e
carrega os dois códigos que a planilha tem —

```
GSPS02_GSPS02EAD003_GSPS0I10227_2026/1
       └─ disciplina  └─ turma
```

— e o código da turma **se repete**: HISTÓRIA, DANÇA e LUTAS rodam todas sob
`GSPS0I10227`. O que as separa é o código da disciplina. Por isso o par
identifica a oferta **sem depender do nome**.

A leitura é conservadora (portada de `../brightspace-orgunits`):

| Célula | Resultado |
|---|---|
| `SAÚDE COLETIVA (1-GSPS01EAD048)` | nome `SAÚDE COLETIVA`, código `GSPS01EAD048` — o prefixo `1-` é do sistema de origem e **não** aparece no Brightspace |
| `EDUCAÇÃO FÍSICA (TURMA A)` · `(2026)` · `(EAD)` | nome **intacto** — o miolo não parece código (precisa de letra e número, sem espaço) |
| `QUÍMICA (GSPS01EAD048) NOTURNO` | nome **intacto** — o parêntese não está no fim |
| `NUTRIÇÃO CLÍNICA (GSPS0I10259)` com esse mesmo código de turma | código descartado — igual ao da turma, não separa nada |

#### Como o cruzamento decide

| # | Estratégia | Quando decide |
|--:|---|---|
| 0 | `codigo-composto` | o `Code` contém o código da turma **e** o da disciplina |
| 1 | `codigo` | uma turma só com aquele código |
| 2 | `codigo-e-nome` | desempate por nome dentro do mesmo código |
| 3 | `nome-exato` | sem código, ou código sem match |
| 4 | `nome-parcial` | um nome contém o outro; só a partir de 6 caracteres |

⚠️ **O `Code` chega composto pelos enrollments** (`OrgUnit.Code`) e simples pelo
launch. Comparar por igualdade quebraria o primeiro caso sem erro nenhum — a
consulta voltaria vazia e toda disciplina viraria "não tem prova". Por isso a
busca usa o código **inteiro E cada token** dele: o inteiro casa com códigos que
tenham hífen (`ADM-0142`), os tokens casam com o composto.

Quando não é conclusivo — nome divergente (`DIVERGENTE`) ou empate (`AMBIGUA`) —
**aquela turma não é liberada** e o motivo vai para o log; chutar significaria
marcar prova para a disciplina errada. Uma turma inconclusiva não derruba as
outras.

O `orgUnitId` é aprendido dos acessos: cada aluno que entra entrega o id das suas
turmas, gravado (nunca sobrescrito) e usado como mais um caminho de busca.

#### Turma não pertence a um curso

Uma turma tem alunos de **vários** cursos — compartilhada, eletiva, equivalência.
Por isso não há coluna de curso: rotulá-la com um seria falso, e o filtro que
existia chegava a descartar disciplina válida. Uma coluna `Curso` no arquivo é
lida e ignorada.

**Consequência aceita:** quem tem dois vínculos **na mesma matrícula** recebe, com
`D2L_HABILITADO=true`, as disciplinas dos dois cursos juntas — e as durações de
prova diferem. São **2 alunos em 7519** na base real. Com a flag desligada não
acontece: a disciplina é a que ele clicou.

A informação que resolveria isso é do par *(aluno, turma)*, que nenhum dos dois
CSVs tem. E duas matrículas não bastam para escapar: os enrollments são buscados
por `userIdD2L`, então uma pessoa com duas matrículas e uma conta só no
Brightspace continua recebendo tudo junto.

### Idempotência

Ambos os uploads fazem upsert (por `matricula + curso` e por
`codigoTurma + nomeDisciplina`). Re-subir o mesmo arquivo atualiza, nunca
duplica. Toda importação registra auditoria em `ImportacaoCsv`.

---

## Autenticação em detalhe

### Admin — JWT

Login e-mail/senha (bcrypt, 12 rounds) → **access token** (`JWT_SECRET`, 15min) +
**refresh token** (`JWT_REFRESH_SECRET`, 7d, com `tipo: 'refresh'` no payload,
verificado para impedir que um access token seja usado como refresh).

O **primeiro admin** vem de seed idempotente: se o e-mail já existir, nada é
sobrescrito — nem a senha, nem o `mustChangePassword`. Re-rodar o seed num
ambiente em uso nunca reseta a senha de quem já trocou.

Admin criado por seed ou por reset nasce com `mustChangePassword = true`, e o
guard bloqueia todas as rotas até a troca. As exceções, marcadas com
`@PermitidoComSenhaProvisoria()`, são `/auth/trocar-senha` e `/auth/me` — sem elas
o admin do seed ficaria travado para sempre.

**Um único nível de acesso:** JWT de admin válido = acesso total. Não há matriz de
permissões, só a separação entre os perfis `ADMIN` e `ALUNO`, aplicada pelos
decorators `@SomenteAdmin()` e `@SomenteAluno()`.

### Aluno — LTI 1.3

O launch é validado **antes** de qualquer dado ser lido:

1. `iniciarLogin` gera `state` + `nonce` e redireciona para o Brightspace.
2. No `launch`, o `state` é consumido (uso único, com expiração) e o `id_token`
   é verificado contra o JWKS remoto — assinatura, `issuer`, `audience`, com 30s
   de tolerância de relógio.
3. O `nonce` do token precisa bater com o emitido.
4. Valida versão `1.3.0`, `message_type = LtiResourceLinkRequest` e, se
   configurado, o `deployment_id`.
5. Só então extrai matrícula e UserId do Valence e cruza com o CSV.

O nome dos claims customizados depende do registro da ferramenta, então
`LTI_CLAIM_MATRICULA` e `LTI_CLAIM_USER_ID` aceitam uma lista separada por
vírgula, tentada em ordem. Para descobrir os nomes reais no ambiente da UCB, use
`LTI_DEBUG_CLAIMS=true` — loga os claims recebidos e é ignorado em produção.

O JWT interno do aluno é curto (2h) e serve só para navegação. Ele carrega os
vínculos **dentro do payload**, justamente para que o agendamento possa verificar
que o `alunoId` escolhido pelo portal pertence mesmo àquela matrícula, sem
confiar em nada vindo do cliente.

Matrícula fora do CSV resulta em `403` com mensagem orientando procurar a
secretaria — não é "senha errada", é ausência de cadastro: sem a linha do CSV não
há como saber modalidade nem polo.

---

## Estrutura do código

Modular por domínio; cada módulo segue `controller/ · dto/ · service/ · module/`.

```
src/
  admin/          gestão de administradores
  agendamento/
    controller/   portal do aluno (período, disciplinas, faixas, agendar)
    service/      agendamento.service.ts (a transação que impede overbooking)
                  agendamento-admin.service.ts (consulta, resumo, exportação)
                  alocacao.ts (regra sequencial, função pura)
                  lock-de-vagas.ts (o FOR UPDATE, compartilhado pelos 3 caminhos)
                  csv-relatorio.ts (montador de CSV parametrizavel — default no
                  formato do Excel —, com defesa de injeção)
                  disciplinas-do-aluno.service.ts (escolhe a fonte das
                  disciplinas e separa por vínculo)
  aluno/          cruzamento matrícula → vínculos
  auth/
    controller/   login, refresh, trocar-senha, me
    jwt/          strategies + guards (admin e aluno)
    lti/          config, state store, keys, controller, service
    roles.decorator.ts
  components/     horario.util.ts (HH:MM → minutos)
  config/         validação do .env no boot + setup do Swagger
  d2l/            OAuth da Valence (d2l-oauth) + canal HTTP compartilhado
                  (d2l-http) + leitura de matrículas (d2l-enrollments) +
                  cliente de questionários (d2l-quizzes)
  database/       PrismaService + driver adapter MariaDB
  dto/            respostas de rotas fora de módulo (health)
  enums/          perfil, status-curso (regra de elegibilidade)
  faixa/          horários + montagem da oferta (SalaFaixa)
  importacao/     parsing dos 2 CSVs + auditoria
  modalidade/     leitura das modalidades e suas durações
  periodo/        janela de agendamento (CRUD do admin + leitura do portal)
  polo/  sala/  sala-faixa/    estrutura física e ajuste da oferta
  relatorio/
    service/      relatorio.service.ts (os grupos horário × turma e o zip)
                  csv-grupos-d2l.ts (o formato que o Groups Import aceita)
                  nome-de-arquivo.ts (nome do arquivo e pasta dentro do zip)
  seguranca/      auditoria + filtro global de exceções
  senha-quiz/
    service/      grade-senhas.service.ts (a grade dia × turno)
                  senha-quiz.service.ts (o lote que grava no Brightspace)
                  senha-quiz.cron.ts (o tick de um minuto)
                  resolucao-orgunit.service.ts (CSV ∩ ofertas do semestre)
                  quiz-body.ts · senha.ts · turno.ts · relogio.ts (puras)
  turma/          cruzamento disciplinas ∩ turmas ∩ período
  generated/      client do Prisma (NÃO versionado)
  app.module.ts   main.ts

prisma/
  schema.prisma   fonte de verdade da modelagem
  migrations/
  seed.ts         orquestrador → modalidades, polos, admin

docker/mysql/init/  grant do shadow database (só dev)
scripts/            gerar-chave-lti.ts · token-aluno.ts · d2l-token.ts (só dev)
test/               e2e + fixtures
```

**Convenções**

- **DTOs com `class-validator`** para toda entrada. Nunca aceitar body cru.
- **Tudo documentado no Swagger** — rota sem `@ApiOperation` é código incompleto.
- **Prisma como única camada de dados.** Injete `PrismaService`; nunca instancie
  `PrismaClient` fora de `src/database/`. Sem SQL cru, exceto onde a transação de
  alocação exigir lock explícito.
- **Nomes em português** no domínio (matrícula, faixa, polo), para casar com o
  vocabulário institucional.
- **Segredos só via `.env`.**
- **Erros de negócio** com exceções tipadas do Nest (`ConflictException` para vaga
  esgotada, `ForbiddenException` para período fechado).

---

## Notas de infraestrutura (Prisma 7)

O projeto usa **Prisma 7**, que difere do que se vê na maioria dos tutoriais em
três pontos:

- O generator é **`prisma-client`** (não `prisma-client-js`), com `output`
  obrigatório → o client é gerado em `src/generated/prisma` e **não é
  versionado**. Depois de clonar ou alterar o schema, rode `npm run prisma:generate`.
- **`url` não existe mais no bloco `datasource`.** A `DATABASE_URL` é lida pelo
  CLI via [`prisma.config.ts`](prisma.config.ts) e pelo runtime via **driver
  adapter** (`@prisma/adapter-mariadb`), montado em
  [`src/database/mariadb-adapter.ts`](src/database/mariadb-adapter.ts) — que
  traduz a URL para os campos separados que o adapter espera, mantendo uma fonte
  única de configuração.
- **`prisma.config.ts` substitui o bloco `prisma` do `package.json`** (schema,
  caminho das migrations e comando de seed).

Dois detalhes que já custaram tempo:

- `importFileExtension = "js"` no generator é **obrigatório**. Sem ele o Prisma
  infere a extensão a partir do tsconfig presente no momento do generate e emite
  imports `.ts` quando roda sem tsconfig (o build do Docker), quebrando o
  `require()` no `dist`. Fixar torna o generate determinístico.
- `docker/mysql/init/` concede ao usuário da aplicação privilégios sobre o
  *shadow database* do `prisma migrate dev` (bancos com prefixo
  `prisma_migrate_shadow_db`). Vale só para desenvolvimento — em produção usa-se
  `migrate deploy`, que não cria shadow database.

### O nome da pasta da migration é a ordem de execução

Num banco **vazio**, o Prisma aplica as migrations em ordem **alfabética do nome
da pasta** — não na ordem em que foram criadas. O banco de quem já as aplicou não
percebe diferença, porque o `_prisma_migrations` guarda a ordem real. Um banco
novo, sim.

Isso já aconteceu aqui: o `init` tinha timestamp **posterior** ao
`aluno_por_vinculo`, então num banco limpo o `ALTER TABLE aluno_importado` rodava
antes de a tabela existir. Em desenvolvimento nunca falhou; teria falhado no
primeiro `migrate deploy` em produção.

**Renomear uma migration já aplicada exige três passos, juntos:**

1. renomear a pasta;
2. atualizar o `migration_name` em `_prisma_migrations` de **todo** banco que já
   a tinha aplicado;
3. **reconstruir toda imagem Docker**, que carrega os nomes antigos gravados.

Pular o passo 3 produz o `P3009` abaixo — foi exatamente o que aconteceu.

A prova de que o histórico está sadio é o próprio `prisma migrate dev`: ele
reconstrói o *shadow database* aplicando tudo do zero. Se passar, replica.

### Erro `P3009` — "failed migrations in the target database"

O `migrate deploy` encontrou uma migration marcada como **falha** e se recusa a
seguir. Causa comum aqui: um container com imagem antiga tentou aplicar uma
migration que já existia no banco sob outro nome.

```bash
# 1. Pare o container — ele fica em loop tentando a mesma coisa
docker compose stop app

# 2. Veja o estrago real. applied_steps_count = 0 significa que NADA rodou
docker exec agendamento-mysql mysql -uagendamento -p -e \
  "SELECT migration_name, finished_at, rolled_back_at, applied_steps_count \
   FROM _prisma_migrations ORDER BY started_at;" agendamento

# 3. Com applied_steps_count = 0, marque como revertida
npx prisma migrate resolve --rolled-back <nome_da_migration>

# 4. Confirme e reconstrua a imagem
npx prisma migrate status
docker compose up -d --build app
```

**Só use `--rolled-back` depois de confirmar `applied_steps_count = 0`.** Se
alguma instrução tiver rodado, o banco está num meio-termo e marcar como revertida
esconde isso — aí o caminho é desfazer à mão o que foi aplicado, antes de resolver.

---

## Deploy em produção

O compose de produção está na pasta **acima** desta (`../docker-compose.prod.yml`):
três containers numa máquina só — `mysql`, `api` e `web`. O `web` (nginx) serve o
portal e repassa `/api` para a API, então **tudo é same-origin** e CORS não entra
na história. TLS fica na borda: o proxy institucional da UCB, ou o Caddy de
`../docker-compose.tls.yml`.

```bash
cp ../.env.prod.example ../.env && chmod 600 ../.env   # credenciais do MySQL, porta, domínio
cp .env.example .env && chmod 600 .env                 # segredos da aplicação
docker compose -f ../docker-compose.prod.yml up -d --build
```

⚠️ **São dois arquivos `.env` com papéis diferentes** — o de cima é do compose, o
daqui é da aplicação. A `DATABASE_URL` não entra em nenhum dos dois: o compose a
monta, porque o host do banco depende da topologia.

⚠️ **Uma réplica da API, sempre.** O `state` do LTI e o `code` de uso único ficam
em memória (`LtiStateStore` / `LtiCodeStore`), e o refresh do D2L é serializado
por uma promessa de processo. Com duas réplicas o launch que chega na instância B
não acha o state criado na A, e o login de aluno quebra de forma intermitente.
Escala é vertical.

### O que muda do desenvolvimento para o servidor real

Sair do ngrok exige mexer em **duas configurações no Brightspace**, não só no
`.env`. As duas comparam URL byte a byte.

| Variável | Dev | Produção | Também precisa mudar em |
|---|---|---|---|
| `D2L_REDIRECT_URI` | `https://….ngrok-free.dev/api/d2l/callback` | `https://SEU-DOMINIO/api/d2l/callback` | **Admin Tools → Manage Extensibility → OAuth 2.0** |
| `PORTAL_ALUNO_URL` | vazia (o launch devolve JSON) | `https://SEU-DOMINIO/` | — |
| URLs do LTI (login, launch, JWKS) | túnel | domínio real | **o registro da ferramenta LTI** |
| `NODE_ENV` | `development` | `production` | — |

Três consequências de `NODE_ENV=production`, todas propositais: o Swagger sai do
ar (a menos de `SWAGGER_ENABLED=true`), o `LTI_DEBUG_CLAIMS` é ignorado, e o
`GET /d2l/callback` para de devolver o access token no corpo.

**`PORTAL_ALUNO_URL` vazia é a pegadinha mais fácil de deixar passar**: sem ela o
`POST /lti/launch` responde o JSON do launch em vez de redirecionar — é o modo de
teste. O aluno vê um blob de JSON no lugar do portal, e nada no log parece errado.
Vale **também para o erro**: com a variável preenchida, um launch recusado vira
`303` para `{PORTAL_ALUNO_URL}?erro=<código>` e o portal explica o caso; sem ela,
quem não está na base importada termina o clique num `403` em JSON na tela.

**A autorização OAuth feita no ngrok não vale em produção**: o `redirect_uri` do
refresh não vai bater. Autorize de novo, já apontando para o domínio real.

### Autorizar a Valence no servidor

Uma vez só, pelo browser (o passo a passo completo está em
[Autorização da Valence (D2L)](#autorização-da-valence-d2l)). Depois disso o
`D2lOauthService` se vira sozinho, persistindo cada rotação do refresh token.

Três coisas que valem para a vida do sistema, não só para o dia do deploy:

- **A chamada roda como o humano que autorizou.** Se essa conta for desativada ou
  a pessoa sair da instituição, a integração morre junto. Use uma conta de
  serviço, com a role adequada na hierarquia de org units — e note que permissão
  insuficiente pode devolver **200 com dados incompletos**, não 403
  (`docs/D2L_API_REFERENCE.md` §3). Valide contra um aluno conhecido depois de
  autorizar.
- **Restaurar um backup do banco invalida o token.** O refresh token vive só em
  `integracao_d2l`, e cada uso rotaciona e invalida o anterior — um backup traz
  um token já morto. Depois de qualquer restore, reautorize.
- **Nunca fale com o token endpoint por fora do service** (`npm run d2l:token` usa
  o service justamente por isso). Uma rotação feita por fora transforma o refresh
  gravado em lixo, e a integração morre depois, longe da causa.

### Conferir que subiu inteiro

```bash
curl -s https://SEU-DOMINIO/api/health
# {"status":"ok","database":"up","d2l":"ok","timestamp":"..."}
```

`status` reflete **só a API e o banco** — de propósito: é o que o healthcheck do
compose testa, e uma integração opcional não pode marcar o container como
unhealthy. Quem monitora o Brightspace lê o campo `d2l`:

| `d2l` | O que significa | Ação |
|---|---|---|
| `desligado` | `D2L_HABILITADO=false` ou faltam variáveis | Nenhuma — o portal usa a turma do launch |
| `ok` | ligada e autorizada | Nenhuma |
| `nao_autorizado` | **ligada no `.env` e sem refresh token gravado** | Reautorizar pelo browser |
| `desconhecido` | não deu para consultar (banco fora) | Ver `database` |

**`nao_autorizado` é o alerta que justifica o campo.** `habilitado()` só lê o
`.env`: num ambiente nessa situação a API se comporta como se a integração
existisse, e toda leitura de disciplina falha. Sem o `/health`, só um aluno
tentando agendar revelaria o problema. **Monitore este campo.**

### Quando a Valence cai, o portal degrada — não para

Com a integração ligada e fora do ar (token expirado, revogado, Brightspace
indisponível), `DisciplinasDoAlunoService` cai para a **turma do launch**: o aluno
agenda a disciplina de onde clicou em vez de tomar 503. É um fallback pobre de
propósito — quem tem três provas agenda uma, e o remanejo administrativo conserta
o resto —, mas agendar uma prova é melhor que agendar nenhuma.

O log traz `Valence indisponivel: usando a turma do launch como fallback`, no
máximo uma vez por minuto (a queda atinge todo request de todo aluno; sem o
intervalo o incidente enterraria o resto do log).

**O compulsório não tem esse fallback, e não pode ter**: quem nunca fez launch não
tem turma clicada. Lá o erro sobe e vira `FALHA_NA_INTEGRACAO` naquele aluno —
linha de relatório reprocessável, em vez de gente alocada para a disciplina errada.

### Checklist

- [ ] `../.env` e `./.env` preenchidos, ambos `chmod 600`
- [ ] `JWT_SECRET` e `JWT_REFRESH_SECRET` novos (`openssl rand -base64 32`) — não os de dev
- [ ] `NODE_ENV=production`, `TRUST_PROXY=1` (já vem no compose de produção)
- [ ] `PORTAL_ALUNO_URL` preenchida
- [ ] `D2L_REDIRECT_URI` no domínio real **e** atualizada no app OAuth do Brightspace
- [ ] URLs do LTI atualizadas no registro da ferramenta
- [ ] `npm run prisma:deploy` aplicado (o container já faz no start)
- [ ] `npm run seed` rodado — modalidades, polos e o primeiro admin
- [ ] Senha do admin do seed trocada no primeiro login (`mustChangePassword`)
- [ ] Autorização OAuth da Valence feita pelo domínio real, **com os escopos de
      `quizzing:` incluídos** (`npm run d2l:token` confirma o que foi concedido)
- [ ] Grade de senhas cadastrada e `GET /senhas-de-prova/turmas` revisado — cada
      linha em `naoResolvidas` é uma turma que ficaria sem senha
- [ ] Turmas **sem modalidade** decididas na mesma tela: as ambíguas (alunos de
      duas modalidades) têm o seletor de desempate ali; as sem agendamento
      nenhum só o fechamento do prazo resolve
- [ ] Dry-run de um turno rodado, **com o tempo medido**: é o que diz se o horário
      do cron é cedo o bastante
- [ ] Questionário-alvo e horários dos turnos cadastrados **na tela** (não estão
      no `.env`); `SENHA_QUIZ_CRON_HABILITADO=true` no servidor que deve disparar
      e `false` em qualquer réplica extra
- [ ] `GET /api/health` devolvendo `status: ok` e `d2l: ok`
- [ ] Um launch LTI real de ponta a ponta, com um aluno de verdade
- [ ] Backup do volume `agendamento-mysql-data` agendado

---

## Testes

```bash
npm test        # unitários — rootDir=src, ignora src/generated
npm run test:e2e   # exige banco de pé + migrations aplicadas
```

Cobertos hoje: regra de elegibilidade por `STATUS CURSO` (incluindo variações de
acento e caixa), state store do LTI, leitura de claims da config LTI, serviço de
autenticação, utilitários de CSV, cruzamento de turmas, validação da oferta,
**alocação sequencial**, e e2e de health, auth, vínculos do aluno, estrutura
(polo → sala → faixa → oferta), **portal do aluno**, **grade de senhas de prova**,
**contrato da documentação OpenAPI** e **controles de segurança** (deny-by-default,
cabeçalhos, rate limiting).

Dois testes da troca de senhas merecem menção, porque medem coisas que só
apareceriam no dia da prova: o de **cobertura de campos** do corpo do
questionário — o `PUT` substitui o objeto inteiro, e um campo esquecido apaga
`EndDate` de todas as provas do semestre — e o que prova que **o dry-run emite
zero PUT**. No e2e, a grade é verificada com `JSON.stringify(corpo)` explícito:
a senha não pode aparecer em campo nenhum da resposta.

O e2e do portal inclui um teste de **concorrência**: cinco alunos disputando a
mesma vaga ao mesmo tempo têm de terminar com um confirmado e quatro `409`.
Retirar o `FOR UPDATE` da transação faz esse teste falhar com cinco confirmados —
é assim que se sabe que ele está medindo alguma coisa.

---

## Estado atual e roadmap

A ordem de implementação segue a prioridade definida para o projeto.

| # | Etapa | Estado |
|:--:|---|---|
| 1 | Prisma schema + migrations + Docker + seeds | ✅ concluída |
| 2 | Auth (admin JWT + LTI aluno) | ✅ concluída |
| 3 | Importação dos CSVs + seed de polos | ✅ concluída |
| 4 | Estrutura: polo / sala / faixa / sala-faixa | ✅ concluída |
| 5 | Portal do aluno: listar faixas + agendar com alocação sequencial | ✅ concluída |
| 6 | Período de agendamento + relatório (consulta, ocupação por sala, CSV) | ✅ concluída |
| 7 | Remanejo e cancelamento administrativos + troca de horário pelo aluno | ✅ concluída |
| 8a | Valence: OAuth + leitura de matrículas (disciplinas do semestre) | ✅ concluída — **ligada por padrão** desde 18/08/2026 |
| 8b | Valence: special access no quiz | ✅ concluída (15/09/2026) — convive com datas e grupos; ver [Special access por agendamento](#special-access-por-agendamento) |
| 9 | Agendamento compulsório + agendamento administrativo de um aluno | ✅ concluída |
| 10 | Senha das provas: grade dia × turno + troca em massa no Brightspace (manual e por cron) | ✅ concluída |

**Pendências conhecidas**

- O **special access** no quiz existe desde 15/09/2026, ao lado da troca de datas
  e grupos, que continua de pé. Remover acesso de prova cancelada exige
  `quizzing:quizzes:delete` no consentimento OAuth (reautorize).
- A **troca de senha dos questionários** exige os escopos
  `quizzing:quizzes:read quizzing:quizzes:write` **no consentimento OAuth** —
  editar `D2L_SCOPES` não basta, é preciso reautorizar pelo browser
  (`npm run d2l:autorizar`). Sem isso o primeiro PUT volta 403.
- A leitura de matrículas (`D2L_HABILITADO`, ligado por padrão) exige a
  autorização OAuth feita uma vez pelo browser e `D2L_BASE_URL` preenchida. Enquanto isso não acontecer,
  o portal cai para a turma do launch e o aluno continua agendando — mas só a
  disciplina de onde clicou, e o compulsório não roda. `GET /health` acusa o
  estado em `d2l` (`nao_autorizado`); ver [Deploy em produção](#deploy-em-produção).
- A modalidade `PRESENCIAL` existe no modelo (prova de 2h) mas ainda não tem CSV
  correspondente.
