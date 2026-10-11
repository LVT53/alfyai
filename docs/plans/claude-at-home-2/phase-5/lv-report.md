# LV: the versioning live check (ruling 76), proved locally against the real model

Model: Sonnet 5.5 (`claude-sonnet-5-5`). Status: DONE. No product code changed, nothing committed, nothing pushed. Both scratch
worktrees (`art-lv` at `8b8b29ec`, `art-lv2` at `7eea581b`) are removed; the server, the tunnel and the proxies are stopped.

## What is where

- `~/.cache/alfyai-artifacts/live-checks/verify-history-p5.mjs` (967 lines, Node built-ins only, one ES module, piped like the Canvas check):
  `ssh -T alfyroot 'set -a; . /root/verify-harness.env; set +a; BASE=http://127.0.0.1:3002 node --input-type=module -' < verify-history-p5.mjs`
  Env: `EMAIL PASSWORD BASE ONLY TURN_TIMEOUT_MS KEEP` (ONLY: `doc-en`, `doc-hu`, `app`, `incognito`, or `doc`). PASS/FAIL per check with
  evidence, exit 1 on any FAIL; a check that cannot run because an earlier one broke is a FAIL ("not run: ..."), never a skip. A chat
  turn that meets the per-account stream limit (503 CAPACITY_EXCEEDED, retryAfter) waits and asks again (up to 6 attempts).
- Companions, same folder (not required to run it): `verify-history-p5.selftest.mjs` (offline: 59 cases for the judging helpers, no server)
  and `verify-history-p5.mutate-proxy.mjs` (a mutating proxy in front of a real build; its header lists every mutation and the check it
  must break).

## The checks (12 lines; a full run takes roughly 3 to 4 minutes with this model: 6 chat turns and 1 App rebuild)

| id | what it proves |
|---|---|
| `doc-en/setup` | turn makes a Document (v1, Alfy); reader save through the body route (v2); a turn makes Alfy edit it in place (v3, one more ask if it does not); no second Document; the edit's items were proven absent from the first draft first |
| `doc-en/summary` | Alfy's own words are one short line, no subject ("I ...", "Alfy ..." fail), past tense (a bare or -ing or third-person verb, or a noun-phrase start, fails; an unknown first word is a note), not the fallback, and History shows them verbatim as stored |
| `doc-en/moments` | GET history newest first: Alfy's edit (status `waiting`, a document detail, holds the newest row), the reader's edit (kind `user_edit`, what it added, `startedAt` stamped), Alfy's first draft; no moment string carries a bare `vN`; the chat card's review count and the open item's `lastAuthor/lastKind` agree |
| `doc-en/undo` | body route with `summaryKind: undid_alfy_change` + `summaryVersion`: the next GET folds it onto the change (one moment, fold `undone`, status `undone`, the Undo as its step, `undoneBy`), header says `undo_alfy_change`, nothing left waiting |
| `doc-en/restore` | restore of the first draft with a stale `expectVersion` is refused and writes nothing (409 `version_conflict`; any refusal that writes nothing is accepted and named); with the current one it succeeds; History: kind `restore`, `restoredFrom` = v1, v1 `sameAsNow` and `restoredHere` |
| `doc-en/name` | quick saves coalesce (control); naming (spaces folded) sticks, mints no version, 61 characters / a number are 400, blank removes it; typing after a name opens a new version and leaves the named words alone |
| `doc-en/paging` | pages of 2, 3 and 4 rows read the same moments, in the same order, as one whole read (the folded Undo falls on, across and past a boundary); `before=abc` and `limit=0` are 400 |
| `doc-hu` | Hungarian create + edit: Alfy's summary is Hungarian, one short line, verbatim as stored, no bare `vN` (a first-person verb form is a note) |
| `app/rebuild` | chat turn makes an App; the panel's own rebuild route (`POST .../app/regenerate`, a real model call; `edit_artifact` refuses Apps, so a chat turn cannot rebuild one) makes v2; History: `app_rebuilt` with the prompt and a line count over `app_made`, no status |
| `app/version` | `GET .../versions/[v1]/app` vs the live App route: 5 non-volatile headers compared entry by entry (all equal), CSP is the App sandbox, it serves v1's stored source exactly with the read-only bridge spliced in (the writing bridge absent), an unknown version is a plain 404 with no sandbox |
| `app/undo` | the rebuild's toast Undo (`restore` with `{expectVersion, undoOf}`) folds with the rebuild; a `...runnable` refusal is tolerated and named |
| `incognito` | an incognito chat's Document: readable through its own chat; history, versions, one version and detail by a bare id, through another chat, or for a missing id inside the chat, and naming, restore and body save by a bare id or another chat, all answer byte for byte like a missing id (17 attempts); nothing was written |

## The local run (real model `qwen3-6-27b` through `ssh -N ... -L 30408:192.168.1.96:30000 alfyroot`)

Build: `feat/artifacts` `8b8b29ec` in a detached scratch worktree (node_modules linked, `svelte-kit sync`, `db:prepare`, `npm run build`,
`node build` on :5520 with MODEL_1/2 and TITLE_GEN on the tunnel, fresh DB, `admin@local`). The final script ran in full twice: 12/12 both
times (the second after the last functional edit); after a last cleanup edit (two unused variables) doc-en + incognito ran again with
`KEEP=0`, 8/8, and the whole script ran on the fix branch (below), 12/12. The second full run:

```
PASS doc-en/setup — "Offsite plan" made by Alfy (v1, 1 row(s); tools=create_artifact); edit items absent from the first draft: true; reader save HTTP 200 -> v2; Alfy edit (1 ask(s), 9873 ms, tools=read_artifact,edit_artifact, edit_artifact x1): v2 -> v3, ...; Documents in the chat: 1
PASS doc-en/summary — Alfy's own words: "Added Accessibility notes section"; short, no subject, past tense, shown verbatim as stored
PASS doc-en/moments — 3 moment(s) newest first: ["alfy_edit:waiting","user_edit","first_draft"]; reader's edit added 1 block(s) ...; header: alfy/alfy_edit; order, kinds, status, details, the review count and the header agree; no bare version number
PASS doc-en/undo — Undo of Alfy's v3 saved as v4 (user: "Undid Alfy's change: v3"); next GET: alfy_edit v3 fold=undone status=undone steps=["undo_alfy_change v4"] undoneBy=v4; one moment, Undone, with the Undo as its step
PASS doc-en/restore — stale (expectVersion 3 of 4): HTTP 409 "version_conflict", artifact still v4; current (expectVersion 4): HTTP 200 -> v5; History: restore restoredFrom v1, first draft sameAsNow=true restoredHere=[5]; refused when stale, restored when current, marked restored-from
PASS doc-en/name — burst control v6/v6; named v6 "Badges ready" (newest stayed v6); too long -> HTTP 400; typing after the name -> v7; remove: "Draft" -> null -> History null; the name sticks, mints no version, and closes the burst
PASS doc-en/paging — 6 moment(s) whole; pages of 2 rows -> [2,2,2] = whole; 3 rows -> [3,2,1] = whole; 4 rows -> [4,2] = whole; before=abc -> HTTP 400, limit=0 -> HTTP 400
PASS doc-hu — "Csapatnap terv" v1 -> v2 (1 ask(s), 11739 ms, ...); Alfy's own words: "Hozzáadtam az Akadálymentesség részt két ponttal"; Hungarian, one short line, shown verbatim as stored, no bare version number (note: first-person verb form ...)
PASS app/rebuild — App v1 made in 30644 ms (tools=create_artifact), rebuilt to v2 in 9642 ms; History: ["app_rebuilt v2","app_made v1"]; rebuild text "Add a \"Reset\" button ...", lines +121/-210; brief "<!DOCTYPE html> <html lang=\"en\"> ..." (note: the brief is the model's own HTML ...); a rebuild moment over the build, no status, no bare version number
PASS app/version — live HTTP 200 / v1 HTTP 200; 5 header(s) compared entry by entry (cache-control, content-security-policy, content-type, referrer-policy, x-content-type-options): all equal; serves v1's stored source exactly (bridge spliced in); read-only bridge: true; unknown version -> HTTP 404; same sandbox headers, v1's source, read-only bridge
PASS app/undo — restore v1 with {expectVersion 2, undoOf 2} -> v3 ("Undid Alfy's change: v2"); History: ["app_rebuilt+undone v2","app_made v1"]; the rebuild and its Undo are one moment
PASS incognito — Document "Incognito probe" made in the incognito chat (2998 ms), a private save -> v2; its own chat reads the history: HTTP 200, 2 moment(s); 17/17 attempts from outside were answered exactly like a missing id (HTTP 404 {"ok":false,"reason":"not_found"}) on history, versions, one version, detail, naming, restore and a body save; nothing written from outside: true (v2, names [null,null])
12/12 checks passed
```

Compatibility with the fix pass: I also built `fix/versioning-review` `7eea581b` (FX-V's I-1..I-5, committed) in a second scratch
worktree and ran the same script: 12/12 (stale restore still 409; a single-version Undo still reads "Undid Alfy's change: vN"; the App restore
of a runnable v1 still works). The two tolerances were proved through the proxy: a stale restore refused as HTTP 400 `stale_view`
(doc-en/restore PASS, names it) and the App toast Undo refused 422 `not_runnable` (app/undo PASS, "tolerated").

## Proof that the lines are honest

A PASS that cannot become a FAIL says nothing, so every check was broken on purpose: 32 mutations through the proxy in front of the real
build (each turns one true answer into the false one), and each turned exactly the intended check red while the others stayed green (a
global mutation also reddens the checks that read the same field, which the evidence names): summary (I-subject, none), moments (status,
`vN` text, dropped first draft, wrong kind, order, `startedAt`, `containsNewest`, review count, header facts), undo (no fold, wrong status),
restore (guard dropped from the request, stale accepted, no restored-from, no same-as-now), name (labels dropped, typing joins the named
version), paging (a page loses a moment), Hungarian (English summary), incognito (a bare id answered as if scoped, the same for a body
save), app (rebuild text, no line count, no fold; no CSP, wrong cache-control, `allow-same-origin`, the writing bridge, other source, an
extra header). The judging helpers (summary shape, language, bare `vN`, header compare, bridge splice) have 59 offline cases in the selftest.

Fixes I made to the script on the way, found by this proving: a first run of four scripts at once hit the account's stream limit (now a bounded
retry); the first-person note fired on lines that already failed on the subject; third-person present verbs ("Updates the intro") passed;
a missing summary printed as "" instead of the fallback; a stale restore that did write said "still v4"; the name check re-sent the
text without block ids (History then reported 2 removed / 3 added for one paragraph; it now types on from the stored text); the incognito
"nothing written" test missed a write that coalesces (now also compares the body hash).

## In the product: what looked wrong

1. **An App's first version stores the model's HTML as its "brief".** `create_artifact`'s `body` field says "Apps: the HTML document"
   (`kind-prose.ts` `bodyFormatEn`), the model sends its whole markup, and `createAppFromBrief` takes `body` as the generation prompt (the
   comment in `normal-chat-tools/artifact-tools/create.ts` says the opposite: "the model's body is its BRIEF, never HTML"). Result seen in
   every run: version 1's summary is `Alfy made the app: <!DOCTYPE html>...` (500 characters of markup) and the History moment's `text`
   for `app_made` is that markup. History never prints it (the headline is "Alfy built the app"), so nothing is visible today, but the
   stored row and the route carry it, and the generator receives that HTML (plus the language line) as its whole prompt
   (`generate.ts`). The script prints a note, not a failure.
2. **The Hungarian edit summary is first person** ("Hozzáadtam az Akadálymentesség részt ..." = "I added ..."). The tool asks for a
   subjectless past-tense line; in English the check fails an "I added", in Hungarian it can only note it. Probably the tool text wants a
   Hungarian example.
3. Not defects, worth knowing: a client that saves Document markdown without the `<!--b:id-->` markers gets every paragraph that arrives bare
   re-minted, so History's detail line counts it as removed and added (the panel's editor keeps ids, so the panel is fine); and two chat turns of one
   account at once get 503 `CAPACITY_EXCEEDED` (`user_limit`), so live checks must run their turns one at a time.

Not verified: anything in the History UI (this is the server and routes only), a Canvas, and the real violating-App path of I-2 (the fixed
body route no longer lets a violating App body be written, so there is no version to restore; the unit tests own that).
