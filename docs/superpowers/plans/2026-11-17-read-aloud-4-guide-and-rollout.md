# Read Aloud — Plan 4 of 4: the Guide, the Docs and the Rollout

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. The tasks are run natively by the sessions in **Who runs what**. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read aloud reaches people. The Feature Guide shows it, the docs and ADR-0070 record it, the box measures each voice's speaking rate, Plans 1–4 merge into `main` and pass the release gate, and the feature goes on in staging, then in production after the UI walk. Every production and box step states its commands before it runs, and every step has a way back.

**Architecture:**
- **No new subsystem.** This plan:
  - adds two Feature Guide entries and updates two drawings;
  - writes ADR-0070 and the docs;
  - adds one script beside the speech service, and the two streaming routes to Apache;
  - ships the merged branch through the release flow the project already uses: the gate, an explicit SHA pushed to `dev`, staging, then `main` and production.
- **The switch:** read aloud goes on through each site's own `TTS_ENABLED` and `TTS_URL` (spec §5).
- **The speech service** is already live on the box (Plan 1, `127.0.0.1:1920`), the same box that serves both sites, so `TTS_URL` is `http://127.0.0.1:1920` for both.

**Tech Stack:** SvelteKit 2.70 and Svelte 5.56, Vitest 4 and Playwright, Python 3.12 (the speech service's environment), Apache 2.4 (Virtualmin vhosts in `/etc/httpd/conf/httpd.conf`), systemd, and the repo's `scripts/gates.sh`, `scripts/deploy.sh` and `scripts/deploy-dev.sh`.

**Spec:** `docs/superpowers/specs/2026-11-16-read-aloud-design.md`: §3 (the ADR), §4.11 (the Feature Guide), §5 (the switch), §8 (before it ships), §9.4 and §10 (the paperwork).
- **The night's rules:** `overnight-runbook-2026-11-17.md` in the shared notes folder (`/Users/lvt53/Library/Application Support/Claude/side-session-notes/local_5a3f641c-81d8-4f8a-a314-44d9e540ab5e/`). Where this plan and the runbook disagree, the runbook wins.
- **Built on:**
  - Plan 1's speech service: its README is the contract and holds the box's paths;
  - Plan 2's reading in the chat;
  - Plan 3's voices and editor: `docs/superpowers/plans/2026-11-17-read-aloud-3-voices-and-editor.md`, whose Task 15 is the knobs' re-measure.

## Global Constraints

- **Approved tonight, with conditions.** The owner approved building Plans 3 and 4, merging, pushing, and deploying to staging and production, the box steps included (the runbook quotes it). Under that approval:
  - **State each production or box command in the session before running it.**
  - **Never restart or reconfigure `vllm-flashnext` or `zonos3`.**
  - Touch production only for the deploy, the Apache streaming rules and the `TTS_ENABLED` switch.
  - **The campaign is not this plan's.** The campaign session saves its draft, and the owner publishes.
- **Production goes on only if staging and the UI walk are green** (Tasks 6 and 7). Otherwise the run stops at staging and reports.
- **Data:** never the owner's data, for tests or for checks.
  - Use made-up or public text.
  - Production checks read no user data: no rows of `messages`, `conversations` or `read_aloud_voices`, only health, headers, the schema and the migration ledger.
  - Staging uses its harness account (`/root/verify-harness.env`, staging only). Its password never reaches the transcript, a file in the repo or a commit.
- **Strings:** every new string in English and Hungarian. The guide's words are `guide.*` keys in `src/lib/i18n/guide.ts`, one Hungarian word per thing (`docs/plans/feature-guide/inventory.md`, section 3).
- **Feature Guide rules:** `src/lib/components/guide/AGENTS.md` and `src/lib/components/drawings/AGENTS.md`. Words are real controls' keys, icons are Lucide, colours are tokens, sizes are design pixels, and the drawings are decorative.
- **The speech service stays as Plan 1 left it.** This plan adds a script beside it (Task 2) and README rows. It never changes `speech_service/`, and it restarts the service only in the rollback.
- **Pushes:** explicit full SHAs (`git push origin <full sha>:refs/heads/dev`), never a bare branch name, and never `| tail` or `| grep` inside an `&&` chain: capture `rc=$?` instead. Before a push, check `git merge-base --is-ancestor origin/<branch> <sha>`. (Project memory: "push an explicit SHA, not dev".)
- **Long commands run in the background** with their status captured: `<cmd> > <log> 2>&1; echo "rc=$?" >> <log>`. Read the `rc=` line.
- **Node 22 in a worktree:** `PATH=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`, written out literally. `scripts/gates.sh` sets it itself.
- **Docs check before code** (`AGENTS.md`). This planning session had no MCP docs tools. The implementer of Task 1 checks the current Svelte 5 docs for the actions and runes it touches; Tasks 6 and 8 rely on the Apache 2.4 `mod_proxy` directives already used in the vhosts.

## Decisions this plan makes (reversible defaults, for the owner's morning review)

1. **Show me goes on Settings → Read aloud, not on the speaker.** Spec §4.11 asks for a Show me marker on the speaker. The guide's own rule (its `AGENTS.md`) allows Show me only where the control is always there, and the speaker needs a finished reply. So:
   - the speaker's entry has Try it, and its row lights the speaker in the chat drawing;
   - Show me rings the Read aloud card's voice pickers.
2. **Two entries** (the guide goes from 31 to 33):
   - "Listen to a reply", in the Ask section, with Try it;
   - "Voices that read to you", in the "Knows you" section, with Show me.
3. **Both entries are `added` on the day production gets read aloud** (default `2026-11-17`). NEW then shows for 30 days.
4. **The guide does not filter by configuration** (its rule). With the feature off, the two entries stay, and Show me rings nothing, quietly. The end-to-end row switches read aloud on for its own test.
5. **One restart switches it on.** Each site's `shared/.env` gets `TTS_URL` and `TTS_ENABLED=true` before that site's deploy, so the deploy's own restart turns read aloud on. The System pane's switch (a live admin override) can still turn it off without a restart.
6. **Staging is built from `dev` only when nobody else's commits are there.**
   - If `origin/dev` holds commits `origin/main` lacks (other sessions' unshipped work), staging is built from a preview branch, `read-aloud-preview`, so they do not ship.
   - The preview branch is deleted once production is on the same SHA.
7. **A gate failure that also fails on `origin/main` alone is pre-existing.** It is recorded with its evidence and does not block. A new failure is fixed.
8. **No reading runs on production.** Its smoke checks read no user data and play nothing; staging and the walk carry the end-to-end proof.
9. **The walk's fixes go the whole way round** (the agent gate, staging, a second walk) before production.
10. **A code rollback never restores the database.** The read-aloud migration only adds a table and three columns, which the previous release ignores. Restoring a database backup is the owner's call, never part of this plan.
11. **Speaking rates are measured with plain sentences.** That means the samples plus four plain sentences per language, with no digits or symbols, which a voice expands. The estimate is "≈", and readings correct it as sentences are made.

**Only the owner decides:** publishing the campaign (not this plan), and restoring a database backup (only in the rollback's last step, never by an agent). Everything else above is a default the owner can turn round in the morning.

## Review Focus

1. **Apache buffers the audio or the events.** On the live sites, Apache sits between the browser and the app; in e2e it does not. A buffered stream makes a reading start late or stall. Check: the unauthenticated `GET` of `…/audio` and `…/events` answers 401 with `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no` through each public host (Tasks 6 and 8). The template's lines are pinned by Task 3's check.
2. **The speech service is down, or `TTS_URL` is wrong, on a site.** Every speaker then turns amber ("Couldn't start reading") while the chat stays untouched. Check: `GET http://127.0.0.1:1920/health` on the box before each switch-on, and the walk's real reading on staging (Tasks 6, 7 and 8).
3. **`main` has taken migration number 1777140000130 since the branch was cut.** Two migrations with one number: one never runs. Check: renumber in Task 5 before the gate, then `npm run check:migrations` and the migration ledger on staging.
4. **Show me for the voices rings nothing** when the card is not drawn (read aloud off), and the guide's end-to-end test then fails. Check: the `SHOW_ME` row switches read aloud on for itself (Task 1).
5. **A deploy while someone is reading.** The restart ends the in-memory reading sessions, so the reader must see the "AlfyAI is updating" note and resume, not a dead player. Plan 2 built this; check it once on staging during the walk (Task 7).

---

## Who runs what (the runbook's stages)

| Stage | Session | Tasks |
|---|---|---|
| 4. Plan 4's code parts | one fresh session, in a worktree cut from Plan 3's final tip (the commit with `Plan-3-Task: 14`) | 1, 2, 3, 4 |
| 5. Release | one fresh session | 5, 6 |
| 6. The UI walk | a fresh Opus 5.5 session | 7 |
| 7. Production | the release session again, after the walk reports green | 8 |

- **Finding a task's commit.** Each task's last commit carries `Plan-4-Task: <N>`. A session finds the work it builds on with `git log --all --format=%H -n 1 --grep='^Plan-4-Task: <N>$'`, or `'^Plan-3-Task: 14$'` for Plan 3.
- **Notes.** Each session writes its hand-over to `read-aloud-plan-4-handover.md` in the shared notes folder, and reads it before it starts.
- **No message is needed** to move from one stage to the next.

## File Structure

| File | Task | What changes |
|---|---|---|
| `src/lib/components/guide/guide-content.ts`, `guide-content.test.ts` | 1 | Two entries; the counts 8/7/5/4/5/4 |
| `src/lib/i18n/guide.ts` | 1 | Their words, English and Hungarian |
| `src/lib/components/guide/drawings/section-drawing-spots.ts`, `AskDrawing.svelte`, `KnowsYouDrawing.svelte`, `drawings.test.ts` | 1 | Spots `readAloud` and `voices` |
| `src/lib/components/drawings/DrawnReply.svelte` | 1 | The speaker after Copy, with its own spot |
| `src/lib/app-places.ts` | 1 | `settings.readAloud` in `SPOTLIGHT_IDS` |
| `src/lib/components/read-aloud/voices/ReadAloudSettingsCard.svelte`, its test | 1 | The Show me marker on the voice pickers |
| `tests/e2e/feature-guide.spec.ts` | 1 | A `SHOW_ME` row, with read aloud on |
| `src/lib/components/guide/AGENTS.md` | 1 | "thirty-three entries" |
| `deploy/speech-service/scripts/measure_rates.py`, `tests/test_measure_rates.py` | 2 | The speaking-rate measurement |
| `docs/adr/0070-read-aloud-runs-beside-the-model.md`, `docs/adr/README.md` | 3 | ADR-0070 |
| `deploy/README.md`, `README.md`, `AGENTS.md`, `deploy/apache-site.conf` | 3 | The docs and the template's two streaming routes |
| `src/lib/server/services/read-aloud/voices.ts`, `deploy/speech-service/README.md` | 4 | The measured rates (and Plan 3's knob ranges, if Task 15 has not run) |

---

### Task 1: The Feature Guide (stage 4)

**Files:** as in the File Structure, rows marked 1.

**Interfaces:**
- **The entries,** in `GUIDE_ENTRIES`:
  - `{ id: "listenToAReply", section: "ask", drawingSpot: "readAloud", action: { kind: "tryIt" }, added: "2026-11-17" }`, last in its section;
  - `{ id: "yourVoices", section: "knowsYou", drawingSpot: "voices", action: { kind: "showMe", place: "settings", spotlight: "settings.readAloud" }, added: "2026-11-17" }`, last in its section.
- **Their words** (`guide.entry.<id>.name`, `.line` and, for Try it, `.example`):

  | Key | English | Hungarian |
  |---|---|---|
  | `listenToAReply.name` | Listen to a reply | Hallgasd meg a választ |
  | `listenToAReply.line` | Press the speaker under a reply to hear it, and follow the words as they are read. | Nyomd meg a válasz alatti hangszórót, és kövesd a szavakat, ahogy elhangzanak. |
  | `listenToAReply.example` | Tell me a short story about a lighthouse keeper. | Mesélj egy rövid történetet egy világítótorony-őrről. |
  | `yourVoices.name` | Voices that read to you | Felolvasó hangok |
  | `yourVoices.line` | Choose a voice for each language and the speed it starts at, or make a voice of your own. | Válassz hangot minden nyelvhez és kezdősebességet, vagy készíts saját hangot. |
- **The drawings:**
  - `SECTION_DRAWING_SPOTS.ask` gains `"readAloud"`, and `.knowsYou` gains `"voices"`.
  - `DrawnReply` gains a `Volume2` icon right after `Copy` in its row of actions, as the real row has it (spec §4.1). It is marked by a new `spots.speaker`, inside the row's own `spots.actions`; a spot may sit inside another. `AskDrawing` passes `speaker: "readAloud"`.
  - `KnowsYouDrawing` gains a compact Read aloud card, wrapped in `DrawnSpot spot="voices"`: one stacked `DrawnSettingsRow label="readAloud.settings.englishVoice"` holding a `DrawnSelect`, and `DrawnButton word="readAloud.settings.newVoice" icon={Plus}`.
    - It fits the 330 × 222 frame with the Hungarian words at 360 px, at least 7 design pixels from the frame's edge.
    - If it does not fit, the button goes and the row stays.
  - `drawings.test.ts` lists the two new keys this drawing reads.
- **The marker:**
  - `ReadAloudSettingsCard` wraps its two voice pickers in one `div class="settings-row-group" data-testid="read-aloud-voice-rows" use:spotlightTarget={"settings.readAloud"}`, with a static class, as the Preferences card's "settings.style" group does.
  - `"settings.readAloud"` joins `SPOTLIGHT_IDS`.
- **The end-to-end row** in `SHOW_ME`: `{ entry: "yourVoices", name: "Voices that read to you", spotlight: "settings.readAloud", control: (page) => page.getByTestId("read-aloud-voice-rows"), readAloud: true }`.
  - `ShowMeRow` gains an optional `readAloud?: boolean`.
  - For such a row, the loop's test starts the fake speech service and switches the feature on before it presses the button (`startFakeSpeechForSpec`), and puts both back after (`stopFakeSpeechForSpec`).

- [ ] **Step 1: Write the failing tests.**
  - `guide-content.test.ts`: the counts become 8/7/5/4/5/4, and the two new entries carry the fields above.
  - `drawings.test.ts`: `the reply's row of actions draws the speaker after Copy`, and the KnowsYou drawing's keys include `readAloud.settings.englishVoice` and `readAloud.settings.newVoice`.
  - `ReadAloudSettingsCard.test.ts`: `marks its voice pickers for Show me`.
  - The guide's guard test (`SHOW_ME` against `GUIDE_ENTRIES` and `SPOTLIGHT_IDS`) fails until the row exists.
- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run src/lib/components/guide src/lib/components/read-aloud/voices`.
- [ ] **Step 3: Implement,** and change the guide `AGENTS.md`'s count to "thirty-three entries".
- [ ] **Step 4: Run them and see them pass.** Then build and run `E2E_PORT=4720 E2E_WORKERS=1 npx playwright test tests/e2e/feature-guide.spec.ts`: every row passes, the new one included.
- [ ] **Step 5: Commit.** `git commit -m "feat(guide): reading aloud and personal voices in the Feature Guide" -m "Plan-4-Task: 1"`

### Task 2: The speaking-rate script (stage 4)

**Files:**
- Create `deploy/speech-service/scripts/measure_rates.py` and `deploy/speech-service/tests/test_measure_rates.py`.
- Modify `deploy/speech-service/README.md`: under "Measured on the box", a "Speaking rates" line on how to run it. The numbers come in Task 4.

**Interfaces:**
- **The command:** `python -I scripts/measure_rates.py --out DIR [--service http://127.0.0.1:1920]`.
  - For each of the six voices it posts `POST /v1/preview` once per sentence: the voice's language's two samples (Plan 3's `VOICE_SAMPLES`, copied with a comment) and four plain sentences per language written in the script, 80–200 characters each, with no digit or symbol.
  - The request is `{"text", "language", "voice": {"speaker_id", "controls"}}`, with the voice's default controls (`room.clean: 2` for Berta and Imre).
  - It writes `DIR/rates.json` (per voice: the sentences' lengths, the clips' seconds and the rate), and prints a table and one `charsPerSecond: <rate>` line per voice for `voices.ts`, rounded to 0.1.
  - Exit status: 0 when it ran; 1 when the service did not answer or refused (a 4xx or 5xx); 2 for a bad argument.
- **`mp3_seconds(data: bytes) -> float`:**
  - it skips a leading ID3v2 tag;
  - it walks MPEG-1 Layer III frame headers at 44 100 Hz (`floor(144 × bitrate / 44100) + padding` bytes a frame, 1152 samples each);
  - it raises `ValueError` on anything else.
- **`rate(texts: list[str], seconds: list[float]) -> float`:** the sum of the texts' lengths over the sum of the seconds.
- **Imports:** only httpx and the standard library. It writes nothing but `rates.json`.

- [ ] **Step 1: Write the failing tests:**
  - `test_mp3_seconds_counts_frames_after_the_id3_tag`: build the frames in the test.
  - `test_rate_is_characters_over_seconds_across_sentences`.
  - `test_runs_on_a_fake_service_and_writes_only_the_report`: an `httpx.MockTransport` answers `/v1/preview` with silent frames sized by the text, and the `--out` folder then holds only `rates.json`.
  - `test_exits_1_when_the_service_refuses`.
- [ ] **Step 2: Run them and see them fail.** From `deploy/speech-service`, run `.venv/bin/python -m pytest -q tests/test_measure_rates.py`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the whole suite and see it pass.** Run `.venv/bin/python -m pytest -q`.
- [ ] **Step 5: Commit.** `git commit -m "feat(speech): a script that measures each voice's speaking rate" -m "Plan-4-Task: 2"`

### Task 3: ADR-0070, the docs and the Apache template (stage 4)

**Files:** as in the File Structure, rows marked 3.

**Content:**
- **`docs/adr/0070-read-aloud-runs-beside-the-model.md`,** "Accepted (2026-11-17)", in the shape of ADR-0069: Context, Decision, Options considered (a table), Consequences.
  - **The decision** (spec §6 and §10):
    - a speech service on the GPU box, beside Zonos and vLLM, on loopback only;
    - Zonos's decoder on the CPU, and FuseAlign's native aligner on the CPU, one alignment at a time;
    - AlfyAI's server is its only reader, with an in-memory replay;
    - one progressive MP3 per reading, with the timeline over server-sent events;
    - the preview is joined per sentence;
    - nothing is stored, and logs carry no text;
    - graceful degradation: without the aligner, sentence marks only; with the service down, calm notes and a chat untouched; and the switch;
    - addresses only from `config-store` (ADR-0068 unaffected).
  - **Options considered:**
    - word times estimated from letters (the owner rejected them after watching both);
    - FuseAlign in Python (3.7 GB resident);
    - audio per sentence (more requests, and a gap at every start);
    - Zonos's own timestamps (it has none).
  - **Consequences:**
    - vLLM decodes about 10% slower while a reading is made, accepted by the owner and documented in the speech service's README;
    - a 1.5 GB budget (695 MB measured);
    - the Apache streaming rules;
    - the knobs' ranges are re-measured on the box;
    - a second speech user would need a second reader design, because of the one-reader rule.
- **`docs/adr/README.md`:** its row.
- **`deploy/README.md`,** a new section, "Read aloud":
  - what runs where (the speech service, its README, the box);
  - the two keys and their live effect (the System pane, or `shared/.env`);
  - the Apache streaming routes and how to check them (an unauthenticated GET answers 401 with the two headers);
  - switching on and off;
  - the box scripts (live check, knob ranges, speaking rates);
  - a pointer to this plan's **Rollback**.
- **`README.md`:** the Read aloud bullet also names Settings → Read aloud, personal voices and the preview.
- **`AGENTS.md`,** "Mandatory Verification": a row "read aloud (the speaker, the player, Read from here, Settings and the voice editor): `tests/e2e/read-aloud.spec.ts tests/e2e/read-aloud-failures.spec.ts tests/e2e/read-aloud-voices.spec.ts`".
- **`deploy/apache-site.conf`:**
  - before the catch-all `ProxyPass /`, beside the other streaming routes: `ProxyPassMatch "^/api/read-aloud/sessions/([^/]+)/(audio|events)$" "http://127.0.0.1:3001/api/read-aloud/sessions/$1/$2" flushpackets=on`;
  - `read-aloud/sessions/[^/]+/(audio|events)` as one more alternative in the `LocationMatch`.

- [ ] **Step 1: Write the docs and the template's lines.**
- [ ] **Step 2: Check them.**
  - `npx vitest run scripts` passes; if a test reads `deploy/apache-site.conf`, it still passes.
  - On the Mac, `grep -c 'read-aloud/sessions' deploy/apache-site.conf` gives 2.
  - Every link in the new docs resolves (`ls` each path).
- [ ] **Step 3: Commit.** `git commit -m "docs(read-aloud): ADR-0070, the deploy notes and the Apache streaming routes" -m "Plan-4-Task: 3"`

### Task 4: The speaking rates (and the knob ranges), measured on the box (stage 4; approved tonight)

This task changes the box only by copying the speech service's folder, which adds two scripts and needs no restart. Each script runs for a few minutes, during which vLLM decodes about 10% slower (accepted). State each command before running it.

- [ ] **Step 1: Make sure the copy changes no service code.** `git diff --stat d625eb1d1 HEAD -- deploy/speech-service/speech_service` must be empty (`d625eb1d1` is Plan 1's tip). If it is not, stop and report: a change to the service's code needs its own review and restart.
- [ ] **Step 2: Copy the folder** (README, "Install or update", step 1, as `alfyws`):
  `rsync -a --exclude .venv --exclude tests --exclude __pycache__ --exclude .pytest_cache --exclude '*.egg-info' deploy/speech-service/ alfyws:/home/alfyws/opt/speech-service/`
- [ ] **Step 3: Check the service before measuring.** `ssh alfyws 'curl -s http://127.0.0.1:1920/health'` answers `{"ok":true,"zonos":true,"aligner":true}`.
- [ ] **Step 4: Measure the rates:**
  `ssh alfyws 'cd ~/opt/speech-service && ~/venvs/speech-service/bin/python -I -B scripts/measure_rates.py --service http://127.0.0.1:1920 --out /home/alfyws/opt/speech-service-rates'`
  Then copy `rates.json` into the shared notes folder with `scp alfyws:/home/alfyws/opt/speech-service-rates/rates.json …`, and remove the box folder with `ssh alfyws 'rm -rf /home/alfyws/opt/speech-service-rates'`.
- [ ] **Step 5: Run Plan 3's Task 15** if its trailer (`Plan-3-Task: 15`) is not on any branch yet, with its own steps (the same pattern, `scripts/measure_knobs.py`).
- [ ] **Step 6: Write the numbers in.**
  - Each voice's `charsPerSecond` in `src/lib/server/services/read-aloud/voices.ts`.
  - A "Speaking rates, 2026-11-17" row in the README's "Measured on the box".
  - Run `npx vitest run src/lib/server/services/read-aloud src/routes/api/read-aloud`.
- [ ] **Step 7: Commit.** `git commit -m "feat(read-aloud): each voice's speaking rate, as measured on the box" -m "Plan-4-Task: 4"`

### Task 5: Merge Plans 1–4 into `main`, then the release gate (stage 5)

- [ ] **Step 1: Check what is live, and where everything stands.**
  - `git fetch origin`.
  - `git rev-parse origin/main origin/dev`.
  - `git rev-list --count origin/main..origin/dev` and `git rev-list --count origin/dev..origin/main`.
  - Read-only on the box: `ssh -T alfyroot 'readlink /home/alfydesign/apps/langflow-chat/current; readlink /home/alfydesign/apps/langflow-chat-dev/current'`.

  Write all of it into the hand-over note. Other agents deploy too: what is live may be newer than `origin/main`.
- [ ] **Step 2: Merge in a scratch worktree on `origin/main`.**
  - Run `git merge --no-ff -m "Merge read aloud (Plans 1–4)" <Plan 4's final tip, the commit with Plan-4-Task: 4>`.
  - Resolve conflicts by keeping both sides' intent. Likely places: `drizzle/meta/_journal.json`, `README.md`, `AGENTS.md`, `package.json` and its lock (`tinyld` 1.3.4 and `entities` 6.0.1 are exact), and the i18n index.
  - **The migration number:** if `origin/main` has a migration numbered 1777140000130 or later, renumber ours to the next free number: the file name, and its journal entry's `idx`, `when` and `tag`. Then run `npm run check:migrations`.
- [ ] **Step 3: Install and check:**
  - `npm ci`, with the Node 22 `PATH`;
  - `npm run check`: 0 errors and 0 warnings.
- [ ] **Step 4: Run the release gate** on that exact commit, in the background: `scripts/gates.sh release <a literal folder in your scratchpad> --port 4600`.
  - Every step must be green.
  - If an e2e failure appears, run that spec alone on `origin/main`. If it fails there the same way, it is pre-existing (Decision 7): record it with its evidence. Otherwise fix it test first, commit, and gate again.
- [ ] **Step 5: Record** the merge SHA and the gate's screen in the hand-over note.

### Task 6: Staging, with read aloud on (stage 5)

- [ ] **Step 1: Check the speech service on the box.** `ssh alfyws 'curl -s http://127.0.0.1:1920/health'` answers ok.
- [ ] **Step 2: Add the Apache rules to ai.dev's vhost only.** Follow the safe-edit recipe in the project memory note `alfyroot-apache-alfyai-vhosts`:
  1. `cp /etc/httpd/conf/httpd.conf /etc/httpd/conf/httpd.conf.bak-20261117-read-aloud`.
  2. A perl script writes `httpd.conf.new`. It adds the `ProxyPassMatch` line (port **3002**) before ai.dev's catch-all `ProxyPass /`, and the alternative in ai.dev's `LocationMatch`. It dies unless each anchor matches exactly once in ai.dev's block.
  3. `httpd -t -f /etc/httpd/conf/httpd.conf.new`, then `diff` it against the live file: only those two lines may differ.
  4. `mv` it into place, run `apachectl configtest`, then `systemctl reload httpd`.
  5. Check both sites' health URLs and one other vhost on the box.
- [ ] **Step 3: Set staging's keys.** In `/home/alfydesign/apps/langflow-chat-dev/shared/.env`, as `alfydesign`, after a copy to `.env.bak-20261117-read-aloud`:
  - set `TTS_URL=http://127.0.0.1:1920` and `TTS_ENABLED=true`;
  - never print the file;
  - check with `grep -c '^TTS_' …` (2).
- [ ] **Step 4: Push and deploy.**
  - **If `origin/dev` is an ancestor of the merge** (Decision 6): `git push origin <full merge sha>:refs/heads/dev`, read it back with `git ls-remote origin dev`, then deploy:
    `ssh -T -o ConnectTimeout=8 -o BatchMode=yes alfyroot 'sudo -u alfydesign -H bash -c "cd /home/alfydesign/apps/langflow-chat-dev && APP_DIR=/home/alfydesign/apps/langflow-chat-dev ./current/scripts/deploy-dev.sh"'`
  - **Otherwise** push `<full merge sha>:refs/heads/read-aloud-preview`, and run the same command with `DEPLOY_BRANCH=read-aloud-preview` before `./current/scripts/deploy-dev.sh`.

  Run it in the background and read `rc=`.
- [ ] **Step 5: Check staging:**
  - `rc=0`;
  - `readlink current` is `releases/<merge sha>`;
  - `systemctl is-active langflow-chat-dev`;
  - `curl -s http://127.0.0.1:3002/api/health` says `draining:false`, and the login page answers 200;
  - the migration: `sqlite3 -readonly …/shared/data/chat.db ".schema read_aloud_voices"` and `pragma table_info(users)` (staging's database is disposable);
  - the streaming rule: `curl -sI https://ai.dev.alfydesign.com/api/read-aloud/sessions/x/audio` and `…/events` answer 401 with `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`;
  - `curl -s -X POST https://ai.dev.alfydesign.com/api/read-aloud/preview` answers 401;
  - `journalctl -u langflow-chat-dev --since "-10 min"`: no error lines.
- [ ] **Step 6: Write the hand-over,** with each check's result, and say the walk can start.

### Task 7: The UI walk (stage 6)

A fresh Opus 5.5 session walks read aloud the way a person would, compares it with the approved prototypes and with the rest of AlfyAI, fixes what it finds, and walks again.

- [ ] **Step 1: Build the local stack** (the speech service's README, "Running it on the Mac", steps 1–3):
  - Zonos MLX on `:1921`, and the speech service on `:1920` with `SPEECH_ALIGNER=python`;
  - the production build of the merge on `localhost:4700`, with a scratch database:
    - `DATABASE_PATH=<scratch>/walk.db npm run db:prepare`;
    - then `npx tsx scripts/seed-admin.ts --email=walk@example.com --password=<generated, kept out of the transcript> --admin`;
    - then `node build`, with `TTS_ENABLED=true` and `TTS_URL=http://127.0.0.1:1920`;
  - made-up replies seeded the way `tests/e2e/read-aloud-helpers.ts`'s `seedReadAloudChat` does: English, Hungarian, a Hungarian reply holding an English email, code, lists, links and a German paragraph.
- [ ] **Step 2: Walk it** at 1280 px and at 375 px, in both themes, with the UI in English and in Hungarian, with Chromium and with WebKit (for Safari):
  - **The speaker:** its states; the ring; dimmed for German, with its note.
  - **The marks:** the sentence tint, the word that glides and jumps lines, the code marks.
  - **The player:**
    - it rises and the thread makes room;
    - scrubber drags (the bubble, the outline, the notch, the damped follow);
    - the speed menu; ⌖; hidden while the command tray is open, then shown again;
    - ✕; the end and "Finished";
    - another reply's speaker.
  - **Read from here:** above the selection on desktop, below it on a phone.
  - **Mixed languages:** the voices switch per paragraph.
  - **The failures:**
    - stop the speech service → can't start;
    - stop it mid-reading → stopped, and Try again;
    - offline, through devtools;
    - two readings at once → busy.
  - **Reduced motion.**
  - **Settings → Read aloud:** the pickers and the Default speed.
  - **The editor:**
    - base cards and their ▶;
    - styles and the sliders' words;
    - Listen, with the inline player; Yours / Original; own words;
    - save, edit, Save as new, delete;
    - the phone sheet.

  For each finding: a screenshot in the scratchpad, what differs from the prototype or from the rest of AlfyAI, and how bad it is.
- [ ] **Step 3: Fix the findings,** test first, on a branch from the merge. Run the agent gate with the read-aloud specs: `scripts/gates.sh agent <out> --port 4610 tests/e2e/read-aloud.spec.ts tests/e2e/read-aloud-failures.spec.ts tests/e2e/read-aloud-voices.spec.ts tests/e2e/feature-guide.spec.ts`. Then hand the new SHA to Task 6's Steps 4–5, to redeploy staging.
- [ ] **Step 4: Walk staging.** Use real model replies, written by the staging harness account. Sign in with a script whose credentials come from `/root/verify-harness.env` into its environment, never into the transcript or a file in the repo. Delete any copy afterwards.
  - Read a real English reply and a real Hungarian reply.
  - Deploy staging again during a reading, and check the "AlfyAI is updating" note and the resume (Review Focus 5).
  - Make, play, choose and delete one personal voice.
- [ ] **Step 5: Report** in the hand-over note:
  - each finding and its fix, with screenshots;
  - what was walked twice;
  - the verdict, which is **green** only when nothing is left but cosmetic Minors the walk lists for the morning.

### Task 8: Production (stage 7; only when Tasks 6 and 7 are green)

- [ ] **Step 1: Check what is live again,** as in Task 5's Step 1. If production has moved since, stop and report: another deploy happened, and the merge must take it in first.
- [ ] **Step 2: Push `main`.**
  - Check `git merge-base --is-ancestor origin/main <full sha>`.
  - Then `git push origin <full sha>:refs/heads/main`, and read it back with `git ls-remote origin main`.
  - If staging ran from `read-aloud-preview`, also push the SHA to `dev` once `origin/dev` is an ancestor, or leave `dev` and say so.
- [ ] **Step 3: Add the Apache rules to production's vhost:** Task 6's Step 2, for the `ai.alfydesign.com` block, port **3001**, with backup `httpd.conf.bak-20261117-read-aloud-prod`.
- [ ] **Step 4: Set production's keys.** Production's `shared/` is root-owned, so:
  - copy `.env` to `shared/backups/env-pre-read-aloud-20261117.bak`;
  - write the new content to a temporary file outside `shared/`, then `cat` it over `.env` in place;
  - set `TTS_URL=http://127.0.0.1:1920` and `TTS_ENABLED=true`, and never print the file.
- [ ] **Step 5: Fast-forward production's app-root checkout:**
  `ssh -T alfyroot 'sudo -u alfydesign -H bash -c "cd /home/alfydesign/apps/langflow-chat && git fetch origin main && git merge --ff-only origin/main"'`
- [ ] **Step 6: Deploy** in the background, and read `rc=`:
  `ssh -T alfyroot 'sudo -u alfydesign -H bash -c "cd /home/alfydesign/apps/langflow-chat && ./scripts/deploy.sh"'`
- [ ] **Step 7: Smoke-check production,** with no user data:
  - `rc=0`, the "Drained" line and the backup line;
  - `readlink current` is `releases/<sha>`;
  - `systemctl is-active langflow-chat`;
  - `curl -s http://127.0.0.1:3001/api/health` says `draining:false`;
  - the public health answers, and the login page answers 200;
  - the migration ledger: `sqlite3 -readonly …/shared/data/chat.db "select count(*) from __drizzle_migrations where created_at >= 1777140000130"` (or the renumbered value) is at least 1, and `.schema read_aloud_voices` exists. That is the schema only, no rows;
  - the streaming headers on `…/audio` and `…/events`, through `https://ai.alfydesign.com`, as in Task 6;
  - the preview route answers 401;
  - the speech service's health;
  - `journalctl -u langflow-chat --since "-15 min"`: no error lines.

  Any check that fails → **Rollback**, from its first step that fits.
- [ ] **Step 8: Record.**
  - Add the deploy to the project memory note `alfyai-deployed-code-is-origin-main`: the SHA, both sites, the backups, the checks.
  - Write the owner's morning review list into the hand-over: Plan 3's and Plan 4's decisions, the walk's cosmetic Minors, Plan 2's open minors (R14–R23), and the slider words to hear.
  - If staging ran from `read-aloud-preview`, delete it on origin.

## Rollback

From the smallest step to the largest. State each command before running it.

1. **Read aloud misbehaves, and the rest of the app is fine: switch it off.**
   - **The quickest way:** Settings → Administration → System, read aloud off. It is a live admin override with no restart, so the owner or anyone with an admin session can do it.
   - **Without a session:**
     1. Set `TTS_ENABLED=false` in the site's `shared/.env`, the same way as it was set.
     2. Drain the site: `/api/admin/drain`, with its key read from `shared/.env` inside the command and never printed.
     3. Restart: `systemctl restart langflow-chat`, or `langflow-chat-dev`.

   No speaker and no Read aloud card remain; nothing else changes (spec §4.8).
2. **Readings stall or start late behind Apache: undo the rules.**
   1. Copy back the backup made before the change (`httpd.conf.bak-20261117-read-aloud…`).
   2. Run `apachectl configtest`, then `systemctl reload httpd`.
   3. Check both sites' health and one other vhost.
3. **The release is bad beyond read aloud: roll back the code.**
   1. Point `current` back at the previous release: `ln -sfn releases/<previous sha> current`, then `mv -Tf`, then restart the service (`deploy/README.md`, "Rollback"). The deploy log has the previous SHA, and the last three releases are kept.
   2. Leave the database: the migration only added a table and three columns, which the previous release ignores (Decision 10).
   3. Leave `origin/main`, write the mismatch into the deploy record, and fix forward.
4. **The speech service hurts the box** (vLLM, memory): stop it.
   1. `ssh alfyroot 'systemctl stop speech-service'`. Readings then fail calmly with "Couldn't start reading".
   2. Do step 1 too, so nobody meets a speaker that cannot start.
   3. Plan 1's full rollback (its README, "Rollback") only if the owner asks.
5. **Restoring a database backup** loses every write since the deploy. It is the owner's call, never an agent's (Decision 10).

On staging, every failure is cheap: fix it, deploy again, walk again (its database is disposable).

## Hand-over (the end of the run)

The production session's last message to the orchestrating session carries:
- the SHA on both sites, or where the run stopped and why;
- each check's result;
- the walk's verdict;
- where the morning review list is.

The orchestrating session then moves the runbook to stage 8. The campaign draft is the campaign session's.
