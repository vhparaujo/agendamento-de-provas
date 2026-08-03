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
| Gravar special access | `quizzing:quizzes:write` | quizzes/(quizId)/specialaccess/(userId) |
| Ler special access (verificação) | `quizzing:quizzes:read` | quizzes/(quizId)/specialaccess/ |

String de exemplo (ajuste conforme o app):
```
enrollment:orgunit:read quizzing:quizzes:read quizzing:quizzes:write
```

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
