-- A REGRA DA SUBSTITUTIVA PASSOU A OLHAR DUAS NOTAS (08/09/2026).
--
-- Ate aqui os dois limites comparavam a MESMA nota — a final calculada, em
-- [1,5 ; 6,75). A regra nova do cliente sao dois criterios sobre notas
-- DIFERENTES, e a disciplina so entra quando passa nos dois:
--
--     N1 >= 1,50   E   nota final calculada < 7,00
--
-- Nao ha mais piso na nota final, nem teto na N1.
--
-- ⚠️ POR QUE RENOMEAR AS COLUNAS EM VEZ DE SO MUDAR O CODIGO.
-- `notaMinima` e `notaMaxima` continuariam compilando e continuariam parecendo
-- um intervalo. Quem lesse o piso como piso da FINAL — a leitura obvia, e a que
-- valeu por tres semanas — voltaria a liberar a substitutiva para quem tem
-- final 2,0 com a N1 zerada, sem nenhum erro aparecendo em lugar nenhum. O
-- nome era a unica coisa que ainda afirmava a regra velha.
--
-- ⚠️ AS JANELAS JA CADASTRADAS MUDAM DE SIGNIFICADO, e nao ha migracao de dados
-- que resolva isso: o 1,50 que esta gravado era piso da final e passa a ser piso
-- da N1; o 6,75, teto da final, continua teto da final. Os numeros nao sao
-- convertidos de proposito — reescrever o teto para 7,00 aqui seria tomar no
-- lugar da secretaria uma decisao que e dela. CONFIRA A JANELA DA SUBSTITUTIVA
-- NA TELA DE PERIODOS ANTES DE ABRI-LA.
ALTER TABLE `periodo_agendamento`
    CHANGE COLUMN `notaMinima` `notaMinimaN1` DECIMAL(5, 2) NULL,
    CHANGE COLUMN `notaMaxima` `notaMaximaFinal` DECIMAL(5, 2) NULL;

-- A segunda nota que decidiu a reserva, gravada por disciplina.
--
-- FOTOGRAFIA, como a `notaFinal` ao lado dela: com duas notas decidindo, gravar
-- so uma deixaria "ele tinha N1 suficiente?" sem resposta — e e justamente o
-- criterio novo, aquele que a secretaria ainda nao conhece de cor e sobre o qual
-- o aluno vai reclamar no balcao.
--
-- NULA nas reservas ja existentes, e sem backfill: elas foram decididas pela
-- regra antiga, que nao olhou N1 nenhuma. Preencher com a nota de hoje seria
-- afirmar que ela decidiu algo que ela nao decidiu.
ALTER TABLE `agendamento_disciplina`
    ADD COLUMN `notaN1` DECIMAL(5, 2) NULL;
