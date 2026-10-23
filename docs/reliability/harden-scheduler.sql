-- Configuration after installing pg_net. Not an application-schema migration.
-- The queue briefly contains the scheduler's Authorization header; responses
-- may contain restricted workload progress. Keep both out of end-user roles.
-- net.http_get is SECURITY DEFINER and scheduled jobs run as postgres, so
-- revoking table grants does not remove their request/response access.
begin;
revoke all on table net.http_request_queue,net._http_response from public,anon,authenticated;
commit;
-- Verify after applying; do not select request headers or response bodies.
select role_name,
 has_table_privilege(role_name,'net.http_request_queue','SELECT') as request_queue_select,
 has_table_privilege(role_name,'net._http_response','SELECT') as response_select
from unnest(array['anon','authenticated']) role_name;
