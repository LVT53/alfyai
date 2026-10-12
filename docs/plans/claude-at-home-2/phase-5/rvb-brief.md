# RV-B — Opus look at what the friction build changed in ownership, file serving and the App sandbox (report only)

The friction build (ruling 77) touched three areas where a missed bug is expensive. You review exactly those,
adversarially; **you fix nothing**. Read `phase-5/common.md` first (skip its build sections), then rulings 39, 49, 51, 52,
58 and 77 in `decisions.md` (by range), and AGENTS.md's chat-files and Artifacts paragraphs (in your context).

- Worktree: `.claude/worktrees/rv-b`, detached at the `feat/artifacts` head the orchestrator names in your prompt; e2e DB
  prepared. Port 5520. Report: `<scratchpad>/p5/rvb-report.md`. Budget: about 45 minutes.

## What to check, in this order

1. **Downloads and export jobs (FB-1, then FB-8's export changes; `phase-5/fb1-report.md`, `fb8-report.md`):** the export
   routes (`api/artifacts/[id]/export`, `api/artifacts/[id]/app/download`), `file-production/intake.ts` (`origin`),
   `file-production/read-model.ts` (`getFileProductionJobForUser`, the `origin` filters), the **new**
   `api/chat/files/jobs/[id]/+server.ts`, the unchanged canonical download route and `generated-file-serving.ts`, and
   the client (`client/downloads.ts`, `client/api/file-production.ts`, `DownloadSheet.svelte`). Can one user read or
   download another's job or file, or an incognito chat's without its conversation? Is a foreign and a missing id the
   same answer? Does the end-of-turn stamp (only jobs made since the turn began) ever attach a job to the wrong reply or
   the wrong conversation? If FB-8 reuses an export's file for a repeated press, can that hand over a stale or someone
   else's file?
2. **The App edited from the chat (FB-2, `phase-5/fb2-report.md`):** `edit_artifact` → `EDIT_ARTIFACT_HANDLERS.app` →
   `regenerateApp` → `generateAndVerifyApp`; the contract audit (`auditAppHtml`, ruling 58) on the generated and on a
   verifier's repaired HTML, the version guard, ownership by the turn's conversation (a forked chat, an incognito chat,
   another user's App by id), the per-turn rebuild cap and the timeout; and that the generator now receiving the App's
   stored HTML as context cannot carry a prompt injection into a write that skips the audit.
3. **The restore guard and the App's restore (FB-8, `phase-5/fb8-report.md`):** the body-hash guard, the runnable probe,
   an App restore's metadata, and that nothing in FB-8's transaction change (`behavior: "immediate"`) lets a write skip
   its guard.

Findings by severity (Critical / Important / Minor) with file:line and the steps or input that show each; a verdict
(**ready for `dev`** / **ready after fixes**). Final reply at most 8 lines: verdict, **your model ID**, counts, the one
thing to know.
