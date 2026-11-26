# Normal Chat turn completion audit — 2026-11-10

Scope: why a Kimi K3.1 Pro turn on production ended with a 95-character preamble and no
answer, how often turns end without a substantive answer across all models, and whether the
proposed "force a text-only closing step" patch is a fix or a band-aid.

Evidence base:

- production `chat.db` on `alfyroot` (`/home/alfydesign/apps/langflow-chat/shared/data/chat.db`),
  read-only, window 2026-08-12T11:51Z → 2026-11-10T11:51Z (90 days), **910 assistant messages**
  joined to `usage_events`;
- `journalctl -u langflow-chat.service`, retained since 2026-10-20 (21 days);
- code: `dev@fbfeed369`; production release `5b3b5b0d5` has identical copies of every file cited
  below (verified with `git diff 5b3b5b0d5 HEAD -- <files>`), so line numbers hold for both.

## 1. Summary

| Observation (90 days unless stated) | Count | Rate |
|---|---:|---:|
| Assistant turns | 910 | — |
| User stops (`wasStopped` or content `Stopped`), excluded | 18 | 2.0% |
| **A. No substantive answer** — preamble/status update only, or cut before answering | **7** | **0.77%** |
| **B. Truncated tail** — substantial answer that stops mid-sentence | **12** | **1.3%** |
| Empty saved assistant message | 0 | — |
| Zero-text stream ends (app-detected, journal, 21 days) | 5 incidents / 4 conversations | ≈2.4% of turns |
| Turns with ≥10 tool calls | 17 | 1.9% |
| Turns with ≥14 tool calls (budget pressure) | 5 | 0.5% |

The Kimi failure is a **new trigger of an existing class, not a new class**. The class is
"the tool loop ends without a final answer". Triggers observed in production: premature
`done`, tool-budget exhaustion, stagnation, and provider-side stream errors. The app already
detects and recovers from the *zero-text* variant by re-running the whole turn (5 incidents in
21 days); it does **not** recover from the *preamble* variant, because any non-empty text is
treated as an answer.

## 2. Method

Messages are classified from `messages.content`, `messages.thinking`, `messages.tool_calls`
(JSON entries of type `text` and `tool_call`), and `metadata_json` (`wasStopped`,
`modelDisplayName`, `depthMetadata`).

- **User stop**: `wasStopped: true`, or content exactly `Stopped` — excluded.
- **A. No substantive answer**: under 300 characters, at least one tool call, and the text is a
  status update / promise of later work, or ends mid-sentence before any answer (manual review
  of a 15-turn shortlist produced by `chars < 300 and thinking > 3,000`).
- **B. Truncated tail**: 200+ characters that end mid-sentence (last character is not terminal
  punctuation) after manual review; citation lists ending in a source name and lines ending in
  emoji, `© OpenStreetMap contributors`, or a closing question were rejected as false positives.
- **Zero-text incidents**: counted from the `[STREAM] Upstream stream ended before final
  assistant answer` warning in the journal. Each incident logs twice (warning + fallback error),
  so 10 log blocks = 5 incidents.

## 3. The seven Class A turns

| Turn | Model | Chars | Text |
|---|---|---:|---|
| `c0643731` | Kimi K3.1 Pro | 95 | "I'll calculate the costs from the unrounded token counts, then round only the requested totals." |
| `a310864b` | Qwen 3.8 Flash | 177 | "…I'll lay out your options." (no options) |
| `3bd1fd1e` | Qwen 3.8 Flash | 121 | "Checking the neighbourhood trade-offs…" (no result) |
| `490c8117` | Qwen 3.8 Flash | 195 | "…The WikiArquitectura drawings section is image-only —" |
| `da702b1c` | Qwen 3.8 Flash | 238 | "…The WikiArquitectura gallery is mostly photos —" |
| `6d7dd41d` | Qwen 3.8 Flash | 240 | "…The folder shows both files saved. Now" |
| `baabdb93` | Qwen 3.8 Flash | 70 | "Sunday evening in Limerick with a group and an activity as the anchor." (borderline) |

`a9603938` (165 chars, "I'll check what's available in the sandbox…") is borderline and not
counted: it is a status update, but the turn also produced the file it promised.

Six of the seven are on the current production model. Kimi's is the only one with a documented
tool-loop trace (`run_python` completed, then two premature `done` calls), because the new model
makes the same failure reproducible.

## 4. The Kimi trace

```
12:44:33  [CHAT_STREAM] start
12:44:35  first-output timeout adjusted → 10000 ms
12:44:51  step 0 finish: finishReason=tool-calls  in=19161 out=993
12:45:22  step 1 finish: finishReason=tool-calls  in=20343 out=1571
12:45:22  language/title/analytics — no second run, no error
```

Stored message: content 95 chars, `thinking` 10,035 chars, one `run_python` call (`status: done`,
exit 0). The reasoning tail ends: *"I'll call done summary then respond."* The answer was
composed in the reasoning stream and never emitted as text; the model called `done` twice, and
the app's "second premature done stops the loop" rule ended the turn. Usage event: 39,504 input
+ 2,564 output tokens, $0.1046.

## 5. Root cause (five layers)

1. **Two competing termination signals.** The app asks the model to call a `done` tool
   (`normal-chat-tools/index.ts:3236`) whose description says "call once, at the very end, when
   the answer is complete… do not use it before the answer text exists". The API already has a
   native end-of-turn: an assistant message with no tool calls (`finish_reason: stop`). Models
   post-trained with a `done` tool in their harness (Kimi) use it as the turn terminator, not as
   a post-answer receipt.
2. **Termination is model-driven; the answer contract is not enforced.** The loop can end on a
   premature `done` (`normal-chat-model/index.ts:143-158`), the step budget
   (`buildToolStopWhen`, 179-186), stagnation, or a provider error. Nothing guarantees a final
   text step exists.
3. **The success predicate is too weak.** `hasVisibleAssistantAnswerOutput` is
   `Boolean(fullResponse.trim())` (`stream-orchestrator.ts:853`). A 95-character preamble
   satisfies it, which suppressed the existing no-answer fallback and saved the stub as a
   completed turn.
4. **Recovery is only for zero text, and it re-runs everything.** The fallback
   (`stream-terminal.ts:150-210`, gated by `stream-fallback-policy.ts`) requires *no* visible
   output and re-runs the whole pipeline, tools included — the 2026-09-05 harness review
   (`docs/harness-review-2026-09-05.md` §3.3) records that side-effecting tools can run twice.
5. **No telemetry.** `finish_reason`, step count, premature-`done` count, and whether the last
   step had text are not stored or logged. The class had to be inferred from message text; a
   preamble longer than 300 characters is invisible to this audit and to the app.

## 6. Why the one-line fix is not enough

Forcing `toolChoice: "none"` after a premature `done` fixes trigger 1 only:

- the budget/stagnation/provider triggers still dead-end;
- layer 3 is untouched, so a closing step that also fails to produce text still saves a stub as
  "answered";
- layer 4 still recovers only the zero-text case;
- layer 5 still leaves the class unmeasurable, so nobody can tell whether the fix works.

## 7. Proposed design: an enforced turn-completion contract

1. **Define "answered" once**, in the loop: the last step produced visible text and has no
   pending tool calls, or the turn paused on `ask_user`, or the deliverable is a completed
   file/artifact. Text emitted before the last tool call (a preamble) does not count.
2. **Enforce it at loop exit, whatever the reason.** If the run is not "answered", run exactly
   one closing step with tools disabled (`toolChoice: "none"`), then re-evaluate. This covers
   premature `done`, budget exhaustion, stagnation, and provider truncation with one rule.
3. **Make the stream terminal use the same predicate** instead of "any text". A preamble-only
   turn must reach the existing fallback, and if the fallback also fails, surface an error
   rather than persist a stub.
4. **Instrument before tuning.** Record `finishReason`, steps used, premature-`done` count,
   whether the closing step ran, and whether the answer came from it. That is the only way to
   know whether `done` should be retired.
5. **Retire `done`** (or keep it as a no-op advisory) once (1)–(4) are in place. The summary it
   carries is only used as a non-streaming text fallback (`normal-chat-model/index.ts:1535`);
   with (1)–(2) that fallback is no longer needed.

## 8. Alternatives considered

- **Remove `done` now.** Simplest and removes the incentive, but changes loop termination for
  every model at once, and the done summary is still used in the non-streaming path. Do it after
  instrumentation, not before.
- **Raise the two-premature-`done` threshold.** No help: the turn still ends without text.
- **Length/preamble heuristics on the client.** Fragile, hides the failure, and does not cover
  the other triggers.
- **Always force a non-streaming re-run when the answer is short.** Doubles generation cost for
  legitimate short replies ("Found the vault.").

## 9. Test plan for the chosen design

- Loop: two premature `done` calls → closing step runs, text is yielded, turn persists an
  answer. (Extends `normal-chat-model/index.test.ts:4686` and `:4827`.)
- Loop: closing step is issued with tools disabled and no `done` in the tool set.
- Terminal: a preamble-only turn does not satisfy the answer predicate and reaches the
  fallback; a real short answer does satisfy it.
- Exemptions: user stop, `ask_user` pause, and file-production-only turns never trigger the
  closing step.
- Recovery: closing step also empty → fallback once → visible error, never a persisted stub.
- Observability: the new fields appear in the turn's usage/analytics record.

## 10. Limitations

- No stored finish reason or step history, so Class A/B rates are text-level inference, not
  counts of premature `done`. The true rate can be higher.
- Journal retention is 21 days; the 5 zero-text incidents are a lower bound.
- 910 turns across six users; Class A is seven turns and two of them are borderline.
- Classification was manual on a shortlist; borderline cases are listed in §3 rather than
  silently bucketed.
