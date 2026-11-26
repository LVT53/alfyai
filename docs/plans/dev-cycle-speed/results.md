# Mac development gate results

All release runs use the Mac. The release gate runs every unit file and the Playwright inventory outside the existing quarantine. The gate's idle-Mac timing criteria require no swap in use at launch and no process-priority clamp while it runs.

| Run | Browser / unit workers | Gate | Browser | Unit | Browser sign-in across workers | First browser worker idle before finish | Swap start → peak |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Pre-optimization baseline, passed | 6 / 3 | 16m39s | 16m14s | 15m30s | 10m58s | 3m35s | 1,771 → 2,082 MB |
| Browser track, one test failed | 6 / 3 | 15m16s | 14m55s | 13m17s | 3m33s | 3m45s | 1,858 → 1,858 MB |
| Combined branch, one unit guard failed | 6 / 2 | 17m12s | 12m32s | 16m51s | 3m36s | 43s | 1,842 → 1,842 MB |
| Combined branch, passed | 5 / 3 | 14m59s | 14m38s | 11m42s | 3m18s | 42s | 1,826 → 1,826 MB |
| Eight-browser phased, passed | 8 / 6 | 15m30s | 9m42s | 5m26s | 3m47s | 45s | 1,802 → 1,802 MB |
| Reviewed release with `nice -n 10`, passed | 5 / 3 | 15m15s | 14m53s | 12m30s | 3m32s | 44s | 1,794 → 1,794 MB |

The baseline had 29,468 passing and four skipped unit tests, and 1,731 passing and 77 skipped browser tests. The browser track matched all 29,472 unit outcomes. Its 1,814 browser cases included six new sign-in tests and the sidebar sign-out test moved to its own suite. The browser track passed 1,736, skipped 77, and failed one when the test's intercepted download poll encountered a connection reset. These runs supplied coverage and timing diagnostics under the reported Mac conditions. The initial swap excludes these runs from the ten-minute acceptance runs.

## What the changes bought

- Dedicated browser test sessions reduced cumulative sign-in time by 7m25s in the browser-track comparison. Authentication-focused tests still exercise the app's real sign-in. The smoke suite includes a sign-in through the form.
- The standalone Node-default unit track preserved every original unit outcome and added six environment guard checks. Total environment setup across its workers was 111s, down from 585s in the frozen baseline. Worker contention and starting swap differed, so these totals describe the two runs and do not isolate the effect on gate wall time.
- The motion spec split preserved all pre-split browser titles. Its three files can run independently. The combined release cut the gap from the first idle worker to the last finish to 43s. No tail file exceeded three minutes.
- Agent gates follow the Vitest import graph and include marked repository scans. Configuration changes select the full suite. The agent gate stops remaining checks when a required static check fails.
- The Mac queue was exercised across browser and integration worktrees. It named the gate holding the queue and handed off when that gate finished.

## Combined release

Chromium passed 1,754 cases and skipped 77, with no failures or flaky results. The extra inventory comes from 18 new cases on main and one replaced test for the old disabled Connections entry. Across workers, sign-in was 216 out of 4,228 seconds (5.1%). A narrow pilot could open an already seeded chat directly after sign-in. Even eliminating all current sign-in work would represent 36 seconds of browser wall time at six fully occupied workers. The worker allocation is the first comparison because Vitest ran for 16m51s with two workers.

Vitest passed 30,496 tests, skipped 10, and failed the selection guard. The guard identified ten new tests that read repository files outside the import graph and need dependency declarations. The only baseline unit file absent by path moved on main from `workspace-search.test.ts` to `workspace-search/index.test.ts`. Other file-level inventory differences came from main, plus the new environment guard. The focused rerun for the intercepted download test passed all 50 cases, including smoke.

## Checks after review

The focused rerun passed 5,596 unit tests with one skip, plus Biome and Fallow. It covered the repository-file declarations, queue metadata, release command arguments and raw-glob classification. Separate fixtures confirmed that both test runners exit with an error for a focused test in release mode. A Mac lock probe confirmed that the recorded hold time begins when the lock is acquired. The faster environment scan examined all 1,562 unit files with no violations. The targeted browser run passed the download spec and the smoke tier.

The five-browser, three-Vitest run passed every gate. Its 1,831 browser cases and their outcomes matched the six-browser run exactly. Vitest passed 30,499 cases and skipped 10. The difference in unit outcomes was the corrected selection guard and the two new review checks. The faster observed release was 2m13s shorter than the six-browser, two-Vitest run. The browser lane became the longer lane at 14m38s.

Browser sign-in fell to 198 of 4,171 cumulative worker seconds (4.76%) in the passing run. Keep the existing sign-in helper interface based on that run. The target still needs a passing ten-minute result under the qualifying machine conditions.

## Agent schedule comparison

Both schedules ran the same selected unit inventory and 37 smoke cases for each change. The samples made a temporary comment in a server file, the composer, or the tool-row dictionary. All six gates passed.

| Sample | Unit files | Active unit tests | Phased | Overlap |
| --- | ---: | ---: | ---: | ---: |
| Server authentication | 225 | 6,091 | 2m16s | 3m34s |
| Composer | 188 | 5,891 | 2m15s | 3m29s |
| Tool-row translations | 395 | 10,759 | 3m19s | 5m59s |
| Mean | | | 2m37s | 4m21s |

Phased stays the agent default. The translation sample took longer because the shared dictionary reaches more of the suite. The selective review gate spent about 14 seconds on tool launch and related-file selection before Vitest started its execution timer.

The gate detected a translation use with neither locale, then a separate English-only translation with a missing Hungarian entry. It also detected a tool error code without UI words. Changing `vitest.config.ts` selected the full 1,562-file suite and passed 30,500 active tests, with 10 skips.

## Release acceptance

On November 26, 2026, the owner accepted about fifteen minutes for the full Mac release. Three passing runs within ten minutes under the measured-run criteria remain a stretch goal. All runs in the comparison began with swap in use. The fastest passing full run took 14m59s. The one-week and two-week observations depend on merge and elapsed time.

## Final Mac verification

The eight-browser phased run finished Playwright in 9m42s, with Vitest and build bringing the total to 15m30s. Five browser workers and three Vitest workers in overlap remain the release default. The independent review fixes passed the agent gate and a full release. The live selector probe ran 63 tests and then correctly failed the gate because a second named spec was stale. A detached-process probe held the queue while its marked browser was alive and released the lock while an unrelated process was still running. A second worktree also waited behind the real phased release, showed its holder, and acquired the lock after the run.

The reviewed release with `nice -n 10` took 15m15s, 16 seconds slower than the normal-priority five-browser run. It passed 30,503 active unit cases and 1,754 active browser cases. All 1,831 browser outcomes matched the normal-priority run. The only unit inventory differences were in the four changed gate and test-infrastructure suites. Swap stayed flat and the lowest reported free memory was 0.1 GB in both runs. Keep the normal priority default pending a qualifying comparison that demonstrates a benefit on the Mac.
