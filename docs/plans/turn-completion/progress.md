# SDD ledger — plan: docs/plans/turn-completion/plan.md

Spec: docs/plans/turn-completion/design.md. Branch fix/turn-completion from origin/dev aba3e8fbe.

## Pre-flight scan
| Tasks | Shared file / interface | Produces vs consumes | Finding |
|---|---|---|---|
| 1 x 3 | normal-chat-model/index.ts, yieldStreamEvents | T1 deletes the done branches; T3 adds stepCount/lastStepOutputTokens to finish | none: sequential, T3 builds on T1 |
| 1 x 2 | tool events | T1 hides events of tools not offered; T2 counts completed tool calls | consistent: a hidden call is never counted |
| 2 x 3 | stream.ts, stream-orchestrator.ts, stream-completion.ts, chat-turn/AGENTS.md | T2 makes hasTextAfterLastToolCall, noFinalAnswer; T3 needs them plus the repair's outcome | gap: T2 does not name how the outcome reaches completion; T3 adds it (Ruling below) |
| 2 x 4 | stream-fallback.ts | T2 changes the recovered test; T4 changes attempt params | none: different functions |
| 1 | own text | tests vs behaviour | agrees |
| 2 | own text | tests vs behaviour | agrees; "no completed tool call" case is reachable (a call that never finished) |
| 3 | own text | end precedence vs recovery | agrees |
| 4 | own text | gated on docs | agrees |
| all | Global Constraints | "no new stream part type" vs T3 finish fields | no conflict: finish is the model run's event, not a browser part |

## Rulings
- Ruling: base the branch on origin/dev, not local dev — local dev has diverged (4 local merges, behind origin) and the cited files are identical — costs a merge into local dev later.
- Ruling: one implementer at a time (the skill), though I told the owner two could run side by side — avoids conflicts in shared files — costs wall-clock time.
- Ruling: no new e2e spec in the fast route — the notice reuses a rendered list; unit, orchestrator and component tests cover the new code; staging is checked by hand — a UI regression in the notice path would be seen only on staging.
- Ruling: the thinking-off recovery (Task 4) is in, though the owner said "fast route" — it was in my recommendation and is one boxed commit — costs about an hour of agent work; drop the commit if the owner did not want it.
- Ruling: task reviews on sonnet, the final whole-branch review on opus — the owner's model rule — a subtle bug could pass a task review and be caught only at the end.
- Ruling: the plan gives behaviour and tests, not finished code — the owner asked to save orchestrator tokens — implementers take more turns.
- Ruling: the repair is not told which text is already on screen — smallest change — a repaired answer may repeat the preamble's sentence.
- Ruling: T3 carries the repair's outcome to completion itself (T2 only needs the flag) — keeps T2 smaller — T3 touches the orchestrator's fallback closure again.

## Progress
- Task 1: dispatched (sonnet), BASE d5df37a31; brief/report in this folder.
- Staging prep (2026-11-10 12:40Z): staging and prod both run releases/aba3e8fbe. Backup shared/backups/chat-pre-turn-completion-20261110T124010Z.db, then copied provider rows deepseek (68d77707, model 5b03df4e DeepSeek V4.1 Flash 1017) and fireworks-ai (901b7294, model 7a511b91 Kimi K3.1 Pro) + 2 price windows from prod (same SESSION_SECRET on both, so the encrypted keys work as copied; icon_asset_id set NULL). Staging's local model is provider model1 (7107c713), model c45389f7 qwen3-6-27b.
- Staging check script: a sonnet agent is writing scratchpad/staging/verify-turn-completion.mjs (reads the repo only).
- Deploy plan: push branch fix/turn-completion to origin (a side branch, not dev), then DEPLOY_BRANCH=fix/turn-completion deploy-dev.sh. Another session deploys from dev: check `readlink current` before and after testing.
- Task 1: implementer DONE_WITH_CONCERNS, commit e173e4c83 (gate subset green, vitest 24,687). Notes: a habit call to an unoffered tool costs one extra step, capped by the step budget (no cap added); 3 one-line edits outside the file list. Review dispatched (sonnet).
- Baseline on old code (staging aba3e8fbe, 2026-11-10 13:00-13:20Z, results in scratchpad/staging/baseline*.log and /tmp/turn-completion on the box): Kimi tools 1 stub in 20 turns (prompt 2, vis=85 post=0, saved ok); DeepSeek 6/6 and Qwen 8/8 answered. "silent" prompt 1 is repaired by the fallback on Kimi and Qwen ("391"). "quiet" prompts: recovery returns nothing -> backend_failure, or returns DSML tool markup (DeepSeek x2, saved as the answer) or one U+200B (Kimi x2, DeepSeek x1). DeepSeek's reasoning_content API refusal did NOT reproduce (6 recoveries passed, thinking on).
- Ruling: Task 2 counts a zero-width-only chunk as not visible for the new fact and for "the repair grew the text"; hasVisibleAssistantAnswerOutput keeps its meaning — smallest change — a zero-width-only reply is saved with the notice instead of as a normal reply.
- Ruling: Task 4 also (3) tells the recovery it cannot call tools and (4) treats tool-call markup or an invisible reply as no reply (new D7) — found on the baseline, same file — more agent work in Task 4; if wrong, a real answer that begins with such markup would be dropped.
- Task 1: review (sonnet) = Needs fixes. Important 1: the unoffered-tool filter also hides tool events of runs with NO tool set, which turns off the App generator's tool_call failure path (artifacts/app/generate.ts).
- Ruling: Task 1 item 3 narrowed — the filter applies only when the attempt has a tool set; a run without tools reports tool calls as before — the brief's wording did not foresee the App generator — if wrong, a chat run built without tools would show a stray call as a failed tool row (today's behaviour).
- Task 1: minor (deferred): hidden calls leave no trace -> moved into Task 3 (droppedToolCalls on finish, in the record and the log line). Reviewer's ⚠️ (stored prompts naming done): checked both sites' admin_config and personality_profiles, 0 rows.
- Task 1: fix round 1/5 dispatched (resume implementer a6cd67922a271b97a), FIX_BASE e173e4c83.
- Task 1: fix round 1/5 (1 addressed, 0 open — filter narrowed to attempts with a tool set; commits e035637f6..46c886943)
- Task 1: minor (deferred): `tools: {}` would still filter though index.ts treats {} as no tools (no caller passes {}); the retry-without-tools path has no test pinning what it reports.
- Task 1: minor (deferred, PRE-EXISTING, outside this change): artifacts/app/generate.ts:353 stores the raw finish reason `tool_calls` but :450 compares `tool-calls`, so only the tool_call event triggers its failure path; generate.test.ts mocks the whole module.
- Task 1: complete (commits d5df37a31..46c886943, review clean after 1 fix round)
- Task 2: dispatched (sonnet, BASE dc27bf791), then STOPPED on the owner's instruction (hand-off to Codex). The agent left commit c8bc6548a (the notice) and uncommitted work, saved as wip commit 1993e49f1: points 1, 2, 3, 6, 7 built, their five test files pass (378 tests); points 4, 5, 8 and the orchestrator/fallback tests missing; type check not run (expected to fail until the orchestrator passes hasFinalAnswer). Not reviewed.
- Run stopped 2026-11-10. Tasks 3 and 4, the whole-branch review, the full gate and staging are not started. Hand-off: docs/plans/turn-completion/HANDOFF.md. This file is a copy of the run's ledger; the reports and review packages it mentions were scratch files and are gone.
