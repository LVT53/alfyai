# Thinking display amendment

Accepted after independent spec review on 2026-11-11. This amends only ordinary working-text presentation; the ModelRun completion owner and structural answer projection remain unchanged.

## Regression

Commit `c4b7b001daf7218eccffcb0a83aeebb21185cfd7` added ordinary commentary rendering to ThinkingBlock. At audited HEAD `dd51fd9d2`, ThinkingBlock's live-or-expanded condition showed `output.activity` prose even when the rail was collapsed. The shared projection selects text blocks whose role is not answer, including provisional text; native reasoning blocks are excluded. Provisional answer-shaped text could therefore look like thinking before its structural promotion. This finding does not diagnose server answer withholding.

## Binding display rules

- Never render ordinary activity prose while its own segment is live, including when the rail is expanded. An activity-only running segment keeps the existing Thinking status. Existing thought summaries, tool/status rows, anchored reveals and full-reasoning opt-in keep their behavior.
- Retained ordinary activity is inspectable only for an explicitly completed stopped, paused, incomplete or failed segment, after deliberate terminal disclosure. Missing completion and answered/delivered outcomes never authorize it.
- Rail expansion during a live segment does not authorize terminal activity disclosure. Authorization is scoped to the completion's turn ID, segment ID and outcome, and is cleared on every eligibility-key change, including transitions through a different terminal segment or a live state. An already expanded reasoning rail stays expanded: close and reopen it to disclose newly retained activity. Keeping rail expansion distinct preserves existing reasoning opt-in and tool-row ownership.
- A paused segment explicitly opened by the reader stays inspectable while another segment resumes. Eligibility is per component/segment, never a conversation-wide streaming flag. Revoked prose is removed immediately rather than retained by an exit transition.
- Preserve event bytes, ordering, role settlement, persistence, replay, completion notices, canonical captions and legitimate partial answers. Copy/export retain their existing answer-only projection and incomplete-answer labels. Do not promote working prose, delete events, add a classifier or change answer timing.

## Verification

Focused component regressions cover collapsed/expanded live activity and provisional text, all four interrupted outcomes, missing/successful completion, fresh terminal authorization, segment A-to-B-to-A reuse, same-segment return to live, and independently running segments. Retained disclosure still escapes markup and strips complete Skill Control envelopes and interrupted closing syntax for both ended states while preserving ordinary literal delimiters, including after a closed envelope.

The card-arrival and image-motion specs use an existing live status anchor and an explicit test-owned browser delivery barrier before tool frames, preserving nonempty pre/post-arrival geometry and original motion thresholds. Canonical final-answer/card ordering, reload, Copy and export checks remain independent. Synthetic client-stream phases cover already committed answer prose followed by a late card without changing the production ModelRun contract.

The controller owns the final agent gate: chat, streaming, conversation, ask-me-first, images, images-motion, artifact-card-arrival and turn-completion-contract specs in full. No deployment is authorized by this amendment.
