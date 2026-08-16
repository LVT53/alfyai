// Skill Control Envelope, Skill Draft, and Skill Session contract shared by
// the skills service modules (sessions.ts, notes.ts, prompt-context.ts,
// composer-command-registry.ts) and the composer/chat UI. Relocated out of
// the former src/lib/types.ts god-module (architecture-deepening T1); this
// file carries no behavior change, only a new home.

export type SkillControlSessionTransition =
	| "active"
	| "awaiting_user"
	| "finished"
	| "failed_note"
	| "dismissed";

export type SkillDraftStatus = "proposed" | "saved" | "dismissed" | "published";

export type SkillDraftDurationPolicy = "next_message" | "session";
export type SkillDraftQuestionPolicy = "none" | "ask_when_needed";
export type SkillDraftNotesPolicy = "none" | "create_private_notes";
export type SkillDraftSourceScope =
	| "current_conversation"
	| "selected_sources_only";

export interface SkillDraftProposal {
	id: string;
	status: SkillDraftStatus;
	displayName: string;
	description: string;
	instructions: string;
	activationExamples: string[];
	durationPolicy: SkillDraftDurationPolicy;
	questionPolicy: SkillDraftQuestionPolicy;
	notesPolicy: SkillDraftNotesPolicy;
	sourceScope: SkillDraftSourceScope;
	savedSkillId?: string;
	publishedSystemSkillId?: string;
	updatedAt?: number;
}

export type SkillControlOperation =
	| {
			operationId: string;
			kind: "session_transition";
			transition: SkillControlSessionTransition;
	  }
	| {
			operationId: string;
			kind: "note_intent";
			action: "create";
			title: string;
			body: string;
	  }
	| {
			operationId: string;
			kind: "note_intent";
			action: "replace" | "append";
			targetArtifactId: string;
			body: string;
	  }
	| {
			operationId: string;
			kind: "skill_draft";
			draft: SkillDraftProposal;
	  };

export interface SkillControlMessageMetadata {
	skillQuestion?: boolean;
	pendingSkillNoteIntents?: Extract<
		SkillControlOperation,
		{ kind: "note_intent" }
	>[];
	skillDrafts?: SkillDraftProposal[];
	skillControl?: {
		envelopeVersion: 1;
		operations: SkillControlOperation[];
		malformedEnvelopeCount: number;
	};
}

export interface PendingSkillSelection {
	id: string;
	ownership: "user" | "system";
	skillKind?: "user_skill" | "skill_pack" | "skill_variant";
	displayName: string;
	baseSkillId?: string | null;
	baseSkillDisplayName?: string | null;
	unavailable?: boolean;
}

export type SkillSessionStatus = "active" | "paused" | "ended";
export type SkillSessionMilestoneKind =
	| "started"
	| "paused"
	| "ended"
	| "dismissed"
	| "unavailable"
	| "awaiting_user"
	| "failed_note";

export interface SkillSessionMilestone {
	id: string;
	sessionId: string;
	userId: string;
	conversationId: string;
	kind: SkillSessionMilestoneKind;
	messageKey: string;
	messageParams: Record<string, unknown>;
	createdAt: number;
}

export interface SkillSession {
	id: string;
	userId: string;
	conversationId: string;
	skillId: string;
	skillOwnership: "user" | "system";
	skillKind: "user_skill" | "skill_pack" | "skill_variant";
	status: SkillSessionStatus;
	pauseReason: string | null;
	endReason: string | null;
	skillDisplayName: string;
	skillDescription: string;
	activationExamples: string[];
	durationPolicy: "next_message" | "session";
	questionPolicy: "none" | "ask_when_needed";
	notesPolicy: "none" | "create_private_notes";
	sourceScope: "current_conversation" | "selected_sources_only";
	skillVersion: number;
	packSkillId: string | null;
	packSkillVersion: number | null;
	variantSkillId: string | null;
	variantSkillVersion: number | null;
	effectiveInstructionsHash: string | null;
	startedFrom: "pending_skill";
	startedAt: number;
	updatedAt: number;
	pausedAt: number | null;
	endedAt: number | null;
	milestones: SkillSessionMilestone[];
}

export interface SkillSessionInternal extends SkillSession {
	skillInstructions: string;
}
