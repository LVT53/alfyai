# Archived Hindsight research source

[Source archive](source.tar.gz) contains 185 historical JavaScript, TypeScript and Python files at their original paths relative to `docs/plans/hindsight-memory/`. The source bytes and permissions were verified against the originals after extraction. One additional member, `prior-findings/stress-results.json`, is the original synthetic replay input copied from the earlier benchmark evidence. The reports, fixtures, logs and results that were already in this tree remain alongside their original evidence folders.

The current [native lifecycle acceptance suite](../native-lifecycle-acceptance/README.md), [native operations probes](../native-operations-fixes.md), [integrated benchmarks](../integrated-native-benchmark/README.md) and active review reproducers are available in the working tree. The paired benchmark still imports [the baseline answer helper](../alfyai-baseline/answer.cjs). Fallow analyzes the runnable source and its imported modules.

## Restore and verify

From the repository root, copy the evidence into a disposable directory so that a replay can write its outputs alongside the restored source.

```sh
evidence="$PWD/docs/plans/hindsight-memory"
archive="$evidence/research-source"
replay="$(mktemp -d)"
restored="$replay/docs/plans/hindsight-memory"
mkdir -p "$restored"
cp -R "$evidence/." "$restored/"
(cd "$archive" && shasum -a 256 -c ARCHIVE-SHA256SUM) &&
  tar -xzf "$archive/source.tar.gz" -C "$restored" &&
  (cd "$restored" && shasum -a 256 -c "$archive/SHA256SUMS")
```

The [member manifest](SHA256SUMS) lists every original path and expected SHA-256. You can also list the paths with `tar -tzf "$archive/source.tar.gz"`. The [archive checksum](ARCHIVE-SHA256SUM) verifies the compressed file. The group-level checksums in the original evidence describe those groups at the time of the experiments.

The [bounded-update offline replay](../bounded-update-prototype/README.md) runs with `(cd "$restored/bounded-update-prototype" && node read-gate.cjs)`. For runners that import the app, restore the evidence under the same relative paths in a disposable checkout of the AlfyAI revision recorded in the corresponding report. The legacy baseline runner, for example, uses the existing app dependencies and Node 22. Native experiments also require the pinned scratch evaluator and provider setup recorded in their reports, using fresh synthetic databases and banks. [Legacy baseline reproduction](../alfyai-baseline/README.md)

## Original scratch paths

The executable sources retain their original absolute paths. Five correction lifecycle imports of `/tmp/alfyai-hindsight-native-quality/common.cjs` use the archived `native-quality-followup/common.cjs`. Its SHA-256 is `004dd8dc2563b22b92e26f5549f8bbe9dcf010c32348f3b731c13d69f285a4c2`. The scratch inputs below matched their preserved copies byte for byte. [Correction lifecycle protocol](../correction-lifecycle/PROTOCOL.md)

| Location expected by the saved source | Path relative to the restored evidence directory |
| --- | --- |
| `/tmp/alfyai-hindsight-native-quality/common.cjs` | `native-quality-followup/common.cjs` |
| `/tmp/alfyai-hindsight-native-quality/integrated-reasoning-results.json` | `native-quality-followup/integrated-reasoning-results.json` |
| `/tmp/alfyai-hindsight-native-quality/native-curator-results.json` | `native-quality-followup/native-curator-results.json` |
| `/tmp/alfyai-hindsight-readiness/cases.json` | `final-feasibility/cases.json` |
| `/tmp/alfyai-hindsight-readiness/fresh-frames-frozen.json` | `final-feasibility/fresh-frames-frozen.json` |
| `/tmp/alfyai-hindsight-fit/merge-cases.json` | `fit-investigation/merge-cases.json` |
| `/tmp/alfyai-hindsight-bench-v2/stress-results.json` | `prior-findings/stress-results.json` |

For an exact replay, copy the required input to its original path in a fresh scratch environment and keep the established fixture files alongside the restored scripts. If the scratch path is occupied, compare its bytes before using it. To relocate a path, make the edit in a disposable replay copy after verifying its starting checksum and record the adjustment with the new run.
