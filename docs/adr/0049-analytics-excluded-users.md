# System Analytics can exclude specific users, including deleted ones

Accepted. Admin **System Analytics** supports an operator-configured exclusion list so that named users (typically staff/test accounts) are filtered out of usage and cost figures at query time. The exclusion picker enumerates every user that appears in `usageEvents` — **including users who were deleted but still have historical rows** — so their prior activity can also be excluded. This complements **ADR-0029 (Account Erasure keeps only anonymous aggregates)**: erasure removes person-linked rows entirely, whereas exclusion filters still-identified rows out of the operator's own dashboards without deleting anything.

> **Recorded 2026-07-10, retroactively.** Landed 2026-06-26 / 2026-07-10 ("include deleted users in exclusion list", "Restore per-model breakdown table on admin System Analytics"). It was described only in `docs/analytics-dashboard-read-model-slices.md`, not in an ADR or CONTEXT.md.

## Behavior

- The list is the `analyticsExcludedUserIds` config value (env `ANALYTICS_EXCLUDED_USER_IDS`). Excluded user ids are filtered from every System Analytics aggregate at query time — totals are computed as if those users' events did not exist. Nothing is deleted; toggling a user off the list restores their contribution.
- The read model exposes `analyticsUsers` (`analytics.ts`) — the id/email/name of every user present in `usageEvents`, sourced from the event rows rather than the live `users` table. A user who has been **deleted** (but not erased under ADR-0029) still owns historical usage rows, so they appear in the picker and can be excluded; a live user with zero events does not appear.
- Exclusion is a **presentation** concern: it shapes the admin dashboard only. It does not alter stored `usage_events`, does not change what was billed, and is distinct from erasure's data removal.

## Considered Options

- **Filter only live, non-excluded users by joining the `users` table.** Rejected: deleted users retain historical rows that skew totals, and a `users`-table join would make them un-excludable — the exact case that motivated sourcing the picker from `usageEvents`.
- **Delete staff/test rows to clean up analytics.** Rejected: destroys real operational history and conflates a dashboard-hygiene preference with data deletion; ADR-0029 erasure is the only path that removes rows, and only for account erasure.
- **Query-time exclusion list sourced from event rows (chosen).** Reversible, non-destructive, and able to exclude deleted-user history.

## Consequences

- **Analytics totals are operator-relative.** Two admins comparing figures must share the same exclusion list; a headline number is only meaningful alongside who is excluded.
- **Interaction with erasure is intentional.** Once a user is *erased* (ADR-0029), their identified rows are gone and they drop out of the picker; until then, "deleted" users remain excludable. Do not assume the picker lists only active accounts.
- **CONTEXT.md warrants a brief Admin System Analytics term** covering excluded-users and the deleted-user inclusion rule, so the read-model behavior is not rediscovered from the slices doc.
