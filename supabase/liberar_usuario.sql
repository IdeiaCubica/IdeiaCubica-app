-- ============================================================================
-- Libera o usuário que terá acesso total ao sistema (executar UMA vez).
--
-- Antes: Supabase → Authentication → Users → Add user → Create new user
--        (marque "Auto Confirm User"). A senha é definida por você ali.
-- Depois: troque o e-mail abaixo pelo e-mail desse usuário e clique em Run.
-- ============================================================================
insert into public.app_members (user_id, role)
select id, 'owner'
  from auth.users
 where email = 'SEU-EMAIL-AQUI@exemplo.com'
on conflict (user_id) do nothing;

-- Conferência: deve listar 1 linha com o seu e-mail.
select u.email, m.role, m.created_at
  from public.app_members m
  join auth.users u on u.id = m.user_id;
