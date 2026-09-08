# Referência da API Brightspace (D2L) — Portal de Agendamento de Provas

Documento técnico para o Claude Code implementar a integração com o Brightspace.
Cobre autenticação, os endpoints usados, formatos de dados, e as regras/armadilhas
descobertas. Fontes: Valence API docs (docs.valence.desire2learn.com) e D2L Community.

> **Versão da API validada:** LE/LP **v1.82+** (LMS 20.25.1+). Rotas de quiz
> anteriores a 1.82 estão deprecadas/obsoletas — use 1.82 ou superior nas URLs.
> **Tenant de teste:** `catolicatest.brightspace.com`.

---

## 1. Visão geral: o que a integração faz

O backend fala com o Brightspace em dois momentos:

1. **Entrada do aluno (LTI 1.3)** — o Brightspace autentica o aluno e manda um
   `id_token` (JWT) com matrícula, papel e o `user_id` Valence. O backend só valida
   e lê; não chama a API REST aqui.
2. **Leitura e escrita via Valence API (REST, OAuth 2.0)** — server-to-server:
   - **Ler** as disciplinas em que o aluno está matriculado (para cruzar com as
     turmas reais e o período letivo).
   - **Gravar** o special access de cada disciplina agendável (libera a prova).

O item 2 é o que este documento detalha. O LTI 1.3 tem sua própria seção (§6).

---

## 2. Autenticação OAuth 2.0 (server-to-server)

O Brightspace oferece **dois caminhos** de OAuth 2.0 M2M. Escolha conforme o que o
tenant da UCB tiver habilitado — a documentação deve suportar ambos, com o
**Client Credentials + Service User** como preferido quando disponível.

### 2.1 (Preferido) Client Credentials Grant + Usuário de Serviço

Fluxo moderno M2M, **sem usuário humano, sem refresh token**. Introduzido para
cargas máquina-a-máquina. Como funciona:

- Cria-se um **Usuário de Serviço** no Brightspace (identidade não-humana), com
  permissões de menor privilégio atribuídas por papel/role.
- Registra-se um app OAuth 2.0 com **JWT Client Assertion**: o app assina um JWT
  curto com sua **chave privada**; o Brightspace valida com as **chaves públicas**
  (JWKS) registradas.
- O app pede um token com `grant_type=client_credentials` + a client assertion.
- O Brightspace devolve um **access token de curta duração** (não renovável — pede
  outro quando expira). As chamadas usam as permissões do Usuário de Serviço.

Vantagens: sem segredos compartilhados, sem refresh token para guardar, tokens
curtos. É o fluxo recomendado pela D2L para integrações automatizadas.

**Implementação (cliente):**
- Gerar par de chaves (RSA/EC); expor o JWKS público num endpoint OU registrar a
  chave pública no app.
- Montar a client assertion (JWT) com claims padrão (iss, sub, aud, exp, jti…),
  assinada com a chave privada.
- `POST` no token endpoint do tenant com `grant_type=client_credentials`,
  `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer`,
  `client_assertion=<JWT>`, e os `scope` necessários (§3).
- Cachear o access token até expirar; renovar sob demanda.

### 2.2 (Alternativa) Authorization Code + Refresh Token

Fluxo tradicional, caso o tenant ainda não tenha Usuários de Serviço habilitados.
Um humano autoriza uma vez e o backend guarda o **refresh token** para rodar sem
interação depois.

- Endpoint de autorização: `https://auth.brightspace.com/oauth2/auth`
- Endpoint de token: `https://auth.brightspace.com/core/connect/token`
- Fluxo:
  1. Redireciona o usuário para `auth` com `response_type=code`, `client_id`,
     `redirect_uri`, `scope` e `state`.
  2. Recebe o `code` no `redirect_uri`; troca por tokens no endpoint de `token`
     (`grant_type=authorization_code`).
  3. Guarda o **refresh token** com segurança. Usa `grant_type=refresh_token` para
     obter novos access tokens.
- **Importante (rotação):** cada refresh gera um **novo refresh token**; o antigo é
  invalidado. Persista sempre o mais recente, senão perde o acesso.

### 2.3 Uso do access token

Em qualquer dos fluxos, as chamadas REST levam o header:

```
Authorization: Bearer <access_token>
```

### 2.4 Configuração no código (env)

```
# OAuth D2L (Client Credentials — preferido)
D2L_TOKEN_URL=https://auth.brightspace.com/core/connect/token
D2L_CLIENT_ID=...
D2L_CLIENT_ASSERTION_KEY=...     # chave privada (ou caminho); NUNCA no git
D2L_SCOPES=...                    # ver §3
D2L_BASE_URL=https://catolicatest.brightspace.com
D2L_API_VERSION_LP=1.62           # orgstructure, enrollments — ver aviso abaixo
D2L_API_VERSION_LE=1.82           # quizzes (1.82+ obrigatório)
```

> **A versão é POR PRODUTO, e o teto é do TENANT.** `lp` e `le` numeram em ritmos
> diferentes: em `ava.catolica.edu.br` (11/08/2026) o `lp` ia até **1.62** e o `le`
> até **1.96**. Usar 1.82 no `lp` devolve **404 com corpo vazio** — sem `error`,
> sem mensagem —, e o sintoma chega ao portal como "o aluno não tem disciplina".
> Confira os limites em `GET {D2L_BASE_URL}/d2l/api/versions/` (rota pública, não
> exige token) antes de subir qualquer uma das duas.

```

# OAuth D2L (Authorization Code — alternativa)
D2L_REFRESH_TOKEN=...             # persistir rotacionado
D2L_CLIENT_SECRET=...
```

---

## 3. Scopes OAuth necessários

Peça só o mínimo. Para este projeto:

| Necessidade | Scope | Endpoints |
|---|---|---|
| Ler matrículas do aluno | `enrollment:orgunit:read` | enrollments/users/.../orgUnits/ |
| Ler a própria matrícula (alt.) | `enrollment:own_enrollment:read` | enrollments/myenrollments/ |
| Ler quiz (GET antes do PUT) | `quizzing:quizzes:read` | quizzes/, quizzes/(quizId) |
| **Trocar a senha do quiz** (§5.7) | `quizzing:quizzes:write` | **PUT** quizzes/(quizId) |
| Gravar special access | `quizzing:quizzes:write` | quizzes/(quizId)/specialaccess/(userId) |
| Ler special access (verificação) | `quizzing:quizzes:read` | quizzes/(quizId)/specialaccess/ |
| **Ler a nota final e a N1** (§4.5) | `grades:gradevalues:read` | grades/final/values/, grades/(gradeObjectId)/values/ |
| **Achar a categoria N1** (§4.5) | `grades:gradecategories:read` | grades/categories/ |

String de exemplo (ajuste conforme o app):
```
enrollment:orgunit:read quizzing:quizzes:read quizzing:quizzes:write
```

> **O escopo vive no CONSENTIMENTO, não no `.env`.** Acrescentar `quizzing:*` a
> `D2L_SCOPES` não muda nada sozinho: o refresh token gravado em `integracao_d2l`
> carrega os escopos que foram autorizados no dia. Sem **reautorizar**
> (`npm run d2l:autorizar`), o primeiro `PUT` volta **403** — e o erro parece
> problema de permissão de conteúdo, não de escopo.

> **Armadilha de permissão (crítico):** o token OAuth dá o *scope*, mas quem executa
> a chamada é o **Usuário de Serviço** (ou o usuário do refresh token). Se esse
> usuário não tiver o **papel/role com permissão** no nível de org unit certo, a API
> pode retornar **HTTP 200 com dados silenciosamente incompletos** (ex.: enrollments
> faltando) em vez de 403. Garanta que o usuário de serviço tenha a role adequada
> na hierarquia. Valide contra um caso conhecido.

---

## 4. Ler as disciplinas do aluno (enrollments)

### 4.1 Endpoint principal

```
GET /d2l/api/lp/(version)/enrollments/users/(userId)/orgUnits/
Scope: enrollment:orgunit:read
```

- `(version)` = versão LP (ex.: `1.82`).
- `(userId)` = o **user_id Valence** do aluno (vem no `id_token` LTI — ver §6).
- Retorna as unidades organizacionais em que o usuário está inscrito, paginadas
  (bookmark). Cada item traz o `OrgUnit` (Id, Type, Name, Code) e o papel.

### 4.2 Filtrar só "Course Offering" do período vigente

O retorno inclui vários tipos de org unit (semestre, curso, oferta…). Interessam
as **ofertas de disciplina** (Course Offering) que descendem do **Período Letivo**
vigente.

- **Tipos de org unit no tenant da UCB (validados no Postman):**
  - `Course Offering` → **Type Id 3**
  - `Período Letivo` (custom) → **Type Id 103** (o Semester padrão, Id 5, não é
    usado neste tenant)
- Fluxo de cruzamento:
  1. Pega enrollments do aluno (este endpoint) → lista de orgUnits tipo 3.
  2. Pega os descendentes do Período Letivo vigente (o `periodoLetivoId` que o
     admin definiu) para saber quais ofertas pertencem ao período atual.
  3. Interseção: `enrollments ∩ descendentes-do-período ∩ turmas-reais-CSV` =
     disciplinas agendáveis.

### 4.3 Armadilha de tipos (número vs string)

O `OrgUnit.Id` vem como **número** no retorno de enrollments, mas como **string**
(`Identifier`) no retorno de descendentes/estrutura. **Normalize os dois para o
mesmo tipo (string) antes de comparar**, senão a interseção falha silenciosamente.

### 4.4 Endpoints auxiliares de estrutura (se necessário)

```
GET /d2l/api/lp/(version)/orgstructure/(orgUnitId)/descendants/
GET /d2l/api/lp/(version)/enrollments/orgUnits/(orgUnitId)/users/(userId)   # checar 1 aluno
```

---

### 4.5 Ler a nota final e a N1 (os critérios de nota da rodada)

Quem usa: `src/d2l/service/d2l-grades.service.ts` (cliente REST) e
`src/agendamento/service/elegibilidade-de-nota.service.ts` (a regra). É o que
decide **quem pode fazer a prova substitutiva**: só entra na prova a disciplina
em que o aluno passa nos **dois** critérios cadastrados no período —
`N1 >= notaMinimaN1` **e** `nota final calculada < notaMaximaFinal`.

⚠️ **São DUAS leituras desde 08/09/2026.** Até então bastava a nota final (os
dois limites comparavam ela). A N1 é a nota nova, e ela **não tem rota própria**.

⚠️ **É produto LE, não LP** — a versão é a `D2L_API_VERSION_LE` (1.82), não a do
`lp`. Mesma armadilha do §4.2 ao contrário: número certo no produto errado dá
**404 com corpo vazio**, e o sintoma parece "o aluno não tem nota".

```
GET /d2l/api/le/(version)/(orgUnitId)/grades/final/values/(userId)      # final, um aluno
GET /d2l/api/le/(version)/(orgUnitId)/grades/final/values/              # final, a turma (paginado)
GET /d2l/api/le/(version)/(orgUnitId)/grades/categories/                # onde mora a N1
GET /d2l/api/le/(version)/(orgUnitId)/grades/(gradeObjectId)/values/(userId)  # N1, um aluno
GET /d2l/api/le/(version)/(orgUnitId)/grades/(gradeObjectId)/values/    # N1, a turma (paginado)
GET /d2l/api/le/(version)/(orgUnitId)/grades/                           # os grade objects
```

#### A N1 é uma CATEGORIA, e o id dela muda de turma para turma

Uma categoria de notas (N1, N2, N3) é, ela mesma, um *grade object* endereçável —
de um tipo específico:

```
GradeObjectType = 9  →  "Category"
```

Ou seja: o **mesmo** `grades/(gradeObjectId)/values/` que lê um item numérico lê
também uma categoria, devolvendo a mesma estrutura (`PointsNumerator`,
`PointsDenominator`, `DisplayedGrade`, mais `GradeObjectType: 9` e
`GradeObjectTypeName: "Category"`). O que muda é só o id.

E é aí que está a armadilha: **o `CategoryId` da N1 é diferente em cada turma.**
Não existe um número da "N1" que sirva para o tenant. Por isso são duas etapas:

```
GET .../grades/categories/            →  [{ CategoryId: 4231, Name: "N1" }, ...]
                                                  ↓
GET .../grades/4231/values/(userId)   →  a N1 daquele aluno naquela turma
```

O único elo estável entre a regra e o tenant é o **nome** da categoria, e é por
isso que ele é configurável (`D2L_CATEGORIA_N1`, default `"N1"`). A comparação
ignora caixa, acento e espaços nas pontas — mas **não** adivinha: `"Nota 1"` não
casa com `"N1"`, e a turma que nomear assim recusa **todos** os seus alunos
(motivo `SEM_CATEGORIA_N1`, com um aviso por turma no log listando os nomes que
ela tem).

| Decisão | Por quê |
|---|---|
| Descoberta por **nome**, não por id fixo | O `CategoryId` muda por turma; um id cravado leria o item errado, ou nenhum, sem erro aparecer |
| Cache de 5 min do `CategoryId`, **inclusive do "não achei"** | Sem o cache negativo, cada aluno de uma turma mal nomeada custaria uma listagem inteira de categorias |
| **404 → `null`** (turma sem categorias), **403 SOBE** | São opostos: 404 é uma turma; 403 é o consentimento sem `grades:gradecategories:read`, e atinge TODAS — traduzi-lo para "turma sem N1" mandaria o curso inteiro à secretaria por um `npm run d2l:autorizar` que falta |
| Só **leitura** | Categorias (tipo 9) e a nota final calculada não aceitam `PUT`: o `IncomingGradeValue` só vale para os tipos 1–4 (Numérico, Aprovado/Reprovado, Caixa de Seleção, Texto). Elas são sempre recalculadas a partir dos itens que as compõem — o que não nos afeta, aqui só se lê |
| A conferência de escala (`PointsDenominator ≠ 10`) **não** roda na N1 | O aviso fala de semestre com notas por lançar, e o denominador de uma N1 só diz quanto ela vale naquela turma |

Resposta de um aluno (campos que importam):

```json
{
  "DisplayedGrade": "58 %",
  "GradeObjectName": "Nota Calculada Final",
  "PointsNumerator": 5.8,
  "PointsDenominator": 10
}
```

| Decisão | Por quê |
|---|---|
| Compara **`PointsNumerator`** (pontos), não o percentual | Decisão do cliente. Os limites (N1 ≥ 1,5 e final < 7) são em pontos, na mesma escala da nota que o aluno vê |
| **404 = `SEM_NOTA`**, não erro | Turma sem notas fechadas e aluno que saiu da turma respondem 404. É o segundo ponto do projeto a usar `nuloEm404`, junto de `users/?orgDefinedId=` |
| **`PointsNumerator` nulo = `SEM_NOTA`**, nunca 0,00 | Zero poria o curso inteiro abaixo do piso, e ninguém reclama de uma prova que não lhe foi oferecida |
| A listagem por turma **segue a paginação até o fim**, e **estoura** se não terminar | Meia turma lida é pior que erro: os alunos que faltaram viram "sem nota", e sem nota ninguém agenda. Vale igual para a N1 — é o mesmo código |
| A nota **final** é lida primeiro; a N1 só depois | A maioria dos alunos passou de ano e sai no primeiro critério: checar a N1 antes faria o portal pagar duas chamadas por disciplina para todo mundo |
| `PointsDenominator ≠ 10` só **avisa** no log | A comparação é em pontos, e um denominador menor quase sempre significa que o semestre ainda está correndo (com só a N1 lançada, a "Nota Calculada Final" vale 4,5) |

**Calculada × Ajustada.** A rota devolve **uma** nota final por aluno, e
`GradeObjectName` diz qual é ("Nota Calculada Final" / "Nota Ajustada Final", no
idioma do tenant). O cliente lê esse nome e o expõe como `origem`
(`AJUSTADA` · `CALCULADA` · `DESCONHECIDA`) — informação de diagnóstico, não um
seletor. Confira com um aluno que **tenha** nota ajustada lançada:

```
npm run d2l:notas -- <orgUnitId> <userId>
```

Esse script também resolve a **categoria N1** da turma e imprime o `CategoryId`
(ou explica que ela não existe). Rode-o em algumas turmas antes de abrir a
janela: a turma sem categoria "N1" é a pendência que este recurso mais produz, e
em produção o único sinal dela é uma linha de `WARN` no log.

Se toda turma responder `CALCULADA` mesmo com ajustadas lançadas, a leitura
precisa passar a buscar o grade object ajustado em `GET /grades/` +
`GET /grades/(gradeObjectId)/values/(userId)` — o que exige também
`grades:gradeobjects:read`. O ponto de mudança é um método só
(`D2lGradesService.notaFinal`); a regra de negócio não muda.

**Escopos:** `grades:gradevalues:read` (os valores) e
`grades:gradecategories:read` (a listagem de categorias, para achar a N1). Vale o
mesmo aviso do §3 — eles vivem no consentimento. Sem reautorizar, o GET
correspondente volta **403**, e como o filtro é *fail-closed*, **ninguém**
consegue agendar a substitutiva.

---

## 5. Gravar o Special Access no quiz (liberar a prova)

Este é o efeito final do agendamento: para cada disciplina agendável, dar ao aluno
acesso especial ao quiz da prova, com a janela de data/hora da faixa escolhida.

### 5.1 Descobrir o quiz da disciplina

```
GET /d2l/api/le/(version)/(orgUnitId)/quizzes/
Scope: quizzing:quizzes:read
```
Retorna a lista de quizzes da oferta (`QuizReadData`). Selecione o quiz da prova
(por nome/convenção combinada com a UCB). Guarde o `QuizId`.

### 5.2 (Recomendado) GET antes de qualquer PUT no quiz

Se for **atualizar o quiz inteiro** (`PUT .../quizzes/(quizId)`), lembre: **o PUT
substitui o objeto todo**. Faça `GET` antes, altere só os campos necessários, e
mande o objeto completo de volta. (Para special access isso não se aplica — veja
5.3, que é um recurso à parte.)

### 5.3 Criar/atualizar o Special Access do aluno

```
PUT /d2l/api/le/(version)/(orgUnitId)/quizzes/(quizId)/specialaccess/(userId)
Scope: quizzing:quizzes:write
```

**Corpo (Quiz.SpecialAccessData):**
```json
{
  "StartDate": "2025-07-20T11:30:00.000Z",
  "EndDate":   "2025-07-20T14:30:00.000Z",
  "DueDate":   null,
  "SubmissionTimeLimit": {
    "IsEnforced": true,
    "TimeLimitValue": 180
  },
  "AttemptsAllowed": {
    "IsUnlimited": false,
    "NumberOfAttemptsAllowed": 1
  }
}
```

- **Datas em UTC** (sufixo Z). Converta o horário local da faixa para UTC antes de
  enviar. Ex.: faixa 08:30–11:30 (Brasília, UTC-3) → 11:30–14:30 UTC.
- `TimeLimitValue` em **minutos** (0–9999). Use a duração da modalidade (EaD 180,
  Semi/Modular 90, Presencial 120) OU a janela da faixa — alinhe a regra com a UCB.
- `SubmissionTimeLimit` e `AttemptsAllowed` podem ser `null` para "não sobrescrever".
- É **idempotente por usuário**: o PUT cria se não existe, atualiza se já existe.
  Reprocessar a fila não duplica.

### 5.4 Status codes e o 404 esperado

| Código | Significado | Ação no sistema |
|---|---|---|
| 200 | Special access gravado | marca sync `CONCLUIDO` |
| 400 | Dados inválidos (datas, limites) | `FALHOU`; logar corpo; não re-tentar cego |
| 403 | Sem permissão (role do usuário de serviço) | `FALHOU`; alerta de config |
| **404** | **Org unit/quiz/user não encontrado, OU usuário não pode receber special access** | **`NAO_MATRICULADO`** — estado ESPERADO quando o aluno não está matriculado como estudante naquela oferta. NÃO é erro; apenas ignora essa disciplina. |
| 429 | Rate limit excedido | back-off e re-tentar (§7) |

> O 404 é o ponto mais importante: o cruzamento pode indicar uma disciplina que,
> na prática, não tem o aluno matriculado como estudante naquele quiz. Tratar como
> `NAO_MATRICULADO` e seguir, sem falhar o agendamento inteiro.

### 5.5 Verificar (opcional)

```
GET /d2l/api/le/(version)/(orgUnitId)/quizzes/(quizId)/specialaccess/(userId)
Scope: quizzing:quizzes:read
```
Retorna o `SpecialAccessData` gravado — útil para conferir após o PUT.

### 5.6 Remover (cancelamento de agendamento)

```
DELETE /d2l/api/le/(version)/(orgUnitId)/quizzes/(quizId)/specialaccess/(userId)
Scope: quizzing:quizzes:delete
```
Se o aluno cancelar/for remanejado, remova o special access antigo.

### 5.7 Trocar a senha do questionário (`PUT .../quizzes/(quizId)`)

**Este e a §5.8 são os trechos da §5 que o portal implementa hoje**
(`src/senha-quiz/`). Special access continua não implementado — ver §9.

```
GET /d2l/api/le/(version)/(orgUnitId)/quizzes/          Scope: quizzing:quizzes:read
GET /d2l/api/le/(version)/(orgUnitId)/quizzes/(quizId)  Scope: quizzing:quizzes:read
PUT /d2l/api/le/(version)/(orgUnitId)/quizzes/(quizId)  Scope: quizzing:quizzes:write
```

O campo é `Password` (string) do `QuizData`. Senha vazia (`""`) significa quiz
**sem** senha.

#### O PUT substitui o objeto INTEIRO

Não existe PATCH. **Campo que você não reenviar é campo apagado** — um erro aqui
apaga `EndDate` ou `SubmissionTimeLimit` de todas as provas do semestre, e
ninguém descobre até o dia. Por isso o fluxo é sempre:

```
GET quizzes/(quizId)  →  troca SÓ Password  →  PUT com o objeto completo
```

`src/senha-quiz/service/quiz-body.ts` faz essa remontagem, e
`quiz-body.spec.ts` tem um **teste de cobertura de campos** contra uma lista
congelada de 35 nomes. Se você acrescentar um campo ao corpo, acrescente à lista;
se o D2L acrescentar um, o teste é quem avisa.

#### As duas conversões leitura→escrita

O objeto que o GET devolve **não é** o objeto que o PUT aceita. Duas formas mudam:

| Leitura (`QuizReadData`) | Escrita (`QuizUpdateData`) |
|---|---|
| `AttemptsAllowed: { IsUnlimited, NumberOfAttemptsAllowed }` | `NumberOfAttemptsAllowed` **achatado** (número) |
| `RichText: { Text, Html }` | `RichTextInput: { Content, Type }` — `Html` preferido; `Type` vira `"Html"` ou `"Text"` |

Vale para `Description`, `Header`, `Footer` e afins. Reenviar a forma de leitura
não dá erro — o campo simplesmente vira `null`.

#### `GET quizzes/` é paginado

A resposta é um `ObjectListPage` com `Objects` e `Next`. **Siga o `Next`**
reaproveitando só a query string (o bookmark). Ignorá-lo não dá erro: a prova
simplesmente não aparece na lista, e aquela turma fica sem senha em silêncio.
O cliente (`src/d2l/service/d2l-quizzes.service.ts`) tem trava de número máximo
de páginas e trava de bookmark repetido.

#### A senha invisível

O `GET` pode devolver `Password` **vazio mesmo quando o quiz tem senha** — a API
esconde o campo em algumas versões/configurações. No portal isso é apenas
**diagnóstico** (`comSenhaLida` na execução), porque o lote **sempre define** e
nunca preserva. **Não construa regra de negócio em cima desse sinal.**

#### 200 sem efeito

O escopo vem do token, mas quem executa é o usuário dono do refresh token (§3).
Sem a role de edição de questionários no nível certo, o D2L pode responder **200
sem gravar nada**. Confirme com um `GET` depois do `PUT` pelo menos uma vez em
homologação.

### 5.8 Trocar o GRUPO que libera a prova (`conditionalRelease`)

**Implementado desde 26/08/2026** (`src/d2l/service/d2l-condicoes.service.ts` +
`src/senha-quiz/service/condicoes.ts`). Roda no MESMO disparo que aplica a janela
de datas — ver "Datas das provas" no CLAUDE.md.

Mover a data fecha a prova pelo relógio, mas quem fez a sessão anterior continua
*elegível* pela condição de liberação do questionário, que aponta para o grupo
daquela sessão. Esta é a metade que fecha essa porta.

```
GET  /d2l/api/lp/(version)/(orgUnitId)/groupcategories/
GET  /d2l/api/lp/(version)/(orgUnitId)/groupcategories/(categoryId)/groups/
GET  /d2l/api/lp/(version)/(orgUnitId)/conditionalRelease/conditions/quizzes/(quizId)
PUT  /d2l/api/lp/(version)/(orgUnitId)/conditionalRelease/conditions/quizzes/(quizId)
```

Scopes: `groups:group:read` para as duas primeiras; `conditionalRelease` não tem
scope documentado e é coberta por `core:*:*`.

#### ⚠️ É **LP**, e o mínimo é 1.49

As quatro rotas não existem antes disso (1.45 e anteriores estão obsoletas). Uma
LP baixa **não** devolve 400 explicando: devolve **404 com corpo vazio**,
indistinguível de "questionário não existe". `D2lCondicoesService` recusa na
primeira chamada, dizendo onde conferir. Este tenant está em 1.62.

#### As condições NÃO são campo do `QuizData`

É um recurso separado do LP. Consequência boa: a troca de grupo **não passa pelos
35 campos de `montarCorpoDoQuiz`** e não pode apagar `EndDate` nem `Password`. As
duas escritas falham independentemente — e é isso que sustenta a regra "falha de
grupo não bloqueia a data".

#### O PUT substitui a lista INTEIRA de condições

Mesmo princípio do PUT de quiz, **com um agravante**: condições que a API não
modela chegam com `Type: "RoundTrip"` e um `State` opaco. Se não voltarem com
`Type` e `State` **intactos**, elas somem — e nada no retorno da API acusa isso.
Uma prova pode ter restrição de data, de nota, de conclusão de conteúdo; o lote
não sabe ler nenhuma, e não precisa: precisa devolvê-las verbatim.

`trocarGrupoNasCondicoes` clona todos os operandos e mexe em exatamente um campo
de um tipo de operando. `condicoes.spec.ts` é a rede — o teste do `RoundTrip` é o
mais importante do arquivo.

Forma do `ConditionsData` (validada contra a instância real, turma `156979`):

```json
{
  "Expression": {
    "Type": "Expression",
    "State": null,
    "ExpressionParams": {
      "Operator": "All",
      "Operands": [
        {
          "Type": "EnrolledInGroup",
          "State": "224735",
          "EnrolledInGroupParams": { "GroupId": 156988, "GroupCategoryId": null },
          "Text": { "Text": "Membro do grupo: ...", "Html": "..." }
        }
      ]
    },
    "Text": { "Text": "Todas as condições devem ser satisfeitas", "Html": "..." }
  }
}
```

O corpo do PUT é o mesmo objeto **sem nenhum `Text`** (gerado pelo servidor e
ignorado na escrita) e com `EnrolledInGroupParams` trocado por
`{ GroupId: <novo>, GroupCategoryId: null }`. O `State` do operando trocado
**continua o antigo** — foi nessa forma que o PUT manual validado devolveu 200.

#### Três regras que o lote não negocia

| Situação | O que acontece |
|---|---|
| `EnrolledInGroup` com `GroupId` | troca o `GroupId`, preserva o resto |
| `EnrolledInGroup` com `GroupCategoryId` | **preserva**: significa "qualquer grupo da categoria"; trocar mudaria o *significado* da condição, não o alvo |
| Quiz sem condição de grupo | **nada é criado**, nenhum PUT sai. `SEM_CONDICAO_DE_GRUPO` |

#### Nome de grupo, nunca `GroupId`

Cada turma tem os seus próprios grupos, com ids próprios, mesmo com nomes
idênticos: "Prova 2" existe em todas as turmas com um id diferente em cada. Por
isso `JanelaDeProva.nomeGrupo` guarda o **nome**, e o id é resolvido turma a turma
(`resolucao-grupo.service.ts`, cache por execução). Gravar um id na janela
liberaria a prova de 156 turmas para um grupo que só existe numa.

A comparação de nome é **normalizada** (sem acento, sem caixa, sem espaço duplo)
— ao contrário da de nome de quiz, que é literal. Um falso negativo aqui não é
erro visível: é uma turma inteira ficando com a condição da sessão anterior.
**Nome ambíguo** (mesmo nome em duas categorias) é erro duro, nunca chute.

#### Custo em chamadas

Por turma: +2 (categorias + grupos), cacheado por `orgUnitId` dentro da execução;
+1 a menos quando `categoriaGrupo` está preenchido. Por quiz casado: +2 (GET e
PUT das condições). Aproximadamente **dobra** o número de chamadas do lote de
datas — o `ritmo` (concorrência 4, atraso 400 ms) e a tolerância de 30 min do
cron absorvem isso, mas meça no primeiro dry-run real.

---

## 6. LTI 1.3 — entrada do aluno (sem senha)

O aluno chega por um launch LTI 1.3 a partir do Brightspace. O backend implementa
o lado **Tool** do fluxo OIDC.

### 6.1 Endpoints que o backend expõe

- **OIDC login init**: recebe o `iss`/`login_hint`, redireciona pro `authenticate`
  do Brightspace com `state` e `nonce`.
- **Launch/redirect (callback)**: recebe o `id_token` (JWT), valida e cria a sessão.
- **JWKS público**: expõe as chaves públicas da Tool para o Brightspace validar.

### 6.2 Validar o id_token

- Buscar as chaves públicas do Brightspace (JWKS do platform) e validar a assinatura.
- Conferir `iss`, `aud` (client_id da Tool), `exp`, `nonce`.
- Exigir os claims LTI 1.3 obrigatórios (message type, version, deployment_id,
  target_link_uri, resource_link).

### 6.3 Claims que interessam (extrair)

- **user_id Valence** (para as chamadas REST): vem no claim proprietário
  `http://www.brightspace.com` como um `user_id` numérico — **diretamente
  compatível com a Valence API**, sem lookup adicional.
- **Matrícula**: chega em um (ou mais) destes — `org_defined_id`,
  `lis.person_sourcedid` (ou `custom.lis_person_sourcedid`), `username`. Confirme
  qual está preenchido no tenant e use como chave de cruzamento com `AlunoImportado`.
- **Papel**: claim `roles` (URIs do IMS). Serve para confirmar que é aluno.
- **Nome/e-mail**: `name`, `email` (opcionais, exibição).

### 6.4 Regras

- A matrícula é **String** (RAs alfanuméricos como `A06103080`, `FC20241119`) —
  nunca converta para número.
- O JWT interno emitido para o aluno é só para manter sessão de navegação; a fonte
  de verdade continua sendo o cruzamento matrícula × CSV.

### 6.5 Notas de ambiente (dev)

- `ngrok` para expor o tunnel HTTPS no launch. No plano free, visite o tunnel no
  browser uma vez para passar a interstitial antes do launch LTI.
- Inspecione tokens no jwt.io durante o desenvolvimento.
- Bibliotecas: `jose@4` (pinar — v5+ é ESM-only e quebra o `require` em CommonJS).
  Não usar `ltijs`.

---

## 7. Regras gerais de chamada (todas as APIs REST)

- **Base URL**: `https://catolicatest.brightspace.com` + o path `/d2l/api/...`.
- **Versão**: use `1.82` (ou a mais recente suportada) no segmento `(version)`.
- **Datas**: **sempre UTC** com sufixo `Z`. Converta o horário local antes de enviar.
- **Paginação**: endpoints de lista usam bookmark/paging — siga o `Next`/bookmark
  até esgotar; não assuma tudo numa página.
- **Rate limiting (429)**: respeite; implemente back-off exponencial e re-tentativa.
  A fila de sync (`SyncD2L`) já tem `tentativas`/status para isso.
- **PUT substitui o objeto inteiro** (ex.: quiz): GET → altere → PUT com tudo.
- **Idempotência**: o PUT de special access é por usuário — reprocessar não duplica.
- **Erros parciais não quebram o todo**: numa fila de N disciplinas, um 404/erro em
  uma não deve abortar as outras nem o agendamento local.

---

## 8. Mapa: fluxo de agendamento × chamadas D2L

```
Aluno faz launch LTI ─────────────► valida id_token, extrai userId + matrícula
                                          │
matrícula × AlunoImportado (CSV) ◄────────┘   (modalidade + polo + ativo?)
   │
   ├─ inativo → bloqueia (mensagem), fim.
   │
   └─ ativo:
        GET enrollments/users/{userId}/orgUnits/   (scope enrollment:orgunit:read)
            └─ ∩ descendentes do Período Letivo (Type 103)
               ∩ TurmaImportada (CSV de turmas reais)
               = disciplinas agendáveis
   │
Aluno escolhe faixa ──► aloca SalaFaixa (regra local, transação) ──► cria Agendamento
   │
Para cada disciplina agendável, enfileira SyncD2L:
        GET quizzes/                         (acha o QuizId da prova)
        PUT quizzes/{quizId}/specialaccess/{userId}   (grava, datas UTC)
            ├─ 200 → CONCLUIDO
            ├─ 404 → NAO_MATRICULADO (ignora)
            └─ 429/erro → retry com back-off
```

---

## 9. Checklist para o Claude Code

- [ ] Cliente D2L isolado (`d2l/valence-client.service.ts`), **mockável** (sem
      credenciais reais ainda).
- [ ] Suportar Client Credentials + JWT assertion (preferido) e refresh token (alt.).
- [ ] Cache de access token com renovação sob demanda.
- [ ] Método `getEnrollments(userId)` com paginação e normalização de tipos (string).
- [ ] Método `listQuizzes(orgUnitId)` e `putSpecialAccess(orgUnitId, quizId, userId, data)`.
- [ ] Conversão de horário local → UTC centralizada (uma função só).
- [ ] Tratar 404 como `NAO_MATRICULADO`; 429 com back-off; 403 como alerta de config.
- [ ] Fila `SyncD2L` processando disciplinas de forma independente e idempotente.
- [ ] LTI: endpoints OIDC login/launch/JWKS, validação de id_token, extração de
      claims (userId Valence + matrícula), com `jose@4`.
- [ ] Nunca logar tokens/segredos; tudo por env.

---

## 10. Links de referência

- Valence API (home): https://docs.valence.desire2learn.com/index.html
- Scopes: https://docs.valence.desire2learn.com/http-scopestable.html
- Quizzes / Special Access: https://docs.valence.desire2learn.com/res/quiz.html
- Enrollments: https://docs.valence.desire2learn.com/res/enroll.html
- OAuth 2.0 (guia): https://community.d2l.com/brightspace/kb/articles/1134-brightspace-api-authentication-guide-oauth-2-0
- Começar com OAuth 2.0: https://community.d2l.com/brightspace/kb/articles/21863-how-to-get-started-with-oauth-2-0
- Obter refresh token: https://community.d2l.com/brightspace/kb/articles/1196-how-to-obtain-an-oauth-2-0-refresh-token
- Usuários de Serviço (M2M): https://community.d2l.com/brightspace-pt-BR/kb/articles/34322
- Postman com a API: https://community.d2l.com/brightspace/kb/articles/1100-using-postman-with-the-brightspace-api
- Postman Collections (GitHub): https://github.com/Brightspace/Postman-Collections
