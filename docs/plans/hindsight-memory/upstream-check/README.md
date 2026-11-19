# Upstream curation check — 2026-11-18

Restore the historical source at its original paths before following the replay commands or source references below. [Archive and restoration instructions](../research-source/README.md)

Current upstream main was checked with git ls-remote and fetched into the isolated research clone. The tested checkout stayed at its original pin; the two newer commits do not modify the curation, replay or Memory Defense implementation under examination. See revision-check.json and engine-diff.patch.

The Python probe calls the real bundled MemoryDefenseRegexExtension.screen implementation directly. This is a deterministic component test, not a full API/storage lifecycle test. No PostgreSQL/API restart or LLM inference was needed. Configuration uses the native sensitive_data/redact policy. It leaves the bicycle claim, paraphrase, shared Hungarian medical condition and UK phone numbers unchanged. It redacts a clearly synthetic GitHub-shaped token while retaining the coffee preference. An unsupported semantic detector name is accepted but does nothing in the OSS extension.

Run with the isolated evaluator venv:

```
HINDSIGHT_API_EMBEDDINGS_PROVIDER=onnx HINDSIGHT_API_RERANKER_PROVIDER=flashrank /tmp/alfyai-hindsight-eval/venv/bin/python docs/plans/hindsight-memory/upstream-check/defense_probe.py
```

Initial harness invocation omitted the extension config constructor argument and failed before screening; corrected to config={} and rerun successfully. The environment provider settings avoid an irrelevant local-ML dependency warning; this probe never uses either provider.

This checks scope, not a failure of the intended secret-scrubbing feature. Replacing its detector with our own semantic correction/removal system would still be custom memory logic that we must maintain, even if hosted inside Hindsight.
