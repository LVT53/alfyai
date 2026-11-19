# Accepted personal/project memory boundary

Owner decision, 2026-11-18. This supersedes any earlier design allowing the model to promote project statements into global memory.

- Personal memory belongs to the authenticated user and is available in their personal chats and all their projects.
- Memories learned in a project stay in that project, including personal-sounding preferences. No automatic promotion to personal memory.
- Moving a chat out keeps its already learned project memories in the original project. New eligible turns use the chat's new scope. Moving the chat does not change where its earlier project assertions can be learned or used. Source deletion, historical-import withdrawal and project or account erasure still apply to the original bank.
- Deleting a project detaches its surviving chats and retires its Memory bank. Earlier project assertions remain excluded from personal Memory, including history that Memory never learned. New eligible turns in the detached chat can use personal Memory.
- A personal chat reads personal memory only. A project chat reads personal memory plus that project's memory, never another project's memory.
- Outside a project, Alfy may know its existence, name and description through existing authorized AlfyAI project records. This is project metadata, not access to project memories. Do not copy these records into a second memory store.
- Automatic sharing of project key points, decisions or progress is not approved. A deliberately shared overview is a possible later feature, not part of the accepted default.
- Proposed Hindsight mapping: one personal bank per user and separate user/project banks. AlfyAI routes writes and combines bounded reads from the eligible banks. Native extraction stays native. Bank routing, authorization and the existing correction/publication safeguards remain required integration work; bank separation is not a substitute for endpoint authorization.
- No project-to-personal write from ingestion, consolidation, corrections, source replay or retries. Reset/erase and stale work must respect these boundaries.
- Verify personal + project combined recall, cross-project exclusion and project-only writes in the actual integration. This decision is not a claim that these paths are already implemented or tested.

## Current Memory and past conversations

Use current Memory for remembered personal facts and preferences. Search past chats only when the current user message explicitly requests it, for example “What did I say about the lamp in a previous chat?” or “Mit mondtam a lámpáról egy korábbi beszélgetésben?” The same rule applies to past project discussions. Memory controls and existing conversation ownership and project scope still apply.

Visible messages in the current chat, explicitly linked sources, and authorized project metadata and files remain available. A later turn reads Memory or requested chats through the current authorization checks.

UI implication: choose a memory space explicitly. Personal says “Available in all your chats”; each project says “Only used in this project”. Project views distinguish their own stored memories from personal memory also available there. Name/description awareness is not a remembered project fact. The later [Quiet list design](agreed-ui-design.md) is approved and the [full implementation plan](../../superpowers/plans/2026-11-18-hindsight-memory-replacement.md) is finalized. Deployment, real-user migration and cutover require separate authorization.
