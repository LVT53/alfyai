// Legacy/display persona-memory and task-memory read shapes served by the
// Knowledge Base Memory Profile read facade (memory.ts,
// knowledge-memory-read.ts, knowledge-memory-actions.ts). Relocated out of
// the former src/lib/types.ts god-module (architecture-deepening T1); this
// file carries no behavior change, only a new home. The Memory V2
// profile-item/consolidation-timeline contract lives separately at
// src/lib/memory-profile-types.ts (kept client-reachable without importing
// $lib/server — see that file's own note).

import type {
	MemoryDirtyReason,
	MemoryProfilePublicPayload,
	MemoryProfileScope,
} from "$lib/memory-profile-types";
import type { TaskStateStatus } from "$lib/server/services/task-state/types";

export type PersonaMemoryScope = "self" | "assistant_about_user";

export type PersonaMemoryClass =
	| "perishable_fact"
	| "short_term_constraint"
	| "active_project_context"
	| "situational_context"
	| "stable_preference"
	| "identity_profile"
	| "long_term_context";

export type PersonaMemoryState = "active" | "dormant" | "archived";
export type PersonaMemoryTemporalKind =
	| "deadline"
	| "availability"
	| "appointment"
	| "project_window"
	| "short_term_constraint";
export type PersonaMemoryTemporalFreshness =
	| "active"
	| "stale"
	| "expired"
	| "historical"
	| "unknown";
export type PersonaMemoryTopicStatus = "active" | "dormant" | "historical";
export type PersonaMemoryDomain = "persona" | "temporal" | "preference";

export interface PersonaMemoryTemporalInfo {
	kind: PersonaMemoryTemporalKind;
	freshness: PersonaMemoryTemporalFreshness;
	observedAt: number;
	effectiveAt: number | null;
	expiresAt: number | null;
	relative: boolean;
	resolved: boolean;
}

export interface PersonaMemoryMemberItem {
	id: string;
	content: string;
	scope: PersonaMemoryScope;
	sessionId: string | null;
	conversationTitle: string | null;
	createdAt: number;
}

export interface PersonaMemoryItem {
	id: string;
	canonicalText: string;
	rawCanonicalText?: string;
	domain?: PersonaMemoryDomain;
	memoryClass: PersonaMemoryClass;
	state: PersonaMemoryState;
	salienceScore: number;
	sourceCount: number;
	conversationTitles: string[];
	firstSeenAt: number;
	lastSeenAt: number;
	pinned: boolean;
	temporal?: PersonaMemoryTemporalInfo | null;
	activeConstraint?: boolean;
	topicKey?: string | null;
	topicStatus?: PersonaMemoryTopicStatus | null;
	supersededById?: string | null;
	supersessionReason?: string | null;
	members: PersonaMemoryMemberItem[];
}

export interface TaskMemoryItem {
	taskId: string;
	conversationId: string;
	conversationTitle: string | null;
	objective: string;
	status: TaskStateStatus;
	locked: boolean;
	updatedAt: number;
	lastCheckpointAt: number | null;
	checkpointSummary: string | null;
}

export type KnowledgeMemoryOverviewSource = "persona_fallback" | null;

export type KnowledgeMemoryOverviewStatus =
	| "ready"
	| "refreshing"
	| "temporarily_unavailable"
	| "not_enough_durable_memory"
	| "disabled";

export interface KnowledgeMemorySummary {
	personaCount: number;
	taskCount: number;
	focusContinuityCount: number;
	activeConstraintCount?: number;
	currentProjectContextCount?: number;
	overview: string | null;
	overviewBullets: string[];
	overviewSource: KnowledgeMemoryOverviewSource;
	overviewStatus: KnowledgeMemoryOverviewStatus;
	overviewUpdatedAt: number | null;
	overviewLastAttemptAt: number | null;
	durablePersonaCount: number;
}

export interface KnowledgeMemoryPayload {
	resetGeneration?: number;
	projectionRevision?: number;
	categories?: MemoryProfilePublicPayload["categories"];
	review?: MemoryProfilePublicPayload["review"];
	personaMemories?: PersonaMemoryItem[];
	activeConstraints?: PersonaMemoryItem[];
	currentProjectContext?: PersonaMemoryItem[];
	taskMemories?: TaskMemoryItem[];
	summary?: KnowledgeMemorySummary;
}

export interface KnowledgeMemoryOverviewPayload {
	summary: KnowledgeMemorySummary;
	profile?: KnowledgeMemoryPayload;
	// The user's master memory toggle (users.memoryEnabled).
	memoryEnabled: boolean;
	// Whether the memory pipeline currently has queued/in-flight work for this
	// user, so the UI can show a compact "memory is processing" notice.
	processing: {
		active: boolean;
		pendingCount: number;
		// Privacy-safe per-reason breakdown of the in-flight work (grouped by
		// reason + scope), so the UI can render a friendly human-readable list
		// instead of just a generic spinner. Never carries raw fact text —
		// only the operation reason, its scope, and a count.
		operations: Array<{
			reason: MemoryDirtyReason;
			scope: MemoryProfileScope;
			count: number;
		}>;
	};
}
