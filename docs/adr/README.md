# Architecture Decision Records

This directory records the architectural decisions behind AlfyAI. Each file captures the context,
decision, and consequences for one boundary or behavior. The list below is generated from the ADR
files in this directory (numbers `0007` and `0014` are intentionally absent).

| ADR | Title |
|---|---|
| [0002](0002-chat-turn-context-selection-boundary.md) | Chat turns own context selection |
| [0003](0003-context-selection-trace-first.md) | Log context selection before changing selection behavior |
| [0004](0004-context-selection-production-slices.md) | Migrate context selection in production TDD slices |
| [0005](0005-unified-file-production-boundary.md) | Unify file production behind one service boundary |
| [0006](0006-model-scaled-context-selection.md) | Model-scaled context selection replaces small fixed caps |
| [0008](0008-project-folder-continuity-convergence.md) | Project folders converge AI project continuity |
| [0009](0009-app-owned-composer-commands-and-skills.md) | App-owned composer commands and skills |
| [0010](0010-conversation-forks-are-snapshot-conversations.md) | Conversation forks are snapshot conversations with lineage |
| [0011](0011-honcho-led-memory-context.md) | Honcho-led Memory Context replaces project-only retrieval (superseded — see 0045) |
| [0012](0012-announcement-campaigns-and-first-run-onboarding.md) | Announcement campaigns and first-run onboarding |
| [0013](0013-skill-packs-and-variants.md) | Skill packs and variants |
| [0015](0015-normal-chat-turn-completion-boundary.md) | Normal Chat turn completion belongs to chat-turn |
| [0016](0016-browser-sse-protocol-boundary.md) | Browser SSE Protocol was superseded by AI SDK UI streams |
| [0017](0017-working-document-identity-boundary.md) | Deepen Working Document Identity |
| [0018](0018-working-document-selection-boundary.md) | Collapse Working Document Selection Signals |
| [0019](0019-normal-chat-client-turn-runtime-boundary.md) | Normal Chat Client Turn Runtime belongs above streamChat |
| [0020](0020-langflow-model-run-boundary.md) | Langflow Model Run was a dedicated execution boundary |
| [0021](0021-document-preview-runtime-boundary.md) | Deepen Document Preview Runtime |
| [0022](0022-conversation-detail-read-model-boundary.md) | Conversation detail payload assembly belongs to the read model |
| [0023](0023-generated-file-serving-boundary.md) | Deepen Generated File Serving |
| [0024](0024-knowledge-upload-intake-boundary.md) | Deepen Knowledge Upload Intake |
| [0025](0025-ai-sdk-ui-stream-migration-sequencing.md) | AI SDK UI streams and messages ship before the next remote deployment |
| [0026](0026-normal-chat-retires-langflow-for-vercel-ai-sdk.md) | AlfyAI retires Langflow for Vercel AI SDK |
| [0027](0027-model-provider-and-provider-model-separation.md) | Model Provider and Provider Model separation |
| [0028](0028-normal-chat-reasoning-depth.md) | Normal Chat Reasoning Depth replaces the Thinking toggle (superseded — see 0061) |
| [0029](0029-account-erasure-keeps-only-anonymous-aggregates.md) | Account Erasure Keeps Only Anonymous Aggregates |
| [0030](0030-account-erasure-quiesces-user-work.md) | Account Erasure Quiesces User Work |
| [0031](0031-account-erasure-detaches-shared-admin-content.md) | Account Erasure Detaches Shared Admin Content |
| [0032](0032-account-data-archive-is-human-readable.md) | Account Data Archive Is Human-Readable |
| [0033](0033-guided-memory-review.md) | Memory Rework Update keeps Honcho-led memory usable long-term (superseded — see 0045) |
| [0034](0034-workspace-search-boundary.md) | Workspace Search is server-backed |
| [0035](0035-chat-surface-visual-design-decisions.md) | Chat Surface Visual Design Decisions |
| [0036](0036-atlas-is-normal-chat-turn-not-parallel-subsystem.md) | Atlas is a Normal Chat Turn + artifact backed by a single in-process background worker |
| [0037](0037-atlas-uses-bounded-adaptive-rounds-not-autonomous-research-loops.md) | Atlas uses bounded adaptive rounds, not autonomous research loops |
| [0038](0038-atlas-publishes-writer-centered-reports-not-source-dumps.md) | Atlas publishes writer-centered reports, not source dumps |
| [0039](0039-deferred-memory-extraction-and-honcho-substrate-restoration.md) | Deferred Memory Extraction restores Honcho as substrate with LLM-assisted Tier 2 intake (superseded — see 0045) |
| [0040](0040-atlas-quality-gate-analytics-and-rendering-improvements.md) | Atlas quality gate, analytics, and rendering improvements |
| [0041](0041-stream-admission-before-turn-preparation.md) | Stream Admission happens before heavy Turn Preparation |
| [0042](0042-normal-chat-context-preparation-telemetry.md) | Normal Chat context-preparation telemetry separates raw stages from visible activity |
| [0043](0043-ui-refresh-identity-clarity-and-jump-rail.md) | UI Refresh — Identity, Clarity, Jump-Rail, and Touch Foundation |
| [0044](0044-connections-ui-redesign.md) | Connections UI Redesign |
| [0045](0045-memory-v2-judge-gated-local-memory.md) | Memory v2: judge-gated local memory replaces the Honcho substrate |
| [0046](0046-automatic-depth-selection-is-deterministic.md) | Automatic Depth Selection is a deterministic rules classifier, not an LLM preflight |
| [0047](0047-provider-cost-price-windows-and-cache-accounting.md) | Provider cost accounting: time-slot price windows and prompt-cache token accounting |
| [0048](0048-openai-compatible-provider-family-compatibility.md) | Provider-family compatibility profiles are the seam for OpenAI-compatible quirks |
| [0049](0049-analytics-excluded-users.md) | System Analytics can exclude specific users, including deleted ones |
| [0050](0050-connections-backend-module-seams.md) | Connections Back-end Module Seams |
| [0051](0051-folder-anchored-continuity-retires-inferred-buckets.md) | Folder-anchored continuity retires the inferred project-memory substrate |
| [0052](0052-replace-searxng-web-research-with-parallel-search.md) | Replace SearXNG web-research pipeline with Parallel Search/Extract |
| [0053](0053-atlas-post-migration-deepening.md) | Atlas is deepened along four module seams after the Parallel migration |
| [0054](0054-atomic-release-cutover.md) | Deploys cut over atomically between immutable release directories |
| [0055](0055-tool-usage-guidance-lives-in-the-tool-interface.md) | Tool usage guidance lives in the tool interface |
| [0056](0056-interim-thought-steps-are-durable-turn-state.md) | Interim Thought Steps are durable turn state, not a rendering of raw reasoning |
| [0057](0057-memory-v2-internal-hardening.md) | Memory v2 internal hardening: one write door, one read seam, one dispatch, one control-model adapter, one scheduler |
| [0058](0058-todoist-retired-and-connection-catalog-grouped.md) | Todoist Retired; Connection Catalog Grouped |
| [0059](0059-db-execution-seam.md) | Query execution goes through one seam |
| [0060](0060-client-turn-runtime-owns-turn-state.md) | The Normal Chat Client Turn Runtime owns turn state |
| [0061](0061-thinking-toggle-replaces-depth-ladder.md) | A single Thinking toggle replaces the Reasoning Depth ladder |
| [0062](0062-atlas-content-pipeline-is-rebuilt-on-the-harness-tools.md) | Atlas's content pipeline is rebuilt on the harness's research tools, behind a pipeline flag |
| [0063](0063-atlas-v3-reasons-from-an-evidence-bank-not-from-search-excerpts.md) | Atlas v3 reasons from an evidence bank, not from search excerpts |
| [0064](0064-claude-at-home-means-workspaces-documents-and-richer-inputs.md) | "Claude at home" means workspaces, living documents and richer inputs, not platform integrations |
| [0065](0065-living-documents-are-edited-in-place.md) | Living Documents are edited in place, reversing the "AI generates new files only" rule |
