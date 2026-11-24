"""Duplicate bicycle rows in a current-list run, as the runner shows them and as publication would.

The runner (`regression-2026-11-24.ts`) shows every eligible native observation; it never runs
the app's publication. `publishNativeSnapshot` now writes one row for exact twins: the same
wording over the same supporting facts (`withoutTwinObservations`). This reads a results file and,
for each stage of a case, counts the rows the runner showed and the rows publication would write,
and names each duplicate shape left: exact twins (collapsed), the same wording over other facts,
or other wording over the same facts (both kept). Read-only; synthetic data only.

    python3 docs/plans/hindsight-memory/current-list-followup/twins-2026-11-24.py <results.json> [case]
"""
import json
import sys
from collections import defaultdict


def shapes(observations):
    by_text = defaultdict(list)
    by_support = defaultdict(list)
    for row in observations:
        support = tuple(sorted(row.get("source_memory_ids") or []))
        by_text[row["text"]].append(support)
        by_support[support].append(row["text"])
    twins = sum(len(v) - len(set(v)) for v in by_text.values())
    same_text = sum(1 for v in by_text.values() if len(set(v)) > 1)
    same_support = sum(1 for v in by_support.values() if len(set(v)) > 1)
    published = len({(row["text"], tuple(sorted(row.get("source_memory_ids") or []))) for row in observations})
    return twins, same_text, same_support, published


def main():
    path = sys.argv[1]
    wanted = sys.argv[2] if len(sys.argv) > 2 else "hu"
    results = json.load(open(path))
    for case in results["cases"]:
        if case["id"] != wanted:
            continue
        print(f"{path}: case {case['id']}")
        print("stage      shown  published  exact-twins  same-text-other-facts  other-text-same-facts")
        for stage in case["stages"]:
            eligible = set(stage.get("eligibleIds") or [])
            shown = [row for row in stage.get("observations") or [] if row["id"] in eligible]
            twins, same_text, same_support, published = shapes(shown)
            print(f"{stage['stage']:<10} {len(shown):>5}  {published:>9}  {twins:>11}  {same_text:>21}  {same_support:>21}")


if __name__ == "__main__":
    main()
