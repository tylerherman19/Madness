# Tournament reliability review

This branch adds transactional pick receipts, durable email/campaign records, independently dispatched background workloads, and Game/System administration. It does **not** activate email, apply production migrations, merge, or deploy production.

## Read these first

- [Audit and evidence](AUDIT.md)
- [Architecture decision and lifecycle diagrams](ARCHITECTURE.md)
- [Rules and exception policy](RULES.md)
- [Rollout, activation, recovery and rollback](RUNBOOK.md)
- [Verification and remaining capacity gates](VERIFICATION.md)
- [Scheduler configuration template](scheduler.sql)

The next operating step is an isolated hosted staging deployment. Local functional evidence does not establish Supabase/Vercel capacity for 1,000 simultaneous viewers or the paid Resend account's actual sending allowance.
