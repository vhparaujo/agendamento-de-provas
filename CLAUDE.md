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
  (1h30) ou Presencial (2h). Define a duração da prova **e qual período letivo do
  Brightspace vale para o aluno** (ver *Mapa por modalidade*). **Uma por vínculo.**
  Abas do CSV: EaD→`EAD`, Semi→`SEMI`, **Híbrido→`MODULAR`** (são a mesma coisa).
- **Vínculo**: aluno + curso. É a unidade real do sistema — um mesmo RA pode ter
  dois vínculos (dois cursos, modalidades diferentes) e agenda uma prova para cada.
- **Faixa**: horário de prova que o admin abre para um polo (data + hora início +
  hora fim). **Também é neutra** — não tem modalidade fixa.
- **SalaFaixa** (NÚCLEO): associação `Sala + Faixa + Modalidade + vagas + ordem`.
  É AQUI que modalidade e vagas existem de fato. A mesma sala física pode ser
  Presencial numa faixa e EaD em outra; dentro de uma faixa fica travada numa
  modalidade. O admin monta isso ao criar a faixa.
- **Mapa por modalidade**: a UCB corre **duas grades ao mesmo tempo**.
  EaD/Semi/Modular andam por **módulo** (quatro por ano — 2026/1 a 2026/4);
  Presencial anda por **semestre** (dois — 2026/1 e 2026/2). São dois org units
  de Período Letivo **diferentes e vivos ao mesmo tempo** no Brightspace. Por
  isso uma janela não tem *um* `periodoLetivoId`, e sim um mapa
  `modalidade → periodoLetivoId` (`PeriodoLetivoModalidade`). O que continua
  único na janela é o PRAZO: datas, `rodada` e faixa de nota valem para todos.
- **Rodada**: QUAL prova do semestre é aquela — `"N2"` (regular), `"SUB"`
  (substitutiva), `"N1"`… Vive em `PeriodoAgendamento.rodada` e é copiada para
  `Agendamento.rodada` como fotografia. **A identidade de um período é o par
  `periodoLetivoId + rodada`**, nunca o `periodoLetivoId` sozinho: as duas provas
  do semestre têm o mesmo id de período letivo no Brightspace. Texto livre, não
  enum — quem nomeia a rodada é a secretaria. Default `"N2"`.
- **Turma real**: turma/disciplina que efetivamente terá prova (CSV de turmas). Filtro
  final do que aparece para o aluno.
- **Janela de prova**: o par (abertura, fechamento) que o questionário do
  Brightspace tem num dia, mais a hora em que o servidor o move para lá. Vive em
  `JanelaDeProva`, **uma linha por disparo, por modalidade** — o número de
  sessões cai da duração: EaD 3 de 3h, Semi/Modular 6 de 1h30, Presencial 5 de
  2h. Ver "Datas das provas".

## Regras de negócio que NÃO podem ser violadas

1. **Aluno não tem senha.** Ele é reconhecido via LTI 1.3; a matrícula do launch
   é cruzada com o CSV de alunos para obter modalidade + polo. Nunca confie em
   dados auto-declarados pelo cliente.
2. **O que o aluno vê** = faixas do polo dele, na modalidade dele, com vaga, com
   o período de agendamento aberto.
3. **Disciplinas agendáveis** = disciplinas do aluno na Valence ∩ turmas reais
   (CSV de turmas) ∩ período letivo vigente. **Não são todas as disciplinas do aluno.**
4. **Um agendamento cobre todas as disciplinas agendáveis de UM vínculo**
   (mesmo horário). Aluno com dois cursos faz dois agendamentos, um por curso.
   Quando o RA tem mais de um vínculo, o portal pergunta de qual curso é a prova
   (`precisaEscolherCurso` na resposta do launch).
4a. **UMA PROVA POR VÍNCULO EM CADA RODADA** — e não uma por semestre.
   A trava é `alunoId + periodoLetivoId + rodada` (`alocar`, em
   `agendamento.service.ts`, e `agendarPeloAdmin`). Antes da rodada ela era
   `alunoId + periodoLetivoId`, e por isso quem agendava a N2 batia em "você já
   tem prova marcada" ao tentar a **substitutiva**: as duas caem no MESMO
   `periodoLetivoId` do Brightspace, e o semestre não distinguia uma da outra.

   - **O que o aluno enxerga e mexe é a rodada VIGENTE**, do mesmo jeito que só
     enxerga o semestre vigente: `GET /portal/agendamentos` lista a prova da
     rodada aberta, e a da rodada anterior fica congelada (nem troca, nem
     declaração). Mostrar as duas juntas mandaria ele para a data errada.
   - **A rodada gravada no `Agendamento` é FOTOGRAFIA**, como `modalidadeId` e
     `poloId`: renomear a rodada da janela depois não remarca prova nenhuma.
   - Isto **convive** com a regra 4b, que é sobre a pessoa e ignora a rodada.
4b. **UMA PROVA POR PESSOA EM CADA HORÁRIO** (decisão do cliente, 14/08/2026).
   O RA com dois cursos faz duas provas, mas **não pode marcar as duas na mesma
   faixa**: são provas diferentes e ninguém faz as duas ao mesmo tempo. Antes
   disso ele ocupava duas cadeiras, aparecia duas vezes na lista de presença e
   só fazia uma das provas — a outra cadeira ficava vazia com o nome dele.

   - A regra é **`matrícula` + `faixa` + `periodoLetivoId`**, e vive num lugar
     só: `exigirUmaProvaPorFaixa` (`lock-de-vagas.ts`). As quatro portas passam
     por ela — agendar, trocar, **remanejar** (o admin também, por decisão do
     cliente) e o compulsório.
   - ⚠️ **Ela NÃO entra na `rodada`, de propósito.** Quem fez a N2 às 08:30 não
     faz a SUB às 08:30 também: são duas provas e ninguém está em dois lugares ao
     mesmo tempo. É a única consulta por prova que fica no `periodoLetivoId`
     inteiro — e `faixasBloqueadasParaOVinculo` (o `conflitaComOutraProva` do
     portal) espelha isso exatamente, senão a tela ofereceria o horário que a
     confirmação recusa.
   - **É a faixa, não a sobreposição de horário.** Duas faixas que se cruzam no
     relógio (09:00-12:00 e 10:00-11:30) continuam permitidas. Se isso virar
     problema, o lugar de mudar é aquela função, e só ela.
   - Ela **convive** com o limite por vínculo (`uma prova por curso no
     semestre`), que responde outra pergunta e continua valendo.
   - No portal, `GET /portal/faixas` devolve `conflitaComOutraProva` para que a
     tela explique em vez de deixar o aluno descobrir no clique de confirmar.
     É separado de `temVaga`: a vaga existe, quem não pode é o aluno.
   - No compulsório, o `ConflictException` é tratado como faixa cheia — **tenta
     a próxima data**. A simulação faz o mesmo em memória (`faixasDaPessoa` em
     `ocuparVagaSimulada`); sem isso ela prometeria um resultado que o lote não
     entrega.
5. **Alocação de sala é sequencial**: preenche a sala de menor `ordem` até lotar,
   só então usa a próxima. A vaga é da SalaFaixa (`count(agendamentos) < vagas`).
6. **Concorrência**: a checagem de vaga + criação do agendamento DEVE ocorrer na
   mesma transação, serializada por SalaFaixa. **Nunca conte fora da transação.**
   Implementado em `agendamento.service.ts` como `SELECT ... FOR UPDATE` (aluno,
   depois as ofertas da faixa+modalidade) sob **READ COMMITTED** — não
   `SERIALIZABLE`: em REPEATABLE READ o snapshot da transação pode ser anterior ao
   lock e a contagem viria velha, e SERIALIZABLE acrescentaria gap lock sem ganho.
   O `FOR UPDATE` é o que garante a exclusão mútua; há teste que prova (remover o
   lock faz 5 alunos entrarem na mesma vaga).

   ⚠️ **O primeiro lock é por `matrícula`, não por id do vínculo** (`travarAluno`,
   mudou em 14/08/2026 junto com a regra 4b). Um RA com dois cursos tem DUAS
   linhas em `aluno_importado`; travar só uma deixaria as duas transações
   correrem em paralelo, cada uma conferindo a regra 4b antes de a outra gravar,
   e as duas passando. A ordem continua `aluno → sala_faixa → agendamento`.
7. **Reagendamento tem dono, e fica registrado.**
   - **O ALUNO NÃO CANCELA** (17/08/2026). A troca de horário é a única alteração
     que ele faz na própria prova; `DELETE /portal/agendamentos/:id` **não existe
     mais**. Cancelar devolve a vaga e o deixa SEM prova — num período que está
     lotando, a vaga sai em segundos e quem só queria mudar de dia chega ao balcão
     sem horário nenhum, quando a troca resolvia o caso dele sem risco nenhum.
     Desmarcar é decisão da secretaria, em `DELETE /agendamentos/:id`, que grava o
     e-mail de quem cancelou. Tirar o botão da tela e deixar o endpoint de pé
     manteria a regra valendo em um lugar só — o teste
     `a rota de cancelamento do portal nao existe mais` trava isso.
   - **O aluno só troca com o período ABERTO.** Vale enquanto o prazo corre;
     depois disso, só a secretaria remaneja. É a mesma trava do agendamento
     inicial — a troca não pode ser uma porta para burlar o prazo.
   - **O aluno só enxerga e só mexe no período VIGENTE.** Provas de semestres
     anteriores não aparecem para ele nem podem ser alteradas. Sem isso, abrir o
     período novo daria a ele a chance de mexer numa prova que já fez.
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

**O launch que NÃO passa segue a mesma tabela.** Quem clica no link é um aluno
dentro do AVA, não um cliente de API: com `PORTAL_ALUNO_URL` preenchida, 400/401/
403/503 viram **303** para `{PORTAL_ALUNO_URL}?erro=<código>`, e o portal mostra
a tela explicando o caso (`RecadoEntrada.vue` + `erros-de-entrada.ts`, no front).
Sem ela, o JSON de erro continua de pé — os dois casos têm teste em
`test/auth.e2e-spec.ts`.

Os códigos são um vocabulário curto e fechado (`CodigoErroLaunch`, em
`lti.service.ts`): `sem-cadastro` (403), `sessao-invalida` (401),
`dados-incompletos` (400), `indisponivel` (503) e `falha` (o resto). **A URL não
carrega matrícula nem mensagem interna** — pelo mesmo motivo do token: ela vai
para histórico, log de proxy e `Referer`. O detalhe fica no log da aplicação, que
é onde `codigoDoErro` o escreve antes de traduzir; quem escreve o texto que o
aluno lê é o front.

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
**5/min** em login, refresh, troca de senha e callback OAuth do D2L
(`@Throttle(LIMITE_AUTENTICACAO)`); **60/min** no launch LTI (`LIMITE_LAUNCH`);
10 a cada 5min nos uploads (`LIMITE_UPLOAD`). Números em `src/config/throttler.config.ts`.

⚠️ O launch saiu dos 5/min em 26/08/2026, depois de o limite derrubar uma janela
inteira: ele não é rota de adivinhação de credencial (exige `id_token` assinado
pelo Brightspace) e alunos legítimos compartilham IP (NAT do câmpus). O motivo
completo está no comentário de `LIMITE_LAUNCH`. **O limite por IP só funciona com
`TRUST_PROXY` correto** — sem ele todo aluno chega com o IP do proxy e qualquer
número vira orçamento compartilhado pela instituição.
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
| `GET /health` | — | Status da API + banco + integração D2L (200 mesmo com banco fora) |
| `POST /auth/login` · `/auth/refresh` | — | Tokens do admin |
| `POST /auth/trocar-senha` · `GET /auth/me` | admin | Liberadas com senha provisória |
| `GET/POST /lti/login` · `POST /lti/launch` · `GET /lti/jwks` | — | Fluxo LTI (autentica pela assinatura do Brightspace) |
| `POST /lti/sessao` | — | Troca o `code` do redirect pelo token do aluno (ver abaixo) |
| `GET/POST /admins` · `POST /admins/:id/resetar-senha` · `PATCH /admins/:id/ativo` | admin | Gestão de administradores |
| `POST /importacao/alunos` · `/importacao/turmas` · `GET /importacao` | admin | CSVs + auditoria |
| `GET /alunos` · `/alunos/cursos` · `/alunos/:id` | admin | Pesquisa os vínculos importados (só leitura) |
| `POST /alunos/:id/mesclar` | admin | Funde o vínculo duplicado pela troca de grafia do curso |
| `GET /turmas` · `/turmas/:id` | admin | Pesquisa as turmas/disciplinas do CSV (só leitura) |
| `GET /modalidades` · `GET/POST/PATCH/DELETE /polos` · `/salas` · `/faixas` · `/sala-faixas` | admin | Estrutura física e oferta de vagas |
| `GET /portal/periodo` · `/portal/disciplinas` · `/portal/faixas` | aluno | O que ele pode escolher |
| `GET/POST /portal/agendamentos` | aluno | Confirmar a prova e consultar o que já marcou |
| `GET/POST /periodos` · `GET/PATCH/DELETE /periodos/:id` | admin | Abrir/fechar a janela de agendamento |
| `GET /agendamentos` · `/resumo` · `/exportacao` · `/:id` | admin | Relatório: consulta, ocupação por sala e o CSV de **todos os alunos** |
| `GET /relatorios/grupos-d2l` · `/zip` · `/:faixaId/:orgUnitId` | admin | Grupos do Brightspace: um CSV de matrículas **por horário e turma** |
| `GET /relatorios/listas-de-presenca` · `/pdf` · `/:salaFaixaId/pdf` | admin | Lista de presença: um PDF com **uma página por sala** de aplicação |
| `PATCH /agendamentos/:id/remanejar` · `DELETE /agendamentos/:id` | admin | Mover de sala/horário e cancelar |
| `POST /agendamentos/compulsorio` · `GET /:id` · `/:id/relatorio` | admin | Agenda por quem não agendou; acompanha o lote e baixa o CSV de exceções |
| `POST /agendamentos` | admin | Agenda a prova de **um** aluno, escolhendo a sala ou deixando a alocação escolher |
| `PATCH /portal/agendamentos/:id` | aluno | Trocar de horário (atômico). **Não há cancelamento pelo aluno** — só o admin, em `DELETE /agendamentos/:id` |
| `GET /portal/agendamentos/:id/declaracao` | aluno | Declaração de agendamento em PDF — **só depois de o prazo encerrar** |
| `GET /agendamentos/:id/historico` | admin | Quem alterou: aluno ou administrador |
| `GET/PUT /senhas-de-prova` · `GET /:id/revelar` · `DELETE /:id` | admin | A grade dia × turno das senhas das provas. **A listagem nunca devolve o valor** |
| `GET/PUT /senhas-de-prova/alvo` · `/horarios` · `GET /senhas-de-prova/turmas` | admin | Questionário-alvo, horários do cron, e quais turmas o lote vai tocar |
| `GET/PUT /senhas-de-prova/janelas` | admin | O calendário de abertura/fechamento do questionário, por modalidade |
| `POST /senhas-de-prova/execucoes` · `GET /:id` · `/:id/relatorio` | admin | Troca a **senha** (`tipo: SENHA`) ou a **janela de datas** (`tipo: DATA`) dos questionários no Brightspace; acompanha e baixa o CSV |
| `GET /d2l/callback` | — | Callback OAuth da Valence: troca o `code` e grava o refresh token |

Pendente: special access no quiz (adiado pelo cliente). OAuth, leitura de
matrículas e troca da senha dos questionários existem — ver "Disciplinas do
aluno: launch ou enrollments" e "Senha das provas".

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
agendar** — hoje, só `STATUS CURSO == "Ativo"` (comparado sem acento/caixa);
qualquer outro status deixa `ativo=false`. É um campo **derivado** de
`statusCurso`, não uma cópia dele: a regra mora em `status-curso.enum.ts` e já
mudou uma vez, então leia `ativo`, nunca compare a string na tela. E
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

⚠️ **`cursosRenomeados[]`: a grafia do curso mudou e o vínculo se duplicou.**
A chave é `[matricula, curso]`, então "PSICOLOGIA" virando "Psicologia —
Bacharelado" não é uma atualização: o upsert não encontra a linha antiga e cria
**outra**. A prova já marcada continua presa à primeira, e a partir daí o aluno
aparece duas vezes na tela de atendimento, sai como **"Não Agendado" na
exportação mesmo tendo agendado**, e o compulsório o aloca de novo — uma segunda
vaga para a mesma pessoa.

A detecção compara o curso da linha nova com os outros vínculos do mesmo RA
(`curso-renomeado.ts`, módulo puro). Duas regras fechadas, ambas exatas depois de
normalizar — `identico-normalizado` (só acento/caixa/pontuação) e
`tokens-contidos` (um nome é o outro com palavras a mais, comparado por token e
sem exigir ordem). **Sem distância de edição de propósito**: "ENGENHARIA CIVIL" e
"ENGENHARIA QUÍMICA" ficam a duas letras uma da outra e são cursos diferentes.

O que separa renomeação de aluno-com-dois-cursos é o **arquivo**: só entra como
candidata a grafia que **sumiu da planilha**. Se as duas aparecem no mesmo upload,
a fonte de verdade está afirmando que são dois vínculos, e nada é reportado.

**Avisa e não mescla**, como `alteracoesComAgendamento`. Fundir dois cursos
distintos misturaria as provas dos dois numa pessoa só, e é irreversível. Quem
decide é a secretaria, em `POST /alunos/:id/mesclar` (abaixo).

### `POST /alunos/:id/mesclar` — a única escrita sobre `AlunoImportado`

A regra "a planilha é a fonte de verdade, corrija o CSV e reimporte" continua de
pé. Esta rota é exceção porque **reimportar não resolve**: a grafia antiga não
está mais no arquivo, e a importação nunca apaga — sem uma ação explícita a linha
órfã fica no banco para sempre.

`:id` é o vínculo que **fica** (o novo); `absorverId`, no corpo, é o que será
**apagado**. É a direção do relatório: `cursosRenomeados[].alunoId` na URL,
`candidatas[].alunoId` no corpo. Agendamentos e exceções do compulsório passam
para o destino, tudo numa transação.

| Trava | Por quê |
|---|---|
| Mesma matrícula (400) | Ids trocados moveriam a prova de uma pessoa para outra — e o vínculo de origem é apagado, então não haveria como descobrir de quem era |
| Não ambos com prova CONFIRMADA no mesmo período (409) | A pessoa ficaria com duas reservas no semestre, em duas salas |
| Modalidade/polo divergentes | **Não bloqueia** — volta em `avisos`, mesma lógica de `alteracoesComAgendamento` |

O rastro vai para `VINCULOS_MESCLADOS` no log de auditoria, **não** para
`HistoricoAgendamento`: aquela tabela responde "mudaram minha prova de horário?",
e a mesclagem não muda prova nenhuma — sala, data e horário continuam idênticos.

⚠️ **`alteracoesComAgendamento[]`: os TRÊS campos que a importação muda por
baixo de uma prova marcada.** São as mudanças que passam **sem que nada mais no
sistema reclame** — a importação grava, a reserva continua exatamente onde
estava, e o `avisarSeMexeEmProvaMarcada` (`importacao-alunos.service.ts`) é o
único lugar que junta as duas pontas. Todas saem com `de`/`para` e vão para WARN.

| Campo | O que a reserva passa a contradizer | O que fazer |
|---|---|---|
| `modalidade` | a prova tem outra duração e o aluno segue na sala antiga | remanejar ou cancelar |
| `polo` | a reserva fica no campus anterior | remanejar ou cancelar |
| `statusCurso` | o aluno **perdeu a elegibilidade** e continua com a cadeira | manter ou cancelar |

As duas primeiras aparecem depois e disfarçadas — **o remanejo passa a ser
recusado** com "esta sala não é da modalidade do aluno". A terceira
(**01/09/2026**) não produz nem isso: `ativo` vira `false`, o aluno some do
compulsório e não troca mais de horário pelo portal, e mesmo assim continua na
lista de presença do dia. Era **completamente silenciosa**, porque
"Transf. Interna" é um status *conhecido* e por isso não entra em
`statusDesconhecidos[]` — a única pista era `bloqueados` subir um.

⚠️ **A pergunta é "PERDEU a elegibilidade?", não "o status mudou?".** A
comparação é sobre `ativo`, o campo derivado, **nunca** sobre o texto do status:
"Trancado" → "Cancelado" não muda nada para o aluno e viraria aviso em toda
planilha, e ler a string aqui seria a segunda cópia da regra que já mora em
`status-curso.enum.ts`. Ganhar elegibilidade também não avisa — voltar a poder
agendar tendo prova marcada não deixa nada inconsistente.

Três escolhas conscientes ali: **avisa e não bloqueia** (a planilha é a fonte de
verdade e pode estar corrigindo um cadastro errado — quem decide é a
secretaria), conta **só o semestre vigente** (prova de semestre passado já
aconteceu; avisar sobre ela seria o ruído que ensina o time a ignorar o aviso), e
**exige reserva confirmada** nos três casos — quem perde a elegibilidade sem
prova marcada é o caso normal, e já está em `bloqueados`.

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
- **Valence API — OAuth + leitura de matrículas**: ✅ implementado e **ligado por
  padrão** (`D2L_HABILITADO`, default `true` desde 18/08/2026 — só `false`
  desliga). É o que descobre **todas** as disciplinas do aluno no semestre; ver
  "Disciplinas do aluno" abaixo.
- **Valence API — troca da senha dos questionários**: ✅ **implementado
  (18/08/2026), a pedido do cliente.** `src/senha-quiz/` — ver "Senha das provas"
  abaixo.
- **Valence API — troca do GRUPO que libera o questionário**: ✅ **implementado
  (26/08/2026), a pedido do cliente.** Roda no mesmo disparo que move as datas —
  ver "O grupo que libera a prova troca no MESMO disparo", abaixo. Exige o escopo
  `groups:group:read` **no consentimento** (reautorize) e LP ≥ 1.49.
- **Valence API — special access nos quizzes**: ⬜ **ADIADA (decisão de
  03/08/2026).** O sistema hoje agenda, emite relatório e troca a senha da prova;
  a liberação individual por aluno fica para uma fase posterior. Não implemente
  nada de special access sem o cliente pedir.

### Disciplinas do aluno: launch ou enrollments

A fonte é decidida em **um arquivo só** (`disciplinas-do-aluno.service.ts`), e o
cruzamento com o CSV é o mesmo nos dois casos:

| `D2L_HABILITADO` | De onde vêm as turmas |
|---|---|
| `false` | A turma de onde o aluno clicou (claim `context` do LTI) — uma só |
| `true` (**default**) | Todas as ofertas dele no período letivo cadastrado, via `enrollments/users/{id}/orgUnits/` |

⚠️ **O default virou `true` em 18/08/2026** (`src/d2l/config/d2l.config.ts`): a
ausência da variável agora liga a integração, e só `'false'` explícito desliga. A
inversão veio da troca de senha das provas, que **depende** da Valence para
descobrir o `orgUnitId` das turmas do CSV — um ambiente que apenas esquecesse de
declarar a variável rodaria o lote em zero turma, sem erro nenhum, e as provas
ficariam sem senha no dia. O efeito colateral é este: **o portal do aluno passou
a usar enrollments por padrão**, com as duas consequências já documentadas aqui
(os 2 alunos de vínculo duplo, e `TURMAS_FILTER_ENABLED=false` ficando muito mais
perigoso). O e2e fixa `D2L_HABILITADO=false` em `test/setup-e2e.ts` para não
depender de um default que se move.

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

**Valence fora = degrada para o launch, nunca 503 no aluno.** `habilitado()` só lê
o `.env`: ele não sabe se há refresh token gravado, se ele ainda vale, nem se o
Brightspace está de pé. Sem o `catch` de `cairParaOLaunch`, os três viravam erro
na cara do aluno e o portal inteiro parava — foi o estado real do ambiente com
`D2L_HABILITADO=true` e `integracao_d2l` vazia, e nada avisou até alguém tentar
agendar. O fallback é pobre de propósito (só a disciplina clicada; quem tem três
provas agenda uma), mas agendar uma é melhor que agendar nenhuma, e o remanejo
conserta o resto. Aviso no log, no máximo 1×/min.

**O compulsório NÃO tem esse fallback, e não pode ter**: quem nunca fez launch não
tem turma clicada, então degradar daria lista vazia e o lote registraria
`SEM_DISCIPLINA_AGENDAVEL` — que manda conferir o CSV — quando a causa foi a rede.
Lá o erro sobe e vira `FALHA_NA_INTEGRACAO`, reprocessável. Há teste para os dois.

**`GET /health` expõe o estado em `d2l`** (`desligado` · `ok` · `nao_autorizado` ·
`desconhecido`), e `status` continua refletindo só banco+API — integração opcional
não pode marcar o container como unhealthy. `nao_autorizado` é o alerta: ligada no
`.env` e sem token gravado. Ver "Deploy em produção" no README.

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
  relatorio/   ✅ grupos do Brightspace por horário e turma (csv-grupos-d2l.ts,
               nome-de-arquivo.ts, zip com uma pasta por turma) +
               lista de presença por sala (lista-presenca.service.ts,
               pdf-lista-presenca.ts puro, assets/logo.png opcional)
  d2l/         ✅ autorização OAuth (d2l-oauth) · canal HTTP compartilhado
               (d2l-http) · leitura de matrículas (d2l-enrollments) · cliente de
               questionários (d2l-quizzes) · condições de liberação e grupos
               (d2l-condicoes, LP ≥ 1.49). Special access continua adiado —
               não criar sem pedido.
  senha-quiz/  ✅ a grade dia × turno (grade-senhas.service) · o lote
               (senha-quiz.service) · o cron (senha-quiz.cron) · puras:
               quiz-body.ts, condicoes.ts, grupo.ts, senha.ts, turno.ts,
               relogio.ts · resolucao-orgunit.service.ts (CSV ∩ ofertas do
               semestre) · resolucao-grupo.service.ts (nome de grupo → GroupId,
               turma a turma)

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

# seeds idempotentes: modalidades + janelas de prova + polos + 1º admin
npm run seed                 # lê SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD do .env

# so o calendario das janelas, sem tocar em polo/admin/modalidade. Para quando a
# unica coisa que mudou foi o horario de uma modalidade nova. NAO sobrescreve
# janela existente: cria o que falta e deixa o resto como esta — mudar horario
# ja cadastrado se faz na TELA, nunca aqui.
npm run seed:janelas

# LTI
npm run lti:keygen           # gera a chave RSA da ferramenta (LTI_TOOL_PRIVATE_KEY)

# token de aluno para testar o portal sem o Brightspace (recusa em producao)
npm run token:aluno -- <RA> [orgUnitId]

# reclassifica `ativo` a partir do statusCurso gravado — rode depois de mexer
# em status-curso.enum.ts. Sem `--gravar` e simulacao.
npm run alunos:recalcular
npm run alunos:recalcular -- --gravar

# Qual a modalidade de cada turma, segundo os agendamentos confirmados. E o que
# decide qual janela de horario o lote de DATAS aplica em cada questionario, e a
# unica forma de ver as turmas AMBIGUAS antes do dia da prova (elas ficariam com
# a data antiga, e ninguem abriria a prova). So leitura; sai com codigo 1 se
# houver ambiguidade. RODE ANTES DO PRIMEIRO DIA.
npm run turmas:modalidades

# "id_token do LTI invalido" e generico de proposito (nao conta a quem sonda a
# rota o que forjar). Este script decodifica o token e diz QUAL claim diverge do
# .env — iss, aud, deployment_id ou exp. Nao verifica assinatura: e leitura.
npm run lti:diagnosticar -- <id_token>

# link de autorizacao da Valence, montado a partir do .env. Refaca a autorizacao
# sempre que D2L_REDIRECT_URI mudar (ngrok -> producao): o Brightspace compara o
# redirect byte a byte, e o refresh token gravado nao serve para outra URL.
npm run d2l:autorizar

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
| Sala sem prova sobreposta no mesmo dia | Duas provas na mesma porta ao mesmo tempo (abaixo) |
| `ordem` única por faixa + modalidade | É a sequência de preenchimento da alocação |

### ⚠️ A mesma sala não recebe duas provas ao mesmo tempo (14/08/2026)

O unique de `SalaFaixa` é `[salaId, faixaId]` — **por faixa, não por horário**.
Ele impede a sala de entrar duas vezes na *mesma* faixa, e só isso. Nada impedia
o par abaixo, com as duas ofertas passando em todas as outras validações:

```
17/08  09:00-12:00  Sala 1  EAD     ← faixas diferentes,
17/08  10:30-12:00  Sala 1  SEMI    ← a mesma porta às 10:30
```

O sintoma só apareceria no dia: duas listas de presença para a mesma sala, com
alunos de modalidades e durações diferentes disputando as cadeiras.

A regra vive em `exigirSalaLivreNoHorario` (`sala-faixa.validacao.ts`, pura) e é
chamada nas **três** portas que podem criar o choque — `POST /faixas`,
`POST /faixas/:id/salas` e `PATCH /faixas/:id`. A terceira é a menos óbvia e a
mais perigosa: **mover a faixa no calendário arrasta todas as salas dela junto**,
e o admin acha que só mexeu no relógio. Ela só reconfere quando `data`,
`horaInicio` ou `horaFim` realmente mudam — um PATCH de `ativo` não cria
sobreposição nenhuma, e recusá-lo por causa de dado antigo deixaria o admin sem
conseguir nem tirar do ar a faixa problemática.

| Decisão | Por quê |
|---|---|
| Intervalo **semiaberto**: 08:30-10:00 e 10:00-11:30 não se sobrepõem | A sala vaga quando a prova acaba. Exigir folga de virada seria inventar regra que a universidade não pediu — quem quiser folga cadastra a faixa seguinte mais tarde |
| Faixa concorrente **inativa e sem confirmado NÃO ocupa** a sala | Sumiu do portal, não ganha aluno novo, e não há ninguém para aparecer no dia. Bloquear prenderia a sala para sempre: faixa com agendamento **CANCELADO** não pode ser apagada (`FaixaService.remover`) |
| Faixa inativa **com** confirmado **ocupa** | Desativar não cancela prova nenhuma (regra 7), e o admin pode agendar de propósito numa faixa desativada. Aquelas pessoas vão estar na sala |
| A consulta é por `sala + data`, sem filtrar polo | `Sala.poloId` é imutável e `validarOferta` já exige que a sala seja do polo da faixa — toda concorrente é do mesmo campus por construção |
| Checagem **fora** da transação | Mesmo risco que o `duplicada` de `criar` já aceita: dois admins montando faixas no mesmo segundo ainda passariam. São poucas pessoas, e o caminho crítico de concorrência é a alocação de vaga, que tem `FOR UPDATE` |

**Não impede dado antigo.** A regra vale na escrita; sobreposição já gravada
continua no banco. Para auditar, cruze `sala_faixa` consigo mesma por
`faixa.data` comparando as janelas.

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
| A MESMA PESSOA já tem prova nesta faixa, pelo outro curso | 409 (regra 4b) |
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

**Trocar é atômico, e por isso é a ÚNICA alteração que o aluno faz.**
Se ele cancelasse primeiro, poderia perder a vaga que tinha e descobrir que a
nova lotou no meio do caminho — ficando sem nenhuma. Foi esse risco que tirou o
cancelamento do portal em 17/08/2026 (regra 7): a troca cobre o caso real do
aluno ("não posso nesse dia") sem nunca deixá-lo sem horário. O lock reaproveitado está em
`agendamento/service/lock-de-vagas.ts`, compartilhado por agendar, trocar e
remanejar: se fossem três implementações, uma delas acabaria sem o `FOR UPDATE`.

**Sem período cadastrado = fechado.** Mesma escolha do filtro de turmas: na
dúvida, não libera. Para testar antes do CRUD administrativo (etapa 7), crie a
linha em `PeriodoAgendamento` pelo `npm run prisma:studio`.

### Duas provas no mesmo semestre: a `rodada`

O Brightspace tem **um** `periodoLetivoId` por semestre, e a UCB tem pelo menos
**duas** provas nele: a regular (N2) e a substitutiva. Antes da `rodada`, isso
travava em dois lugares ao mesmo tempo — `POST /periodos` recusava a segunda
janela como duplicata, e a trava por vínculo recusava o segundo agendamento.

A `rodada` (`"N2"`, `"SUB"`, …) é a segunda metade da identidade do período. Onde
ela entra e onde **não** entra:

| Consulta | Filtra por rodada? | Por quê |
|---|:---:|---|
| `alocar` / `agendarPeloAdmin` — "já tem prova?" | ✅ | É o núcleo da mudança: quem fez a N2 precisa poder agendar a SUB |
| `meusAgendamentos`, declaração, `exigirAgendamentoDoAluno` | ✅ | O aluno só vê e só mexe na prova da rodada aberta; a anterior já aconteceu |
| `elegiveis` (compulsório) | ✅ | Elegível para a SUB é quem não tem prova **da SUB** — inclusive quem fez a N2 |
| `remover` (período) e `totalAgendamentos` | ✅ | A conta é da janela, não do semestre |
| `exportarCsv` | ✅ (quando o `periodoLetivoId` não vem na URL) | Sem ela, quem fez a N2 sai como "Agendado" durante a SUB e escapa da cobrança |
| **`exigirUmaProvaPorFaixa`** | ❌ | Uma prova por PESSOA em cada horário, entre rodadas inclusive: quem fez a N2 às 08:30 não faz a SUB às 08:30 |
| **`faixasBloqueadasParaOVinculo`** (`conflitaComOutraProva`) | ❌ | É o espelho exato da linha acima; filtrar aqui faria a tela oferecer o horário que a confirmação recusa |
| **`reservaAnterior`** (disciplinas para o admin) | ❌ | A reserva da N2 é fonte válida para a SUB: mesmas disciplinas, mesmo `userIdD2L` |
| `disciplinas-do-aluno`, importação, relatórios, senhas | ❌ (só usam `periodoLetivoId`) | O que define quais ofertas contam é o SEMESTRE; as duas rodadas cobrem as mesmas matérias |
| **Os critérios de nota** (`filtrarPorNota`) | ❌ — usa `notaMinimaN1/notaMaximaFinal` | O que separa a SUB da N2 são os critérios cadastrados, e não o TEXTO da rodada, que é livre. Ver "Quem pode fazer a substitutiva" |

⚠️ **`periodoLetivoVigente()` NÃO EXISTE MAIS** (01/09/2026). A tabela acima
continua valendo para a `rodada`, mas o `periodoLetivoId` virou um MAPA por
modalidade — ver *Duas grades no mesmo ano*. No lugar dele há dois métodos:
`periodoLetivoDaModalidade(modalidade)` para quem age sobre um aluno e
`janelaVigente()` para quem conta, lista ou trava por PESSOA. São dois nomes, e
não um parâmetro opcional, pela mesma razão que o antigo devolvia o par em vez da
string: a escolha tem de ser explícita em cada chamada, senão é esquecida em
silêncio.

**`rodada` só é editável enquanto a janela estiver VAZIA** (`PATCH /periodos/:id`;
`periodoLetivoId` nunca é). `Agendamento.rodada` é fotografia: trocar a da janela
não renomeia prova nenhuma — a janela passaria a dizer `SUB` com 20 reservas
dizendo `N2`, e daí em diante *toda* consulta pelo par para de casar (o portal diz
ao aluno que ele não tem prova, a exportação o lista como "Não Agendado", o
compulsório o aloca de novo). Com a janela vazia não há o que desalinhar, e é aí
que a correção resolve o caso real: cadastrou como `N2` o que era a substitutiva
e percebeu antes de abrir. A contagem inclui **cancelados**, como no `remover`.

Apagar e recriar **não** é a alternativa: `vigente` = o cadastrado mais
recentemente, então recriar embaralha essa ordem — é justamente o problema que o
`DELETE /periodos/:id` existe para desfazer.

**A migration deu `rodada = "N2"` a tudo que já existia** — períodos e
agendamentos. Quem tinha um semestre cadastrado antes desta mudança continua
consistente, sem nenhuma ação manual.

### Duas grades no mesmo ano: o mapa por modalidade (01/09/2026)

A `rodada` resolveu "duas provas no mesmo período letivo". Esta é a irmã dela, e
resolve o inverso: **dois períodos letivos na mesma prova.**

A UCB divide o ano de duas formas simultâneas. EaD, Semipresencial e Modular
andam por **módulo** — quatro por ano, `2026/1` a `2026/4`. Presencial anda por
**semestre** — dois, `2026/1` e `2026/2`. Em novembro de 2026 o aluno EaD está
sob `2026/4` e o presencial sob `2026/2`: **dois org units diferentes e vivos ao
mesmo tempo** no Brightspace.

Como as disciplinas agendáveis saem dos descendentes desse org unit
(`ofertasDoPeriodo`), a janela com um `periodoLetivoId` único obrigava a escolher
uma das grades — e a outra metade da universidade ficava sem disciplina nenhuma.
**Sem erro nenhum:** o id que não bate responde 200 com lista vazia, e todo aluno
daquela modalidade recebe a mesma frase genérica. É o mesmo modo de falhar que
transformou o campo em dropdown fechado, e por isso a mensagem de lista vazia
agora **nomeia** o período letivo e a modalidade que o escolheu.

`PeriodoAgendamento.periodoLetivoId` continua existindo como o **principal** (o
rótulo da janela, a chave da duplicata em `criar`, e o fallback de uma modalidade
sem linha no mapa). Quem responde "qual org unit vale para ESTE aluno" é
`PeriodoLetivoModalidade`.

**As duas leituras, e a escolha entre elas é sempre explícita.**
`periodoLetivoVigente()` foi APAGADO de propósito — dois métodos com nomes
diferentes obrigam cada chamador a dizer o que quer, e a lista de erros do `tsc`
foi o checklist da migração:

| Pergunta | Método |
|---|---|
| o período DESTE aluno (disciplinas, agendar, trocar, importar) | `periodoLetivoDaModalidade(modalidade)` |
| todos os períodos DESTA janela (contar, listar, exportar, relatar) | `janelaVigente()` + `{ in: periodoLetivoIds }` |
| **trava por PESSOA** (uma prova por matrícula em cada faixa) | `janelaVigente()` — **obrigatoriamente** |

⚠️ **A última linha é a que não pode errar.** Um mesmo RA pode ter um vínculo EaD
e um Presencial, e as duas reservas dele ficam sob org units DIFERENTES na mesma
janela. Recortar pelo período de um vínculo faria a trava não enxergar a reserva
do outro — e a pessoa sairia com **duas provas no mesmo horário, em duas salas**.
São três lugares, e os três usam a janela inteira: `exigirUmaProvaPorFaixa`
(`lock-de-vagas.ts`), `faixasBloqueadasParaOVinculo` (o espelho na tela, que tem
de bater exatamente) e `exigirAgendamentoDoAluno` (a trava de prova anterior, que
virou `includes` em vez de igualdade).

**A regra "uma prova por vínculo em cada rodada" (`alocar`) NÃO mudou**: ela
trava por `alunoId`, que *é* o vínculo — e um vínculo tem uma modalidade só.

**Onde o recorte é de propósito ESTREITO**, e não a janela inteira:

- **`reservaAnterior`** (balcão) — copiar a reserva do outro vínculo atravessaria
  as duas grades e marcaria a prova cobrindo as disciplinas ERRADAS, em silêncio,
  porque a lista viria cheia e plausível. Dois vínculos da MESMA modalidade
  continuam emprestando um para o outro, que é o caso que o método serve.
- **O cache do compulsório** (`resolverEmLotes`) — a chave virou
  `matricula + modalidade`. Era só a matrícula, e com as duas grades o segundo
  vínculo receberia a lista do primeiro.

**`recusarSeAmbosTemProva`** (mesclagem) passou a colapsar os períodos da janela
vigente numa chave só: mesclar vínculos de modalidades diferentes é permitido
(`conferirHeranca` avisa e não bloqueia), e comparar o id cru deixaria passar
exatamente o estado que a trava existe para impedir.

**O mapa só é editável com a janela VAZIA**, como a `rodada` e pelo mesmo motivo:
`Agendamento.periodoLetivoId` é fotografia. Reenviar o mapa IGUAL não dispara a
trava — editar a data de fechamento de uma janela cheia é a operação mais comum
da tela, e ela manda o formulário inteiro.

**O mapa tem de cobrir TODAS as modalidades** (400 nomeando as que faltam).
Cobrir parcialmente seria pior que não cobrir: a esquecida cairia no principal em
silêncio, que é exatamente o erro que o mapa existe para impedir. Omitir o campo
inteiro põe todas no principal — o caso legítimo de quem tem uma grade só.

**O filtro `periodoLetivoId` das telas de admin virou LISTA** (separada por
vírgula, em `/agendamentos`, `/agendamentos/exportacao` e nos relatórios). A tela
manda a janela inteira; um id sozinho continua valendo e recorta aquela grade.
Sem isso, escolher a janela vigente no dropdown esconderia todos os presenciais —
e na lista de presença o sintoma só apareceria no dia da prova, com a sala cheia
e a folha em branco na mão do fiscal.

**A migration fez o backfill do produto cartesiano** (toda janela × toda
modalidade, apontando para o `periodoLetivoId` que ela já tinha), como a da
`rodada` deu `"N2"` a tudo. Quem tinha janela cadastrada antes desta mudança
continua idêntico, sem nenhuma ação manual.

### Quem pode fazer a substitutiva: os critérios de nota (20/08/2026, regra nova em 08/09/2026)

A `rodada` deu ao semestre duas janelas, mas as duas ofereciam ao aluno **as
mesmas** disciplinas — `disciplinas-do-aluno` filtra só pelo `periodoLetivoId`,
porque "as duas rodadas cobrem as mesmas matérias". Aberta a janela da SUB, a
substitutiva ficaria liberada para todo mundo, inclusive para quem já passou.

A regra do cliente são **DOIS critérios sobre notas DIFERENTES**, e a disciplina
só entra quando passa nos dois:

| Critério | Nota olhada | Comparação | Por quê |
|---|---|---|---|
| piso | **N1** | `>= notaMinimaN1` (1,50) | quem nem isso fez já reprovou |
| teto | **nota final calculada** | `< notaMaximaFinal` (7,00) | quem alcançou a média já passou |

⚠️ **Isto MUDOU em 08/09/2026, e a mudança é fácil de desfazer sem perceber.**
Até então os dois limites comparavam a **mesma** nota — a final, em
`[1,5 ; 6,75)`. Hoje o piso mudou de nota, e **não há mais piso na nota final nem
teto na N1**. As colunas foram renomeadas junto (`notaMinima`→`notaMinimaN1`,
`notaMaxima`→`notaMaximaFinal`) exatamente por isso: `minima`/`maxima`
continuariam compilando e continuariam parecendo um intervalo, e quem lesse o
piso como piso da final voltaria a liberar quem tem final 2,0 com a N1 zerada —
sem erro nenhum aparecendo. Pelo mesmo motivo a validação de
`minima >= maxima` **saiu**: ordem entre notas diferentes não significa nada.

⚠️ **A N1 não tem rota própria na Valence.** Ela é uma *categoria de notas*
(`GradeObjectType: 9`), lida pelo mesmo `grades/(gradeObjectId)/values/` de
qualquer item — só que o `CategoryId` dela é **diferente em cada turma**. Então a
leitura é em duas etapas: `grades/categories/` acha o id pelo NOME, e o nome vem
de `D2L_CATEGORIA_N1` (default `"N1"`). Turma que chamar a categoria de "Nota 1"
recusa **todos** os seus alunos (`SEM_CATEGORIA_N1`), com um aviso por turma no
log. Ver §4.5 da referência da API.

A regra é **por DISCIPLINA, não por aluno**: um aluno com três matérias pode ter
uma elegível e duas não, e a prova dele cobre só a elegível. Isso **não** quebra
a regra 4: a lista encolhe antes de chegar a ele, que continua sem escolher
disciplina por disciplina.

⚠️ **O gatilho é `PeriodoAgendamento.notaMinimaN1/notaMaximaFinal`, NUNCA
`rodada === 'SUB'`.** `rodada` é texto livre — quem a nomeia é a secretaria —,
então comparar a string faria a regra parar de valer em silêncio no dia em que
alguém cadastrasse "Substitutiva" ou "sub". Colunas nulas (todo período
existente) = sem filtro, e **nenhuma chamada de nota sai**: o caminho da N2
continua custando zero.

| Peça | Onde | O que faz |
|---|---|---|
| Cliente REST | `src/d2l/service/d2l-grades.service.ts` | Lê a nota final e a N1, um aluno ou a turma inteira; resolve a categoria N1 pelo nome. Nenhuma regra |
| A regra | `src/agendamento/service/elegibilidade-de-nota.service.ts` | Aplica os dois critérios, cacheia 5 min (por turma+aluno+**alvo**), pré-aquece por turma |
| A costura | `disciplinas-do-aluno.service.ts` (`filtrarPorNota`) | Entra depois do CSV, nas DUAS portas — cobre portal, compulsório e balcão de uma vez |
| A configuração | `PeriodoAgendamento` + `periodo.service.ts` (`FiltroDeNota`) | O admin cadastra os dois números na tela de Períodos |

**A ordem das leituras é deliberada: nota final primeiro, N1 depois.** A maioria
dos alunos de uma turma passou de ano, e esses saem no primeiro critério — checar
a N1 antes faria o portal pagar DUAS chamadas por disciplina para todo mundo.
Inverter não muda resultado nenhum, e é por isso que ninguém perceberia.

**Fail-closed, e é a diferença que mais importa.** Com a Valence fora, a N2
degrada para a turma do launch ("agendar uma prova é melhor que agendar
nenhuma"). Com filtro de nota, degradar liberaria a substitutiva **sem conferir
nota nenhuma** — exatamente o que a regra existe para impedir. Então
`cairParaOLaunch` não vale, `D2L_HABILITADO=false` com faixa cadastrada recusa
(e loga `error`: é erro de configuração), e o aluno recebe a frase de
`NOTAS_INDISPONIVEIS`, que fala em **notas** e não em disciplinas.

**O mesmo erro vira coisas opostas nas duas portas**, e é de propósito:
`cruzar` (portal) o transforma em `motivo` — 200 com o botão desabilitado, como
todo o resto do portal; `cruzarPorUserId` (compulsório/balcão) o deixa **subir**,
porque virado texto ele daria uma linha de relatório dizendo "este aluno passou
de ano" quando a causa foi a rede — e ninguém a reprocessaria. Subindo, vira
`FALHA_NA_INTEGRACAO`.

**`causa: 'FILTRO_DE_NOTA'` existe para não comparar frase.** É o que separa
`NAO_ELEGIVEL_PELA_NOTA` de `SEM_DISCIPLINA_AGENDAVEL` no compulsório: o segundo
manda conferir o CSV de turmas, e quem passou de ano não tem nada para conferir.
Num lote de substitutiva o motivo novo tende a ser a **maioria** das linhas.

**Os motivos de recusa são cinco, e cada um pede uma ação diferente**
(`MotivoDaRecusa`): `FINAL_ATINGIU_A_MEDIA` e `N1_ABAIXO_DO_MINIMO` são a regra
funcionando; `SEM_NOTA_FINAL` e `SEM_NOTA_N1` são pendência de lançamento (caso
de secretaria); `SEM_CATEGORIA_N1` é **defeito de montagem da turma** e atinge a
turma inteira. Misturar os três grupos numa frase só faria o aluno desistir de
perguntar — ou cobrar uma nota que ninguém tem como lançar.

**O compulsório lê as notas por TURMA antes de começar** (fase 0,
`preCarregarNotas`). Aluno a aluno seriam ~10 chamadas por pessoa — perto de 70
mil num lote de 7 mil, somadas às 2 que já existem. Por turma são **duas** (a
final e a N1), uma vez. Falha de uma turma não para nada: ela volta a ser
consultada aluno a aluno. Turma sem categoria N1 **não** conta como falha —
contá-la esconderia as falhas de verdade, que são as de rede.

**Os critérios são editáveis com a janela CHEIA**, ao contrário da `rodada`. A
rodada é fotografia gravada em cada reserva e trocá-la desalinha toda consulta;
os critérios não são gravados em lugar nenhum, e mexer neles só muda quem agenda
daqui para a frente. Vai para a auditoria (`PERIODO_FILTRO_DE_NOTA_ALTERADO`) e
para o log quando já há reservas — as provas existentes **não** são revistas.

**`AgendamentoDisciplina.notaFinal` e `.notaN1` são fotografia das notas que
decidiram.** Nulas na N2; a `notaN1` é nula também nas reservas anteriores a
08/09/2026, decididas por uma regra que não olhava a N1 (não há backfill:
inventar um valor seria mentir sobre o que aconteceu). Existem para responder
"por que ele agendou substitutiva desta matéria?" com o aluno na frente, meses
depois, quando a nota no Brightspace já mudou. O fallback `RESERVA_ANTERIOR` do
balcão **recopia** as notas antigas e avisa em `avisos` que a lista não foi
conferida contra os critérios.

**Escopos: `grades:gradevalues:read` e `grades:gradecategories:read`.** O segundo
entrou em 08/09/2026, com a N1. Como todo escopo, eles vivem no consentimento —
acrescentá-los a `D2L_SCOPES` sem `npm run d2l:autorizar` deixa o GET
correspondente em 403, e aí *ninguém* agenda a substitutiva. Confira o formato
real com `npm run d2l:notas -- <orgUnitId> <userId>` antes de abrir a janela: ele
resolve o `CategoryId` da N1 (ou avisa que a turma não tem a categoria), mostra
se `PointsDenominator` já vem 10 (nota fechada) e se a rota devolve a **ajustada**
quando o professor a lançou. Ver §4.5 da referência.

**⚠️ Ao migrar: as janelas já cadastradas mudam de significado.** O `1,50`
gravado era piso da nota final e passa a ser piso da N1; o `6,75` continua teto da
final. A migration renomeia as colunas e **não converte os números** — reescrever
o teto para 7,00 seria tomar no lugar da secretaria uma decisão que é dela.
Confira a janela da substitutiva na tela de Períodos antes de abri-la.

### `DELETE /periodos/:id` — vigente é derivado, e por isso se erra fácil

Vigente = **o cadastrado mais recentemente** (`createdAt desc`), não um flag no
banco. Não há como marcar outro no lugar: cadastrar o semestre seguinte com
antecedência, ou criar uma linha errada, **rouba o vigente do período em curso**,
e a única saída era mexer no banco à mão. É o mesmo caso de uso do
`DELETE /polos/:id` — desfazer cadastro que não deveria existir.

| Decisão | Por quê |
|---|---|
| Só apaga período letivo **sem agendamento nenhum** (409 caso contrário) | Apagar a linha não apaga prova: `Agendamento.periodoLetivoId` é string, sem FK. As provas ficariam órfãs de janela, e o aluno perderia de vista a que já marcou — o oposto da regra 7, em que fechar tranca a escolha e nunca a consulta |
| A contagem inclui **CANCELADO**, ao contrário do `totalAgendamentos` da tela (só `CONFIRMADO`) | São perguntas diferentes: a tela mostra vagas tomadas, e cancelar devolveu a vaga; aqui a pergunta é "alguém já usou este semestre?", e o cancelamento é justamente o registro que precisa continuar explicável no dia da prova |
| A conta é pelo par `periodoLetivoId + rodada` — duas linhas do MESMO par travam uma a outra, mas a N2 e a SUB do mesmo semestre não | Com a mesma chave nos dois, não há como dizer a qual linha a prova pertence. Já a janela vazia da SUB precisa poder ser desfeita: as provas da regular são de outra janela e não dizem nada sobre ela |
| **Apagar o vigente é permitido**, e a resposta traz `vigenteAgora` | É o motivo de a rota existir. Mas o portal passa ao período anterior, em geral com o prazo vencido — avisa e não bloqueia, como `alteracoesComAgendamento` |

Encerrar o prazo continua sendo `PATCH` (`aberto=false` ou `dataFechamento` no
passado): a linha fica no histórico, e quem já agendou não perde nada.

**Token de aluno para teste:** `npm run token:aluno -- <RA> [orgUnitId]`
monta o mesmo payload do launch lendo os vínculos do banco, pulando só a
assinatura do Brightspace. **Recusa rodar com `NODE_ENV=production`.**

## A exportação em CSV é de ALUNOS, não de agendamentos

`GET /agendamentos/exportacao` não é a tela virada arquivo. Ele responde **com
quem a secretaria precisa falar**: a base são os **vínculos importados, todos
eles**, e o agendamento entra como coluna. Quem não marcou sai com as colunas da
prova vazias e `Status = Não Agendado`.

Colunas, e só estas: `Matricula · Aluno · E-mail · Curso · Modalidade · Polo ·
Rodada · Data da prova · Inicio · Fim · Sala · Status · Agendado em`.

- **`Modalidade` e `Polo` saem do AGENDAMENTO, não do vínculo** (13/08/2026).
  `AlunoImportado` guarda só o estado atual e a importação o sobrescreve; lendo
  de lá, uma prova feita como EaD passava a ser exibida como "Modular" assim que
  o aluno mudasse de curso — na mesma linha da data e da sala corretas, que
  continuam sendo as da prova de verdade. Duas colunas da mesma linha
  discordando sobre o mesmo fato. Quem **não** tem prova não tem fotografia, e aí
  o estado atual é a resposta certa: vai agendar pela modalidade que tem hoje.

- **`Status` tem dois valores, `Agendado` e `Não Agendado`** — não o enum do
  banco. Quem for cobrar filtra a coluna no Excel; `CANCELADO` obrigaria a
  secretaria a saber que cancelado também significa "precisa agendar".
- **Cancelado conta como `Não Agendado`** e, por isso, o filtro `status` da URL
  **não se aplica** aqui: a coluna é derivada.
- **O recorte é UMA PROVA: `periodoLetivoId` + `rodada`** (os da URL ou os do
  período vigente). Sem o semestre, prova do semestre passado faria o aluno
  parecer agendado; sem a rodada, quem fez a N2 apareceria como agendado durante
  a substitutiva. Os dois tiram da cobrança gente que precisa ser cobrada.
  Fixar `periodoLetivoId` na URL **sem** `rodada` traz o semestre inteiro, de
  propósito: aí a pergunta é outra ("o que aconteceu naquele semestre").
- `faixaId`/`salaId`/`de`/`ate` são filtros da **prova** e restringem o arquivo a
  quem tem prova ali; `poloId`/`modalidadeId`/`busca` filtram o **aluno** e
  continuam trazendo quem não agendou.

Não "otimize" isso de volta para uma consulta em `agendamento`: o arquivo
deixaria de listar exatamente as pessoas para as quais ele existe.

## ⚠️ São TRÊS documentos, com públicos e recortes OPOSTOS

Confundir os três é o erro fácil desta parte do sistema. Eles respondem a
perguntas diferentes e recortam a mesma base de jeitos incompatíveis:

| | `GET /agendamentos/exportacao` | `GET /relatorios/grupos-d2l/:faixaId/:orgUnitId` | `GET /relatorios/listas-de-presenca/pdf` |
|---|---|---|---|
| Quem lê | **Pessoa**, no Excel pt-BR | **Máquina**: o *Groups Import* do Brightspace | **Pessoa**, no papel: o fiscal da sala |
| Responde | "com quem a secretaria precisa falar" | "quem entra no grupo desta prova" | "quem senta nesta sala" |
| Base | Todos os vínculos, agendados ou não | Só quem tem prova **confirmada** | Só quem tem prova **confirmada** |
| Formato | CSV, 12 colunas | CSV, 2 colunas (`Nome de usuário`, `Código do Grupo` **vazia**) | PDF A4, 5 colunas |
| Uma linha é | um vínculo | um **usuário** (RA distinto) | uma **pessoa** (RA distinto) |
| Separador · BOM | `;` · **sim** | `,` · **não** | — |
| Recorte | um período letivo | uma **janela + uma turma** + um período letivo | uma **sala + uma faixa** + um período letivo |

**O primeiro conta diferente dos outros dois, e não está errado.** Ele lista
*vínculos*, então o RA de dois cursos aparece duas vezes — é a lista de quem a
secretaria precisa cobrar, e são duas provas a cobrar. Os outros dois listam
*pessoas* e o trazem uma vez só.

Trocar o separador ou o BOM quebra em silêncio nos dois sentidos: com `;` o D2L
lê a linha inteira como um campo só; com BOM, os três bytes grudam no cabeçalho e
`Nome de usuário` deixa de casar com a coluna esperada; e o CSV da secretaria sem
BOM chega no Excel como "CÃ¢mpus".

Por isso `montarCsv()` (`agendamento/service/csv-relatorio.ts`) recebe
`{ separador, bom }`, **com default no formato do Excel** — quem não passa nada
continua produzindo o arquivo da secretaria. O formato do D2L está declarado num
lugar só, `relatorio/service/csv-grupos-d2l.ts`.

## Grupos do Brightspace: um arquivo por HORÁRIO **e** TURMA

`GET /relatorios/grupos-d2l` lista os grupos do recorte com quantos alunos cada
um tem; `/:faixaId/:orgUnitId` baixa o CSV de um; `/zip` baixa todos de uma vez.
É a aba **Relatorios** do painel.

- **O recorte é o PAR (janela, turma).** O grupo não existe solto: ele vive
  *dentro* de uma disciplina do Brightspace (`orgUnitId`), e é ele que libera o
  quiz **daquela** disciplina. Um arquivo com o horário inteiro importaria sem
  erro nenhum e colocaria no grupo de HISTÓRIA quem só cursa NUTRIÇÃO — gente com
  acesso a uma prova que não faz, descoberto no dia. Por isso o mesmo aluno
  aparece em vários arquivos: um por disciplina que a prova dele cobre.
- **Nem a sala nem o POLO entram.** O grupo libera o quiz numa *janela de tempo*;
  onde a pessoa senta — que cadeira, que campus — não muda o acesso. As salas e
  os polos daquele dia e horário entram na mesma lista. Ver "A janela, não a
  faixa", abaixo.
- **Uma matrícula aparece UMA vez por arquivo.** Um RA com dois vínculos na mesma
  modalidade pode ter dois agendamentos na mesma janela, os dois cobrindo a mesma
  disciplina — o grupo é por *usuário*, e a linha repetida faria o import
  reclamar ou duplicar. `totalAlunos` conta matrículas **distintas**, para bater
  com o número de linhas do arquivo.
- **De onde sai a turma:** `AgendamentoDisciplina` guarda o `orgUnitId` de cada
  disciplina coberta pela reserva (gravado junto com o agendamento). O
  `codigoTurma` legível vem de `TurmaImportada`, encontrada por esse `orgUnitId`
  — que o CSV de turmas **não traz**: ele é aprendido no launch
  (`TurmaService.aprenderOrgUnitId`). Enquanto não foi aprendido, ou com
  `TURMAS_FILTER_ENABLED=false`, o nome cai em `orgUnit <id>`. Nome genérico ali
  faria duas turmas disputarem o mesmo arquivo.
- **Nome do arquivo:**
  `20-08-2026 08h30-11h30 - GSPS0I10227 - HISTORIA E CULTURA.csv` — horário,
  código da turma e disciplina. `/` e `:` são inválidos em nome de arquivo, daí o
  `-` e o `h`; **os acentos caem** (só no nome; na tela e no CSV o nome fica
  inteiro), o que dispensa o `filename*=UTF-8''` do RFC 5987 no
  `Content-Disposition` e evita negociação de codificação no zip e no sistema de
  arquivos de quem baixa. Regras em `relatorio/service/nome-de-arquivo.ts`.
- **O zip é organizado em uma pasta por turma**, com o horário no nome do
  arquivo. Acompanha o trabalho real: abre-se a turma no Brightspace e importam-se
  os horários dela, um a um — com faixa × turma o zip passa de dezenas para
  centenas de arquivos, e achar o certo na raiz seria o gargalo.

  ```
  GSPS0I10227 - HISTORIA E CULTURA DO CORPO/
      20-08-2026 08h30-11h30.csv
      20-08-2026 14h00-17h00.csv
  ```

- **O sufixo `#<orgUnitId>` é raro e não é sobre polo.** Ele só aparece quando
  duas disciplinas do mesmo código de turma geram a **mesma pasta** depois do
  corte de 60 caracteres do `sanear` — aí a segunda sobrescreveria a primeira
  dentro do zip, em silêncio. Até 17/08/2026 o desempate era `#<faixaId>` e
  disparava no caso normal (dois campi); ver abaixo.
- **Horário sem ninguém agendado não aparece.** As linhas nascem dos
  agendamentos: uma faixa não "tem" disciplinas, são os alunos que as trazem.
  Ocupação por horário é `GET /agendamentos/resumo`, a tela feita para isso.
- **A listagem não devolve as matrículas**, só a contagem: mandar dezenas de
  milhares de RAs para o navegador exibir um número seria desperdício. O CSV é
  gerado pela rota do arquivo, pelo mesmo caminho de código.

### ⚠️ A JANELA, não a faixa (17/08/2026)

Até esta data o recorte era o par (`faixaId`, `orgUnitId`) — e `Faixa` carrega
`poloId`. **O polo entrou no recorte de carona**, sem ninguém decidir isso: duas
faixas do mesmo dia e horário em campi diferentes viravam dois grupos, na mesma
disciplina, com exatamente o mesmo special access.

O que o Brightspace precisa saber é **quando** a prova abre e em **qual**
disciplina. Onde a pessoa senta não é uma das duas — é o mesmo argumento que já
tirava a *sala* do recorte, só que um nível acima. Por isso o grupo passou a ser
a **janela** (`data + horaInicio + horaFim`) cruzada com a turma, e as faixas de
todos os polos daquela janela entram no mesmo arquivo.

O que isso conserta, na prática:

| Antes | Agora |
|---|---|
| Dois grupos idênticos a criar à mão no D2L, um por campus | Um grupo, um import |
| `#<faixaId>` no nome, disparando no caso **normal** de operação | Um arquivo só; o `#` vira caso raro (colisão de nome truncado) |
| RA com dois vínculos em campi diferentes na mesma janela saía em dois arquivos da mesma disciplina | O `Set` de matrículas o traz uma vez |

**A regra que sustenta isso: o filtro `poloId` estreita a LISTAGEM, nunca o
CONTEÚDO.** `montarGrupos` usa o filtro só para escolher **quais janelas**
aparecem, e depois relê os alunos daquelas janelas **sem ele**
(`inscricoesDasJanelas`). Aplicar o polo nas duas pontas produziria um CSV com
metade da turma e nome de arquivo de turma inteira: o import passaria sem erro
nenhum, e quem ficou de fora descobriria no dia, com o quiz trancado. Não
"otimize" as duas consultas numa só — é essa separação que o teste
`poloId nao trunca o arquivo` protege.

Duas consequências no contrato, ambas testadas:

- **`faixaId` virou um *handle*, não o recorte.** Na listagem é a menor faixa da
  janela (para não mudar entre carregamentos); na rota
  `/:faixaId/:orgUnitId` serve só para dizer de que janela se trata. Duas faixas
  irmãs devolvem **o mesmo arquivo, com o mesmo nome**, de propósito.
- **`polo: string` virou `polos: string[]`.** É informativo, em ordem
  alfabética, e quase sempre tem um elemento só. A tela junta com ` · `.

O front usa o `nomeArquivo` que vem do backend: resposta em blob não expõe o
`Content-Disposition`, e montar o nome no cliente deixaria a regra em dois
lugares.

## Lista de presença: um PDF com uma página por SALA

`GET /relatorios/listas-de-presenca` lista as salas que terão aplicação e quantos
assinam em cada; `/pdf` baixa o PDF do recorte inteiro; `/:salaFaixaId/pdf` baixa
a folha avulsa de uma sala. É a mesma aba **Relatorios** do painel.

É o **único documento do sistema que sai impresso e volta escrito à mão**, e isso
dita cada decisão abaixo.

- **O recorte é a SALA (`SalaFaixa`)**, que já é exatamente o trio "sala +
  horário + polo" — a faixa carrega polo, data e hora; a oferta acrescenta a
  sala. Uma folha com a faixa inteira imprimiria sem erro nenhum, e o fiscal da
  SALA 1 receberia uma lista com quem está sentado na SALA 2: chamaria nome de
  quem não está ali e deixaria de conferir quem está. É o oposto do grupo do
  D2L, onde **a sala não entra** porque o acesso ao quiz não depende dela.
- **Uma linha por PESSOA.** A folha é assinada à mão: o mesmo RA duas vezes faria
  o fiscal chamar a mesma pessoa duas vezes e sobrar uma linha em branco no fim,
  parecendo falta de quem estava presente. A deduplicação é por `matrícula`.

  Desde a regra 4b isto é quase só rede de segurança — um RA não consegue mais
  marcar duas provas na mesma faixa —, e duas linhas na mesma sala só existem em
  dado gravado **antes** dela. Vale manter: o relatório não pode depender de o
  histórico estar limpo.

  ⚠️ Nesses casos antigos `totalAlunos` fica **menor** que `ocupadas` em
  `GET /agendamentos/resumo`: a sala tem duas cadeiras tomadas e a folha, uma
  linha. A divergência é o sintoma do dado velho, não erro de contagem — o certo
  é cancelar o agendamento duplicado, não voltar a imprimir duas linhas.
- **Sala sem ninguém agendado não vira página.** Não haverá aplicação ali, e uma
  folha em branco no meio da pilha só faz procurar o erro. Para ver a oferta
  montada, cheia ou vazia, use `GET /agendamentos/resumo`.
- **As colunas são `Nº · RA · Nome · Modalidade · Assinatura`.** A de assinatura
  é uma célula **vazia com borda**: a própria linha da tabela é a linha em que se
  assina — por isso a altura mínima da linha (`ALTURA_MINIMA`) é o espaço que uma
  mão precisa, e não o tamanho da fonte. Nome longo quebra em duas linhas e a
  linha cresce; cortá-lo tiraria justamente o campo pelo qual se confere quem
  assinou. **Não há linha em branco no fim**: a folha é a relação de quem TEM
  lugar ali, e uma linha vazia convida a escrever nela quem não deveria estar.
- **A `Modalidade` da coluna vem do AGENDAMENTO** (fotografia), a do cabeçalho
  vem da OFERTA. São iguais por construção — a alocação só aceita oferta da
  modalidade do aluno —, e é essa redundância que faz a divergência aparecer no
  papel se algum dia existir, em vez de ficar escondida.
- **A ordem dentro da página é alfabética por nome** (`localeCompare` com
  `pt-BR`, senão "ÁLVARO" cairia depois de todo o alfabeto). O fiscal procura
  pela pessoa que está na frente dele, e o que ela sabe dizer é o próprio nome —
  não a matrícula. Quem não tem nome no CSV vai para o fim, ordenado por RA.
- **A ordem das páginas é dia → horário → polo → sala**: a pilha já sai da
  impressora separável por campus, sem ninguém reordenar folha a folha.
- **O cabeçalho se repete em toda página**, inclusive na continuação de uma sala
  grande, marcado `(cont.)`. Folha solta que não diz de que sala, dia e horário
  ela é não serve para nada — e as folhas são distribuídas uma a uma.
- **Nome do arquivo:**
  `Lista de presenca - 11-06-2026 09h00-12h00 - Campus Asa Sul - SALA 1 EAD.pdf`.
  Aqui **o polo entra**, ao contrário do CSV de grupos: as folhas de dois campi
  no mesmo dia e horário vão para lugares físicos diferentes, e sala com o mesmo
  nome em dois polos é comum. Acentos caem pelo mesmo motivo de lá
  (`relatorio/service/nome-de-arquivo.ts`).
- **O logo é OPCIONAL.** `src/relatorio/assets/logo.png` é lido se existir e
  ignorado se não — basta colocar o arquivo lá, nada mais muda
  (`src/relatorio/assets/LEIA-ME.md`). Fazer o relatório inteiro falhar por causa
  de uma imagem ausente seria trocar um documento imperfeito por documento
  nenhum. O `nest build` copia `**/*.png` para o `dist` (`nest-cli.json`).
- **Fonte Helvetica padrão do PDF**, com `WinAnsiEncoding`: cobre Latin-1 inteiro
  e com ele todo acento do português ("VINÍCIUS", "ALARÇÃO", "Câmpus"), sem
  embutir arquivo de fonte no repositório. Caractere fora do Latin-1 exigiria uma
  TTF embutida.
- **A listagem não devolve os alunos**, só a contagem — mesma razão do relatório
  de grupos: milhares de nomes no navegador para exibir um número por linha.

O desenho do PDF está isolado em `relatorio/service/pdf-lista-presenca.ts`
(módulo puro, recebe dados e devolve `Buffer`); as consultas ficam em
`lista-presenca.service.ts`. A separação é o que permite testar layout e
paginação sem banco (`lista-presenca.spec.ts`) e o recorte com banco
(`test/lista-presenca.e2e-spec.ts`).

## Declaração de agendamento: o único documento que o ALUNO baixa

`GET /portal/agendamentos/:id/declaracao` — uma folha A4 declarando que ele está
matriculado sob aquele RA e marcou a prova presencial para tal dia e hora. É o
papel que se leva ao trabalho para justificar a ausência.

Os três documentos da seção anterior são baixados pela **secretaria**; este é o
único que sai pela mão do aluno, no portal, e por isso as regras dele são outras.

### ⚠️ SÓ DEPOIS DE O PRAZO ENCERRAR (regra do cliente)

Enquanto o período está aberto, o aluno ainda troca de horário (regra 7). Uma
declaração emitida ali afirma um dia e uma hora que **o próprio portador pode
mudar cinco minutos depois** — e quem recebeu o papel (empregador, escola)
não tem como conferir. Depois do fechamento só a secretaria remaneja, e o que o
documento diz para de se mover sozinho.

A porta é `PeriodoService.exigirEncerrado()`, **o espelho de `exigirAberto()`**.
As duas leem o mesmo estado de propósito: uma noção própria de "prazo acabou" na
declaração divergiria da do agendamento na primeira vez que alguém mexesse numa
delas.

**`encerrado` NÃO é `!aberto`.** `aberto: false` esconde três estados, e só dois
são encerramento:

| Estado | `aberto` | `encerrado` | Emite declaração? |
|---|:---:|:---:|:---:|
| Prazo correndo | `true` | `false` | não — ele ainda pode trocar |
| Sem período cadastrado | `false` | `false` | não — não há semestre |
| Cadastrado, ainda não abriu | `false` | `false` | não — não há o que declarar |
| Prazo vencido (`dataFechamento`) | `false` | `true` | **sim** |
| Fechado à mão pelo admin (`aberto=false`) | `false` | `true` | **sim** — encerramento antecipado |

`encerrado` é campo de `SituacaoPeriodo`, devolvido por `GET /portal/periodo`, e
é ele que o portal lê para mostrar o botão. Ler `!aberto` na tela mostraria um
botão que só produz 403 num banco recém-migrado.

### O resto das regras

- **O recorte da consulta é o mesmo de `GET /portal/agendamentos`**: matrícula do
  token, vínculo do token, período letivo vigente, `CONFIRMADO`. A declaração
  existe para o que a tela lista. Sem o filtro por matrícula, trocar o número na
  URL imprimiria a prova de outra pessoa **com o nome dela**.
- **404 único** para "não existe", "não é sua" e "cancelada": distinguir os três
  diria a quem sonda a URL quais agendamentos existem, e nenhum dos três tem ação
  diferente para o aluno.
- **Uma declaração por PROVA, não por pessoa.** Quem tem dois cursos faz duas
  provas, em dias diferentes, e cada uma justifica uma ausência diferente — o
  portal oferece o botão nas duas.
- **Sem nome no cadastro, 409.** `AlunoImportado.nome` é opcional, e a queda óbvia
  (usar a matrícula) produziria *"Declaramos que UC26425318 está matriculado(a)
  sob o RA UC26425318"* — um documento que não nomeia ninguém, entregue a um
  empregador. Recusar é acionável: a secretaria corrige o CSV e reimporta.
- **A data é lida em UTC.** `Faixa.data` é `@db.Date` (meia-noite UTC); ler as
  partes no fuso local recuaria um dia em Brasília, e a declaração diria 11 de
  junho para uma prova do dia 12 — impressa e assinada. Mesmo motivo de
  `dataDaProva` e `hojeUtc`. Há teste que trava isso.
- **Os meses são uma lista no código**, não `toLocaleDateString('pt-BR')`: o texto
  vai impresso, e não pode mudar de grafia porque a imagem do Node subiu de versão
  ou veio sem os dados completos do ICU.
- **O layout é o TIMBRADO OFICIAL DA CATÓLICA EAD** para documentos online
  (21/08/2026). Até então era o da "Declaração de Prova" do sistema anterior
  (Avalia/Grupo A), com as coordenadas tiradas do PDF daquele fornecedor — um
  papel que a secretaria reconhecia mas que não seguia a identidade visual da
  instituição. **O texto não mudou nenhuma palavra**: `textoDaDeclaracao` é a
  mesma função, e o teste que a lê continua valendo letra por letra.
- **O timbrado é UMA IMAGEM, e por isso a troca foi barata.** O PDF de origem
  (`EAD - TIMBRADO PARA DOC. ONLINE.pdf`) não tem texto nem vetor: é um único
  PNG A4 de 2000×2830 (~240 dpi, 63 KB), extraído para
  `src/agendamento/assets/timbrado-ead.png` e desenhado de canto a canto como
  fundo, antes de qualquer texto. Não foi preciso `pdf-lib` nem redesenhar arte
  — o `pdfkit` embute PNG truecolor sem recodificar.
- **As medidas do texto saem da arte, não de um gosto.** A margem lateral (46pt)
  é a do endereço no pé do timbrado; a área branca útil vai de ~100pt (fim da
  curva do topo) a ~630pt (onde a curva do rodapé invade pela direita), e é ela
  que limita até onde a assinatura pode descer. O título repete o azul da marca
  (`#283489`, a cor dominante da arte).
- **A assinatura acompanha o fim do parágrafo**, 34pt abaixo dele — não um `y`
  fixo. O documento antigo a ancorava numa altura fixa, e o vão acima dela mudava
  conforme o nome ocupasse duas ou três linhas (e, sem um piso, ela era impressa
  POR CIMA do texto que assina). Medindo a partir do texto, os dois casos saem
  iguais e o piso deixa de existir.
- **O QR code e as duas linhas de validação ficaram de fora**, por decisão do
  cliente: apontavam para o `ValidacaoCertificados` do fornecedor antigo, que não
  existe deste lado. QR que leva a lugar nenhum é pior que nenhum QR, porque
  convida a conferir. O espaço está livre se um dia houver validação própria.
- **A arte vai versionada**, ao contrário do logo da lista de presença, porque é
  a identidade visual que o cliente pediu. A leitura continua tolerante à
  ausência: derrubar o download por causa de um `.png` faltando trocaria um papel
  imperfeito por papel nenhum. O `nest build` a copia para o `dist` pelo mesmo
  `**/*.png` de `nest-cli.json`.
- **A fonte continua Helvetica.** A arte usa outra família, mas ela vem embutida
  na imagem — é pixel, não texto, então não há o que casar. Aproximá-la exigiria
  versionar um `.ttf` e o direito de uso dele.
- **`Content-Type` e `Content-Disposition` vão no `StreamableFile`**, não num
  `@Header` da rota. `@Header('Content-Type', 'application/pdf')` — o jeito das
  rotas de relatório — marcaria também o 403 de prazo aberto e o 404 de prova
  alheia, que são JSON. Aqui isso importa: as recusas são frequentes e esperadas.

O desenho está isolado em `agendamento/service/pdf-declaracao.ts` (módulo puro,
com `textoDaDeclaracao` exportado para o teste ler a frase sem abrir o PDF); as
regras ficam em `declaracao.service.ts`. Testes em `pdf-declaracao.spec.ts`
(frase, meses, fuso) e no bloco `declaracao de agendamento` de
`test/portal-aluno.e2e-spec.ts` (prazo, prova alheia, cancelada).

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

## O admin agenda por UM aluno (etapa 9b)

`POST /agendamentos` — a outra ponta do compulsório: lá é o lote inteiro (recorte
mínimo, o polo), aqui é **uma pessoa**, com o aluno na frente.

É ela que **fecha a fila de trabalho do relatório de exceções**. Cada motivo
dizia o que fazer (`SEM_VAGA` → abrir sala), mas depois de abrir a sala a única
ação existente era redisparar o lote do polo todo: `PATCH /:id/remanejar` exige
um agendamento que já exista e **não cria nenhum**.

Dois destinos, os mesmos do remanejo e pelo mesmo motivo — "quem escolhe a sala"
é uma pergunta só, e duas formas de respondê-la em formatos diferentes virariam
duas telas incompatíveis:

| Corpo | Quem escolhe a sala |
|---|---|
| `{ alunoId, faixaId }` | a alocação sequencial (menor `ordem` até lotar) |
| `{ alunoId, salaFaixaId }` | o admin |

**`alunoId` é o VÍNCULO, não a matrícula** — um RA com dois cursos faz duas
provas, e o id diz de qual delas se trata.

**Tudo fica registrado como ADMIN.** `HistoricoAgendamento` grava `CRIADO` com o
e-mail (é a resposta para "eu nunca marquei essa prova", que aqui é verdade), e
`alocadoManual: true` **sempre** — inclusive quando a alocação escolheu a sala,
porque o que a coluna diz é "isto não saiu do portal do aluno".

### De onde saem as disciplinas, sem launch e sem aluno na frente

O portal descobre pelo JWT; o compulsório, pelo `identidadePorMatricula`. Aqui não
há token nenhum — e `Agendamento.userIdD2L` é coluna obrigatória, então "criar sem
disciplina" não existe como saída. Duas fontes, nesta ordem:

1. **A Valence**, com `D2L_HABILITADO` — a lista de agora, que é a certa.
2. **A reserva ANTERIOR da mesma pessoa no MESMO semestre, cancelada inclusive.**
   Não é chute: é a fotografia que aquele agendamento gravou, com o `userIdD2L`
   que veio do launch dele.

A segunda cobre justamente o caso mais comum do balcão —
`CANCELOU_E_NAO_REMARCOU`, o motivo que o compulsório deixa de fora de propósito
— e funciona com a integração **desligada**, que é o default. `origemDasDisciplinas`
(`BRIGHTSPACE` | `RESERVA_ANTERIOR`) diz qual foi, e `avisos` traz o motivo da
queda. Sem nenhuma das duas, a rota **recusa** com 409.

⚠️ **A busca da reserva anterior é por MATRÍCULA, com o vínculo só como
desempate** — mesma razão pela qual o compulsório consulta a Valence uma vez por
RA: turma não pertence a um curso, então a lista é da PESSOA. Para o segundo
vínculo de quem tem dois, a reserva do outro curso é a única fonte que existe.

### O que ela recusa, e o que ela só avisa

| Situação | Resposta |
|---|---|
| Nenhum ou ambos os destinos | 400 |
| Faixa/oferta de outro polo ou de outra modalidade | 400 (mesma checagem do remanejo) |
| Vínculo, faixa ou oferta inexistente | 404 |
| Aluno já com prova no semestre | 409 — "use o remanejo" |
| A MESMA PESSOA já tem prova nesta faixa | 409 (regra 4b, o admin inclusive) |
| Sala lotada | 409 |
| `statusCurso` que bloqueia | 409, **liberável com `ignorarStatusCurso: true`** |
| Sem disciplina de onde copiar | 409 |
| **Faixa inativa, ou data já passada** | **avisa em `avisos`, não bloqueia** |

As duas últimas linhas são as decisões que mais importam:

- **`ignorarStatusCurso` existe porque não há "avisa e não bloqueia" possível
  antes de gravar** — ou a prova entra, ou não. Recusar é o padrão (igual ao
  portal); liberar é explícito, volta em `avisos` e vai para a auditoria. Sem a
  saída, a secretaria ficaria travada no único caso em que precisa da válvula.
- **Faixa inativa e data passada só avisam.** O portal recusa as duas, e com
  razão: o aluno escolhendo sozinho um horário que já passou só pode ser engano.
  Aqui quem escolhe é a secretaria, e os dois casos têm uso real — registrar quem
  fez a prova sem estar na lista, ou usar uma faixa desativada de propósito para
  sumir do portal. Recusar seria decidir no lugar dela; calar esconderia um erro
  de digitação.

Como o remanejo, **não depende do período estar aberto**.

## Senha das provas (etapa 10)

O que o cliente fazia num CLI separado (`../brightspace-change-passwords`), agora
dentro do portal: trocar o campo `Password` do questionário da prova, em massa,
no Brightspace.

**A operação é uma grade dia × turno.** Manhã/tarde/noite, seis dias de prova,
uma senha de 6 dígitos por célula — a mesma planilha que a secretaria já usava.
A senha de um turno vale para **todas as provas de todas as turmas**.

**Sobrescrever a senha do turno anterior é o OBJETIVO, não efeito colateral.** É
o que impede o aluno da manhã de repassar a senha ao da tarde. Só que isso torna
o lote **frágil quanto à ordem**: rodar a tarde e depois reprocessar a manhã põe
a senha da manhã de volta em toda a instituição. Por isso `forcar` existe e pede
confirmação.

### O que é configuração e o que é `.env`

Duas coisas moram em `configuracao_senha_quiz` (linha única, `id=1`) e são
editadas na tela: **o questionário-alvo** e **os horários de cada turno**. As
duas mudam por semestre, e quem as conhece é a secretaria — deixar qualquer uma
no `.env` significava que trocar o horário de um turno exigia deploy.

**Nenhuma das duas tem valor padrão.** Sem alvo escolhido, `iniciar()` recusa com
400; sem horário, o turno simplesmente não dispara. Um default plausível
("Prova", `07:30`) seria pior que a ausência: rodaria, casaria com o que
estivesse por perto e ninguém saberia até o dia. Foi por isso que
`SENHA_QUIZ_NOME`/`_MATCH` e `SENHA_QUIZ_CRON_MANHA/_TARDE/_NOITE` saíram do
`.env` em 19/08/2026 sem virar constante no código.

Continua no `.env` só o que é **da instância**: `SENHA_QUIZ_CRON_HABILITADO`
(esta réplica dispara?), a tolerância, o teto de tentativas e o ritmo contra a
Valence.

### O conjunto de turmas

```
TurmaImportada (o CSV)  ∩  descendentes do período letivo vigente
```

Decidido com o cliente: **não** se verifica se há agendamento na turma. O
cruzamento com as ofertas do D2L serve para duas coisas e só elas:

1. descobrir o `orgUnitId` — o CSV não o traz, ele é *aprendido* (nos launches, e
   agora também aqui);
2. descartar as linhas de **semestres passados** — a importação faz upsert e
   nunca apaga, então a tabela acumula.

⚠️ **A direção da iteração não é a direção do escopo.** `resolucao-orgunit.service.ts`
itera sobre as ofertas do D2L porque é assim que `turma-match.ts` casa
(`TurmaDoLaunch` → `TurmaCandidata[]`); o conjunto que entra no lote é o das
**linhas do CSV** que casaram. Oferta do semestre que não está no CSV é
**ignorada** — ela não tem prova. Há teste travando exatamente isso.

Como em todo match do projeto, **nada é chutado**: `AMBIGUA` e `DIVERGENTE` não
gravam `orgUnitId` nenhum e viram linha de relatório.

### O PUT substitui o objeto INTEIRO

Não há PATCH em quiz. `GET` → troca só `Password` → `PUT` completo. **Campo não
reenviado é campo apagado** — um erro em `montarCorpoDoQuiz` apaga `EndDate` de
todas as provas do semestre e ninguém descobre até o dia.

A rede é `quiz-body.spec.ts`: um **teste de cobertura contra uma lista congelada
de 35 campos**. Campo novo entra na lista de propósito, nunca por acidente. As
duas conversões leitura→escrita (`AttemptsAllowed` achatado e
`RichText`→`RichTextInput`) estão na §5.7 de `docs/D2L_API_REFERENCE.md`.

### A senha em texto claro fica em UMA coluna

`senha_de_prova.senha`, e em nenhum outro lugar. O D2L exige o valor literal e a
secretaria imprime a folha para os fiscais — hash impossibilita as duas coisas.
A proteção é **em volta**:

- **nunca** em `ExecucaoSenhaQuiz`/`ItemSenhaQuiz`, na auditoria, no `Logger` nem
  no CSV do relatório;
- `descreverSenha()` devolve `'(6 caracteres)'` e é a **única** forma de a senha
  chegar perto de um log — existe para tirar a tentação;
- a listagem da grade devolve `temSenha: boolean`. O valor sai **só** de
  `GET /senhas-de-prova/:id/revelar`, que é auditada em toda chamada e tem
  throttle de rota de credencial. A grade fica aberta num monitor compartilhado
  da secretaria: ver a senha precisa ser um **ato com rastro**;
- `DELETE` apaga a célula, e a execução histórica **sobrevive** (`onDelete:
  SetNull` + data/turno desnormalizados). Apagar o segredo não pode apagar a
  prova de que o lote rodou.

### Dois disparos

**Manual**: `POST /senhas-de-prova/execucoes`, fire-and-forget como o compulsório
(responde com um id, a tela faz polling). **`simulacao: true` é o padrão** e não
emite nenhum PUT — é a única conferência possível antes de mexer na prova de toda
a instituição, e há um teste só para provar que o dry-run emite zero PUT.

**Cron** (`@nestjs/schedule`, primeira fila/cron do projeto): um tick de um minuto
chamando `turnoParaDisparar()`, uma **função pura testada** — e não três `@Cron`
com expressão de horário, porque decorator é avaliado uma vez, na subida. Desde
que os horários passaram a ser **escolhidos pelo admin na tela** (19/08/2026),
isso deixou de ser elegância: salvar `07:30` às 07:25 precisa valer às 07:30, sem
reiniciar nada. A **janela de tolerância** (30 min) faz um restart às 07:41 ainda
aplicar o turno das 07:30.

- **Opt-in por instância**: `SENHA_QUIZ_CRON_HABILITADO` default `false`, mesmo
  com `D2L_HABILITADO` sendo `true`. São coisas diferentes, e trocar senha
  sozinho é irreversível. **Essa chave é a única coisa do cron que ficou no
  `.env`**, e de propósito: ela responde "esta réplica dispara?", não "a que
  horas a prova começa".
- **O cron nunca simula.** Dry-run agendado gera relatório que ninguém lê. A rede
  de proteção equivalente é mais forte: **nada acontece se um humano não tiver
  digitado a senha da célula.**
- **Idempotência no banco**, não em memória: é o que sobrevive ao restart.
  Concluída → sai; viva → sai; morta (5 min sem sinal) → enterra e segue;
  tentativas ≥ 3 → sai (sem esse teto, uma falha permanente bateria no D2L a cada
  minuto pelos 30 min de tolerância).
- **Multi-réplica**: o compose fixa uma réplica. Para subir outra, desligue o cron
  nela.
- **Cron ligado e nenhum horário cadastrado** avisa (`SENHA_QUIZ_CRON_SEM_HORARIO`)
  em vez de calar; e a tela avisa o inverso (horários salvos com o cron desligado
  no servidor). Um cron que *parece* armado e não está é pior que um desligado.
- **A tela precisa enxergar o disparo que não foi dela** (20/08/2026). O manual
  acompanha o lote pelo `id` que o POST devolveu; o do cron não tem dono, e a
  tela ficava **muda** — nem "trocando agora", nem "acabou". Quem estava com a
  grade aberta às 07:30 não via nada mudar, e quem chegava às 10h não tinha como
  responder "a troca da manhã rodou?" sem abrir log de servidor.

  `GET /senhas-de-prova/execucoes/ultima?origem=CRON` é a rota disso, e o filtro
  por origem não é enfeite: sem ele, um lote manual rodado às 09h esconderia o
  resultado das 07:30. Devolve **corpo vazio (200), não 404**, quando nunca
  houve execução — "nunca rodou" é o estado normal de um ambiente recém-configurado
  e a tela precisa distingui-lo de "não consegui perguntar".

  Do lado da tela (`SenhasDeProvaView.vue`), a vigia pergunta a cada 20s (3s
  enquanto o cron roda) e **só a diferença entre duas leituras vira toast** —
  abrir a tela às 10h não pode anunciar a troca das 07:30 como se fosse agora. O
  cartão, esse, mostra sempre. Duas armadilhas que ela evita de propósito: a
  execução do cron **não** entra no mesmo estado do disparo manual (apagaria o
  relatório que o admin está lendo), e a grade **não** se recarrega sozinha
  quando há senha digitada e não salva (`carregarGrade` zera os rascunhos, e a
  secretária veria o campo esvaziar sem ter tocado em nada).

### O resultado que mais dói é o menos barulhento

`QUIZ_NAO_ENCONTRADO` — a turma não tem questionário com o nome configurado — não
é falha de rede nem erro de ninguém, e é uma **turma inteira que não abriria a
prova**. Zero falhas e 40 "não encontrado" é um desastre silencioso. A tela
destaca esse contador tanto quanto `falhas`, e o mesmo vale para
`ORGUNIT_NAO_RESOLVIDO`.

**Revise `GET /senhas-de-prova/turmas` antes do primeiro dia**, não depois: cada
linha em `naoResolvidas` é uma turma que ficaria sem senha.

**Cuidado com `CONTEM`.** "Prova" casa "Prova N1", "Prova N2" e "Prova de
recuperação". O lote não escolhe turma por turma, então um nome genérico troca a
senha de simulados e atividades em toda turma do CSV de uma vez. O dry-run lista
cada questionário casado; use `EXATO` assim que os nomes estiverem padronizados.

### Antes do primeiro dia

1. **Escopo `quizzing:` no consentimento** — acrescentar a `D2L_SCOPES` não basta,
   é preciso `npm run d2l:autorizar`. Sem isso o primeiro PUT volta 403.
2. Confirme com um `GET` depois do `PUT` em homologação: sem a role certa, o D2L
   responde **200 sem gravar nada**.
3. **Meça o tempo do dry-run.** É o número que decide se o horário do cron é cedo
   o bastante — com ~300 turmas o lote leva ~6 min a 10 req/s; com 1.500 passa de
   30 min.

## Datas das provas (etapa 11)

A mesma aba passou a fazer três coisas: trocar a **senha**, mover a **janela de
datas** do questionário e — desde 26/08/2026 — trocar o **grupo** que libera a
prova (ver a seção própria, mais abaixo). No dia da prova a prova fica aberta *só* durante a
sessão corrente, e a senha (que já rodava por turno) continua sendo o segundo
fator. Quem fez a prova das 15h não consegue nem abrir o questionário às 19h.

### ⚠️ A turma NÃO tem modalidade — ela é DERIVADA dos agendamentos

O lote de datas precisa de uma modalidade por turma, porque o calendário é dela:
EaD (3h) cabe em 3 sessões por dia, Semi/Modular (1h30) em 6, Presencial (2h) em
5 — e o questionário tem **uma** janela. Mas `TurmaImportada` não guarda modalidade, e não deve
guardar — é o mesmo argumento que removeu `curso` em 10/08/2026 ("uma turma tem
alunos de VÁRIOS cursos"). Como a modalidade vem do curso, ela o herda.

O único caminho verdadeiro que o modelo oferece:

```
agendamento (CONFIRMADO, periodoLetivoId + rodada vigentes)
  └─ agendamento_disciplina.orgUnitId  ==  turma_importada.orgUnitId
       ⇒ agendamento.modalidadeId
```

`ModalidadeDaTurmaService` faz isso em **uma consulta agregada**, não uma por
turma. `Agendamento.modalidadeId` é fotografia da reserva, e é o certo: a prova
acontece na duração com que foi marcada, mesmo que o aluno tenha trocado de curso
depois. Ler de `aluno_importado` faria a janela mudar por baixo de uma reserva
confirmada — o problema que a migration `snapshot_modalidade_polo_agendamento`
existe para resolver.

**O timing funciona, e não por sorte:** o cron de datas roda nos dias de prova,
com o prazo de agendamento já fechado. É o oposto do lote de senhas, que ignora
agendamentos de propósito.

**Nada é chutado**, como em todo match do projeto:

| Modalidades distintas na turma | Resultado |
|---|---|
| 1 | entra no lote daquela modalidade |
| ≥ 2 | `MODALIDADE_AMBIGUA` — linha de relatório, **nada é gravado** |
| 0 | `SEM_AGENDAMENTO` — linha de relatório |

Não há voto de maioria: o questionário tem uma janela só, e a minoria ficaria sem
conseguir abrir a prova, com o erro aparecendo no dia.

⚠️ **Uma turma ambígua não tem caminho de recuperação automático.** Ela fica com
a data antiga. **Rode `npm run turmas:modalidades` antes do primeiro dia** — ele
mede exatamente isso na base real e sai com código 1 se houver ambiguidade. Se
aparecerem linhas, a correção mínima é uma coluna de modalidade fixada,
preenchida à mão só nessas turmas.

### 🔴 Por que o lote de datas TAMBÉM grava a senha

O caminho óbvio — preservar a senha lida, `Password: quiz.Password`, que é o que
o CLI de origem `../brightspace-change-dates` faz — **apagaria a senha de toda
prova da instituição**.

O `QuizReadData` só expõe `Password` se ele for "não nulo **E** visível ao
contexto do chamador". Ou seja: o GET pode devolver `Password: null` num
questionário **que tem senha**. Como o PUT substitui o objeto inteiro, reenviar
esse nulo apaga o campo — sem erro nenhum, descoberto no dia. É exatamente o
risco que o comentário de `ExecucaoSenhaQuiz.comSenhaLida` já registrava sobre o
CLI de origem, e ele volta no instante em que nasce um lote que *preserva*.

Por isso `montarCorpoDoQuiz` mantém `novaSenha` **obrigatória nos dois lotes**, e
`JanelaDeProva.turno` existe: ele diz de qual célula da grade o lote de datas
tira a senha. **Sem senha cadastrada naquele turno, a janela não é aplicada** —
`DATA_QUIZ_CRON_SEM_GRADE`, que é evento de falha, não aviso.

Consequência aceita (decisão do cliente): a grade continua com **três turnos**, e
em Semi/Modular duas janelas seguidas do mesmo turno dividem a mesma senha. O que
ainda segura o aluno é a própria janela — às 10:30 o questionário das 08:30 já
está fechado.

### Um lote por vez, e por que os dois moram na mesma tabela

Os dois fazem `GET → altera → PUT` no **mesmo** questionário. Rodando em
paralelo, os dois leriam antes de qualquer um gravar e o segundo PUT devolveria o
campo do outro ao valor antigo, em silêncio.

`recusarSeJaRodando()` já serializa tudo **consultando `execucao_senha_quiz`**.
Foi por isso que o `tipo` entrou naquela tabela em vez de nascer uma tabela nova:
com duas tabelas, o guard teria de consultar as duas, e esquecer isso seria
justamente esse bug. Serializados, cada lote faz o próprio GET imediatamente
antes do próprio PUT e preserva verbatim o campo do outro — não há atualização
perdida.

O tick do cron dispara **um** lote por minuto, e a **data vem primeiro**: sem a
janela nova o questionário não abre e ninguém faz a prova; com a senha do turno
anterior por mais um minuto, o pior caso é um aluno usando a senha velha numa
prova que já está aberta para ele. A primeira falha impede a prova, a segunda só
a adianta. Às 12:01 três modalidades têm janela — vão nos minutos seguintes,
dentro da tolerância de 30 min.

### As janelas são configuração de tela

`JanelaDeProva` fica no banco pelo mesmo motivo que os horários dos turnos saíram
do `.env` em 19/08/2026: quem conhece o calendário é a secretaria, e ela não faz
deploy. `janelasParaDisparar` (`janela.ts`, **pura e testada**) é lida a cada
tick, então salvar 15:31 às 15:25 vale às 15:31.

**Diferença deliberada em relação a `ConfiguracaoSenhaQuiz`: aqui HÁ seed.** Um
*nome* de questionário chutado casa com o questionário errado em silêncio; um
*horário* errado não casa com nada — ou o admin o corrige na tela, ou o dry-run o
mostra. Não semear seria pior: um ambiente novo subiria sem janela e o cron nunca
dispararia. O seed **cria o que falta e não sobrescreve** o que a secretaria
ajustou.

`ordem` **não é a ordem do relógio**: a primeira janela é a que dispara à noite
com `diaSeguinte`, armando a prova da manhã seguinte. Sem essa coluna a sessão
das 08:30 teria de ser aplicada de madrugada, quando ninguém está olhando se ela
falhou.

⚠️ **`diaSeguinte` é DERIVADO, não configurado** (25/08/2026). Vale exatamente
`horaDisparo > horaInicio` (`ehDoDiaSeguinte`, em `janela.ts`): se o disparo
acontece depois da hora de abertura, ele **não pode** ser para hoje — não há como
abrir uma prova às 08:30 quando já são 22:01. Foi um checkbox na tela por um dia,
e não havia resposta certa que o admin pudesse dar; marcar "mesmo dia" ali produz
uma prova que abre no passado, que a API aceita e nasce fechada. Fica **gravado**
mesmo sendo derivado, como `AlunoImportado.ativo` — recalculado em toda escrita
(`salvarJanelas` e o seed), e recusado se vier no corpo de um PUT.

### A regra que gera os horários de disparo

```
horaDisparo = fim da janela ANTERIOR + 1 minuto
```

…e a primeira janela do dia é armada na noite anterior, um minuto depois do fim
da **última** — o ciclo fecha em si mesmo. O minuto de folga não é estética: a
janela só pode ser movida depois de a sessão anterior ter **fechado**; disparar
no mesmo minuto do fechamento abriria a prova seguinte com alguém ainda na
anterior, que é o que este recurso existe para impedir.

Vale para os quatro calendários semeados, e é o que permite montar o de uma
modalidade nova sem perguntar a ninguém — basta a lista de janelas em ordem de
relógio. Os semeados hoje:

| Modalidade | Sessões | Disparos |
|---|---|---|
| EaD (3h) | 09:00–12:00 · 15:00–18:00 · 19:00–22:00 | 22:01 (D+1) · 12:01 · 18:01 |
| Semi e Modular (1h30) | 08:30–10:00 · 10:30–12:00 · 14:00–15:30 · 16:00–17:30 · 18:00–19:30 · 20:00–21:30 | 21:31 (D+1) · 10:01 · 12:01 · 15:31 · 17:31 · 19:31 |
| Presencial (2h) | 08:30–10:30 · 11:00–13:00 · 15:00–17:00 · 17:30–19:30 · 20:00–22:00 | 22:01 (D+1) · 10:31 · 13:01 · 17:01 · 19:31 |

**Minutos compartilhados entre modalidades são normais, não conflito.** Às 12:01
disparam EaD, Semi e Modular; às 19:31, Semi, Modular e Presencial; às 22:01, EaD
e Presencial. `janelasParaDisparar` devolve no máximo uma por modalidade e o cron
aplica **uma por tick** — três candidatas entram em três minutos, contra 30 de
tolerância. Há teste travando o pior minuto do calendário real.

### ⚠️ Corrigir o horário de uma janela precisa liberá-la para rodar HOJE

Bug real, 25/08/2026, e o mais instrutivo desta etapa. O admin viu que a janela
do EaD tinha disparado às 12:01 com o horário errado, corrigiu para 12:45 às
12:43 e salvou. Às 12:45 **o cron não fez nada, e nada apareceu no log.**

`salvarJanelas` faz upsert por `(modalidadeId, ordem)`, então a linha editada
**mantém o id**. A checagem de idempotência perguntava "já existe execução
concluída para (janela, dia)?" — e existia, a das 12:01. Ela pulava, em silêncio,
e a correção só passaria a valer no dia seguinte.

`SenhaDeProva` já tinha resolvido exatamente isso com `versao` +
`ExecucaoSenhaQuiz.versaoAplicada`. As janelas nasceram sem, e ganharam o mesmo
remédio: `JanelaDeProva.versao` sobe quando **o horário muda** (não em todo PUT —
salvar o mesmo calendário não pode reprocessar a instituição inteira), e
`versaoAplicada` passou a guardar a versão da **janela** nas execuções `DATA`.

Duas lições que ficaram no código:

- **Um cron que encontra trabalho e não faz nada, calado, é indistinguível de um
  cron quebrado.** `motivoParaNaoDisparar` devolve o motivo em vez de um booleano,
  e o tick registra `DATA_QUIZ_CRON_NADA_A_FAZER` (LOG, não WARN — na maior parte
  dos ticks da tolerância isso é o normal) dizendo qual janela pulou e por quê.
- **`turno` entrou na linha de auditoria das janelas.** É ele que decide de qual
  célula da grade sai a senha; sem ele no log, "por que a janela das 15h não
  rodou?" não tem resposta.

### ⚠️ Os dois lotes NÃO tocam as mesmas turmas

| | Quais turmas alcança |
|---|---|
| Senha | **todas** as turmas do CSV no período letivo vigente |
| Data | só aquelas cuja **modalidade pôde ser derivada** dos agendamentos |

É por isso que uma turma pode receber a senha nova e continuar com a data velha —
e foi o primeiro sintoma real (`GSPS01N20001`, 26/08/2026). Não é falha: é a
regra "nada é chutado" funcionando. Sem modalidade não há janela a escolher, e o
lote prefere deixar a data antiga a abrir a prova no horário de outra modalidade.

Os três caminhos que levam a isso, todos reportados por turma no CSV da execução:
`SEM_AGENDAMENTO`, `MODALIDADE_AMBIGUA`, ou a turma derivou para **outra**
modalidade (aí ela foi tocada, mas por outro disparo, com outra janela).

E o lote de senhas **nunca toca em condição de liberação**: ele alcança todas as
turmas do CSV, sem janela, e trocar o grupo ali apontaria a prova da instituição
inteira para o grupo de uma sessão só.

**`semModalidade` tem o mesmo peso de `naoEncontradas` na tela.** Ficou fora da
contagem de pendências até 26/08/2026, e o efeito foi exatamente o previsto no
comentário daquele contador: uma execução em que *toda* turma caiu em
`SEM_AGENDAMENTO` aparecia verde, com "0 pendência(s)". Nenhum dos quatro é falha
de sistema, e todos significam a mesma coisa para o aluno — a prova não abre no
horário.

### ⚠️ Um minuto de disparo produz VÁRIAS execuções

Às 12:01 disparam três modalidades — EaD (15:00–18:00), Semi e Modular
(14:00–15:30). O tick aplica **uma por minuto**, então saem três execuções em
12:01, 12:02 e 12:03.

Por isso `GET /senhas-de-prova/execucoes/ultima?tipo=DATA` **não serve para a
tela**: ele devolve a terceira delas e esconde as outras duas. Quem abrisse a
aba às 12:03 leria "Janela 14:00–15:30" — sem saber de qual modalidade — e
concluiria que a janela do EaD tinha sido aplicada errada. Foi exatamente o que
aconteceu no primeiro teste real.

A rota da tela é `GET /senhas-de-prova/execucoes/datas-por-modalidade`, que
responde a pergunta que a secretaria faz: **cada modalidade está com a janela
certa?** Uma linha por modalidade com calendário cadastrado; `execucao: null`
significa "nunca rodou", que é o estado normal de quem ainda não teve prova — não
um erro. Pelo mesmo motivo `modalidadeCodigo` entrou no andamento e no nome do
arquivo do relatório: dois downloads do mesmo dia seriam indistinguíveis.

### ⚠️ O disparo da noite lê a célula de AMANHÃ

A última janela do dia arma a primeira sessão da manhã seguinte — às 21:31 de
segunda o servidor grava a janela de terça 08:30. E ele lê a senha da célula
**`(terça, manhã)`**, não da de hoje, porque o PUT substitui o questionário por
inteiro e não pode preservar a senha lida.

Consequência operacional que a grade sozinha não conta: **a senha de amanhã de
manhã precisa estar digitada antes do disparo desta noite.** Esquecer não produz
erro no momento — a prova de amanhã simplesmente amanhece com o horário de ontem,
e a descoberta é às 08:30, com os alunos na frente.

| Cron | Dispara em | Lê a célula de |
|---|---|---|
| Senhas | os 3 horários de turno | o próprio dia |
| Datas — sessões diurnas | 2 a 4 horários | o próprio dia |
| Datas — sessão da noite | 21:31 ou 22:01 | **o dia seguinte** |

Do lado do servidor isso vira `DATA_QUIZ_CRON_SEM_GRADE`, que é **evento de
falha** e não aviso: a janela não foi aplicada. Do lado da tela, a grade destaca
a célula que faltará e explica o prazo enquanto ainda há o dia inteiro para
consertar (`celulasDaVespera`, em `SenhasDeProvaView.vue`).

O aviso é deliberadamente **calado em dois casos**, para não virar ruído que se
aprende a ignorar: quando não há nenhuma senha cadastrada hoje (fora de período
de prova, não há o que cobrar) e quando "amanhã" está fora do intervalo carregado
na grade — ali a célula não foi buscada, e ausência não é vazio.

⚠️ **Presencial só passa a ter efeito quando houver aluno presencial
importado.** A modalidade da turma vem dos agendamentos, e até hoje não houve CSV
na aba Presencial: sem aluno, nenhuma turma resolve para PRESENCIAL e o lote roda
em zero turma — o cron dispara e conclui limpo. Quem mostra a contagem real por
modalidade é `GET /senhas-de-prova/turmas`. O calendário existir antes do
primeiro aluno é o certo; a alternativa seria descobrir no dia da primeira prova
presencial que não havia horário nenhum cadastrado.

### O grupo que libera a prova troca no MESMO disparo (26/08/2026)

Mover a data fecha a prova **pelo relógio**. Mas quem fez a sessão anterior
continua *elegível*: a condição de liberação do questionário aponta para o grupo
daquela sessão, e ela não muda sozinha. O que o cliente fazia à mão no CLI
`../brightspace-change-conditions`, uma vez por turno, agora acontece no mesmo
tick do cron.

**Não virou `TipoExecucaoQuiz.GRUPO`.** É parte do lote `DATA`: mesma janela,
mesmo recorte de modalidade, mesma execução, mesmo relatório. Um terceiro tipo
gastaria mais um tick do cron (que aplica um lote por minuto) e deixaria data e
grupo em execuções separadas, com dois relatórios para uma decisão só — além de
ser mais um lugar onde `recusarSeJaRodando()` poderia ficar cego.

**A troca NÃO passa pelo objeto do quiz.** Condições de liberação são um recurso
do LP (`GET/PUT .../conditionalRelease/conditions/quizzes/{id}`), não um campo do
`QuizData`. Consequência boa: ela não pode apagar `EndDate` nem `Password`, e as
duas escritas falham independentemente. Detalhes da API na §5.8 de
`docs/D2L_API_REFERENCE.md`.

#### As três decisões do cliente

| Pergunta | Resposta | Por quê |
|---|---|---|
| Onde mora o nome do grupo? | **Fixo por janela** (`JanelaDeProva.nomeGrupo`), reusado nos seis dias | Os grupos da instância se chamam "Prova 1/2/3". São ~14 nomes no total; a secretaria reimporta o CSV de alunos no mesmo grupo a cada dia |
| Falha de grupo bloqueia a data? | **Não.** Vira linha de pendência | Sem a data a prova não abre para NINGUÉM; sem a troca de grupo ela abre para o grupo anterior. Bloquear troca o problema menor pelo maior |
| Cria condição onde não há? | **Nunca.** Só troca | Criar uma restrição onde não havia muda o comportamento de uma prova que talvez seja aberta a todos de propósito — e o PUT substitui a lista inteira |

#### ⚠️ O grupo vem ANTES do PUT do quiz, e a ordem não é indiferente

O PUT do quiz é o que **abre** a prova no horário novo. Com o grupo primeiro, o
estado entre as duas escritas é "janela antiga + grupo novo": prova fechada,
inofensivo. Na ordem inversa seria "janela nova + grupo antigo" — a prova
**aberta para a sessão anterior**, que é exatamente o que o recurso existe para
impedir. São dois recursos independentes da API, sem transação possível entre
eles; o que se escolhe é qual estado intermediário se prefere.
`ordemDasEscritas`, no spec, trava isso.

#### NOME, nunca `GroupId`

Cada turma tem os seus próprios grupos, com ids próprios, mesmo com nomes
idênticos: "Prova 2" existe em todas as turmas com um id diferente em cada.
`resolucao-grupo.service.ts` resolve o id turma a turma, com cache **por
execução** — um cache que sobrevivesse entre lotes esconderia um grupo criado às
11h do disparo das 12:01, sem nada no log dizendo por quê.

Nome ambíguo (mesmo nome em duas categorias) é erro duro, como
`ORGUNIT_AMBIGUO` e `MODALIDADE_AMBIGUA`: o homônimo errado liberaria a prova
para o turno errado, e o erro só apareceria no dia.

**A comparação é normalizada** (sem acento, sem caixa, sem espaço duplo) — ao
contrário de `casarPorNome`, que compara nome de *questionário* literalmente. São
duas regras com dois motivos: lá afrouxar casaria o quiz errado num universo de
dezenas; aqui um falso negativo é uma turma inteira ficando com a condição da
sessão anterior. Hífen e pontuação **não** são normalizados: isso é conteúdo.

#### ⚠️ `gruposPendentes` tem o mesmo peso de `naoEncontradas`

É a mesma lição de 26/08/2026 sobre `semModalidade`, um nível adiante: ali a prova
**abre no horário certo** e o contador de falhas fica em zero, mas ela continua
liberada para a sessão anterior. Sem esse contador nas pendências da tela, uma
execução em que *todo* grupo falhou apareceria verde.

**Como toda turma já tem todos os grupos criados** (decisão do cliente), zero é o
estado normal: qualquer valor acima disso é anomalia de cadastro — nome digitado
errado na janela, ou grupo que faltou ser criado numa turma. O `detalhe` do item
lista os grupos que existem naquela turma, para distinguir os dois casos.

#### Detalhes que vão custar tempo se esquecidos

- **`nomeGrupo` e `categoriaGrupo` SOBEM a `versao` da janela.** Mesmo bug de
  25/08/2026 num campo novo: corrigir um nome errado às 12:43, depois do disparo
  das 12:01, não reprocessaria nada em silêncio. Só valeria no dia seguinte — com
  a prova aberta para a sessão anterior o dia inteiro.
- **Vazio vira `null`, nunca `""`.** Um `"  "` salvo por engano passaria pela
  checagem de "tem grupo?" e produziria uma pendência por turma sem nada estar
  configurado.
- **`groups:group:read` precisa de REAUTORIZAÇÃO.** O escopo vive no
  consentimento: acrescentar ao `.env` não muda nada sem `npm run d2l:autorizar`.
  Sem ele, o lote aplica as datas e reporta `FALHA_AO_LER_CONDICOES` em toda
  turma — e nada nas falhas acusa.
- **LP >= 1.49**, senão as rotas devolvem **404 com corpo vazio**, indistinguível
  de "questionário não existe". `D2lCondicoesService` recusa na primeira chamada.
- **`condicoesAnteriores` é o único desfazer.** O PUT substitui tudo e a API não
  guarda histórico. Gravado também no dry-run — é nele que se descobre o que a
  prova tem hoje.
- **O lote de SENHAS nunca toca em condições.** Ele alcança TODAS as turmas do
  CSV, sem janela; trocar a condição ali apontaria a prova da instituição inteira
  para o grupo de uma sessão só.

### Detalhes que já custaram tempo

- **Sempre UTC-`Z` nas datas.** `instanteUtcDe` (`relogio.ts`) pergunta o
  deslocamento ao ICU para *aquela* data — nunca `-3` cravado. `-03:00` é
  recusado por endpoints da Valence com `400 Invalid Parameters`, e um `""` numa
  data devolve **500**.
- **`DueDate` é preservado.** O cliente pediu abertura e fechamento; mover o
  prazo de entrega mudaria a nota de quem entregou atrasado.
- **`turno` e `versaoAplicada` são NULOS em execuções `DATA`.** Gravar um turno
  "plausível" faria a célula da grade parecer aplicada antes de o turno dela ter
  rodado — por isso `GradeSenhasService.listar` filtra `tipo: SENHA`.
- **A "exibir data" (results view) ficou de fora**: no CLI de origem ela é um
  `PATCH` num microserviço Siren separado (`quizzes.api.brightspace.com`), com o
  host tirado do claim `tenantid` do JWT. Segunda integração, e o cliente não
  pediu.

## Ao implementar, priorize nesta ordem

1. ✅ Prisma schema + migrations + Docker + seed do admin.
2. ✅ Auth (admin JWT + LTI aluno).
3. ✅ Importação dos 2 CSVs (alunos, turmas) + seed de polos.
4. ✅ Estrutura (polo/sala/faixa/sala-faixa).
5. ✅ Portal do aluno (listar faixas + agendar com alocação sequencial).
6. ✅ Período de agendamento + relatório (consulta, ocupação por sala, CSV).
7. ✅ Remanejo e cancelamento administrativos + troca de horário pelo aluno.
   O cancelamento **pelo aluno** existiu e foi removido em 17/08/2026 (regra 7).
8. ✅ Valence: OAuth + enrollments (todas as disciplinas do semestre), **ligados
   por padrão desde 18/08/2026**. Special access no quiz — **adiado pelo cliente.**
9. ✅ Agendamento compulsório: o lote que agenda por quem não agendou, com
   simulação, acompanhamento e relatório de exceções. **Exige `D2L_HABILITADO`**
   — é a integração que sabe as disciplinas de quem nunca fez launch.
9b. ✅ Agendamento administrativo de UM aluno (`POST /agendamentos`): o
   atendimento de balcão que fecha a fila de exceções do compulsório. Funciona
   **sem** `D2L_HABILITADO` quando o aluno tem reserva anterior no semestre.
10. ✅ Senha das provas: a grade dia × turno e o lote que troca o campo
   `Password` dos questionários no Brightspace, manual e por cron. **Exige
   `D2L_HABILITADO`** e escopo `quizzing:` no consentimento OAuth.
11. ✅ Datas das provas (25/08/2026): o mesmo lote passa a mover
   `StartDate`/`EndDate` do questionário, por **modalidade**, em até 6 janelas
   por dia. A modalidade da turma é **derivada dos agendamentos** — não há, e não
   deve haver, coluna para ela. Ver "Datas das provas".

**Bloqueios externos:** o consentimento OAuth precisa incluir
`quizzing:quizzes:read quizzing:quizzes:write` — acrescentar ao `D2L_SCOPES` não
basta, é preciso **reautorizar** (`npm run d2l:autorizar`), senão o primeiro PUT
de senha volta 403. O CSV real de turmas
(`Curso;Código da Turma;Disciplina / Código EAD`, `;`, UTF-8) é quem diz **quais
turmas têm prova**. Em 07/08/2026 o match passou a usar o **`Code` composto** do
Brightspace (código da turma + código da disciplina), portado do
`../brightspace-orgunits` — sem isso o caminho dos enrollments não achava turma
nenhuma. O special access continua adiado pelo cliente.

**Aceito conscientemente:** com `D2L_HABILITADO=true`, o aluno de dois vínculos
na mesma matrícula leva as disciplinas dos dois cursos em cada agendamento — são
2 em 7519. Ver "Turma NÃO pertence a um curso".
