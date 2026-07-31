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

EXPOSE 3000

# aplica migrations pendentes e sobe a API
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main"]
