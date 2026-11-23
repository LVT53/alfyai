/** Public Memory contracts. References identify immutable accepted snapshots. */
export type MemoryScope =
	| { kind: "personal" }
	| { kind: "project"; projectId: string };

/**
 * How an entry ages (design spec, part 2): lasting is kept until replaced,
 * ongoing goes quiet and then Earlier without a new fact, temporary is Earlier
 * a while after its mention or its event. An unlabelled entry reads as lasting.
 */
export const MEMORY_KINDS = ["lasting", "ongoing", "temporary"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
/** Storage slugs of the subject index ("Calls I made" 1); the page words are keyed by them. */
export const PERSONAL_MEMORY_SUBJECTS = [
	"about_you",
	"home_family",
	"work_study",
	"health",
	"projects",
	"interests",
	"other",
] as const;
export const PROJECT_MEMORY_SUBJECTS = [
	"goals_decisions",
	"people",
	"facts_figures",
	"plans_status",
	"other",
] as const;
export type MemorySubject =
	| (typeof PERSONAL_MEMORY_SUBJECTS)[number]
	| (typeof PROJECT_MEMORY_SUBJECTS)[number];
export function memorySubjectsFor(
	kind: MemoryScope["kind"],
): readonly MemorySubject[] {
	return kind === "project"
		? PROJECT_MEMORY_SUBJECTS
		: PERSONAL_MEMORY_SUBJECTS;
}
export interface MemoryRef {
	scope: MemoryScope;
	generation: string;
	rowId: string;
}
export type MemoryUpdateStatus =
	| "ready"
	| "queued"
	| "working"
	| "failed"
	| "off";
/** updatedAt is a known assertion/edit date. Mixed-date evidence may have no single display date. */
export interface MemoryRow {
	ref: MemoryRef;
	text: string;
	updatedAt: string | null;
	sourceCount: number;
}
export interface MemoryPage {
	authority: "legacy" | "preparing" | "hindsight";
	scope: MemoryScope;
	generation: string;
	rows: MemoryRow[];
	nextCursor: string | null;
	status: MemoryUpdateStatus;
	total: number;
}
/** quote is original authorized source text, never a generated native fact. */
export interface MemorySource {
	id: string;
	conversationId: string | null;
	messageId: string | null;
	title: string;
	quote: string;
	assertedAt: string;
	available: boolean;
}
export interface MemoryVersion {
	text: string;
	changedAt: string;
}
export interface MemoryDetail {
	/** Explicit provenance; absence of conversation sources never implies manual authorship. */
	origin?: "manual" | "conversation" | "unknown";
	row: MemoryRow;
	sources: MemorySource[];
	versions: MemoryVersion[];
	canEdit: boolean;
	canRemove: boolean;
}
export type MemoryAction =
	| { kind: "add"; scope: MemoryScope; text: string; requestId: string }
	| { kind: "edit"; ref: MemoryRef; text: string; requestId: string }
	| { kind: "remove"; ref: MemoryRef; requestId: string };
export interface MemoryOperation {
	id: string;
	status: "queued" | "working" | "applied" | "failed" | "stale";
	retryable: boolean;
	errorCode: string | null;
	exclusionAcknowledged: boolean;
	cleanupPending: boolean;
	ref: MemoryRef | null;
}
export interface HistoryImportStatus {
	choice: "include" | "decline" | null;
	cutoff: string | null;
	decidedAt: string | null;
	policyVersion: string;
	status:
		| "not_requested"
		| "pending"
		| "working"
		| "complete"
		| "held"
		| "failed";
}
export interface AdmittedMemoryEvidence {
	ref: MemoryRef;
	text: string;
	sources: MemorySource[];
	/**
	 * When the entry was last said: the newest `explicitEditAt ?? assertedAt`
	 * among the sources of its admitted supporting facts, as an ISO 8601
	 * instant, or null when it has none (never an invented "now").
	 */
	lastMentionedAt: string | null;
}

export interface MemoryQuarantineCandidate {
	id: string;
	text: string;
	scope: MemoryScope;
	source: {
		conversationId: string;
		messageId: string;
		assertedAt: string;
	};
}

export interface MemoryQuarantineApproval {
	id: string;
	text: string;
	status: "queued" | "failed" | "succeeded";
	retryable: boolean;
}

export interface MemoryQuarantine {
	status: "unavailable" | "idle" | "working" | "pending" | "complete" | "held";
	candidates: MemoryQuarantineCandidate[];
	approvals?: MemoryQuarantineApproval[];
}

export type MemoryQuarantineRequest =
	| { action: "start"; requestId: string }
	| { action: "retry"; id: string }
	| {
			action: "resolve";
			id: string;
			requestId: string;
			decision: "keep";
			text?: string;
	  }
	| { action: "resolve"; id: string; requestId: string; decision: "discard" };
