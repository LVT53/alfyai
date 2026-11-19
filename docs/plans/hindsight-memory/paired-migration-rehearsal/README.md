# Synthetic per-user migration rehearsal

Both Memory implementations passed **6 of 8** independently graded questions. Hindsight gained the current kayak nickname, lost the former nickname on the Memory-only probe, and shared one wrong-object answer with legacy Memory. This small fixture measures individual tradeoffs. It does not establish overall improvement, production readiness, or an owner pilot result. [Frozen questions and authored sources](fixture.json) · [Frozen gold](gold.json) · [Execution receipt](receipt.json)

| Case | Legacy | Hindsight | Evidence |
| --- | --- | --- | --- |
| Current nickname | Fail | Pass | The real legacy Judge kept the older value. Native supplied the newer authored nickname. |
| Former nickname | Pass | Fail | Legacy still supplied the old name, and the question framed it as former. Native current Memory supplied only the new name. |
| Unknown registration | Pass | Pass | Both explicitly abstained. |
| Eszter’s studio | Pass | Pass | Both attributed the studio to Eszter. |
| Distinct boat name | Fail | Fail | Both borrowed a touring-kayak nickname. Neither retrieved nor said the actual incognito name. |
| Cedar-only label in Cedar | Pass | Pass | Both answered with the authorized label. |
| Label in Birch | Pass | Pass | Both abstained. |
| Personal label | Pass | Pass | Both abstained. |

The immutable staged release at 447cde74b ran against the isolated GPU Hindsight endpoint and the private qwen3-6-27b model alias. A fresh SQLite database contained one synthetic account and was never served through browser or production routes. Four real legacy Judge calls completed, admitting three facts, and the incognito turn was skipped by the legacy gate. The existing per-user migration inspection marked four authored sources eligible and one excluded after synthetic opt-in. The existing prepare, job drain, verify and cutover services migrated that same isolated account. Four native source jobs succeeded. The harness seeded authored chats and let each implementation process them.

Both arms used the actual application persona reader and the same local answer provider, model, instruction, scope and sampling settings. The harness used a fixed answer prompt and bypassed Normal Chat completion and model-selected tools. The chats, person, scopes and gold were synthetic. The probe about a former nickname asked the Memory reader. Explicit retained-chat search has separate staging evidence.

Each retrieval used the dedicated SQLite connection in a transaction rolled back before answer generation, including legacy reader housekeeping and prompt-use telemetry. All application table contents had equal durable hashes around each arm, and the dedicated probe contexts held zero messages. Native active facts and observations and the pending-operation inventory were unchanged around native probes. The scope of this verification is application data and the available native inventory. The inference or native service may retain operational telemetry.

Execution order was legacy followed by Hindsight. Answer order was randomized independently within each pair for the grader, who saw the fixed gold and opaque answers before the arm key was retrieved. The eight pairs yielded five passes in both arms, one failure in both arms, one gain and one loss, with zero inconclusive cases. Retrieval medians were 2 ms legacy and 51.5 ms native. Answer medians were 178.5 ms legacy and 111.5 ms native. Fixed execution order and a small sample prevent a speed conclusion. [Blinded answers](blind-answers.json) · [Independent judgments](blind-grades.json) · [Unblinding key](arm-key.json)

## Reproduce

Use the staged release’s Node 22 runtime and protected staging EnvironmentFiles through the authorized ephemeral unit. Bind the approved private Model 1 URL and qwen3-6-27b alias, enable the real legacy Judge on that alias, and bind the isolated Hindsight worker at http://127.0.0.1:18894. The runner creates and marks its own system-temp database. It has no database-path argument. Run from the release root with the [runner](run.ts) and [fixture](fixture.json) in the documented relative paths.

```sh
node --import tsx docs/plans/hindsight-memory/paired-migration-rehearsal/run.ts
```

Keep proof collection in the isolated synthetic directory. Query and retrieval evidence from the run is in private benchmark files on the staging host. This directory holds the synthetic answers and redacted receipt. The runner adds exact endpoint and alias assertions for future runs. The completed run used those values. [Owner-only pilot preparation](pilot-preparation.md)
