# History consent at migration and withdrawal boundaries

The fixes are in local commit `a530fefd9812db952d8a901b6a3f6ae213e662df`. The eight regression cases use synthetic SQLite databases, the existing Memory job engine, and a deterministic native HTTP fixture. They verify what the application sends to native Memory and which rows it admits to reads.

## Equal timestamps

Message and control-interval timestamps both persist at second resolution. Before the fix, preparation and first-time enabling could treat a legacy message written earlier in the same second as known enabled. The fixture sent its text in a retain request and in a later message’s prior Memory context. An enabled interval now establishes consent only when its start timestamp precedes the stored message timestamp. An explicit Include still admits optional history through its cutoff. A disabled interval continues to exclude an assertion at its persisted end boundary. A same-second live turn with trusted server admission still reaches the native retain endpoint.

## Decline and the Memory switch

Decline now saves the choice, revokes affected optional imported sources, and queues their existing cleanup jobs in one SQLite transaction. A forced failure in follow-up preparation leaves the imported text already absent from list, detail, prior-generation reads, and recall. Cleanup succeeds before a preparation retry. A failed cleanup-job insert rolls back both the choice and the source revocation. Repeating an earlier Decline reconciles accepted optional sources left behind by an interrupted older request.

Preparation while Memory is Off preserves learned sources whose text, timestamp, scope, and durable permission still match. The tests exercise direct preparation while Off, a successful Decline while Off, and switching Off after the choice commits and before its follow-up preparation. Known-on history, independent live turns, and authored legacy statements preserve their accepted source identifiers after Memory is turned back on and preparation runs again. The captured retain count stays the same through those steps.

## Verification

- Eight of eight focused regressions passed in `migration.integration.test.ts`. The equal-second assertions use a frozen application clock and verify the stored timestamps before draining jobs.
- The final focused Memory run passed 281 tests across nine suites. Biome checked all four changed source and test files, and `git diff --check` passed. The independent reviewer closed the history findings on this checkpoint.
- The local diagnostic logs are `/tmp/alfyai-history-privacy-red.log`, `/tmp/alfyai-history-off-reprepare-red.log`, `/tmp/alfyai-history-off-reprepare-green.log`, and `/tmp/alfyai-history-privacy-final-broad.log`. The committed regression tests carry the durable evidence. The native HTTP fixture provides deterministic protocol coverage. A release gate and real native smoke are tracked separately in the [integration readiness report](integration-readiness.md).
