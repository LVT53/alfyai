# FB-7 — the first message and the reply: no English flash, no late jump, chips you can see (F5, F16, F17)

Part of the friction build (`phase-5/build-plan.md`, ruling 77); FB-1 and FB-3 are merged into your base. Read
`phase-5/common.md` and the two files it names first, then `phase-5/fa-report.md` §1 and the paragraphs for **F5, F16,
F17** in §2, ruling 77's F17, and AGENTS.md's landing/chat handoff paragraphs (`conversation-session.ts`, the landing
page, the chat page's bootstrap) and the follow-up chip paragraph. Screenshots: `<scratchpad>/p5/fa-shots/` (`F05*`,
`F16*`, `F17*`).

- Branch / worktree: `fix/friction-first-message` in `.claude/worktrees/art-fb7`, from `feat/artifacts`. Ports
  5420–5429.
- Report: `<scratchpad>/p5/fb7-report.md`. Owns: the build plan's FB-7 row.

## What to fix

1. **F5.** The first message never passes through an English page: the bootstrap view ("Starting conversation…",
   "Type a message…") renders in the reader's language from its first frame (the Hungarian strings exist:
   `chat.startingConversation`), and an untitled conversation reads "Új beszélgetés" in a Hungarian UI until its title
   arrives (the default title in `services/conversations.ts` and `ConversationTitleText.svelte`). If the bootstrap view
   can be skipped or made to look like the chat it becomes, prefer that: the audit saw it as a blank page with a spinner.
2. **F16.** A card does not drop in late and push the streamed text down: its room is held from the moment the tool call
   starts (a placeholder row of the card's height in the place the card will take), or the card goes where it moves
   nothing; measure the layout shift before and after.
3. **F17 (ruling 77).** The follow-up chips show at rest on desktop as on a phone, quietly; the message's hover-only
   action row keeps its own rule for the other actions.

## Tests and gates

Red first, real input: F5 in Hungarian from the landing (no English text in any frame of the handoff, frame-by-frame as
the audit did; the header says "Új beszélgetés" until the title), F16 (no layout shift of the streamed text when the
card arrives), F17 (chips visible without hover after a reply). Screenshots you look at yourself, at most 6, in
`<scratchpad>/p5/fb7-shots/`. `scripts/gates.sh agent <out-dir> --port 5420 --workers 4` with your specs plus
`chat.spec.ts`, `conversation.spec.ts`, `streaming.spec.ts`, `follow-up-chips.spec.ts`, `artifact-chat-card.spec.ts`.

Final reply at most 12 lines: status, **your model ID**, commit range, gate summary, the layout-shift numbers, concerns.
