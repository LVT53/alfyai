# Targeted DeepSeek fix — verification

2026-11-10. Tested code `e2045e1dacc63f5a4a105e5d77e5a3937ffbfac1`, `fix/turn-completion`.

## Verdict

The targeted fix passes the agreed staging checks. Both previously failing URLs now work; four follow-ups in one
DeepSeek conversation also work. No broader runtime blocker was reproduced. Work stops at the requested scope;
architectural completion hardening below is not implemented.

## Diagnosis and fix

The installed AI SDK already preserves actual model-generated `reasoning_content` through native streaming and
plain tool loops. HTTP-capture tests disproved the initial adapter-cache hypothesis.

Fresh URL requests instead contained an **app-generated** assistant `fetch_url` call from server prefetch, with no
actual model reasoning. DeepSeek rejected that synthetic history. A prefetch-only compatibility policy now passes
those fetched pages as retrieved evidence in the user packet through the existing inline path. Native model history,
real in-flight tool reasoning, MiMo and MiniMax behavior remain unchanged. No reasoning is fabricated, disabled,
logged or copied across attempts.

Review caught a provenance regression: removing model-facing tool messages could lose page-link eligibility. The
fix registers actual retrieved evidence independently of request representation. Authenticated tests verify real
page links remain eligible and invented, cross-user and cross-conversation addresses remain refused.

The stored-history characterization intentionally models a stricter provider rejection when reasoning is missing.
That negative fixture is not evidence of a live historical-turn failure: the real shared-conversation probe passed.

Official reference checked: https://api-docs.deepseek.com/guides/thinking_mode/ . Installed `ai@6.0.193` and
`@ai-sdk/openai-compatible@2.0.48` source and captured requests were the version-specific authority.

## Verification

Independent task/whole-extension review passed after the provenance fix; its scoped re-review also passed.

```sh
scripts/gates.sh agent /tmp/alfyai-deepseek-gate --port 4710 --workers 4 \
  tests/e2e/chat.spec.ts tests/e2e/streaming.spec.ts tests/e2e/conversation.spec.ts \
  tests/e2e/ask-me-first.spec.ts tests/e2e/fake-provider-chat.spec.ts
```

ALL GATES PASSED: 24,819 unit tests passed (three existing skips), 90 browser tests passed (no failures/skips/flaky),
typecheck zero errors/warnings, clean build, Biome/migrations/chunks passed. Fallow 3.33.1 retained the same four
cycles with no new finding. Scratch-database `db:prepare` completed. Full gate ran once after code/review completion.

## Staging results

Serial batches avoided the previous account-capacity problem. All requests explicitly selected thorough reasoning.

| Model | Ordinary tool turns | Additional probes |
|---|---|---|
| DeepSeek V4.1 Flash | 12/12 answered directly | 4/4 follow-ups in one conversation; silence 1 direct; blank probes 3 recovered |
| Kimi K3.1 Pro | 12/12 answered directly | silence 1 recovered; blank probes 2 recovered, 1 visible empty-answer error |
| Qwen 3.8 Flash Next | 20/20 answered directly | silence 1 direct; blank probes 1 direct, 1 recovered, 1 correctly paused via ask_user |

All 44 ordinary turns and all four shared-conversation turns answered without recovery, notice or provider error.
The deliberate Kimi empty-reply failure had zero visible text and produced a visible error after recovery also
returned no answer; it did not save a completed stub. Its error was not a provider exception. The Qwen pause was
saved as paused and did not invoke recovery or answer for the user.

Total: 60 requests, 57 new synthetic conversations, 59 saved assistant segments: 51 answered, seven recovered,
one paused. All 59 had completion records and the journal had exactly 59 `[TURN_END]` lines. Audit found zero
unflagged saved tool-only endings, zero dropped calls, zero DeepSeek reasoning pass-back errors, zero upstream error
events and zero fallback exceptions. Actual backend model names were verified through usage rows for exact test IDs.

Structured summary: [staging-results.json](./staging-results.json). Raw synthetic runs, shared-conversation script
and full per-ID audit: `/tmp/turn-completion-deepseek/` on `alfyroot`; local logs `/tmp/alfyai-deepseek-*`.

## Remaining broader work for full completion coverage

1. **A bounded closing phase at unfinished loop exit.** Reserve one tools-disabled answer step with adequate output
   room for budget/stagnation/truncation/reasoning-only endings. Keep stop, pause and successful-delivery exemptions;
   preserve explicit failure when even closing cannot answer. This also gives progress narration a separate phase.
2. **Continuation from complete original context.** Replace digest/pipeline rebuilding with continuation carrying
   original tool results and provider-required reasoning, without re-running tools. Preserve the same evidence
   through pause/resume, retry and provider failover. Current inline-prefetch evidence is not reconstructed on a
   resume; a different primary failing over to DeepSeek can still carry its initially native synthetic prefetch.
3. **One durable completion contract across entrypoints.** Extend the stream rule to non-streaming send and record
   actual app stop causes and failed/unsaved attempts. Final-step narration can still satisfy a text-presence rule;
   explicit closing-phase ownership is preferable to short-text heuristics.

These are known architectural gaps/hardening items, not failures observed in the ordinary or shared-conversation
staging tests above. No additional storage/history/recovery redesign was undertaken.

## State and data touched

Only `origin/fix/turn-completion` was pushed; staging moved from `875db0634` to `e2045e1da`, with successful deployment
and unchanged release throughout the test run. Final health: OK, draining false, activeStreams zero. Production and
`dev`/`main` were untouched. No staging model/provider configuration changed.

Tests used only synthetic prompts in the dedicated staging test account. Server writes were normal test conversation,
message, tool and usage records, the staging release/deploy backup/pruning, and test artifacts under `/tmp`.
Read-only SQL inspected exact generated assistant IDs; journal reads were limited to the staging test window.
No owner conversations/documents were test input. The deliberately paused question remains in its test conversation.

## Rulings

- Corrected the hypothesis after actual SDK wire captures passed; no unnecessary replay wrapper was enabled.
- Used a prefetch-only policy instead of changing all historical tool serialization; broader behavior stays explicit.
- Fixed provenance at its existing owner using actual retrieved data, not model text or a relaxed address gate.
- Used serial staging and a four-turn shared-conversation probe. Live acceptance supersedes a hypothetical strict
  mock rejection when reporting observed stability; it does not erase the documented context-lifecycle limitations.

Full decisions and review history: [progress.md](./progress.md).
