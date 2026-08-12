-- CreateTable
CREATE TABLE `execucao_compulsorio` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `status` ENUM('EM_ANDAMENTO', 'CONCLUIDA', 'FALHOU') NOT NULL DEFAULT 'EM_ANDAMENTO',
    `simulacao` BOOLEAN NOT NULL DEFAULT true,
    `periodoLetivoId` VARCHAR(191) NOT NULL,
    `iniciadoPor` VARCHAR(191) NOT NULL,
    `totalElegiveis` INTEGER NOT NULL DEFAULT 0,
    `processados` INTEGER NOT NULL DEFAULT 0,
    `alocados` INTEGER NOT NULL DEFAULT 0,
    `erro` TEXT NULL,
    `iniciadoEm` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `concluidoEm` DATETIME(3) NULL,
    `atualizadoEm` DATETIME(3) NOT NULL,

    INDEX `execucao_compulsorio_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `excecao_compulsorio` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `execucaoId` INTEGER NOT NULL,
    `alunoId` INTEGER NOT NULL,
    `matricula` VARCHAR(191) NOT NULL,
    `motivo` ENUM('SEM_CONTA_D2L', 'MATRICULA_AMBIGUA', 'ID_INVALIDO_D2L', 'SEM_DISCIPLINA_AGENDAVEL', 'SEM_FAIXA_NO_POLO', 'SEM_VAGA', 'CANCELOU_E_NAO_REMARCOU', 'FALHA_NA_INTEGRACAO', 'AVISO_CONTA_INATIVA_D2L') NOT NULL,
    `detalhe` TEXT NULL,

    INDEX `excecao_compulsorio_execucaoId_idx`(`execucaoId`),
    INDEX `excecao_compulsorio_motivo_idx`(`motivo`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `excecao_compulsorio` ADD CONSTRAINT `excecao_compulsorio_execucaoId_fkey` FOREIGN KEY (`execucaoId`) REFERENCES `execucao_compulsorio`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `excecao_compulsorio` ADD CONSTRAINT `excecao_compulsorio_alunoId_fkey` FOREIGN KEY (`alunoId`) REFERENCES `aluno_importado`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
