# FB-1 — files and downloads: what you ask to download reaches you (F1, F23, F25, F27, F30)

Part of the friction build (`phase-5/build-plan.md`, ruling 77). Read `phase-5/common.md` and the two files it names
first, then `phase-5/fa-report.md` §1 and the paragraphs for **F1, F23, F25, F27, F30** in §2 (and §3's pattern 2,
"work with no home"). The screenshots are in `<scratchpad>/p5/fa-shots/` (`F01*`, `F23*`, `F25*`, `F27*`).

- Branch / worktree: `fix/friction-files` in `.claude/worktrees/art-fb1`, from `feat/artifacts`. Ports 5400–5409.
- Report: `<scratchpad>/p5/fb1-report.md`. Beside you: FB-2 (Alfy's tools and words; `normal-chat-tools/**`,
  `prompts.ts`, `ToolActivityRow.svelte`). Owns: see the build plan's row for FB-1; nothing else.

## What to fix

1. **F1, the main one.** A Document's and an App's Letöltés (PDF, Word, Markdown, the App's file) start an export job
   that succeeds in under a second, and then nothing reaches the reader: no download, no card, no row; the files turn up
   later as ghost cards inside an unrelated reply. Reproduce it first with real input (red), find why (the client never
   follows the job? the job's files are attached to the next assistant message?), then make a download do what it says:
   the file downloads when it is ready, the popover says it is preparing until then and says so if it fails, and an
   export never attaches itself to a chat reply. Whether a finished export also appears in "Made in this chat" as a
   File row: decide by what the rest of the panel does for files the reader asked for, and say why in your report.
   Every download stays on the canonical routes and the ownership scope (AGENTS.md: `/api/chat/files/[id]/download`,
   incognito with `?conversationId=`); an Opus look reads your download path.
2. **F23, Knowledge:** the page opens on Dokumentumok (ruling 77); sizes are real (a 364 KB PDF does not read "0 B");
   Document, Canvas and App rows get the same actions a generated file row has where they make sense (open, download).
3. **F25:** a PDF preview takes its final size at once (no 316×166 box that jumps to 888×719).
4. **F27:** in a project's Files dialog the row's name opens the item (it looks like a link, so it is one).
5. **F30:** a download starts without a request that is meant to fail (`client/downloads.ts:31–42`).

## Tests and gates

Red first with real input for F1 (a real click on each Letöltés format, then a Playwright `download` event, the file's
name and a non-empty body), F23, F25 (no layout shift after the first paint, measured), F27. Screenshots you look at
yourself, at most 6, in `<scratchpad>/p5/fb1-shots/`: the Download popover preparing and done, Knowledge's Documents
tab, the project Files dialog. `scripts/gates.sh agent <out-dir> --port 5400 --workers 4` with every spec you add or
change plus `artifact-document.spec.ts`, `artifact-app.spec.ts`, `knowledge.spec.ts`, `project-files.spec.ts`.

Final reply at most 12 lines: status, **your model ID**, commit range, gate summary, F1's cause in one line, the
download path for the Opus look, concerns.
