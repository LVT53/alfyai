# Feature notes — design

**Status:** approved for implementation (2026-10-17).  
**Mockup:** [`docs/design/feature-note/index.html`](../../design/feature-note/index.html) (desktop, phone, dark/light detail, longer-copy variants).

## Intent

Campaigns are good at one thing: a major or minor release that deserves a full, multi-slide, screenshot-led announcement. They are too heavy for the smaller things — a security capability such as two-factor authentication, a new export option, a sharper answer on long chats — and publishing one as a campaign would replace the campaign the owner wants readers to keep seeing.

A **feature note** is the lighter sibling: one short, dismissable strip that appears on the landing page (the app's new-chat surface), names the feature first, says why it matters in one line, and offers one way in. It lives in the campaigns pipeline, but it never competes with a campaign and never turns into a queue.

## Goals

- A fourth campaign type, `feature_note`, authored and published from the existing Settings → Campaigns pane.
- A single-slide, single-idea note; no carousel, no screenshots, no setup controls.
- Delivery only on the landing/new-chat surface; never over an existing chat, Settings, a project page, or a turn.
- One announcement at a time: a campaign wins, and a note never follows a campaign in the same landing arrival.
- The note disappears the moment a message is sent, but is not dismissed by sending.
- It returns on later arrivals until the reader presses X (or the CTA) or has seen it four times.
- One live note at a time: publishing a new one supersedes the previous one; an older note never resurrects.
- EN/HU content and chrome; the note is accessible as a region, not a dialog.

## Non-goals (v1)

- No replay from the sidebar version badge, no “What’s new” history page, no user-facing archive of past notes.
- No scheduling, targeting by audience segment, or per-note frequency other than the shared four-impression cap.
- No uploaded artwork or per-note icon picker: every note uses the same sparkle tile.
- No performance card for notes in v1. The events are still recorded, so a later card can read them.
- No external action URLs. Notes link only to allow-listed internal app routes.

## Approved decisions

### 1. A fourth campaign type, not a parallel system

- `AnnouncementCampaignType` gains `feature_note`.
- It uses the existing campaign tables, immutable published snapshots, admin draft/publish/archive lifecycle, per-user state and event rows.
- Its one slide uses the existing `standard` layout; the `feature_note` type carries the note rules. No new slide layout is added.
- Content stored per note:
  - title EN/HU (the feature name — always the first line),
  - body EN/HU (one short benefit/explanation line),
  - optional action label EN/HU and allow-listed destination.
- No desktop/mobile crops, no alt text, no setup controls.
- The fixed visual is a Lucide `Sparkles` tile, then the title, then the body with the optional CTA inline at the end of the body row, and an X at the top right.
- The campaign version is `v1`; each new note is the next revision (`feature_note:v1:rN`). The admin names the note; no separate slug or version field is exposed.

### 2. Delivery surface and priority

- The note renders only when the landing route is active (`/(app)`). It does not render on `/chat/[id]`, Settings, Knowledge, or a project page.
- It floats at the top of the main content: centered, 620 px wide on desktop; full width minus 8 px margins on a phone, below the header and above the composer. It does not block the composer.
- It is a **region**, not a dialog: no scrim, no focus trap, no auto-focus. The campaign stays the only modal announcement.
- Campaign priority:
  - If a campaign is eligible on this landing arrival, the campaign opens and the note does not.
  - If a campaign is open, the note does not render.
  - A note never follows a campaign in the same landing arrival; it waits for the next landing arrival.
  - If a campaign opens while the note is visible (a race), the note is cleared.
- A **landing arrival** means the landing route becoming active — the initial load of `/`, or a client-side navigation back to `/` (the sidebar's New chat door). It is not every re-render.
- The note is asked for once per landing arrival. It is not re-fetched on window focus, conversation-list refresh, or while it is already on screen. A send, a campaign opening, or leaving the landing latches it off for the rest of that arrival, so a failed send cannot pop it back.

### 3. Hide on send; four impressions; two terminal exits

- The landing page already owns `sendStarted`. A shared UI flag mirrors it to the shell; the layout unmounts the note the instant a send begins. Sending is not a dismissal: the note is eligible again on the next landing arrival if it has not been dismissed or exhausted.
- An **impression** is one landing arrival where the note was actually rendered. The client records it with the existing campaign `auto_shown` event. The server returns the note only while the user has fewer than four `auto_shown` events for that snapshot:
  - 1st–4th arrival: the note may render; the 4th is the last.
  - 5th arrival onward: eligibility returns null.
- **X** writes the existing `skipped` terminal state through `completeCampaign`; the note is gone for good.
- The cap is **soft**: the eligibility read and the impression write are separate requests, so two tabs or a very fast reload can exceed four. Accepted for v1; the note is a nudge, not a quota.
- **CTA** writes the existing `completed` terminal state through `completeCampaign`, then follows the allow-listed destination. Acting is a stronger signal than seeing; it ends the note.
- A failed impression or completion call is a console warning, never a blocked landing page. The cap is best-effort across multiple tabs; two simultaneous arrivals can both render and both count.

### 4. Eligibility, superseding, and account age

`getEligibleFeatureNoteForUser(userId)` returns the latest published `feature_note` only when all of these hold:

1. The account was created before the note was published (the welcome is a new account's introduction; a note is for people who were already here).
2. The user has no terminal state for that snapshot (`completed` or `skipped`).
3. The user has fewer than four `auto_shown` events for that snapshot.

The note is not returned by `getEligibleCampaignForUser`; the campaign modal must never open a note. `getLatestPublishedAnnouncement` (the sidebar badge) must never return a note. `feature_note` is served only by its own reader.

Publishing a `feature_note` archives every older published `feature_note` in the same transaction. There is one live note; archiving it leaves no older note to resurrect. Release updates and first-run onboarding are untouched.

### 5. API

- `GET /api/campaigns/feature-note` → `{ note: FeatureNote | null }`.
  - `requireAuth`.
  - Returns null when the account has an active chat stream.
  - The service owns who may see it.
  - The shell calls this only after `/api/campaigns/eligible` has returned no campaign on the document load, or on a later landing arrival where no campaign is active. The campaign endpoint's response is unchanged.
- Impressions reuse `POST /api/campaigns/[id]/events` with `eventType: "auto_shown"`. No new event type.
- X reuses `POST /api/campaigns/[id]/complete` with `{ reason: "skipped" }`.
- CTA reuses `POST /api/campaigns/[id]/complete` with `{ reason: "completed" }`, sent with `keepalive` so the completion survives the navigation the `<a>` starts.
- No new table, no migration: impressions are the existing campaign event rows; terminal exits are the existing campaign user-state rows.

`FeatureNote` is the mapped single slide:

```ts
type FeatureNote = {
  id: string; // campaign id, for the event/complete calls
  name: string;
  snapshotId: string;
  title: { en: string; hu: string };
  body: { en: string; hu: string };
  actionLabel: { en: string; hu: string }; // empty strings when there is no action
  actionDestination: string | null;
  publishedAt: string | Date;
};
```

### 6. Admin authoring

- The New campaign dialog offers **Feature note** alongside First-run and Release. Choosing it does not ask for a release version.
- Creating a feature note seeds exactly one empty `standard` slide (`sortOrder 1`, `semanticRole feature`). The note editor is words and one optional action:
  - title, body, action label, destination;
  - no image blocks, no alt text, no layout/purpose/setup menu, no add/delete/reorder controls;
  - the language pills and the EN→HU copy action remain.
- The publish checklist mirrors the server rules:
  - exactly one slide, `standard` layout, `feature` role;
  - title and body in EN and HU;
  - optional action destination must be allow-listed and must not be an `internal:` action; when set, both action labels are required;
  - no crops, alt text, or setup controls.
- The rail row and editor meta line read “Feature note · 1 note”, not “Release · …” or “1 slide”.
- The right-hand preview is the reader's own note card, rendered inert with the draft's words in the language being edited. It is not the campaign modal.
- No performance card in v1. `auto_shown`, `completed` and `skipped` events are still recorded per note.

### 7. Visual and accessibility

The approved mockup is the reference. The strip:

- Uses `--surface-elevated`, `--border-default`, `--radius-lg`, the app shadow and the app's two fonts.
- Has a 42 px dotted tile with a 24 px Lucide `Sparkles` in accent; this is the only “new” signal (no “NEW” label).
- Title in Libre Baskerville, 15 px; body in Nimbus Sans, 13 px; the optional CTA is a 12.5 px accent link with an arrow at the end of the body line, in the same row. It never adds a third line.
- X is a 32 px icon button with a localized accessible label. There is no “Not now” button; X is the dismiss.
- The note does not steal focus. It is a labelled region in the DOM before the home content. A polite live announcement names the feature once for screen readers.
- Motion is a short fade/slide-in; instant under `prefers-reduced-motion`. Unmounting on send is immediate.
- If the stored action destination is empty or not allow-listed, no CTA is rendered (the note is inert text).
- The note's text is admin content and localized EN/HU; the chrome (`New feature`, `Dismiss`) lives in the app dictionary.

## Behaviour table

| Moment | Result |
|---|---|
| Landing arrival with no campaign | Ask for the note; if eligible, render it and record one impression. |
| Landing arrival with a campaign eligible/open | Campaign shows; no note this arrival. |
| Campaign dismissed, then the reader stays on the landing | No note in this landing arrival. |
| Reader navigates back to the landing later | New landing arrival; note may show if still eligible. |
| Reader starts a send | Note unmounts immediately; impression already counted; not dismissed. |
| Send fails and the reader stays | The note stays hidden for this landing arrival; the next arrival may show it again. |
| X | `skipped` terminal state; note gone for good. |
| CTA | `completed` terminal state; navigate; note gone for good. |
| Fourth display | The note is shown; the fifth eligibility read returns null. |
| Admin publishes a newer note | Older published notes are archived; the new note starts at zero impressions. |
| Admin archives the live note | No note; no older note resurrects. |
| New account | No note (created after publish); welcome is its introduction. |
| Active chat turn | Eligibility returns null; the next arrival asks again. |

## Edge cases considered

- **Landing-to-chat full navigation:** the note is already unmounted by `sendStarted`; the shell load for the chat does not ask for a note (route guard).
- **Campaign race:** if a campaign opens while the note is on screen, `activeCampaign` clears the note; the campaign is the only announcement.
- **Multiple tabs:** each tab can render and count an impression; the four-impression cap is per user per snapshot, so tabs can exhaust it faster. Accepted.
- **Snapshot identity:** a new note is a new snapshot and a new impression count; old events stay for analytics. Dismissing a note is per snapshot.
- **Action safety:** admin-authored destinations are checked at publish and again in the note component; `internal:` actions are not valid for notes.
- **Localization fallback:** missing EN/HU is a publish error; a reader's language always has a complete note.
- **Incognito:** the note is app-level, contains no conversation content, and is allowed; it writes only campaign state/events, not chat content.
- **Account erasure / cascade:** existing campaign event and state rows cascade with the user; no new table to add to the archive/erasure lists.

## Testing

- Server: create/publish/validate a note; superseding; eligibility by account age, terminal state and impression count; `getEligibleCampaignForUser`/`getLatestPublishedAnnouncement` ignore notes; analytics counts.
- Client: `FeatureNote` rendering, localization, X/CTA callbacks, no-CTA state, preview inertness, one `auto_shown` recorded by the shell per accepted landing arrival (the component has no `onShown` prop).
- Checklist/labels: note shape and action rules mirror the server; rail/meta lines.
- E2E: publish a note via the admin API; see it on the landing; X; four-impression cap; hidden on send; campaign priority; admin create/publish/preview. Every test archives what it published.
- Gates: `scripts/gates.sh agent <out-dir> --port <base>` with `tests/e2e/feature-note.spec.ts` plus the campaign/admin specs touched.

## Calls made (not questions)

- The note shows on every landing arrival, including a client-side New chat, not only on a full document load. It is light and tied to the safe surface; the campaign modal keeps its stricter document-load rule.
- The note is not replayable and is not added to the version badge. Acting on it or dismissing it is the end.
- The performance card is hidden for notes in v1 to avoid reusing “finished all slides” language for a one-line note.
- Notes accept only internal app paths, not `internal:` actions.
- The body is a short sentence; the editor's guide drops from 600 to a note-sized hint. The strip wraps if an admin writes more, but the approved copy is one line.
