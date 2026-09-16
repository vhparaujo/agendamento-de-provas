-- FUSO DO POLO (e tres colunas de uma fila de special access que nao seguiu).
--
-- Esta migration foi aplicada no banco de desenvolvimento em 15/09/2026 por um
-- trabalho que depois foi descartado, e o arquivo se perdeu junto. Ela foi
-- REESCRITA com exatamente o que aquele banco ja tinha, para o historico voltar
-- a bater. Nada aqui e diferente do que ja rodou.
--
-- `polo.fuso` e o que o special access usa para ler a faixa no relogio do polo
-- (Cruzeiro do Sul, no Acre, fica duas horas atras de Brasilia). As colunas e o
-- status DISPENSADO de `sync_d2l` pertencem a uma fila por agendamento que foi
-- trocada pelo lote de `src/special-access`; ficam sem uso, porque apagar coluna
-- ja aplicada nao traz ganho nenhum.

-- AlterTable
ALTER TABLE `polo` ADD COLUMN `fuso` VARCHAR(64) NOT NULL DEFAULT 'America/Sao_Paulo';

-- AlterTable
ALTER TABLE `sync_d2l` ADD COLUMN `endDateAplicado` DATETIME(3) NULL,
    ADD COLUMN `quizIds` VARCHAR(500) NULL,
    ADD COLUMN `startDateAplicado` DATETIME(3) NULL,
    MODIFY `status` ENUM('PENDENTE', 'CONCLUIDO', 'FALHOU', 'NAO_MATRICULADO', 'DISPENSADO') NOT NULL DEFAULT 'PENDENTE';
