-- CreateTable
CREATE TABLE `integracao_d2l` (
    `id` INTEGER NOT NULL DEFAULT 1,
    `refreshToken` TEXT NOT NULL,
    `atualizadoEm` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
