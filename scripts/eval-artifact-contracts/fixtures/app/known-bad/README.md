# The `app` suite's known-bad fixture

`suites/apps.ts`'s `KNOWN_BAD_CASE` (id `app-known-bad-no-fence`) is a prompt,
not a file: it appends an instruction to the real App contract prompt telling
the model to ignore it and answer with the single word `OK`. Any compliant
model does this, and `extractAppHtml` can never accept it as a fenced app, so
the case scores `bad` deterministically in both a live run and `--replay` —
proving the scorer can see a failure (ruling 25) without depending on the
target model's actual quality at the ten real prompts.

This directory exists to satisfy the suite's fixture-layout convention
(`fixtures/<suite>/known-bad/`, `slice-5.md §The eval harness`); there is no
separate HTML file to load because the fixture's "badness" lives in the
prompt text itself, exactly like `verification`'s known-bad case.
