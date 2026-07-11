# Account Data Archive Is Human-Readable

The Account Data Archive is a self-service, password-confirmed ZIP for the signed-in user, built around a friendly HTML entry file named `Open AlfyAI Data Archive.html` and original files rather than an importable machine snapshot. We chose a human-readable archive because the foreseeable product need is personal review and GDPR-style access, not backup/restore portability, and exposing raw database-shaped JSON would make the export harder to understand while accidentally creating an importer contract.

## Update (arch-hardening C7): unaffected by the erasure consolidation

The archive is the read-path sibling of Account Erasure. The C7 consolidation (one account-lifecycle owner + a single user-scoped-table registry) and the analytics identity de-denormalization (ADR-0029) did **not** change the archive: it already reads identity from the `users` row of the signed-in user and never depended on the denormalized `usage_events` / `analytics_conversations` email/name columns that were dropped. Recorded here so the two privacy operations stay reconciled — the archive builder was reviewed and left as-is.
