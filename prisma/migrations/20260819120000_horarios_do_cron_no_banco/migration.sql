-- Os horarios do cron saem do .env e passam a ser escolhidos pelo admin, junto
-- com o questionario-alvo, que deixa de ter semente no .env.
--
-- `nomeQuiz` vira NULL-avel de proposito: sem semente, existe um estado em que
-- ninguem escolheu ainda — e o lote precisa RECUSAR comecar nele, em vez de
-- adivinhar um nome e trocar a senha do questionario errado em toda turma.
-- Linhas ja gravadas mantem o valor que tinham.
ALTER TABLE `configuracao_senha_quiz`
    MODIFY `nomeQuiz` VARCHAR(191) NULL,
    ADD COLUMN `horaManha` VARCHAR(5) NULL,
    ADD COLUMN `horaTarde` VARCHAR(5) NULL,
    ADD COLUMN `horaNoite` VARCHAR(5) NULL;
