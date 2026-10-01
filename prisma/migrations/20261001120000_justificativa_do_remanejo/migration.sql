-- O MOTIVO DO REMANEJO, escrito pelo admin. Opcional: NULO quando ele nao quis
-- justificar, e sempre NULO nos eventos do aluno. Fica no historico, ao lado de
-- quem remanejou, porque e la que a administracao procura quando o aluno pergunta.
ALTER TABLE `historico_agendamento`
    ADD COLUMN `justificativa` VARCHAR(500) NULL;
