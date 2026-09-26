# The `verification` suite's known-bad fixture

`suites/verification.ts`'s `KNOWN_BAD_CASE` (id `verification-known-bad-unparseable`)
sends the real verifier prompt (`buildVerifierPrompt`) plus an instruction to
ignore the fenced-JSON contract and answer with the bare word `CONFIRMED`.
`parseVerifierAnswer` can never parse that as findings, so the case scores
`bad` deterministically — proving the scorer can see a failure (ruling 25)
without depending on whether the target model would otherwise have caught a
real bug.

The suite's actual positives/negative live in `../apps/*.html`:
`mislabelled-aggregate.html`, `wrong-unit.html` and `wrong-key.html` are the
three hand-audited prototype bug classes (slice-2.md Task A3/A9); `clean.html`
is the negative the verifier must stay silent on. Those are the suite's real,
substantive cases, not its known-bad gate — the whole point of running them
live is that a good verifier SHOULD catch (or correctly not catch) each one,
which is the opposite of a fixture engineered to always fail.
