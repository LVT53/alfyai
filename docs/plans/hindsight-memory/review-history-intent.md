# Independent review of old-chat access

The staged regression at baseline `365acf876` is documented in [the paired restore receipt](staging-app-evidence/gpu-curation-restore-results.json). Its first current-fact model answer included the old Meridian marker. The recorded tool was `memory_context` in `history` mode and the marker appeared in its candidate payload. The receipt attributes that result to retained chat content.

## Review criteria

- Current personal facts use curated Memory and the current conversation. An empty Memory lookup leaves the fact unknown. The model's request fields, prior turns, connector text, attachments and summaries confer no permission to search old chats.
- An explicit request in the user's current words can open historical sources in English and Hungarian. Search results and dialogue must retain their existing ownership, project, incognito and removal boundaries. Historical claims remain attributed to the earlier conversation.
- The policy covers both plain and streaming Normal Chat, including retries and a reply resumed after asking the person. An ID or a request for details cannot grant access independently. Authorized project metadata and ordinary same-chat dialogue remain available.

## Baseline source trace

Both transports converge on the prepared Normal Chat runner and its shared tool factory. Current request text reaches that factory as `requestText: params.message`. Stream retries and Ask Me First resumes reconstruct the original user request from the stored user message.

Personal mode reads curated Memory. History mode searches other owned personal chats and excludes incognito, current-chat and project rows. Loading selected dialogue also checks the ID against the scoped candidate list and rechecks ownership and chat scope. The baseline tool admits `history` on the model's selection alone. Project mode has separate summary, detail and report paths. Outside the current project it can look up a folder by the model's query and surface old dialogue. Prompt assembly can also automatically include sibling summaries and lexical sibling-message matches. Native conversation history can replay stored tool digests carrying historical tool output alongside the user-visible chat transcript.

## Findings on the first candidate

The candidate adds a server-side refusal before memory retrieval and gates automatic project sibling access. The first classifier passed the direct English and Hungarian historical questions and the vague memory questions. Six other questions incorrectly opened old chats, including explicit “without searching old chats” wording, a PDF about earlier conversations, chat-history deletion help and the Hungarian “anélkül, hogy” negative construction. Four direct historical questions were rejected, including “Do you remember what we discussed in our previous conversation?” These findings were returned to the implementer before staging.

The patch also initially allowed stored historical tool digests on later explicit turns without rereading the source. Source deletion, changed scope or the Memory switch could therefore affect a fresh lookup differently from a replay. Automatic project sibling reads also needed to honor the active Memory and incognito conditions. Both paths were returned to the implementer for review.

Independent focused Vitest execution for `memory-context.test.ts`, `memory-context/project.test.ts` and `memory-context/project.folder-retrieval.test.ts` passed all 48 tests. These exercise the existing read-side checks and the project retrieval service. The revised prompt assembly checks active Memory and a specific current-project reference before loading project siblings. Stored historical tool results are dropped from both native and flattened replay while visible dialogue stays available.

## Revised candidate findings

The later classifier classified all 28 independent review inputs as expected under the owner's rule that asking what was decided in a named project requests prior discussions. The cases cover direct English and Hungarian historical references, current and vague memory questions, quote-only commands, prohibitions on searching, project questions limited to the current chat and chat-history help. Later regression cases cover smart apostrophes and direct titled-chat references.

Focused Vitest execution passed 99 tests covering the classifier, conversation replay and refusal on the plain and streaming runners. The transport test runs the real tool factory with a scripted provider and verifies that a model-supplied history or project search is settled as definitely unexecuted before it can fetch chat content. A later focused run passed 53 tests covering the expanded classifier and Ask Me First resume path. These counts overlap. The later-turn renderer discards all stored Memory tool digests, including old persona results, in native and flattened formats. The user-visible conversation remains available.

The first candidate, `aef0cad06`, detects prior-turn Memory digests in old exact Ask Me First captures and rejects historical output captured without user authorization. The follow-up, `e38f7cdec`, closes resumes that contain exact cross-chat excerpts with no revalidatable source revision. It checks current Memory controls and durable Clear, revocation and project-move records before replaying captured persona context. A user's subsequent free-text prohibition vetoes fresh old-chat access on resume. These checks run at resume admission. The review did not exercise a concurrent privacy change between admission and provider dispatch.

## Isolated staging evidence

The isolated runtime used `aef0cad06` with the actual Qwen provider. With curated Memory active, English and Hungarian current-fact answers returned the current marker alone. Every captured model request in these cases lacked the old marker. The Hungarian provider attempted history anyway. The recorded refusal had zero candidates, and the model saw an unsuccessful tool result without any old text.

After Clear, the Memory UI confirmed zero current rows and the original chat remained visible. Fresh English and Hungarian current-fact answers said the current name was unknown. Their provider requests, tool results and persisted replies contained neither marker. Explicit English and Hungarian history requests before and after Clear returned the old marker with historical attribution. The history candidates included the original seeded conversation.

The English after-Clear streaming probe said the name was unknown. Its history request was refused, both name markers were absent, and persona did carry the old title in a newly accumulated candidate. The Hungarian historical streaming probe returned and attributed the old marker through previous synthetic verification discussions. Its ledger did not include the original named chat.

In the after-Clear English plain historical probe, the model retrieved the original and other owned past chats. It attributed the old name to the original discussion and asserted the former current marker as presently valid. The second claim came through earlier synthetic verification transcripts. The redacted receipt records a non-negated current assertion. This is a failure to keep historical material separate from current facts within an authorized historical answer. The named-source streaming probe also demonstrated that lexical candidate selection can answer from other conversations.

## First-stage verdict

The ordinary current-fact regression passed on both transports. The historical source precision and current-fact assertion failures led to the named-source correction below. The staged model and wire evidence covers `aef0cad06`; the paused-reply follow-up was reviewed separately in source and was outside the staged probes.

## Named-source correction

In `447cde74b`, the server reads the title selector from the current user message. A unique eligible title resolves before message or summary queries, and those queries are constrained to its chat ID. Eligible sources are the person's own personal chats and named chats in the current project. The active chat, incognito chats and other projects stay outside that lookup. Unknown and duplicate titles stop the call. A different ID in model-supplied detail arguments cannot change the target. Named requests also suppress automatic project sibling excerpts. Historical tool payloads and the base prompt instruct the model to attribute past claims to their source and time and to use current Memory or current user words to answer about the present.

Independent review checked the exact English and Hungarian stage wording, ordinary quoted titles, ownership and project scope in both the candidate and detail reads, and the no-fallback path. The candidate's focused suite passed all 519 tests. The 28 earlier independent intent cases and seven additional named-selector cases passed on the final commit.

The isolated rerun used the exact `447cde74b` runtime on a clone retaining the earlier competing synthetic transcripts. The independent receipt check covered 11 actual provider requests. Both plain historical replies and the Hungarian streaming reply received a single candidate from the original named chat. Their tool results carried the original chat ID and the past-chat-only label. The historical answers attributed the old name to what the person said at the time. The competing cleared name was absent from the new model wires and replies. The ordinary English and Hungarian plain probes and the English streaming probe said the current name was unknown. Plain English attempted history and the server refused it. Its persona result still contained the chat title, but no name marker or original-chat history candidate.

The rerun clears the specific named-source and temporal regression under the tested English and Hungarian prompts. The earlier mixed receipt remains part of the record. These probes used synthetic accounts and did not exercise an actual migration or a concurrent privacy change during Ask Me First resume.
