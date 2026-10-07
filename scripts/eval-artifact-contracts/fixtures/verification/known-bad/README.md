# The `verification` suite's known-bad fixture

`suites/verification.ts`'s `KNOWN_BAD_CASE` (id `verification-known-bad-unparseable`)
is the real verifier prompt (`buildVerifierPrompt`) and an ordinary request,
answered with a hand-written answer committed beside the recorded model answers:
`../responses/verification-known-bad-unparseable.json`, the bare word `CONFIRMED`
instead of the fenced JSON the contract asks for. `parseVerifierAnswer` can never
parse that as findings, so the case scores `bad` in a live run and in `--replay`
alike, proving the scorer can see a failure (ruling 25) without depending on
whether the target model would otherwise have caught a real bug.

It is served from disk in a live run too and the model is never asked for it
(ruling 59: the case used to ask the verifier to "ignore the fenced JSON format",
`qwen3-6-27b` kept the contract instead, and the live gate rightly refused every
score in that run). `run.ts` never sends a known-bad case and recording skips it;
`known-bad.test.ts` holds that for every suite.

The suite's actual positives/negative live in `../apps/*.html`:
`mislabelled-aggregate.html`, `wrong-unit.html` and `wrong-key.html` are the
three hand-audited prototype bug classes (slice-2.md Task A3/A9); `clean.html`
is the negative the verifier must stay silent on. Those are the suite's real,
substantive cases, not its known-bad gate: the whole point of running them
live is that a good verifier SHOULD catch (or correctly not catch) each one,
which is the opposite of a fixture engineered to always fail.
