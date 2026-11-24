"""Side-by-side sheet for grading the 2026-11-24 regression run against the recorded one.

Prints, per frozen check: the rubric, the recorded answer and its manual grade, today's
answer and today's admitted Memory content. Offline; no model is called.
Usage: python3 compare-2026-11-24.py <today's results dir> [profile ...] [--evidence]
"""
import gzip
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
CASES = {p["id"]: p for p in json.loads((HERE.parent / "alfyai-baseline" / "cases.json").read_text())}
GRADES = {(g["profile"], g["index"]): g for g in json.loads((HERE / "manual-grades.json").read_text())}
today_dir = Path(sys.argv[1])
evidence = "--evidence" in sys.argv
profiles = [a for a in sys.argv[2:] if a.startswith("p0")] or sorted(CASES)


def checks(record):
    return {e["index"]: e for e in record["events"] if e["kind"] == "check"}


for pid in profiles:
    old = checks(json.loads(gzip.decompress((HERE / f"{pid}-results.json.gz").read_bytes())))
    path = today_dir / f"{pid}-results.json"
    new = checks(json.loads(path.read_text())) if path.exists() else {}
    for index, case in enumerate(CASES[pid]["checks"]):
        grade = GRADES[(pid, index)]
        then = old.get(index, {})
        now = new.get(index)
        print(f"=== {pid}/{index:02d} [{case['category']}] {case['day']} project={case['project']}")
        print(f"  Q: {case['query']}")
        print(f"  want: {' / '.join(case['want'])} | forbid: {' / '.join(case['forbid'])}")
        print(f"  THEN ({'PASS' if grade['pass'] else 'FAIL'}; unsupported {grade['unsupportedClaims']}): {(then.get('response') or {}).get('text')}")
        print(f"    reason: {grade['reason']}")
        if now is None:
            print("  NOW: (not run yet)")
            continue
        print(f"  NOW: {(now.get('response') or {}).get('text') or now.get('answerError')}")
        if evidence:
            print("  NOW admitted:")
            for line in (now["tool"].get("content") or "").splitlines():
                print("    " + line)
