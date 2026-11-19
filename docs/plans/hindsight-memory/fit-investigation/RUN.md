# Evaluation artifact notes

Restore the historical source at its original paths before following the replay commands or source references below. [Archive and restoration instructions](../research-source/README.md)

These are scratch runners and synthetic results, not AlfyAI application code. No automatic execution is intended.

Pinned engine and setup are described in the parent report and start.py. The local provider bridge requires the same authorized remote configuration access as earlier evaluations; credentials remain remote. Dummy tenant keys in these artifacts are synthetic. Do not run against a production Hindsight bank.

Run native.cjs before reprocess.cjs; other named runners have independent banks, but each runner expects new banks for an uncontaminated rerun. Use a fresh database or change the fit-* bank namespace. helper.cjs waits for background operations and logs complete API responses. Native deletion uses native_delete.py, an evaluation-only wrapper around the engine method.

reflect-bench.cjs preserves its original scratch-input path for the ten old cases. All cases are also in reflect-frozen.json; replace that old input path with a fixture containing cases where heldOut=false before rerunning elsewhere. Fresh cases are in fresh-attribution.json. The saved output is the actual run, not a rerun after that portability adjustment.

Compressed traces include synthetic prompts, native tool calls and responses. Inspect stored items and recalled source text as well as final answers. SHA256SUMS covers saved artifacts except itself. Current scores are manual fixture expectations, not a statistical production claim. No case-specific prompt tuning or costly model fallback was used to rescue the Reflect benchmark.
