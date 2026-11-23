# Memory recall part 1: acceptance

Plan: [Task 7 of the part 1 plan](../../superpowers/plans/2026-11-23-memory-recall-part-1.md). Branch `claude/memory-recall-part-1-42a4af`. Counts and timings only, no entry text. Every account, fact and message in these runs is synthetic.

## Size check (local, the app's side)

23 November 2026, commit `f5a3b4368`, this Mac, Node 22, Vitest 4.1.12.

```sh
MEMORY_RECALL_SIZE_CHECK=1 npx vitest run --reporter=verbose src/lib/server/services/memory-context/native-recall-size.integration.test.ts
```

| Rows (personal + project) | Recalls | Median | 95th percentile | Bar | Result |
| --- | ---: | ---: | ---: | --- | --- |
| 5,000 + 1,000 | 20, per turn | 172.9 ms | 190.2 ms | under 500 ms | pass |

In-memory SQLite and a fake native client whose every ranking returns all rows. The budget was 4,000 tokens, and the sources were not linked to chats. Both make it lighter than production; the whole-branch review deferred that as a minor. Hindsight's own search time at 5,000 entries is not measured here.

## Live check

Not run. The owner is deciding about it, because the non-production Hindsight it targets (`127.0.0.1:18890`) no longer exists.

## Age probe

```sh
HINDSIGHT_NATIVE_ACCEPTANCE=1 ALFY_API_KEY=... npx vitest run --reporter=verbose src/lib/server/services/memory-profile/native-recall-age-probe.integration.test.ts
```

The probe runs 20 synthetic turns on Flash-Next (`qwen3-6-27b` through `inference.alfycomms.com`), 10 in English and 10 in Hungarian. Each turn asks for a lasting fact whose newest source is 13 months to 3 years old. Bar: at most 2 of the 20 replies may remark on the fact's age or doubt it. An English and Hungarian phrase list gives the verdict, and a reader may overrule one from the printed replies.

| Run | Started (GMT) | Commit | Replies | Flagged (EN / HU) | Result |
| --- | --- | --- | ---: | ---: | --- |
| 1 | 23 Nov 2026, 18:04 | `6c7c906dc` | 15 of 20 | 4 (3 / 1) | does not count |
| 2 | 23 Nov 2026, 18:16 | `0f875d378` | 20 of 20 | 4 (2 / 2) | fail |

### Why run 1 does not count

Run 1 measured the probe, not the wording.

- **The synthetic person contradicted itself.** Blood type, birthplace and height each had one value in English and a different one in Hungarian, and both values reached the same memory section. All four flagged replies pointed out the contradiction and used the dates to say which entry was newer.
- **Five turns got no reply.** Each one called `run_python`, which cannot reach Docker on this Mac, and a failed `run_python` call ends a turn.

Commit `0f875d378` fixed both:

- The person is now consistent: 20 facts on 20 subjects, and each memory section holds one fact per topic.
- The probe's turns are offered every tool but `run_python`.
- Every turn checks that the model got its fact with its age, got no second fact on that topic, and was not offered `run_python`.

### Run 2

Every turn got a reply, and every per-turn check held. Read by hand, all four flagged replies are real effects of the wording; none is a phrase-list false positive:

- 2 replies add a caveat that a dated fact (an anniversary, a birthday) should be confirmed, because the note is two years old.
- 1 reply says when a fact was recorded, without doubting it.
- 1 reply reads "said 2 years ago" as the date of the event itself.

No unflagged reply mentions the age.

Nothing was changed after run 2: changing the wording is the owner's call.
