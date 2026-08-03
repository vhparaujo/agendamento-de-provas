# CLAUDE.md — Portal de Agendamento de Provas (Backend)

Guia para trabalhar neste repositório. Leia antes de gerar ou alterar código.

## O que é este projeto

API backend que permite a **alunos** da UCB agendarem a data/horário de suas
provas presenciais, e a **administradores** gerenciarem polos, salas, horários,
turmas e o período de agendamento. Ao confirmar um agendamento, o sistema libera
o acesso às provas (special access) no **Brightspace (D2L)** via **Valence API**.

## Stack

- **NestJS** + **TypeScript**
- **Prisma ORM** sobre **MySQL**
- **Docker** / docker-compose (app + banco)
- Autenticação: **LTI 1.3** (aluno) e **JWT** (admin)
- Documentação da API: **Swagger / OpenAPI** (`@nestjs/swagger`)

O `README.md` documenta o projeto para quem chega (setup, endpoints, modelo de
dados, roadmap). Este arquivo é o guia de *como trabalhar* no código. Ao mudar
regra de negócio ou estrutura, atualize os dois.


## Conceitos de domínio (essenciais)

- **Polo**: unidade física onde as provas ocorrem.
- **Sala**: espaço físico dentro de um polo, com capacidade. **É neutra** — não
  tem modalidade fixa.
- **Modalidade**: formato do curso do aluno — EaD (3h), Modular/Semipresencial
  (1h30) ou Presencial (2h). Define a duração da prova. **Uma por vínculo.**
  Abas do CSV: EaD→`EAD`, Semi→`SEMI`, **Híbrido→`MODULAR`** (são a mesma coisa).
- **Vínculo**: aluno + curso. É a unidade real do sistema — um mesmo RA pode ter
  dois vínculos (dois cursos, modalidades diferentes) e agenda uma prova para cada.
- **Faixa**: horário de prova que o admin abre para um polo (data + hora início +
  hora fim). **Também é neutra** — não tem modalidade fixa.
- **SalaFaixa** (NÚCLEO): associação `Sala + Faixa + Modalidade + vagas + ordem`.
  É AQUI que modalidade e vagas existem de fato. A mesma sala física pode ser
  Presencial numa faixa e EaD em outra; dentro de uma faixa fica travada numa
  modalidade. O admin monta isso ao criar a faixa.
- **Turma real**: turma/disciplina que efetivamente terá prova (CSV de turmas). Filtro
  final do que aparece para o aluno.

## Regras de negócio que NÃO podem ser violadas

1. **Aluno não tem senha.** Ele é reconhecido via LTI 1.3; a matrícula do launch
   é cruzada com o CSV de alunos para obter modalidade + polo. Nunca confie em
   dados auto-declarados pelo cliente.
2. **O que o aluno vê** = faixas do polo dele, na modalidade dele, com vaga, com
   o período de agendamento aberto.
3. **Disciplinas agendáveis** = disciplinas do aluno na Valence ∩ turmas reais
   (CSV de turmas) ∩ período letivo vigente. **Não são todas as disciplinas do aluno.**
4. **Um agendamento cobre todas as disciplinas agendáveis de UM vínculo**
   (mesmo horário). Aluno com dois cursos faz dois agendamentos, um por curso —
   as durações são diferentes, então caem em faixas diferentes. Quando o RA tem
   mais de um vínculo, o portal pergunta de qual curso é a prova
   (`precisaEscolherCurso` na resposta do launch).
5. **Alocação de sala é sequencial**: preenche a sala de menor `ordem` até lotar,
   só então usa a próxima. A vaga é da SalaFaixa (`count(agendamentos) < vagas`).
6. **Concorrência**: a checagem de vaga + criação do agendamento DEVE ocorrer na
   mesma transação, serializada por SalaFaixa. **Nunca conte fora da transação.**
   Implementado em `agendamento.service.ts` como `SELECT ... FOR UPDATE` (vínculo,
   depois as ofertas da faixa+modalidade) sob **READ COMMITTED** — não
   `SERIALIZABLE`: em REPEATABLE READ o snapshot da transação pode ser anterior ao
   lock e a contagem viria velha, e SERIALIZABLE acrescentaria gap lock sem ganho.
   O `FOR UPDATE` é o que garante a exclusão mútua; há teste que prova (remover o
   lock faz 5 alunos entrarem na mesma vaga).
7. **Admin pode remanejar** qualquer agendamento (trocar sala ou faixa). A
   alocação automática é só o default; marcar `alocadoManual = true`.
8. **Período de agendamento fecha só por data/hora** (`dataFechamento`), nunca por
   esgotamento de vagas. Janela de agendamento e datas das provas são linhas do
   tempo independentes.
9. **Sync com D2L é assíncrono e tolerante a falha**: enfileira special access por
   disciplina; 404 (não matriculado) é estado ESPERADO (`NAO_MATRICULADO`), não
   erro. Falha de rede/token re-tenta.

## Documentação da API (Swagger)

**Regra: toda rota, DTO e resposta que entrar no projeto nasce documentada.** Um
endpoint sem `@ApiOperation` é código incompleto — a doc é o contrato com o front,
não um extra opcional.

- **Onde**: `{API_PREFIX}/docs` (UI) e `{API_PREFIX}/docs-json` (spec). Ligada fora
  de produção; `SWAGGER_ENABLED=true` publica mesmo em produção.
- **Setup**: `src/config/swagger.ts` — tags, esquemas de segurança e descrição
  geral. Rota nova **entra numa tag existente** (`TAGS`) ou cria a sua lá.
- O plugin do `@nestjs/swagger` está ligado em `nest-cli.json` com
  `introspectComments: true`: JSDoc em cima de um campo de DTO já vira descrição.
  Ele **complementa**, não substitui as anotações explícitas.

Checklist ao adicionar um endpoint:

1. `@ApiTags(TAGS.X)` no controller.
2. `@ApiOperation({ summary, description })` — o `summary` é o que aparece na
   lista; o `description` explica a **regra de negócio**, não o óbvio do HTTP.
3. Uma resposta de sucesso tipada: `@ApiOkResponse({ type: XDto })` /
   `@ApiCreatedResponse`. Nada de resposta sem `type`.
4. Cada erro que o handler realmente lança, com o **porquê**:
   `@ApiConflictResponse({ description: 'vaga esgotada' })`.
5. `@ApiProperty` em todo campo de DTO de entrada, com `example`.
6. Upload: `@ApiConsumes('multipart/form-data')` + `@ApiBody({ schema })`.

**Não repita `@ApiBearerAuth`**: `@SomenteAdmin()` e `@SomenteAluno()` já aplicam
o esquema de segurança e as respostas 401/403 (`src/auth/roles.decorator.ts`).

**DTOs de resposta** ficam em `<modulo>/dto/*.response.dto.ts` e usam
`implements` da interface do service (`class XDto implements X`). Se a interface
mudar, o build quebra ali — a doc não fica mentindo em silêncio.

**Nunca** transforme em DTO validado um corpo que hoje é interface solta só para
documentá-lo: com `forbidNonWhitelisted` isso passa a rejeitar campos extras e
pode quebrar integração externa (é o caso do launch LTI, documentado por
`@ApiBody({ schema })` justamente por isso).

### A regra é cobrada por teste

`test/openapi.e2e-spec.ts` varre o documento OpenAPI real (o mesmo que a
aplicação publica) e **quebra o build quando uma rota entra sem documentação**.
Ele verifica, para cada operação: `summary`, tag registrada em `TAGS`, resposta
de sucesso, schema na resposta 2xx, esquema de segurança existente, corpo
documentado em POST/PUT/PATCH — e, para cada campo de schema, `description`,
`example`, `enum` ou `format`.

Se um caso legítimo não couber numa regra, **adicione a exceção nomeada** na
constante correspondente do próprio teste, com o motivo escrito
(`SEM_CORPO_DE_SUCESSO`, `SEM_CORPO_DE_REQUISICAO`). Não afrouxe a regra para
todo mundo — uma exceção com nome é auditável; um `if` genérico não é.

O teste roda em `npm run test:e2e` e exige banco de pé.

## Autenticação

- **Aluno**: endpoints LTI 1.3 (login OIDC, launch, JWKS). Valida `id_token`,
  extrai matrícula + userId Valence, emite JWT interno curto só para navegação.
- **Admin**: login próprio e-mail/senha (bcrypt) → JWT (access + refresh).
  - Primeiro admin: **seed idempotente**, senha já em hash, `mustChangePassword=true`.
  - Novos admins: rota protegida por JWT de admin.
  - Reset: administrativo (um admin gera senha provisória para outro). Campos de
    reset por e-mail existem no schema mas ficam fora do MVP.
  - **Um único nível de acesso**: JWT de admin válido = acesso total.

**Decisões já implementadas — não reinventar:**

- **Senha provisória trava tudo.** Com `mustChangePassword=true` o `JwtAdminGuard`
  devolve 403 em qualquer rota, exceto as marcadas com
  `@PermitidoComSenhaProvisoria()` (hoje `/auth/trocar-senha` e `/auth/me`). Sem
  essa exceção o admin do seed ficaria travado para sempre.
- **Login não vaza quais e-mails existem.** Mensagem única para e-mail
  inexistente, senha errada e conta inativa; comparação contra um hash falso
  mantém o tempo de resposta constante. Não "melhore" a mensagem de erro.
- **Refresh só aceita refresh.** O payload carrega `tipo: 'refresh'`, verificado
  antes de emitir tokens novos — um access token não serve.
- **O JWT do aluno carrega os vínculos no payload.** É assim que o agendamento
  confere que o `alunoId` escolhido pelo portal pertence àquela matrícula, sem
  confiar em nada vindo do cliente.
- **STATUS CURSO não bloqueia o login**, só o agendamento: um aluno cancelado é
  reconhecido e recebe mensagem clara, em vez de "não encontrado".
- **Duas travas em admins**: ninguém desativa a si mesmo, e o último admin ativo
  não pode ser desativado.
- **LTI**: `state` de uso único com expiração + `nonce` conferido; valida versão
  `1.3.0`, `LtiResourceLinkRequest` e `deployment_id`. Os claims de matrícula e
  UserId são configuráveis por lista (`LTI_CLAIM_*`, tentados em ordem) porque
  dependem do registro da ferramenta; `LTI_DEBUG_CLAIMS=true` loga os claims
  recebidos para descobrir os nomes reais (ignorado em produção).

Decorators prontos em `src/auth/roles.decorator.ts`: `@SomenteAdmin()`,
`@SomenteAluno()`, `@AdminLogado()`, `@AlunoLogado()`, `@UsuarioLogado()`.

## Segurança (controles ativos — não desfazer sem substituir)

**Nega por padrão.** `AutenticacaoGuard` é global (`APP_GUARD`): rota **sem
decorator de acesso é recusada com 403** e o fato vai para o log como
`ROTA_SEM_CONTROLE_DE_ACESSO`. Toda rota nova precisa de `@SomenteAdmin()`,
`@SomenteAluno()` ou `@Publico()`. Esquecer fecha a rota, nunca abre.

É esse guard que lê o `PERFIL_KEY` — a metadata que antes era gravada e nunca
consultada. **Não coloque `UseGuards(JwtAdminGuard)` numa rota**: com o guard
global, o token seria verificado duas vezes por request.

**Limite de requisições** (`@nestjs/throttler`, ASVS 6.3.1): 120/min no geral;
**5/min** em login, refresh, troca de senha e launch LTI (`@Throttle(LIMITE_AUTENTICACAO)`);
10 a cada 5min nos uploads (`LIMITE_UPLOAD`). Números em `src/config/throttler.config.ts`.
Nos testes o limitador é desligado por `skipIf`; ligue com `THROTTLE_NOS_TESTES=true`
apenas na suíte que testa o próprio limitador.

**Cabeçalhos** (`helmet`, `src/config/helmet.config.ts`): CSP `default-src 'none'`
na API e uma CSP relaxada **só** na rota do Swagger. Não unifique as duas — seria
afrouxar a API inteira por causa da página da doc. `X-XSS-Protection: 0` está
**correto**: o auditor de XSS foi removido dos navegadores e ligá-lo é conselho antigo.

**Auditoria** (`AuditoriaService`, módulo global): uma linha JSON por evento, com
quando/onde/quem/o-quê. Evento novo entra no *union type* `EventoSeguranca`, nunca
como string solta. **Nunca** passe senha, hash ou token em `detalhe`. Valores
vindos do cliente são limpos de caracteres de controle (log injection, ASVS 16.4.1).

Detalhe que importa: no login, **o log distingue o motivo** (e-mail inexistente /
senha errada / conta inativa) enquanto a **resposta continua uniforme**. Quem
investiga precisa do motivo; o atacante não pode tê-lo.

**Filtro global de exceções** (`ExcecoesFilter`): audita 401/403/429, e converte
qualquer erro não tratado em `500` genérico + `erroId` — stack só no log (A10).

**Não se aplica a este projeto:** CSRF (autenticação é `Authorization: Bearer`,
sem cookie; se algum dia o token for para cookie, CSRF volta a existir) e XSS
refletido (a API só devolve JSON). O que é responsabilidade do front está em
[`docs/SEGURANCA-FRONTEND.md`](docs/SEGURANCA-FRONTEND.md) — **mantenha esse
arquivo atualizado** quando mudar contrato de erro, limite ou fluxo de token.

**Pendente:** CORS não configurado (hoje desabilitado = seguro, mas o front não
funcionará até definirmos a origem).

## Endpoints já implementados

Todos sob `{API_PREFIX}` (default `api`). Detalhe completo: `{API_PREFIX}/docs`.

| Rota | Auth | O que faz |
|---|:---:|---|
| `GET /health` | — | Status da API + banco (200 mesmo com banco fora) |
| `POST /auth/login` · `/auth/refresh` | — | Tokens do admin |
| `POST /auth/trocar-senha` · `GET /auth/me` | admin | Liberadas com senha provisória |
| `GET/POST /lti/login` · `POST /lti/launch` · `GET /lti/jwks` | — | Fluxo LTI (autentica pela assinatura do Brightspace) |
| `GET/POST /admins` · `POST /admins/:id/resetar-senha` · `PATCH /admins/:id/ativo` | admin | Gestão de administradores |
| `POST /importacao/alunos` · `/importacao/turmas` · `GET /importacao` | admin | CSVs + auditoria |
| `GET /modalidades` · `GET/POST/PATCH /polos` · `/salas` · `/faixas` · `/sala-faixas` | admin | Estrutura física e oferta de vagas |
| `GET /portal/periodo` · `/portal/disciplinas` · `/portal/faixas` | aluno | O que ele pode escolher |
| `GET/POST /portal/agendamentos` | aluno | Confirmar a prova e consultar o que já marcou |
| `GET/POST /periodos` · `GET/PATCH /periodos/:id` | admin | Abrir/fechar a janela de agendamento |
| `GET /agendamentos` · `/resumo` · `/exportacao` · `/:id` | admin | Relatório: consulta, ocupação por sala e CSV |

Pendentes: remanejo administrativo, cancelamento/troca pelo aluno, integração D2L.

## Cadastro: polos, salas e os 2 CSVs

**Polos — via SEED, não CSV.** Os 27 polos são populados por `prisma/seed-polos.ts`
(nomes extraídos da coluna CAMPUS do CSV de alunos, exatamente como aparecem). O
`Polo.nome` é único e serve de chave de casamento. Adicionar polo novo = inserir
linha, não migration.

**Salas — CADASTRO MANUAL.** O admin cadastra sala (nome + capacidade) e escolhe o
polo num dropdown populado pelos polos do seed. Import de salas por CSV existe só
como opção alternativa secundária; o padrão é manual.

**Os 2 CSVs (upload pelo admin):**

| CSV | Colunas reais → uso | Observações |
|---|---|---|
| **Alunos** | RA→matrícula · ALUNO→nome · EMAIL INSTITUCIONAL→email · CURSO→curso (só exibição) · STATUS CURSO→ativo · CAMPUS→polo | Modalidade vem do **dropdown no upload** (aba EaD/Semi/Híbrido), não de coluna. RA é alfanumérico (String). Encoding real: ISO-8859-1. |
| **Turmas** | orgUnitId, nomeDisciplina, (codigoTurma) | filtro final de disciplinas com prova. **CSV ainda não existe** — cabeçalhos provisórios; parser adiável com mapeamento de colunas isolado num único ponto (`// TODO` ao chegar o arquivo real). |

**Regras dos campos de aluno:**
- **STATUS CURSO**: importa **todos** os alunos, guardando o valor bruto em
  `statusCurso` e derivando `ativo` (= "pode agendar") de uma **lista explícita**
  — `src/enums/status-curso.enum.ts`, ponto único de alteração:

  | Permitem agendar | Bloqueiam |
  |---|---|
  | Ativo · Transf. Interna · Transf. de Curriculo · Alter. de Habilitação | Desistente · Trancado · Cancelado · Formado |

  **Racional (31/07/2026):** situações de *transição* (transferência, mudança de
  habilitação) mantêm o aluno apto; só estados *terminais* barram.
  Status fora das duas listas **bloqueia** e é reportado na importação, para que
  alguém decida em qual lista ele entra. A comparação ignora acento e caixa.
  Como `statusCurso` fica gravado cru, mudar a regra não exige reimportar os CSVs.
- **CURSO**: puramente informativo, exibido para o aluno. Não entra em filtro/alocação.
- **CAMPUS→polo**: casa com `Polo.nome` por string exata (mesma origem do seed).

Todo upload registra auditoria (`ImportacaoCsv`: tipo, arquivo, linhas, quem, quando).
Importação **idempotente**: upsert por `[matricula, curso]` (alunos) e `orgUnitId`
(turmas). Re-subir o mesmo arquivo atualiza, nunca duplica.

**Endpoints** (todos exigem JWT de admin):
- `POST /api/importacao/alunos` — multipart: `arquivo` (.csv) + `modalidade`
  (`EAD|SEMI|MODULAR|PRESENCIAL`, o dropdown da aba de origem)
- `POST /api/importacao/turmas` — multipart: `arquivo`
- `GET /api/importacao` — histórico de auditoria

**Linha rejeitada não interrompe a importação.** O resto entra e a resposta traz
`rejeitadas[]` (nº da linha, RA, motivo), `statusDesconhecidos[]` e
`polosNaoEncontrados[]`. Nada é descartado em silêncio — mas nada é inventado
também: sem CAMPUS não há como definir o polo, e polo é obrigatório para alocar
sala. O admin corrige a planilha e reenvia.

**Encoding é detectado, não presumido**: latin1 (arquivos atuais) ou UTF-8/BOM
(se a planilha for reexportada). Ler errado quebraria o casamento do polo por nome.

**Turmas vazias = comportamento seguro.** Enquanto não houver turmas importadas, o
default é **bloquear agendamento** (não liberar prova para disciplina errada),
controlado por um flag claro e invertível (`TURMAS_FILTER_ENABLED`, default `true`).

O cruzamento disciplinas ∩ turmas ∩ período **já está implementado e testado** em
`src/turma/service/turma.service.ts` (`filtrarAgendaveis`). Quando o CSV real
chegar, o único ponto a mudar é `src/importacao/service/turma-csv.columns.ts` —
nenhuma regra de negócio se move.

## Integração D2L

- **LTI 1.3**: entrada do aluno. ✅ **Implementado e validado contra um launch real.**
- **Valence API (OAuth 2.0)**: ⬜ **ADIADA (decisão de 03/08/2026).** O sistema
  hoje só agenda e emite relatório; a liberação de special access nos quizzes
  fica para uma fase posterior. Não implemente nada de quiz/special access sem
  o cliente pedir.
- Referência completa da API em [`docs/D2L_API_REFERENCE.md`](docs/D2L_API_REFERENCE.md)
  (autenticação, endpoints, armadilhas). O projeto `../lti-spike` tem um launch
  LTI funcionando contra `catolicatest.brightspace.com` — é a fonte de verdade
  sobre quais claims realmente chegam.

**Claims do launch — confirmados, não presumidos.** Matrícula e UserId vêm no
claim PROPRIETÁRIO `http://www.brightspace.com` (`org_defined_id` e `user_id`),
não em parâmetros customizados. **O `sub` do LTI é opaco (`<guid>_76629`) e a
Valence API o rejeita** — ele não está na lista de candidatos, e há teste que
falha se alguém o recolocar. O launch recusa UserId não-numérico de propósito:
o erro precisa aparecer no login, não no dia da prova.

## Organização do código

Modular por domínio. Cada módulo segue subpastas:
`controller/ · dto/ · service/ · module/` (padrão do projeto de referência).

```
src/
  auth/        ✅ controller/ dto/ jwt/ lti/ service/ module/ roles.decorator.ts
  admin/       ✅   aluno/  ✅   importacao/ ✅ (2 CSVs)   turma/ ✅ (cruzamento)
  config/      ✅ env.validation.ts · swagger.ts · helmet.config.ts · throttler.config.ts
  seguranca/   ✅ auditoria (log de eventos) · filtro global de excecoes
  database/    ✅ prisma.service.ts · mariadb-adapter.ts · prisma.module.ts
  enums/       ✅ perfil.enum.ts · status-curso.enum.ts
  dto/         ✅ respostas de rotas fora de módulo (health)
  generated/   ✅ client do Prisma — NÃO versionado, não editar

  modalidade/  ✅  polo/  ✅  sala/  ✅  faixa/  ✅  sala-faixa/  ✅
  agendamento/ ✅ portal do aluno · alocacao.ts (pura) · disciplinas-do-aluno.service.ts
  periodo/     ✅ CRUD do admin + leitura usada pelo portal
  d2l/         ⬜ adiado — não criar sem o cliente pedir

  app.module.ts  app.controller.ts (health)  main.ts
```

## Convenções

- **DTOs** com `class-validator` para toda entrada de dados. Nunca aceitar body
  cru sem validação. `ValidationPipe` global com `whitelist` +
  `forbidNonWhitelisted`: campo não declarado no DTO derruba a request.
- **Toda rota e todo DTO documentados no Swagger** — ver a seção acima.
- **Prisma** como única camada de acesso a dados; sem SQL cru exceto onde a
  transação de alocação exigir lock explícito. Injete `PrismaService`; nunca
  instancie `PrismaClient` fora de `src/database/`.
- **Nomes em português** no domínio (matrícula, faixa, polo) para casar com o
  vocabulário institucional; código/estruturas em inglês onde for convenção.
- **Segredos só via `.env`** (DATABASE_URL, JWT_SECRET, credenciais Valence/LTI,
  seed do admin). Nunca commitar segredo.
- **Variável de ambiente nova entra em `src/config/env.validation.ts`** e no
  `.env.example`. O `.env` é validado no boot: faltando algo essencial, a
  aplicação não sobe — melhor falhar no start que em produção.
- **Erros de negócio** com exceções tipadas do Nest (ex: `ConflictException` para
  vaga esgotada, `ForbiddenException` para período fechado).
- **Rota nova = decorator de acesso obrigatório.** Sem `@SomenteAdmin()`,
  `@SomenteAluno()` ou `@Publico()` ela é negada pelo guard global.
- **Ação sensível = evento de auditoria.** Login, troca de senha, mudança de
  admin, e o que vier de agendamento/remanejo.
- **Comentário explica o *porquê*, não o *quê*.** O padrão do repositório é
  registrar a decisão e o risco que ela evita (ver `status-curso.enum.ts`,
  `mariadb-adapter.ts`). Mantenha isso.

## Comandos

```bash
cp .env.example .env         # preencha JWT_SECRET, JWT_REFRESH_SECRET, SEED_ADMIN_*

# subir só o banco (padrão para dev; app roda na máquina)
npm run db:up                # docker compose up -d mysql
# subir tudo containerizado (app + mysql)
docker compose up -d --build

# prisma
npm run prisma:generate      # regenera o client em src/generated (não versionado)
npm run prisma:migrate       # migrate dev
npm run prisma:deploy        # migrate deploy (produção/container)
npm run prisma:studio
npm run db:down              # derruba o compose
npm run db:reset             # migrate reset — APAGA os dados

# seeds idempotentes: modalidades + 27 polos + 1º admin
npm run seed                 # lê SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD do .env

# LTI
npm run lti:keygen           # gera a chave RSA da ferramenta (LTI_TOOL_PRIVATE_KEY)

# token de aluno para testar o portal sem o Brightspace (recusa em producao)
npm run token:aluno -- <RA> [orgUnitId] [titulo da turma]

# dev / qualidade
npm run start:dev            # doc em http://localhost:3000/api/docs
npm test        # unitários
npm run test:cov
npm run test:e2e   # exige banco de pé + migrations aplicadas
npm run lint
npm run format
```

## Notas de infraestrutura (Prisma 7)

O projeto usa **Prisma 7**, que muda três coisas em relação ao que se vê na
maioria dos tutoriais (e em relação ao `schema.prisma` original):

- O generator é `prisma-client` (não `prisma-client-js`), com `output` obrigatório
  → o client é gerado em `src/generated/prisma` e **não é versionado**. Depois de
  clonar ou mudar o schema, rode `npm run prisma:generate`.
- `url` **não existe mais** no bloco `datasource`. A `DATABASE_URL` é lida pelo CLI
  via `prisma.config.ts` e pelo runtime via **driver adapter**
  (`@prisma/adapter-mariadb`), montado em `src/database/mariadb-adapter.ts`.
- `prisma.config.ts` substitui o bloco `prisma` do `package.json` (schema,
  migrations e comando de seed).

Dois detalhes que já custaram tempo — não desfaça:

- `importFileExtension = "js"` no generator é **obrigatório**. Sem ele o Prisma
  infere a extensão a partir do tsconfig presente no momento do generate e emite
  imports `.ts` quando roda sem tsconfig (o build do Docker), quebrando o
  `require()` no `dist`.
- O `docker/mysql/init/` concede ao usuário da aplicação permissão sobre o shadow
  database do `prisma migrate dev` (só desenvolvimento).

## Estrutura física e oferta de vagas (etapa 5)

`GET /modalidades` · `polos` · `salas` · `faixas` · `sala-faixas` — todas exigem
JWT de admin.

**Onde cada coisa vive:** sala é física e neutra; faixa é horário neutro; a
**oferta** (`SalaFaixa` = sala + faixa + modalidade + vagas + ordem) é onde
modalidade e vaga existem de fato. Criar oferta é sempre por dentro da faixa
(`POST /faixas` ou `POST /faixas/:id/salas`) — `SalaFaixa` nunca nasce solta.

**Validações que recusam configuração impossível** (`sala-faixa.validacao.ts`,
compartilhado pelas duas portas de entrada):

| Regra | Por quê |
|---|---|
| Sala tem que ser do mesmo polo da faixa | Senão o aluno é alocado em outro campus |
| Janela ≥ duração da modalidade | Faixa de 1h30 com sala EaD (3h) é oferta impossível |
| `vagas` ≤ capacidade da sala | Mais alunos do que lugares |
| Sala entra 1× por faixa | Dentro da faixa ela fica travada numa modalidade |
| `ordem` única por faixa + modalidade | É a sequência de preenchimento da alocação |

**Campos deliberadamente imutáveis** — mudá-los quebraria dado já gravado:
`Polo.nome` (chave de casamento com o CSV), `Sala.poloId` (sala não se muda de
campus), `SalaFaixa.modalidadeId` (trocar depois de haver agendamento poria o
aluno numa prova de outra duração). Nos três casos o campo não existe no DTO de
update, então `forbidNonWhitelisted` devolve 400.

**Apagar vs. desativar:** só se apaga o que nunca foi usado. Sala já ofertada,
faixa com agendamento e oferta com aluno alocado respondem 409 sugerindo
`ativo=false` — o histórico de quem já tem prova marcada precisa sobreviver.
Reduzir `vagas` abaixo dos agendamentos existentes também é 409.

## Portal do aluno (etapa 6)

`GET /portal/periodo · /portal/disciplinas · /portal/faixas` e
`GET/POST /portal/agendamentos` — todas exigem o JWT emitido pelo launch LTI.

**O aluno não escolhe nada além do horário.** Polo e modalidade vêm do CSV; a
sala vem da alocação. Por isso `GET /portal/faixas` **não devolve salas**: mostrar
antes daria a entender que dá para escolher, e o número por sala já estaria velho
no segundo seguinte. Faixa lotada continua na lista com `temVaga: false`, em vez
de sumir sem explicação.

**Alocação sequencial** (`agendamento/service/alocacao.ts`, função pura): enche a
sala de menor `ordem` até lotar, só então abre a próxima. Espalhar daria a mesma
contagem e exigiria mais fiscais e mais salas abertas.

**A transação** (`agendamento.service.ts`) — ver regra 6. Ordem dos locks sempre
`aluno_importado → sala_faixa → agendamento`, o que impede ciclo de deadlock. O
lock do vínculo existe para serializar o **mesmo aluno consigo mesmo** (duplo
clique em faixas diferentes não passaria pelo lock das salas).

**Ocupação é contada igual em todo lugar** (`status = CONFIRMADO`): admin e
alocador precisam ver o mesmo número, senão um dos dois está mentindo.

**Recusas, na ordem em que acontecem** — cada uma com a mensagem mais útil:

| Situação | Resposta |
|---|---|
| STATUS CURSO bloqueia (Cancelado, Trancado…) | 403 com o status citado |
| Período fechado / ainda não abriu / não configurado | 403 com o motivo exato |
| Nenhuma disciplina com prova | 403 |
| Faixa de outro polo | 403 |
| Faixa inativa ou com data passada | 409 |
| Já tem prova marcada para o vínculo | 409 |
| Vagas esgotadas | 409 |
| `alunoId` que não está no token | 403 + auditoria |

**Fonte das disciplinas é uma costura de um arquivo só**
(`disciplinas-do-aluno.service.ts`). Hoje: a turma de onde o aluno clicou (claim
`context` do LTI, que agora vai no JWT). Na etapa 7 vira o enrollments da Valence
— nada mais muda.

**A fila do D2L nasce na mesma transação** do agendamento: um agendamento gravado
sem sua fila seria prova marcada que nunca é liberada no Brightspace, e ninguém
descobriria até o aluno tentar abrir o quiz.

**Sem período cadastrado = fechado.** Mesma escolha do filtro de turmas: na
dúvida, não libera. Para testar antes do CRUD administrativo (etapa 7), crie a
linha em `PeriodoAgendamento` pelo `npm run prisma:studio`.

**Token de aluno para teste:** `npm run token:aluno -- <RA> [orgUnitId] [título]`
monta o mesmo payload do launch lendo os vínculos do banco, pulando só a
assinatura do Brightspace. **Recusa rodar com `NODE_ENV=production`.**

## Ao implementar, priorize nesta ordem

1. ✅ Prisma schema + migrations + Docker + seed do admin.
2. ✅ Auth (admin JWT + LTI aluno).
3. ✅ Importação dos 2 CSVs (alunos, turmas) + seed de polos.
4. ✅ Estrutura (polo/sala/faixa/sala-faixa).
5. ✅ Portal do aluno (listar faixas + agendar com alocação sequencial).
6. ✅ Período de agendamento + relatório (consulta, ocupação por sala, CSV).
7. ⬜ Remanejo administrativo + cancelamento/troca pelo aluno.
8. ⬜ Integração D2L (Valence + special access) — **adiada pelo cliente.**

**Bloqueios externos:** o CSV real de turmas não chegou (mapeamento provisório).
As credenciais da Valence não existem, mas isso deixou de ser bloqueio: a
integração foi adiada pelo cliente.
