-- CreateTable
CREATE TABLE `historico_agendamento` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `agendamentoId` INTEGER NOT NULL,
    `evento` ENUM('CRIADO', 'TROCADO', 'REMANEJADO', 'CANCELADO') NOT NULL,
    `autorTipo` ENUM('ALUNO', 'ADMIN') NOT NULL,
    `autor` VARCHAR(191) NOT NULL,
    `de` VARCHAR(191) NULL,
    `para` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `historico_agendamento_agendamentoId_idx`(`agendamentoId`),
    INDEX `historico_agendamento_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `historico_agendamento` ADD CONSTRAINT `historico_agendamento_agendamentoId_fkey` FOREIGN KEY (`agendamentoId`) REFERENCES `agendamento`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
