# Re-check RC-T · the tours, reviewed and walked the way the owner walks them (report only)

The tours are built on `feat/artifacts-tours` (`c66d80c1`: TR-A server, TR-B card/trigger/replay, TR-C empty states,
admin gaps, strings, no Slides chip). Before they go to ai.dev, check them twice: as a reviewer of the diff, and as the
owner using them. **Report only; do not fix** (a fix agent follows if you find something).

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/rc-t` (detached at `c66d80c1`),
  e2e/dev-server port **5500**, label `rct`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/5c073247-a423-47a9-b825-91f05ce97740/scratchpad/w4/rct-report.md`;
  screenshots `…/scratchpad/w4/shots/rct/` (at most 14, each one you looked at).
- Read first: `docs/plans/claude-at-home-2/wave-4/common.md` (+ the Wave 3 rules it points to); rulings 4, 8, 32, 33, 69, 71
  in `decisions.md`; the three tours reports (`wave-4/tra-report.md`, `trb-report.md`, `trc-report.md`: their deviations and
  concerns); AGENTS.md's Tours section. The diff: `git diff 43694579...c66d80c1` (read by file, `--stat` first).

## 1. Review the diff (working-plan §7's RV-6 list, and more)

The badge predicate fix (a published tour never becomes the sidebar badge's campaign, and is never counted as a replay);
once per user per kind and per published copy; replay writes nothing; an incognito chat shows no tour and sends no
request; the seen row holds no conversation or artifact id, joins the account archive and goes on erasure; archiving falls
back to the code copy (ruling 71); the publish rule for a tour's kind; nothing serves, seeds, lists or renders Slides
(ruling 69); ruling 49's route shapes and 401/404/409; the card is one lazy chunk the chat never loads until a tour shows
(the chat-route baseline moved twice: are the two moves honest — strings and trigger only?); no user-visible "Artifact" in
either language; Svelte 5 idioms and Lucide; no telemetry with content. Name file:line for each finding.

## 2. Walk it like the owner (real browser, real pointer and keyboard, Hungarian, 1440×900 and 390×844, light and dark)

Run the app on your port with a scratch DB (`DATABASE_PATH="$PWD/data/rct.db"`, `npm run db:prepare` first) and use the
e2e helpers' seeding to make one Document, one App and one Canvas in a chat (no model needed). Then, as a person:
first open of each kind shows its own tour; Next/Back/Got it by mouse, then the keyboard alone (Tab, Enter, Escape);
reopen → no tour; Skip on slide 2, reload → no tour; the list row menu's "How this kind works" replays it and writes
nothing; an empty Canvas shows its line and "Újra megnézem" replays; an incognito chat shows none; a second user still
sees them; as admin: seed the drafts, edit the Canvas tour's text, publish → a user who saw the old copy sees the new one
once, and the empty state shows the new line; archive it → the default copy is back; the Knowledge tab shows no Slides
chip; the sidebar version badge still opens the release note, never a tour. Note anything that looks wrong, moves, clips,
flickers, reads oddly in Hungarian or takes more than one try.

## Report

Findings by severity (Critical / Important / Minor), each with steps to reproduce and file:line where known; what you
walked and what you saw; a verdict: **ready for ai.dev** or **not ready** (and what blocks). Your final reply to the
orchestrator is at most 12 lines: verdict, your model ID, counts by severity, the top findings in one line each, the
screenshot paths to look at.

**Runs beside you:** agent FLK on `fix/canvas-undo-regression` (from `dev`) — no shared files.
