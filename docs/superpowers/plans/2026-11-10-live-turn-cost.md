# Live turn cost implementation plan

Goal: update message and conversation cost after a streamed turn without refresh, including delayed accounting.

Scope: accounting reads, browser reconciliation and tests only. Hold interim-output/harness changes. Both related chats were read: active fix/turn-completion owns recovery and DeepSeek replay; Review harness architecture proposes plain-run usage aggregation, not this display fix.

Architecture: expose a small authenticated per-message usage read through analytics, with explicit pending/ready/untracked outcomes. Poll serially in the browser until usage is recorded, bounded and cancelled on navigation. Refresh cost independently of context metadata; keep existing eventual projection hydration rules.

- [x] Add regressions for context metadata suppressing cost refresh, delayed usage, zero cost, incognito and ownership.
- [x] Add scoped accounting read and thin route; add browser API and cancellable refresher. Wire page application and lifecycle cleanup.
- [x] Verify visible ring and Info values without reload, delayed accounting and stale navigation; run focused tests.
- [x] Review diff and run the mandatory agent gate once, including affected chat specs. Leave unrelated work untouched; no push/deploy.

Official SvelteKit routing and Vitest timer docs checked; documentation MCP tools unavailable. Reuse the current checkout without switching its branch; other active implementation uses its own worktree.

Review: independent reviewer found one stale-detail accounting race; regression reproduced it and the independent usage freshness guard now passes. Focused verification: 541 tests passed before the final race regression, which also passed separately. Full gate is in progress. Sandbox-blocked migration/server/browser checks were restarted with local process permissions; Fallow reports 15 pre-existing findings in unrelated untracked embedding evaluation scripts and four unchanged cycles.

Final verification:
- Full unit suite: 24,196 passed, three skipped; all 245 page integration tests passed.
- Browser gate: 63 other checks passed. The delayed-cost regression passed separately against the same production build after correcting test pricing setup and its Info selector. It forces two pending responses, then verifies real ledger cost in Info and the ring without navigation/reload.
- Typecheck: zero errors, zero warnings. The existing gate parser expects machine output but the check command prints human output, so its summary marks this successful command failed.
- Build, migrations, Biome and bundle checks passed. Build retains 15 dependency D3 circular-import warnings; Fallow retains 15 findings in unrelated untracked embedding evaluation scripts and the same four known cycles. No suppressions or baseline changes.
- Independent review approved after the stale-detail fix. Official SvelteKit routing, Vitest timer and Drizzle join documentation checked. No model/harness/recovery edits, no push or deployment; the second issue remains on hold.
- Logs: /private/tmp/alfyai-cost-gates-final.log and /private/tmp/alfyai-cost-browser-final.log.
