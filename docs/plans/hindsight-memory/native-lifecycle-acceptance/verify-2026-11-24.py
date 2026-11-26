"""The archived checks of verify-records.py, applied to the 2026-11-24 regression records.

Each check is reported (pass, fail, or info), not asserted, so one difference does not
hide the rest. Where the recorded run failed a step that a later retest passed
(followup.md), today's expectation is the retest's. No model is called.
Usage: python3 verify-2026-11-24.py <directory with today's *.json records> [out.json]
"""
import json
import re
import sys
from pathlib import Path

HERE = Path(sys.argv[1])
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else None
results = []


def check(case, name, ok, detail=""):
    results.append({"case": case, "check": name, "result": "pass" if ok else "fail", "detail": detail})


def info(case, name, detail):
    results.append({"case": case, "check": name, "result": "info", "detail": detail})


def load(case):
    path = HERE / f"{case}.json"
    if not path.exists():
        return None, {}
    record = json.loads(path.read_text())
    steps = {}
    for step in record["steps"]:
        steps.setdefault(step["name"], step)  # first occurrence, as the archive's dict kept the last
        steps[step["name"]] = step
    return record, steps


def layers(step):
    return {
        "raw": [row["text"] for bank in step["banks"] for row in bank["raw"]],
        "native_observations": [row["text"] for bank in step["banks"] for row in bank["observations"]],
        "published": [row["text"] for bank in step["banks"] for row in bank["published"]],
        "page": [row["text"] for bank in step["banks"] for row in (bank["lookup"]["body"].get("rows") or [])],
        "recall": ((step.get("applicationRecall") or {}).get("content") or "").splitlines(),
    }


def mentions(texts, term):
    return any(re.search(term, text, re.I) for text in texts)


def absent_layers(step, term):
    return [layer for layer, texts in layers(step).items() if mentions(texts, term)]


def missing_layers(step, term):
    return [layer for layer, texts in layers(step).items() if not mentions(texts, term)]


def operation(step):
    op = step.get("operation") or {}
    return op.get("body", op) if op.get("status") == 200 or "body" in op else op


def day_of(step, term):
    days = []
    for bank in step["banks"]:
        for row in bank["lookup"]["body"].get("rows") or []:
            if re.search(term, row["text"], re.I):
                days.append(row["updatedAt"][:10])
    return days


def linked_recall(case, record):
    bad = []
    for s in record["steps"]:
        recall = s.get("applicationRecall")
        if not recall:
            continue
        published = {
            (row["nativeId"], row["generation"])
            for bank in s["banks"] if bank["scope"]["kind"] == "personal"
            for row in bank["published"]
        }
        for evidence in recall.get("evidenceCandidates") or []:
            ref = evidence["id"].removeprefix("memory-fact:")
            if (ref, evidence["metadata"]["generation"]) not in published:
                bad.append((s["name"], ref))
    check(case, "every recalled row is a current published row", not bad, str(bad[:3]))


def main_case(case, prop, old, new, others, newer_term, newer_forbidden, stamp):
    record, steps = load(case)
    if not record:
        info(case, "record", "not run")
        return
    check(case, "record finished after-restart without failures", record.get("final") == "after-restart" and not record["failures"], str(record["failures"])[:300])
    linked_recall(case, record)
    for name in ("add", "edit", "partial-remove", "whole-remove"):
        if name in steps:
            body = operation(steps[name])
            check(case, f"{name} applied", body.get("status") == "applied", f"status={body.get('status')} error={body.get('errorCode')}")
    exact_source = next((item["text"] for item in steps["original"]["sources"] if item["eventId"].startswith("message:")), None)
    quotes = [d["body"]["sources"][0]["quote"] for d in steps["original"]["banks"][0]["details"] if d["body"].get("origin") == "conversation" and d["body"].get("sources")]
    check(case, "conversation cards quote the exact original message", bool(quotes) and all(q == exact_source for q in quotes), f"{len(quotes)} quotes")
    check(case, f"original shows '{old}' in every layer", not missing_layers(steps["original"], old), str(missing_layers(steps["original"], old)))
    check(case, f"edit shows '{new}' in every layer", not missing_layers(steps["edit"], new), str(missing_layers(steps["edit"], new)))
    check(case, f"edit leaves no '{old}'", not absent_layers(steps["edit"], old), str(absent_layers(steps["edit"], old)))
    corrected = next((d["body"] for d in steps["edit"]["banks"][0]["details"] if mentions([d["body"]["row"]["text"]], new)), None)
    if corrected:
        info(case, "history after Edit (recorded as a gap)", f"origin={corrected.get('origin')} versions={len(corrected.get('versions') or [])} sources={len(corrected.get('sources') or [])}")
    for name in ("edit", "partial-remove", "unchanged-resend", "forced-native-reextraction"):
        lost = [o for o in others if missing_layers(steps[name], o)]
        check(case, f"{name} keeps the unrelated facts", not lost, str({o: missing_layers(steps[name], o) for o in lost}))
        check(case, f"{name} leaves no '{old}'", not absent_layers(steps[name], old), str(absent_layers(steps[name], old)))
    part = steps["partial-remove"]
    check(case, f"partial removal leaves no '{new}'", not absent_layers(part, new), str(absent_layers(part, new)))
    check(case, f"partial removal keeps '{prop}' ownership", not missing_layers(part, prop), str(missing_layers(part, prop)))
    for name in ("unchanged-resend", "forced-native-reextraction"):
        wrong = {o: day_of(steps[name], o) for o, d in zip(others, (3, 3, 2)) if set(day_of(steps[name], o)) != {f"2026-08-0{d}"}}
        check(case, f"{name} keeps the unrelated facts' dates", not wrong, str(wrong))
        check(case, f"{name} leaves no '{new}'", not absent_layers(steps[name], new), str(absent_layers(steps[name], new)))
    pre, post = steps["forced-native-reextraction"], steps["native-api-and-app-restart"]
    check(case, "restart ran in a new process", pre["process"] != post["process"])
    for key in ("raw", "observations", "published", "details"):
        check(case, f"restart keeps {key} identical", pre["banks"][0][key] == post["banks"][0][key])
    # Today's recall lines end in "(kind, said N days ago)": the age moves with the synthetic
    # clock (the restart step is four days later), so entries are compared without it.
    strip = lambda lines: {re.sub(r" \((?:[a-z]+, )?said [^)]*\)$", "", line) for line in lines}
    check(case, "restart keeps admitted recall (entries, without their age)", strip(layers(pre)["recall"]) == strip(layers(post)["recall"]))
    info(case, "restart: recall lines differ only in age", str(set(layers(pre)["recall"]) != set(layers(post)["recall"])))
    ack = steps["whole-remove-acknowledged-before-drain"]
    check(case, "Remove acknowledged: old detail 409", operation(ack).get("exclusionAcknowledged") and ack["priorDetail"]["status"] == 409)
    hidden = [k for k in ("published", "page", "recall") if mentions(layers(ack)[k], prop)]
    check(case, "Remove acknowledged: hidden from publication, page and recall at once", not hidden, str(hidden))
    for name in ("whole-remove", "post-remove-unchanged-resend"):
        check(case, f"{name} leaves no '{prop}'", not absent_layers(steps[name], prop), str(absent_layers(steps[name], prop)))
    after = steps["newer-assertion"]
    check(case, f"newer assertion admitted ('{newer_term}')", not missing_layers(after, newer_term), str(missing_layers(after, newer_term)))
    check(case, "newer assertion brings back no removed material", not absent_layers(after, newer_forbidden), str(absent_layers(after, newer_forbidden)))
    wrong = {t: day_of(after, t) for t, d in zip([*others, stamp, newer_term], (3, 3, 2, 11, 19)) if set(day_of(after, t)) != {f"2026-08-{d:02}"}}
    check(case, "newer assertion: every fact keeps its own date", not wrong, str(wrong))


main_case("en", "metronome", "bronze", "walnut", ["Rhea", "Saturday", "warm desk lamp"], "maple", "bronze|walnut", "railway stamps")
main_case("hu", "távcs", "réz", "alumínium", ["Ákos", "csütörtök", "asztali lámp"], "titán", "réz|alumínium", "vasúti bélyeg")

record, cancel = load("cancel")
if record:
    try:
        linked_recall("cancel", record)
        check("cancel", "baseline has the seed library", not missing_layers(cancel["dependent-baseline"], "seed library"))
        patched = any(ev["method"] == "PATCH" and "/memories/" in ev["path"] and ev["response"] == 200 for ev in record.get("relay") or [])
        info("cancel", "the edit reached a native PATCH (dirty cancellation exercised)", str(patched))
        for name in ("after-dirty-cancellation", "source-deleted-while-off", "reenabled-dependent-repair", "unrelated-publication-after-cancellation", "unrelated-add-after-cancellation"):
            if name in cancel:
                body = operation(cancel[name]) if cancel[name].get("operation") else {}
                leaked = [k for k in ("published", "page", "recall") if mentions(layers(cancel[name])[k], "Monday|Friday")]
                check("cancel", f"{name}: no Monday or Friday schedule shown", not leaked, str(leaked))
                info("cancel", f"{name} operation", f"status={body.get('status')} error={body.get('errorCode')} retryable={body.get('retryable')} cleanup={body.get('cleanupPending')}")
        for name in ("reenabled-dependent-repair", "unrelated-publication-after-cancellation", "unrelated-add-after-cancellation"):
            if name in cancel:
                info("cancel", f"{name}: seed library in recall", str(mentions(layers(cancel[name])["recall"], "seed library")))
                info("cancel", f"{name}: paper maps in recall", str(mentions(layers(cancel[name])["recall"], "paper maps")))
        if "unrelated-add-after-cancellation" in cancel:
            add = cancel["unrelated-add-after-cancellation"]
            info("cancel", "unrelated Add after cancellation", f"submission={add['submission']['status']} operation={(add.get('operation') or {}).get('body', {}).get('status')}")
        if "after-dirty-cancellation" in cancel and not patched:
            before, refused = cancel["dependent-baseline"], cancel["after-dirty-cancellation"]
            same = all(set(layers(before)[k]) == set(layers(refused)[k]) for k in ("published", "page", "recall"))
            check("cancel", "a refusal before any native PATCH keeps the accepted evidence", same)
    except KeyError as missing:
        info("cancel", "record", f"unfinished: no step {missing}")


record, privacy = load("privacy")
if record:
    try:
        linked_recall("privacy", record)
        scope = privacy["scope-isolation"]
        for field, required, forbidden in (
            ("applicationRecall", "Indigo Lane", "Peregrine-Birch|Tern-Alder|Bronze-Rook"),
            ("projectA", "Peregrine-Birch", "Tern-Alder|Bronze-Rook"),
            ("projectB", "Tern-Alder", "Peregrine-Birch|Bronze-Rook"),
            ("otherUser", "Bronze-Rook", "Indigo Lane|Peregrine-Birch|Tern-Alder"),
        ):
            lines = (scope[field].get("content") or "").splitlines()
            check("privacy", f"scope {field}: own fact, nothing foreign", mentions(lines, required) and not mentions(lines, forbidden))
        check("privacy", "foreign project list and detail 404", scope["deniedProject"]["status"] == 404 and (scope["foreignDetail"] or {}).get("status") == 404, f"{scope['deniedProject']['status']} {(scope['foreignDetail'] or {}).get('status')}")
        off = privacy["disabled-during-native-retain"]
        check("privacy", "off: recall empty and every list off", off["applicationRecall"]["content"] is None and all(b["lookup"]["body"]["status"] == "off" for b in off["banks"]))
        for step in ("disabled-during-native-retain", "reenabled-after-late-native-retain", "reset-during-native-retain"):
            check("privacy", f"{step}: no late or stale fact learned", not absent_layers(privacy[step], "Slate-Grouse|Juniper Vault|Cobalt-Swift"), str(absent_layers(privacy[step], "Slate-Grouse|Juniper Vault|Cobalt-Swift")))
        reset = privacy["reset-during-native-retain"]
        check("privacy", "reset reported pending cleanup, then settled", reset["reset"]["body"].get("nativeCleanupPending") and not reset["cleanup"]["nativeCleanupPending"])
        check("privacy", "reset: old detail gone, chat kept", reset["oldDetail"]["status"] in {404, 409} and bool(reset["survivingChat"]))
        # Today's recall lines end in "(kind, said N days ago)"; the archive's check read the bare line end.
        check("privacy", "reset: other account keeps its recall", bool(re.search(r"Bronze-Rook\.( \([^)]*\))?$", reset["secondUserAfterReset"]["content"] or "")))
        check("privacy", "reset: three retired banks absent", len(reset["physical"]) == 3 and all(not row["existsAfter"] for row in reset["physical"]))
    except KeyError as missing:
        info("privacy", "record", f"unfinished: no step {missing}")


record, faults = load("faults")
if record:
    try:
        linked_recall("faults", record)
        for name in ("curation-outage", "outage-retry-with-slow-response", "malformed-curation-output", "dirty-edit-final-check-fault", "persistent-dirty-fault-exhaustion", "persistent-dirty-fault-retry"):
            if name in faults:
                body = operation(faults[name])
                info("faults", f"{name} operation", f"status={body.get('status')} error={body.get('errorCode')} retryable={body.get('retryable')} cleanup={body.get('cleanupPending')}")
        if "curation-outage" in faults:
            check("faults", "outage: the edit fails, earlier facts stay", operation(faults["curation-outage"]).get("status") == "failed" and not missing_layers(faults["curation-outage"], "orange typewriter|typewriter is orange"), str(missing_layers(faults["curation-outage"], "orange typewriter|typewriter is orange")))
        if "dirty-edit-final-check-fault" in faults:
            dirty = faults["dirty-edit-final-check-fault"]
            leaked = [k for k in ("published", "page", "recall") if mentions(layers(dirty)[k], "lilac")]
            check("faults", "final-check fault: no replaced colour shown", not leaked, str(leaked))
            info("faults", "final-check fault: raw annotation names the replaced colour (recorded as a false acceptance)", str(mentions(layers(dirty)["raw"], "from lilac to burgundy|lilac")))
        if "fault-recovery-unrelated-turn" in faults:
            check("faults", "a later unrelated turn is admitted", not missing_layers(faults["fault-recovery-unrelated-turn"], "kitchen timers"), str(missing_layers(faults["fault-recovery-unrelated-turn"], "kitchen timers")))
        if "persistent-dirty-fault-retry" in faults:
            recovered = faults["persistent-dirty-fault-retry"]
            exhaustion = faults["persistent-dirty-fault-exhaustion"]
            check("faults", "persistent fault: same job recovers on retry", operation(recovered).get("id") == operation(exhaustion).get("id") and operation(recovered).get("status") == "applied")
            lost = [t for t in ("mint", "Maja", "kitchen timers") if missing_layers(recovered, t)]
            check("faults", "persistent fault retry: mint applied, Maja and timers kept", not lost, str({t: missing_layers(recovered, t) for t in lost}))
    except KeyError as missing:
        info("faults", "record", f"unfinished: no step {missing}")



# The edit/remove holdout (edit-remove-followup-results.md), through the app: the
# requested removals and changes hold in every layer through the edit, the replay
# (unchanged resend), the forced re-extraction (changed resend) and the later statement;
# the information the user kept stays; the later statement is admitted.
def lines_where(step, include, exclude=None):
    found = {}
    for layer, texts in layers(step).items():
        hits = [t for t in texts if re.search(include, t, re.I) and not (exclude and re.search(exclude, t, re.I))]
        if hits:
            found[layer] = hits[:2]
    return found


ER = {
    "er-en-fresh": {
        "gone": [("bicycle colour (red)", r"\bred\b", None), ("old kayak colour (green)", r"\bgreen\b", None)],
        "kept": [("kayak is yellow", r"yellow"), ("folding bicycle owned", r"folding"), ("stored in the shed", r"shed"), ("brother cycles to work", r"brother")],
        "later": ("purple bicycle", r"purple"),
    },
    "er-hu-regression": {
        "gone": [("the user's gluten-free diet", r"glutén", r"^\W*(- )?Luca"), ("Mák's colour (black)", r"fekete", None), ("Bodza's old colour (white)", r"fehér", None)],
        "kept": [("Luca's gluten-free diet", r"Luca.*glutén|glutén.*Luca"), ("two cats", r"macsk"), ("Bodza is grey", r"szürke")],
        "later": ("Mák's brown fur", r"barna"),
    },
    "er-hu-fresh": {
        "gone": [("the user's vegetarian diet", r"vegetári|húst", r"^\W*(- )?Márton"), ("guitar colour (blue)", r"kék", None), ("piano's old colour (black)", r"fekete", None)],
        "kept": [("Márton's diet", r"Márton.*(vegetári|húst)"), ("Márton lives in Szeged", r"Szeged"), ("guitar owned", r"gitár"), ("piano is brown", r"barna")],
        "later": ("white guitar", r"fehér"),
    },
    "er-remove": {
        "gone": [("the user's telescope", r"telescope", r"sister")],
        "kept": [("sister's black telescope", r"sister.*black telescope"), ("birdwatching", r"birdwatching")],
        "later": ("blue telescope", r"blue telescope"),
    },
}
for case, spec in ER.items():
    record, steps = load(case)
    if not record:
        info(case, "record", "not run")
        continue
    if "er-new-explicit" not in steps:
        info(case, "record", f"unfinished (last step {record['steps'][-1]['name']}); failures {str(record['failures'])[:200]}")
        continue
    linked_recall(case, record)
    for step in record["steps"]:
        if re.match(r"er-(edit|remove)-\d+$", step["name"]):
            body = operation(step)
            check(case, f"{step['name']} applied", body.get("status") == "applied", f"status={body.get('status')} error={body.get('errorCode')}")
        if step["name"] == "er-card-missing":
            info(case, "a card was already changed by an earlier edit", step["edit"]["card"])
    for name in ("er-edit", "er-replay", "er-reprocess", "er-new-explicit"):
        for label, include, exclude in spec["gone"]:
            if case == "er-remove" and name == "er-new-explicit":
                continue  # the later purchase is a new telescope
            hits = lines_where(steps[name], include, exclude)
            check(case, f"{name}: {label} gone from every layer", not hits, str(hits)[:300])
        for label, include in spec["kept"]:
            missing = missing_layers(steps[name], include)
            check(case, f"{name}: {label} kept", not missing, str(missing))
    label, include = spec["later"]
    missing = missing_layers(steps["er-new-explicit"], include)
    check(case, f"later statement admitted: {label}", not missing, str(missing))


# The exact-resend retest (exact-carry.md). Recorded: Hungarian and English metronome
# carried with 0 retains and passed every later step; the English lamp held its changed
# append (memory_dependency_check_rejected); the English tea case passed its steps but
# its changed append rewrote the jasmine correction back to Earl Grey (a false acceptance).
def carry_job(step):
    return next((job for job in step["jobs"] if job["kind"] == "source" and job["sourceId"] == step.get("sourceId")), {})


def active_ids(step, kind):
    return {(row["id"], row["text"]) for bank in step["banks"] for row in bank[kind]}


for case, original, append, separate in (
    ("carry-hu", "kék|Réka", "rozskeny[eé]r", "gomb"),
    ("carry-en-metronome", "Rhea|receipt", "rye bread", "fountain pen nib"),
    ("carry-en-lamp", "blue|Mara", "rye bread", "fountain pen nib"),
    ("carry-en-tea", "jasmine|Mara", "rye bread", "fountain pen nib"),
):
    record, steps = load(case)
    if not record:
        info(case, "record", "not run")
        continue
    linked_recall(case, record)
    if "carry-manual-correction" in steps:
        body = operation(steps["carry-manual-correction"])
        info(case, "manual correction", f"status={body.get('status')} error={body.get('errorCode')}")
    before = steps.get("carry-manual-correction") or steps.get("carry-before-exact")
    exact = steps["carry-exact-resend"]
    job = carry_job(exact)
    check(case, "exact resend: accepted with 0 retains and 0 document deletes", job.get("status") == "succeeded" and not exact["wire"]["retains"] and not exact["wire"]["docDeletes"], f"job={job.get('status')} error={job.get('errorCode')} retains={len(exact['wire']['retains'])} deletes={len(exact['wire']['docDeletes'])}")
    check(case, "exact resend: same native facts and observations", all(active_ids(before, k) == active_ids(exact, k) for k in ("raw", "observations")))
    check(case, "exact resend: Memory still shows the chat's facts", not missing_layers(exact, original.split("|")[0]) if job.get("status") == "succeeded" else False, str(missing_layers(exact, original.split("|")[0])))
    dependent = steps["carry-dependent-reply"]
    check(case, "dependent reply: one retain, accepted", carry_job(dependent).get("status") == "succeeded" and len(dependent["wire"]["retains"]) == 1, f"job={carry_job(dependent).get('status')} retains={len(dependent['wire']['retains'])}")
    changed = steps.get("carry-changed-append") or steps.get("carry-reasserted-preference")
    job = carry_job(changed)
    info(case, "changed append", f"job={job.get('status')} error={job.get('errorCode')} retains={len(changed['wire']['retains'])}")
    plain = steps["carry-plain-deletion"]
    origin = steps["carry-authored"]["sourceId"]
    check(case, "plain deletion: the original chat's document deleted", any(ev["path"].endswith(f"/documents/{origin}") and ev["response"] == 200 for ev in plain["wire"]["docDeletes"]))
    check(case, "stale edit pointer: 0 retains", not steps["carry-stale-edit-pointer"]["wire"]["retains"])
    first = steps["carry-unsubmitted-first-retain"]
    retains = first["wire"]["retains"]
    check(case, "never-submitted message: one first retain at its own date", len(retains) == 1 and retains[0]["body"]["items"][0]["timestamp"][:10] == "2026-08-16", str([r["body"]["items"][0]["timestamp"] for r in retains]))
    if case == "carry-en-tea":
        for name in ("carry-changed-append", "carry-plain-deletion", "carry-stale-edit-pointer", "carry-unsubmitted-first-retain"):
            check(case, f"{name}: the jasmine correction holds, no Earl Grey (recorded as resurrected)", not missing_layers(steps[name], "jasmine") and not absent_layers(steps[name], "Earl Grey"), f"missing jasmine in {missing_layers(steps[name], 'jasmine')}, Earl Grey in {absent_layers(steps[name], 'Earl Grey')}")

summary = {}
for row in results:
    summary.setdefault(row["case"], {"pass": 0, "fail": 0, "info": 0})[row["result"]] += 1
for row in results:
    if row["result"] != "pass":
        print(f"[{row['result']}] {row['case']}: {row['check']} {row['detail']}")
print(json.dumps(summary))
if OUT:
    OUT.write_text(json.dumps({"summary": summary, "checks": results}, indent=2, ensure_ascii=False) + "\n")
