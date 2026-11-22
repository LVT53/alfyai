# Final feasibility artifacts

Restore the historical source at its original paths before following the replay commands or source references below. [Archive and restoration instructions](../research-source/README.md)

2026-11-18. Synthetic local Flash Next tests, not product implementation or an integrated UI pass. See [decision](../design-readiness.md), [quality results](../typed-frame-results.md), and [independent review](../typed-frame-review.md).

`frames-results.json`: revised fast 20 cases; `fresh-frames-results.json`: 10 fresh cases; `reason-frames-results.json`: reasoning extraction on 14 repeated cases; `strict-frames-results.json`: strict JSON schema on four repeated cases. Original initial results are retained, not pooled into a success score. `accepted` means structural acceptance, not semantic success. Frozen files preserve cases/prompts; `frames-fast.cjs` is the revised fast source, `frames.cjs` adds optional reasoning, `frames-strict.cjs` changes only structured-output enforcement. No candidate is production-ready.

`schema-check.json` captures a deliberately schema-conflicting request, distinct from the compliant basic probe. Synthetic model transcripts are gzip-compressed. Scripts use the historical scratch path and require an intentionally configured local proxy, isolated evaluator and approved model access; they are evidence/reproduction sources, not a one-command installation. Do not start them against real users or print remote credentials. The remote bridge keeps credentials remote.

P2 native API artifacts and reproduction notes are separate in `../bounded-update-prototype/`. No full application gates were run: product files are unchanged. Hashes cover archived artifacts; the manifest excludes itself.
