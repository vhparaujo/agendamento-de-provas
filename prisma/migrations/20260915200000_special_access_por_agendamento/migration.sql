-- SPECIAL ACCESS POR AGENDAMENTO (15/09/2026) — a alternativa a troca diaria de
-- data e de grupo do questionario.
--
-- O questionario fica sem data e restrito a quem tem special access; o portal
-- grava, para cada aluno agendado, a janela da FAIXA dele (no fuso do polo) e o
-- tempo de prova da modalidade — mais o tempo extra de quem e do NIOP.
--
-- Aditiva. Nada do lote de datas e grupos e removido: os dois caminhos convivem
-- ate o special access substituir o anterior.

-- ---------------------------------------------------------------------------
-- 1. O tempo de prova que vai no special access, por modalidade
-- ---------------------------------------------------------------------------
-- Separado de `duracaoMinutos` de proposito: aquela coluna decide o TAMANHO da
-- faixa que aceita a modalidade; esta e o `TimeLimitValue` do questionario, e o
-- admin a muda na tela. Nasce igual a duracao.

-- AlterTable
ALTER TABLE `modalidade` ADD COLUMN `tempoDeProvaMinutos` INTEGER NULL;

UPDATE `modalidade` SET `tempoDeProvaMinutos` = `duracaoMinutos`;

ALTER TABLE `modalidade` MODIFY `tempoDeProvaMinutos` INTEGER NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Cruzeiro do Sul marca a prova no relogio do Acre (UTC-5)
-- ---------------------------------------------------------------------------
UPDATE `polo` SET `fuso` = 'America/Rio_Branco' WHERE `nome` = 'Polo Cruzeiro do Sul';

-- ---------------------------------------------------------------------------
-- 3. Quem e do NIOP — por MATRICULA, fora de `aluno_importado`
-- ---------------------------------------------------------------------------
-- A importacao sobrescreve o vinculo a cada upload; uma coluna la seria apagada
-- no proximo CSV. E a pessoa que tem direito ao tempo extra, nao o curso.

-- CreateTable
CREATE TABLE `aluno_niop` (
    `matricula` VARCHAR(191) NOT NULL,
    `marcadoPor` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`matricula`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `configuracao_special_access` (
    `id` INTEGER NOT NULL DEFAULT 1,
    `tempoExtraNiopMinutos` INTEGER NOT NULL DEFAULT 60,
    `substituiJanelas` BOOLEAN NOT NULL DEFAULT false,
    `atualizadoPor` VARCHAR(191) NULL,
    `atualizadoEm` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 4. O PREPARO do questionario mora na tabela dos lotes de senha e data
-- ---------------------------------------------------------------------------
-- Ele faz GET -> PUT no MESMO questionario; em tabela separada, a trava de "um
-- lote por vez" nao o enxergaria e um PUT desfaria o outro.

-- AlterTable
ALTER TABLE `execucao_senha_quiz` MODIFY `tipo` ENUM('SENHA', 'DATA', 'PREPARO') NOT NULL DEFAULT 'SENHA';

-- AlterTable
ALTER TABLE `item_senha_quiz` MODIFY `resultadoGrupo` ENUM('TROCADO', 'SIMULADO', 'JA_ERA_O_GRUPO', 'SEM_CONDICAO_DE_GRUPO', 'CONDICAO_POR_CATEGORIA', 'GRUPO_NAO_ENCONTRADO', 'GRUPO_AMBIGUO', 'SEM_CATEGORIA_DE_GRUPO', 'SEM_GRUPO_NO_DIA', 'FALHA_AO_LER_CONDICOES', 'FALHA_AO_GRAVAR_CONDICOES', 'REMOVIDO', 'REMOCAO_SIMULADA') NULL;

-- ---------------------------------------------------------------------------
-- 5. O lote que grava o special access de cada aluno
-- ---------------------------------------------------------------------------

-- CreateTable
CREATE TABLE `execucao_special_access` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `status` ENUM('EM_ANDAMENTO', 'CONCLUIDA', 'FALHOU') NOT NULL DEFAULT 'EM_ANDAMENTO',
    `simulacao` BOOLEAN NOT NULL DEFAULT true,
    `periodoLetivoIds` VARCHAR(500) NOT NULL,
    `rodada` VARCHAR(191) NOT NULL,
    `orgUnitId` VARCHAR(191) NULL,
    `nomeQuizAlvo` VARCHAR(191) NOT NULL,
    `matchQuizAlvo` ENUM('EXATO', 'CONTEM') NOT NULL,
    `tempoExtraNiopMinutos` INTEGER NOT NULL,
    `iniciadoPor` VARCHAR(191) NOT NULL,
    `totalTurmas` INTEGER NOT NULL DEFAULT 0,
    `turmasProcessadas` INTEGER NOT NULL DEFAULT 0,
    `gravados` INTEGER NOT NULL DEFAULT 0,
    `atualizados` INTEGER NOT NULL DEFAULT 0,
    `removidos` INTEGER NOT NULL DEFAULT 0,
    `jaCorretos` INTEGER NOT NULL DEFAULT 0,
    `pendencias` INTEGER NOT NULL DEFAULT 0,
    `erro` TEXT NULL,
    `iniciadoEm` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `concluidoEm` DATETIME(3) NULL,
    `atualizadoEm` DATETIME(3) NOT NULL,

    INDEX `execucao_special_access_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `item_special_access` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `execucaoId` INTEGER NOT NULL,
    `orgUnitId` VARCHAR(191) NOT NULL,
    `codigoTurma` VARCHAR(191) NULL,
    `nomeDisciplina` VARCHAR(191) NULL,
    `quizId` VARCHAR(191) NULL,
    `nomeQuiz` VARCHAR(191) NULL,
    `matricula` VARCHAR(191) NULL,
    `userIdD2L` VARCHAR(191) NULL,
    `resultado` ENUM('ACESSO_GRAVADO', 'ACESSO_ATUALIZADO', 'ACESSO_REMOVIDO', 'ACESSO_DE_OUTRO_USUARIO', 'QUIZ_NAO_ENCONTRADO', 'QUESTIONARIO_NAO_RESTRITO', 'RESERVA_DUPLICADA', 'USER_ID_INVALIDO', 'ALUNO_NAO_ENCONTRADO', 'FALHA_NA_API') NOT NULL,
    `startDate` DATETIME(3) NULL,
    `endDate` DATETIME(3) NULL,
    `minutos` INTEGER NULL,
    `niop` BOOLEAN NOT NULL DEFAULT false,
    `detalhe` TEXT NULL,

    INDEX `item_special_access_execucaoId_resultado_idx`(`execucaoId`, `resultado`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `item_special_access` ADD CONSTRAINT `item_special_access_execucaoId_fkey` FOREIGN KEY (`execucaoId`) REFERENCES `execucao_special_access`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
