"""Recheck the archived layer-by-layer observations without invoking a model."""
import gzip
import json
from pathlib import Path
import re

HERE = Path(__file__).parent / "evidence"

def load(case):
    with gzip.open(HERE / f"{case}.json.gz", "rt") as stream:
        record = json.load(stream)
    return record, {step["name"]: step for step in record["steps"]}

def layers(step):
    return {
        "raw": [row["text"] for bank in step["banks"] for row in bank["raw"]],
        "native_observations": [row["text"] for bank in step["banks"] for row in bank["observations"]],
        "published": [row["text"] for bank in step["banks"] for row in bank["published"]],
        "page": [row["text"] for bank in step["banks"] for row in bank["lookup"]["body"]["rows"]],
        "recall": (step["applicationRecall"]["content"] or "").splitlines(),
    }

def mentions(texts, term):
    return any(re.search(term, text, re.I) for text in texts)

def absent(step, term):
    for layer, texts in layers(step).items():
        assert not mentions(texts, term), (step["name"], layer, term, texts)

def present(step, term):
    for layer, texts in layers(step).items():
        assert mentions(texts, term), (step["name"], layer, term, texts)

def operation(step):
    assert step["operation"]["status"] == 200
    return step["operation"]["body"]

def check_day(step, term, day):
    found = False
    for bank in step["banks"]:
        for row in bank["lookup"]["body"]["rows"]:
            if re.search(term, row["text"], re.I):
                found = True
                assert row["updatedAt"][:10] == f"2026-08-{day:02}", row
    assert found, term

def verify_linked_recall(record):
    for s in record["steps"]:
        if "applicationRecall" not in s:
            continue
        published = {
            (row["nativeId"], row["generation"], row["text"])
            for bank in s["banks"] if bank["scope"]["kind"] == "personal"
            for row in bank["published"]
        }
        for evidence in s["applicationRecall"]["evidenceCandidates"]:
            ref = evidence["id"].removeprefix("memory-fact:")
            matches = [row for row in published if row[:2] == (ref, evidence["metadata"]["generation"])]
            assert len(matches) == 1, (record["mode"], s["name"], ref)

for case, prop, old, new, others in (
    ("en", "metronome", "bronze", "walnut", ["Rhea", "Saturday", "warm desk lamp"]),
    ("hu", "távcs", "réz", "alumínium", ["Ákos", "csütörtök", "asztali lámp"]),
):
    record, steps = load(case)
    verify_linked_recall(record)
    assert operation(steps["add"])["status"] == operation(steps["edit"])["status"] == "applied"
    exact_source = next(item["text"] for item in steps["original"]["sources"] if item["eventId"].startswith("message:"))
    for detail in steps["original"]["banks"][0]["details"]:
        if detail["body"]["origin"] == "conversation":
            assert detail["body"]["sources"][0]["quote"] == exact_source
    present(steps["original"], old)
    present(steps["edit"], new)
    absent(steps["edit"], old)
    assert operation(steps["edit"])["ref"] is None
    corrected = next(detail["body"] for detail in steps["edit"]["banks"][0]["details"] if mentions([detail["body"]["row"]["text"]], new))
    assert corrected["origin"] == "unknown" and not corrected["versions"] and not corrected["sources"]
    for name in ("edit", "partial-remove", "unchanged-resend", "forced-native-reextraction"):
        for other in others:
            present(steps[name], other)
        absent(steps[name], old)
    for name in ("unchanged-resend", "forced-native-reextraction"):
        for other, day in zip(others, (3, 3, 2), strict=True):
            check_day(steps[name], other, day)
    pre = steps["forced-native-reextraction"]
    post = steps["native-api-and-app-restart"]
    assert pre["process"] != post["process"]
    for key in ("raw", "observations", "published", "details"):
        assert pre["banks"][0][key] == post["banks"][0][key], (case, key)
    assert set(layers(pre)["recall"]) == set(layers(post)["recall"])
    ack = steps["whole-remove-acknowledged-before-drain"]
    assert operation(ack)["exclusionAcknowledged"] and ack["priorDetail"]["status"] == 409
    for key in ("published", "page", "recall"):
        assert not mentions(layers(ack)[key], prop)
    if case == "en":
        part = steps["partial-remove"]
        assert operation(part)["status"] == "failed"
        assert mentions(layers(part)["page"], "walnut") and not mentions(layers(part)["recall"], "walnut")
        latent = next(r for b in part["banks"] for r in b["observations"] if "walnut" in r["text"])
        public = next(r for b in part["banks"] for r in b["published"] if "walnut" in r["text"])
        assert latent["id"] != public["nativeId"]
        assert latent["source_memory_ids"] == json.loads(public["sourceIdsJson"])
        assert operation(steps["whole-remove"])["status"] == "applied"
        absent(steps["whole-remove"], prop)
        absent(steps["post-remove-unchanged-resend"], prop)
        present(steps["newer-assertion"], "maple")
        for term, day in zip([*others, "railway stamps", "maple"], (3, 3, 2, 11, 19), strict=True):
            check_day(steps["newer-assertion"], term, day)
        absent(steps["newer-assertion"], "bronze|walnut")
    else:
        assert operation(steps["partial-remove"])["status"] == "applied"
        for name in ("partial-remove", "unchanged-resend", "forced-native-reextraction"):
            present(steps[name], prop)
            absent(steps[name], new)
        whole = steps["whole-remove"]
        assert operation(whole)["status"] == "failed" and operation(whole)["cleanupPending"]
        assert mentions(layers(whole)["raw"], prop) and not mentions(layers(whole)["recall"], prop)
        assert mentions(layers(whole)["recall"], "vasúti bélyeg")
        for name in ("post-remove-unchanged-resend", "newer-assertion"):
            assert not mentions(layers(steps[name])["recall"], "távcs|titán|vasúti bélyeg")
            assert any(job["errorCode"] == "memory_curation_publication_held" for job in steps[name]["jobs"])
    print(case, "reproduced archived pass/failure observations and restart equality")

record, cancel = load("cancel")
verify_linked_recall(record)
present(cancel["dependent-baseline"], "seed library")
assert any(ev["method"] == "PATCH" and "/memories/" in ev["path"] and ev["response"] == 200 for ev in record["relay"])
choice = cancel["reenabled-dependent-repair"]
assert operation(choice)["errorCode"] == "memory_edit_restore_source_changed"
assert not mentions(layers(choice)["recall"], "seed library|Monday|Friday")
assert mentions(layers(choice)["recall"], "paper maps")
assert any(source["state"] == "repair_held" and "seed library" in source["text"] for source in choice["sources"])
assert any(job["errorCode"] == "memory_curation_publication_held" for job in cancel["unrelated-publication-after-cancellation"]["jobs"])
print("cancel reproduced confirmed native mutation, surviving dependent hold, and no leaked schedule")

record, privacy = load("privacy")
verify_linked_recall(record)
scope = privacy["scope-isolation"]
for field, required, forbidden in (
    ("applicationRecall", "Indigo Lane", "Peregrine-Birch|Tern-Alder|Bronze-Rook"),
    ("projectA", "Peregrine-Birch", "Tern-Alder|Bronze-Rook"),
    ("projectB", "Tern-Alder", "Peregrine-Birch|Bronze-Rook"),
    ("otherUser", "Bronze-Rook", "Indigo Lane|Peregrine-Birch|Tern-Alder"),
):
    lines = scope[field]["content"].splitlines()
    assert mentions(lines, required) and not mentions(lines, forbidden)
assert scope["deniedProject"]["status"] == scope["foreignDetail"]["status"] == 404
off = privacy["disabled-during-native-retain"]
assert off["applicationRecall"]["content"] is None and len(off["banks"]) == 3
assert all(bank["lookup"]["body"]["status"] == "off" for bank in off["banks"])
for step in ("disabled-during-native-retain", "reenabled-after-late-native-retain", "reset-during-native-retain"):
    absent(privacy[step], "Slate-Grouse|Juniper Vault|Cobalt-Swift")
reset = privacy["reset-during-native-retain"]
assert reset["reset"]["body"]["nativeCleanupPending"] and not reset["cleanup"]["nativeCleanupPending"]
assert reset["oldDetail"]["status"] in {404, 409} and reset["survivingChat"]
assert reset["secondUserAfterReset"]["content"].endswith("Bronze-Rook.")
assert len(reset["physical"]) == 3 and all(not row["existsAfter"] for row in reset["physical"])
postgres = json.loads((HERE / "postgres-reset.json").read_text())
assert set(postgres["banks"]) == {row["id"] for row in reset["physical"]}
assert len(postgres["counts"]) == 26 and set(postgres["counts"].values()) == {0}
print("privacy reproduced bank isolation, off/reset fences, and zero rows in 26 PostgreSQL tables")

record, faults = load("faults")
verify_linked_recall(record)
assert operation(faults["curation-outage"])["status"] == "failed"
assert operation(faults["malformed-curation-output"])["status"] == "applied"
dirty = faults["dirty-edit-final-check-fault"]
assert operation(dirty)["status"] == "applied"
assert mentions(layers(dirty)["raw"], "from lilac to burgundy")
for layer in ("published", "page", "recall"):
    assert not mentions(layers(dirty)[layer], "lilac")
exhaustion = faults["persistent-dirty-fault-exhaustion"]
assert operation(exhaustion)["status"] == "failed" and operation(exhaustion)["cleanupPending"]
assert mentions(layers(exhaustion)["raw"], "mint") and mentions(layers(exhaustion)["page"], "burgundy")
assert not mentions(layers(exhaustion)["recall"], "mint|burgundy")
recovered = faults["persistent-dirty-fault-retry"]
assert operation(recovered)["id"] == operation(exhaustion)["id"] and operation(recovered)["status"] == "applied"
for present_term in ("mint", "Maja", "kitchen timers"):
    present(recovered, present_term)
with gzip.open(HERE / "provider.jsonl.gz", "rt") as stream:
    calls = [json.loads(line) for line in stream]
assert len(calls) == 172
assert {call["request"]["model"] for call in calls} == {"qwen3-6-27b"}
assert {call["response"]["status"] for call in calls} == {200}
print("faults reproduced bounded attempts, a raw annotation leak and recovery of the same job")

record, hu_retest = load("hu-carry-forward-r3")
verify_linked_recall(record)
assert record["final"] == "after-replay"
for step_name in ("add", "edit", "partial-remove", "whole-remove"):
    assert operation(hu_retest[step_name])["status"] == "applied"
before = hu_retest["app-restart-after-replay"]
published_target = next(row for bank in before["banks"] for row in bank["published"] if mentions([row["text"]], "távcs"))
supporting_ids = set(json.loads(published_target["sourceIdsJson"]))
raw = [fact for bank in before["banks"] for fact in bank["raw"] if fact["id"] in supporting_ids]
assert len(raw) == 2
carry = next(f["document_id"] for f in raw if any(s["sourceId"] == f["document_id"] and not s["exists"] for s in before["sourceMessages"]))
receipt = next(a for a in before["actions"] if a["kind"] == "source_edit" and a["intent"]["outcome"] == "accepted" and carry in a["intent"]["sourceIds"])
assert any(item["sourceId"] == receipt["requestId"] and item["exists"] and item["sameText"] for item in before["sourceMessages"])
assert operation(hu_retest["whole-remove-acknowledged-before-drain"])["exclusionAcknowledged"]
assert hu_retest["whole-remove"]["priorDetail"]["status"] == 409
assert not operation(hu_retest["whole-remove"])["cleanupPending"]
for checkpoint in ("whole-remove", "post-remove-unchanged-resend"):
    absent(hu_retest[checkpoint], "távcs|titán|réz|alumínium")
after = hu_retest["newer-assertion"]
present(after, "titán")
absent(after, "réz|alumínium")
for term, day in (
    ("bátyja|brácsa", 3), ("csütörtök", 3), ("asztali lámp", 2),
    ("vasúti bélyeg", 11), ("titán", 19),
):
    check_day(after, term, day)
print("HU retest passed verified carry-forward, whole removal, repeat replay, and preserved assertion dates")

for filename, key in (
    ("cancel-resumed-r3", "original-cancellation-after-recovery"),
    ("cancel-fresh-r3", "reenabled-dependent-repair"),
):
    record, case = load(filename)
    verify_linked_recall(record)
    staged = case[key]
    assert operation(staged)["errorCode"] == "memory_dependency_check_rejected"
    assert operation(staged)["cleanupPending"]
    assert mentions(layers(staged)["raw"], "seed library")
    assert not mentions(layers(staged)["recall"], "seed library|Monday|Friday")
    assert case["unrelated-add-after-cancellation"]["submission"]["status"] == 409
print("the intermediate cancellation retests rebuilt native state but independently reproduced a rejected publication")

for filename in ("cancel-resumed-r4", "cancel-fresh-resumed-r4"):
    record, case = load(filename)
    verify_linked_recall(record)
    before = case["original-cancellation-before-recovery"]
    after = case["original-cancellation-after-recovery"]
    assert operation(before)["errorCode"] == "memory_dependency_check_rejected"
    assert operation(after)["id"] == operation(before)["id"]
    assert operation(after)["errorCode"] == "memory_dependency_source_missing"
    assert operation(after)["cleanupPending"]
    held = next(source for source in after["sources"] if source["eventId"].startswith("dependency:"))
    assert held["state"] == "repair_held" and held["eventId"].endswith(":restore")
    assert any(event["method"] == "DELETE" and event["response"] == 200 and event["path"].endswith(held["id"]) for event in record["relay"])
    assert not mentions(layers(after)["raw"], "seed library|Monday|Friday")
    assert case["unrelated-add-after-cancellation"]["submission"]["status"] == 409
print("the exact saved retries reproduced the lost replacement identity without disclosing a removed schedule")

for filename in ("cancel-fresh-replacement-r4", "cancel-fresh-omission-r4"):
    record, case = load(filename)
    verify_linked_recall(record)
    before = case["dependent-baseline"]
    refused = case["after-dirty-cancellation"]
    assert operation(refused)["status"] == "failed" and not operation(refused)["cleanupPending"]
    assert refused["faultUnused"] == 1 and "cancellation" not in refused
    assert not any(event["method"] == "PATCH" and "/memories/" in event["path"] for event in record["relay"])
    for layer, texts in layers(before).items():
        assert set(texts) == set(layers(refused)[layer]), (filename, layer)
print("fresh replacement and omission refusals made no native PATCH and kept their accepted evidence")

for filename in ("cancel-original-recovered-r5", "cancel-fresh-recovered-r5"):
    record, case = load(filename)
    verify_linked_recall(record)
    before = case["original-cancellation-before-recovery"]
    recovered = case["original-cancellation-after-recovery"]
    added = case["unrelated-add-after-cancellation"]
    assert operation(before)["errorCode"] == "memory_dependency_source_missing"
    assert operation(recovered)["id"] == operation(before)["id"]
    assert operation(recovered)["status"] == "failed"
    assert operation(recovered)["errorCode"] == "memory_edit_cancelled"
    assert not operation(recovered)["retryable"] and not operation(recovered)["cleanupPending"]
    old = next(source for source in before["sources"] if source["eventId"].endswith(":restore"))
    restored = next(source for source in recovered["sources"] if source["id"] == old["id"])
    assert old["state"] == "repair_held" and restored["state"] == "accepted"
    assert old["nativeOperationId"] != restored["nativeOperationId"]
    assert restored["assertedAt"] == old["assertedAt"] and restored["assertedAt"][:10] == "2026-08-03"
    for checkpoint in (recovered, added):
        absent(checkpoint, "Monday|Friday")
        present(checkpoint, "seed library")
        present(checkpoint, "paper maps")
        check_day(checkpoint, "seed library", 3)
        check_day(checkpoint, "paper maps", 4)
    quote = next(d["body"]["sources"][0] for b in recovered["banks"] for d in b["details"] if mentions([d["body"]["row"]["text"]], "seed library"))
    assert quote["available"] and quote["quote"] == "Yes, I do. I also maintain the community seed library."
    assert operation(added)["status"] == "applied"
    present(added, "brass thimbles")
print("both exact saved cancellations recovered the independent dated statement and unblocked Add")


def carry_job(step):
    return next(job for job in step["jobs"] if job["kind"] == "source" and job["sourceId"] == step["sourceId"])


def active_ids(step, kind):
    return {
        (row["id"], row["text"], row.get("mentioned_at"))
        for bank in step["banks"] for row in bank[kind]
    }


def physical_ancestry_withdrawn(case):
    origin_id = case["carry-authored"]["sourceId"]
    settled = case["carry-plain-deletion"]
    assert settled["deletion"]["status"] == 200
    assert any(ev["path"].endswith(f"/documents/{origin_id}") and ev["response"] == 200 for ev in settled["wire"]["docDeletes"])
    assert any(source["id"] == origin_id and source["state"] == "revoked" for source in settled["sources"])
    assert all(row["document_id"] != origin_id for bank in settled["banks"] for row in bank["raw"])


def carry_first_retain(case):
    unsent = case["carry-unsubmitted"]
    original = next(s for s in unsent["sources"] if s["id"] == unsent["sourceId"])
    assert original["state"] == "pending" and not original["nativeSubmitted"]
    assert unsent["wire"]["retains"] == []
    finally_sent = case["carry-unsubmitted-first-retain"]
    assert carry_job(finally_sent)["status"] == "succeeded"
    belongs, = finally_sent["wire"]["retains"]
    raw_item, = belongs["body"]["items"]
    assert raw_item["timestamp"] == original["assertedAt"]
    assert raw_item["document_id"] == finally_sent["sourceId"]
    assert raw_item["timestamp"][:10] == "2026-08-16"
    assert mentions([raw_item["content"]], "rosemary|rozmaring")
    assert not case["carry-stale-edit-pointer"].get("sourceId")
    assert not case["carry-stale-edit-pointer"]["wire"]["retains"]


for name, original_terms, append_term, separate_term in (
    ("exact-carry-hu", ("kék", "Réka"), "rozskeny[eé]r", "gomb"),
    ("exact-carry-en-metronome", ("bronze", "Rhea", "receipt"), "rye bread", "fountain pen nib"),
    ("exact-carry-en-dependent-hold", ("blue", "Mara"), "rye bread", "fountain pen nib"),
    ("exact-carry-en-tea", ("jasmine", "Mara"), "rye bread", "fountain pen nib"),
):
    record, case = load(name)
    verify_linked_recall(record)
    before = case.get("carry-manual-correction") or case["carry-before-exact"]
    exact = case["carry-exact-resend"]
    assert carry_job(exact)["status"] == "succeeded"
    assert exact["wire"]["retains"] == exact["wire"]["docDeletes"] == []
    for category in ("raw", "observations"):
        assert active_ids(before, category) == active_ids(exact, category)
    alias = next(s for s in exact["sources"] if s["id"] == exact["sourceId"])
    assert alias["state"] == "accepted" and not alias["nativeSubmitted"] and not alias["facts"]
    assert alias["assertedAt"][:10] == "2026-08-02"
    assert case["carry-authored"]["sourceId"] in json.loads(alias["context"])["carriedSourceIds"]
    for term in original_terms:
        present(exact, term)

    dependent = case["carry-dependent-reply"]
    assert carry_job(dependent)["status"] == "succeeded"
    payload, = dependent["wire"]["retains"]
    item, = payload["body"]["items"]
    parsed_context = json.loads(item["context"])
    prior = [entry for entry in parsed_context["messages"] if entry["role"] == "prior-memory"]
    physical_ids = {f["id"] for b in exact["banks"] for f in b["raw"]}
    assert prior and all(entry["id"] in physical_ids for entry in prior)
    assert {entry["date"][:10] for entry in prior} <= {"2026-08-02", "2026-08-04"}
    assert "carriedSourceIds" not in item["context"]
    assert all(mentions([fact["text"] for fact in prior], term) for term in original_terms)
    present(dependent, separate_term)
    check_day(dependent, separate_term, 8)

    changed = case["carry-changed-append"]
    raw_primary, = [f for b in changed["banks"] for f in b["raw"] if f["document_id"] == changed["sourceId"]]
    assert raw_primary["mentioned_at"][:10] == "2026-08-10"
    assert mentions([raw_primary["text"]], append_term)
    assert not mentions([raw_primary["text"]], "|".join(original_terms))
    if name == "exact-carry-en-dependent-hold":
        assert carry_job(changed)["errorCode"] == "memory_dependency_check_rejected"
        assert not mentions(layers(changed)["recall"], "rye bread|fountain pen nib")
    else:
        assert carry_job(changed)["status"] == "succeeded"
        present(changed, append_term)
        check_day(changed, append_term, 10)
    physical_ancestry_withdrawn(case)
    carry_first_retain(case)
    if name != "exact-carry-en-tea":
        assert case["carry-plain-deletion"]["applicationRecall"]["content"] is None
        if name != "exact-carry-en-dependent-hold":
            present(changed, separate_term)
            check_day(changed, separate_term, 8)
            for term in original_terms:
                present(changed, term)
                check_day(changed, term, 2)
    else:
        assert operation(before)["status"] == "applied"
        check_day(exact, "jasmine", 4)
        absent(exact, "Earl Grey")
        assert "earl grey" not in item["context"].lower()
        native_jasmine = next(f for b in exact["banks"] for f in b["raw"] if "jasmine" in f["text"])
        mutations = record["relay"][changed["wire"]["from"]:changed["wire"]["through"]]
        assert any(
            e["method"] == "PATCH" and e["response"] == 200 and e["path"].endswith(native_jasmine["id"])
            and "Earl Grey" in e["body"]["text"] for e in mutations
        )
        for checkpoint in (changed, case["carry-plain-deletion"], case["carry-stale-edit-pointer"]):
            present(checkpoint, "Earl Grey")
            absent(checkpoint, "jasmine")
            check_day(checkpoint, "Earl Grey", 4)
            row = next(f for b in checkpoint["banks"] for f in b["raw"] if f["id"] == native_jasmine["id"])
            assert row["document_id"] == native_jasmine["document_id"]
            assert row["mentioned_at"] == native_jasmine["mentioned_at"]
        authored = next(s for s in changed["sources"] if s["id"] == native_jasmine["document_id"])
        assert authored["text"] == "I prefer jasmine tea." and authored["eventId"].startswith("manual:")
    print(name, "verified exact transport counts, physical evidence and separately graded later append")

record, held = load("exact-carry-en-held-correction")
verify_linked_recall(record)
assert operation(held["carry-manual-correction"])["status"] == "failed"
assert operation(held["carry-manual-correction"])["cleanupPending"]
assert held["carry-exact-resend"]["wire"]["retains"] == []
assert carry_job(held["carry-exact-resend"])["errorCode"] == "memory_curation_publication_held"
print("held English draft records zero retain without a false exact-carry pass")
