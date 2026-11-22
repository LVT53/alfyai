# Integrated native Memory smoke

19 November 2026. Both runs used a private archive of product commit `a530fefd9812db952d8a901b6a3f6ae213e662df`, Node 22.23.4, and Vitest 4.1.12. The independently installed package lock had SHA-256 `d74c2220a208a58a49329bae38b9aadf098ddee63bb712ca3544cdf44aeb6068`. The opt-in run followed the existing native smoke test against the pinned Hindsight service at loopback port 18890 and the authorized local Flash Next alias. It used a fresh migrated SQLite fixture, synthetic account and synthetic bank each time. [Smoke test](../../../../../src/lib/server/services/memory-profile/native-live.integration.test.ts) · [Native setup](../../native-operations-fixes.md).

```sh
HINDSIGHT_NATIVE_ACCEPTANCE=1 npm test -- src/lib/server/services/memory-profile/native-live.integration.test.ts
```

| Run | Job results | Native observations | Published rows | App-admitted rows |
| --- | --- | ---: | ---: | ---: |
| Initial, bridge lost upstream SSH during extraction | Both failed with `memory_preparation_failed` | 3 arrived before final readback | 0 | 0 |
| Fresh bank after local bridge recovery | Both succeeded on their first attempts | 3 | 3 | 3 |

The initial assertion failed after 258.29 seconds. Hindsight logged HTTP 503 during extraction. It later returned observations from both synthetic languages, while the app kept publication and admitted recall empty for the failed jobs. The fixture cleanup ran. [Disconnected result](disconnected-results.json)

A dedicated SSH probe reached the existing upstream again. The recovery replaced only the local synthetic bridge process and verified HTTP 200 on its configuration endpoint. The pinned native service, model and shared SSH state stayed in place. The rerun passed in 9.76 seconds. Both the English kayak assertion and Hungarian cat assertion appeared in native recall, published Memory and the application-admitted response. The fixture cleanup completed. [Recovered result](recovered-results.json) · [Checksums](SHA256SUMS).
