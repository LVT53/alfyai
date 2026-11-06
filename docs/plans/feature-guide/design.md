# Feature guide: design

Date: 2026-11-06. Status: the owner approved the direction in conversation (2026-11-05 and 06): the format, the six sections, the layout, the drawing style and the behaviour below. This document turns that into something a builder can plan from. A builder check read it on 2026-11-06; its one open question (campaign buttons and Show me) is answered in section 6. The owner approved the whole document on 2026-11-06. Nothing is built yet.

Companion files in this folder:

- [`inventory.md`](./inventory.md): every user-facing feature found on `dev` at `49a270730`, how each is reached, the naming drift (section 3) and the bugs found along the way (section 4).
- [`mockups.html`](./mockups.html): the approved look, layout C with realistic drawings for two of the six sections. Open it in a browser: hover a row to light its part of the drawing, and switch the drawing labels between EN and HU and the theme between light and dark.

## 1. Why

In the owner's words: family members use AlfyAI as a plain chat and never find the rest, and "even I am lost with the features sometimes, and as the app is getting bigger each week it's harder and harder to consolidate features to make one cohesive product."

The inventory backs both halves. AlfyAI has about 30 headline features and many smaller ones. Six of the headline features have no button anywhere (maps and travel, Alfy asking first, Apps, Canvases, Pictures, Files), so a person only meets them by knowing to ask. The same things are named differently across the app: the library is "Knowledge Base", "Knowledge base" and "your Library"; "Retry" has four Hungarian words.

So the guide has two jobs. For a family member it is the place to discover what AlfyAI does and try it. For the owner it is the product's one map: every feature named once and placed in one of six sections, which is the shape new features have to fit into.

## 2. Goals, non-goals, anti-goals

Goals:

- G1. One page lists everything a person can do with AlfyAI, in six sections, in English and Hungarian.
- G2. Every entry can be reached from the page: Try it starts a chat with an example, Show me opens the real place with the control lit.
- G3. Each section has one realistic drawing of the place where its features live, and a row lights up its part of the drawing.
- G4. The guide's entry names are the features' names. Where the app disagrees with itself, the guide's name is the one to keep (see the naming follow-up, section 9).
- G5. The guide stays current: its content is code, changed in the same change as the feature it describes.
- G6. It works on a phone, with a keyboard, in dark mode and in both languages.

Non-goals:

- Admin features. The owner is the only admin; the guide never mentions the Administration tab, campaign editing or anything else only an admin sees. There is no per-person filtering of any kind: not by role, and not by whether a feature is configured on the server.
- A step-by-step click-through tour, or anything that opens by itself.
- Editing the guide from the admin Campaigns pane. The content lives in the code.
- Counting or analysing how people use the guide.
- Search inside the guide. Thirty rows in six sections are read at a glance.
- Fixing the naming drift across the app, and moving campaign pictures to the drawing style. Both are follow-ups (section 9).

Anti-goals (a failure even if it works):

- A popup nobody asked for.
- A manual that goes stale: an entry that describes a feature that has changed or gone.
- A guide that breaks whenever a button moves.
- Walls of text. Each entry is a name and one line.

## 3. What a person sees

### 3.1 Where it opens from

- **Beside the version badge.** A small "?" button sits right after `AppVersionBadge` in the expanded sidebar's header (`src/lib/components/layout/Sidebar.svelte`). It is as quiet as the badge next to it, uses Lucide's circle-help icon, is named "What AlfyAI can do" for screen readers and in its tooltip, and shows as active while the guide page is open. The badge keeps its job (it replays the latest release card): the badge answers "what's new", the "?" answers "what can it do".
- **The collapsed sidebar.** The collapsed rail shows only the logo, so the version badge and the "?" are hidden there. The "?" appears under the logo in the rail.
- **A phone.** A row in the header's user menu (`src/lib/components/layout/Header.svelte`), beside the existing rows (New chat, Search, Knowledge base, Profile & Settings, Log out).
- The guide never opens by itself.

### 3.2 The page

A page in the app shell, beside the sidebar like Knowledge and Settings, not a modal. The owner chose a page for the room it gives.

- Title: "What AlfyAI can do" (Hungarian draft: "Amit az AlfyAI tud", in the pattern of the panel's "Amit ez a beszélgetés készített"). The title is the only serif on the page.
- One line under it: "A map of everything here. Try it starts a chat with an example you can change before sending."
- A row of six chips that jump to the sections.
- Six **section bands** (layout C in the mockups). On a wide screen a band is two columns: on the left the section's name, a one-line intro and its drawing; on the right its rows. A row is the entry's name (with a NEW mark when due, 3.6), one line, and its action at the right: Try it, Show me, or nothing.
- At the end, a small **Shortcuts and commands** box: Ctrl/⌘+K opens Search; `/` puts you in the message box; **Ctrl/⌘+Enter sends and Enter adds a new line** (nothing in the app says so today); Esc closes. Then the slash commands with their one-line descriptions, read from the command registry (`src/lib/composer-commands.ts`) rather than copied, so the box cannot drift from the composer.
- On a phone each band stacks: the section's name and intro, the drawing, then the rows.

### 3.3 The drawings

One drawing per section. Each is a small, realistic copy of the place where that section's features live, so a person can match it to the real screen:

- Real Lucide icons, the app's own colour tokens and shapes, and the real button words, taken from the same dictionary keys the real controls use (for example `composerTools.attachFile`, `messageEvidenceDetails.sourcesLabel`, `artifacts.document.review.keepShort`). Never a copy of the word: when the real button's wording changes, the drawing changes with it, and Hungarian comes for free.
- Message text and other content are grey bars. Content would need its own translation and would date.
- Light and dark come from the tokens, with nothing redrawn.
- A drawing is decorative (`aria-hidden`). Everything it shows is also said in the rows' words.

What each drawing shows:

| Section | The drawing | Its spots |
|---|---|---|
| Ask | A person's message and Alfy's reply with its Sources row and action icons (copy, regenerate, fork); the composer with the "+" menu open on Attach file, From your Library, Atlas and Skills; the Accounts and Thinking icons and Send | thinking, sources, attach, atlas, reply-actions |
| Make | The chat beside the side panel open on a Document: the panel header's way back, History (clock) and Download; one passage marked as Alfy's change with Keep / Undo; in the chat, a Document card and a Picture card | document, picture, download, history |
| It knows you | The Memory Profile ("What I remember about you", a few facts, the Needs Review count) beside a slice of Settings with Personal instructions, Conversation style and Skills | memory, instructions, style, skills |
| Your things | The Knowledge Base list with its kind chips beside Settings > Connections (a few accounts with their icons and switches), and a "Needs your OK" card | library, from-library, connections, ok-card |
| Stay organized | The sidebar (Search, Pinned, Projects with folders, Chats) beside Home's Recent list and the incognito mask button | search, projects, sidebar-list, incognito, home |
| Your account | A slice of Settings > Profile: the language and appearance choices, the Two-step sign-in row, Download my data, and the Your Activity chart | language, two-step, data, activity |

The Ask and Make drawings are in `mockups.html`; the other four are the builder's to draw from the real screens, in the same way. A builder may add a spot to a drawing (an App card for Apps, a question card for "Alfy asks first"); a row without a spot simply lights nothing.

**Lighting a spot.** Hovering a row, focusing it with the keyboard, or tapping it on a phone rings its spot in the drawing: the accent outline with a soft halo, as in the mockups. The ring is instant under reduced motion. On a phone the drawing sits above the rows, so a lit spot must be in view when it lights; how (a drawing that stays in view while its rows scroll, or a scroll to it) is the builder's call.

### 3.4 Try it

Try it opens Home with the entry's example already in the message box, **not sent**, so the person can change it first. The example is in the reader's language. If the Home box already holds a draft, Try it must not silently destroy it; how it avoids that is the builder's call.

### 3.5 Show me

Show me takes the person to the real place and rings the real control for about two seconds, with the same ring as the drawing. If the control lives inside a menu, the menu opens (Atlas: Home, with the "+" menu open and Atlas lit). Settings opens at the right section.

Show me exists only where its control is always there. A control that appears only in some state (the actions under a reply, an open item's History, a pending "Needs your OK" card, the sidebar's selection bar) gets no Show me; the drawing shows where it is.

### 3.6 NEW

An entry is marked NEW for 30 days after its `added` date. Everyone sees the same thing, so the guide keeps no per-person record. Entries for features that already exist when the guide ships get an `added` date that leaves them unmarked, except "Alfy asks first", which was added on 2026-11-05.

## 4. The content

Section names and intros (Hungarian names are drafts for the owner to check):

| Section | Hungarian draft | Intro |
|---|---|---|
| Ask | Kérdezz | Ask anything, in English or Hungarian. Alfy decides when to search, calculate or look something up. |
| Make | Készíts | Ask for something you will keep. It opens beside the chat and you change it together. |
| It knows you | Ismer téged | Alfy learns what matters to you. You can see, correct or switch off all of it. |
| Your things | A dolgaid | Bring in what you already have: documents and accounts. |
| Stay organized | Tartsd rendben | Find anything, and keep your chats where you want them. |
| Your account | A fiókod | Language, sign-in and your data. |

The entries. "Example" is the Try it text; examples are drafts the builder may improve, as long as each one shows its feature in one message.

| Section | Entry | One line | Action | Spot |
|---|---|---|---|---|
| Ask | Ask anything | Pick a model and a style; switch Thinking on for harder questions. | Show me: Home, the Thinking switch | thinking |
| Ask | Web and links | Fresh facts from the web, with the sources it used. | Example: "What will the weather be like at Lake Balaton this weekend?" | sources |
| Ask | Show it a picture or a file | Drop in a photo, a PDF or a screenshot and ask about it. | Show me: Home, "+" menu with Attach file | attach |
| Ask | Maps and travel | Routes, travel times and public transport, on a map. | Example: "How do I get from Keleti station to the airport by public transport?" | none |
| Ask | Atlas research | A deep report with sources; a bell tells you when it is ready. | Show me: Home, "+" menu with Atlas | atlas |
| Ask | Steer a reply | Edit, regenerate, fork, or add a follow-up while it is still answering. | none | reply-actions |
| Ask | Alfy asks first (added 2026-11-05) | When a request could go two ways, Alfy asks with answers to click. | Example: "Help me choose a laptop." | none |
| Make | Documents | Write and edit together; Alfy's changes wait for your Keep or Undo. | Example: "Draft a polite letter to my landlord about the broken heating." | document |
| Make | Apps | Small working tools: a quiz, a calculator, a tracker. | Example: "Make a times-table quiz for a nine-year-old." | none |
| Make | Canvases | A board of notes, charts, maps and photos. | Example: "Plan a weekend in Vienna on a board." | none |
| Make | Pictures | Make a picture from words, or change one. | Example: "Draw a birthday card with a fox in a party hat." | picture |
| Make | Files | PDF, Word, Excel or PowerPoint, ready to download. | Example: "Make an Excel sheet for our monthly household budget." | download |
| Make | History | Every version is kept. Compare and restore. | none | history |
| It knows you | Memory | See what Alfy remembers, correct it, or switch it off. | Show me: Knowledge Base, Memory | memory |
| It knows you | Instructions | Rules Alfy follows in every chat, or in one project. | Show me: Settings, Personal instructions | instructions |
| It knows you | Style and model | How Alfy sounds, and which model answers by default. | Show me: Settings, Preferences | style |
| It knows you | Skills | Ready-made helpers like Study Coach, and your own. | Show me: Settings, Skills | skills |
| Your things | Knowledge Base | Your documents in one place, with everything your chats made. | Show me: Knowledge Base, Documents | library |
| Your things | Use a document in a chat | Pick a file from your Library and ask about it. | Show me: Home, "+" menu with From your Library | from-library |
| Your things | Connected accounts | Calendar, email, files, photos and more, for Alfy to read. | Show me: Settings, Connections | connections |
| Your things | Nothing changes without your OK | Alfy asks before it changes anything in your accounts. | none | ok-card |
| Stay organized | Projects | Folders with their own instructions and files. | Show me: the sidebar's Projects | projects |
| Stay organized | Search | Find any chat or document; Ctrl/⌘+K on a keyboard. | Show me: the sidebar's Search | search |
| Stay organized | Tidy the sidebar | Pin, drag into folders, or select many at once. | none | sidebar-list |
| Stay organized | Incognito | A chat Alfy learns nothing from. | Show me: Home, the mask button | incognito |
| Stay organized | Home | Recent chats, what's running, your projects and your week. | Show me: Home | home |
| Your account | Language and look | Interface language, chat title language, light or dark. | Show me: Settings, Preferences | language |
| Your account | Two-step sign-in | A code from your phone as well as your password. | Show me: Settings, Two-step sign-in | two-step |
| Your account | Your data | Download everything, bring in your ChatGPT history, or delete your account. | Show me: Settings, Data & privacy | data |
| Your account | Your activity | Messages, tokens and estimated cost over time. | Show me: Settings, Your Activity | activity |

On a phone the "sidebar" destinations open the sidebar drawer first.

Hungarian: every word on the page needs a Hungarian version, written by the builder and checked by the owner. The owner's standing rule applies: short, natural Hungarian that fits a 360 px row. The inventory's section 3 lists where the app's own Hungarian disagrees with itself; the guide uses one word per thing (for example one word for Retry) and does not copy a drifted one.

## 5. How it is built

Decided:

- **No server change.** The content is static, NEW is worked out from a date in the browser, and nothing is stored per person: no route under `src/routes/api/`, no table, no migration.
- **The content is one typed list in code**: each entry's id, section, action (an example, a Show me destination, or none), spot and `added` date. Every word lives in a new dictionary file, `src/lib/i18n/guide.ts` (keys `guide.*`), so the dictionary's existing English and Hungarian checks cover the guide. The drawings' words are the real controls' existing keys, never new ones.
- **The drawings are a shared kit, not part of the guide page.** They go in a folder of their own under `src/lib/components/` with its own AGENTS.md, built from small drawn parts (a composer, a reply, the side panel, the sidebar, a Settings row, cards) that the six section drawings compose. Campaign pictures will reuse the kit later (section 9), so the guide page must not be the only thing that can render a drawing. The panel tours' drawings (`src/lib/components/artifacts/tour/illustrations/`) are the precedent for illustrations under the Lucide rule; unlike those, these drawings put real Lucide icons inside them.
- **One list of in-app places.** Every place in the app that something can send a person to is defined once, in a shared module. The campaign allow-list (`src/lib/campaign-action-destinations.ts` today, with its `internal:` actions handled in `src/routes/(app)/+layout.svelte`) becomes a view of that list. Five things read the allow-list: the server's publish check (`announcement-campaigns.ts`), the feature-note reader, the admin slide editor's destination menu (`SlideEditor.svelte`), the publish checklist (`campaign-checklist.ts`) and the campaign modal. **The allow-list's values do not change.** Published campaign snapshots store these strings, so every existing value must stay valid. Do not start a second list. The guide's Show me places are guide-only: campaign and feature-note buttons do not get them in this project (owner, 2026-11-06: "that's separate"), so the campaign view offers exactly what it offers today, and nothing in the campaign code's behaviour changes.
- **One spotlight mechanism.** Show me names a destination and a spot; the component that owns the real control finds its spot, opens what has to open, and rings it. The real controls carry a marker for their spot. The request to ring travels with the navigation, held in memory and not in the URL, so a reload or Back never rings again (my call).
- **Try it goes through `src/lib/client/conversation-session.ts`**, which owns the hand-off into the composer. It already has a one-shot pattern of this kind (`markProjectComposerFocus` / `consumeProjectComposerFocus`). No new raw `sessionStorage` protocol anywhere else (root AGENTS.md).
- **The page is its own route** inside `src/routes/(app)/` (the builder names it; `/guide` is the obvious one). The route is an adapter: the page's components and the content list live under `src/lib/`. Nothing in the chat shell imports the guide statically except the "?" button.
- **Svelte 5 runes, Lucide icons, the app's tokens**, as everywhere. The page title joins the files allowed to use the serif in `tests/integration/serif-conventions.test.ts`.
- **A rule that keeps it current**, added to the root AGENTS.md's Core Rules: a change that adds, removes, renames or moves a user-facing feature updates its guide entry in the same change, and its section's drawing when a pictured control changes. The guide's and the drawing kit's own AGENTS.md files hold their details, and the root's Folder Rules list them.
- **A glossary entry**: "Feature Guide" in `CONTEXT.md`, under User Onboarding, with _Avoid_: tour (the glossary already has the First-run Onboarding Tour and the Artifact Tour), help centre, manual.

Tests:

- Unit: every entry has its words in both languages, a valid action (a known destination and spot, or an example), and a spot that exists in its section's drawing (or none); ids are unique; NEW appears on the right days; the shortcuts box lists every command the registry offers.
- Component: hover, focus and tap light the row's spot; Try it hands its example to Home unsent and keeps an existing draft safe; Show me asks for the right destination and spot.
- End to end, a new `tests/e2e/feature-guide.spec.ts`: the guide opens from the "?", from the collapsed rail and from the phone menu; **every Show me reaches its real control and rings it** (this is what keeps the markers on the real controls alive when the app changes); Try it leaves the example unsent in the Home box; the page holds together at 390 px in English and 360 px in Hungarian, and in dark mode.
- The finish line is the repo's usual one: `scripts/gates.sh agent` with the new spec and the specs for anything touched (the sidebar and header: `tests/e2e/login.test.ts tests/e2e/search-modal.spec.ts`; the composer: `tests/e2e/chat.spec.ts`).

## 6. Who decided what

The owner decided (2026-11-05 and 06):

- An optional guide for every user, opened from a "?" next to the version number, never by itself.
- A page, not a modal, for the room.
- No admin features, and no machinery to hide them ("let's not even develop that").
- The six sections and their contents, as in section 4.
- Layout C, section bands.
- Drawings, made realistic "so it's easier to draw the connection between the UI and this", with real icons and button words and a row lighting its part.
- Campaign pictures should adopt the same style in future.
- Campaign and feature-note buttons do not get Show me places in this project; that is separate work (2026-11-06, answering the builder check).
- The behaviour played back on 2026-11-06 and approved as a whole: Try it fills the box without sending; Show me opens the place and rings the control; the highlight works by keyboard and touch; the phone menu row and the collapsed-rail "?"; NEW for 30 days for everyone; the guide's names become the app's names.

My calls, for the owner to check while reading:

- The Hungarian drafts for the page title and section names.
- The wording of every entry line and example in section 4.
- The rule that Show me exists only where its control is always there, and which entries therefore have none (Steer a reply, History, Nothing changes without your OK, Tidy the sidebar), plus three entries with neither action nor spot (Maps and travel, Apps, Canvases have an example but no spot).
- What each of the four undrawn section drawings shows (the table in 3.3).
- No server change; the content and every word in code; one shared list of in-app places; the drawing kit as its own shared folder.

## 7. Left to the builder

- The route's name, the component split, and the folder names.
- Drawing the four remaining sections from the real screens, and composing the kit's parts.
- How a lit spot stays in view on a phone, and the spotlight's mechanics.
- How Try it treats an existing Home draft.
- Whether the section chips stay in view while scrolling.
- The final wording of the examples.

## 8. Phasing

A suggested order, for the plan to refine:

1. The content list, the `guide.*` dictionary and the page with its bands and rows, Try it and NEW, without drawings.
2. The drawing kit and the six drawings, with the row-to-spot highlight.
3. Show me: the shared list of places, the spotlight, and the markers on the real controls.
4. The ways in: the "?" beside the badge, the collapsed rail, the phone menu.
5. The AGENTS.md rule, the folder AGENTS.md files, the glossary entry, and the end-to-end spec.

## 9. Follow-ups, not part of this project

- **Campaign pictures in the drawing style** (owner, 2026-11-06). Release and welcome pictures are captured today as real screenshots (`scripts/campaign-shots.ts`) and loaded with `scripts/create-release-campaign.ts`. Switching them needs ADR-0012 amended (it says campaign screenshots are "curated real captures of released AlfyAI features, not live user-state screenshots and not invented mock panels") and the pipeline changed to render drawings from the kit. Open there: a captured picture has one language and one theme, while the kit's drawings have both. Also there: two of the campaign allow-list's values lead nowhere today. `/settings/profile` and `/settings/admin` are offered in the slide editor, but Settings is one page (`src/routes/(app)/settings/+page.svelte`) with no such routes.
- **Show me for campaign buttons**, if wanted. The shared list of places makes it possible, but it touches the publish check, the feature-note reader, the slide editor, the checklist and the campaign modal, and ADR-0012's allow-list wording. The owner called it separate from this project.
- **Naming alignment.** `inventory.md` section 3 lists where the app names one thing several ways. Once the guide's names are settled, a separate change brings the rest of the app in line, one owner decision per line.
- **The welcome slides could point at the "?".** That is admin-written campaign content, so it is the owner's to add.
