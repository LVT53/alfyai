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
import type {
	ArtifactType,
	DocumentOutlineEntry,
} from "$lib/server/services/knowledge/types";
import type {
	ForkEvidenceSnapshot,
	MessageEvidenceSummary,
} from "$lib/server/services/message-evidence";
import type { SkillControlMessageMetadata } from "$lib/server/services/skills/types";
import type {
	WebCitationAudit,
	WebCitationRepairSummary,
} from "$lib/server/services/web-citation-audit";
import type {
	EvidenceSourceType,
	ToolEvidenceCandidate,
} from "./message-evidence";

// MessageRole type: 'user' | 'assistant'
export type MessageRole = "user" | "assistant";

// Inline map card data (map_route and future geography tools). Deliberately
// separate from `metadata` (which is scalar-only, ADR-shaped for the evidence
// pipeline): this carries the small structured geometry an inline map card
// needs to render — a simplified route line, marker points, an optional
// isochrone polygon set, and the summary line — WITHOUT going anywhere near
// the model's context (it never appears in `modelPayload`). Producers must
// keep the whole object well under 8 KB (simplify polylines/polygons) since
// it rides the same JSON blob persisted per tool call.
export type ToolCallMapMarker = {
	lat: number;
	lng: number;
	label?: string;
	kind?: "origin" | "destination" | "waypoint" | "point";
};

export type ToolCallMapPolygon = {
	// Outer ring only, simplified: [lat, lng] pairs.
	points: [number, number][];
	rangeS?: number;
};

// One leg of a public-transport itinerary, as the chat card draws it. Times
// are already LOCAL "HH:MM" strings for the region the journey is in — the
// client never has to know a timezone.
export type ToolCallMapTransitLeg = {
	type: "walk" | "pt";
	// Line label ("39A") and where the vehicle is headed.
	line?: string;
	headsign?: string;
	from?: string;
	to?: string;
	depart?: string;
	arrive?: string;
	stops?: number;
	minutes: number;
	// Plain word for the vehicle ("bus", "tram", …), from GTFS route_type.
	vehicle?: string;
};

// One row of a "next departures" card.
export type ToolCallMapDeparture = {
	depart?: string;
	arrive?: string;
	minutes: number;
	transfers: number;
	line?: string;
};

export interface ToolCallMapData {
	bounds: { minLat: number; minLng: number; maxLat: number; maxLng: number };
	markers?: ToolCallMapMarker[];
	// Simplified route geometry as [lat, lng] pairs (already decoded from
	// whatever the provider returned — never a re-encoded polyline string, so
	// the client never needs a polyline decoder).
	polyline?: [number, number][];
	polygons?: ToolCallMapPolygon[];
	distanceM?: number;
	durationS?: number;
	mode?: "drive" | "walk" | "bike" | "transit";
	originLabel?: string;
	destinationLabel?: string;
	// Public transport only: the itinerary's legs (transit action) or the next
	// departures (timetable action), plus the journey's transfer count.
	transitLegs?: ToolCallMapTransitLeg[];
	departures?: ToolCallMapDeparture[];
	transfers?: number;
	attribution: string;
}

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
	// Compact excerpt (≤ 1,500 chars) of what the model actually received from
	// the tool, so later turns can replay the call as a native tool result
	// instead of a one-line summary. Never rendered to the user.
	resultDigest?: string | null;
	sourceType?: EvidenceSourceType | null;
	candidates?: ToolEvidenceCandidate[];
	metadata?: Record<string, string | number | boolean | null>;
	// Inline map card data (map_route only, today). See ToolCallMapData.
	map?: ToolCallMapData | null;
}

export type ThinkingSegment =
	| { type: "text"; content: string }
	| {
			type: "status";
			id: string;
			label: string;
			status: ResponseActivityStatus;
	  }
	| {
			type: "tool_call";
			callId?: string;
			name: string;
			input: Record<string, unknown>;
			status: "running" | "done" | "failed";
			outputSummary?: string | null;
			resultDigest?: string | null;
			sourceType?: EvidenceSourceType | null;
			candidates?: ToolEvidenceCandidate[];
			metadata?: Record<string, string | number | boolean | null>;
			map?: ToolCallMapData | null;
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
	// Summary of the citation auto-repair pass (web-citation-audit.ts):
	// markdown links rewritten to a same-domain retrieved source, or stripped
	// (text kept) when no retrieved source backed them. Present only when a
	// web-grounding tool ran this turn.
	citationAudit?: WebCitationRepairSummary;
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
	// Owner idea (variant A) — up to two short follow-up questions for this
	// assistant turn, generated by the local control model in the stream's
	// synchronous completion path (so they ride the terminal
	// data-stream-metadata frame live) and persisted additively into
	// `messages.metadataJson.followUps` (same paved road as `railSummary`,
	// no migration). Projected here by the ADR-0022 read model. `undefined`
	// — never `[]` — when the turn has no suggestions (skipped or the
	// control model failed). Assistant turns only.
	followUps?: string[];
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
	// Long-document comfort fields (2026-09-06) — omitted when never
	// computed at ingestion (older attachments, or extraction failures).
	tokenEstimate?: number;
	pageCount?: number;
	outline?: DocumentOutlineEntry[];
}
