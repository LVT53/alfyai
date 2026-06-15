# Account Data Archive Is Human-Readable

The Account Data Archive is a self-service, password-confirmed ZIP for the signed-in user, built around a friendly HTML entry file named `Open AlfyAI Data Archive.html` and original files rather than an importable machine snapshot. We chose a human-readable archive because the foreseeable product need is personal review and GDPR-style access, not backup/restore portability, and exposing raw database-shaped JSON would make the export harder to understand while accidentally creating an importer contract.
