# Feature 2 — rulings on the slice specs' open questions

When the slice specs were drafted, nine places were ambiguous or contradictory. Each was reported rather
than decided silently; the rulings are below. **Where a ruling and a slice spec disagree, this file wins**,
and the slice spec should be corrected in the same commit that touches it.

## 1. Comments are never part of an artifact body

The parent spec's §3 body list mentioned `comments` for Canvas; §2.7 and the `artifact_comments` DDL make
comments one shared table. **The table wins.** A body carries only what the artifact *is* — for Canvas
`{nodes, edges, viewport, annotations}`; comments, versions and per-App key-value state are rows keyed by
`artifact_id`. The spec's §3 body list is corrected to match.

## 2. Slides: layouts are code-owned, the body carries the deck

`{layouts, slides[]}` is read as *deck theme and aspect*, not body-defined layouts. The layout set is fixed
in code (title, section, bullets, two-column, image, quote, closing); a body may choose among them and set
theme values, never define new ones. Rationale: fixed layouts are what makes PPTX export reliable, and it
keeps the model's job to content.

## 3. Slides export: PPTX in v1, PDF deferred

The mockup's export matrix said "PPTX · PDF"; slice 4 said PPTX only. **PPTX only in v1.** There is no PPTX
renderer in `file-production/` today (only output validation), so slides export through
`sourceMode: "program"` using `python-pptx` (confirmed present in `SANDBOX_PYTHON_PACKAGES`); a PDF of a
deck is a second renderer and is a stated non-goal of slice 4. The mockup line is corrected to "PPTX" and
PDF is recorded as deferred, not forgotten.

## 4. Tours: code-owned defaults, campaign override

ADR-0012's campaigns are immutable snapshots with required crops, which a per-type tour cannot be. Ruling:
each tour's **structure and trigger are code-owned**, with shipped default text and illustration; a tour may
be **overridden by a published campaign** carrying a new `summary` layout value (one line of body text
under the artwork). The owner's decision stands: the text is editable, the trigger is not.

## 5. Tool guidance lives on the tools, and a doc claim is wrong

ADR-0055 wins over the handoff brief's shorthand: the model-facing **rules go on the tool** (schemas and
descriptions in `normal-chat-tools/`); what belongs in the turn guidance is only the **catalogue** — that
these tools exist this turn. Two documentation fixes fall out of this and must land with slice 5:

- `AGENTS.md`'s line that outbound file-production guidance lives in `normal-chat-context.ts` is wrong —
  the text is in `src/lib/server/prompts.ts` (6 occurrences; zero in `normal-chat-context.ts`), consumed by
  normal-chat context assembly. Reword it to name both files for what they do.
- `fileProductionToolsAvailable` is declared and threaded (`normal-chat-context.ts:441,1848,1932`) but
  nothing reads it. Confirm during slice 5 and either read it or delete it; do not carry dead state forward.

## 6. Artifacts appear as evidence through the existing Sources surface

The brief's "Info popover rows" were never in the parent spec. The ruling follows Feature 1's settled
design: the Info popover shows **counts**, and the message's **Sources panel** (`ResponseAuditDetails` /
`MessageEvidenceDetails`) shows the detail. An artifact that an answer drew on appears there as an evidence
row labelled with its type. No new popover row is invented.

## 7. Widening `EvidenceSourceType` is approved

Showing a made artifact as evidence means adding a case to `EvidenceSourceType`
(`messages-types.ts`), which is an exhaustive union consumed by `GROUP_LABELS` and `GROUP_ORDER` in
`message-evidence.ts` — so the compiler enforces that the new case is handled everywhere. Do it in the
slice that first surfaces artifacts as evidence (slice 5), with a test per group label.

## 8. Four tours, not five

**File gets no tour.** `produce_file` already exists and File is not a new kind; a tour would explain
something the user already knows. Tours ship for Document, App, Canvas and Slides, and the parent spec's
"each type shows a tour" is read as the four new types.

## 9. The performance gate: structural in CI, measured locally for the figure

A strict "≥ 60 fps" assertion cannot be honest on a shared CI runner. Ruling:

- **CI asserts structural budgets** — board JSON size, node and stroke counts, and a timing ceiling with a
  generous margin, all deterministic and machine-independent.
- **The 60 fps figure is a local, recorded measurement** (the prototype's `_probe.mjs` already produces it:
  163 nodes + 202 annotations at 8.3 ms average frame). Slice 3's spec must say which of the two a failing
  check means, so nobody "fixes" a slow CI runner by weakening the product.

## Consequences for the slice specs

- Slice 3: body list loses `comments`; the perf gate is split as §9.
- Slice 4: PPTX only; layouts fixed; the mockup's export line corrected.
- Slice 5: tool guidance on the tools; the two `AGENTS.md` fixes; `EvidenceSourceType` widening with tests;
  artifacts as evidence rows, not new Info rows.
- Slice 6: four types, code-owned structure with a campaign override and the `summary` layout.
