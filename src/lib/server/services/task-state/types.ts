// The Task/Continuity domain contract owned by task-state.ts and its
// internal modules (control-model, continuity, artifacts, chunk-sync,
// document-preferences, mappers). Relocated out of the former
// src/lib/types.ts god-module (architecture-deepening T1); this file
// carries no behavior change, only a new home.

export type TaskStateStatus = "active" | "candidate" | "revived" | "archived";

export type CompactionMode = "none" | "deterministic" | "llm_fallback";
export type RoutingStage =
	| "deterministic"
	| "semantic"
	| "evidence_rerank"
	| "verification_fallback";
export type VerificationStatus = "skipped" | "fallback" | "passed";
export type TaskEvidenceRole =
	| "selected"
	| "pinned"
	| "excluded"
	| "checkpoint_source";
export type TaskEvidenceOrigin = "system" | "user";
export type TaskCheckpointType = "micro" | "stable";
export type EvidencePreference = "auto" | "pinned" | "excluded";

export interface TaskEvidenceLink {
	id: string;
	taskId: string;
	userId: string;
	conversationId: string;
	artifactId: string;
	chunkIndex: number | null;
	role: TaskEvidenceRole;
	origin: TaskEvidenceOrigin;
	confidence: number;
	reason: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface TaskCheckpoint {
	id: string;
	taskId: string;
	userId: string;
	conversationId: string;
	checkpointType: TaskCheckpointType;
	content: string;
	sourceTurnRange: string | null;
	sourceEvidenceIds: string[];
	verificationStatus: VerificationStatus;
	createdAt: number;
	updatedAt: number;
}

export interface TaskState {
	taskId: string;
	userId: string;
	conversationId: string;
	status: TaskStateStatus;
	objective: string;
	confidence: number;
	locked: boolean;
	lastConfirmedTurnMessageId: string | null;
	constraints: string[];
	factsToPreserve: string[];
	decisions: string[];
	openQuestions: string[];
	activeArtifactIds: string[];
	nextSteps: string[];
	lastCheckpointAt: number | null;
	createdAt: number;
	updatedAt: number;
}

export type TaskSteeringAction =
	| "lock_task"
	| "unlock_task"
	| "start_new_task"
	| "set_artifact_preference"
	| "pin_artifact"
	| "unpin_artifact"
	| "exclude_artifact"
	| "include_artifact";

export interface TaskSteeringPayload {
	action: TaskSteeringAction;
	artifactId?: string;
	objective?: string;
	preference?: EvidencePreference;
}
