# UI review fixes — 2026-11-18

This is the implementer checkpoint for a fresh rereview, not browser or native acceptance.

## Changes against review-ui.md

1. Detail success/failure and focus refresh are fenced by navigation, scope and mounted identity. New editor navigation invalidates pending reads.
2. Stale review traverses the complete current unfiltered snapshot, follows only exact native row identity, guards every await and never replaces the visible filtered page. Missing identity preserves the draft and explains the limitation.
3. Pending operations and exclusion feedback belong to their scope/ref. Unrelated record navigation clears transient review state.
4. Polling survives dismissing a transport alert; Check status remains available. SvelteKit visit snapshots retain only request identity/scope/action metadata, never statement drafts, and reconcile by authenticated requestId on re-entry.
5. Unknown acknowledgements lock the submitted intent and reconcile/retry its existing requestId. Terminal refusals do not offer blind retry. Changing a failed draft invalidates the previous intent using the input event value.
6. Applied removal transitions internally after releasing submitting; accepted Add/Edit leaves the editor before refreshing detail, preventing a second Save if that read fails.
7. Source links use the real chat. The existing authorized older-message reader traverses older windows until target found or exhausted; navigation fencing, shared highlight and reduced-motion scrolling apply. Browser cases cover a target beyond the initial window and a deleted target.
8. Historical chat evidence is read-only. Legacy browser memory API exports and dead home review notice/component were retired; historical backend data is not changed.
9. Profile carries nativeCleanupPending and cleanup operation results through the settings client. Existing ErrorMessage and a status/retry component expose pending remote deletion across reloads; completion appears only after verification.
10. Initial failure differs from accepted empty and prevents Add. Read retry clears recovered errors; load-more retry preserves prior pages. Background work refreshes until its durable outcome, independently of alert dismissal.
11. Missing sources no longer imply Added by you. Inaccessible quotations are hidden and chat titles use the shared localized fallback. Explicit manual origin attribution awaits the backend detail origin field; the UI does not infer it.
12. Introductory Esc/X/backdrop dismissal persists decline; cancelling Profile preserves its choice. Sequenced reads, focus, BroadcastChannel and same-tab notifications reconcile consent and import progress, including save completion after unmount.
13. Rows use the actual theme hover treatment, 12px side insets and existing motion durations. Browser assertions inspect computed background/insets/duration; those browser assertions remain unexecuted at this checkpoint.
14. Per-visit scope/query/page count/row focus/scroll are restored after source navigation. New screens focus a visible heading; background refresh retains loaded pagination. Memory remains mounted while switching Knowledge tabs.

## Evidence

- Regression-first coordinator run reproduced four failures before fixes: `/tmp/memory-ui-review-red.txt`.
- Final Node22 focused Vitest: **214 passed, 12 suites passed**, `/tmp/memory-ui-review-final.txt`. Includes coordinator, page loading, history prompt, cleanup, typed clients, linked-message pagination, shared hover/motion source assertions, historical evidence and HomeSurface.
- `npm run check`: **0 errors, 0 warnings**, `/tmp/memory-ui-review-check-final.txt`.
- Scoped Biome on 13 touched review files: clean after formatting, `/tmp/memory-ui-review-biome-final.txt`.

## Remaining verification and integration

No build, Fallow, browser suite or native-backend acceptance was run by this worker; orchestration owns scheduling. Updated browser suites: memory-replacement, knowledge, home-memory-review-notice, everyday-redesign-screens and zz-knowledge-polish-capture. Source navigation also warrants chat-scroll-on-load and normal chat smoke coverage. Native route-backed actions, cleanup acknowledgement, migration eligibility and complete acceptance must be checked after backend integration. Controlled UI fixtures are not evidence of native extraction quality or durable correction success.

The new operations lookup contract is GET `/api/knowledge/memory/operations?requestId=...`, authenticated owner-only, 404 if unknown. A request without a known acknowledgement must never silently become a fresh mutation. Manual attribution must come from explicit backend provenance. Native identity that changes through split/merge is not guessed by the UI.
