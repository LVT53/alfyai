# Review RV-3 (Opus) · the whole Canvas before it ships to ai.dev

You are the one adversarial review of Canvas (Slice 3) before the owner sees it. Eight Sonnet agents built it on
`feat/artifacts` (reports in `docs/plans/claude-at-home-2/wave-3/`: s3p, s3t, s3b, s3f, s3c, s3z, s3a, s3y, s3r1 + m1,
s3r2). Each passed its own gates; that is not evidence the whole is right. Find what is wrong, **report only** — do not
fix — with a failing-test sketch per real defect. A fix agent works from your report.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/rv-3` (detached at the head the
  orchestrator gives you), e2e port **5540**, label `rv3`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/cabde459-204b-43f4-96fb-60f3639a68a8/scratchpad/w3/rv3-review.md`;
  screenshots `…/scratchpad/w3/shots/rv3/`.
- `wave-3/common.md` holds the environment and the gate commands. The rulings that define "right" are
  `decisions.md` 1, 11, 12–14, 16, 24, 33, 39, 47, 49, 51, 53, 58, 61–64, and AGENTS.md's Artifacts section.

## What to hunt, in this order (the riskiest first)

1. **The edit protocol.** `shared/artifacts/{canvas,canvas-blocks,canvas-body,ops,board-ops}.ts`,
   `services/artifacts/{ops,canvas-ops,...}.ts`, the ops route: the validation order and every refusal reason; a
   partly refused batch is still a coherent board; the canonical JSON and hash (ruling 12: a no-edit round trip keeps the
   hash; float noise); `baseVersionId` vs a coalesced user save (ruling 47) — can a stale diff overwrite a user's edit?;
   the body caps; the normaliser's drops never lose user content silently; `update_node` rewriting a file/App node's
   reference id (S3-P's open question: acceptable, or an allow-list?).
2. **What the model sees vs what is parsed (ruling 62).** `normal-chat-tools/artifact-tools/` canvas handlers,
   `canvas-model.ts`, `kind-prose.ts`, the catalogue snapshots: the advertised schema is the validator's; the worked
   examples pass the validator (tests exist — are they the real path?); refusals name the fix; the create parse and its
   refile; the `@Alfy` comment path (`canvas-comments.ts`) strips `propertyNames` for vLLM's grammar compiler — confirm
   nothing that constrains the model was stripped with it, and that the stripped schema is still what is parsed.
3. **Ownership, incognito, deletion.** Every Canvas route (ops, body, comments, review, chat-blocks listing, refresh, the
   App node's kv from inside a board) with a foreign id, a missing id (byte-identical 404s), an incognito item with and
   without `?conversationId=`; the chat-blocks listing never returns another conversation's or user's items; the panel
   restore (S3-Z, S3-Y: per-chat map; an incognito chat's items never restored elsewhere, removed on leaving); Delete and
   Regenerate of a Canvas (the facade's cascade covers its comments/versions/review state; `recreate.ts` under the same
   id); the account archive and erasure; no board content, query text or comment text in logs or telemetry.
4. **Outbound reads and embedded content.** The refresh route (S3-R2): only the stored query, only through the one
   `research_web` module, bounded time, abort on disconnect, a user-authored version; photos: a URL reaches an `<img>`
   only as a same-origin path, the Immich proxy's `connectionId` belongs to the user; the App block inside a board: the
   exact sandbox string and CSP (ruling 58), the App's own storage (never the board's), `postMessage` source checks, the
   tripwire — does embedding an App in a board open any path the panel's App frame closed?
5. **The review state (ruling 63).** Touched nodes per unreviewed Alfy version against its parent; Keep, Undo (a user
   version of the parent body, refused after a user edit), Redo; the one `pendingReviewCount` source for card, list row
   and dot; the once-only landing across re-mounts and reloads (the Document's `settledActivityKeyAtMount` lesson); a
   highlight-only edit is never pending.
6. **The owner's walk.** Drive the flows the way the owner will, in Hungarian, at 1440×900 and 390×844, light and dark,
   through the app (Playwright with the e2e fake provider, or the suites' own seeding): a board made in the chat, opened
   from its card; insert note-shaped blocks and blocks from the chat (a file, an App, a map, a chart, photos, a web
   search); frames and arrows; draw; comment and `@Alfy`; an Alfy change landing, Keep and Undo, reload; Delete and
   Regenerate; the Knowledge tab and Workspace Search show the Canvas; the chat card. **Look at every screenshot
   yourself** — agents' screenshot checks missed real defects three times in this feature. Read the new Hungarian
   strings as a native speaker would.
7. **Quality gates.** Svelte 5 idiom in touched files, a11y (roles, names, focus, 44 px targets on phones), reduced
   motion, the chunk guard's honesty (S3-X is bringing the editor under 65 kB gzip beside you — report the numbers you
   see), Fallow, dead code, duplicated logic between the Document and Canvas that should be one.

## Report format

Findings as **Critical / Important / Minor**, each: file:line, the failure scenario (input → wrong result), why it
matters, and the smallest fix with its failing test. Then a **fix plan**: the findings grouped into at most three
clusters with **disjoint files**, so two Sonnet fix agents can run side by side. Then what you checked and found right
(briefly), so the re-check does not repeat it. Final reply at most 12 lines: verdict (ready / ready after fixes / not
ready), counts per severity, the top three findings, your model ID.
