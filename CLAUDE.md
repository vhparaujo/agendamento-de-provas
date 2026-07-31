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
6. **Concorrência**: a checagem de vaga + criação do agendamento DEVE ocorrer em
   transação serializável por SalaFaixa. Nunca conte fora da transação.
7. **Admin pode remanejar** qualquer agendamento (trocar sala ou faixa). A
   alocação automática é só o default; marcar `alocadoManual = true`.
8. **Período de agendamento fecha só por data/hora** (`dataFechamento`), nunca por
   esgotamento de vagas. Janela de agendamento e datas das provas são linhas do
   tempo independentes.
9. **Sync com D2L é assíncrono e tolerante a falha**: enfileira special access por
   disciplina; 404 (não matriculado) é estado ESPERADO (`NAO_MATRICULADO`), não
   erro. Falha de rede/token re-tenta.

## Autenticação

- **Aluno**: endpoints LTI 1.3 (login OIDC, launch, JWKS). Valida `id_token`,
  extrai matrícula + userId Valence, emite JWT interno curto só para navegação.
- **Admin**: login próprio e-mail/senha (bcrypt) → JWT (access + refresh).
  - Primeiro admin: **seed idempotente**, senha já em hash, `mustChangePassword=true`.
  - Novos admins: rota protegida por JWT de admin.
  - Reset: administrativo (um admin gera senha provisória para outro). Campos de
    reset por e-mail existem no schema mas ficam fora do MVP.
  - **Um único nível de acesso**: JWT de admin válido = acesso total.

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
Importação **idempotente** (upsert por matrícula/orgUnitId; re-subir não duplica).

**Turmas vazias = comportamento seguro.** Enquanto não houver turmas importadas, o
default é **bloquear agendamento** (não liberar prova para disciplina errada),
controlado por um flag claro e invertível (`TURMAS_FILTER_ENABLED`). O cruzamento
disciplinas ∩ turmas ∩ período já deve estar escrito e testável com um mock de
2-3 linhas; quando o CSV real chegar, só muda o mapeamento de colunas.

## Integração D2L

- **LTI 1.3**: entrada do aluno.
- **Valence API (OAuth 2.0)**: ler enrollments do aluno (cruzar com turmas reais)
  e gravar special access nos quizzes. Usuário de serviço + refresh token
  persistido com segurança; renovação automática do access token.
- Documentação de referência da Valence/D2L está listada no projeto (docs D2L).

## Organização do código

Modular por domínio. Cada módulo segue subpastas:
`controller/ · dto/ · service/ · module/` (padrão do projeto de referência).

```
src/
  auth/        (controller, lti, jwt, dto, service, module, roles.decorator.ts)
  admin/       aluno/      modalidade/
  polo/        sala/       faixa/     sala-faixa/
  agendamento/ (alocação sequencial — coração da regra)
  importacao/  (parsing dos 2 CSVs)   turma/
  periodo/     (abrir/fechar agendamento)
  d2l/         (valence-client.service.ts, sync.service.ts)
  components/  enums/  errors/  database/ (Prisma)
  app.module.ts  main.ts
```

## Convenções

- **DTOs** com `class-validator` para toda entrada de dados. Nunca aceitar body
  cru sem validação.
- **Prisma** como única camada de acesso a dados; sem SQL cru exceto onde a
  transação de alocação exigir lock explícito.
- **Nomes em português** no domínio (matrícula, faixa, polo) para casar com o
  vocabulário institucional; código/estruturas em inglês onde for convenção.
- **Segredos só via `.env`** (DATABASE_URL, JWT_SECRET, credenciais Valence/LTI,
  seed do admin). Nunca commitar segredo.
- **Erros de negócio** com exceções tipadas do Nest (ex: `ConflictException` para
  vaga esgotada, `ForbiddenException` para período fechado).

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

# seeds idempotentes: modalidades + 27 polos + 1º admin
npm run seed                 # lê SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD do .env

# dev / qualidade
npm run start:dev
npm test        # unitários
npm run test:e2e   # exige banco de pé + migrations aplicadas
npm run lint
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

O `docker/mysql/init/` concede ao usuário da aplicação permissão sobre o shadow
database do `prisma migrate dev` (só desenvolvimento).

## Ao implementar, priorize nesta ordem

1. Prisma schema + migrations + Docker + seed do admin.
2. Auth (admin JWT + LTI aluno).
3. Importação dos 2 CSVs (alunos, turmas) + seed de polos.
4. Estrutura (polo/sala/faixa/sala-faixa).
5. Portal do aluno (listar faixas + agendar com alocação sequencial).
6. Integração D2L (Valence client + fila de special access).
7. Período de agendamento + remanejo administrativo + exportação.
