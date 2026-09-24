# "Claude at home" means workspaces, living documents and richer inputs, not platform integrations

Accepted (2026-09-24).

AlfyAI's goal is "to have Claude at home". It is a private, self-hosted assistant for the owner first, and for a few family members and friends second. It will not be offered publicly. Stability and speed are no longer the problem: production went 30 days with zero failovers, and there are about 150 user messages a month across 3 active users. The remaining gap is the experience. This ADR records which parts of that gap we are closing, in what order, and what we are deliberately not doing. It came out of a comparison of the Claude apps against AlfyAI and a goals interview with the owner (2026-09-24).

## Decision

We close the gap in this order, ranked with the owner:

1. **Folders become workspaces.** Add **Personal Instructions** (one account-wide box) and, on each **Project Folder**, **Folder Instructions** plus **Folder Knowledge** (uploads linked straight to the folder). This matches Claude, which has both account-wide and per-project instructions. It comes first because it is small and every conversation feels it, and because #2's **Document Bundle** needs folders that carry meaning.
2. **Living Documents** (see [ADR-0065](0065-living-documents-are-edited-in-place.md)). These are drafts, plans and interactive checklists that the user and AlfyAI both edit in place. It ships in phases:
   - **2a:** documents AlfyAI creates, tickable checklists, and targeted AI edits with visible changes.
   - **2b:** the user's own rich-text editing, plus **Selection Edit**.
   - **2c:** the folder **Document Bundle**.

   It shares the export renderers with `produce_file`, whose reliability fixes have already shipped (2026-09), so nothing blocks it.
3. **File analysis in the sandbox.** Uploaded CSV/XLSX files go into the offline sandbox read-only, and the sandbox image gains pandas and matplotlib. Charts and cleaned files come back as file cards. The no-network security model stays. This is independent of #1 and #2 and can run alongside them.
4. **Image understanding.** A `look_at_image` tool backed by a small vision model on GPU 1. The conversation keeps the text description, not the image.
5. **Dictation.** Self-hosted speech-to-text (a Whisper-class model on GPU 1) and a microphone button in the composer. It ranks last because phone keyboards already dictate.

Every new user-facing string ships in English and Hungarian. Anything added to the models must be self-hostable and handle both languages.

## Not doing (parked)

- **Platform integration:** a desktop app or global hotkey, a native phone app or share-sheet target, a terminal CLI, or AlfyAI acting from inside Nextcloud, mail or calendar. The owner judged the effort not worth it. The local model is already reachable from OpenCode for terminal work.
- **Full voice mode (speaking back).** Natural self-hosted Hungarian speech output is weak today. Only dictation (speech in) is on the list.
- **Network access and long-running jobs in the sandbox.** Parked as future enhancements to #3. `research_web` and `fetch_url` cover getting data from the web.
- **Zip archive upload and browsing.** Parked earlier, unchanged.

## Why this shape

The comparison showed AlfyAI already matching or beating Claude on:
- research with citations
- memory control
- connectors for home services
- cost transparency
- Hungarian support
- forking conversations

The gaps the owner actually feels are elsewhere: being able to shape the assistant (instructions), keeping work that evolves (documents in place of one-shot file downloads), and accepting more kinds of input (spreadsheets it can really analyse, images).

Model quality compared with cloud frontier models is out of scope. It follows from self-hosting and is not a product lever.

## Consequences

- Project Folders stop being only colour tags. They carry instructions, knowledge and a document bundle, so folder membership will matter more to prompt assembly.
- AlfyAI will diverge from Claude where Claude assumes cloud infrastructure: scheduled cloud tasks, phone push for everything, remote MCP. Those gaps stay open on purpose.
- Usage data (2026-08/09) showed the large features (Atlas, connectors) are rarely used, while everyday tools are used heavily. New features should appear in the conversation where they are needed (for example, a checklist the model offers), not only behind menus.
