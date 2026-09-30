# Canvas agent S3-Z · the chat's own panel after a reload, Canvas's containment, and a kinder create

Three small, separate jobs that the Canvas milestone needs and that do not touch the board's components.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-s3z`, branch
  `feat/artifacts-s3-containment` (from `feat/artifacts`), e2e port **5480**, label `s3z`, model tunnel local port
  **30050**.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/cabde459-204b-43f4-96fb-60f3639a68a8/scratchpad/w3/s3z-report.md`;
  screenshots `…/scratchpad/w3/shots/s3z/`.
- **Agent S3-C runs at the same time**: `src/lib/components/artifacts/canvas/**`, `src/lib/shared/artifacts/comments.ts`,
  `services/artifacts/comments.ts`, `tests/e2e/artifact-canvas*.spec.ts`. Stay out of those.

## Read first

`wave-3/common.md`; decisions.md rulings 24, 31, 33, 51, 62, 64; the "Found" note in `progress.md`'s S3-B row and
S3-B's report §concerns (item 5); S3-T's report §"Open questions" item 1 and its hand-off; `slice-3.md` 2002–2060 (T9);
`docs/plans/incognito-one-way-spec.md` (grep for what may carry over from an incognito chat).

## Step 1 · A chat's panel shows that chat's items after a reload

Found by S3-B, live on ai.dev: the chat page restores **one tab-wide** workspace from `sessionStorage`
(`src/lib/client/document-workspace-state.ts`, `restorePersistedWorkspaceState` in the chat page), so after a reload
another chat's open items — an incognito chat's included — open in this chat's panel. Since Feature 2 the panel is "what
this chat made". Fix it at the state module (keep the chat page's change to the call): a restore keeps only the items
that belong to this conversation (`conversationId`/`originConversationId`) and the conversation-free items the workspace
legitimately carries (library and search opens), and **never** restores an item from an incognito conversation into any
other conversation (check what the item records; add what it must record if nothing tells). Leaving an incognito chat
must not leave its items behind in the stored state either. Tests first: the state module's unit tests (normal → normal,
incognito → normal, the knowledge page's opens), and one e2e that opens a Canvas in chat A, goes to chat B, reloads and
sees B's own panel.

## Step 2 · Canvas in the containment, ownership and archive suites (T9)

T9's list (2011–2020) as far as it is not already covered generically: append the Canvas cases to
`tests/cross-cutting/incognito-artifact-containment.test.ts` (append only; `ALLOWED_WITHOUT_SCOPE` unchanged, ever) —
the ops route, the body route and the comments for a board made in an incognito chat; another user's board through ops,
body, comments and (when it exists) export → the same 404; the account archive carries canvas bodies, versions and
comments and erasure removes them (ruling 24's reading, as Documents do); no board content in telemetry or logs (grep
the new modules' log lines). Fix any real gap you find, test first.

## Step 3 · An arrow listed with the blocks is still an arrow

Orchestrator ruling from S3-T's eval: in about 30 % of English board creations the model lists arrows under `nodes`;
they are refused with the fix named and mended on the next step, at the price of resending the whole board. In
`parseCanvasCreateBody` (`normal-chat-tools/artifact-tools/canvas-model.ts`), an entry in `nodes` that has `source` and
`target` and no `data` is moved to `edges` (deterministic, tested, nothing else about the contract relaxes; anything
ambiguous is still refused with the fix named). Then re-run the canvas eval's two create fixtures live through the
tunnel (3 repeats each, the committed harness path) and report before/after; commit the recorded answers only if you
change the committed set on purpose.

## Step 4 · A fresh dev server's first test must not flake

Since the Canvas packages arrived, the **first** e2e test of a fresh dev server fails with `ERR_ABORTED` after a Vite
hydrate error (seen at `artifact-app.spec.ts:235` in the orchestrator's integration run and by S4-V; it passes on a
retry or alone on a warm cache). Find the cause (most likely Vite optimising the new dependencies on the first page load
and reloading mid-test) and make the first load deterministic (for example `optimizeDeps.include` for the Canvas
packages, or a warm-up in the Playwright global setup) — prove it by running that spec first against a fresh server with
an empty `.vite` cache, three times.

## Proof

Screenshots: chat B's panel after the reload (desktop), nothing from the incognito chat after leaving it. Full gates once
at the end.
