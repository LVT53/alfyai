// Skill Draft and pending-skill-selection contract shared by the skills
// service modules (user-skills.ts, prompt-context.ts,
// composer-command-registry.ts) and the composer/chat UI. Relocated out of
// the former src/lib/types.ts god-module (architecture-deepening T1).
//
// Skill Sessions, Skill Session Milestones, and Skill Note operations were
// removed when skills moved from durable session-based activation to
// on-demand loading (a per-turn catalogue line plus a `use_skill` tool call
// or an explicit `$` selection, both scoped to a single turn — see
// drizzle/1777140000088_drop_skill_sessions_and_notes.sql). Only the
// AI-drafted-skill proposal flow (`skill_draft`) and the pending-skill
// selection contract survive from the old Skill Control Envelope.

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

export type SkillControlOperation = {
	operationId: string;
	kind: "skill_draft";
	draft: SkillDraftProposal;
};

export interface SkillControlMessageMetadata {
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
