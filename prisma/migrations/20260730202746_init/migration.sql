-- CreateTable
CREATE TABLE `admin` (
    `id` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `senhaHash` VARCHAR(191) NOT NULL,
    `nome` VARCHAR(191) NULL,
    `ativo` BOOLEAN NOT NULL DEFAULT true,
    `mustChangePassword` BOOLEAN NOT NULL DEFAULT false,
    `resetToken` VARCHAR(191) NULL,
    `resetTokenExpiry` DATETIME(3) NULL,
    `ultimoLogin` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `admin_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `modalidade` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `codigo` VARCHAR(191) NOT NULL,
    `nome` VARCHAR(191) NOT NULL,
    `duracaoMinutos` INTEGER NOT NULL,

    UNIQUE INDEX `modalidade_codigo_key`(`codigo`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `polo` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `nome` VARCHAR(191) NOT NULL,
    `cidade` VARCHAR(191) NULL,
    `ativo` BOOLEAN NOT NULL DEFAULT true,

    UNIQUE INDEX `polo_nome_key`(`nome`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sala` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `poloId` INTEGER NOT NULL,
    `nome` VARCHAR(191) NOT NULL,
    `capacidade` INTEGER NOT NULL,
    `ativo` BOOLEAN NOT NULL DEFAULT true,

    INDEX `sala_poloId_idx`(`poloId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `faixa` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `poloId` INTEGER NOT NULL,
    `data` DATE NOT NULL,
    `horaInicio` VARCHAR(191) NOT NULL,
    `horaFim` VARCHAR(191) NOT NULL,
    `ativo` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `faixa_poloId_idx`(`poloId`),
    INDEX `faixa_data_idx`(`data`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sala_faixa` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `salaId` INTEGER NOT NULL,
    `faixaId` INTEGER NOT NULL,
    `modalidadeId` INTEGER NOT NULL,
    `vagas` INTEGER NOT NULL,
    `ordem` INTEGER NOT NULL,

    INDEX `sala_faixa_faixaId_modalidadeId_idx`(`faixaId`, `modalidadeId`),
    UNIQUE INDEX `sala_faixa_salaId_faixaId_key`(`salaId`, `faixaId`),
    UNIQUE INDEX `sala_faixa_faixaId_modalidadeId_ordem_key`(`faixaId`, `modalidadeId`, `ordem`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `aluno_importado` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `matricula` VARCHAR(191) NOT NULL,
    `nome` VARCHAR(191) NULL,
    `email` VARCHAR(191) NULL,
    `curso` VARCHAR(191) NULL,
    `ativo` BOOLEAN NOT NULL DEFAULT true,
    `modalidadeId` INTEGER NOT NULL,
    `poloId` INTEGER NOT NULL,
    `importacaoId` INTEGER NULL,

    UNIQUE INDEX `aluno_importado_matricula_key`(`matricula`),
    INDEX `aluno_importado_modalidadeId_idx`(`modalidadeId`),
    INDEX `aluno_importado_poloId_idx`(`poloId`),
    INDEX `aluno_importado_ativo_idx`(`ativo`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `turma_importada` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `orgUnitId` VARCHAR(191) NOT NULL,
    `nomeDisciplina` VARCHAR(191) NULL,
    `codigoTurma` VARCHAR(191) NULL,
    `importacaoId` INTEGER NULL,

    UNIQUE INDEX `turma_importada_orgUnitId_key`(`orgUnitId`),
    INDEX `turma_importada_orgUnitId_idx`(`orgUnitId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `importacao_csv` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `tipo` ENUM('ALUNOS', 'SALAS', 'TURMAS') NOT NULL,
    `nomeArquivo` VARCHAR(191) NOT NULL,
    `totalLinhas` INTEGER NOT NULL,
    `importadoPor` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `agendamento` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `alunoId` INTEGER NOT NULL,
    `salaFaixaId` INTEGER NOT NULL,
    `matricula` VARCHAR(191) NOT NULL,
    `userIdD2L` VARCHAR(191) NOT NULL,
    `periodoLetivoId` VARCHAR(191) NOT NULL,
    `status` ENUM('CONFIRMADO', 'CANCELADO') NOT NULL DEFAULT 'CONFIRMADO',
    `alocadoManual` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `agendamento_alunoId_idx`(`alunoId`),
    INDEX `agendamento_salaFaixaId_idx`(`salaFaixaId`),
    INDEX `agendamento_matricula_idx`(`matricula`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `agendamento_disciplina` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `agendamentoId` INTEGER NOT NULL,
    `orgUnitId` VARCHAR(191) NOT NULL,
    `nomeDisciplina` VARCHAR(191) NULL,

    INDEX `agendamento_disciplina_agendamentoId_idx`(`agendamentoId`),
    UNIQUE INDEX `agendamento_disciplina_agendamentoId_orgUnitId_key`(`agendamentoId`, `orgUnitId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sync_d2l` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `agendamentoId` INTEGER NOT NULL,
    `orgUnitId` VARCHAR(191) NOT NULL,
    `status` ENUM('PENDENTE', 'CONCLUIDO', 'FALHOU', 'NAO_MATRICULADO') NOT NULL DEFAULT 'PENDENTE',
    `tentativas` INTEGER NOT NULL DEFAULT 0,
    `ultimoErro` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `sync_d2l_agendamentoId_idx`(`agendamentoId`),
    INDEX `sync_d2l_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `periodo_agendamento` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `periodoLetivoId` VARCHAR(191) NOT NULL,
    `descricao` VARCHAR(191) NULL,
    `aberto` BOOLEAN NOT NULL DEFAULT false,
    `dataAbertura` DATETIME(3) NULL,
    `dataFechamento` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `sala` ADD CONSTRAINT `sala_poloId_fkey` FOREIGN KEY (`poloId`) REFERENCES `polo`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `faixa` ADD CONSTRAINT `faixa_poloId_fkey` FOREIGN KEY (`poloId`) REFERENCES `polo`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sala_faixa` ADD CONSTRAINT `sala_faixa_salaId_fkey` FOREIGN KEY (`salaId`) REFERENCES `sala`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sala_faixa` ADD CONSTRAINT `sala_faixa_faixaId_fkey` FOREIGN KEY (`faixaId`) REFERENCES `faixa`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sala_faixa` ADD CONSTRAINT `sala_faixa_modalidadeId_fkey` FOREIGN KEY (`modalidadeId`) REFERENCES `modalidade`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `aluno_importado` ADD CONSTRAINT `aluno_importado_modalidadeId_fkey` FOREIGN KEY (`modalidadeId`) REFERENCES `modalidade`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `aluno_importado` ADD CONSTRAINT `aluno_importado_poloId_fkey` FOREIGN KEY (`poloId`) REFERENCES `polo`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `aluno_importado` ADD CONSTRAINT `aluno_importado_importacaoId_fkey` FOREIGN KEY (`importacaoId`) REFERENCES `importacao_csv`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `turma_importada` ADD CONSTRAINT `turma_importada_importacaoId_fkey` FOREIGN KEY (`importacaoId`) REFERENCES `importacao_csv`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `agendamento` ADD CONSTRAINT `agendamento_alunoId_fkey` FOREIGN KEY (`alunoId`) REFERENCES `aluno_importado`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `agendamento` ADD CONSTRAINT `agendamento_salaFaixaId_fkey` FOREIGN KEY (`salaFaixaId`) REFERENCES `sala_faixa`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `agendamento_disciplina` ADD CONSTRAINT `agendamento_disciplina_agendamentoId_fkey` FOREIGN KEY (`agendamentoId`) REFERENCES `agendamento`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sync_d2l` ADD CONSTRAINT `sync_d2l_agendamentoId_fkey` FOREIGN KEY (`agendamentoId`) REFERENCES `agendamento`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
