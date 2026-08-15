# Tool usage guidance lives in the tool interface

Accepted (2026-08-15). Each tool's usage rules — when to call it, its argument shape, one example,
how to handle its output, and what to do on failure — now live on that tool's own description
(`TOOL_I18N` in `src/lib/server/services/normal-chat-tools/index.ts`, in both English and Hungarian).
The Normal Chat **guidance-pack selector** that used to assemble this text into the system prompt —
12 packs, ~10 English-only regexes scored against the latest message, `resolveGuidancePackSelection`,
`planNormalChatGuidancePacks`, `NORMAL_CHAT_GUIDANCE_PACKS` — is deleted outright. This is a **net
deletion**, not a rewrite: `normal-chat-context.ts` shrinks from 2354 to 1607 lines (net -747), and the
preparation pipeline that used to rebuild the system prompt after every stage that touched `inputValue`
simplifies as a direct consequence — nothing replaces the deleted selection machinery in that file.
`buildOutboundSystemPrompt` keeps only what
is genuinely turn-scoped (response-language guard, reasoning-depth contract, the injected system-time
context, the connections framing, the GPT-OSS reasoning directive, base prompt + personality).

## What changed

Before this change, `buildOutboundSystemPrompt` called `resolveGuidancePackSelection`, which ran a
battery of English-only regexes (`WEB_INTENT_RE`, `MEMORY_CONTEXT_RE`, `IMAGE_INTENT_RE`,
`FILE_INTENT_CONVERSION_RE`, `HIGH_RISK_RE`, and others) against **only the latest user message** to
decide which of twelve guidance packs (`web-core`, `web-detailed`, `file-core`, `file-detailed`,
`memory-core`, `memory-detailed`, `image-search`, `url-argument`, `forced-web`, plus three always-on
core packs) to splice into the system prompt. Three problems followed directly from that design:

- **Language-dependent.** The regexes matched English words. The identical request phrased in
  Hungarian selected a different (usually smaller) set of packs, because Hungarian sentences rarely
  contain `today`, `remember`, `latest`, or the other trigger words.
- **Wording-dependent.** Two English phrasings of the same intent could select different packs
  depending on incidental word choice, sentence length, or whether a "do not use tools" disclaimer
  happened to match `NO_TOOL_DIRECTIVE_RE`.
- **Follow-up-blind.** Selection read `params.message` — the current turn's text only, never
  conversation history. A first turn that triggered `web-core` + `web-detailed` could be followed by a
  bare-pronoun follow-up ("And the second one?") that matched none of the intent regexes and lost that
  guidance entirely, even though the tool call it needed was identical in kind to the first turn's.

The fix is not a better classifier. Tool **availability** already exists as a deterministic signal in
`createNormalChatTools`: `research_web`/`fetch_url` register only when Parallel is configured;
`files`/`calendar`/`email`/`photos`/`media`/`location`/`contacts`/`repos`/`tasks` register only when
the user has an enabled connection capability; `memory_context`, `image_search`, and `produce_file`
are unconditional. A tool's own description is read by the model at the same moment its schema is —
there is no reason to *also* maintain a second, message-content-driven decision about whether the
model should be told how to use it. Migrating the packs' text onto the tool descriptions removes the
selection problem instead of solving it: there is no longer a classification step to get right or
wrong, in any language, on any turn.

## Why this does not reopen ADR-0046

[ADR-0046](0046-automatic-depth-selection-is-deterministic.md) replaced an LLM-based Reasoning Depth
classifier with a **deterministic rules classifier** — it kept the classification step (auto-selecting
`standard`/`extended`/`maximum` from message signals) and changed *what performs it* (regex/keyword
scoring instead of a model call). That is not what this decision does, and this decision should not be
read as arguing rules-based classification is bad or that ADR-0046 should be revisited.

This decision **removes the classification problem itself**, not the mechanism that performed it. There
is no "which guidance is relevant to this message" question left to answer, by a model or by rules,
because the answer no longer varies by message: a tool's guidance is present whenever the tool is
present, full stop. ADR-0046's deterministic classifier remains the correct call for Reasoning Depth,
where the output space (`off`/`standard`/`extended`/`maximum`) is a genuine turn-scoped judgment that
has no availability-based substitute. Tool usage guidance never needed that judgment in the first
place — the packs existed to *save tokens* by omitting guidance for tools the model probably would not
call, a token-budget optimization that cost correctness (wrong-language misses, wrong-wording misses,
follow-up amnesia) for a saving that a `TOOL_I18N` description already pays for once per tool, present
or absent, exactly like its Zod schema.

## Considered Options

- **Keep the pack selector, fix the regexes to be bilingual and follow-up-aware.** Rejected: doubles
  the regex surface (EN + HU) with no bound on future languages, and still leaves wording-sensitivity
  inside the surviving bilingual patterns. Fixing symptoms of a selection step that should not exist.
- **Replace the regex selector with an LLM classifier.** Rejected before it was seriously considered:
  this is the shape ADR-0046 already rejected for Reasoning Depth (latency and cost on every turn for a
  routing decision), and it would still need a second signal — tool availability — to reconcile
  against, so it solves nothing the availability signal does not already solve alone.
- **Delete the selector; move guidance onto each tool's own description (chosen).** Tool presence in
  `createNormalChatTools` is already the deterministic, per-turn-stable signal the packs were trying to
  approximate with regexes. No new classification mechanism, in any form, replaces the deleted one.

## Consequences

- `grep -rn "GUIDANCE_PACK\|resolveGuidancePackSelection\|planNormalChatGuidancePacks" src` returns
  nothing. The exported `planNormalChatGuidancePacks` function, the `NormalChatGuidancePackSelection`/
  `NormalChatGuidancePackId`/`NormalChatGuidancePackInput` types, and the `promptPackPlan` field
  threaded through `prepareOutboundChatContext`'s preparation-stage state are gone; nothing replaces
  them.
- `buildOutboundSystemPrompt`'s assembled output is now **byte-identical for a fixed conversation**
  regardless of the latest message's wording, length, or language (EN vs HU) — this is a regression
  test (`normal-chat-context.test.ts`), not just an observation.
- Because none of the remaining guidance in `buildOutboundSystemPrompt` depends on `inputValue`, the
  `prepareOutboundChatContext` preparation pipeline no longer needs to rebuild the system prompt when
  later stages (forced web prefetch, proactive connector context, automatic context compression) splice
  new text into `inputValue`. Those stages got simpler as a direct consequence, not as a separate
  cleanup.
- `research_web`, `fetch_url`, `memory_context`, `image_search`, and `produce_file`'s `TOOL_I18N`
  descriptions now each carry: when to call the tool, its argument shape with one example, how to
  handle its output (citation format, embed-as-markdown for images, success-means-accepted-not-finished
  for file production), and failure behaviour — in English and Hungarian, at parity. `image_search`'s
  Hungarian description specifically carries the "embed as `![](url)` or it is invisible" rule, which
  before this change was six words with no embed instruction at all.
- Some pack text did not map onto one tool. Generic JSON-argument-formatting advice
  (`JSON_FORMATTING_RULES`) and the `done`-tool completion contract (`TOOL_TERMINATION_GUARD`) were
  folded into `produce_file`'s description and the `done` tool's own (still English-only, unlocalized)
  description respectively, rather than kept as free-floating always-on system-prompt text — see the
  code comments at those call sites for the specific placement decision.
- `CONTEXT.md` is amended in the same change (surgical edit, not a rewrite) to describe this framing
  next to the existing bullet about `normal-chat-context.ts`'s runtime-guidance role.
- `scripts/evaluate-tool-guidance-ab.ts` (G0's before/after eval harness) imports the now-deleted
  `planNormalChatGuidancePacks` for its diagnostic `guidancePackMode`/`guidancePackIds` fields. That
  harness is explicitly out of this slice's scope — the orchestrator owns resyncing it to run the AFTER
  arm — so `npm run check` shows exactly one new type error, confined to that one file, until that
  resync happens.
