"""Validate paired archives and summarize the offline manual decisions."""
from collections import Counter
from hashlib import sha256
from pathlib import Path
from statistics import mean
import gzip
import json

HERE = Path(__file__).resolve().parent
cases = json.loads((HERE.parent.parent / "alfyai-baseline/cases.json").read_bytes())
frozen = {
    (p["id"], i): check
    for p in cases
    for i, check in enumerate(p["checks"])
    if check["category"] not in {"personalization", "cross_project_personal_fact"}
}
responses = {}
for archive in sorted(HERE.glob("p0?-results.json.gz")):
    profile = json.loads(gzip.decompress(archive.read_bytes()))
    assert profile["complete"]
    original = HERE.parent / archive.name
    assert profile["archiveHash"] == sha256(original.read_bytes()).hexdigest()
    assert profile["runnerHash"] == sha256((HERE / "run.ts").read_bytes()).hexdigest()
    for event in profile["checks"]:
        key = profile["id"], event["index"]
        assert key not in responses
        assert frozen[key]["query"] == event["query"]
        assert frozen[key]["day"] == event["day"]
        assert frozen[key]["project"] == event["project"]
        for arm, answer in event["responses"].items():
            assert answer["finish"] == "stop"
            assert event["evidenceSha256"][arm] == sha256(event["evidence"][arm].encode()).hexdigest()
            assert event["modelRowTokens"][arm] <= profile["budget"]
        responses[key] = event
assert responses.keys() == frozen.keys()

grades = json.loads((HERE / "manual-grades.json").read_bytes())
assert {(g["profile"], g["index"]) for g in grades} == frozen.keys()
assert len(grades) == len(frozen) == 60
arm_names = ["observation", "linkedRaw"]
by_category = {}
changes = {"linkedRawOnly": [], "observationOnly": [], "bothFail": [], "bothPass": []}
totals = {}
for arm in arm_names:
    totals[arm] = {
        "passed": sum(g[arm]["pass"] for g in grades),
        "answersWithUnsupportedClaims": sum(bool(g[arm]["unsupportedClaims"]) for g in grades),
        "unsupportedClaims": sum(len(g[arm]["unsupportedClaims"]) for g in grades),
        "meanPromptTokens": round(mean(e["responses"][arm]["usage"]["prompt_tokens"] for e in responses.values()), 1),
        "maxEstimatedEvidenceTokens": max(e["modelRowTokens"][arm] for e in responses.values()),
    }
for grade in grades:
    key = grade["profile"], grade["index"]
    o, r = (grade[arm]["pass"] for arm in arm_names)
    bucket = "bothPass" if o and r else "observationOnly" if o else "linkedRawOnly" if r else "bothFail"
    changes[bucket].append(f"{key[0]}/{key[1]}")
    count = by_category.setdefault(frozen[key]["category"], Counter())
    for arm in arm_names:
        count[arm] += grade[arm]["pass"]

print(json.dumps({
    "pairs": len(responses),
    "answers": sum(len(e["responses"]) for e in responses.values()),
    "verdictTotals": totals,
    "pairedOutcomes": {key: len(ids) for key, ids in changes.items()},
    "changedCases": {key: ids for key, ids in changes.items() if key != "bothPass"},
    "byCategory": by_category,
}, indent=2))
