# Portal de Agendamento de Provas — UCB (Backend)

API que permite a **alunos** da UCB agendarem a data e o horário de suas provas
presenciais, e a **administradores** gerenciarem polos, salas, horários, turmas,
o período de agendamento e o **relatório de quem agendou o quê**.

A liberação automática das provas no Brightspace (*special access* via Valence
API) está **adiada** — o sistema hoje agenda e emite relatório. O que já existe é
a entrada do aluno por **LTI 1.3**, que funciona.

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
| **Modalidade** | Formato do curso, define a **duração da prova**: EaD 3h · Semipresencial 1h30 · Modular/Híbrido 1h30 · Presencial 2h. |
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
2. **O que o aluno vê** = faixas do polo dele, na modalidade dele, com vaga, com
   o período de agendamento aberto.
3. **Disciplinas agendáveis** = disciplinas do aluno na Valence ∩ turmas reais
   (CSV) ∩ período letivo vigente. **Não são todas as disciplinas do aluno.**
4. **Um agendamento cobre todas as disciplinas agendáveis de UM vínculo**, no
   mesmo horário. Aluno com dois cursos faz dois agendamentos — as durações são
   diferentes, então caem em faixas diferentes.
5. **Alocação de sala é sequencial**: preenche a sala de menor `ordem` até lotar,
   só então usa a próxima. A vaga é da SalaFaixa (`count(agendamentos) < vagas`).
6. **Concorrência**: a checagem de vaga + criação do agendamento **deve** ocorrer
   na mesma transação, serializada por SalaFaixa. Nunca conte fora da transação.
   Feito com `SELECT ... FOR UPDATE` sob READ COMMITTED — há teste que prova:
   remover o lock faz 5 alunos entrarem na mesma vaga.
7. **Reagendamento tem dono.** O aluno só troca/cancela com o período **aberto**
   e só no período **vigente**. O admin remaneja a qualquer tempo (é a válvula de
   escape), marcando `alocadoManual = true`, mas nem ele muda polo ou modalidade.
   **Toda alteração grava quem a fez** — aluno ou administrador — na mesma
   transação da mudança.
8. **O período fecha só por data/hora** (`dataFechamento`), nunca por esgotamento
   de vagas. A janela de agendamento e as datas das provas são linhas do tempo
   independentes.
9. **Sync com D2L é assíncrono e tolerante a falha**: 404 (aluno não matriculado)
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
| `SWAGGER_ENABLED` | | vazio = ligado fora de produção; `true` publica também em produção |
| `THROTTLE_NOS_TESTES` | | só para teste: liga o rate limiting sob `NODE_ENV=test` |
| `JWT_EXPIRES_IN` / `JWT_REFRESH_EXPIRES_IN` | | default `15m` / `7d` |
| `JWT_ALUNO_EXPIRES_IN` | | default `2h` — token curto, só para navegação |
| `SEED_ADMIN_EMAIL` / `_PASSWORD` / `_NOME` | seed | lidos apenas por `npm run seed` |
| `PERIODO_LETIVO_ID` | | período letivo vigente no Brightspace (ex: `103`) |
| `TURMAS_FILTER_ENABLED` | | **default seguro `true`** — ver abaixo |
| `LTI_*` | LTI | issuer, client id, deployment, URLs, chave RSA, claims |
| `D2L_HABILITADO` | | **default `false`** — ligado, as disciplinas do aluno passam a vir dos enrollments da Valence |
| `D2L_*` | D2L | credenciais OAuth, URL do tenant, versão da API e Type Ids de org unit |

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
| `GET` | `/health` | Status da API e do banco |

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

Todas exigem JWT de admin e são **somente leitura**: a planilha é a fonte de
verdade, e um ajuste feito por aqui seria desfeito no próximo upload sem ninguém
perceber. Para corrigir um registro, corrige-se o CSV e reimporta.

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/alunos` | Pesquisa os vínculos importados — paginada |
| `GET` | `/alunos/cursos` | Cursos distintos, para o dropdown do filtro |
| `GET` | `/alunos/:id` | O vínculo: origem, outros vínculos do mesmo RA e provas marcadas |
| `GET` | `/turmas` | Pesquisa as turmas/disciplinas do CSV — paginada |
| `GET` | `/turmas/:id` | A turma: origem e quantos agendamentos a cobrem |

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

### Período de agendamento

Exigem JWT de admin. A janela em que se pode agendar — **não confundir com as
datas das provas**, que são as faixas. São duas linhas do tempo independentes.

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/periodos` | Histórico; o primeiro da lista é o vigente |
| `GET` | `/periodos/:id` | Detalhe, com quantos já agendaram |
| `POST` | `/periodos` | Cria — **nasce fechado**, para conferir as faixas antes de liberar |
| `PATCH` | `/periodos/:id` | Abre, fecha ou ajusta o prazo |

Fecha **só por data/hora**. Vaga esgotando é problema de capacidade (o admin abre
mais salas), nunca motivo para encerrar o agendamento de quem ainda não escolheu.

### Relatório de agendamentos

Exigem JWT de admin. Todas aceitam os mesmos filtros: `poloId`, `faixaId`,
`salaId`, `modalidadeId`, `periodoLetivoId`, `de`, `ate` (data da **prova**).

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/agendamentos` | Listagem paginada (50/pág, máx. 200), com busca por matrícula, nome ou curso |
| `GET` | `/agendamentos/resumo` | Ocupação por sala: quais abrir, quantos fiscais, quais ficaram vazias |
| `GET` | `/agendamentos/exportacao` | **CSV de TODOS os alunos** — agendados ou não |
| `GET` | `/agendamentos/:id` | Detalhe |
| `GET` | `/agendamentos/:id/historico` | **Quem alterou**: o próprio aluno ou qual administrador |
| `PATCH` | `/agendamentos/:id/remanejar` | Move de sala (`salaFaixaId`) ou de horário (`faixaId`) |
| `DELETE` | `/agendamentos/:id` | Cancela (vira `CANCELADO`, não apaga) |

O remanejo **não depende do período estar aberto** — consertar depois do
fechamento é justamente o caso de uso.

Sem `status` explícito, a **consulta** traz apenas os **confirmados** — um
cancelado na lista do dia da prova faria alguém procurar um aluno que não vem.

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
| `Data da prova` · `Inicio` · `Fim` · `Sala` | vazias para quem não agendou |
| `Status` | **só dois valores**: `Agendado` ou `Não Agendado` |
| `Agendado em` | data/hora em que o aluno confirmou |

- **Cancelado conta como `Não Agendado`.** Quem cancelou e não remarcou precisa
  ser contatado igual a quem nunca entrou no portal. É também por isso que
  `status` não se aplica aqui: a coluna é **derivada**, não filtrada.
- **O recorte é um período letivo** — o de `periodoLetivoId` ou, sem ele, o
  vigente. Sem isso, quem fez prova no semestre passado apareceria como
  "agendado" e escaparia da cobrança deste.
- `faixaId`, `salaId`, `de` e `ate` são filtros da **prova**: informá-los
  restringe o arquivo a quem tem prova ali (é a lista daquela sala/daquele dia).
  `poloId`, `modalidadeId` e `busca` filtram o **aluno** e continuam trazendo
  quem não agendou.

### Relatórios — grupos para o Brightspace

A aba **Relatorios** do painel. Gera o arquivo que o *Groups Import* do
Brightspace consome, para criar um grupo por horário de prova (e depois liberar
o quiz para o grupo).

Filtros comuns às três rotas: `poloId`, `periodoLetivoId`, `de`, `ate` (data da
**prova**).

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/relatorios/grupos-d2l` | Lista as faixas do recorte com quantos alunos cada uma tem |
| `GET` | `/relatorios/grupos-d2l/zip` | Zip com o CSV de todas as faixas |
| `GET` | `/relatorios/grupos-d2l/:faixaId` | O CSV de uma faixa |

O arquivo tem **duas colunas**: `Nome de usuário` com a matrícula (RA) e
`Código do Grupo` **em branco** — o código é preenchido à mão depois de criar o
grupo no D2L.

```
Nome de usuário,Código do Grupo
UC25426847,
0009552430,
```

- **Um arquivo por FAIXA**, não por sala: o grupo existe para liberar o quiz num
  horário, e a sala em que a pessoa senta não muda o acesso.
- **Cada matrícula aparece uma vez.** Um RA com dois vínculos na mesma modalidade
  pode ter dois agendamentos na mesma faixa; o grupo é por *usuário*.
- **Só agendamentos `CONFIRMADO`**, no período letivo do recorte (ou o vigente).
- Nome do arquivo: **`20-08-2026 08h30-11h30.csv`** — dia e horário, sem polo e
  sem sala. Dentro do zip, duas faixas do mesmo horário em polos diferentes são
  desempatadas pelo id (`... #14.csv`).
- Faixa **sem ninguém** aparece na listagem com `0`, mas fica **fora do zip**.

#### ⚠️ Este CSV é o oposto do outro

| | `/agendamentos/exportacao` | `/relatorios/grupos-d2l/:faixaId` |
|---|---|---|
| Quem lê | Pessoa, no Excel pt-BR | O Brightspace |
| Separador | `;` | `,` |
| BOM UTF-8 | sim | **não** |
| Colunas | 12 | 2 |

Com `;` o D2L lê a linha inteira como um campo só; com BOM, os três bytes grudam
no cabeçalho e `Nome de usuário` deixa de casar com a coluna esperada. O
montador é o mesmo (`csv-relatorio.ts`), parametrizado por `{ separador, bom }`,
com **default no formato do Excel**.

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
3. Autorize uma vez pelo browser:
   `https://auth.brightspace.com/oauth2/auth?response_type=code&client_id=…&redirect_uri=…&scope=…&state=…`

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
| `PATCH` | `/portal/agendamentos/:id` | **Troca de horário** — atômica: sem vaga no novo, mantém o antigo |
| `DELETE` | `/portal/agendamentos/:id` | Cancela a própria prova |

Trocar e cancelar valem **enquanto o prazo estiver aberto**. Depois disso, só a
secretaria remaneja — cancelar após o fechamento deixaria um lugar vago que mais
ninguém consegue ocupar.

O aluno enxerga **apenas o período vigente**: provas de semestres anteriores não
aparecem nem podem ser alteradas. Mas fechar o prazo **não esconde** a prova dele
— ele continua vendo onde e quando é. Fechar tranca a escolha, não a consulta.

Toda alteração registra **quem a fez**, e o administrador consulta em
`GET /agendamentos/:id/historico`. É a resposta para "mudaram minha prova e não
fui eu".

O aluno não escolhe polo, modalidade nem sala. Polo e modalidade vêm do CSV; a
sala é resultado da alocação no instante da confirmação.

**De onde vêm as disciplinas de `/portal/disciplinas`.** A fonte é decidida em um
arquivo só (`agendamento/service/disciplinas-do-aluno.service.ts`):

| `D2L_HABILITADO` | Turmas consideradas |
|---|---|
| `false` (default) | Só a turma de onde o aluno clicou (claim `context` do LTI) |
| `true` | Todas as ofertas dele no período letivo cadastrado, lidas por `enrollments/users/{id}/orgUnits/` e cruzadas com os descendentes do Período Letivo |

O semestre é **o que o admin cadastrou** em `PeriodoAgendamento.periodoLetivoId`
(org unit tipo `103` neste tenant), não "o atual" segundo o relógio. Sem esse
recorte viriam também as disciplinas de semestres passados.

⚠️ **A lista não é separada por vínculo.** Turma não pertence a um curso, então
quem tem dois vínculos na mesma matrícula recebe as disciplinas dos dois juntas.
São 2 alunos em 7519 — ver "Turma não pertence a um curso".

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
| **Deny by default** | Guard global: rota sem `@SomenteAdmin()`/`@SomenteAluno()`/`@Publico()` é **negada** |
| **Rate limiting** | 5/min em login, refresh, troca de senha e launch LTI · 10/5min em uploads · 120/min no resto |
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

TurmaImportada ── ImportacaoCsv      Admin      PeriodoAgendamento
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
| `Agendamento` | A reserva, apontando para a `SalaFaixa` alocada |
| `AgendamentoDisciplina` | As N disciplinas cobertas pela reserva |
| `SyncD2L` | Fila de gravação do *special access* (PENDENTE/CONCLUIDO/FALHOU/NAO_MATRICULADO) |
| `HistoricoAgendamento` | Quem alterou o agendamento: evento, autor (aluno/admin), de → para |
| `PeriodoAgendamento` | Janela de agendamento; fecha por `dataFechamento` |

**Índices que importam para a regra**

- `SalaFaixa @@unique([salaId, faixaId])` — uma sala entra uma única vez por
  faixa, logo numa única modalidade.
- `SalaFaixa @@unique([faixaId, modalidadeId, ordem])` — a ordem de preenchimento
  é única e não ambígua.
- `AlunoImportado @@unique([matricula, curso])` — chave de idempotência da
  importação. **`matricula` sozinha não é única**, porque um RA pode ter vários
  vínculos.
- `Agendamento @@index([salaFaixaId])` — usado na contagem de ocupação dentro da
  transação de alocação.

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

> ⚠️ **`alteracoesComAgendamento[]` — troca de modalidade ou polo em quem já tem
> prova marcada.** São os dois campos que a importação muda *por baixo* de uma
> reserva confirmada: a modalidade vem do dropdown e sobrescreve todas as linhas
> do arquivo, e o polo segue a coluna `CAMPUS`. A reserva continua na sala antiga
> — prova de outra duração, ou em outro campus — e nada mais no sistema reclama.
> O sintoma aparece depois e disfarçado: o remanejo passa a ser recusado com
> *"esta sala não é da modalidade do aluno"*.
>
> O upload **não é bloqueado** (a planilha pode estar corrigindo um cadastro
> errado), mas cada linha dessas pede decisão: remanejar ou cancelar a reserva.
> A contagem considera só o **semestre vigente** — prova de semestre passado já
> aconteceu, e avisar sobre ela seria o ruído que faz o aviso ser ignorado.

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
  d2l/            OAuth da Valence + leitura de matrículas (d2l-enrollments)
  database/       PrismaService + driver adapter MariaDB
  dto/            respostas de rotas fora de módulo (health)
  enums/          perfil, status-curso (regra de elegibilidade)
  faixa/          horários + montagem da oferta (SalaFaixa)
  importacao/     parsing dos 2 CSVs + auditoria
  modalidade/     leitura das modalidades e suas durações
  periodo/        janela de agendamento (CRUD do admin + leitura do portal)
  polo/  sala/  sala-faixa/    estrutura física e ajuste da oferta
  relatorio/
    service/      relatorio.service.ts (as faixas exportáveis e o zip)
                  csv-grupos-d2l.ts (o formato que o Groups Import aceita)
  seguranca/      auditoria + filtro global de exceções
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

## Testes

```bash
npm test        # unitários — rootDir=src, ignora src/generated
npm run test:e2e   # exige banco de pé + migrations aplicadas
```

Cobertos hoje: regra de elegibilidade por `STATUS CURSO` (incluindo variações de
acento e caixa), state store do LTI, leitura de claims da config LTI, serviço de
autenticação, utilitários de CSV, cruzamento de turmas, validação da oferta,
**alocação sequencial**, e e2e de health, auth, vínculos do aluno, estrutura
(polo → sala → faixa → oferta), **portal do aluno**, **contrato da documentação
OpenAPI** e **controles de segurança** (deny-by-default, cabeçalhos, rate limiting).

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
| 7 | Remanejo administrativo + cancelamento/troca pelo aluno | ✅ concluída |
| 8a | Valence: OAuth + leitura de matrículas (disciplinas do semestre) | 🟡 pronta, desligada por padrão |
| 8b | Valence: special access no quiz | ⬜ **adiada pelo cliente** |

**Pendências conhecidas**

- O **special access** no quiz foi **adiado** (decisão de 03/08/2026): o sistema
  agenda, lê as disciplinas e emite relatório; liberar a prova no Brightspace fica
  para depois. Referência técnica em `docs/D2L_API_REFERENCE.md`.
- A leitura de matrículas (`D2L_HABILITADO=true`) exige a autorização OAuth feita
  uma vez pelo browser e `D2L_BASE_URL` preenchida. Enquanto isso não acontecer,
  o portal usa a turma do launch e nada quebra.
- A modalidade `PRESENCIAL` existe no modelo (prova de 2h) mas ainda não tem CSV
  correspondente.
