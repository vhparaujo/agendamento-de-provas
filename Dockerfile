# --- build -------------------------------------------------------------------
FROM node:24-slim AS builder

WORKDIR /app

# openssl e exigido pelo Prisma; a imagem slim nao o traz por padrao
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --ignore-scripts=false

COPY prisma ./prisma
COPY prisma.config.ts ./

# `prisma generate` nunca conecta no banco, mas prisma.config.ts exige a variavel
# presente. Este valor e um placeholder de build — a URL real vem do ambiente em
# tempo de execucao (docker-compose / .env).
ENV DATABASE_URL="mysql://build:build@localhost:3306/build"
RUN npx prisma generate

COPY . .
RUN npm run build

# Descarta as devDependencies DEPOIS do build: @nestjs/cli, jest e companhia nao
# sao usados em runtime (616 MB -> 427 MB).
#
# DOIS pacotes ficaram em `dependencies` de proposito, e a poda e o motivo:
#   - `prisma`, porque o CMD abaixo roda `prisma migrate deploy` no start;
#   - `tsx`, porque o seed e `tsx prisma/seed.ts` (prisma.config.ts) — e o seed
#     e quem cria as modalidades, os 27 polos e o primeiro admin. Sem ele a
#     instalacao sobe sem ninguem para fazer login.
# Como devDependencies, os dois sumiriam aqui e a falha so apareceria no deploy.
RUN npm prune --omit=dev

# --- runtime -----------------------------------------------------------------
FROM node:24-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./
COPY package*.json ./

# Operacao de producao, nao ferramenta de desenvolvimento: `alunos:recalcular`
# reclassifica quem pode agendar depois de uma mudanca em status-curso.enum.ts,
# e `d2l:token` diagnostica a integracao com a Valence. Sem esta pasta os dois
# so existiriam na maquina de quem desenvolve. Sao alguns KB.
COPY --from=builder /app/scripts ./scripts

# O fonte, 2,1 MB (1,2 MB dos quais e o client gerado do Prisma).
#
# Nao e duplicata inutil do dist/: o seed e os scripts operacionais rodam por
# `tsx` sobre os .ts ORIGINAIS, e importam por caminho relativo ao fonte —
# `prisma/seed.ts` puxa '../src/generated/prisma/client' e
# '../src/database/mariadb-adapter', que por sua vez puxa os proprios imports.
# Copiar so as pastas citadas resolve o primeiro erro e revela o seguinte; a
# arvore inteira e menor que perseguir a cadeia.
#
# Sem isto, `npx prisma db seed` morre com MODULE_NOT_FOUND dentro do container
# — e o seed e quem cria as modalidades, os 27 polos e o primeiro
# administrador. A instalacao subiria sem ninguem para fazer login.
COPY --from=builder /app/src ./src
COPY --from=builder /app/tsconfig.json ./

EXPOSE 3000

# aplica migrations pendentes e sobe a API
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main"]
