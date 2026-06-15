# Privacy Controls and Account Data Archive

This note records the agreed product shape for GDPR-oriented profile controls before implementation. The canonical domain terms live in `CONTEXT.md`; this document keeps the implementation-facing decisions together.

## Profile Controls

The Profile tab should replace the generic danger-zone grouping with **Privacy and Data Controls** for every signed-in user. The four actions are:

- **Download my data**: prepares a password-confirmed Account Data Archive ZIP for the signed-in user.
- **Clear memory and knowledge**: removes remembered context, Knowledge Base documents, document-derived context, continuity state, embeddings, working-set/context status, and stored evidence traces while keeping chat conversations and the account.
- **Clear workspace data**: removes chats, Knowledge Base content, app-controlled memory, generated files, and workspace continuity while keeping login, profile settings, avatar, and identifiable historical analytics.
- **Delete account**: performs Account Erasure.

All destructive privacy controls should offer a secondary "Download my data" action before confirmation. Deletion must not be blocked on downloading an archive.

Password confirmation is required for Download my data, Clear memory and knowledge, Clear workspace data, and Delete account. Clear workspace data signs the user out after completion. Clear memory and knowledge does not need to sign the user out.

Self-service Delete account should not block the last remaining admin. Admin deletion of another user may keep its existing last-admin guard.

Admins must not be able to download another user's Account Data Archive in v1.

## Account Data Archive Scope

The archive is a transient, self-service ZIP generated for the signed-in user and discarded after download. It should not create durable export history or leave ZIP files on disk. The downloaded filename should be neutral, for example `AlfyAI Data Archive 2026-06-15.zip`, without email or display name.

The archive starts with `Open AlfyAI Data Archive.html`, uses stable English folder and file names, and preserves stored user content in its original language. It should be human-readable and easy to navigate, not a restore format, importer contract, diagnostic trace, or raw database dump.

Include:

- profile facts and preferences, excluding secrets
- avatar/profile picture if present
- chat messages with user messages and assistant responses
- minimal transcript file links for uploaded and generated files
- original uploaded Knowledge Base files
- original generated files
- app-controlled memory in readable summary and detailed memory pages
- user-created Skill definitions and Skill Notes
- readable ChatGPT import provenance on imported conversations
- personal analytics summaries and simple tables
- clear exclusion notes

Exclude:

- Deep Research data in v1, with an explicit exclusion note
- assistant thinking traces
- hidden system prompts, prompt context, raw tool JSON, provider payloads, retry/debug fields, and diagnostic metadata
- password hashes, session IDs, cookies, service assertions, provider API keys, storage paths, and app/admin secrets
- raw import ZIPs, parser internals, summarizer state, and embedding state
- opaque third-party provider logs outside AlfyAI's control
- local process/server logs

Archive generation should fully fail if any in-scope section cannot be loaded or written. A partial archive is misleading and should not be downloaded. Deep Research is a planned v1 exclusion rather than a failure.

## Erasure Scope

Account Erasure removes local personal workspace data and app-controlled external memory state. It also applies when an admin deletes another user.

After Account Erasure, only anonymous aggregate usage and cost totals may remain. Retained records must not preserve email, display name, user ID, conversation title, message ID, or pseudonymous per-user rows for the erased person.

Account Erasure should quiesce user-owned running work before destructive cleanup so streams, file production, Deep Research, or memory maintenance cannot recreate erased data afterward.

Shared admin-authored deployment content should survive an admin account erasure with authorship detached or anonymized. Published campaigns, provider/model configuration, system skills, and similar shared records should not be deleted merely because the author account was erased.

## Prototypes

The proposed archive visual language is prototyped in:

- `docs/prototypes/account-data-archive.html`
- `docs/prototypes/chat-quarterly-roadmap-planning.html`
- `docs/prototypes/memory-compact-planning-documents.html`

## Implementation Breakdown

The implementation has been broken into local, issue-ready vertical slices in `docs/privacy-controls-implementation-issues.md`.
