# Tool rows that say what happened: design

Date: 2026-11-18. Status: **approved by the owner** (2026-11-18): the two mockup screens ("This is fucking amazing!"), then this document with the recommended defaults for the builder check's questions ("I will take your recommended defaults for these"), the Atlas report row included. Code facts are from origin/main `dea9d0e08`. The mockups sit beside this file:

- `2026-11-18-tool-row-words/mockup-1-rows.html`: the first screen (the video, a memory lookup that found nothing, Python, the two sentences above every list).
- `2026-11-18-tool-row-words/mockup-2-every-tool.html`: the second screen (every other tool and every error case, with the words in English and Hungarian).

Both are standalone pages: open one in a browser, click a row to open it, and use the bar at the top for Hungarian, phone width and dark mode.

## 1. Intent

The owner, about the in-chat tool rows: they "are currently useless to read". Keep them "friendly, end-user facing, nothing developer or nothing dumping fully". The bar is set by the web search's source list and the recalled memories, which "already work wonders": "The raw thinking trace contains everything in greater detail but that's hidden on purpose. So the only thing the tool call detail screen needs to do is give a little more info than the tool's name."

On errors: "there's probably an error somewhere with these tools that we do log for fixing sake, but the user only sees characters they don't understand. I'd like friendly messages for all error cases we cover basically. It should be made a rule too."

Why it matters: the family reads these rows, mostly in Hungarian. Today an opened row often shows raw argument names, a UUID, the English note the tool wrote for the model, or the same failure four times. The example that started this: a video the app declined on purpose opens to "Couldn't make the video "Harbour at dawn". / Could not complete it. / Couldn't make this one. / ▸ Details: Couldn't make this one."

## 2. The rule (owner-approved)

1. An opened tool row gives a little more than the tool's name: the things the tool found or touched, by their own names (a page's title and site, a memory, an event, a file), in plain words.
2. Never the model's side: no argument names, ids, codes, exception or HTTP text, and no text written for the model (`outputSummary`, `metadata.error`, refusal messages, `resultDigest`).
3. Every error case a tool's server code tells apart has its own short sentence in English and Hungarian, shown once. A case without one gets that tool's own fallback line, never the code. The raw error stays in the server log, for fixing; nobody sees it in the app, the admin included.
4. A red ✕ only when something broke. A stop the app makes on purpose (a check, a filter, a limit), or a setting the person can change, is the quiet – of the existing `skipped` status.
5. A row with nothing more to say than its own line does not open: no body, so no chevron (the row component's existing rule that only a row with a body is a button).

**Scope: the tool rows only** (owner: "For now let's stick to rule cover only"). Every other error a person can meet is a later item in the owner backlog doc (`docs/agent-memory/claude/alfyai-feature-backlog-owner-order.md`, "Owner add-on (2026-11-18): friendly error messages across the whole app"). "Tool rows" means everything drawn by `ToolActivityRow.svelte`, `ToolActivityList.svelte` and the connector rows, plus the failure line on the cards a tool row carries (the file job card, the "couldn't make this" artifact card, the picture and clip cards).

**The Atlas report row is in** (owner's call after the builder check, 2026-11-18): it is drawn through `ToolActivityRow` too, so the rule covers it from day one, with no exception (section 4, "Atlas report rows").

Where the rule is written, as part of this change:

- root `AGENTS.md`, Core Rules: one line saying a tool row says what happened in plain words in both languages, every error case a tool tells apart has its own words, codes and raw error text stay in the server log, and pointing to the chat folder's section and the test.
- `src/lib/components/chat/AGENTS.md`: a new "Tool Rows" section holding the five points above, where the words and the registry live, and the test that holds them.
- `src/lib/server/services/AGENTS.md`, the "Tool execution envelope note": every failure or refusal a tool records carries a reason code from its tool's closed list; the text written for the model stays the model's.

## 3. What changes everywhere

The row's anatomy stays: `[status] [tool icon] verb object … meta [chevron]`, with the opened body below (`ToolActivityRow.svelte`, view-model from `buildToolActivityItem` in `src/lib/utils/tool-activity.ts`). The item cards (Document, App, Canvas, Slides, File, Image, Video) stay; only their failure words change.

- **The two sentences go.** Almost every opened body starts with two sentences built by `describeToolCall` (`src/lib/components/chat/tool-call-summary.ts`) and the `chat.toolSummary.*` keys: "Searched "…"." / "Found 6 results.", "Recalled "3 memories"." / "Finished.". They repeat the row, so they leave every row. Every proposed row on both screens is drawn without them (see 9: a call of mine).
- **Details goes.** The closed "Details" disclosure (raw argument names and values, the model-facing result, the second copy of a failure reason) leaves every row, and so does the meta word "Details" on failed create, edit, picture and video rows.
- **A failure's reason is one sentence**, from its reason code: in the opened body, or on the item's card when the row carries one.
- **Every row reads in-band failures.** Today only `make_image`, `make_video`, `create_artifact` and `edit_artifact` read `metadata.ok === false`; every other row goes red only on `status === "failed"` (`tool-activity.ts:655`), so an account step that failed, a missing skill or a read of a deleted item get a green tick. After: `ok === false` with a reason code is a failure or a stop, by the code's kind.
- **Nothing found is said on the row.** A search, a picture search or a memory lookup that found nothing stays done, shows "nothing found" as its meta, and does not open.
- **The elapsed time goes.** The "1.4 s" on the right (from `metadata.durationMs`, which the envelope writes on every call) leaves every row, as on the approved screens: a raw timing reads like a log line, which the artifact rows already decided (artifacts redesign §9.2). A row's meta is a fact a person reads ("6 sources", "27 km · 34 min", "nothing found"), or nothing.
- **The glyph follows the code's kind.** The stored `status` stays as it is, so nothing the model reads back changes; the row's shown glyph and colour come from the reason code's kind in the browser (✕ for something broke, – for a stop on purpose or a setting, i for information).

## 4. Per tool

What today's opened row shows, what it shows after, and the data it uses. The words are in section 5; the proposed reason codes there are names the builder may change.

### research_web ("Searched <query>")
Today: the source list (it stays). A failure is `status: "failed"` with "No usable web evidence was committed. Narrow the topic or URL for a new read." (`normal-chat-tools/model-payload-budget.ts:172`) for a broken search, an empty one and a search refused because the turn's reading budget is used up, alike.
After: success unchanged (without the two sentences). The server tells the three apart. Empty is not a failure: done, meta "nothing found", no body.

### fetch_url ("Read <host · page title>")
Today: the page row and its excerpt (they stay). A link refused under ADR-0068 (on purpose: it came from neither the person nor a tool result): older stored calls hold `ok: false` and `refusedUrlCount`, are status done, and open to "The page came back."; at the tip the budget-grant path writes research_web's failed shape instead.
After: the refusal is a quiet row, verb "Didn't open", object the host, one sentence. Failures the server tells apart: didn't answer in time, turned Alfy away (sign-in, paywall, block), page gone, no readable text, skipped on purpose because enough was read.

### image_search ("Searched images <query>")
Today: a dump: "Finished." and Details with `query`, `count` and "Found 8 images.". The pictures are not shown.
After: meta "8 pictures"; the body is the pictures found, as small thumbnails with each one's site under it. Data: up to 8 `candidates` with `title`, `url`, `snippet` (the source) and `metadata.thumbnail`, `width`, `height` (`normal-chat-tools/image-search.ts:65`). The thumbnails are addresses from a tool's result, which ADR-0068 allows without a click; read `url-provenance/AGENTS.md` and load them the way the app already loads result thumbnails. Errors: the picture search unavailable (the provider answered 402 five times in late October), didn't answer in time.

### memory_context ("Recalled <N memories>")
Today: bullets of the candidates' titles (they stay for memories). A look into past chats (`history` mode) or the project's chats (`project` mode) also reads "Recalled N memories" though the items are chat titles; `persona` mode opens to "Persona memory status: available" (`memory-context.ts:267`); nothing found opens to a dump.
After: memories unchanged. Past chats and project chats: verb "Looked through", object "3 past chats", body the chats' titles. Persona: the remembered statements as bullets when the candidates carry them, else no body. Nothing found: meta "nothing found", no body. Errors: a chat Alfy may not look into (on purpose, today's scope refusal), memory couldn't be read.

### The nine account tools: calendar, contacts, email, files, location, media, photos, repos, tasks
Today (`buildConnectorActivityItem`, `tool-activity.ts:1454`): one row per run of a tool's calls, verb the capability ("Calendar"), object "2 actions", meta only "Failed"; the body is one line per call, `input.action` lowercased ("list events", "check availability"), with no result. A failure the tool reports inside its answer (`success: false`, status done) gets a green tick.
After: the row's object says what came back across the run, in the tool's own unit ("Calendar · 3 events", as the approved screen draws it for a list of events followed by an availability check); "N actions" stays only when nothing countable came back. The body has each call as a plain phrase ("Looked at your events", "Checked when you're free") with what came back: its count (`eventCount`, `messageCount`, `contactCount`, `repoCount`, `taskCount`, `resultCount`) and up to 5 things by name from the candidates (an event's title and start, an email's subject, a contact's name and company, a task's title and due date, "Show — Episode", a place, "#12 Title"), then "and N more". Files keep their strip under the reply, Photos keep "Looked at N photos" and their strip, writes keep their pending-write cards and the settled rows ("Sent", "Moved to Trash"), and the live stack's agenda peek and photo strip stay.
Errors, one set for all nine with the account's own name: not connected, needs connecting again, no account by that name, the account didn't answer, changes turned off, details kept on the person's server (a cloud model is in use: `metadata.localDistilled`; information, not an error), Alfy asked the wrong way and corrected itself (missing parameters).
Every action of the nine tools needs its phrase in both languages; the builder lists them from the tools' schemas.

### produce_file (the file job card)
Today: `FileProductionCard.svelte` words the error codes it knows and prints the raw English message for any other code.
After: the card's fallback line instead of raw text, and words for every code the file maker returns (the limits on purpose: too many outputs, source too large, the `*_limit_exceeded` and `unsupported_*` codes; breakage: timeouts, the `worker_*` codes, the client's `tool_failed`). Codes that have words today keep them.

### create_artifact
Today: a refusal (`ok: false` with `artifactKind`) is the failed card "Alfy couldn't make this." with the English reason verbatim; a thrown error is a red "Couldn't create: <title>" with Details.
After: the card's line is the reason's sentence: the per-turn cap (`MAX_CREATE_ARTIFACT_CALLS_PER_TURN`, `index.ts` near line 1852, on purpose), a kind that can't be made, each other handler reason with its own code, and the fallback. The row's glyph follows the code's kind like every other row: the per-turn cap is a quiet – (the second screen draws it red; that was a slip, and the rule wins).

### edit_artifact
Today: a red "Couldn't edit: <title>", the meta "Details", the English reason twice.
After: the stale-read conflict, which protects the person's own changes, is a quiet "Left as it was: <title>" with its sentence. Other guards, each with a code: a File, picture or video can't be edited as text; patches and ops sent together, or an instruction for something that isn't an App (the model's own mistakes: "Alfy adjusted its request."); an App rebuilt twice in one reply; the per-operation Document and Board refusals in `refusedBlocksJson`. The card's existing "N parts left alone" pill stays. Fallback.

### make_image
Today the words come from codes already (`imageReasonKey` and `IMAGE_REASON_KEYS`, `tool-activity.ts:443-490`), but the glyphs do not follow the rule: `explicit_request` and `transparent_unavailable` read "Picture not made" with `status: "failed"`, and the filter's `image_blocked` / `image_unchecked` read "Picture blocked", also red (`makeImageRow`; tests in `tool-activity.test.ts` pin the red). Once a take has a card, `withImageCard` puts the card in the row's place, and the card's failure line is the generic "Couldn't make this one." (`artifacts.take.failed`, the take card shell shared with clips) for every breakage code. The second screen's "Today" drew the transparency row quiet; it is red today.
After: make_image gets the whole rule. `explicit_request`, `transparent_unavailable` and `image_blocked` are a quiet –; `image_unchecked` stays ✕ (the check could not run, and later it may). The card's failure line is its code's sentence (the existing `toolActivity.pictureReason.*` words), in the take card shell that pictures and clips share. The transparency sentence loses its Admin hint: "The current picture model can't make transparent pictures." for everyone (see 9). The tests that pin the red change with it.

### make_video
Today: words only for `video_blocked`, `video_unchecked`, and `video_server_unreachable` / `video_server_not_configured` / `not_configured`. Every other code, the on-purpose `not_asked_for` and `explicit_request` included, reads "Couldn't make the video" with "Couldn't make this one.", and a refusal (it names no card) opens to that four times.
After: the picture row's grammar. The stops on purpose are a quiet "Video not made" with a sentence; `video_blocked` is a quiet "The video was blocked" and `video_unchecked` stays ✕, as for pictures; `unknown_picture` is "Adjusting the video request" with no body, as the picture row's adjusting state is; every breakage code has its sentence, in the row's body when there is no card and on the clip's card (the shared take card shell's failure line) when there is.

### Atlas report rows
Today: a failed job's body prints `job.error.message` verbatim (`AtlasActivityBody.svelte:190`), for example "Atlas worker heartbeat timed out before completion." (`ATLAS_LOST_ATTEMPT_MESSAGE`, `atlas/config.ts:31`) or whatever exception the pipeline passes on under `atlas_pipeline_failed`. The job already carries a code (`errorCode`, read in `atlas/read-model.ts:71`).
After: the body shows the code's sentence (table in section 5), and the message stays in the log. The job engine's own codes (`worker_queue_timeout`, `no_verdict`, `job_failed`, in `jobs/recovery.ts` and `jobs/runner.ts`) are part of Atlas's list. Where the pipeline's exceptions tell cases apart that a person would care about (a search provider down, the model failing), the builder may give them codes of their own; `atlas_pipeline_failed` keeps the existing fallback sentence. The stage line, the plan and the Stop and Retry controls stay as they are.

### Every tool: a Stop, a tool's own timeout, the turn's deadline
These come from the shared envelope for every tool (`toolAbortError`, `toolTimeoutError` and the working-deadline abort `TurnDeadlineReason` in `normal-chat-tools/shared.ts`) and reach the segment as English text ("fetch_url timed out after 30000ms"). Under the rule that text is never shown, so each would fall to its tool's red fallback, which is wrong for a Stop the person pressed.
After: three shared codes join every tool's closed list:
- `stopped` (the person pressed Stop): a quiet –. Pictures and clips already treat a Stop as no failure ("Picture stopped", "Stopped the video", drawn today with a ✓); they move to the – with every other tool, keeping their verbs.
- `timed_out` (the tool's own time limit): ✕, with the tool's own "didn't answer in time" sentence where its table has one (`site_timeout`, `search_timeout`, `video_render_timeout`…), else the shared one.
- `out_of_time` (the turn's working time ran out while the step ran): a quiet –, a limit on purpose.
A tool that already words its Stop or its timeout (`video_stopped`, `video_tool_timeout`'s "still being made", create_artifact's cancel) keeps its own code; the shared ones are the floor, not a replacement.

### run_python
Today: "Program" (the whole source) and "Output", which is `outputSummary`: "run_python finished: exit code 0, 41 stdout chars." (`run-python.ts:103-122`). What the program printed never reaches the browser. A thrown error is status done with `ok: false` (a green tick) and the error as its "Output"; `ok` is true even when the program exits with an error.
After: no program. The body is what the program printed, as plain text. The server keeps a short display copy of stdout on the segment, in a field of its own that is never sent to the model (about 12 lines or 600 characters, cut at a line end; the builder decides). A program that printed nothing does not open. Errors: ran out of time (`timedOut`), stopped with an error (a non-zero exit or a thrown error), calculations unavailable (the sandbox is down).

### map_route
Today: success is the itinerary and the map (they stay). A failure has no code, only sentences written for the model ("do NOT estimate"), and opens to the raw request; the row's object is the first input value, so it can read "Route drive".
After: codes for out of the map areas, no route, a map still being prepared, a trip across map areas, a map that is unavailable, no timetables for the area (the coverage stops are on purpose), a place not found (its sentence names the place, from the input) and the map search down. With no map, the row's object is "origin → destination" from the input.

### use_skill
Today: success opens to `Loaded skill "X"` (English); a refusal is a green "Used skill X" whose body is the instruction written for the model ("Only call use_skill with a name from "## Skills available"").
After: success does not open (the skill's name says it). Codes: turned off, and no skill by that name (row: quiet "No skill called <name>", no body).

### suggest_instruction
Today: the verb is "Tool" (the tool has no label key) and the row opens to "Alfy used a tool." with Details.
After: verb "Suggested an instruction", object the text, no body: the offer itself has its own card (from `message.instructionSuggestions`). Its rules already have codes (`already_offered`, `empty_text`, `text_too_long`): they get words.

### read_artifact and read_generated_file
Today: a dump (`artifactId` as a UUID and `detail`; `filename`, `requestTitle`, `from`, `query`, `page`, `part`). Not found (`ok: false`) is a green tick with no name.
After: no body; a part shows on the row ("report.pdf · page 3"). Codes: the item is gone, the file isn't in this chat, several files matched.

## 5. The words

"Kind": ✕ something broke, – a stop on purpose or a setting, i information. The codes are proposals; the builder may rename them, keeping one closed list per tool. The Hungarian follows the owner's copy rule: short, natural, fits a 360 and 390 px row.

### Words on the row itself

| Where | English | Hungarian |
|---|---|---|
| any search or lookup that found nothing (meta) | nothing found | nincs találat |
| image_search (meta) | 8 pictures | 8 kép |
| memory_context history/project (verb, object) | Looked through · 3 past chats | Átnézve: · 3 korábbi beszélgetés |
| fetch_url refused (verb) | Didn't open | Nem nyitotta meg: |
| edit_artifact stale read (verb) | Left as it was: | Változatlan maradt: |
| make_video stop (verb) | Video not made | A videó nem készült el |
| make_video adjusting (verb) | Adjusting the video request | Videókérés pontosítása |
| use_skill not found (verb) | No skill called | Nincs ilyen készség: |
| suggest_instruction (verb) | Suggested an instruction | Utasítást javasolt: |
| account lists, after the 5th thing | and 3 more | és még 3 |
| account not connected (object) | not connected | nincs csatlakoztatva |
| account calls (examples; one per action) | Looked at your events · Checked when you're free · Looked at your inbox | Megnézte az eseményeidet · Megnézte, mikor érsz rá · Megnézte a beérkezett leveleidet |

### research_web

| Case | Code | Kind | English | Hungarian |
|---|---|---|---|---|
| service down or broken | `search_unavailable` | ✕ | The search service didn't answer, so nothing came back this time. | A keresőszolgáltatás nem válaszolt, ezért most nem jött eredmény. |
| nothing useful found (row meta "nothing found", no body) | `nothing_found` | – | Nothing useful came up for this search. | Ehhez a kereséshez nem jött hasznos találat. |
| skipped on purpose, enough read already | `reading_budget_used` | – | Alfy had already searched enough for this reply. | Alfy ehhez a válaszhoz már eleget keresett. |
| fallback | | ✕ | The search couldn't be finished. | A keresést nem sikerült befejezni. |

### fetch_url

| Case | Code | Kind | English | Hungarian |
|---|---|---|---|---|
| a link from neither the person nor a search (on purpose) | `link_not_from_a_source` | – | Alfy opens only links you gave it or a search found, and this one was neither. | Alfy csak a tőled kapott vagy keresésben talált linkeket nyitja meg, ez pedig egyik sem volt. |
| site didn't answer in time | `site_timeout` | ✕ | The site didn't answer in time. | Az oldal nem válaszolt időben. |
| site turned Alfy away | `site_refused` | ✕ | The site wouldn't let Alfy in. | Az oldal nem engedte be Alfyt. |
| page gone | `page_not_found` | ✕ | That page doesn't exist any more. | Ez az oldal már nem létezik. |
| no readable text | `no_readable_text` | ✕ | The page had no text Alfy could read. | Az oldalon nem volt olvasható szöveg. |
| skipped on purpose, enough read already | `reading_budget_used` | – | Alfy had already read enough pages for this reply. | Alfy ehhez a válaszhoz már elég oldalt elolvasott. |
| fallback | | ✕ | The page couldn't be read. | Az oldalt nem sikerült elolvasni. |

### image_search

| Case | Code | Kind | English | Hungarian |
|---|---|---|---|---|
| picture search unavailable (for example the plan ran out) | `search_unavailable` | ✕ | The picture search isn't available right now. | A képkeresés most nem érhető el. |
| didn't answer in time | `search_timeout` | ✕ | The picture search didn't answer in time. | A képkeresés nem válaszolt időben. |
| nothing found (row meta, no body) | `nothing_found` | – | No pictures came up for this search. | Ehhez a kereséshez nem jött kép. |
| fallback | | ✕ | The picture search couldn't be finished. | A képkeresést nem sikerült befejezni. |

### memory_context

| Case | Code | Kind | English | Hungarian |
|---|---|---|---|---|
| a chat Alfy may not look into (on purpose) | `chat_out_of_reach` | – | Alfy can't look into that chat from here. | Abba a beszélgetésbe Alfy innen nem láthat bele. |
| nothing found (row meta, no body) | `nothing_found` | – | Nothing about this in your memory. | Erről nincs semmi az emlékeid között. |
| memory couldn't be read (also the fallback) | `memory_unavailable` | ✕ | Alfy couldn't look in your memory this time. | Alfy most nem tudott az emlékeid között keresni. |

### The nine account tools (Calendar shown; each tool puts its own name in)

| Case | Code | Kind | English | Hungarian |
|---|---|---|---|---|
| not connected | `not_connected` | – | Calendar isn't connected yet. You can connect it in Settings › Connections. | A naptár még nincs csatlakoztatva. A Beállítások › Kapcsolatok alatt csatlakoztathatod. |
| needs connecting again | `needs_reconnect` | ✕ | Calendar needs to be connected again. You can do it in Settings › Connections. | A naptárt újra csatlakoztatni kell. A Beállítások › Kapcsolatok alatt megteheted. |
| no account by that name | `no_such_account` | – | There's no connected calendar by that name. | Nincs ilyen nevű csatlakoztatott naptár. |
| the account didn't answer | `account_unreachable` | ✕ | Your calendar didn't answer, so Alfy couldn't look. | A naptár nem válaszolt, ezért Alfy nem tudott belenézni. |
| changes turned off | `writes_turned_off` | – | Changing your calendar is turned off. You can turn it on in Settings › Connections. | A naptár módosítása ki van kapcsolva. A Beállítások › Kapcsolatok alatt bekapcsolhatod. |
| details kept on the server (cloud model in use) | `details_kept_local` | i | The cloud model got a summary only, so the details stayed on your server. | A felhős modell csak összefoglalót kapott, így a részletek a saját szervereden maradtak. |
| asked the wrong way, corrected itself | `request_adjusted` | – | Alfy adjusted its request. | Alfy pontosította a kérést. |
| fallback | | ✕ | Alfy couldn't use your calendar this time. | Alfy most nem tudta használni a naptáradat. |

The Hungarian takes each account's own noun and its suffixes (naptár, levelezés, névjegyek, teendők, fotók, média, helyzet, kód, fájlok); write each tool's sentences out in full rather than building them from parts, since Hungarian suffixes change with the noun.

### produce_file (the file job card)

| Case | Code (today's, or new) | Kind | English | Hungarian |
|---|---|---|---|---|
| more files than one request may make | `too_many_outputs` | – | That's more files than one request can make. | Ez több fájl, mint amennyi egy kérésre elkészülhet. |
| source too large | `source_too_large` | – | The source is too large to turn into a file. | A forrás túl nagy ahhoz, hogy fájl készüljön belőle. |
| file type not supported | `unsupported_*` | – | That kind of file can't be made here. | Ilyen fájl itt nem készíthető. |
| took too long | the timeout codes | ✕ | Making the file took too long. | A fájl túl sokáig készült. |
| the file maker broke | `worker_*` | ✕ | The file maker ran into a problem. | A fájlkészítő hibába ütközött. |
| anything else (fallback) | | ✕ | The file couldn't be made. | A fájlt nem sikerült elkészíteni. |

Codes that already have words on the card keep them; the `*_limit_exceeded` codes get sentences of their own in the same voice.

### create_artifact (the "couldn't make this" card's line)

| Case | Code | Kind | English | Hungarian |
|---|---|---|---|---|
| as many new items as one reply allows | `reply_limit_reached` | – | Alfy has already made as many new items as one reply allows. | Alfy ebben a válaszban már annyi új elemet készített, amennyit lehet. |
| that kind can't be made | `kind_not_creatable` | – | That kind of item can't be made here. | Ilyen elemet itt nem lehet készíteni. |
| anything else (fallback) | | ✕ | This couldn't be made. | Ezt nem sikerült elkészíteni. |

### edit_artifact

| Case | Code | Kind | English | Hungarian |
|---|---|---|---|---|
| changed since Alfy read it (protects the person's changes) | `changed_since_read` | – | The document changed since Alfy read it, so Alfy left it as it was. | A dokumentum megváltozott, mióta Alfy elolvasta, ezért Alfy nem nyúlt hozzá. |
| a file, picture or video | `not_editable_as_text` | – | Files, pictures and videos can't be changed as text. | Fájlt, képet és videót nem lehet szövegként módosítani. |
| an App already rebuilt twice in this reply | `rebuild_limit_reached` | – | An app can be rebuilt twice in one reply. | Egy alkalmazás egy válaszban kétszer építhető újra. |
| the model sent a malformed change | `request_adjusted` | – | Alfy adjusted its request. | Alfy pontosította a kérést. |
| anything else (fallback) | | ✕ | The change couldn't be made. | A módosítást nem sikerült elvégezni. |

"The document" in the first line becomes "The board", "The app" and so on by kind; write each out.

### Atlas report rows

| Case | Code | Kind | English | Hungarian |
|---|---|---|---|---|
| the worker stopped and the job couldn't be restarted | `atlas_worker_heartbeat_timeout` | ✕ | The research stopped partway and couldn't be restarted. | A kutatás félúton leállt, és nem sikerült újraindítani. |
| the job couldn't start in time | `worker_queue_timeout` | ✕ | The research couldn't start in time. | A kutatás nem tudott időben elindulni. |
| anything else, `atlas_pipeline_failed`, `job_failed` and `no_verdict` included (fallback) | | ✕ | (existing `atlas.failed`) Atlas could not finish. Please try again. | (existing) Az Atlas nem tudott elkészülni. Próbáld újra. |

### Every tool (shared envelope codes)

| Case | Code | Kind | English | Hungarian |
|---|---|---|---|---|
| the person pressed Stop | `stopped` | – | You stopped this before it finished. | Ezt leállítottad, mielőtt befejeződött. |
| the tool's own time limit, where its table has no timeout sentence | `timed_out` | ✕ | This took too long, so Alfy stopped waiting. | Ez túl sokáig tartott, ezért Alfy nem várt tovább. |
| the turn's working time ran out during the step | `out_of_time` | – | The time for this reply ran out, so Alfy stopped here. | A válaszra szánt idő lejárt, ezért Alfy itt abbahagyta. |

### make_image (kinds change; one sentence changes)

| Case | Code | Kind | English | Hungarian |
|---|---|---|---|---|
| explicit request (on purpose) | `explicit_request` | – | (unchanged) Explicit pictures are not made here. | (unchanged) Szexuális tartalmú képek itt nem készülnek. |
| transparency not possible with the current picture model | `transparent_unavailable` | – | The current picture model can't make transparent pictures. | A mostani képmodell nem tud átlátszó képet készíteni. |
| the filter blocked the finished picture | `image_blocked` | – | (unchanged) It looked explicit, so it was not shown or kept. | (unchanged) Szexuális tartalmúnak tűnt, ezért nem jelenik meg, és nem maradt meg. |
| the filter couldn't check it | `image_unchecked` | ✕ | (unchanged) The picture could not be checked, so it was not shown. | (unchanged) A képet nem sikerült ellenőrizni, ezért nem jelenik meg. |
| every breakage code | `image_*` | ✕ | (unchanged, now also on the card) the `toolActivity.pictureReason.*` sentences | (unchanged) |
| a Stop | `imageStopped` | – | (unchanged verb) Picture stopped | Kép leállítva |

### make_video

| Case | Code | Kind | English | Hungarian |
|---|---|---|---|---|
| not clearly asked for a video (on purpose) | `not_asked_for` | – | Alfy wasn't sure you wanted a video, so it didn't make one yet. | Alfy nem volt biztos benne, hogy videót szeretnél, ezért még nem készített. |
| explicit request (on purpose) | `explicit_request` | – | Explicit videos are not made here. | Szexuális tartalmú videók itt nem készülnek. |
| a picture that isn't in the chat (row only: "Adjusting the video request") | `unknown_picture` | – | | |
| the server refused the request | `video_graph_rejected` | ✕ | The video server refused this request. | A videókészítő elutasította a kérést. |
| render failed | `video_render_failed` | ✕ | The video server couldn't make the clip. | A videókészítő nem tudta elkészíteni a klipet. |
| render took too long | `video_render_timeout` | ✕ | The clip took too long to make. | A klip túl sokáig készült. |
| result lost | `video_result_missing` | ✕ | The video server lost the clip. | A videókészítő elvesztette a klipet. |
| a starting picture is gone | `video_input_missing` | ✕ | A picture the clip starts from is gone. | Egy kép, amelyből a klip indul, már nincs meg. |
| the request couldn't be read | `video_request_invalid` | ✕ | The video request couldn't be read. | A videókérés nem olvasható. |
| deleted while being made | `video_item_deleted` | ✕ | The clip was deleted while it was being made. | A klipet készítés közben törölték. |
| couldn't be saved | the `video_media_*` codes | ✕ | The finished clip couldn't be saved. | Az elkészült klipet nem sikerült elmenteni. |
| made but not kept | `video_artifact_failed` | ✕ | The clip was made but couldn't be kept. | A klip elkészült, de nem sikerült megtartani. |
| its record went missing | `video_take_missing` | ✕ | The clip's record went missing. | A klip adatai elvesztek. |
| anything else, `video_error` included (fallback) | | ✕ | The video couldn't be made. | A videó nem készíthető el. |

The exact code spellings are in `normal-chat-tools/make-video.ts` (near lines 135-192) and the take's `errorCode`. `video_blocked` (now a quiet –), `video_unchecked` (✕), the server-unreachable / not-configured pair (✕) and `video_tool_timeout` ("The video is still being made") keep their words; `video_stopped` keeps "Stopped the video" and moves to the –.

### run_python

| Case | Code | Kind | English | Hungarian |
|---|---|---|---|---|
| ran out of time | `timed_out` | ✕ | The calculation ran out of time. | A számítás kifutott az időből. |
| stopped with an error | `program_error` | ✕ | The calculation stopped with an error. | A számítás hibával leállt. |
| calculations unavailable (also the fallback) | `sandbox_unavailable` | ✕ | Calculations aren't available right now. | A számolás most nem érhető el. |

### map_route

| Case | Code | Kind | English | Hungarian |
|---|---|---|---|---|
| outside the map areas | `out_of_coverage` | – | Routes can only be planned where Alfy has maps. | Útvonalat csak ott lehet tervezni, ahol Alfynak van térképe. |
| no route between the places | `no_route` | ✕ | No route was found between these two places. | Nem található útvonal a két hely között. |
| the map is still being prepared | `region_preparing` | – | The map for this area is still being prepared. Try again later. | Ennek a területnek a térképe még készül. Próbáld újra később. |
| the trip crosses map areas | `multi_region` | – | This trip crosses map areas, which isn't possible yet. | Ez az út több térképterületen halad át, ez még nem lehetséges. |
| the area's map is unavailable | `region_unavailable` | ✕ | The map for this area isn't available right now. | Ennek a területnek a térképe most nem érhető el. |
| no timetables for the area | `transit_unavailable` | – | There are no public transport times for this area. | Ehhez a területhez nincs tömegközlekedési menetrend. |
| a place not found | `place_not_found` | ✕ | Alfy couldn't find "Fő utca 99" on the map. | Alfy nem találta meg a térképen: „Fő utca 99”. |
| the map search is down | `geocoder_unavailable` | ✕ | The map search didn't answer. | A térképes kereső nem válaszolt. |
| fallback | | ✕ | The route couldn't be planned. | Az útvonalat nem sikerült megtervezni. |

### use_skill

| Case | Code | Kind | English | Hungarian |
|---|---|---|---|---|
| skill turned off | `skill_turned_off` | – | This skill is turned off. You can turn it on in Settings. | Ez a készség ki van kapcsolva. A Beállításokban bekapcsolhatod. |
| no skill by that name (row only, no body) | `skill_not_found` | – | | |
| fallback | | ✕ | The skill couldn't be loaded. | A készséget nem sikerült betölteni. |

### suggest_instruction

| Case | Code | Kind | English | Hungarian |
|---|---|---|---|---|
| already suggested | `already_offered` | – | Alfy had already suggested this one. | Alfy ezt már javasolta. |
| empty or too long | `empty_text`, `text_too_long` | – | The suggestion couldn't be offered. | A javaslatot nem lehetett felajánlani. |

### read_artifact and read_generated_file

| Case | Code | Kind | English | Hungarian |
|---|---|---|---|---|
| the item is gone | `item_not_found` | ✕ | That item isn't there any more. | Ez az elem már nincs meg. |
| the file isn't in this chat | `file_not_found` | ✕ | Alfy couldn't find that file in this chat. | Alfy nem találta ezt a fájlt ebben a beszélgetésben. |
| several files matched | `ambiguous` | – | Several files matched, so Alfy didn't guess. | Több fájl is egyezett, ezért Alfy nem találgatott. |
| fallback | | ✕ | That couldn't be read. | Ezt nem sikerült elolvasni. |

## 6. How the rule is held

- **One registry of failure words** for the browser: per tool name, a closed map from reason code to its kind (✕, –, i) and its i18n key, plus the tool's fallback key, with the three shared envelope codes (`stopped`, `timed_out`, `out_of_time`) in every tool's list unless the tool words that case itself. It extends what `IMAGE_REASON_KEYS` and `videoReasonKey` already do and replaces both, and it is pure and browser-safe, beside `tool-activity.ts`.
- **The server names every case.** Each tool keeps one closed list of reason codes (an exported `as const` list or union) and writes the code on the segment's metadata for every failure and refusal, in one field shared by all tools (for example `metadata.reasonCode`). `imageError`, `imageRefusal`, `videoError` and the file job's `error.code` may stay where they are and be read as the code. Where a tool today only throws or returns text, it starts naming its cases (research_web, fetch_url, image_search, memory_context, the nine account tools, run_python, map_route, use_skill, the two read tools, create_artifact and edit_artifact).
- **The raw error stays in the log.** Every path that turns an error into a code logs the raw cause with the tool's name and the code, under the existing prefixes (`[CHAT_STREAM]`, `[FILE_PRODUCTION]` and the tools' own), and without inputs, queries, addresses or results (the owner's content-free rule for what is read from production).
- **The test** sits beside the dictionary test of `TOOL_ACTIVITY_I18N_KEYS` and fails when:
  1. a reason code in any tool's server list has no registry entry;
  2. an entry's key does not resolve in both English and Hungarian;
  3. a tool in the model's catalogue (the names in `tool-catalogue.en.snapshot.txt`) has no fallback;
  4. raw text reaches a row: for every tool name, a failed and a refused segment whose `outputSummary`, `metadata.error` and inputs carry a sentinel string is built into a row, and no string in the resulting view-model (verb, object, suffix, meta, title, every body string) contains the sentinel.

  A new tool therefore cannot ship without its words, and a new code cannot ship without its sentence.

## 7. Constraints

- **The model sees exactly what it sees today.** `outputSummary`, the model payloads, the refusal texts and the tool catalogue stay as they are: the catalogue is the cached prompt prefix (`tool-catalogue.en.snapshot.txt`, held by `normal-chat-tools/index.test.ts`), and `outputSummary` is replayed to the model in later turns (`chat-turn/conversation-history.ts:81`). New display fields (the reason code, run_python's display copy) are written on the segment for the browser and never put into a model request. Model-facing text stays English (ruling 79); every word a person reads comes from i18n.
- **Stored history.** Rows saved before this change carry no reason codes. They render their tool's fallback line (or the success body where their data allows it), never raw text, and never throw.
- **ADR-0068** for any picture a row loads (the image search thumbnails): addresses from a tool's result only, the established thumbnail path, and never a favicon for an address the model only gave.
- **What a Turn Made (F16).** Deliverable rows and cards keep their place below the prose; nothing is inserted above a streaming reply.
- **Hungarian copy:** short and natural, fits a 360 and 390 px row (measure), no word repeated between a heading and its title.
- **The Feature Guide.** Check `guide-content.ts` for anything that pictures or describes tool rows, and update its entry and drawing in the same change if so.

## 8. Not in this design

Non-goals:
- Errors anywhere outside the tool rows: the later backlog item.
- An "uncertain" row state for steps that may or may not have run (proposed in the brainstorm and dropped by the owner).
- The notice under a reply that ended without an answer ("The model stopped before writing its answer. Retry the message."): app-wide, the backlog item.
- What any tool does, or what the model reads.

Anti-goals (a failure even if everything else works):
- A code, an id, an exception, an HTTP status or an English note for the model reaching a person.
- A red ✕ for a stop the app made on purpose.
- A row that dumps everything, or a body that only repeats its row.
- Words in one language only.

## 9. Calls I made (the owner approved the screens; these are mine to check)

- **The two sentences leave every row.** The first screen asked "keep them or drop them" and was not answered by a click; both screens drew every proposed row without them, and both were approved.
- **A setting the person can change** (not connected, changes turned off, a skill turned off) is the quiet –, not the red ✕.
- **The transparency sentence loses its Admin hint for everyone.** The alternative is to keep "Switch the Admin "Picture model" to Qwen." for admins only.
- **The image search shows thumbnails**, not a list of titles.
- **The instruction-suggestion row and the read rows do not open.**
- **Python shows what it printed**, which needs the bounded display copy.
- **The sentences themselves**, in both languages (the owner read them on the screens).

Settled after the builder check (the reviewer's questions that a sensible builder could settle, or that the approved screens and rule already answer):
- **The elapsed time leaves every row**, as the approved screens draw it (section 3).
- **An account row counts what came back across the run** ("Calendar · 3 events"), as the screen draws it; "N actions" only when nothing countable came back.
- **A refused create follows its code's kind**: the per-turn cap is a quiet –, though the second screen drew it red.
- **make_image gets the whole rule**, not only its transparency sentence: its stops and the filter's block become a quiet –, and the picture and clip cards show each code's sentence instead of "Couldn't make this one." "Couldn't be checked" (`image_unchecked`, `video_unchecked`) stays ✕: the check failed, and later it may not.
- **A Stop is a quiet – for every tool**, pictures and clips included (today they draw it with a ✓). The tool's own timeout is ✕, and the turn running out of time is a quiet –, with the three shared sentences in section 5, which no screen showed.

## 10. Left to the builder

- The reason codes' exact names and the shared metadata field's name.
- How each provider's errors (HTTP statuses, exception types, Parallel's and Brave's error shapes) map to the cases.
- The list caps (5 named things, then "and N more"; 8 thumbnails) and run_python's display-copy limit.
- The connector action phrases for every action of the nine tools, in both languages.
- Where the registry lives, the test's layout, and how the build is sliced into a plan.

## 11. Found on the way (separate from this design)

- The web sources' "cited" tick never lights: nothing writes `candidate.status`, and the cited state lives in `message.evidenceSummary`. A small fix of its own.
- `toolElapsedLabel`'s comment in `tool-activity.ts` says no timing rides on a segment; `metadata.durationMs` does (`normal-chat-tools/shared.ts`). Moot once the elapsed time leaves the rows: `toolElapsedLabel` can go with it.
