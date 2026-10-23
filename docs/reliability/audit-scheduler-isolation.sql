-- Read-only scheduler isolation audit, not an application-schema migration.
-- Hosted Supabase owns pg_net tables as supabase_admin and grants PUBLIC table
-- access. Project postgres cannot revoke those grants; SQL Editor hides the
-- resulting warning. Do not claim a REVOKE hardened these tables.
-- Keep net outside exposed Data API schemas; anon/authenticated must be NOLOGIN.
-- Trust every direct database-login role with queued headers and responses.
-- Vault protects storage at rest, while pg_net briefly holds decrypted headers.
-- https://supabase.com/kb/troubleshooting/revoking-access-to-pg_net-objects-has-no-effect
begin read only;
select role_name,
 (select rolcanlogin from pg_roles where rolname=role_name) as can_login,
 has_table_privilege(role_name,'net.http_request_queue','SELECT') as managed_request_queue_grant,
 has_table_privilege(role_name,'net._http_response','SELECT') as managed_response_grant,
 has_table_privilege(role_name,'vault.decrypted_secrets','SELECT') as vault_decrypted_select
from unnest(array['anon','authenticated']) role_name;
select setting as configured_data_api_schemas
from pg_roles r cross join lateral unnest(r.rolconfig) setting
where r.rolname='authenticator' and setting like 'pgrst.db_schemas=%';
rollback;
-- Verify exposed schemas in Dashboard Data API settings too. No net objects
-- should be reachable through client API keys. Don't print queued headers.
