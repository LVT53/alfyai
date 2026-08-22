// The persisted/streamed chat message contract: `ChatMessage` and the
// smaller shapes it aggregates directly (role, tool-call entries, thinking
// segments, completion-warning codes, runtime phase, chat attachments).
// Owned by messages.ts (persisted assistant-message metadata) — relocated
// out of the former src/lib/types.ts god-module (architecture-deepening
// T1); this file carries no behavior change, only a new home. Sibling
// concerns (evidence, web-citation audit, fork provenance, skill control,
// depth/response-activity metadata) live in their own owning modules and
// are imported here, not duplicated.

import type { ModelId } from "$lib/model-types";
import type {
	InterimThoughtStep,
	ResponseActivityEntry,
	ResponseActivityStatus,
} from "$lib/response-activity-types";
import type { DepthMetadata } from "$lib/server/services/chat-turn/depth-metadata-types";
import type {
	ForkCopyMetadata,
	MessageSourceForks,
} from "$lib/server/services/conversation-forks";
import type { ArtifactType } from "$lib/server/services/knowledge/types";
import type {
	ForkEvidenceSnapshot,
	MessageEvidenceSummary,
} from "$lib/server/services/message-evidence";
import type { SkillControlMessageMetadata } from "$lib/server/services/skills/types";
import type { WebCitationAudit } from "$lib/server/services/web-citation-audit";
import type {
	EvidenceSourceType,
	ToolEvidenceCandidate,
} from "./message-evidence";

// MessageRole type: 'user' | 'assistant'
export type MessageRole = "user" | "assistant";

// "failed" (E1) is a genuine terminal outcome distinct from "done" — a tool
// call that errored is finished (not running) but did not succeed. Before
// E1, failed calls were reported as "done" with only `metadata.ok === false`
// hinting at the failure, so callers keying off status alone could not tell
// a failed call from a successful one.
export interface ToolCallEntry {
	callId?: string;
	name: string;
	input: Record<string, unknown>;
	status: "running" | "done" | "failed";
	outputSummary?: string | null;
	sourceType?: EvidenceSourceType | null;
	candidates?: ToolEvidenceCandidate[];
	metadata?: Record<string, string | number | boolean | null>;
}

export type ThinkingSegment =
	| { type: "text"; content: string }
	| {
			type: "status";
			id: string;
			label: string;
			status: ResponseActivityStatus;
			passIndex?: number;
			passTotal?: number;
			passKind?: string;
	  }
	| {
			type: "tool_call";
			callId?: string;
			name: string;
			input: Record<string, unknown>;
			status: "running" | "done" | "failed";
			outputSummary?: string | null;
			sourceType?: EvidenceSourceType | null;
			candidates?: ToolEvidenceCandidate[];
			metadata?: Record<string, string | number | boolean | null>;
	  };

// E1 — stable codes for a chat turn that completed with a caveat. Before E1
// these were English sentences ("Note: The model reached its output
// limit...") concatenated directly into the persisted assistant message
// body. They now ride as `completionWarningCodes` on the turn's
// `data-stream-metadata` payload instead; localized copy for each code is
// an E2 (client) concern, matching the WebCitationAuditStatus precedent
// just below (structured status, no baked prose).
export type ChatTurnCompletionWarningCode =
	| "output_truncated"
	| "content_filtered"
	| "provider_error"
	| "non_standard_finish"
	| "stream_closed_without_finish"
	| "file_production_failed";

export type NormalChatRuntimePhase =
	| "idle"
	| "preparing"
	| "generating"
	| "finalizing"
	| "polling";

export interface ChatMessage {
	id: string;
	// Stable client-side identity used for keyed rendering so stream finalization
	// can swap in persisted IDs without remounting the message bubble.
	renderKey?: string;
	role: MessageRole;
	content: string;
	timestamp: number;
	attachments?: ChatAttachment[];
	isStreaming?: boolean;
	runtimePhase?: NormalChatRuntimePhase;
	thinking?: string;
	isThinkingStreaming?: boolean;
	thinkingTokenCount?: number;
	responseTokenCount?: number;
	totalTokenCount?: number;
	// Interleaved thinking text + tool call segments, built during streaming.
	// Not persisted to DB — falls back to flat `thinking` string on page reload.
	thinkingSegments?: ThinkingSegment[];
	// Display name of the model used for the response (assistant messages only)
	modelId?: ModelId;
	modelDisplayName?: string;
	providerDisplayName?: string;
	providerIconUrl?: string;
	// Total generation duration in milliseconds (assistant messages only)
	generationDurationMs?: number;
	// Estimated cost in USD for this response (from usage_events, assistant messages only)
	costUsd?: number;
	evidenceSummary?: MessageEvidenceSummary;
	webCitationAudit?: WebCitationAudit;
	evidencePending?: boolean;
	wasStopped?: boolean;
	// E2 — client-side projection of E1's completionWarningCodes (see the
	// ChatTurnCompletionWarningCode comment above). Carried on the message so
	// a turn that completed with a caveat (e.g. output_truncated, where the
	// body may be empty) still has something to show the user, even when
	// `content` alone is blank.
	completionWarningCodes?: ChatTurnCompletionWarningCode[];
	depthMetadata?: DepthMetadata;
	responseActivity?: ResponseActivityEntry[];
	// P3b (ADR-0056) — the durable, persisted Interim Thought Step rail for
	// this completed turn (deterministic + event-derived + classified steps,
	// in emission order), projected from `messages.metadataJson.thoughtSteps`
	// by the ADR-0022 read model (see `parseThoughtSteps` in
	// src/lib/server/services/chat-turn/thought-steps.ts, and its call site
	// in messages.ts's `projectMessageMetadata`). `undefined` — never `[]` —
	// when the turn has no persisted steps, mirroring every other optional
	// projection on this type.
	thoughtSteps?: InterimThoughtStep[];
	// A1 (owner idea) — a short, glanceable headline of THIS assistant turn,
	// generated by the local control model in the background after the turn
	// finalizes and persisted additively in `messages.metadataJson.railSummary`
	// (same paved road as `thoughtSteps`; no migration). Projected here by the
	// ADR-0022 read model (see `projectMessageMetadata` in messages.ts).
	// `undefined` — never `""` — when the turn has no persisted summary (short
	// reply, still pending, or the generation degraded), in which case the
	// jump-rail falls back to the verbatim truncated reply start
	// (`railEntryText` in src/lib/components/chat/jump-rail.ts). Assistant
	// turns only (owner decision O-3).
	railSummary?: string;
	skillQuestion?: boolean;
	pendingSkillNoteIntents?: SkillControlMessageMetadata["pendingSkillNoteIntents"];
	skillDrafts?: SkillControlMessageMetadata["skillDrafts"];
	skillControl?: SkillControlMessageMetadata["skillControl"];
	forkCopy?: ForkCopyMetadata;
	forkEvidenceSnapshot?: ForkEvidenceSnapshot;
	sourceForks?: MessageSourceForks;
	importSource?: string;
}

export interface ChatAttachment {
	id: string;
	artifactId: string;
	name: string;
	type: ArtifactType;
	mimeType: string | null;
	sizeBytes: number | null;
	conversationId: string | null;
	messageId?: string | null;
	createdAt: number;
}
