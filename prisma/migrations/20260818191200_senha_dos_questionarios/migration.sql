-- CreateTable
CREATE TABLE `senha_de_prova` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `data` DATE NOT NULL,
    `turno` ENUM('MANHA', 'TARDE', 'NOITE') NOT NULL,
    `senha` VARCHAR(200) NOT NULL,
    `versao` INTEGER NOT NULL DEFAULT 1,
    `criadoPor` VARCHAR(191) NOT NULL,
    `atualizadoPor` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `senha_de_prova_data_idx`(`data`),
    UNIQUE INDEX `senha_de_prova_data_turno_key`(`data`, `turno`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `configuracao_senha_quiz` (
    `id` INTEGER NOT NULL DEFAULT 1,
    `nomeQuiz` VARCHAR(191) NOT NULL,
    `matchQuiz` ENUM('EXATO', 'CONTEM') NOT NULL DEFAULT 'CONTEM',
    `atualizadoPor` VARCHAR(191) NULL,
    `atualizadoEm` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `execucao_senha_quiz` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `status` ENUM('EM_ANDAMENTO', 'CONCLUIDA', 'FALHOU') NOT NULL DEFAULT 'EM_ANDAMENTO',
    `simulacao` BOOLEAN NOT NULL DEFAULT true,
    `origem` ENUM('MANUAL', 'CRON') NOT NULL DEFAULT 'MANUAL',
    `iniciadoPor` VARCHAR(191) NOT NULL,
    `senhaDeProvaId` INTEGER NULL,
    `data` DATE NOT NULL,
    `turno` ENUM('MANHA', 'TARDE', 'NOITE') NOT NULL,
    `periodoLetivoId` VARCHAR(191) NOT NULL,
    `versaoAplicada` INTEGER NOT NULL,
    `nomeQuizAlvo` VARCHAR(191) NOT NULL,
    `matchQuizAlvo` ENUM('EXATO', 'CONTEM') NOT NULL,
    `turmasNoCsv` INTEGER NOT NULL DEFAULT 0,
    `turmasResolvidas` INTEGER NOT NULL DEFAULT 0,
    `orgUnitsAprendidos` INTEGER NOT NULL DEFAULT 0,
    `processadas` INTEGER NOT NULL DEFAULT 0,
    `definidas` INTEGER NOT NULL DEFAULT 0,
    `naoEncontradas` INTEGER NOT NULL DEFAULT 0,
    `falhas` INTEGER NOT NULL DEFAULT 0,
    `comSenhaLida` INTEGER NOT NULL DEFAULT 0,
    `erro` TEXT NULL,
    `iniciadoEm` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `concluidoEm` DATETIME(3) NULL,
    `atualizadoEm` DATETIME(3) NOT NULL,

    INDEX `execucao_senha_quiz_data_turno_simulacao_status_idx`(`data`, `turno`, `simulacao`, `status`),
    INDEX `execucao_senha_quiz_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `item_senha_quiz` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `execucaoId` INTEGER NOT NULL,
    `orgUnitId` VARCHAR(191) NULL,
    `codigoTurma` VARCHAR(191) NULL,
    `nomeDisciplina` VARCHAR(191) NULL,
    `quizId` VARCHAR(191) NULL,
    `nomeQuiz` VARCHAR(191) NULL,
    `resultado` ENUM('DEFINIDA', 'SIMULADA', 'QUIZ_NAO_ENCONTRADO', 'ORGUNIT_NAO_RESOLVIDO', 'ORGUNIT_AMBIGUO', 'FALHA_AO_LISTAR', 'FALHA_AO_LER', 'FALHA_AO_GRAVAR') NOT NULL,
    `senhaAnteriorLida` BOOLEAN NOT NULL DEFAULT false,
    `detalhe` TEXT NULL,

    INDEX `item_senha_quiz_execucaoId_idx`(`execucaoId`),
    INDEX `item_senha_quiz_resultado_idx`(`resultado`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `execucao_senha_quiz` ADD CONSTRAINT `execucao_senha_quiz_senhaDeProvaId_fkey` FOREIGN KEY (`senhaDeProvaId`) REFERENCES `senha_de_prova`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `item_senha_quiz` ADD CONSTRAINT `item_senha_quiz_execucaoId_fkey` FOREIGN KEY (`execucaoId`) REFERENCES `execucao_senha_quiz`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
