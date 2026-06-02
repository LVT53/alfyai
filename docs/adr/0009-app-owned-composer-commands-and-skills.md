# App-owned composer commands and skills

AlfyAI will implement `$` skills and `/` composer commands as an app-owned Normal Chat composer registry, not as hidden prompt text, strict command syntax, or model-side side-effect tools. Commands become structured composer state, skills become declarative app-managed definitions with optional durable Skill Sessions, and note-capable skills write living Skill Notes through bounded server-validated operations. App-owned Normal Chat tools remain separate model-facing capabilities for agent-side data access or side effects, while skill activation, skill drafts, user/system ownership, command UI, session state, and note persistence stay inside AlfyAI.

**Considered Options**

- Treat `$` and `/` as prompt macros that paste hidden instructions into the user message.
- Implement skills as model-facing tools that can create or update app configuration.
- Build a strict command language where users must know command arguments such as document names.
- Implement an app-owned composer command registry with structured metadata, explicit UI state, and server-side validation.

We chose the app-owned registry because skills and commands are user-facing product state: they need settings UI, ownership, permissioning, durable session behavior, context-selection integration, and recoverable note writes. Prompt macros would pollute transcripts and make behavior hard to audit. Model-side side effects would blur app configuration with agent execution and make retries or partial streams risky. Strict command syntax would make the feature brittle for ordinary users.

ADR-0017 complements this decision: `/document` creates Linked Context Sources from existing Working Documents, and Working Document Identity canonicalizes their display, prompt, family, and prompt-readiness identity before chat preflight persists or uses them.

**Acceptance Scenarios**

- Typing `$` or `/` opens a composer-attached Command Tray, and Enter selects the highlighted row before message send.
- Selecting a command consumes only the selected command token, preserves surrounding message text, and stores the result as structured composer state.
- A user can combine one pending or active Skill, multiple linked documents, uploaded attachments, and ordinary composer settings in one Normal Chat turn.
- `/document` opens a Document Picker Modal for selecting existing Library Documents as Linked Context Sources rather than uploading copies.
- A selected Skill enters the chat turn as structured Skill context; the visible transcript preserves the user's message text.
- A durable Skill Session survives refresh and appears in an active Skill Session Panel while it can affect future turns.
- A question-capable Skill asks through ordinary assistant messages marked as Skill Questions, not through a separate question transport.
- Skill state changes flow through a server-validated Skill Control Envelope stripped from visible assistant text.
- A note-capable Skill writes Skill Notes through bounded create, replace, or append operations, never raw filesystem paths or arbitrary file writes.
- AI-proposed skills appear as Skill Draft Cards and do not enter `$` discovery until a user saves them.
