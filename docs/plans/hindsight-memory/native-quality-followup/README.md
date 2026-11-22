# Native quality follow-up artifacts

Restore the historical source at its original paths before following the replay commands or source references below. [Archive and restoration instructions](../research-source/README.md)

2026-11-18. Synthetic evaluation only, local Flash Next, pinned Hindsight 1.2.1. See [report](../native-quality-followup.md).

Runs: `native-results.json` (10 default concise/thinking-off); `configured-results.json` (14 native custom/thinking-off); `native-reasoning-results.json` (5 exact prompt replays); `integrated-reasoning-results.json` (14 native concise/thinking-on end-to-end); `curation-results.json` (7 source-policy scenarios, 3 states each); `native-curator-results.json` (9 initial narrow-curator cases); `curator-v2-results.json` (9 schema-repaired reasoning cases); `curator-fast-results.json` (same 9 without reasoning); `roundtrip-results.json` (2 actual native curation/Recall checks).

Frozen cases/settings/prompts and runners are included. Model/API transcripts are compressed. No success count should be inferred from structural validity. Error cases retain partial diagnostic output, which must never be published. Native candidate banks used for the narrow curator disabled observations during extraction; the two roundtrips enabled them for PATCH/consolidation. The main native quality banks used observations throughout.

Reproduction requires the isolated evaluator/venv/temporary PostgreSQL and approved remote configuration bridge; credentials remain remote. Scripts reference historical scratch paths and banks. Do not rerun against production or existing evidence banks. `start.py` inherits retain thinking/token-limit environment variables; integrated runs used HINDSIGHT_API_RETAIN_LLM_EXTRA_BODY='{"chat_template_kwargs":{"enable_thinking":true}}' and HINDSIGHT_API_RETAIN_MAX_COMPLETION_TOKENS=8192. Earlier runs omitted them. Proxy logs verify actual request settings.

These are throwaway sources, not production code. Hashes exclude the manifest itself.
