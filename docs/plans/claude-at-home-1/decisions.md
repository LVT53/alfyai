# Feature 1 · Workspaces — owner decisions

**Ratified by the owner on 2026-09-24.** These are final. Every slice document carries its own copy of the
decisions that affect it, so an agent reading one slice in isolation sees the same answers. If a slice document
and this file ever disagree, **this file wins**.

The product decisions themselves are in `claude-at-home-1-workspaces-spec.md` §"Decisions (do not reopen)" and
in `plan.md` §"Owner decisions already made". What follows is the second round: the judgment calls the plan
raised because the spec was silent or its literal reading contradicted the code.

## Cross-cutting

| # | Question | Decision |
|---|---|---|
| 1 | `## Your Instructions` after `## Response Style` breaks the test that pins Response Style as the last system-message section (`normal-chat-context.test.ts:738`) | **Change the order, keep the guarantee.** The assertion is updated to pin `… Runtime Guidance → Response Style → Your Instructions → Project Instructions`. It is not deleted, and the drop of the old `endsWith` clause is named in the commit message. |
| 2 | Where instruction text is read for prompt assembly | **Resolved outside prompt assembly and passed in** through `PrepareOutboundChatContextParams`. `normal-chat-context.ts` gains the section but no DB reads, so the file that must stay byte-stable stays pure and testable. |
| 3 | `stripDeprecatedPromptSections` deletes a paragraph containing `<preserve>`, "preserve tags" or "translation-preserved" — including one the user typed | **The instruction sections are appended after the stripper runs**, so it never scans user text. Indentation protects only the section *shape*. The user's words are never rewritten, escaped or sanitised. |
| 4 | The migration that deletes user `pinned`/`excluded` rows is one-way | **Proceed.** Once the writer is deleted those rows are unreachable, so the `DELETE` is hygiene rather than data loss. The task must still report the affected row count and dry-run against a scratch DB copy first. |
| 5 | `projectId` vs `folderId` in code | **`projectId` in code, "project" in UI copy.** `conversations.projectId`, the existing routes and the sidebar label already say project; CONTEXT.md's "Project Folder" is the domain gloss, not an identifier. |

## Slice A

| # | Question | Decision |
|---|---|---|
| 6 | Should the finding that the feature had been inert for some time be written up? | **No standalone document.** One line in the commit message, one line in `review-<batch>.md`. A future `git log -S` lands there. **— PREMISE RETRACTED 2026-09-24, see below.** |

> **Correction to decision 6 (2026-09-24, found by the Wave 1 reviewer and verified by the orchestrator).**
> The premise was **false**: the surface had *not* gone inert. Only its *display* chain was dead — the pinned/
> excluded props handed to the message bubbles were never read. Its *effect* chain was live end to end: the
> panel's writes reached `prepareTaskContext`, which filtered excluded artifacts out of the candidate set
> (`1aeea62e:src/lib/server/services/task-state.ts:1180-1207`) and passed `pinnedIds` on to
> `context-selection.ts`, which force-included and boosted them (`:1708`, `:1985`, `:2084`). A user who pinned
> a source had it prioritised; a user who excluded one had it dropped from candidates.
>
> So the removal **did** take a working capability away, and the removal rests on the owner's decision — "I
> never used it" — not on the feature being dead. The commit message of `f83e9e82` and the CONTEXT.md line it
> carried said otherwise and are wrong; CONTEXT.md was corrected by `898d2227`, the commit history was left
> alone. A live-path capability that nobody uses is still a capability, and a future reader must not be told it
> was inert.
| 7 | ADR-0043 asserts pinning "lives in the Knowledge library / working-document workspace" | **Correct it in place, with the correction dated.** AGENTS.md points future agents at ADR-0043, so a false claim about where a capability lives keeps misleading them. A superseded note would leave the wrong statement standing. If the inventory's verification shows the claim was true, leave it alone and say so. |

## Slice B

| # | Question | Decision |
|---|---|---|
| 8 | Negative allowance: clamp or reject? | **Clamp in env, reject in the admin UI.** A negative env value falls back to the default `5`, matching `parsePositiveIntegerEnv`'s existing behaviour; the admin-config registry spec is the real gate and returns a `400`. `0` is valid and means "charge everything". |
| 9 | The meter's `$Z` — "users are charged $Z" | **The current month's counted total.** The line also says "resets 1 <Month>"; a lifetime figure beside a monthly reset reads as a bug. |

## Slice C

| # | Question | Decision |
|---|---|---|
| 10 | The dialog saves only the scope on screen, even when a switch is offered | **Yes, one scope at a time.** "Nothing is saved without the user seeing the full text" (decision 5 in the spec) forbids writing a buffer the user never looked at. Switching moves the pending line into the other scope's buffer, which the user must then look at before saving. |
| 11 | Hungarian text for the personal scope token | **"Te"** for the token, **"Személyes"** for the switch label — mirroring the mockup's "You" / "Personal" split. The token is the short form everywhere it appears. |

## Slice D

| # | Question | Decision |
|---|---|---|
| 12 | The quiet line under the project composer ships in two steps | **Yes.** Slice D renders the instructions half; Slice E adds the files half. Shipping a files button whose modal does not exist yet would be worse than an intermediate state no user sees in production. |
| 13 | The incognito arm on the project page | **Keep it.** Slice E guarantees an incognito chat in a project still sees the project's instructions and files, which only matters if one can be started there. |
| 14 | The stats line uses the newest *chat* activity rather than the newest message | **Keep it, and it is nearly moot:** `conversations.updatedAt` no longer moves on a folder move (commit `468668ee`), so it already tracks real activity — which is also why the home row and this line cannot disagree. |

## Slice E

| # | Question | Decision |
|---|---|---|
| 15 | `+N more` names a count, not the files | **Count only.** Thirty entries and 1,500 characters is already generous for a section that is never trimmed; listing the remainder would need a second budget and would push real context out of the packet. The remaining files stay reachable through retrieval and by name. |
| 16 | The retrieval boost is a fixed constant rather than a percentage | **Keep it fixed and small (`+5`).** It breaks ties toward project files and cannot override a genuinely better match. A larger boost risks a project file outranking the document the user actually attached — a worse failure than the reverse. |
| 17 | A project file that is not prompt-ready still links and still appears in the list | **Yes, and it fails only when read**, with the existing 409 the linked-source path already returns. Refusing the link would hide the file's existence from the model entirely, which is the opposite of Folder Knowledge's purpose. |
| 18 | The Knowledge → Documents token reads "In N projects" | **Yes.** A bare folder icon cannot distinguish a document in one project from one in three, and that difference changes what editing it would affect. |

## Slice F

| # | Question | Decision |
|---|---|---|
| 19 | `suggest_instruction` is registered for the whole conversation instead of gated per turn on the user stating a standing preference | **Keep as planned.** A per-turn gate would vary the tool catalogue inside the cached prompt prefix — the exact failure `shouldExposeFileProductionTools()` exists to prevent — and a language-dependent accept gate would reintroduce what ADR-0055 deleted. The rule lives in the tool description; the server still enforces absence in incognito, one offer per turn, and a clamped scope. **If staging shows the model offering on ordinary turns, the next step is a server-side accept filter at execute time**, which leaves the catalogue untouched; do not vary the tool set. |
| 20 | `Dismiss` is permanent and the model may offer the same rule again later | **Keep it permanent, with no suppression.** A later explicit "from now on" is new evidence and deserves a new offer. Add suppression only if staging shows it repeating annoyingly. |
| 21 | The suggestion row shows only the scope token and the quoted text | **Yes.** It sits directly under its own reply, so position is the reference; a message link would add a control that only ever points where the user already is. |

## Slice G

| # | Question | Decision |
|---|---|---|
| 22 | A project with no chats gets no home card | **Hide it.** Every card then carries a true "N chats · active …" line and the row matches §M6. Known consequence: a project created minutes ago appears only in the sidebar until its first chat. Revisit only if the owner asks; it would need one extra key and one ordering rule. |
| 23 | Cards show no per-project colour stripe | **Follow the mockup: accent folder, no per-project colour.** Projects still carry their colour in the sidebar, which is where distinguishing rows matters. |
| 24 | The `home.suggest.*` i18n block is deleted outright | **Delete all of it** — 27 `home.suggest.*` keys plus `home.suggestionsLabel`, `home.another`, `home.anotherLabel` and `home.suggestionSource`, in both locales. "Backend included" is read as covering the strings. |

## What these decisions do not change

No slice's scope, file ownership, or test list changes as a result. The wave plan stands:

```
Wave 1   A ∥ B      Wave 2   C      Wave 3   D      Wave 4   E      Wave 5   F ∥ G
```

Two consequences worth carrying into implementation:

- **Decision 3 is a mechanism, not a preference.** If an implementer finds themselves sanitising, escaping or
  rewriting user instruction text to get past the stripper, they have gone the wrong way — move the append
  instead.
- **Decision 19 has a named fallback.** If spurious offers appear on staging, the cheapest correct fix is an
  accept filter inside the tool's execute body. Any fix that changes what the catalogue contains on a per-turn
  basis is out of bounds and must come back to the owner.
