-- Turma nao pertence a um curso: ela tem alunos de varios (compartilhada,
-- eletiva, equivalencia). O rotulo era falso e o filtro por curso chegava a
-- descartar disciplina valida.
--
-- Destrutivo e intencional. Nada mais le esta coluna, e o dado nao e
-- reconstruivel a partir da turma — se voltar a ser necessario, a informacao
-- correta e do par (aluno, turma), nao desta tabela.
ALTER TABLE `turma_importada` DROP COLUMN `curso`;
