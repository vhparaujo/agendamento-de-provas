# Dump do banco: máquina local → servidor

## Contexto

O projeto roda MySQL 8.0 em container nos dois ambientes (`agendamento-mysql`), com
Prisma 7. O objetivo é levar o conteúdo do banco local (polos, salas, faixas,
alunos importados, agendamentos) para o servidor de produção.

Duas restrições do ambiente decidem o método:

- **Produção não publica a porta 3306** (`docker-compose.prod.yml` — comentário
  explícito: "o banco só existe na rede interna"). Nenhuma ferramenta de fora
  alcança o MySQL: tudo passa por `docker exec`.
- **Prisma controla o schema pela tabela `_prisma_migrations`.** Ela precisa ir no
  dump; se for embora, o `migrate deploy` do start do container tenta recriar
  tabelas que já existem e o container morre em loop com `P3009`.

Nome do container é o **mesmo** nos dois compose (`agendamento-mysql`) — cuidado
para não rodar o restore na máquina errada.

## Passo 1 — Gerar o dump (na máquina local)

```bash
cd ~/Documents/Trabalho-UCB/agendamento/agendamento-de-provas
docker compose up -d mysql          # o banco precisa estar de pé

docker exec agendamento-mysql \
  mysqldump \
    -uroot -p"${MYSQL_ROOT_PASSWORD:-root}" \
    --single-transaction \
    --no-tablespaces \
    --default-character-set=utf8mb4 \
    --hex-blob \
    agendamento \
  | gzip > ~/agendamento-$(date +%Y%m%d-%H%M).sql.gz
```

Por que cada flag:

| Flag | Por quê |
|---|---|
| `--single-transaction` | Snapshot consistente em InnoDB sem travar escrita. Sem ele, um agendamento gravado no meio do dump pode sair sem a linha de `agendamento_disciplina`. |
| `--no-tablespaces` | O MySQL 8 exige o privilégio `PROCESS` para dumpar info de tablespace. O usuário `agendamento` não tem. Sem a flag, "Access denied". |
| `--default-character-set=utf8mb4` | O banco é utf8mb4 de propósito (nome de aluno e de campus com acento). O casamento do polo é por string exata contra `Polo.nome` — um dump em latin1 quebra a importação em silêncio. |
| `--hex-blob` | Segurança para os campos binários/texto longo (payloads de auditoria, detalhes das exceções do compulsório). |
| sem `--databases` | Não emite `CREATE DATABASE`/`USE`. O banco de destino é escolhido no restore — evita apontar para o nome errado. |

Confira antes de mandar (não confie no tamanho do arquivo):

```bash
gunzip -c ~/agendamento-*.sql.gz | grep -c "INSERT INTO"
gunzip -c ~/agendamento-*.sql.gz | grep "CREATE TABLE" | wc -l   # deve dar 17
gunzip -c ~/agendamento-*.sql.gz | grep "_prisma_migrations"     # precisa aparecer
```

São 17 tabelas + `_prisma_migrations`: `admin`, `modalidade`, `polo`, `sala`,
`faixa`, `sala_faixa`, `aluno_importado`, `turma_importada`, `importacao_csv`,
`agendamento`, `historico_agendamento`, `agendamento_disciplina`, `sync_d2l`,
`integracao_d2l`, `periodo_agendamento`, `execucao_compulsorio`,
`excecao_compulsorio`.

## Passo 2 — Enviar

```bash
scp ~/agendamento-20260817-1430.sql.gz usuario@servidor:/tmp/
```

## Passo 3 — Restaurar (no servidor)

```bash
cd /caminho/do/projeto            # onde está o docker-compose.prod.yml
source .env                       # pega MYSQL_ROOT_PASSWORD

# 3a. BACKUP DO QUE JÁ ESTÁ LÁ, antes de qualquer coisa
docker exec agendamento-mysql mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" \
  --single-transaction --no-tablespaces --default-character-set=utf8mb4 \
  agendamento | gzip > /tmp/antes-do-restore-$(date +%Y%m%d-%H%M).sql.gz

# 3b. Pare a API para ninguém escrever durante o restore
docker compose -f docker-compose.prod.yml stop api

# 3c. Banco limpo — o dump traz CREATE TABLE, não pode haver tabela antiga
docker exec agendamento-mysql mysql -uroot -p"$MYSQL_ROOT_PASSWORD" \
  -e "DROP DATABASE agendamento; CREATE DATABASE agendamento
      CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

# 3d. Restore
gunzip -c /tmp/agendamento-20260817-1430.sql.gz \
  | docker exec -i agendamento-mysql \
      mysql -uroot -p"$MYSQL_ROOT_PASSWORD" \
        --default-character-set=utf8mb4 agendamento

# 3e. Suba a API
docker compose -f docker-compose.prod.yml start api
docker compose -f docker-compose.prod.yml logs -f api
```

**`docker exec -i`, nunca `-it`.** O `-t` aloca um TTY e o pipe do stdin não chega
no `mysql` — o comando "funciona" e o banco fica vazio.

O `DROP DATABASE` do 3c só faz sentido porque o volume `agendamento-mysql-data`
guarda **apenas** este banco. Sem ele o restore falha em "table already exists" na
primeira tabela, ou pior: mistura schema novo com dados velhos.

## Passo 4 — Conferir

```bash
docker exec agendamento-mysql mysql -uroot -p"$MYSQL_ROOT_PASSWORD" agendamento \
  -e "SELECT COUNT(*) FROM aluno_importado;
      SELECT COUNT(*) FROM agendamento WHERE status='CONFIRMADO';
      SELECT nome FROM polo LIMIT 5;
      SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY migration_name;"

curl -s http://localhost:8080/api/health
```

Três coisas que precisam bater:

1. Os nomes de polo saem **com acento correto** ("Câmpus", não "CÃ¢mpus"). Se
   saírem quebrados, o encoding se perdeu no caminho — refaça o dump com
   `--default-character-set=utf8mb4` nas duas pontas.
2. `_prisma_migrations` lista todas as migrations com `finished_at` preenchido, na
   ordem alfabética das pastas de `prisma/migrations/`. É isso que faz o
   `migrate deploy` do start do container ser um no-op.
3. `/api/health` responde `database: up`.

## Depois do restore: dois acertos obrigatórios

**A integração D2L precisa ser reautorizada.** O refresh token vive só em
`integracao_d2l`, e cada uso rotaciona e invalida o anterior — um dump traz um
token já morto (README, seção "Autorizar a Valence no servidor"). Além disso, o
token de dev foi emitido para o `redirect_uri` do ngrok, que não bate com o
domínio de produção. O sintoma, se esquecer: `/api/health` devolve
`d2l: nao_autorizado`, ou pior, `d2l: ok` mentindo até um aluno tentar agendar.

Limpe e reautorize pelo browser, no domínio real:

```bash
docker exec agendamento-mysql mysql -uroot -p"$MYSQL_ROOT_PASSWORD" agendamento \
  -e "DELETE FROM integracao_d2l;"
```

**Os admins do dump vieram com as senhas de dev.** A tabela `admin` carrega os
hashes locais — inclusive o do seed com a senha do `.env` de desenvolvimento. Ou
apague as contas de teste e rode `npm run seed` (idempotente, cria o primeiro
admin com `mustChangePassword=true`), ou force a troca:

```bash
docker exec agendamento-mysql mysql -uroot -p"$MYSQL_ROOT_PASSWORD" agendamento \
  -e "UPDATE admin SET mustChangePassword = 1;"
```

## Alternativa: não dumpar nada

Se o que interessa no servidor é só o **cadastro e os alunos**, e não o histórico
de agendamentos de teste, o caminho mais limpo é reconstruir:

```bash
npm run prisma:deploy   # o container já faz no start
npm run seed            # modalidades + polos + 1º admin, idempotente
```

…e depois subir os 3 CSVs por `POST /api/importacao/alunos` (um por aba/modalidade)
e `POST /api/importacao/turmas`. A importação é idempotente — upsert por
`[matricula, curso]` e `[codigoTurma, nomeDisciplina]`.

O que **não** volta por esse caminho: salas, faixas e ofertas (`sala_faixa`), que
são cadastro manual do admin, e os agendamentos já feitos. Se você montou a
estrutura de salas e horários localmente, o dump vale mais.

## O que NÃO fazer

- **Copiar o volume `agendamento-mysql-data` com `tar`.** Funciona, mas exige
  parar o MySQL nas duas pontas e versão binária idêntica do servidor. Um restore
  a quente corrompe o InnoDB. `mysqldump` não tem esse risco.
- **Dump só de dados (`--no-data` / `--no-create-info`) misturado com
  `migrate deploy`.** Sem `_prisma_migrations` consistente com o schema, o
  container entra em loop de `P3009` (a receita de recuperação está no README,
  seção "Erro P3009").
- **Restaurar com a API de pé.** `restart: unless-stopped` + healthcheck fazem a
  API reconectar no meio do restore e escrever em cima.

## Backup recorrente (o item aberto do checklist)

O checklist de deploy do README tem "Backup do volume `agendamento-mysql-data`
agendado" pendente. O mesmo comando do passo 1 serve, num cron do host:

```cron
0 3 * * * cd /caminho/do/projeto && docker exec agendamento-mysql mysqldump \
  -uroot -p"$(grep MYSQL_ROOT_PASSWORD .env | cut -d= -f2)" \
  --single-transaction --no-tablespaces --default-character-set=utf8mb4 \
  agendamento | gzip > /var/backups/agendamento-$(date +\%Y\%m\%d).sql.gz
```

Guarde fora da máquina. Um backup no mesmo disco não é backup.
