// Memory V2 — the profile-item and consolidation-timeline contract served
// to the Knowledge Base Memory Profile UI (KnowledgeMemoryView.svelte,
// $lib/client/api/knowledge.ts) and consumed server-side by
// knowledge-memory-actions.ts / knowledge-memory-read.ts. Deliberately kept
// at the client-reachable top level of $lib rather than under $lib/server —
// relocated out of the former src/lib/types.ts god-module
// (architecture-deepening T1), preserving that file's original constraint
// verbatim (see the MemoryDirtyReason note below). This file carries no
// behavior change, only a new home.

export type MemoryProfileCategory =
	| "about_you"
	| "preferences"
	| "goals_ongoing_work"
	| "constraints_boundaries";

export type MemoryProfileScope =
	| { type: "global" }
	| { type: "project"; id: string }
	| { type: "conversation"; id: string }
	| { type: "document"; id: string };

// Mirrors MEMORY_DIRTY_REASONS in
// src/lib/server/services/memory-profile/types.ts. Duplicated here (rather
// than imported) because this file is reachable from client code and must
// not import from $lib/server.
export type MemoryDirtyReason =
	| "stale_projection"
	| "deferred_intake"
	| "profile_action_reconciliation"
	| "projection_reconciliation"
	| "possible_conflict"
	| "possible_duplicate"
	| "legacy_migration"
	| "review_generation";

export interface MemoryProfilePublicItem {
	id: string;
	itemKey: string;
	category: MemoryProfileCategory;
	statement: string;
	scope: MemoryProfileScope;
	status: "active";
	revision: number;
	updatedAt: string;
	confidence?: "stated" | "inferred" | null;
	expiryClass?: "durable" | "time_bound" | null;
	expiresAt?: string | null;
	canEdit: boolean;
	canDelete: boolean;
	canSuppress: boolean;
}

export interface MemoryProfileSourceChip {
	id: string;
	sourceType: string;
	label: string;
	summary: string | null;
}

export interface MemoryProfilePublicItemDetail extends MemoryProfilePublicItem {
	sourceChips: MemoryProfileSourceChip[];
	whyRemembered: string | null;
}

export interface MemoryProfileReviewItem {
	id: string;
	subject: string;
	question: string;
	reason: string;
	canAccept: boolean;
	expiresAt?: string | null;
}

export interface MemoryProfilePublicPayload {
	resetGeneration: number;
	projectionRevision: number;
	categories: Array<{
		category: MemoryProfileCategory;
		items: MemoryProfilePublicItem[];
	}>;
	review: {
		items?: MemoryProfileReviewItem[];
		visibleItems: MemoryProfileReviewItem[];
		openCount: number;
		overflowCount: number;
	};
}

export type MemoryProfileActionPayload =
	| {
			target?: "profile_item";
			action: "delete";
			itemId: string;
			expectedProjectionRevision: number;
	  }
	| {
			target?: "profile_item";
			action: "suppress";
			itemId: string;
			expectedProjectionRevision: number;
	  }
	| {
			target?: "profile_item";
			action: "edit";
			itemId: string;
			statement: string;
			expectedProjectionRevision: number;
	  }
	| {
			target: "review_item";
			action: "accept";
			itemId: string;
			expectedProjectionRevision: number;
	  }
	| {
			target: "review_item";
			action: "suppress";
			itemId: string;
			expectedProjectionRevision: number;
	  }
	| {
			target: "review_item";
			action: "edit";
			itemId: string;
			statement: string;
			expectedProjectionRevision: number;
	  };

export interface MemoryPersonaSummaryPayload {
	summary: {
		text: string;
		links: Array<{ text: string; factIds: string[] }>;
		updatedAt: string;
	} | null;
}

export interface MemoryTimelineAction {
	type: "expired" | "renewed" | "superseded" | "merged";
	itemIds: string[];
	resultItemId?: string;
	// The current statement of resultItemId (the surviving/merged-into fact),
	// resolved at read time so the UI can show "superseded by / merged into X".
	resultStatement?: string;
	description: string;
	undo: Array<{
		itemId: string;
		prevStatus: string;
		prevStatement: string;
		prevExpiresAt?: string | null;
	}>;
}

export interface MemoryTimelineReport {
	id: string;
	status: string;
	summaryText: string;
	createdAt: string;
	actions: MemoryTimelineAction[];
}

export interface MemoryTimelinePayload {
	reports: MemoryTimelineReport[];
}

export type MemoryV2ActionPayload =
	| {
			kind: "profile_item";
			action: "correct";
			itemId: string;
			statement: string;
			expectedProjectionRevision: number;
	  }
	| {
			kind: "profile_item";
			action: "retire";
			itemId: string;
			expectedProjectionRevision: number;
	  }
	| {
			kind: "summary";
			action: "edit";
			text: string;
	  }
	| {
			kind: "consolidation";
			action: "undo";
			reportId: string;
			actionIndex: number;
	  };
