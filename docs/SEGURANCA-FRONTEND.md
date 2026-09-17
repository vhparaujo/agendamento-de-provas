# Segurança — o que é responsabilidade do FRONT-END

> **Para quem for construir o portal (web) deste projeto.**
> O backend é uma API NestJS que só devolve JSON. Vários controles de segurança
> **não podem ser implementados nele** — dependem de decisões do cliente. Este
> documento lista exatamente quais, e por quê.
>
> Documento de referência da API: `README.md` do backend · Swagger em `/api/docs`.

---

## Contexto em 30 segundos

| | |
|---|---|
| **Backend** | NestJS + Prisma/MySQL. Só JSON, nenhuma página HTML. |
| **Aluno** | Entra por **LTI 1.3 a partir do Brightspace**. Não tem senha. |
| **Admin** | E-mail + senha → access token (15min) + refresh token (7d). |
| **Autenticação** | `Authorization: Bearer <token>`. **Não usamos cookies.** |
| **Perfis** | `ADMIN` (acesso total, sem níveis) e `ALUNO`. |

---

## 1. Onde guardar o token — a decisão mais importante

O backend **não impõe** onde o token fica. Essa escolha define se a aplicação
fica exposta a CSRF ou a XSS, e é a decisão de segurança com maior impacto no
front.

### Como está hoje: sem cookie, sem CSRF

O token viaja num header que o navegador **não anexa sozinho** em requisição
cross-site. Por isso o projeto **não tem** e **não precisa** de proteção CSRF.

### ⚠️ O que muda se você guardar o token em cookie

Se o front decidir usar cookie (inclusive `httpOnly`, que é recomendação comum e
legítima), **CSRF passa a existir na mesma hora**. Nesse caso, é obrigatório:

- `SameSite=Strict` (ou `Lax`) e `Secure` no cookie;
- token anti-CSRF (double-submit) nas rotas que mudam estado;
- **avisar o time do backend** — precisaremos habilitar validação de CSRF e
  ajustar CORS para `credentials`.

**Não tome essa decisão sozinho.** Se for usar cookie, avise antes.

### Recomendação

| Token | Onde | Por quê |
|---|---|---|
| **access token** | memória (variável / estado do app) | some ao fechar a aba; XSS não lê de `localStorage` |
| **refresh token** | memória, ou cookie `httpOnly` + `SameSite=Strict` | se for cookie, leia o aviso acima |

**Evite `localStorage`/`sessionStorage`** para o token: qualquer XSS na página lê
o conteúdo deles em uma linha de JS. Se o projeto aceitar esse risco
conscientemente, tudo bem — mas registre a decisão.

**Nunca** coloque token na URL (query string). URL vai para histórico do
navegador, log de proxy e header `Referer`.

---

## 2. XSS — o backend não pode resolver isso por você

A API devolve JSON, então não existe XSS refletido do lado do servidor. **O risco
real é XSS armazenado, e a origem são os dados que nós importamos.**

O sistema importa CSVs enviados pela secretaria — hoje **7.510 registros de
alunos** — com campos que vão direto para a tela do usuário:

| Campo | Vem de | Aparece onde |
|---|---|---|
| `nome` | coluna `ALUNO` do CSV | cabeçalho do portal, listagens |
| `curso` | coluna `CURSO` | seleção de vínculo |
| `polo.nome` | coluna `CAMPUS` | listagem de faixas/horários |
| `nomeDisciplina` | CSV de turmas / Valence | lista de disciplinas da prova |

Esses valores **não são sanitizados na importação, de propósito**: sanitizar na
entrada corromperia dados legítimos (um nome com `&` ou acento, por exemplo) e
ainda perderia o dado original. O tratamento correto é **escapar na saída**.

### O que fazer

- **Renderize como texto, sempre.** React (`{valor}`), Vue (`{{ valor }}`) e
  Angular já escapam por padrão. Isso resolve o caso normal.
- **Nunca** use `dangerouslySetInnerHTML`, `v-html`, `[innerHTML]` ou
  `element.innerHTML = ...` com qualquer campo da tabela acima.
- Se precisar de HTML rico em algum campo (não deveria), sanitize com **DOMPurify**
  antes de injetar.
- Cuidado com atributos: `<a href={valorDoCsv}>` permite `javascript:`. Valide o
  esquema (`https:` / `http:`) antes.

### CSP no front

O backend já envia CSP restritiva nas respostas dele, mas **isso não protege as
páginas do front** — cada aplicação envia a própria. Configure no servidor que
servir o portal:

```
Content-Security-Policy: default-src 'self'; object-src 'none'; base-uri 'self'
```

Evite `'unsafe-inline'` e `'unsafe-eval'` em `script-src`.

---

## 3. Autorização — "request autenticado ≠ request legítimo"

**Token válido não significa ação legítima.** Um aluno autenticado continua sem
direito de agendar prova para outro aluno.

O backend faz essa verificação — os vínculos do aluno vão **dentro do JWT**
justamente para conferir posse sem confiar no cliente. Mas isso tem duas
consequências para o front:

- **Nunca confie em checagem de permissão feita só no front.** Esconder um botão
  não protege nada; a proteção é o backend recusar. Esconder é UX, não segurança.
- **Não invente `alunoId`.** Envie o `alunoId` que veio no launch; se não bater
  com o token, o backend recusa (e isso vai para o log de auditoria).

O mesmo vale para as telas de admin: não há níveis de admin, então qualquer admin
autenticado pode tudo. Não construa uma "matriz de permissões" no front — ela não
existe no backend.

---

## 4. Fluxos que o front precisa tratar

### 4.1 Admin com senha provisória (`mustChangePassword`)

`POST /api/auth/login` pode responder com `mustChangePassword: true`. Nesse
estado, **todas as rotas devolvem 403**, exceto `/api/auth/trocar-senha` e
`/api/auth/me`.

O front **deve** redirecionar para a tela de troca de senha antes de qualquer
outra coisa. Se ignorar a flag, o app trava em 403 sem explicação aparente.

### 4.1-b Entrada do aluno: o `code` do redirect

O aluno chega pelo Brightspace, não por um formulário. O launch é um POST do LMS
para a **API**, mas quem precisa do token é o **portal**, no navegador dele —
e entre os dois só existe um redirect.

Como **token não pode ir na URL** (seção 1), o redirect leva um `code` opaco:

```
POST /api/lti/launch  (Brightspace → API)
   ↓ 303
{PORTAL_ALUNO_URL}?code=<uuid>          (navegador → portal)
   ↓
POST /api/lti/sessao  { "code": "<uuid>" }   → { accessToken, vinculos, ... }
```

O que o front **deve** fazer ao carregar a página do portal:

1. ler `code` da query;
2. trocá-lo por `POST /api/lti/sessao`;
3. **limpar o `code` da URL** (`history.replaceState` ou `router.replace`) — ele
   já foi consumido, e deixá-lo ali só enche o histórico com uma URL que produz
   erro no F5;
4. guardar o `accessToken` em memória, como todo o resto.

O código vale **uma única vez** e por **2 minutos**. Reapresentá-lo (botão
voltar, URL colada) responde `401` com texto pronto: *"Sessão inválida ou
expirada. Volte ao Brightspace e abra o link da prova de novo."* Mostre essa
mensagem — não tente resgatar de novo, porque não vai funcionar.

Quando `PORTAL_ALUNO_URL` está vazia no backend, `/lti/launch` responde o JSON do
launch direto, sem redirect. É o modo de teste, não o de produção.

**Quando o launch não passa, o redirect também acontece** — com `?erro=<código>`
no lugar do `?code=`:

```
POST /api/lti/launch  (Brightspace → API)
   ↓ 303  (em vez de 400/401/403/503)
{PORTAL_ALUNO_URL}?erro=sem-cadastro     (navegador → portal)
```

O front trata igual ao `code`: lê, mostra a tela e **limpa a query** com
`router.replace`. Os códigos são fechados — `sem-cadastro`, `sessao-invalida`,
`dados-incompletos`, `indisponivel`, `falha` — e valor desconhecido cai em
`falha`, porque a URL vem do navegador do aluno e pode ter sido editada à mão.

**A URL não carrega a mensagem de erro**, pela regra da seção 1: ela iria para
histórico, log de proxy e `Referer`, e a mensagem interna cita matrícula e nome
de variável de ambiente. O texto que o aluno lê é do front
(`src/views/aluno/erros-de-entrada.ts`); o detalhe fica no log da API.

### 4.2 Aluno com mais de um curso (`precisaEscolherCurso`)

`POST /api/lti/launch` responde com um array `vinculos`. Se
`precisaEscolherCurso: true`, o RA tem mais de um curso (formatos diferentes,
durações de prova diferentes) e **o portal precisa perguntar de qual curso é a
prova** antes de listar horários. Cada vínculo gera um agendamento próprio.

Se `vinculos[].ativo` for `false`, o aluno é reconhecido mas **não pode agendar** —
mostre mensagem clara em vez de "erro".

Nas rotas `/api/portal/*`, o `alunoId` vai na query (`GET`) ou no corpo (`POST`).
Quem tem **um** curso pode omitir; quem tem mais de um e omite recebe `400`.

### 4.3 Agendamento — as recusas já vêm com o texto pronto

Toda recusa do portal traz em `message` uma frase escrita para o aluno ler. **Não
reescreva nem generalize**: "vagas esgotadas", "seu curso está como Cancelado" e
"o prazo encerrou em 18/08 23:59" pedem reações diferentes, e trocar isso por
"erro ao agendar" transfere o problema para a secretaria.

| Código | Quando | O que o front faz |
|---|---|---|
| `403` | Situação no curso, período fechado, sem disciplina com prova, horário de outro polo | Mostra `message`; **não** oferece "tentar de novo" |
| `409` | Vagas esgotadas, horário inativo/já realizado | Recarrega `GET /portal/faixas` e pede outro horário |
| `409` | Já tem prova marcada para esse curso | Leva para `GET /portal/agendamentos` |
| `404` | Horário não existe mais | Recarrega a lista |

`GET /portal/periodo` e `GET /portal/disciplinas` respondem `200` mesmo quando o
aluno não pode agendar, com `aberto`/`podeAgendar` em `false` e o `motivo` já
escrito — use-os para desabilitar o botão **antes** de o aluno tentar.

Duas coisas que o front **não** deve fazer:

- **Não escolher sala.** `GET /portal/faixas` não devolve salas de propósito; a
  sala é decidida no `POST` e volta na resposta.
- **Não reenviar o `POST` automaticamente** ao receber `409`. A vaga acabou; um
  retry só produz outro `409` — e um retry cego numa disputa por vaga é a forma
  mais fácil de derrubar a API no dia da abertura.

### 4.4 Renovação de token

Access token expira em **15 minutos**. Ao receber `401`, chame
`POST /api/auth/refresh` com o refresh token e refaça a requisição. Faça isso
**uma vez só** — se o refresh também falhar, mande para o login. Loop de refresh
em 401 é uma forma clássica de derrubar a própria API.

### 4.5 `429 Too Many Requests`

O backend agora limita requisições:

| Rota | Limite |
|---|---|
| `/api/auth/login`, `/refresh`, `/trocar-senha`, `/api/lti/launch` | **5 por minuto** por IP |
| Uploads de CSV | 10 a cada 5 minutos |
| Demais rotas | 120 por minuto |

O front **deve** tratar `429` com mensagem amigável ("muitas tentativas, aguarde
um instante") e **não** repetir automaticamente sem espera. Respeite o header
`Retry-After` quando presente.

> Atenção em laboratório/campus: o limite é **por IP**. Muitos alunos atrás do
> mesmo NAT podem compartilhar IP. Se isso virar problema real em produção, é
> ajuste no backend — reporte.

### 4.6 Erros `500`

Resposta de erro interno vem assim:

```json
{ "statusCode": 500, "message": "Erro interno. Informe o codigo abaixo ao suporte.", "erroId": "8f1c9d2e-..." }
```

**Mostre o `erroId` para o usuário.** É com ele que o time acha a linha exata no
log do servidor. O detalhe técnico nunca vem na resposta, de propósito.

---

## 5. CORS — precisa ser combinado

**Hoje o CORS está desabilitado no backend.** Isso significa que **nenhuma
chamada de navegador vindo de outra origem vai funcionar** até configurarmos.

Quando o front tiver uma origem definida (ex.: `https://provas.ucb.br`), avise o
time do backend com:

- a(s) origem(ns) exata(s), incluindo protocolo e porta;
- se vai usar cookies (`credentials: true`) — ver seção 1.

Não vamos liberar `origin: '*'`. Origem curinga com credenciais é bloqueado pelo
navegador e, sem credenciais, ainda expõe a API a qualquer site.

---

## 6. Checklist rápido

- [ ] Token **fora** de `localStorage`; se for cookie, `SameSite` + `Secure` + CSRF, **e avisar o backend**
- [ ] Token **nunca** na URL
- [ ] Nenhum `innerHTML`/`v-html`/`dangerouslySetInnerHTML` com `nome`, `curso`, `campus`, `nomeDisciplina`
- [ ] `href` vindo de dado importado tem esquema validado
- [ ] CSP configurada no servidor do front
- [ ] `mustChangePassword: true` → redireciona para troca de senha
- [ ] `?code=` do launch trocado em `/lti/sessao` e **removido da URL** em seguida
- [ ] `precisaEscolherCurso: true` → pergunta o curso antes de listar horários
- [ ] `vinculos[].ativo === false` → mensagem clara, não erro genérico
- [ ] `401` → tenta refresh **uma vez**, depois login
- [ ] `429` → mensagem de espera, sem retry automático agressivo
- [ ] `500` → exibe o `erroId`
- [ ] Permissão escondida na UI **não** é tratada como segurança
- [ ] Origem do front comunicada ao backend para liberar CORS
- [ ] HTTPS em produção (o backend não faz terminação TLS)

---

## 7. O que o BACKEND já garante (não precisa refazer)

Para não haver esforço duplicado:

- Hash de senha (bcrypt, 12 rounds) e comparação em tempo constante
- Mensagem de erro uniforme no login (não revela se o e-mail existe)
- Validação de **toda** entrada; campo não declarado no DTO derruba a requisição
- Proteção contra SQL injection (Prisma parametrizado)
- **Deny by default**: rota sem decorator de acesso é negada
- Cabeçalhos de segurança nas respostas da API (helmet + CSP restritiva)
- Rate limiting
- Log de auditoria: login, falhas, troca de senha, ações administrativas
- `500` sem stack trace, com `erroId` correlacionável
- Validação completa do LTI (assinatura, issuer, audience, `nonce`, `state` de uso único)

---

## 8. Dúvidas

A fonte de verdade dos contratos é o **Swagger**: `http://localhost:3000/api/docs`
(spec JSON em `/api/docs-json`, importável no Postman/Insomnia e utilizável para
gerar client tipado).

Regras de negócio e modelo de dados: `README.md` do backend.
