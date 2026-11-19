"""Offline review only. Reads synthetic records and the frozen gold without network access."""
from collections import Counter
from hashlib import sha256
from pathlib import Path
from statistics import mean, median
import argparse
import gzip
import json

HERE = Path(__file__).resolve().parent
FIXTURE = HERE.parent / "alfyai-baseline" / "cases.json"
PROFILES = json.loads(FIXTURE.read_bytes())


def result(root, profile_id):
    plain = root / f"{profile_id}-results.json"
    zipped = root / f"{profile_id}-results.json.gz"
    if plain.exists():
        data = plain.read_bytes()
    elif zipped.exists():
        data = gzip.decompress(zipped.read_bytes())
    else:
        return None
    record = json.loads(data)
    assert record["fixtureHash"] == sha256(FIXTURE.read_bytes()).hexdigest()
    return record


def review_sources(profile, record):
    for event in record["events"]:
        if event["kind"] != "source":
            continue
        original = profile["sessions"][event["index"]]
        print(f'{profile["id"]}/{event["index"]:02d} [{event["project"]}] '
              f'{original["text"]} ({event["job"]["status"]})')
        for fact in event["source"]["facts"]:
            print(f'    {fact["text"]}')


def review_answers(profile, record, evidence):
    for event in record["events"]:
        if event["kind"] != "check":
            continue
        original = profile["checks"][event["index"]]
        print(f'{profile["id"]}/{event["index"]:02d} [{original["category"]}] {event["query"]}')
        print("  Required:", " / ".join(original["want"]))
        print("  Forbidden:", " / ".join(original["forbid"]))
        print("  Answer:", event.get("response", {}).get("text") or event.get("answerError"))
        if evidence:
            print("  Admitted:", event["tool"]["content"])


def summarize(records):
    grades = json.loads((HERE / "manual-grades.json").read_text())
    grade_by_key = {(g["profile"], g["index"]): g for g in grades}
    assert len(grade_by_key) == len(grades) == 72
    assert len(records) == 6 and all(r["complete"] for _, r in records)
    intake = [(p, e) for p, r in records for e in r["events"] if e["kind"] == "source"]
    checks = [(p, e) for p, r in records for e in r["events"] if e["kind"] == "check"]
    assert len(intake) == 102 and len(checks) == 72
    assert set(grade_by_key) == {(p["id"], e["index"]) for p, e in checks}
    by_category = {}
    by_language = {}
    by_profile = {}
    for p, e in checks:
        manual = grade_by_key[p["id"], e["index"]]
        category = p["checks"][e["index"]]["category"]
        for table, key in ((by_category, category), (by_language, p["lang"]), (by_profile, p["id"])):
            counter = table.setdefault(key, Counter())
            counter["checks"] += 1
            counter["pass"] += manual["pass"]
            counter["unsupportedClaims"] += len(manual["unsupportedClaims"])
            counter["retrievalSufficient"] += manual["retrievalSufficient"]
    source_fact_count = sum(len(e["source"]["facts"]) for _, e in intake)
    responses = [e["response"] for _, e in checks if e.get("response")]
    finish = Counter(r["finish"] for r in responses)
    final_scope_counts = Counter()
    for _, record in records:
        for bank in record["events"][-1]["published"]:
            kind = bank["scopeKey"].split(":", 1)[0]
            final_scope_counts[kind] += len(bank["published"])
    return {
        "profiles": len(records),
        "sessions": len(intake),
        "checks": len(checks),
        "answers": len(responses),
        "strictPassed": sum(g["pass"] for g in grades),
        "answersWithUnsupportedClaims": sum(bool(g["unsupportedClaims"]) for g in grades),
        "unsupportedClaims": sum(len(g["unsupportedClaims"]) for g in grades),
        "sufficientRecall": sum(g["retrievalSufficient"] for g in grades),
        "sourceJobs": Counter(e["job"]["status"] for _, e in intake),
        "sourceStates": Counter(e["source"]["state"] for _, e in intake),
        "sourceAttempts": Counter(a["status"] for _, e in intake for a in e["attempts"]),
        "jobErrorCodes": Counter(e["job"]["errorCode"] for _, e in intake if e["job"].get("errorCode")),
        "acknowledgedRawFacts": source_fact_count,
        "zeroFactSessions": sum(not e["source"]["facts"] for _, e in intake),
        "finalPublishedRowsByScope": final_scope_counts,
        "recallCandidates": sum(len(e["tool"]["evidenceCandidates"]) for _, e in checks),
        "scopeOrOwnerViolations": sum(len(e["scopeViolations"]) for _, e in checks),
        "emptyRecall": sum(not e["tool"]["content"] for _, e in checks),
        "memoryActions": sum(r["memoryActionCount"] for _, r in records),
        "interruptions": [i for _, r in records for i in r["interruptions"]],
        "finishReasons": finish,
        "averageAnswerPromptTokens": round(mean(r["usage"]["prompt_tokens"] for r in responses), 1),
        "medianDeliveryMs": median(e["ms"] for _, e in intake),
        "medianRecallMs": median(e["recallMs"] for _, e in checks),
        "medianAnswerMs": median(r["ms"] for r in responses),
        "byCategory": by_category,
        "byLanguage": by_language,
        "byProfile": by_profile,
    }


args = argparse.ArgumentParser()
args.add_argument("view", choices=["answers", "sources", "summary"])
args.add_argument("profiles", nargs="*", default=[p["id"] for p in PROFILES])
args.add_argument("--evidence", action="store_true")
args.add_argument("--root", type=Path, default=HERE)
options = args.parse_args()
records = [(p, result(options.root, p["id"])) for p in PROFILES if p["id"] in options.profiles]
records = [(p, r) for p, r in records if r]
if options.view == "summary":
    print(json.dumps(summarize(records), indent=2, ensure_ascii=False))
else:
    for profile, record in records:
        if options.view == "sources":
            review_sources(profile, record)
        else:
            review_answers(profile, record, options.evidence)
