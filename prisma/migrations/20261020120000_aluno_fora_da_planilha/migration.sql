-- FORA DA PLANILHA: o vinculo que nao veio no ultimo CSV COMPLETO do formato
-- dele fica marcado (e bloqueado para agendar), em vez de apagado. Apagar
-- levaria junto as provas ja feitas. Nenhum vinculo existente e marcado aqui:
-- a marca so nasce de uma importacao com "lista completa" confirmada.
ALTER TABLE `aluno_importado`
    ADD COLUMN `foraDaPlanilhaEm` DATETIME(3) NULL,
    ADD COLUMN `foraDaPlanilhaImportacaoId` INTEGER NULL;

CREATE INDEX `aluno_importado_modalidadeId_foraDaPlanilhaEm_idx`
    ON `aluno_importado`(`modalidadeId`, `foraDaPlanilhaEm`);

ALTER TABLE `aluno_importado`
    ADD CONSTRAINT `aluno_importado_foraDaPlanilhaImportacaoId_fkey`
    FOREIGN KEY (`foraDaPlanilhaImportacaoId`) REFERENCES `importacao_csv`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

-- O registro do upload diz se ele foi tratado como lista completa, e quantos
-- vinculos marcou. Tudo que ja existe era parcial, por definicao: a importacao
-- nunca comparou nada com o banco antes desta mudanca.
ALTER TABLE `importacao_csv`
    ADD COLUMN `listaCompleta` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `saidasMarcadas` INTEGER NOT NULL DEFAULT 0;
