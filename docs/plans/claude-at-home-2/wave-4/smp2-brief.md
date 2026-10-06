# Agent SMP-2 · short internal answers a person reads: the stray think block, Hungarian leaks, follow-up language

SMP (`fix/internal-call-sampling`, `27274c0e..4e64644c`) gave every model call one route to its sampling and found that the
owner's garble is not explained by missing sampling on `dev` or `main`. Its live probe found three real defects on the
same short, person-read paths instead. You fix them, on the same branch, before it merges into `dev`.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/smp` (SMP's, finished), branch
  `fix/internal-call-sampling`, e2e port **5400**, label `smp2`, real-model tunnel local port **30401**.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/5c073247-a423-47a9-b825-91f05ce97740/scratchpad/w4/smp2-report.md`;
  probe script and raw output in `…/scratchpad/w4/smp2-probe/` (outside the repo; reuse SMP's `…/w4/smp-probe/` capture
  and harness rather than rebuilding them).
- Read first: `docs/plans/claude-at-home-2/wave-4/common.md` (+ the Wave 3 rules it points to) from the `art-base` worktree,
  and SMP's report (`…/scratchpad/w4/smp-report.md`: its inventory, the title sweep, the language-drift note, concern 1–3).

## Steps

1. **The stray think block.** The model starts a `<think>` block although the request says `enable_thinking: false`;
   on titles (`TITLE_GEN_MAX_TOKENS = 120`) an unclosed block is cut off and the title falls back 25–33 % of the time.
   Find out why at the wire (does `chat_template_kwargs` reach vLLM in the form v0.31 reads; what does the rendered
   prompt end with — vLLM's `/tokenize` through the tunnel can show it) and fix it at the right layer, **once**, for every
   short internal call whose text a person reads (titles, thought-step status lines, the rail summary and turn
   acknowledgement, follow-up suggestions): the request shape if that is the cause, else one shared cleanup that
   strips a closed block and treats an unclosed one as a retry or a fallback by rule. Tests first (unit on the cleanup,
   wire tests on the request shape).
2. **Leaked reasoning in Hungarian.** `chat-turn/short-local-text.ts`'s `REASONING_LEAK_RE` only knows English
   preambles, so leaked Hungarian reasoning ("A felhasználó azt kérdezi…", "Rendben, gondoljuk végig…") reaches a status
   line or the rail summary. Make the check work for both languages from **real** leaked outputs (collect them in the
   probe; do not invent phrases from memory), without rejecting ordinary Hungarian status lines (tests both ways).
3. **Follow-ups in the conversation's language, and the before/after.** Follow-up suggestions come back English-only in
   ~17 % of Hungarian conversations at every temperature. Find the cause (what language signal the prompt gets; how the
   chat reply's own language is decided — W0-D's language fix and ruling 55's turn language are the precedent) and fix
   it if it is small; otherwise report the cause and stop there. Then one live before/after on the real model, the app's
   own functions, n ≥ 60 per arm: title fallback rate, think-leak rate, Hungarian-leak rate in status lines/rail,
   follow-up language. **Titles' temperature:** keep the profile (SMP's change) unless, after your step 1, titles at the
   profile are still measurably worse than at 0.2 on that run; if so, set titles back to 0.2 the way SMP's report
   describes (listed in the guard with its reason) and say so with the numbers.

Then the full gates once (Wave 3 rules' list, Playwright with `streaming.spec.ts` and every artifact suite). Report the
before/after table and every rule you added.

**Runs beside you:** agent TR-B on `feat/artifacts-tours` (the tour card in the panel) — no shared files.
