# Feature 1 · Workspaces — implementation spec

The owner signed off on everything below on 2026-09-24, working through each decision in a goals interview
([ADR-0064](../adr/0064-claude-at-home-means-workspaces-documents-and-richer-inputs.md), item 1).
The glossary terms come from `CONTEXT.md`: **Personal Instructions**, **Folder Instructions**,
**Folder Knowledge**, **Project Folder**.

**UI copy uses "project"** (the sidebar already reads "Projects" / "Projektek"). The domain term is
Project Folder.

**Mockups:** [`claude-at-home-1-workspaces-mockups.html`](./claude-at-home-1-workspaces-mockups.html).
Open it in a browser. It uses AlfyAI's own tokens, and its numbered sections are referenced below as §M1–§M9.
Match its layout, copy and hierarchy. The reference screens for fidelity are the real home page, the
Settings → Assistant behaviour card, the Knowledge → Documents table and the logout ConfirmDialog.

This feature also carries three owner requests from the same session:
- **Slice A:** remove "Manage context sources".
- **Slice B:** the Parallel free allowance.
- **Slice G:** remove the home suggestion chips.

The slices are independent unless noted otherwise. Each slice lands as its own small commit series.

## Decisions (do not reopen)

1. **Precedence, from highest to lowest:**
   1. the current message
   2. Project (Folder) Instructions
   3. Personal Instructions
   4. Memory
   5. Style

   Instructions are user-typed, so they outrank both learned memory and the chosen Style preset.
2. **Instructions apply on every turn, including the "shallow" path.**
   - Short messages with no attachment currently skip all folder context (`context-selection.ts:1143-1170`).
   - Instructions therefore live in the **system message**, not in the packet.
   - They are stable per user and per project, so they do not break the prefix-cache contract
     (`normal-chat-context.ts:96-100`). The system message and tool schemas stay byte-identical until
     the user edits their instructions.
3. **Instructions apply in incognito chats. AI suggestions are never offered there.** `/instruction`
   still works in incognito because it is explicit and the user sees the modal before anything is saved.
4. **Folder Knowledge** (Q4 = b):
   - Every chat in the project knows the project's files **exist**: names plus a one-line summary, on every
     turn, shallow path included.
   - It **reads content only when the turn needs it**, either through relevance or because the user named
     the file.
   - The files are ordinary Library Documents. Linking one to a project never copies it. Unlinking keeps
     it in the library.
5. **One editing surface.** Every way of changing instructions opens the **same modal**:
   - Settings
   - the project page
   - `/instruction`
   - an AI suggestion's "Review"

   Nothing is saved without the user seeing the full text.
6. **The folder token.** A project is always shown as a token (folder icon + name), never in running text,
   so "Home project" can never produce "Home project project instructions". The personal scope is shown
   as the token "[user icon] You".
7. **Length limit:** 2,000 characters each for Personal and Project Instructions. The server rejects
   anything longer with a 400. **Do not silently truncate** (skills do today; don't copy that).
8. **Lifecycle:**
   - Deleting a project deletes its instructions and its knowledge links, but not the library files.
   - Moving a chat into or out of a project switches which instructions apply from the next turn onward.
9. `/remember` is **unchanged**. `/instruction` is a new command. The token is English in both locales
   (like `/remember`); its labels are localized (HU label: "Utasítás").

---

## Slice A — Remove "Manage context sources" (owner: "removed from everywhere")

The owner has never opened it. It is the context-ring popover button → `EvidenceManager` side panel,
which offers per-source Auto/Pinned/Excluded steering. The full removal map was produced by an inventory
agent on 2026-09-24. Its essentials follow.

**Delete:**
- `src/lib/components/chat/EvidenceManager.svelte` (+ test) and `EvidencePreferenceControl.svelte`
- `src/routes/api/conversations/[id]/task-steering/+server.ts`
- `applyTaskSteering` and `TaskSteeringResponse` in `src/lib/client/api/conversations.ts`
- In `task-state.ts`: `applyTaskSteeringAction` and `upsertEvidenceRole`
- The `TaskSteeringAction`, `TaskSteeringPayload` and `EvidencePreference` types
- i18n `contextSources.*` and `contextUsageRing.manageEvidence`, EN and HU
- The dead `onSteer` prop chain: ChatMessagePane → MessageArea → MessageBubble
- **The Context Sources projection.** The stream path computes it and discards it, and nothing reads it.
  Delete:
  - `chat-turn/context-sources.ts` (+ test)
  - the `ContextSource*` types
  - `buildChatTurnCompletionContextSources` and `contextSources` in `finalize.ts`
  - `ConversationDetail.contextSources`, plus the read-model fetches that exist only to feed it
  - the client stream parse in `streaming.ts`, `normal-chat-client-turn-runtime.ts` and the chat page
  - `contextSources` in the `/api/chat/send` response
- **Existing user pins and exclusions.** Add a migration that deletes the `task_state_evidence_links` rows
  where `role IN ('pinned','excluded') AND origin='user'`. Once they are gone, remove the read side
  (`task-state.ts` selection, `evidence-family.ts`), which no longer has anything to read.

**Edit:**
- The chat page, ChatComposerPanel and MessageInput: remove the `onManageEvidence` / `evidenceManagerOpen`
  wiring.
- ContextUsageRing:
  - Remove the button and the Pinned/Excluded/"Source state" rows.
  - **Keep the compaction indicator.** The owner wants it. It already reads
    `contextStatus.compactionMode`, so drop only the `contextSources?.compacted` fallback.
- Tests: update every test that referenced the removed pieces (the inventory lists them). Do not keep tests
  that only assert the old panel.
- Docs:
  - Fix the claim that pinning "lives in Knowledge/workspace": CONTEXT.md around the "evidence manager"
    entries, and ADR-0043 lines 9 and 49.
  - Add a one-line "superseded" note to ADR-0004 and ADR-0006. Do not rewrite them.
  - Remove the "Context Sources projection" mentions from AGENTS.md (conversation-detail bullet),
    `chat-turn/AGENTS.md` and `routes/AGENTS.md`.

**Keep (shared, used by `/document` and `/source`, and reused by Slice E):** `linked-context-sources.ts`, `artifact_links` rows with
`linkType:"linked_context_source"`, `LinkedDocumentPicker.svelte`, `LinkedSourceManager.svelte`, the
`linkedSources.*` i18n keys, `getContextDebugState` and `contextDebug`, and `contextStatus`.

---

## Slice B — Parallel free monthly allowance

**Rule.**
- Parallel gives one free allowance per calendar month, and it is **shared by the whole server**.
- While the server's Parallel spend for the month (`calls × $0.001` list price) is at or below the
  allowance, every Parallel call is booked at **$0** for the user who made it.
- Calls after that point are booked at the normal price. The call that crosses the line is booked only for
  its part above the allowance.
- This covers `research_web`, `fetch_url` and Atlas; all of them go through `recordParallelUsage`
  (`analytics.ts:2345`, `atlas-v3/worker-bindings.ts:197`).

**Where.**
- **Config:** `PARALLEL_FREE_MONTHLY_USD`, default `5`, non-secret and admin-overridable.
  - Wire it through `env.ts` → `config-store.ts` → the admin "Integrations & keys → Web research" row
    (§M9), placed directly under the Parallel API Key row.
  - Document it in README.md and `.env.example` (AGENTS.md config checklist).
- **Booking:** `recordParallelUsage` computes the billed micros at record time, inside one write
  transaction:
  1. month-to-date list cost = count of `parallel:*` rows in `billing_month` × 1000 micros
  2. billed = `max(0, listAfter − allowance) − max(0, listBefore − allowance)`, clamped to `[0, 1000]`
  3. store billed in `cost_usd_micros`

  The list cost can always be derived from the call count, so **no new column is needed**. Every existing
  total (context ring, personal analytics, admin totals) sums `cost_usd_micros`, so users see $0 until the
  allowance is used up, with no read-side changes.
- **Retroactive (owner: yes):**
  - Add a one-time idempotent script `scripts/recompute-parallel-billing.ts`, with `--apply` and a dry
    run, that replays every month in `created_at` order with the current allowance.
  - Add the same recompute for the **current month only** whenever an admin changes the allowance.
  - No past month has come close to $5, so all historical Parallel cost becomes $0.
- **Admin analytics (§M9):** the System analytics "Parallel API" tab gains:
  - an allowance meter: "$X of $Y free allowance used · resets 1 <Month> · users are charged $Z"
  - a "Counted as cost" tile
  - a by-month table showing calls, free usage and counted cost
- **No user-facing UI change.**

**Tests:**
- below, crossing and above the allowance
- allowance set to 0 (behaves like today)
- concurrent calls at the boundary (the transaction keeps the total exact)
- dry-run versus apply for the recompute
- recompute triggered by a config change

---

## Slice C — Personal Instructions

**Data.**
- `users.personal_instructions TEXT NULL`, with a migration and a `_journal.json` entry; run
  `npm run check:migrations`.
- API: `PATCH /api/settings/preferences` accepts `personalInstructions` (string, ≤2000 after trim; empty
  means clear) and returns it in `GET /api/settings`.
- Browser calls go in `src/lib/client/api/settings.ts`.

**UI.**
- **Settings → Profile → Assistant behaviour** (`SettingsProfileTab.svelte`) gets a new **first row**
  (§M7):
  - title "Personal instructions"
  - description "Followed in every chat. Project instructions take priority inside a project."
  - a one-line preview box when set
  - an **Edit** button when set, or **Add instructions** when not
- The button opens `InstructionsDialog` (below) with scope = Personal and **no scope switch**.

**Shared component `src/lib/components/instructions/InstructionsDialog.svelte`** (§M2, §M3):
- Built on `DialogShell`, the same frame as ConfirmDialog/logout, widened to about 560px.
- Title "Instructions" plus the scope token. A description line.
- Optional segmented scope switch (Personal | project token), shown only when the caller passes both
  scopes.
- A large textarea (about 8 rows, grows to fit).
- An optional highlighted appended line: the `/instruction` argument or the suggestion text.
- A live `n / 2000` counter; Cancel (`btn-secondary`) and Save (`btn-primary`).
- On mobile it becomes DialogShell's sheet.
- Use Svelte 5 runes and callback props. Every string exists in EN and HU.

**Prompt.**
- `normal-chat-context.ts` adds `## Your Instructions` to the system message, **after** Response Style.
  Section order then ends: … Runtime Guidance, Response Style, Your Instructions, Project Instructions
  (Slice D).
- Add one precedence sentence:
  > "Follow Project Instructions over Your Instructions, and both over the Response Style and any
  > remembered preference; the user's current message overrides all of them."
- **Reword the Response Style framing** (`normal-chat-context.ts:515`, currently a "hard rule") so it
  yields to instructions.
- Extend the prefix-stability tests (`normal-chat-context.test.ts:626-672`) so that identical instructions
  give an identical prefix and an edit changes it.

**Info popover.**
- Persist `instructionsApplied: { personal: boolean; projectId?: string }` in the assistant-message
  metadata. It is owned by `messages.ts`.
- `ResponseAuditDetails` / the Info popover shows an "Instructions" row with the tokens (§M8), **only
  when at least one set applied**.

---

## Slice D — Project Instructions and the project page (needs C's dialog)

**Data.**
- `projects.instructions TEXT NULL`, with a migration.
- `PATCH /api/projects/[id]` accepts `instructions` (≤2000).
- `GET /api/projects` and the layout preload include `hasInstructions`, plus the full text where the page
  needs it.
- `projects.ts` owns persistence. Deleting a project clears its instructions (Decision 8).

**Project page = the home page in project mode (§M1).**
- Route: `/projects/[projectId]`. It renders the landing page (`src/routes/(app)/+page.svelte`'s content,
  moved into a shared component) in project mode:
  - greeting → project name, same serif and colour
  - stats line → "N chats · active <relative>"
  - composer placeholder "Start a chat in <name>…". The first send creates the conversation **in this
    project** (the prepared-conversation flow gains `projectId`, owned by `conversation-session.ts`).
  - one quiet line under the composer: "✎ Instructions · 📎 N files". Empty state: "Add instructions · Add
    files".
    - Instructions → `InstructionsDialog` (scope = this project, no switch).
    - Files → the Files modal (Slice E).
  - the recent list → this project's chats: "N chats in this project". Empty state: "No chats yet. The
    first message you send here starts one."
- Keep one page component and one prepared-conversation flow. **Do not fork the landing logic.**

**Entry points.**
- `ProjectItem.svelte`: the existing inline hover button (today "create chat in project") now **navigates
  to the project page**, with aria-label "Open <name>".
- The menu's "New chat" also goes to the project page, with the composer focused.
- Clicking the project name still only expands or collapses it (unchanged).
- The chat header breadcrumb ("Vienna trip / …") makes the project segment a link to the project page.
- The home projects row (Slice G).

**Prompt.**
- `## Project Instructions` goes in the system message after Your Instructions, whenever the conversation
  has a `projectId` and the project has instructions. It applies on every path, including shallow turns
  and incognito.
- The Info popover's `projectId` is set when this block applied.

---

## Slice E — Folder Knowledge (needs D)

**Data.**
- New table `project_knowledge_links`: `id`, `user_id`, `project_id` FK → projects ON DELETE CASCADE,
  `artifact_id` FK → artifacts ON DELETE CASCADE, `created_at`; unique on (`project_id`, `artifact_id`).
- It needs a migration.
- This is deliberately **not** an `artifact_links` row, because that table is conversation- and
  message-scoped.
- Ownership is checked on every write: the project and the artifact must both belong to the user.

**API** (thin routes; the logic lives in the knowledge boundary, e.g. `knowledge/project-knowledge.ts`
exposed through `knowledge.ts`):
- `GET /api/projects/[id]/knowledge`: list files with name, type, size and added date.
- `POST /api/projects/[id]/knowledge` `{ artifactIds }`: link existing library documents.
- `DELETE /api/projects/[id]/knowledge/[artifactId]`: unlink only.
- Upload: `POST /api/knowledge/upload` accepts an optional `projectId`. Knowledge Upload Intake validates
  ownership, stores the file as a normal Library Document, then links it.

**UI (§M5).**
- The **Files modal** reuses the Knowledge → Documents table look:
  - search, "Add from library", Upload
  - columns: Name, Type pill, Size, Added
  - row actions: preview (opens the Document Workspace) and **unlink**
  - footer "N files · removing one here keeps it in your library"
- **Add from library** is the same frame with a checkbox list. Already-linked documents are greyed out and
  marked "already added"; the confirm button reads "Add N documents".
- The Knowledge → Documents table shows a small folder token on linked documents.

**Prompt.**
- A protected packet section, `## Project Files`: name plus a one-line summary for each linked document,
  capped (for example 30 entries or about 1,500 characters, with "+N more").
- It is included on **every** path, shallow turns included, whenever the chat has a project with
  knowledge.
- Content enters only when needed:
  - library retrieval gives the project's linked documents a scope boost for chats in that project
  - `read_generated_file` resolves project files by name
  - naming a file in the message resolves it the way `/document`-linked sources resolve today (reuse the
    `linked-context-sources` resolution helpers; do not build a second resolver)
- Incognito chats in a project still see the project's files. The incognito rules stay as they are: what
  an incognito chat creates stays hidden from other chats.

**Info popover and Sources (§M8, owner chose option A).**
- Persist `projectFilesRead: number` in the message metadata.
- The Info row "Project files" shows "N read · see Sources ↓". **File names are never listed in Info.**
  Clicking the row closes Info and expands the message's Sources panel (`MessageEvidenceDetails.svelte`).
- In Sources, evidence rows for project files carry the project folder token.

---

## Slice F — `/instruction` command and AI suggestions (needs C, D)

**Command.**
- Register `/instruction <text>` in `src/lib/composer-commands.ts`, with labels and descriptions in EN and
  HU.
- It opens `InstructionsDialog` with the current text of the default scope, `<text>` appended as a
  highlighted new line, and the scope switch.
- **Default scope:**
  - In a project chat: the project, with a switch to Personal.
  - Outside a project: Personal, with no switch.
  - Switching moves the pending line to the other scope's text.
- It works in incognito.

**Suggestions.**
- A model-facing tool, `suggest_instruction({ text, scope })` in `normal-chat-tools/`. Its usage guidance
  lives in the tool interface (ADR-0055). Offer it **only** when the user explicitly states a standing
  preference ("from now on", "always", "never", or the Hungarian equivalents).
- The server enforces:
  - not registered at all in incognito
  - at most one suggestion per turn
  - scope defaults to the chat's project when there is one
- Persist it in the assistant-message metadata as `instructionSuggestions`, following the `skillDrafts`
  precedent (`messages.ts:273,794+`), with status `pending | reviewed | dismissed`.
- UI (§M4): a slim row under the reply:
  - "Add to instructions for [token] · “<text>”"
  - **Review** opens `InstructionsDialog` prefilled, with the suggestion appended and highlighted, as with
    `/instruction`. Saving marks the suggestion reviewed.
  - **Dismiss** marks it dismissed.
  - After a refresh the row keeps the state it was left in.

---

## Slice G — Home: remove chips, add the projects row

- **Remove the conversation suggestion chips completely** (owner: "backend included"):
  - `HomeSuggestionRail.svelte`
  - `src/lib/server/services/home-suggestions*`
  - the suggestion-rail event log and its pruning
  - the `suggestions` field of `/api/home/summary` and `home-summary.ts`
  - their i18n keys and tests

  Check whether any table exists only for the rail's event log. If so, drop it with a migration.
- **Add `HomeProjects.svelte` (§M6)** between the composer and the recent list:
  - heading rule "Projects"
  - up to **3** cards for the most recently active projects (by latest chat activity), each with:
    - folder icon and name
    - "N chats · <relative>"
    - an indicator line for instructions and file count
  - clicking a card opens the project page
  - **hidden entirely when the user has no projects**
  - on phones, the cards are 150px wide and the row scrolls sideways
- Data comes from the home summary read model. Do not add a new endpoint.

---

## Account data and erasure (applies to C, D, E and F)

- **Data archive** (ADR-0032, human-readable). It must include:
  - Personal Instructions
  - each project's Instructions
  - the list of files linked to each project, by name

  Suggestion rows are message metadata and already travel with messages.
- **Account erasure** (ADR-0029/0030). The new columns and `project_knowledge_links` rows are deleted
  along with the user's other data. Add them to the erasure tests' "nothing left behind" assertions.
- **"Clear workspace data"** removes projects, and with them their instructions and knowledge links.
  **"Clear memory and knowledge"** leaves Personal Instructions alone, because they are not memory.
  Say so in that action's description copy.

## i18n (EN + HU; every key in both)

New keys cover:
- the dialog (title, the two descriptions, counter, Save/Cancel)
- the scope labels "You"/"Te" and "Personal"/"Személyes"
- the Settings row
- the project page (placeholder, stats, the instructions/files line, empty states, list heading)
- the Files and Add-from-library modals
- the project token aria-labels
- the Info rows
- the suggestion row
- the `/instruction` command
- the home projects row
- the Parallel allowance setting, meter and table

Hungarian copy must read naturally, not as a literal translation. Removed features (Slices A and G) take
their keys with them.

## Verification (per AGENTS.md)

- `npm run check` (0 errors / 0 warnings), `npm test`, `npm run build` (0 warnings), and lint
  `src scripts tests`. The full `npm run lint` breaks on nested worktrees.
- `npx fallow --no-cache --format json --quiet --score` with no new findings.
- `npm run check:migrations` after every schema change.
- Playwright:
  - `tests/e2e/chat.spec.ts`, `conversation.spec.ts`, `settings-admin.spec.ts`, `home-*.spec.ts`
  - new specs for the project page, the instructions dialog (all four entry points), the files modal
    (link, unlink, upload) and the `/instruction` command
- Real-app visual check at 1440×900 and 390×844, light and dark, against the mockup file.

## Suggested order

A and B first (independent, small, removal and accounting), then C → D → E → F, with G after D.
Each slice ships as small commits. Do not push until the owner asks.
