#!/bin/bash
# Executado uma unica vez, na criacao do volume do MySQL.
#
# `prisma migrate dev` cria e destroi um "shadow database" temporario para
# detectar drift. O usuario da aplicacao nao tem permissao de CREATE DATABASE por
# padrao, entao concedemos o minimo: privilegios apenas sobre os bancos cujo nome
# comeca com prisma_migrate_shadow_db.
#
# Isso vale so para desenvolvimento — em producao usa-se `prisma migrate deploy`,
# que nao cria shadow database.
set -euo pipefail

mysql --protocol=socket -uroot -p"${MYSQL_ROOT_PASSWORD}" <<-EOSQL
  GRANT ALL PRIVILEGES ON \`prisma_migrate_shadow_db%\`.* TO '${MYSQL_USER}'@'%';
  FLUSH PRIVILEGES;
EOSQL
