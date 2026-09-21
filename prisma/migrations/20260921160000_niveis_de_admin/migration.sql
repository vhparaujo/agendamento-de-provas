-- O ADMIN GANHA NIVEL (21/09/2026)
--
-- Ate aqui nao havia hierarquia: possuir um JWT de admin valido era acesso
-- total ao sistema inteiro — criar outro admin, trocar a senha da prova,
-- cancelar agendamento, tudo. O comentario de src/enums/perfil.enum.ts dizia
-- isso com todas as letras.
--
-- Agora sao tres:
--
--   SUPERADMIN             — o que existia ate aqui, inclusive gerir admins;
--   ASSISTENTE_OPERACIONAL — a operacao do dia (Inicio, Faixas, Polos e salas,
--                            Alunos, Relatorios) mais Agendamentos e Senhas
--                            em SOMENTE LEITURA;
--   VISUALIZADOR_EXECUTIVO — so a tela inicial, para acompanhar os numeros.
--
-- A matriz de rotas vive em src/auth/jwt/niveis.ts. Este arquivo so cria a
-- coluna.
--
-- ---------------------------------------------------------------------------
-- POR QUE O DEFAULT E `SUPERADMIN`
-- ---------------------------------------------------------------------------
-- E a unica escolha que nao tira acesso de ninguem no deploy: toda conta que ja
-- existia tinha acesso total, e precisa continuar tendo ate que um superadmin
-- decida o contrario na tela de Administradores.
--
-- O default NAO e o caminho do cadastro: `CriarAdminDto.nivel` e obrigatorio, e
-- quem cria admin pela API sempre diz qual e o nivel. Ele existe para esta
-- migracao e para o seed do primeiro administrador.
ALTER TABLE `admin`
  ADD COLUMN `nivel` ENUM(
    'SUPERADMIN',
    'ASSISTENTE_OPERACIONAL',
    'VISUALIZADOR_EXECUTIVO'
  ) NOT NULL DEFAULT 'SUPERADMIN';
