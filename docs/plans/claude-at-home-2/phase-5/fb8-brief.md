# FB-8 — the leftovers: the restore guard's two edges, a reconnect that never ends, a CSP violation, a locked database

Part of the friction build (`phase-5/build-plan.md`, ruling 77). These are defects the last round found but left. Read
`phase-5/common.md` and the two files it names first, then: RC-V's report (`phase-5/rcv-report.md`, M-1 and M-2), FG's
"Findings in the app" (`phase-5/fg-report.md`), FX-V's "left" list (`phase-5/fxv-report.md`), and AGENTS.md's chat-flow
and streaming paragraphs (`streaming.ts` owns the browser stream contract, `chat-turn/` the server's; do not collapse a
user stop and a local detach).

- Branch / worktree: `fix/friction-leftovers` in `.claude/worktrees/art-fb8`, from `feat/artifacts`. Ports 5440–5449.
- Report: `<scratchpad>/p5/fb8-report.md`. Owns: the build plan's FB-8 row.

## What to fix

1. **RC-V M-1.** Restore's guard also checks the newest row's body hash (History's rows carry it), so a late save that
   coalesced into the newest version without changing its number cannot be restored over unseen; the answer is the same
   "It changed while you were looking" state.
2. **RC-V M-2.** Before an App version's runnable check answers, Restore is not offered (or is offered disabled with a
   quiet wait), so a question never opens on a version that turns out Code-only.
3. **FG's reconnect hang.** A reload within a few hundred milliseconds of a first turn that fails at once leaves the
   reconnect request open with no terminal event (`chat-turn/stream-reconnect.ts` `doReconnect`: replay the buffer, then
   subscribe, while the original run's failure lands a millisecond later). Reproduce it with a provider that refuses at
   once (FG's log excerpt is in its report), then make every reconnect end with the run's terminal event or an error,
   and never leave a turn spinning.
4. **`map-route-card`'s CSP** on a production build (a report-only `unsafe-eval` violation; it is quarantined in
   `tests/e2e/quarantine.json` today): find what evaluates code, fix it without loosening the CSP, and take the test out
   of quarantine.
5. **"database is locked"** for a second writer on a deferred read-then-write transaction (`updateArtifactBody` is one):
   the write transactions that read first take the write lock up front (`behavior: "immediate"`, as FG did in the test
   servers), with a unit test that runs two writers.
6. **An App restore's metadata** (FX-V's note): restoring an App version leaves its verification and glitch metadata
   describing the version that was live before; make them describe what is live now (or clear them with a quiet line).

7. **Exports (FB-1's notes, `phase-5/fb1-report.md`).** An export is a delivery: a repeated press for the same item
   version and format reuses the file it made, and exports are not listed as separate "GENERÁLT" rows in the library
   (they belong to their item, which already has its download); a generated file row shows no bare "V1" (ruling 76's
   Q2: no number outside History); a failure after the Download popover has closed tells the reader (a toast), never
   silence; a source-first generated row in Knowledge opens its preview instead of "Preview not available". FB-1 owned
   `DownloadSheet.svelte`, the export routes and Knowledge; they are yours now for these.

## Tests and gates

Red first: unit tests for 1, 5, 6; real-input Playwright for 1, 2 and 3 (3 with the e2e fake provider made to fail at
once, then a reload); 4 by taking the spec out of quarantine. `scripts/gates.sh agent <out-dir> --port 5440 --workers 4`
with your specs plus `artifact-history.spec.ts`, `streaming.spec.ts`, `chat.spec.ts`, `conversation-refresh.spec.ts`,
`map-route-card.spec.ts` (or its real name).

Final reply at most 12 lines: status, **your model ID**, commit range, gate summary, the reconnect hang's cause in one
line, concerns.
