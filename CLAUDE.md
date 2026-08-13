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
7. **Reagendamento tem dono, e fica registrado.**
   - **O aluno só reagenda com o período ABERTO.** Trocar de horário e cancelar
     valem enquanto o prazo corre; depois disso, só a secretaria. É a mesma trava
     do agendamento inicial — a troca não pode ser uma porta para burlar o prazo.
   - **O aluno só enxerga e só mexe no período VIGENTE.** Provas de semestres
     anteriores não aparecem para ele nem podem ser alteradas. Sem isso, abrir o
     período novo daria a ele a chance de cancelar uma prova que já fez.
   - **Fechar o prazo NÃO esconde a prova.** Ele continua vendo onde e quando é.
     Fechar tranca a *escolha*, não a *consulta*.
   - **Admin pode remanejar** qualquer agendamento (trocar sala ou faixa), e
     **não depende do período estar aberto** — consertar depois do fechamento é o
     caso de uso. Marca `alocadoManual = true`. Mas nem ele muda **polo** (aluno
     iria ao campus errado) ou **modalidade** (prova de outra duração): são os
     dois erros que o remanejo poderia esconder.
   - **TODA alteração grava QUEM a fez** em `HistoricoAgendamento`, na mesma
     transação da mudança — `TROCADO`/`ALUNO` com a matrícula, `REMANEJADO`/`ADMIN`
     com o e-mail. Existe para a conversa no balcão: o aluno diz que mudaram a
     prova dele, e a secretaria mostra que foi ele mesmo. Ver
     `GET /agendamentos/:id/historico`.
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

### Como o token do aluno chega ao front (código de uso único)

O launch é um POST do Brightspace para **nós**; quem precisa do token é o portal,
que roda no **navegador do aluno**. Entre os dois só existe um redirect, e
redirect só carrega URL — mas **o token não pode ir na URL** (histórico do
navegador, log de proxy, header `Referer`).

Por isso o handoff é em duas etapas, e `PORTAL_ALUNO_URL` decide qual caminho:

| `PORTAL_ALUNO_URL` | `POST /lti/launch` responde |
|---|---|
| preenchida | **303** para `{PORTAL_ALUNO_URL}?code=<uuid>` |
| vazia | o JSON do launch — é assim que se testa sem front |

O portal então chama `POST /lti/sessao` com o `code` e recebe o token. O código é
UUID v4, **de uso único**, TTL de 2 min, guardado em `LtiCodeStore` — mesmo
desenho e mesmas garantias do `state` em `LtiStateStore`, por isso os dois
arquivos são propositalmente parecidos (e têm a **mesma limitação**: memória, uma
instância só).

`/lti/sessao` **não** usa o limite de 5/min das rotas de credencial: um UUID v4
consumido na primeira troca não tem o que ser adivinhado por força bruta, e
apertar ali penalizaria um laboratório inteiro atrás do mesmo IP — onde *todo*
launch legítimo passa por essa rota.

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
| `POST /lti/sessao` | — | Troca o `code` do redirect pelo token do aluno (ver abaixo) |
| `GET/POST /admins` · `POST /admins/:id/resetar-senha` · `PATCH /admins/:id/ativo` | admin | Gestão de administradores |
| `POST /importacao/alunos` · `/importacao/turmas` · `GET /importacao` | admin | CSVs + auditoria |
| `GET /alunos` · `/alunos/cursos` · `/alunos/:id` | admin | Pesquisa os vínculos importados (só leitura) |
| `GET /turmas` · `/turmas/:id` | admin | Pesquisa as turmas/disciplinas do CSV (só leitura) |
| `GET /modalidades` · `GET/POST/PATCH/DELETE /polos` · `/salas` · `/faixas` · `/sala-faixas` | admin | Estrutura física e oferta de vagas |
| `GET /portal/periodo` · `/portal/disciplinas` · `/portal/faixas` | aluno | O que ele pode escolher |
| `GET/POST /portal/agendamentos` | aluno | Confirmar a prova e consultar o que já marcou |
| `GET/POST /periodos` · `GET/PATCH /periodos/:id` | admin | Abrir/fechar a janela de agendamento |
| `GET /agendamentos` · `/resumo` · `/exportacao` · `/:id` | admin | Relatório: consulta, ocupação por sala e o CSV de **todos os alunos** |
| `GET /relatorios/grupos-d2l` · `/zip` · `/:faixaId` | admin | Grupos do Brightspace: um CSV de matrículas **por faixa** |
| `PATCH /agendamentos/:id/remanejar` · `DELETE /agendamentos/:id` | admin | Mover de sala/horário e cancelar |
| `POST /agendamentos/compulsorio` · `GET /:id` · `/:id/relatorio` | admin | Agenda por quem não agendou; acompanha o lote e baixa o CSV de exceções |
| `PATCH /portal/agendamentos/:id` · `DELETE` | aluno | Trocar de horário (atômico) e cancelar |
| `GET /agendamentos/:id/historico` | admin | Quem alterou: aluno ou administrador |
| `GET /d2l/callback` | — | Callback OAuth da Valence: troca o `code` e grava o refresh token |

Pendente: special access no quiz (adiado pelo cliente). OAuth e leitura de
matrículas existem — ver "Disciplinas do aluno: launch ou enrollments".

## Cadastro: polos, salas e os 2 CSVs

**Polos — via SEED, não CSV.** Os polos são populados por `prisma/seed-polos.ts`
(nomes extraídos da coluna CAMPUS do CSV de alunos, exatamente como aparecem). O
`Polo.nome` é único e serve de chave de casamento. Adicionar polo novo = inserir
linha, não migration. A importação **nunca cria polo**: ela só faz lookup por
nome, e CAMPUS sem polo cadastrado **rejeita a linha do aluno** (o vínculo não
entra no banco), reportando em `polosNaoEncontrados[]`.

### Campus que sai da oferta: DESATIVA, não apaga

`Polo.ativo` é a trava do ciclo "este campus não tem mais prova". Um polo inativo
**não aceita sala nem faixa nova** (409 em `POST /salas` e `POST /faixas`) — e é
só isso que ele faz. Sem faixa nova, ninguém agenda ali, e o compulsório reporta
esses alunos como `SEM_FAIXA_NO_POLO`, que é a linha que a secretaria precisa ver.

**A trava é do lado administrativo de propósito.** Nada no portal do aluno
consulta `Polo.ativo`: desativar um campus no meio do semestre não pode esconder
a prova de quem já agendou. Mesma lógica da regra 7 — fechar tranca a *escolha*,
nunca a *consulta*. A importação também segue casando alunos com polo inativo:
rejeitá-los faria sumir dos relatórios gente que ainda existe.

**`POST /polos` com nome de polo INATIVO reativa, com o mesmo id** — em vez de
409. É como o campus volta na oferta seguinte, sem perder salas, faixas passadas
nem alunos. Sem isso o admin ficaria travado: o nome está ocupado por um polo que
ele não vê na tela, e renomear não é permitido. Só nome de polo **ativo** conflita.

**`DELETE /polos/:id` só apaga polo VIRGEM** — sem sala, sem faixa e sem aluno.
Ele existe para desfazer cadastro errado (nome com acento trocado), que ficaria
no banco para sempre porque `nome` não é editável. Polo com histórico responde
409 com as contagens: apagá-lo arrastaria junto as faixas que sustentam
agendamentos já realizados, e a prova sumiria do relatório.

**Salas — CADASTRO MANUAL.** O admin cadastra sala (nome + capacidade) e escolhe o
polo num dropdown populado pelos polos do seed. Import de salas por CSV existe só
como opção alternativa secundária; o padrão é manual.

**Os 2 CSVs (upload pelo admin):**

| CSV | Colunas reais → uso | Observações |
|---|---|---|
| **Alunos** | RA→matrícula · ALUNO→nome · EMAIL INSTITUCIONAL→email · CURSO→curso (só exibição) · STATUS CURSO→ativo · CAMPUS→polo | Modalidade vem do **dropdown no upload** (aba EaD/Semi/Híbrido), não de coluna. RA é alfanumérico (String). Encoding real: ISO-8859-1. |
| **Turmas** | Código da Turma · Disciplina / Código EAD (a coluna `Curso`, se vier, é **ignorada**) | filtro final de disciplinas com prova. Separado por `;` (Excel pt-BR). A 2ª coluna traz **nome e código da disciplina na mesma célula** — separados na leitura. |

**Regras dos campos de aluno:**
- **STATUS CURSO**: importa **todos** os alunos, guardando o valor bruto em
  `statusCurso` e derivando `ativo` (= "pode agendar") de uma **lista explícita**
  — `src/enums/status-curso.enum.ts`, ponto único de alteração:

  | Permitem agendar | Bloqueiam |
  |---|---|
  | Ativo | Desistente · Trancado · Cancelado · Formado · Transf. Interna · Transf. de Curriculo · Alter. de Habilitação |

  **Regra vigente (11/08/2026): só "Ativo" agenda.** Isto **reverte** a decisão
  de 31/07/2026, que tratava as situações de transição como aptas. As grafias de
  transição continuam listadas (do lado que bloqueia) de propósito: são valores
  reais dos arquivos, e sinalizá-las como "desconhecidas" pediria a cada
  importação uma decisão que já foi tomada.
  Status fora das duas listas **bloqueia** e é reportado na importação, para que
  alguém decida em qual lista ele entra. A comparação ignora acento e caixa.

  ⚠️ **Mudar a lista não reclassifica quem já está no banco.** `ativo` é derivado
  na importação e **gravado**, e é a coluna que o agendamento consulta
  (`exigirVinculo`). Como `statusCurso` fica cru, dá para reclassificar sem
  reimportar: `npm run alunos:recalcular` (simula; `-- --gravar` aplica). Ele
  também aponta quem perde a elegibilidade **com prova já marcada** — e não
  cancela nada, porque cancelar em massa é decisão de negócio.
- **CURSO**: puramente informativo, exibido para o aluno. Não entra em filtro/alocação.
- **CAMPUS→polo**: casa com `Polo.nome` por string exata (mesma origem do seed).

Todo upload registra auditoria (`ImportacaoCsv`: tipo, arquivo, linhas, quem, quando).
Importação **idempotente**: upsert por `[matricula, curso]` (alunos) e
`[codigoTurma, nomeDisciplina]` (turmas). Re-subir o mesmo arquivo atualiza,
nunca duplica.

**Endpoints** (todos exigem JWT de admin):
- `POST /api/importacao/alunos` — multipart: `arquivo` (.csv) + `modalidade`
  (`EAD|SEMI|MODULAR|PRESENCIAL`, o dropdown da aba de origem)
- `POST /api/importacao/turmas` — multipart: `arquivo`
- `GET /api/importacao` — histórico de auditoria

**Consultar o que entrou** (também só com JWT de admin):

- `GET /api/alunos` — pesquisa os **vínculos** (aluno + curso), paginada.
  `busca` casa com matrícula, nome, e-mail **ou** curso ao mesmo tempo; filtros
  por `poloId`, `modalidadeId`, `curso`, `ativo`, `importacaoId` e `agendado`.
- `GET /api/alunos/cursos` · `GET /api/alunos/:id` — dropdown do filtro e a tela
  de atendimento (origem do registro, **outros vínculos do mesmo RA** e as provas
  marcadas, canceladas inclusive).
- `GET /api/turmas` · `GET /api/turmas/:id` — o catálogo do que tem prova.
  `busca` casa com código da turma, nome da disciplina, código EAD ou
  `orgUnitId`; `comOrgUnitId=false` isola o que nenhum launch alcançou ainda.

**São só leitura, de propósito.** A planilha é a fonte de verdade: um aluno
editado ou criado pela API seria sobrescrito/ignorado no próximo upload sem
ninguém perceber. Correção se faz no CSV e reimporta — que é idempotente.

**Os filtros são lidos à mão, sem DTO** (como no relatório de agendamentos): com
`forbidNonWhitelisted`, um parâmetro a mais na URL derrubaria a requisição, e URL
de busca é coisa que se cola, edita e compartilha.

Dois detalhes que a tela não deve traduzir errado: `ativo` significa **pode
agendar** (derivado de `statusCurso`, não igual a `STATUS CURSO == "Ativo"`), e
`totalAgendamentos` de uma turma vem **null, não zero**, enquanto o `orgUnitId`
não tiver sido aprendido — sem ele não há como contar, e "0" faria parecer que
ninguém marcou.

**Linha rejeitada não interrompe a importação.** O resto entra e a resposta traz
`rejeitadas[]` (nº da linha, RA, **nome, curso, campus** e motivo — quem corrige
a planilha procura pelo aluno, e a linha rejeitada pode ser justamente a do RA
vazio; o front lista tudo e exporta em CSV), `statusDesconhecidos[]` e
`polosNaoEncontrados[]`. Nada é descartado em silêncio — mas nada é inventado
também: sem CAMPUS não há como definir o polo, e polo é obrigatório para alocar
sala. O admin corrige a planilha e reenvia.

**A importação nunca apaga.** Quem não está no arquivo não é tocado — para
incluir uma pessoa, basta um CSV com a linha dela.

⚠️ **`alteracoesComAgendamento[]`: troca de modalidade ou polo em quem já tem
prova marcada.** São os dois campos que a importação muda **por baixo de uma
reserva confirmada** sem que nada mais reclame — a modalidade vem do dropdown e
sobrescreve todas as linhas do arquivo; o polo segue a coluna CAMPUS. A reserva
continua na sala antiga (outra duração, ou outro campus), e o sintoma aparece
depois e disfarçado: **o remanejo passa a ser recusado** com "esta sala não é da
modalidade do aluno". Por isso a importação passou a reportar essas linhas
(`importacao-alunos.service.ts` → `avisarSeMexeEmProvaMarcada`), com `de`/`para`
em nomes, e a logar em WARN.

Duas escolhas conscientes ali: **avisa e não bloqueia** (a planilha é a fonte de
verdade e pode estar corrigindo um cadastro errado — quem decide entre remanejar
e cancelar é a secretaria), e conta **só o semestre vigente** (prova de semestre
passado já aconteceu; avisar sobre ela seria o ruído que ensina o time a ignorar
o aviso).

**Encoding é detectado, não presumido**: latin1 (arquivos atuais) ou UTF-8/BOM
(se a planilha for reexportada). Ler errado quebraria o casamento do polo por nome.

**Turmas vazias = comportamento seguro.** Enquanto não houver turmas importadas, o
default é **bloquear agendamento** (não liberar prova para disciplina errada),
controlado por um flag claro e invertível (`TURMAS_FILTER_ENABLED`, default `true`).

### O cruzamento é por CÓDIGO DA TURMA + CÓDIGO DA DISCIPLINA

**O CSV não traz orgUnitId** e descobri-lo exigiria consultar o Brightspace. Mas
o `Code` da oferta nesta instância é **composto** e carrega os dois códigos que
a planilha tem:

```
GSPS02_GSPS02EAD003_GSPS0I10227_2026/1
       └─ disciplina  └─ turma
```

E o código da turma **se repete**: HISTÓRIA, DANÇA e LUTAS rodam todas sob
`GSPS0I10227`. O que as separa é o código da disciplina — aquele que vem entre
parênteses na 3ª coluna do CSV. Por isso **o par identifica a oferta sem depender
do nome**, e é o primeiro critério, não o último.

Regra e desempate em `src/turma/service/turma-match.ts`, portada de
`../brightspace-orgunits` (`src/matching.js` + `src/normalize.js`), que já
resolve isto contra a instância real da UCB.

**De onde vem o `Code` do nosso lado — e a armadilha:**

| Fonte | O que chega |
|---|---|
| enrollments (`D2L_HABILITADO=true`) | `OrgUnit.Code` — o **composto inteiro** |
| launch LTI | `context.label`, que **vem vazio neste tenant**; o código sai do fim do título (`extrairCodigoDoTitulo`), já simples |

⚠️ **Comparar o código por igualdade quebra os enrollments.** `GSPS0I10227` nunca
seria igual a `GSPS02_GSPS02EAD003_GSPS0I10227_2026/1`, e a consulta voltaria
vazia **sem erro nenhum** — toda disciplina viraria "não tem prova". Por isso
`codigosParaBuscar` devolve o código **inteiro E cada token**: o inteiro é o que
casa com um `codigoTurma` que tenha hífen (`ADM-0142`, que tokenizado viraria
duas palavras); os tokens são o que casa com o composto. Nenhum cobre o caso do
outro. Há teste para os dois.

E a comparação de token é **por token, nunca por substring**: `GSPS02` existe
dentro de `GSPS02EAD003`, e por substring o prefixo do curso passaria por código
de disciplina.

**Os tiers, na ordem** (o primeiro que produzir exatamente uma vence):

| # | Estratégia | Quando decide |
|--:|---|---|
| 0 | `codigo-composto` | o `Code` contém o código da turma **e** o da disciplina |
| 1 | `codigo` | uma turma só com aquele código |
| 2 | `codigo-e-nome` | desempate por nome dentro do mesmo código |
| 3 | `nome-exato` | sem código, ou código sem match |
| 4 | `nome-parcial` | um nome contém o outro; só a partir de 6 caracteres |

Zero acertos no tier 0 **não é falha**: significa que o `Code` não é composto ou
que a disciplina não bate, e a decisão segue para os tiers seguintes. É o que
garante que ele nunca piore o que já funcionava.

**Nada é chutado.** Código sem nome compatível (`DIVERGENTE`) ou empate entre
candidatas (`AMBIGUA`) **não liberam nada**, e o motivo vai para o log. Chutar
aqui significaria marcar prova para a disciplina errada — erro que só apareceria
no dia.

**O prefixo numérico do código da disciplina sai na leitura.** `(1-GSPS02EAD003)`
vira `GSPS02EAD003`: o `1-` é do sistema de origem e não aparece no `Code`, então
mantê-lo faria o token nunca casar. O código só é guardado se **parecer** código
(letra e número, sem espaço) e se **diferir** do código da turma — `(TURMA A)`,
`(2026)` e `Nome (CODIGO_DA_PROPRIA_TURMA)` deixam o nome intacto.

**O orgUnitId é aprendido de graça.** Todo launch entrega o `context.id` da turma
de onde o aluno clicou; quando o cruzamento fecha e a linha ainda não tem
orgUnitId, ele é gravado (nunca sobrescrito). Ao longo do período de agendamento
a tabela se completa sozinha, e o id vira mais um caminho de busca.

### ⚠️ Turma NÃO pertence a um curso (decisão de 10/08/2026)

Uma turma tem alunos de **vários** cursos — disciplina compartilhada, eletiva,
equivalência. Rotulá-la com um curso é falso, e o filtro que existia chegava a
**descartar disciplina válida** de quem cursava uma oferta de outro curso.

Por isso `TurmaImportada.curso` foi removido, junto com o `doVinculo` do
`DisciplinasDoAlunoService`. Uma coluna `Curso` no arquivo é lida e ignorada.

**O preço, aceito conscientemente.** Quem tem dois vínculos **na mesma
matrícula** recebe, pelos enrollments, as disciplinas dos dois cursos juntas — e
as durações de prova são diferentes. Medido na base real:

```
RAs distintos ............... 7519
com mais de um vínculo ...... 2   (0,03%)
  → mesma modalidade ........ 0
  → modalidades diferentes .. 2   ← os únicos afetados

  UC24424289  [EAD/PEDAGOGIA, MODULAR/PSICOLOGIA]
  UC25426277  [MODULAR/ENFERMAGEM, SEMI/FARMÁCIA]
```

Dois alunos. E **só aparece com `D2L_HABILITADO=true`**: pelo launch a disciplina
é a que o aluno clicou, e o problema não existe.

**Por que nenhum dos dois CSVs resolve.** A informação que falta é do par
**(aluno, turma)** — "esta pessoa cursa esta disciplina por qual vínculo" —, e
isso não é atributo da turma nem do aluno isoladamente. As saídas possíveis, se
um dia valer a pena: o aluno escolher na tela, a secretaria montar os dois
agendamentos pelo remanejo, ou uma tabela de exceção só para quem tem 2+
vínculos.

**Duas matrículas não bastam para escapar.** Os enrollments são buscados por
`userIdD2L`, não por matrícula (`ofertasDoPeriodo(aluno.userIdD2L, ...)`). Uma
pessoa com duas matrículas mas **uma conta só no Brightspace** continua recebendo
tudo misturado.

## Integração D2L

- **LTI 1.3**: entrada do aluno. ✅ **Implementado e validado contra um launch real.**
- **Valence API — OAuth + leitura de matrículas**: 🟡 implementado, desligado por
  padrão (`D2L_HABILITADO=false`). É o que descobre **todas** as disciplinas do
  aluno no semestre; ver "Disciplinas do aluno" abaixo.
- **Valence API — special access nos quizzes**: ⬜ **ADIADA (decisão de
  03/08/2026).** O sistema hoje só agenda e emite relatório; a liberação da prova
  fica para uma fase posterior. Não implemente nada de quiz/special access sem o
  cliente pedir.

### Disciplinas do aluno: launch ou enrollments

A fonte é decidida em **um arquivo só** (`disciplinas-do-aluno.service.ts`), e o
cruzamento com o CSV é o mesmo nos dois casos:

| `D2L_HABILITADO` | De onde vêm as turmas |
|---|---|
| `false` (default) | A turma de onde o aluno clicou (claim `context` do LTI) — uma só |
| `true` | Todas as ofertas dele no período letivo cadastrado, via `enrollments/users/{id}/orgUnits/` |

**O semestre é o que o admin cadastrou**, não "o atual" segundo o relógio:
`PeriodoAgendamento.periodoLetivoId` é o org unit do Período Letivo (tipo **103**
neste tenant, não o Semester padrão 5). O filtro é a interseção com
`orgstructure/{id}/descendants/` — sem ele viriam também os semestres passados.
Essa árvore fica em cache de 10 min por período: é igual para todos os alunos, e
virar o semestre já é outra chave.

**Normalize os ids para string.** O `OrgUnit.Id` vem número nos enrollments e
`Identifier` string nos descendentes; comparar sem normalizar dá interseção vazia
**sem erro nenhum** (§4.3 da referência). Há teste que trava isso.

**`TURMAS_FILTER_ENABLED=false` ficou muito mais perigoso.** Com a turma clicada,
desligar o filtro liberava uma disciplina; com os enrollments, libera o semestre
inteiro do aluno — o CSV de turmas é justamente quem diz quais turmas têm prova.
O serviço loga um aviso quando as duas coisas estão ligadas ao mesmo tempo.

**A lista NÃO é separada por vínculo.** Os enrollments vêm pelo RA e chegam
misturados para quem tem dois cursos — e nada os separa, porque turma não
pertence a um curso. Ver "Turma NÃO pertence a um curso".

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
  admin/       ✅   importacao/ ✅ (2 CSVs)
  aluno/       ✅ vínculos do launch (aluno.service) + consulta do admin (aluno-admin)
  turma/       ✅ filtro do que tem prova (turma.service) + consulta do admin (turma-admin)
  config/      ✅ env.validation.ts · swagger.ts · helmet.config.ts · throttler.config.ts
  seguranca/   ✅ auditoria (log de eventos) · filtro global de excecoes
  database/    ✅ prisma.service.ts · mariadb-adapter.ts · prisma.module.ts
  enums/       ✅ perfil.enum.ts · status-curso.enum.ts
  dto/         ✅ respostas de rotas fora de módulo (health)
  generated/   ✅ client do Prisma — NÃO versionado, não editar

  modalidade/  ✅  polo/  ✅  sala/  ✅  faixa/  ✅  sala-faixa/  ✅
  agendamento/ ✅ portal do aluno · alocacao.ts (pura) · disciplinas-do-aluno.service.ts
  periodo/     ✅ CRUD do admin + leitura usada pelo portal
  relatorio/   ✅ grupos do Brightspace por faixa (csv-grupos-d2l.ts + zip)
  d2l/         🟡 autorização OAuth + leitura de matrículas (d2l-enrollments).
               Special access continua adiado — não criar sem pedido.

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

# seeds idempotentes: modalidades + polos + 1º admin
npm run seed                 # lê SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD do .env

# LTI
npm run lti:keygen           # gera a chave RSA da ferramenta (LTI_TOOL_PRIVATE_KEY)

# token de aluno para testar o portal sem o Brightspace (recusa em producao)
npm run token:aluno -- <RA> [orgUnitId]

# reclassifica `ativo` a partir do statusCurso gravado — rode depois de mexer
# em status-curso.enum.ts. Sem `--gravar` e simulacao.
npm run alunos:recalcular
npm run alunos:recalcular -- --gravar

# access token da Valence a partir do refresh gravado (recusa em producao).
# Usa o D2lOauthService, entao a ROTACAO do refresh e persistida — nunca fale
# com o token endpoint por fora, ou o refresh do banco vira lixo.
npm run d2l:token

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

**A ordem das migrations é o NOME DA PASTA, não a data de criação.** Num banco
vazio o Prisma aplica em ordem alfabética; num banco que já as tem, o
`_prisma_migrations` guarda a ordem real e esconde o problema. Foi o caso do
`init`, que tinha timestamp posterior ao `aluno_por_vinculo` — nunca falhou em
dev e teria falhado no primeiro `migrate deploy` em produção.

**Renomear migration já aplicada = três passos, juntos:** renomear a pasta,
atualizar `migration_name` em `_prisma_migrations` de todo banco, e **reconstruir
toda imagem Docker** (a imagem carrega os nomes antigos). Pular o terceiro gera
`P3009` — aconteceu em 04/08/2026. Receita de recuperação no README.

**Depois de mexer em código ou migration, sempre `docker compose up -d --build app`.**
Sem `--build` o compose reusa a imagem antiga em silêncio: a API responde, só que
velha. E o serviço tem `restart: unless-stopped` na porta 3000 — ele volta sozinho
e disputa a porta com o `npm run start:dev`.

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

**Apagar vs. desativar:** só se apaga o que nunca foi usado. Polo com sala/faixa/
aluno, sala já ofertada, faixa com agendamento e oferta com aluno alocado
respondem 409 sugerindo `ativo=false` — o histórico de quem já tem prova marcada
precisa sobreviver. Reduzir `vagas` abaixo dos agendamentos existentes também é
409. No caso do polo, desativar tem efeito próprio (não recebe sala nem faixa
nova) e `POST /polos` com o mesmo nome reativa — ver "Campus que sai da oferta".

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
| Nenhuma disciplina com prova | 403 com o motivo do cruzamento (turma divergente, semestre sem disciplina, nada do curso escolhido) |
| Faixa de outro polo | 403 |
| Faixa inativa ou com data passada | 409 |
| Já tem prova marcada para o vínculo | 409 |
| Vagas esgotadas | 409 |
| `alunoId` que não está no token | 403 + auditoria |

**Fonte das disciplinas é uma costura de um arquivo só**
(`disciplinas-do-aluno.service.ts`): a turma clicada (claim `context`, que vai no
JWT) ou os enrollments da Valence, conforme `D2L_HABILITADO`. A regra completa —
período letivo, atribuição por curso, armadilhas — está em "Disciplinas do aluno:
launch ou enrollments", na seção de integração D2L.

**A fila do D2L nasce na mesma transação** do agendamento: um agendamento gravado
sem sua fila seria prova marcada que nunca é liberada no Brightspace, e ninguém
descobriria até o aluno tentar abrir o quiz.

**O histórico é tabela, não log de arquivo.** `AuditoriaService` continua
gravando o evento na saída do processo, mas quem precisa da resposta é a
secretaria, na tela, com o aluno na frente — log que só o time de infra consegue
ler não resolve atendimento. Por isso `HistoricoAgendamento` guarda `autor` como
**fotografia** (matrícula ou e-mail, não FK: precisa continuar legível se a conta
do admin for desativada) e `de`/`para` como **texto pronto**
("M114 · 20/08/2026 08:30-11:30"), porque ids soltos exigiriam reconstruir o
passado para virar frase.

**Sair de um horário devolve a vaga na hora.** Cancelar vira `CANCELADO`, nunca
apaga — quem aparecer no dia sem estar na lista precisa ser explicável. Toda
contagem filtra `CONFIRMADO`, então a vaga volta sozinha.

**Trocar é atômico, e por isso existe separado de "cancelar e marcar de novo".**
Se o aluno cancelasse primeiro, poderia perder a vaga que tinha e descobrir que a
nova lotou no meio do caminho — ficando sem nenhuma. O lock reaproveitado está em
`agendamento/service/lock-de-vagas.ts`, compartilhado por agendar, trocar e
remanejar: se fossem três implementações, uma delas acabaria sem o `FOR UPDATE`.

**Sem período cadastrado = fechado.** Mesma escolha do filtro de turmas: na
dúvida, não libera. Para testar antes do CRUD administrativo (etapa 7), crie a
linha em `PeriodoAgendamento` pelo `npm run prisma:studio`.

**Token de aluno para teste:** `npm run token:aluno -- <RA> [orgUnitId]`
monta o mesmo payload do launch lendo os vínculos do banco, pulando só a
assinatura do Brightspace. **Recusa rodar com `NODE_ENV=production`.**

## A exportação em CSV é de ALUNOS, não de agendamentos

`GET /agendamentos/exportacao` não é a tela virada arquivo. Ele responde **com
quem a secretaria precisa falar**: a base são os **vínculos importados, todos
eles**, e o agendamento entra como coluna. Quem não marcou sai com as colunas da
prova vazias e `Status = Não Agendado`.

Colunas, e só estas: `Matricula · Aluno · E-mail · Curso · Modalidade · Polo ·
Data da prova · Inicio · Fim · Sala · Status · Agendado em`.

- **`Status` tem dois valores, `Agendado` e `Não Agendado`** — não o enum do
  banco. Quem for cobrar filtra a coluna no Excel; `CANCELADO` obrigaria a
  secretaria a saber que cancelado também significa "precisa agendar".
- **Cancelado conta como `Não Agendado`** e, por isso, o filtro `status` da URL
  **não se aplica** aqui: a coluna é derivada.
- **O recorte é um período letivo** (`periodoLetivoId` ou o vigente). Sem ele,
  prova do semestre passado faria o aluno parecer agendado.
- `faixaId`/`salaId`/`de`/`ate` são filtros da **prova** e restringem o arquivo a
  quem tem prova ali; `poloId`/`modalidadeId`/`busca` filtram o **aluno** e
  continuam trazendo quem não agendou.

Não "otimize" isso de volta para uma consulta em `agendamento`: o arquivo
deixaria de listar exatamente as pessoas para as quais ele existe.

## ⚠️ São DOIS CSVs, com formatos OPOSTOS

Confundir os dois é o erro fácil desta parte do sistema. Eles têm público,
conteúdo e bytes diferentes:

| | `GET /agendamentos/exportacao` | `GET /relatorios/grupos-d2l/:faixaId` |
|---|---|---|
| Quem lê | **Pessoa**, no Excel pt-BR | **Máquina**: o *Groups Import* do Brightspace |
| Responde | "com quem a secretaria precisa falar" | "quem entra no grupo desta prova" |
| Base | Todos os vínculos, agendados ou não | Só quem tem prova **confirmada** |
| Colunas | 12 | 2 (`Nome de usuário`, `Código do Grupo` **vazia**) |
| Separador | `;` | `,` |
| BOM UTF-8 | **sim** | **não** |
| Recorte | um período letivo | uma **faixa** + um período letivo |

Trocar o separador ou o BOM quebra em silêncio nos dois sentidos: com `;` o D2L
lê a linha inteira como um campo só; com BOM, os três bytes grudam no cabeçalho e
`Nome de usuário` deixa de casar com a coluna esperada; e o CSV da secretaria sem
BOM chega no Excel como "CÃ¢mpus".

Por isso `montarCsv()` (`agendamento/service/csv-relatorio.ts`) recebe
`{ separador, bom }`, **com default no formato do Excel** — quem não passa nada
continua produzindo o arquivo da secretaria. O formato do D2L está declarado num
lugar só, `relatorio/service/csv-grupos-d2l.ts`.

## Grupos do Brightspace: um arquivo por FAIXA

`GET /relatorios/grupos-d2l` lista as faixas do recorte com quantos alunos cada
uma tem; `/:faixaId` baixa o CSV de uma; `/zip` baixa todas de uma vez. É a aba
**Relatorios** do painel.

- **O recorte é a FAIXA, não a sala.** O grupo no D2L existe para liberar o quiz
  num horário; em qual sala a pessoa senta não muda o acesso. As salas da faixa
  entram na mesma lista.
- **Uma matrícula aparece UMA vez.** Um RA com dois vínculos na mesma modalidade
  pode ter dois agendamentos na mesma faixa — o grupo é por *usuário*, e a linha
  repetida faria o import reclamar ou duplicar. A contagem de `totalAlunos` é de
  matrículas **distintas**, para bater com o número de linhas do arquivo.
- **Nome do arquivo: `20-08-2026 08h30-11h30.csv`** — dia e horário, sem polo e
  sem sala (decisão do cliente). `/` e `:` são inválidos em nome de arquivo, daí
  o `-` e o `h`; e ficar em ASCII puro dispensa o `filename*=UTF-8''` do RFC 5987
  no `Content-Disposition`.
- **Sem o polo no nome, a colisão é o caso normal**: duas faixas do mesmo dia e
  horário em polos diferentes geram o mesmo nome. Dentro do zip, a partir da
  segunda o id da faixa entra como desempate (`... #14.csv`) — sem isso a segunda
  sobrescreveria a primeira em silêncio.
- **Faixa vazia aparece na listagem** (com `0`, a informação é útil na tela) mas
  **fica fora do zip**: arquivo só de cabeçalho não importa nada.

O front usa o `nomeArquivo` que vem do backend: resposta em blob não expõe o
`Content-Disposition`, e montar o nome no cliente deixaria a regra em dois
lugares.

## Agendamento compulsório (etapa 9)

Fechado o prazo, **quem não agendou não fica sem prova**: a secretaria dispara um
lote que aloca todo mundo automaticamente. `POST /agendamentos/compulsorio`,
acompanhado por `GET /agendamentos/compulsorio/:id`.

**As duas dimensões de preenchimento**, nesta ordem: as **datas** da mais próxima
para a mais distante (`ordenarPorProximidade`, em `alocacao.ts`) e, dentro de cada
faixa, as **salas** por `ordem` até lotar (`escolherOferta`, o mesmo do portal).
Concentrar em vez de espalhar é a regra nas duas — espalhar 7 mil alunos por todas
as datas manteria o campus mobilizado o período inteiro, com fiscal em sala vazia.

**Quem entra** (decisão do cliente, 12/08/2026): vínculo `ativo` sem agendamento
`CONFIRMADO` no período letivo. Fica de fora quem **cancelou e não remarcou** —
mas aparece no relatório como `CANCELOU_E_NAO_REMARCOU`, porque ficar sem lugar
nenhum é decisão que a secretaria precisa ver aluno por aluno.

**Depois do compulsório o aluno não troca mais nada**; só o admin remaneja. É a
trava que já existia (o portal exige período aberto), não uma nova.

**Como o aluno descobre:** entrando pelo link LTI e vendo a prova marcada. Não há
envio de e-mail no sistema.

### O `userIdD2L` de quem nunca entrou

O compulsório só é possível porque `identidadePorMatricula` (em
`d2l-enrollments.service.ts`) resolve o RA para o UserId do Brightspace via
`users/?orgDefinedId=` — o `userIdD2L` **só existe em `Agendamento`**, gravado a
partir do launch, então quem nunca clicou não tem nenhum id guardado.

Detalhes que custaram investigação:

- **O escopo `users:userdata:read` não é necessário**: o `core:*:*` que já temos
  cobre a rota. Verificado contra o `ava.catolica.edu.br`.
- **404 ali é estado ESPERADO** (matrícula sem conta no LMS), não falha. É o único
  ponto que usa o `nuloEm404` do `pedir()`; todo o resto continua tratando 404
  como id errado no cadastro.
- **O filtro do tenant é por igualdade, não por prefixo** — mas a comparação é
  refeita no nosso lado. Se uma versão futura da API casar por prefixo, o efeito
  seria alocar a prova de uma pessoa para outra, em silêncio.
- **Nada é chutado**: duas contas com a mesma matrícula (`AMBIGUA`) ou UserId não
  numérico (`ID_INVALIDO`) não escolhem ninguém — viram linha de relatório.

### Simulação é o padrão, e não é opcional na prática

`simulacao: true` percorre a alocação inteira **contando as vagas em memória** e
não grava nada. É a única forma honesta de responder "cabe todo mundo?": descobrir
no meio de uma execução real que não cabia deixaria metade alocada e metade não.

⚠️ A contagem simulada **muta o mapa de ocupação de propósito** — é ele que
carrega, de um aluno para o próximo, a vaga recém-tomada. Trabalhar sobre uma
cópia faz todos caberem na primeira sala, e a simulação passa a responder "cabe
todo mundo" justamente quando não cabe. Foi um bug real; há teste que o trava
(`ocuparVagaSimulada`, em `alocacao.spec.ts`).

### Por que duas fases, e por que a segunda é sequencial

| Fase | O quê | Como |
|---|---|---|
| 1 | Identidade + disciplinas de cada aluno | rede, **6 em paralelo**, ~1,5s cada |
| 2 | A alocação | banco, **sequencial**, ~5ms cada |

Alocar em paralelo, conforme cada chamada de rede volta, faria a ordem depender da
latência da Valence: duas execuções com os mesmos dados dariam salas diferentes, e
a simulação deixaria de prever a execução. A fase 2 é ordenada por
`(polo, modalidade, matrícula)` — determinística por construção.

Medido na base real: ~0,76s para achar o usuário + ~0,75s para ler as matrículas.
Para 7.226 ativos, ~25 min com concorrência 6.

**Falha de um aluno nunca derruba o lote.** `resolverUm` classifica em vez de
lançar — se um aluno sem conta virasse exceção, o `Promise.all` da fatia levaria
junto os outros cinco.

### O lote é uma tabela, não uma resposta

`ExecucaoCompulsorio` + `ExcecaoCompulsorio`. Três motivos: a requisição não fica
aberta 25 minutos; "faltaram 130 vagas em Taguatinga/EaD" é o que faz abrir sala e
não pode sumir num F5; e é o registro de que o compulsório aconteceu, com quem
mandou.

`atualizadoEm` é batido a cada fatia — é o que distingue **lote lento de lote
morto**. Sem isso um restart deixaria `EM_ANDAMENTO` para sempre e bloquearia todo
lote seguinte. Silêncio de mais de 5 min vira `FALHOU`, e a consulta devolve
`interrompida: true`.

**Rodar de novo retoma de onde parou**, sem duplicar: quem já tem prova confirmada
não entra na lista, e a transação reconfere isso sob lock (o aluno pode ter
agendado pelo portal no meio do lote).

### Os motivos do relatório são a fila de trabalho da secretaria

Cada um pede uma ação diferente, e é por isso que o CSV sai ordenado por motivo:

| Motivo | O que fazer |
|---|---|
| `SEM_VAGA` | abrir mais uma sala ou mais uma data |
| `SEM_FAIXA_NO_POLO` | o polo não tem faixa cadastrada |
| `SEM_CONTA_D2L` | chamado no suporte do LMS |
| `MATRICULA_AMBIGUA` | duas contas com o mesmo RA no Brightspace |
| `ID_INVALIDO_D2L` | UserId não numérico no cadastro do LMS |
| `SEM_DISCIPLINA_AGENDAVEL` | conferir o CSV de turmas (o detalhe traz o `Code` que não casou) |
| `CANCELOU_E_NAO_REMARCOU` | decidir caso a caso: ficou sem lugar |
| `FALHA_NA_INTEGRACAO` | reprocessável — foi rede/timeout naquele aluno |
| `AVISO_CONTA_INATIVA_D2L` | **foi alocado**, mas a conta está desativada no LMS |

O último é o único que convive com uma alocação: a pessoa tem lugar na sala e não
conseguiria abrir a prova. Existe porque apareceu na base real — aluno `ativo` no
nosso CSV e `IsActive: false` no Brightspace.

O CSV é do formato da **secretaria** (`;` + BOM UTF-8), não do D2L. Ver "São DOIS
CSVs, com formatos OPOSTOS".

## Ao implementar, priorize nesta ordem

1. ✅ Prisma schema + migrations + Docker + seed do admin.
2. ✅ Auth (admin JWT + LTI aluno).
3. ✅ Importação dos 2 CSVs (alunos, turmas) + seed de polos.
4. ✅ Estrutura (polo/sala/faixa/sala-faixa).
5. ✅ Portal do aluno (listar faixas + agendar com alocação sequencial).
6. ✅ Período de agendamento + relatório (consulta, ocupação por sala, CSV).
7. ✅ Remanejo administrativo + cancelamento/troca pelo aluno.
8. 🟡 Valence: OAuth + enrollments (todas as disciplinas do semestre) prontos e
   desligados por padrão. Special access no quiz — **adiado pelo cliente.**
9. ✅ Agendamento compulsório: o lote que agenda por quem não agendou, com
   simulação, acompanhamento e relatório de exceções. **Exige `D2L_HABILITADO`**
   — é a integração que sabe as disciplinas de quem nunca fez launch.

**Bloqueios externos:** nenhum aberto. O CSV real de turmas
(`Curso;Código da Turma;Disciplina / Código EAD`, `;`, UTF-8) é quem diz **quais
turmas têm prova**. Em 07/08/2026 o match passou a usar o **`Code` composto** do
Brightspace (código da turma + código da disciplina), portado do
`../brightspace-orgunits` — sem isso o caminho dos enrollments não achava turma
nenhuma. O special access continua adiado pelo cliente.

**Aceito conscientemente:** com `D2L_HABILITADO=true`, o aluno de dois vínculos
na mesma matrícula leva as disciplinas dos dois cursos em cada agendamento — são
2 em 7519. Ver "Turma NÃO pertence a um curso".
