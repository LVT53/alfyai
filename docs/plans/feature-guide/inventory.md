# AlfyAI feature inventory and a proposed grouping

Date: 2026-11-05. Status: a draft for the owner to react to. Nothing is built.

Why this exists: the owner wants an optional feature guide, a page opened from a "?" beside the version badge, and asked to see how the features group before committing to it. Two read-only agents went through `dev` at `49a270730` (Ask me first had just been merged in): one through the chat, one through everything around it. Admin-only features are left out on purpose; the owner is the only admin and the guide will not cover them.

Marks used below:

- **Door** is how a person gets to a feature: *button* (something to click), *words* (only by asking Alfy in a message), *both*, or *Alfy* (Alfy decides; the person meets it).
- *(minor)* is a small convenience that belongs in a line, not a card.
- **Checked** means I confirmed it in the code myself. Everything else is the agents' report.

## 1. The proposed grouping

Six sections and 30 entries, plus a shortcuts box at the end. Section names are working names; Hungarian names come later.

### 1. Ask

Ask anything, in English or Hungarian. Alfy decides when to search, calculate or look something up.

| Entry | What it covers | Door |
|---|---|---|
| Ask anything | Model and style per chat; Thinking on or off (`/think`, `/quick`, `/thorough`); "Answer now" cuts the thinking short; Info under a reply (model, time, tokens, cost); Python for sums and conversions; pictures from the web | both |
| Web and links | Searches the web by itself when it needs fresh facts (`/web` forces it); reads a link you paste; Sources shows what it used, what it also found and what it set aside | words |
| Show it a picture or a file | Paperclip, "+" menu, `/attach`, drag onto the page, paste a screenshot, phone camera and photo library; pictures are numbered; Mark draws lettered boxes to say where | button |
| Maps and travel | Places, distances, routes and travel times by car, foot, bike or public transport, drawn on a map | words |
| Atlas research | "+" menu, Atlas report: Overview, In-Depth or Exhaustive (about 2-5, 10-20, 30+ minutes); a bell notifies you when it is done; Report, Evidence and Plan tabs; download PDF, HTML or Markdown; Revise, Continue, Fork | button |
| Steer a reply | Edit your message, Regenerate, Fork from here, send a follow-up while it is still answering, follow-up chips, Open as document | button |
| Alfy asks first | When a request could go two ways, Alfy stops with 1-3 questions and answers to click (Recommended, Other, Decide for me), then carries on in the same reply; the sidebar marks a chat that is waiting for you | Alfy |

### 2. Make

Ask for something you will keep. It opens beside the chat ("What this chat made") and you change it together.

| Entry | What it covers | Door |
|---|---|---|
| Documents | Write and edit together; Alfy's edits arrive as Keep / Undo (Keep all); comments with @Alfy; download PDF, Word, Markdown | words (and "Open as document" under a reply) |
| Apps | Small working tools; Preview and Code; "Change this app…"; download `.html` | words |
| Canvases | A board of notes, frames, charts, maps, files, apps, photos and live web pages; drawing, comment pins, Ask Alfy; export PNG | words |
| Pictures | Make a picture from words or change one; Another, Use this, Before / After with a slider, Mark, Attach, Download | words |
| Files | PDF, Word, Excel, PowerPoint, CSV, Markdown, zip, as a file card to download | words |
| History | Every version kept; Named filter, Compare with now, Restore (Documents, Apps, Canvases, Pictures; Files have their own version chips) | button |

Also: the three-step card the first time you open each kind, replayed from "How this kind works" or "Show it again".

### 3. It knows you

Alfy learns what matters to you. You can see, correct and switch off all of it.

| Entry | What it covers | Door |
|---|---|---|
| Memory | Learns as you talk; Memory Profile ("What I remember about you", facts by category, stated or inferred); Needs Review; correct, forget or retire; "While you were away" shows the overnight tidy-up with Undo; `/remember`; Memory off in Settings; the Home notice when memories need a look | both |
| Instructions | Personal instructions for every chat (up to 2,000 characters); project instructions; say "from now on…" and Alfy offers to save it; `/instruction` | both |
| Style and model | Default model and conversation style (AlfyAI, Brief, Thinking partner, Storyteller, Technical, Warm); the Model guide behind the "?" in the model menu | button |
| Skills | Seven built-in helpers (Plan Critic, Document Explainer, Study Coach, Purchase Helper, Translate & Rewrite, Appointment Prep, Spreadsheet Builder) and your own; `$` or `/skill`; "make this a skill" saves one from a chat | both |

### 4. Your things

Bring in what you already have.

| Entry | What it covers | Door |
|---|---|---|
| Knowledge Base | Upload documents; everything your chats made is there too; filter by kind; reading status with Retry and Re-extract; "What the AI sees" | button |
| Use a document in a chat | "From your Library" in the "+" menu, `/document`; or add it to a project's files | button |
| Connected accounts | Calendar (Google, iCloud, CalDAV), email, files (Nextcloud, OneDrive), photos (Immich), Plex, location (OwnTracks), contacts, tasks, GitHub; the Accounts button picks which ones a message may use; "Keep connector data on this device" lets a local model read account data first | button to connect, words to use |
| Nothing changes without your OK | Writing is off until you allow it per account; every change waits on a "Needs your OK" card (Confirm or Cancel, expires after 30 minutes) | Alfy |

### 5. Stay organized

| Entry | What it covers | Door |
|---|---|---|
| Projects | Folders with their own instructions, files and a page of their own; drag a chat in, "Move to project", or start a chat inside one | button |
| Search | Ctrl/⌘+K finds chats, documents and reports; scope chips | button |
| Tidy the sidebar | Pin, drag into folders, select many (Select all, Pin, Move, Delete), collapse | button |
| Incognito | A chat nothing is learned from; chosen before the first message, and it cannot be undone | button |
| Home | Greeting and your week, Recent and Running now, your projects | button |

### 6. Your account

| Entry | What it covers | Door |
|---|---|---|
| Language and look | Interface language, title language, appearance | button |
| Two-step sign-in | Authenticator code plus ten backup codes | button |
| Your data | Download everything as a ZIP; import from ChatGPT; clear memory and knowledge; delete the account; the privacy policy | button |
| Your activity | Messages, tokens, favourite model, estimated cost, by week, month or year | button |

### Shortcuts and commands (a box at the end)

Ctrl/⌘+K search; `/` puts you in the message box; **Ctrl/⌘+Enter sends and Enter adds a new line** (checked; nothing in the app says so); Esc closes. The 16 slash commands: model, style, think, quick, thorough, attach, document, skill, settings, clear, compact, web, new, remember, instruction, export.

### What the grouping shows

- Every feature the agents found has a place; nothing was left over.
- Six entries have no button at all: Maps and travel, Alfy asks first, Apps, Canvases, Pictures and Files. Documents have only "Open as document". You get these only if you know to ask, so the guide's Try it is their only door.
- Not in the app (searched): voice or read-aloud, thumbs up or down, share links, find inside one chat.

## 2. Everything else (minor)

- Composer: a draft per chat that survives reloads and devices; a queue for one follow-up while a reply runs; Edit warns "N later replies will be deleted".
- Replies: Copy; Retry on failure; the thinking display ("Thought for 12s", Show full reasoning); tool rows ("Show what was done": sources, page excerpts, Python and its output, maps, file and picture cards); the jump rail on long chats and Jump to latest; rich blocks (code, charts, CSV, Mermaid, callouts, a zoom viewer for pictures).
- Context ring: how full the chat is; compaction ("Summarized N earlier messages", Show what was kept); `/compact`.
- Cards that wait for you: the cloud-model warning (once per chat); the skill draft card.
- Sidebar: marks for forks, incognito chats and finished Atlas reports; drag to resize; the version badge replays the latest release card.
- Home: the feature note strip, when one is published.
- Settings: photo, name, email, password (signs out other devices); "Things that cannot be undone" (clear memory and knowledge, which also deletes your documents; clear workspace data; delete account).
- Sign-in: Remember me (17 days instead of 2.5); no self sign-up and no "forgot password".
- Phone: the header's user menu (New chat, Search, Knowledge base, Profile & Settings, Log out); the sidebar as a drawer; full-screen side panel.
- Notices: Update available, Update in progress, signed out.
- The welcome slides (new accounts) and the release card (each release, replayed from the version badge) are admin-written campaigns, not features to list.

## 3. Naming drift and overlaps

This is the consolidation list: the same thing named differently, or different things doing nearly the same job. The guide has to settle on one name per feature, so each line below is a decision for the owner. `CONTEXT.md` is the glossary to settle them in.

**The library.** The page is "Knowledge Base" (`knowledge.title`) and "Knowledge base" (`sidebar.knowledgeBase`, `header.knowledgeBase`); what is in it is "your Library" ("From your Library", "Add from your Library", "Add from library"). "Documents" is a tab, a chip and a Search scope. The library's "Files" chip is not a project's "Files", and `CONTEXT.md` lists "project files" under _Avoid_. Checked.

**Steering Alfy.** Six ways: personal instructions, project instructions (both reached by `/instruction` and the "Add to instructions for…" offer), memory (learned, `/remember`, portrait edits), style and skills. The order between them is explained only in two help lines (`instructions.descriptionProject`, `profileTab.personalInstructionsHelp`).

**Settings set in three places.** Style, theme, language and model are each set in Settings, on the welcome's setup slide and in the composer, under different names. Style: "Conversation style", "Default style", "Style", and the default shows "AlfyAI" though a "Default" name exists. Theme: "Appearance" and "Theme". Language: "Interface language" and "UI Language". Settings' model list leaves out the built-in models.

**Thinking.** Four doors (the brain icon, the "+" menu, `/think`, `/quick` and `/thorough`) and four wordings ("Thinking — on for this message", "Toggle thinking for this reply", "Turn thinking off for replies", Info's "Reasoning depth: Quick/Thorough"). It is in fact one setting for the whole browser, not per message (`src/lib/stores/settings.ts`).

**Memory.** The switch says "Memory", the Settings row "Memory profile" (its button "Open Knowledge Base"), the tab "Memory Profile". Five verbs for taking something away: Forget, Retire, Delete permanently, Do not remember, Remove; `memoryProfile.removeFraming` says "two different ways" and shows up to three. Memory off, Incognito and "Clear memory and knowledge" are three different stops, and the last one also deletes documents.

**Retry and Regenerate.** English says "Retry" and "Try again". Hungarian has four words for Retry: Újrapróbálkozás (`chat.retry`), Újrapróbálom (`common.retry`), Újrapróbálás (`contextCompression.retry`), Újra (`atlasActivity.retry`). Checked. "Regenerate" means a new reply, a deleted item made again, and (for an App) "Change this app…" then "Rebuild". "Answer now" is a Regenerate in Quick.

**Accounts or Connections.** The composer says "Accounts" (HU Fiókok), its popover "Use my connections" (HU Kapcsolatok), Settings "Connections". "Local mode" (`connections.cloudWarning.enableLocalMode`) is the same thing as Settings' "Keep connector data on this device".

**Pictures.** The kind is "Image" (HU Kép), its card says "picture", the Library chip "Photo", Immich "Photos".

**Two version systems.** Files have "Version History" chips and "Compare versions"; the other four kinds have History ("Compare with now", "Restore"). There are three different Undos (the toolbar, the pill on Alfy's change, History).

**Smaller ones.**

- "Follow-up" is both the queue button ("Send follow-up") and the suggestion chips.
- "Fork" is both a message fork and an Atlas fork.
- `/document` sounds like the Document kind and "Open as document", but it adds a Library file.
- One search shows two source counts: the tool row's "N sources" and the Sources panel's "N considered, M used".
- The context ring's dialog is named "Context focus panel" but has no focus controls left. Its "What AlfyAI remembers" is a count of recent turns, not Memory. "Compaction: Deterministic / LLM fallback" is jargon.
- Hungarian "chats": `sidebar.chatCount` says "beszélgetés" and `projects.listHeading` says "csevegés".
- Hungarian Checklist: "Feladatlista" in Documents, "Ellenőrzőlista" in Canvas.
- The Search placeholder says "Search conversations and documents" in English and "Keresés a munkaterületen" ("Search the workspace") in Hungarian.
- There are three "recent" lists: Home, Search's default and the sidebar.
- "Project" vs "Project folder" and "No folder" (ChatGPT import).

**Two names to keep (deliberate, per the agents).** Canvas is "Tábla" in Hungarian. The panel's way back says "This chat" in English and "Vissza" in Hungarian.

## 4. Bugs and half-built things found on the way

Update 2026-11-06: the three checked bugs and the first four reported items below (Knowledge delete confirmations, the phone's Log out, the dead History button, the Memory-off state) were fixed in a separate session, seven commits now on local `dev` at `001af26ee` and not pushed. The rest of the reported list is untouched.

Checked in the code:

1. **ChatGPT import ignores which chats you tick.** `ImportChatGPTModal.svelte` keeps a tick per chat, but `startImport` calls `importChatGPTData(file, selectedProjectId)`, which posts only the file and the project, and the server imports every chat in the ZIP. The welcome template promises "select which chats to bring over". The success line "conversations imported successfully." (`ImportChatGPTModal.svelte:405`) is English only.
2. **Immich "Let Alfy write" cannot be switched on.** `api/connections/immich/enable-writes` exists, with tests, but nothing in the app calls it; `normal-chat-tools/photos.ts` tells the model to "Enable Immich writes ... in settings".
3. **Home's weekly bars count incognito messages.** `readWeekly` in `home-summary.ts` does not leave out incognito chats; Your Activity does (`analytics.ts`), and the incognito copy says nothing is remembered or counted.
4. **Two campaign button destinations lead nowhere** (found 2026-11-06, not fixed). `/settings/profile` and `/settings/admin` are on the campaign allow-list (`src/lib/campaign-action-destinations.ts`) and offered in the admin slide editor, but Settings is one page, `src/routes/(app)/settings/+page.svelte`, with no such routes.

Reported by the agents, not yet checked:

- The Knowledge page's delete confirmations are English only (`knowledge/+page.svelte`).
- Log out on a phone skips the confirmation the sidebar asks for (`Header.svelte`).
- A permanently disabled History button, "History arrives with documents." (`artifacts.history.comingWithDocument`), sits in the older panel header for uploaded documents and Atlas reports (`DocumentWorkspace.svelte`).
- The Memory tab has no "Memory is off" state.
- The version badge does nothing when no release or welcome is published (`(app)/+layout.svelte`).
- Search shows a disabled "Connections" chip, "Coming soon" (`search-scopes.ts`); Contacts cannot be connected on their own (`provider-catalog.ts`).
- Browser notifications live only on the Atlas bell, with nothing in Settings (`MessageInput.svelte`).
- A project's page lists only its newest 20 chats (`projects/[projectId]/+page.server.ts`); the way into a project is a new-chat icon labelled "Open {name}" (`ProjectItem.svelte`).
- Pins and folders can be reordered only by dragging.
- With the composer command registry off, the "+" menu still lists Skills and "From your Library", and linked documents are dropped silently (`MessageInput.svelte`).
- Slides is shelved, but its strings remain (`artifacts.type.slides` "Diasor", delete, history and tour lines).
- A "Max/Extended reasoning depth" badge no new turn can produce (`chat-turn/depth-selection.ts` maps only off and standard).
- Dead strings: 42 of 52 `messageBubble.audit*`, `chat.thinkingToggleOn/Off`, `chat.connectionsToggle*`, `contextUsageRing.lockTask/startNewTask`, `knowledge.memory`, `knowledge.description`; the `messageBubble.sendShortcut` hint exists but is never shown; `GoogleSignInButton.svelte` is unused.
- Document tracker chips (Booked, To book, Paid, Cancelled, date) can only be placed by Alfy; there is no insert button.
- The Knowledge page opens on Documents, though `CONTEXT.md` says Memory Profile.
