# Agent CHP · follow-up chips a person would actually send, and "angolul" only when it is a request

**Not Feature 2: from `dev`, into `dev`.** It ships with the sampling milestone. The owner (2026-10-05) on the follow-up
chips under a reply: "It's usually worded to the wrong party, and they aren't very actionable either." And: a Hungarian
message that merely contains "angolul" ("Hogy mondják angolul, hogy alma?") must not flip the reply to English — only an
explicit request should.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/chp`, branch
  `fix/follow-up-chips` (from `dev` `b179456b`, which has SMP and SMP-2), e2e port **5450**, label `chp`, real-model tunnel
  local port **30403**.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/5c073247-a423-47a9-b825-91f05ce97740/scratchpad/w4/chp-report.md`;
  probe output in `…/scratchpad/w4/chp-probe/` (outside the repo). **Reuse SMP-2's probe harness and its 26 captured
  conversations** (`…/scratchpad/w4/smp2-probe/`, described in `…/w4/smp2-report.md`) instead of building new ones.
- Read first: `docs/plans/claude-at-home-2/wave-4/common.md` (+ the Wave 3 rules it points to) from the `art-base`
  worktree; SMP-2's report (its follow-up and language sections); `chat-turn/follow-up-suggestions.ts`,
  `services/language.ts` (`~117`, `~190–200`, `~387`: the explicit-request rule) and where a chip is rendered and what a
  click on it sends (find the component by `grep`).

## Steps

1. **What a chip is, pinned by tests, then the prompt.** A chip is **the next message the person would send to Alfy**,
   in the person's own voice — never Alfy offering ("Szeretnéd, ha…?", "Would you like me to…") and never a question put
   to the person ("Mennyi a kereted?"). It is **actionable**: a concrete thing Alfy can do in the next turn (compare,
   turn into a checklist or a table, draft the email, go one step deeper on a named point, apply it to the person's case),
   **specific** to this reply (it names what it acts on), in the turn's language, short enough for a chip. Generic chips
   ("Tell me more", "Mondj többet") are out. Keep the existing rule for a reply that asks the person a question unless
   you find a clearly better one (say which). Rewrite the prompt, and make `isPlausibleFollowUpSuggestion` (or one
   shared check beside it) reject the wrong voice and the generic ones in **both** languages, from real outputs — tests
   both ways (good chips pass, bad ones fail). Read what a click sends so the wording matches what lands in the composer.
2. **"angolul" only as a request.** In `language.ts`, only an explicit request to answer or write in English
   ("válaszolj angolul", "angolul válaszolj", "írd angolul", "beszéljünk angolul", "in English please") flips the reply;
   a message that mentions the language ("hogy mondják angolul…", "mit jelent angolul…", "fordítsd le angolra…") keeps
   the conversation's language. Mirror it for English messages that mention Hungarian ("how do you say … in
   Hungarian?"). Tests for each case in both directions; the existing language suites (W0-D's) stay green.
3. **Before/after on the real model.** Through `ssh -N -L 30403:192.168.1.96:30000 alfyroot` in the same command
   (model `qwen3-6-27b`), the app's own functions, the captured conversations (n ≥ 60 chip sets per arm): the share of
   chips in the person's voice, actionable, specific, in the right language; and the "angolul" trap prompts. Put **15
   before/after chip sets side by side** in the report (Hungarian and English) so the orchestrator and the owner can read
   them. Bounded and sequential.

Then the full gates once (Wave 3 rules' list; Playwright with `streaming.spec.ts`, `chat.spec.ts`, `conversation.spec.ts`
and every artifact suite).

**Runs beside you:** agent TR-C on `feat/artifacts-tours` (tours) — no shared files.
