# Read aloud — design

**Date:** 2026-11-16 · **Status:** approved by the owner, section by section, in the design session of 2026-11-16 · **Reference files:** [`2026-11-16-read-aloud/`](2026-11-16-read-aloud/) (clickable prototypes and pictures) · **Infrastructure handoff:** [`docs/tts-zonos3-handoff.md`](../../tts-zonos3-handoff.md)

Marks used below: **(owner)** the owner decided it; **(my call)** proposed in the session and not objected to, so it stands unless the owner says otherwise; **(builder)** left to whoever builds it.

---

## 1. Intent

Every AlfyAI reply can be listened to. A person presses a speaker on a reply, hears it in a good voice in the reply's own language (English or Hungarian), sees where the reading is, and controls it: pause, step a sentence, drag to any sentence, change the speed, jump back to the text. It plays while the page is open. People can also make their own voices by adjusting a few audible qualities of a built-in voice.

Why: AlfyAI is a family assistant. Replies are often long, and people want to listen while doing something else, or follow along while reading. Half the conversations are in Hungarian (ruling 79: the model answers in the person's language), so an English-only voice would leave the assistant mute in half its chats.

The voice model is already running: ZONOS3-Mini on the GPU box at `127.0.0.1:1919`, beside vLLM, with its waveform decoder on the CPU (handoff, §"Verified live state"). AlfyAI does not know it exists yet.

## 2. Goals, non-goals, anti-goals

**Goals**
- A read-aloud button on every finished reply; sound within about a second of pressing it.
- Following along: the sentence being read is tinted and the word being spoken is marked, in English and Hungarian.
- Full control from a floating player: pause, previous and next sentence, a sentence scrubber, speed, jump to the reading, stop.
- Six built-in voices (owner): British woman and man, American woman and man, Hungarian woman and man.
- Personal voices made from a built-in voice with five knobs and seven style presets.
- Every failure is quiet, explained, and recoverable, and never touches the chat itself.

**Non-goals for this version** (owner unless marked)
- Talking to AlfyAI by voice, a microphone, or cloning anyone's voice (owner: "no microphone wizardry").
- Replies reading themselves out as they arrive (my call).
- Reading a reply while it is still being written; the button appears when the reply is finished (my call).
- Downloading the audio; switching voice from inside the player (my call).
- Languages other than English and Hungarian (my call; adding one later means adding its voices, not code).
- Listening with the page in the background, the screen off or the phone locked, and lock-screen media controls (owner: cut, because there is no iPhone to test background audio on).

**Anti-goals** — it fails even if it works when:
- A reading slows down or breaks a chat turn. Speech is an auxiliary service and degrades gracefully (`AGENTS.md`, Known Traps).
- Markdown or any other syntax is spoken ("asterisk asterisk") (owner).
- An English voice reads Hungarian, or the other way round: it sounds off (owner, after listening).
- The screen jumps or flickers: nothing in the thread moves except on purpose and smoothly (owner).
- A custom voice stops sounding like a person: every knob is limited to its measured safe range.
- Audio of anyone's replies is stored (my call).

## 3. Constraints

- **The voice server** (handoff): ZONOS3-Mini, ggml build, `zonos3.service`, loopback only. `--batch 2`: two syntheses at once, others queue first-in-first-out. `--max 1500`: about 100 s of audio per request, after which it truncates silently, so requests are per sentence. Output is streamed float32 PCM at 44.1 kHz mono, or buffered 16-bit WAV. vLLM must not be touched; the operational rule "stop `zonos3` before restarting `vllm-flashnext`" stands.
- **Model behaviour, from its source and from our tests** (details in §9):
  - no word or sentence timestamps are returned;
  - `language` must be sent explicitly (`en_us` or `hu`; the default is American English) and only chooses the text-normalization rules;
  - `speaker_mode` defaults to `reference`; send `embedding`, which the voice knobs need;
  - unknown request fields are refused (422);
  - inputs of one or two words misfire;
  - the same seed gives byte-identical audio.
- **The box's memory is tight** (swap pressure has happened before). Anything new on it gets a memory budget and a measurement.
- **Repository rules** apply as everywhere:
  - runtime settings through `env.ts` → `config-store.ts` → admin loaders → README and `.env.example`;
  - every new string in English and Hungarian;
  - Svelte 5 runes; Lucide icons only;
  - a Feature Guide entry with its drawing and a Show me marker;
  - the gates in `scripts/gates.sh`;
  - an ADR (next free number: **0070**).

## 4. The experience

The clickable prototypes in the reference folder are the visual source of truth; this section states what they show so nothing depends on opening them. Motion uses the app's tokens (`--duration-micro` 100 ms, `--duration-standard` 150 ms, `--duration-emphasis` 250 ms; `--ease-out`, `--ease-emphasis`, `--ease-in`); under reduced motion every movement is instant, as the tokens already do.

### 4.1 The speaker on a reply (owner)

- A new icon in the reply's action row, after Copy (my call on position), same size and style as its neighbours (Lucide `Volume2`, 15 px).
- States:
  - ready: speaker
  - getting the voice: spinner, the app's `mini-spinner`
  - reading: pause icon inside a thin ring that fills with progress
  - paused: play icon, the ring kept
  - finished: back to the speaker
- While its reply is being read, the row stays visible even without hover (my call).
- Shown only on finished replies. A reply drawn in segments ("Ask me first") is read as one reply from its last segment, the way Copy treats it (my call).
- Dimmed on a reply whose language has no voice; see §4.8.

### 4.2 Following along in the text (owner)

- **Sentence:** the sentence being read gets a soft accent tint (`rgba(193,95,60,.12)` in light theme; a token pair for both themes is the builder's), and crossfades to the next sentence (150 ms).
- **Word:** the word being spoken gets a stronger mark that glides along the line (90 ms) and jumps without sliding when the next word is on a new line. Word times come from the forced aligner (§6.4), never from an estimate: the owner compared both and rejected the estimate.
- **No layout change, ever.** Marking must not change the reply's DOM in a way that reflows text; draw marks as an overlay or with the CSS Custom Highlight API (builder).
- **Stacking.** Marks live inside the message area's stacking context and can never paint over the composer layer. In the prototype a `z-index` on word spans did exactly that and made the player look transparent; the owner called it a bug.
- **First sentence.** Its words arrive about half a second after its audio starts (alignment time), so the first sentence may begin with only the sentence tint (my call).
- **After the end, after ✕, or when another reply starts:** the marks fade out (150 ms).

### 4.3 The floating player (owner)

**Where it lives.** It sits above the message box, inside the composer layer (`ChatComposerPanel`'s `composer-shell`), so the layer's measured height includes it. Everything that already follows that height moves with it: `MessageArea`'s scroll clearance, the jump-to-latest button, and the narrow-chat capsule.
- **Opening:** its slot opens by animating `grid-template-rows` from `0fr` to `1fr` (250 ms, emphasis easing), so the thread makes room and nothing hides behind the player.
- **Following:** a reader pinned to the bottom of the thread follows it down.
- **Backdrop:** while something reads, the composer column (the `composer-shell` width, not the full layer, so the thread's scrollbar stays clear) gets a page-coloured backdrop that fades in over 20 px above the player. Nothing in the thread shows through around it.

**Desktop layout** (one row, about 54 px tall, `width: min(620px, 100%)`, 28 px radius):
- `⏮ ▶/❚❚ ⏭`, where ⏮ and ⏭ are the previous and next sentence;
- `0:09 ── scrubber ── 0:24`: the elapsed time and the total on either side of the scrubber;
- `⌖` (Lucide `LocateFixed`): jump to where it is reading;
- the speed chip;
- `✕`: stop.

Buttons are 40 px with 6 px between them. Play and pause is a 40 px circle with a soft accent fill (accent at 14% on white, accent icon).

**Phone layout** (two rows, about 108 px tall, 24 px radius):
- top row: the elapsed time, the scrubber, the total time;
- bottom row: the speed chip on the left, `⏮ ▶/❚❚ ⏭` in the middle (44 px buttons, play and pause a 52 px circle), `⌖ ✕` on the right.

The breakpoint is the one the chat already uses for narrow layouts (builder).

**No text in the player** (owner: the reply already shows it).

**The scrubber** (owner):
- **Notches:** sentence starts show as notches on the line.
- **Dragging:**
  - The handle follows the pointer exactly (updates coalesced per animation frame), the fill follows the handle, and the notch it will land on lights up.
  - The sentence under the pointer gets a stronger tint and a thin outline in the reply.
  - A dark bubble above the handle says `4/9 · Feed it once a day…` and stays inside the player's edges.
  - If that sentence is off screen, the thread follows it with one continuous damped scroll (never a stack of smooth scrolls).
  - Reading pauses while dragging and resumes on release.
- **Release:** the handle glides onto the notch (250 ms, emphasis easing) and reading continues from the start of that sentence.
- **Tap:** a tap on the line jumps the same way.
- **Keyboard:** the scrubber is a `role="slider"` with `aria-valuetext` "Sentence 4 of 9"; ← and → step a sentence, Home and End go to the first and last.

**Before the later sentences exist** (my call, after the spec review). Synthesis runs only about two sentences ahead of playback (§6.3), so the real lengths of later sentences are unknown when the player opens, and after a jump the lengths of everything before it are unknown too. So:
- **Notches** are placed by each sentence's share of the reply's text and never move.
- **The scrubber** turns a pointer position into a sentence by the same share.
- **The speaker's ring and the scrubber's fill** follow the share of text already read: the sentence and the word within it.
- **The elapsed time** is real, from the audio clock.
- **The total time** is an estimate from the text's length and the voice's measured speaking rate. It is shown as "≈0:54" and quietly corrected as sentences are made; it is the only number that may change, and nothing moves because of it.

**Speed** (owner):
- The chip opens the speed menu: 0.75×, 1×, 1.25×, 1.5×, 1.75×, 2× (the first mockup).
- Changes apply at once without re-making audio, with pitch kept: the browser's `playbackRate` with `preservesPitch`.
- The player's speed lasts for that reading only. Every reading starts at the person's **Default speed** (Settings, §4.7), which is 1× unless they changed it.

**Behaviour** (all approved in the clickable prototype):

| Moment | What happens |
|---|---|
| Start | The speaker spins until the first audio arrives, then the ring appears and the player rises 8 px while fading in (250 ms) as the thread makes room. |
| ✕ | Reading stops; the player sinks 6 px and fades (150 ms, ease-in); its room closes; the marks fade; the speaker returns. |
| The end | The ring fills, "Finished" shows in the player for about 1.1 s, then it leaves as on ✕. |
| A slash command (`/` opens the command tray) | The player fades out in 100 ms and keeps its room; reading continues and the reply's marks keep showing where it is; the player fades back when the tray closes. |
| Typing several lines | The composer grows; the player rides up with it. |
| Sending a message while it reads | Reading continues; ⌖ brings you back. |
| Another reply's speaker | The first reading stops and its marks fade; the player stays where it is and only its time and notches change: no exit and re-entry. |
| ⌖ | The thread scrolls (damped) so the sentence being read sits in the middle of the area above the composer layer. |
| Leaving the chat | Reading stops (my call). |
| The reply being read is edited, regenerated or deleted | Reading stops (my call). |

**Read from here** (owner):
- Selecting any text in a reply shows a floating dark pill, "▶ Read from here", that never moves a word.
- Desktop: it sits above the selection. Phone: below it, because the phone's own copy menu takes the space above.
- It starts reading at the beginning of the sentence the selection starts in and reads to the end of the reply.
- It works while another reading plays (that reading stops).

**The thread does not scroll by itself** to follow the reading (my call); ⌖ is the way back.

### 4.4 What gets read (owner)

The spoken text is built from the reply **as rendered on screen**, never from its Markdown source, so no Markdown syntax reaches the voice. Anything awkward or meaningless to hear either gets a spoken form or is left out (owner, 2026-11-16; refined so code lessons can be listened to).
- **Where it happens:** in the browser, while building the speech script (Plan 2). The speech service is unaffected.
- **Marks follow along:** every spoken form maps back to its place on screen, so the word mark covers, for example, a whole code name while its words are said.

**Read as written:**
- paragraphs and quotes, with text in brackets read normally;
- headings, followed by the same pause as a new paragraph;
- list items and checklist items: a numbered list reads its numbers ("One. Mix the flour…"), bullets are silent;
- the text of links, and inline emphasis as plain words.

**Code, read the way a teacher says it out loud** (one shared code-reading dictionary, in English and Hungarian):
- **Inline code** (in ticks inside a sentence) is always read.
  - **Names** are split into words: `ArrayList` "Array List", `getUserName` "get User Name", `user_id` "user id", `MAX_SIZE` "max size".
  - **Symbols:**
    - `.` "dot" / "pont"
    - `::` "double colon"
    - `->` and `=>` "arrow"
    - `=` "equals", `==` "double equals", `===` "triple equals", `!=` "not equals"
    - `&&` "and", `||` "or"
    - `|` "pipe" (in shell commands)
    - `*` "star"
    - `/` "slash" (in paths)
    - `<T>` "of T": a `<…>` straight after a name is a generic
    - `<` "less than", `>` "greater than", `<=` "less than or equal", `>=` "greater than or equal"
    - `+` "plus", `-` "minus" (silent inside a hyphenated name like `my-class`), `++` "plus plus", `--` "minus minus", `+=` "plus equals", `-=` "minus equals"
    - `!` "not", `%` "mod"
    - brackets are silent, and any other symbol is dropped. So `if x < 10` reads "if x less than ten", in Hungarian with the dictionary's Hungarian words.
  - **Abbreviations, per language.** The starting list:
    - Java: `println` "print line"; C#: `Console.WriteLine` "console dot write line"
    - Python: `def` "define", `elif` "else if", `__init__` "dunder init", `kwargs` "keyword args", `len` "length"
    - JavaScript / TypeScript: `console.log` "console dot log", `NaN` "not a number"
    - C / C++: `printf` "print f", `std::cout` "standard c out", `#include` "include"
    - Go: `fmt.Println` "format dot print line", `:=` "colon equals"
    - Rust: `fn` "function", `mut` "mutable", `println!` "print line"
    - Kotlin / Swift: `fun`, `func` "function"
    - PHP: `$name` "name"
    - SQL: `SELECT *` "select star"
    - shell: `chmod` "change mode", `~` "home"
    - HTML / CSS: `<div>` "div tag", `.class` "dot class"
  - **Acronyms** as people say them: SQL, JSON "Jason", API, URL, HTML, CSS, npm, YAML, GUI "gooey".
  - **Long hashes, IDs and keys** (12 or more characters of random letters and digits) are skipped.
- **Code blocks:** up to three lines are read in the same style, and longer blocks are skipped silently. Selecting text inside any code block and pressing Read from here reads it, however long, because the person asked for it explicitly.

**Given a spoken form:**
- **Addresses:** a bare URL reads only its site name ("example dot com"); an email address reads as "name at site dot com"; a file name as "report dot pdf".
- **Abbreviations:**
  - Hungarian: "pl." "például", "kb." "körülbelül", "stb." "és a többi", "ún." "úgynevezett", "ill." "illetve", "db" "darab".
  - English: "e.g." "for example", "i.e." "that is", "etc." "et cetera".
- **Symbols in prose:** × "times" / "szorozva", ÷ "divided by" / "osztva", ± "plus or minus" / "plusz-mínusz", ≤ ≥ ≠ ≈ by their names, ² "squared" / "négyzet", ³ "cubed" / "köb", ½ "half" / "fél", ° "degrees" / "fok", % "percent" / "százalék".
- **Keyboard shortcuts:** "Ctrl+C" "Control C", "⌘K" "Command K", "Shift+Enter" "Shift Enter".
- **Versions:** "v2.3.1" "version two point three point one".
- **Arrows and separator dots between items:** a short pause.

**Left out silently:**
- tables (Markdown and CSV), charts, Mermaid diagrams and formulas;
- images; document, app, canvas, picture and file cards; map routes;
- tool and thinking rows, Sources, follow-up chips, the "Ask me first" card and any button;
- emoji, and citation and footnote markers.

**Numbers, dates, money and units** go to the speech service's text clean-up (zyphra-textnorm with the Hungarian "két" fix). Ranges like "7–12 fok" and Hungarian suffixes get a listening check during the build.

**English terms inside a Hungarian paragraph** are read by the Hungarian voice, because voices switch per paragraph, not per word. Accepted (owner).

**Sentences:**
- **Splitting:** with `Intl.Segmenter` in the paragraph's language. A period after a number ("2026. november 16.", "3. fejezet") or after an abbreviation from the lists above never ends a sentence.
- **Short sentences:** a sentence of one or two words joins the next one, because Zonos misfires on them. Since 2026-11-17 (the owner's call, after measuring: Zonos stalls or goes on speaking past a short text) a unit under about 50 written characters joins a neighbour: a sentence the next one of its paragraph, a list item the next item of its list, a paragraph of one sentence ("Sure!") the first sentence of the next paragraph, or the one before when it has no next to take; never across a heading, a code line or a language, and never into a unit over the 240-character split. Where the first part ends in no pause mark the join gives it a full stop; the pause between the parts is then the stop's, not the longer gap before a paragraph or an item. The tint covers the joined unit; word marks stay per word.
- **Long sentences:** a sentence over 240 characters is split at a comma or semicolon. Measured on the box, that keeps every clip under 30 s even at the slowest Pace.
- **Every unit ends in a stop:** Zonos can end a clip before the last words of a text that ends in no mark (the last item of a joined list was never said; the same text ending in a full stop is read in full). So the last step of the speech script gives a unit that ends in no mark a full stop and replaces a closing comma, semicolon or colon with one; `.`, `!`, `?` and `…` stay. Only punctuation changes, so the containment check is unaffected, and the stop counts towards the 240 characters.
- **One set of boundaries** drives the notches, the tint and Read from here.

### 4.5 Voices (owner)

| Built-in voice | Language | Zonos speaker id |
|---|---|---|
| Imogen · British woman | English | `default_b78b28baf5c31a1d` |
| Rupert · British man | English | `default_3765f0d1140c05c0` |
| Savannah · American woman | English | `default_de4d191ca7574982` |
| Wyatt · American man | English | `default_34370fd91e3484ef` |
| Berta · Hungarian woman | Hungarian | made from the Berta 1.0 dataset (§8) |
| Imre · Hungarian man | Hungarian | made from the Imre 1.0 dataset (§8) |

- **One language per voice.** A voice only ever reads its own language (owner). The feature ships with both Hungarian voices made; there is no "coming soon" (owner).
- **Language, per paragraph** (owner). Each paragraph (heading, list item, quote) is read in the voice of its own language, so a Hungarian reply containing an English email switches to the person's English voice for the email and back.
  - A short paragraph, below a length the builder sets, takes the language of the paragraph before it.
  - A paragraph in a language without a voice is skipped silently (my call).
  - A reply with no paragraph in a language that has a voice gets the dimmed speaker and its note (§4.8).
- **The detector** (owner: approved as a documented exception). Read aloud gets its own language detector, used only to choose voices and normalization rules. It must name languages beyond English and Hungarian, so the note can say "German". The chat's reader, `readReplyLanguage`, knows only English, Hungarian or unknown; in the spec review it read a German paragraph as English, which would have had the English voice read German.
  - **The exception:** `src/lib/server/services/chat-turn/AGENTS.md` forbids a second reader beside the chat's, so the exception is written there: the read-aloud detector never feeds anything the chat decides.
  - **Builder's part:** which library, where it runs, and how results are kept. The speaker must still be dimmed *before* pressing whenever a reply's languages are known.
- **Consistency** (my call): every request uses `speaker_mode: "embedding"` and a fixed seed, so a voice sounds identical every time; seed-to-seed variation is clearly audible. Every voice is matched to the same loudness, because the built-in voices differ by up to 17 dB.
- **Where the list lives.** The built-in list is configuration in code, one entry per voice, not an admin screen (my call).

### 4.6 Personal voices: the editor (owner)

A personal voice is a built-in voice plus five knob settings and a name. It is visible only to the person who made it (owner). The editor opens from Settings → Read aloud: "＋ New voice", or Edit on a saved voice. It is a dialog on desktop and a full-height sheet on a phone, built from the app's own dialog shell and scroll styling (builder).

**Start from.** The built-in voices as cards grouped by language (English: four; Hungarian: two), each with its own ▶ to hear it. A personal voice belongs to its base voice's language.

**A style to start with.** These are chips that set all five knobs at once; the sliders animate to their new places over 260 ms. The values are starting points the owner liked by ear in the prototype; tune them with the Hungarian voices too (builder).

| Style | Pace | Pitch | Depth | Energy | Projection |
|---|---|---|---|---|---|
| Original | 0 | 0 | 0 | 0 | 0 |
| Bedtime | −1 | 0 | 1 | −2.5 | −0.6 |
| Storyteller | −0.5 | 0 | 0 | 1.5 | 0.5 |
| Brisk | 1.25 | 0 | 0 | 1 | 0.5 |
| Calm and clear | −0.5 | 0 | 0 | −1.5 | 1 |
| Cheerful | 0.5 | 0.5 | 0 | 2.5 | 0.5 |
| Newsreader | 0.25 | 0 | 1 | −0.5 | 1.5 |

**Shape it: five sliders** (owner, chosen after listening to all 25 controls):

| Slider | Ends | Range | Request controls | Words shown, from low to high |
|---|---|---|---|---|
| Pace | Slower · Faster | −2…2 | `delivery.tempo` = v | Much slower · Slower · A little slower · Normal · A little faster · Faster · Much faster |
| Pitch | Lower · Higher | −2…2 | `pitch.pitch` = v | Much lower · Lower · A little lower · Normal · A little higher · Higher |
| Depth | Normal · Deeper | 0…4 | `texture.deep` = v | Normal · A little fuller · Deeper · Much deeper |
| Energy | Calmer · Livelier | −4…4 | `mood.arousal` = v | Very calm · Calm · A little calmer · Normal · A little livelier · Lively · Very lively |
| Projection | Softer · Projected | −1.5…2 | v < 0: `delivery.whisper` = −v; v > 0: `delivery.loud` = v | Breathy · Softer · A little softer · Normal · A little clearer · Clearer · Projected |

The band edges are in the prototype (`voice-editor-prototype.html`, `KNOBS`).
- **Words, not numbers.** Each slider shows its word on the right, in accent colour once it has moved.
- **Track:** the accent runs from the "normal" notch to the handle.
- **Snapping:** a soft snap to normal within 4% of the range.
- **Resetting:** each moved slider gets a ↺, and there is a Reset all.
- **Embedding mode:** Pitch and Depth need `speaker_mode: embedding`.
- **Pitch up is weak:** raising pitch barely moves the woman's voice and did nothing in Hungarian, which is why its upper word stops at "Higher".
- **Calibration:** the doses may need a per-language calibration once the Hungarian voices exist (builder, by ear).

**Listen:**
- **Rendering:** letting go of a slider renders the sample and plays it ("Play after each change", on by default). It took about a second on the owner's Mac.
- **Yours / Original** switches between this voice and its untouched base.
- **"Use my own words"** reads a sentence the person types; at most 300 characters (my call).
- **The player:** the preview uses the same player component as replies, scrubber included (owner).
- **Sample:** a two-sentence sample per language, the English one ending in a question so intonation is audible. The Hungarian sample is the builder's, checked by the owner.

**One sound at a time.** Every ▶ on the screen pauses on a second press, its icon follows the state, and starting any sound stops whatever else is playing (owner).

**Name.** It is suggested until the person types: the style's name when one matches ("Bedtime Imogen"), else the two biggest changes ("Imogen, slower and very calm"). At most 40 characters.

**Footer:**
- New voice: Cancel · **Save voice**.
- Editing: Delete (left) · Save as new · **Save changes**. On a phone, Cancel is dropped because ✕ closes.

**Deleting.** Delete asks first. Readings that used the voice fall back to its base voice.

### 4.7 Settings → Read aloud (owner)

A new card in the Profile tab, after Preferences (my call), titled **Read aloud**:
- **English voice:** a picker with the built-ins and then "Yours".
- **Hungarian voice:** the same, for Hungarian.
- **Default speed:** "Every reading starts at this speed"; 1× unless changed.
- **Your voices:** each with ▶ (plays its sample with its settings), Edit, and "＋ New voice". When empty: "Make a voice of your own: start from one of the built-in voices and change how it sounds. Only you will see it."

### 4.8 When something goes wrong (owner)

Amber, not red: red is reserved for actions where the person loses something. Shown in `v4-*.png` and `player-prototype.html`.

| Situation | What the person sees |
|---|---|
| The reply's language has no voice | The speaker is dimmed; hover, or a tap on a phone, shows a calm note: "Read aloud isn't available in German yet." (the language name localized). |
| The voice is busy | The spinner runs; after 2.5 s a calm note above the speaker: "The voice is busy with another reading. Yours starts in a moment." It goes away when reading starts. |
| It can't start (service down, error) | The speaker turns into a crossed-out speaker (Lucide `VolumeX`) in amber, with a note: "Couldn't start reading. The voice isn't answering right now." and **Try again**. The note closes on ✕, on a click elsewhere, or after 8 s; the speaker returns to normal after 3 s. |
| It stops while reading | The player stays; its edge turns amber and play becomes **Try again** (Lucide `RotateCcw`). A note above it: "Reading stopped. The voice stopped answering. Try again". The sentence stays tinted; Try again, or dragging the scrubber, restarts at the start of a sentence. |
| The connection drops | A calm note above the player, without Try again: "You're offline. Reading continues when you're back." Play shows a spinner, and reading resumes by itself when the browser is back online. |
| AlfyAI updates (a deploy drains and restarts the server) | "AlfyAI is updating. Reading continues when it is back." Resumes by itself, using the app's existing update watch (`stores/server-update.ts`, `client/server-update-watch.ts`). |
| Word timing fails | Nothing is shown; the sentence tint continues without the word mark. |
| Editor: the sample fails | Next to Play: "Couldn't play the sample. Try again." |
| Editor: saving fails | Next to Save: "Couldn't save this voice. Try again." The editor stays open with everything kept. |
| A personal voice's base voice was removed | In Settings, under the voice: "⚠ Imogen isn't available any more, so this voice reads as your English voice for now." |
| The feature is switched off by the admin | No speaker anywhere and no Read aloud card; nothing else changes. |

All notes are `role="status"`. Every string exists in English and Hungarian.

### 4.9 Only with the page open (owner)

- **Target browsers** (owner): the family uses AlfyAI in a normal browser tab, not as a home-screen app:
  - on iPhone: Safari, Chrome and Firefox;
  - on Android: Vivaldi and Firefox.
- **The page must stay open** (owner, 2026-11-16). There is no iPhone to test background audio on, so listening with the page hidden is cut. When the page is hidden (another tab, another app, the screen locked), reading pauses: the speaker and the player show paused, and play resumes from the start of that sentence (my call).
- **Interruptions:** an incoming call or unplugged headphones pause the reading the way the browser does.
- **No lock-screen controls:** this version has no lock-screen or media-session controls.

### 4.10 Privacy (my call)

No audio is written to disk anywhere. The browser keeps fetched audio in memory only for replays while the page is open. Logs carry no reply text. Incognito chats can be read aloud the same way and keep nothing.

### 4.11 Feature Guide (repo rule)

A guide entry for reading aloud and for personal voices, in English and Hungarian, with the section drawing updated for the new speaker icon and a Show me spotlight marker on it (`src/lib/components/guide/AGENTS.md`). Wording is the builder's, reviewed by the owner.

## 5. Admin

- `TTS_ENABLED` (default `false` until the Hungarian voices are in and the owner signs off on staging) and `TTS_URL` (the speech service address), through `env.ts` → `config-store.ts` → the admin System pane, plus README and `.env.example` (my call; the four-place rule in `AGENTS.md`).
- No per-user switch: the speaker is there for everyone when the feature is on (my call).

## 6. How it works

### 6.1 Shape

```
browser                         AlfyAI server (SvelteKit)            GPU box, loopback
───────                         ─────────────────────────            ─────────────────
reply DOM ─► speech script ──►  session route: auth, checks ──────►  speech service ──► Zonos :1919
(sentences + word ranges)        (message access, containment)       (normalize, synthesize,
<audio> ◄── progressive stream ◄─ proxy ◄──────────────────────────   align, encode)   FuseAlign
marks  ◄── timeline events  ◄──── proxy ◄──────────────────────────
```

- **The speech script** (browser): the sentences of §4.4, each with the DOM ranges of its words, built from the rendered reply. It is what gets marked, and its text is what gets spoken.
- **The session route** (server):
  - checks that the person may read the message;
  - checks that every sentence's letters occur in that message's text in order, so the route is not a free text-to-speech service;
  - resolves the voice (built-in id plus knob controls), the language and the speed;
  - opens a reading session starting at sentence *n*.
  
  A jump is a new session from another sentence; the old one is cancelled. One reading per person at a time.
- **The speech service** (new, on the GPU box, loopback only) owns everything close to the model:
  - text normalization (zyphra-textnorm, plus the Hungarian fixes of §9.3);
  - synthesis, by calling Zonos per sentence with `text_normalization: false` on the already-normalized text, so the voice and the aligner see the same words;
  - word alignment (FuseAlign) mapped back to the written words;
  - loudness matching;
  - encoding to the stream format.
  
  It is the provider boundary the handoff asked for: the model behind it can change without touching AlfyAI.
- **The browser** plays the stream in one `<audio>` element and maps `currentTime` through the timeline events to the sentence and word to mark.

The contract between the server and the speech service, and the exact protocols, are the builder's, within §6.2–§6.5.

### 6.2 Audio transport (builder, within these requirements)

- **Playback with the page open** in the five target browsers; nothing has to survive a hidden page (§4.9). One progressive stream per session into an `<audio>` element, or audio per sentence, is the builder's choice. The iPhone browsers' behaviour with the page open can be checked in the iOS Simulator on the owner's Mac.
- **Speed:** `playbackRate` with `preservesPitch`.
- **First audio:** about a second from pressing the speaker. Zonos streams frames, and its first audio bytes measured 20–100 ms.
- **Timeline:** a side channel (server-sent events are the app's pattern; compare `images/take-events.ts`) gives each sentence's start and end on the stream's clock and, when alignment is done, its words' times. Encoder delay is compensated.
- **Stop and jump:** closing the stream cancels synthesis, which frees the Zonos slot.

### 6.3 Synthesis

- **One request per sentence** to `/v1/audio/speech` or `/v2/generate`, streamed. Every request carries:
  - `language` (`en_us` or `hu`);
  - `speaker_embedding_id` or the voice's embedding;
  - `speaker_mode: "embedding"`;
  - the fixed seed;
  - `controls` from §4.6.
- **Prefetch:** generation runs ahead of playback by a few sentences (builder; about two). At 2× playback there is still more than 2× headroom (§9.1).
- **Busy server:** a third concurrent reading waits in Zonos's queue; the browser shows the busy note after 2.5 s.

### 6.4 Word timing: FuseAlign (owner chose it over the alternatives)

FuseAlign is Zyphra's multilingual forced aligner: given the audio and the words, it returns each word's start and end. It is not part of the voice model.
- **Runs on the box's processor:** not on GPU0, which has about 650 MiB free.
- **Two ways to run it:**
  - the native ggml build: C++, no Python, the `q8_0` file is 0.51 GB;
  - the Python package: about 3.7 GB resident on the Mac test.

  The builder measures on the box and prefers the native build. Memory budget for the whole speech service: about 1.5 GB resident (my call).
- **Input:** it aligns the **normalized** sentence (what was actually spoken). The result is mapped back to the written words by sequence alignment, and a written run that became several spoken words (or the other way round) is marked as one unit. Example: "12 990 Ft" lights up as one.
- **First sentence:** its words arrive after its audio starts; later sentences are aligned ahead of playback.
- **Failure:** alignment failure degrades to sentence-only marking, with no message (§4.8).

### 6.5 Data (builder for the schema)

- **Per person:**
  - the English voice and the Hungarian voice, each a built-in key or a personal voice id;
  - Default speed.
- **Personal voices:** id, owner, name (at most 40 characters), base voice key, and the five values.
- **Nothing about audio is stored** (§4.10).

## 7. Testing (builder, at least)

- **Unit tests:**
  - the speech-script builder: DOM to sentences and word ranges, every exclusion of §4.4, no syntax in the output, the short-sentence merge;
  - the Hungarian fixes;
  - the knob mapping and the clamping to the safe ranges;
  - the style values;
  - the timeline mapping;
  - the reading state machine, including every failure of §4.8.
- **Server:** the session route's authorization and its containment check.
- **A fake speech service**, like `images/comfyui/testing/fake-comfyui.ts`, that returns deterministic audio and timings and can fail on demand.
- **End-to-end:**
  - press the speaker, the player rises, the tint moves;
  - ✕ and the end;
  - a slash command while reading;
  - switching replies;
  - the scrubber;
  - each failure state;
  - Settings and the editor (rendering through the fake);
  - the phone layout;
  - reduced motion.
- **The new spec joins the release gate** by existing.

## 8. Before it ships (owner)

- **The two Hungarian voices: locked in** (owner, 2026-11-16). The working names are the datasets' own; the owner may rename them.

  | Voice | Made from |
  |---|---|
  | **Berta** (woman) | "Berta 1.0", Open Home Foundation on Mozilla Data Collective, CC0-1.0: one speaker, about 1.4 h, recorded to make text-to-speech voices, FLAC at 48 kHz |
  | **Imre** (man) | "Imre 1.0", same publisher, CC0-1.0: one speaker, about 1.5 h, WEBM/Opus at 48 kHz |

  - **How they're made.** Each voice comes from a reference of the speaker's 20 cleanest clips (55–58 s, chosen automatically by background, treble and clipping). It is made in **embedding mode**, so all five knobs work, with `room.clean: 2` ("studio") as its default control.
  - **The owner's verdict.** "Berta + Studio is really good." Imre is "usable": better than every other Hungarian man tried, though not a favourite. No other single-speaker Hungarian man's set under an open licence could be found.
  - **Where the files are.** The references, the embeddings (`.npy`, 192 floats), approved samples, scripts and a rebuild note are kept on the owner's Mac in `.superpowers/hu-voices/`. That folder is ignored by git: the datasets' terms forbid trying to identify the speakers, so the reference audio stays local.
  - **On the box,** the embeddings become the two Hungarian built-in voices, with the studio control applied by default. They are re-approved on the box's own output like everything else (below).
- **Tuning.** The style presets and knob words are tuned by ear with the Hungarian voices.
- **Judged on the box, not the Mac** (my call, after the spec review). Every by-ear judgment so far was made on the owner's Mac (the MLX build). Readings will come from the box's ggml build (quantized backbone, one decoder), and the same seed may sound different there. So:
  - the owner re-approves on staging, using the box's own output: first the two Hungarian voices with their seeds, then the presets and knob words in both languages;
  - the knobs' safe ranges are re-measured automatically on the box before the editor ships, the same way they were measured on the Mac (§9.4).
- **Sign-off.** The owner signs off on staging before `TTS_ENABLED` goes on in production.

## 9. Evidence

Everything here was measured in this session or in the infrastructure handoff.

### 9.1 Speed

| What | Measured |
|---|---|
| Zonos on the box, one reading | 7.4–8.7× faster than real time; first audio bytes 20–100 ms (English) |
| Zonos on the box, four at once | about 4.7–5.8× faster than real time |
| Zonos on the owner's Mac (MLX) | about 11 audio seconds per second; the editor's two-sentence sample rendered in about 1.0 s |
| FuseAlign, Python, Mac CPU, 8 threads | 0.24–0.40 s per 5–7 s sentence (16–24× real time); 9 s to load; 3.75 GB resident |
| FuseAlign, native, 16 x86 threads (its README) | 0.55 s per TIMIT clip; `q8_0` same accuracy as `f32` |

### 9.2 Word timing

- On 11 generated sentences (English and Hungarian, two voices) every word was placed, in order, with confidence ≥ 0.91.
- FuseAlign's published accuracy on real speech is about 83% of word edges within 50 ms (TIMIT).
- An estimate from letter counts was off by 70–430 ms on a typical word and up to 0.9 s, worst around numbers. The owner watched both side by side and chose the aligner.

### 9.3 Text cleanup

- **Hungarian is covered.** The shipped normalizer (zyphra-textnorm 0.2.0) covers 43 languages, Hungarian included. The model page lists only nine because it predates the code. A wrong `language` reads Hungarian numbers in English and turns "Ft" into "feet", so the language must be right.
- **Its Hungarian output has a "kettő" problem:**
  - "2 tojás" → "kettő tojás" (should be "két")
  - "2026." → "kettőezer-huszonhat" ("kétezer")
  - "12 990 Ft" → "tizenkettőezer-kilencszázkilencven forint" ("tizenkétezer…")
  - "12 fok" → "tizenkettő fok" ("tizenkét")

  "3-án" → "harmadikán", "4 órakor" → "négy órakor" and "40%" → "negyven százalék" are right.

  **The fix** (my call): after normalization, "kettő" becomes "két" when it is part of a compound number word ("kettőezer", "tizenkettőezer", "kettőszáz") or is followed by a word (a counted noun). A lone "kettő" at the end of a phrase stays.
- **Decimals:** "1,5" reads as "egy egész öt tized"; correct, if formal. The owner judges it by ear (builder may special-case "másfél").

### 9.4 The knobs

- All 25 Studio controls were rendered at their safe ends on three voice/language pairs and measured against natural seed-to-seed variation. Each control's mapping came from the Studio's own source.
- **Kept** (owner): Pace, Pitch, Depth, Energy, Projection.
- **Left out, and why:**
  - Gender, Happy, Angry, Scared and Confused change who is speaking or clip.
  - Warmth, Sad, Read↔chatty, Age, Husky, Soft, Bright, Authority, Room and Liveliness are barely audible in their safe ranges.
  - Raspy and Hesitation break the voice; hesitation drops words.
- **Hungarian responds differently.** Some doses do less (pitch up), and extreme doses collapse Hungarian clips. That is why the ranges stop at the safe ends.
- **Hidden-space controls fade.** Energy and Projection fade to 35% after 4 s of speech by the model's design (`steer_release`; Pace is exempt). Sentence-by-sentence requests restart them every sentence.

### 9.5 Making a voice from a recording

These are the first trials on the owner's Mac. The measures come from the same clips: treble is the energy above 10 kHz against the whole clip (higher is clearer), and background is the quiet frames' level below the loud ones (lower is cleaner).

| Clip | Treble | Background |
|---|---|---|
| Imogen reading Hungarian (benchmark), short / long line | −17 / −30 dB | −73 / −65 dB |
| A native speaker's 16 kHz research recording (FLEURS) | −85 dB | — |
| …made in reference mode (copies the recording) | −72 dB, muffled | −53 dB |
| …made in embedding mode | −24 dB | −53 dB |
| …embedding mode with `room.clean` 2 ("studio"), short / long line | −18 / −37 dB | −54 / −68 dB |
| Amateur spoken-Wikipedia recording, embedding mode, short line | −34 dB | −55 dB |
| …with `room.clean` 4 | −26 dB | −65 dB |
| …from a noise-reduced recording (ffmpeg `afftdn`), long line | −64 dB (the cleaning took the treble) | −62 dB |

**The gallery round.** 19 native speakers were made into voices the same way: the eight best-recorded women and eight best-recorded men from Common Voice Hungarian 27.0 (ranked automatically), plus Berta, Anna and Imre. The owner judged them blind to any measurements:
- the Common Voice speakers sounded noisy;
- Berta with the studio push was "really good";
- Imre was the best man.

A first ranking of Common Voice favoured clips whose pauses were gated to digital silence and whose treble was cut. Those are a browser's noise suppression and a band-limited microphone, not a studio, so the ranking now requires full treble.

Findings:
- **Embedding mode** keeps clarity independent of the recording's sample rate.
- **`room.clean`** brings the background close to Imogen's.
- **Cleaning the recording** costs clarity, so it is not the answer.
- **What the measures miss:** the owner's ear still hears faint treble artifacts and a non-native accent, so a better recording is needed regardless (§8).

### 9.6 Question intonation

A rough pitch tracker suggested that questions without a question word end like statements. The owner listened to the same clips (statement and question pairs in English and Hungarian) and found the intonation works. That tracker is not reliable for this, and no change is needed.

## 10. Left to the builder

- **Transport and protocols:** the stream format, the timeline protocol and the server↔speech-service contract (§6.2, §6.1).
- **Speech service build:** native or Python aligner after measuring on the box, its systemd unit, health check and memory limit, and its start order beside `zonos3.service`.
- **Language and text:** where language detection runs and which library; the sentence-length threshold; the Hungarian sample sentence.
- **Look and markup:** the exact token names for the tint and amber colours in both themes; the component split (one shared player for replies and the editor); the database schema.
- **Paperwork:** ADR-0070 (the speech service on the GPU box beside vLLM, decoder on CPU, the aligner, graceful degradation, nothing stored); the runbook additions; the Feature Guide wording.

## 11. Reference files

In [`2026-11-16-read-aloud/`](2026-11-16-read-aloud/):
- `player-prototype.html`: the floating player, scrubber, phone layout and every failure state, with a panel that triggers them. Open it in a browser; the voice is simulated.
- `voice-editor-prototype.html`: Settings → Read aloud and the editor. It plays real audio only through `voice-editor-relay.py` beside a local Zonos MLX server on port 1921; without them the layout still shows.
- Pictures:
  - the button states and the first options (`read-aloud-progress.png`)
  - the combined reading view (`read-aloud-combined.png`)
  - the player (`player-desktop.png`, `player-phone.png`)
  - the editor (`editor-desktop.png`, `editor-phone.png`)
  - the failure states (`v4-*.png`)
