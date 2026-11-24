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
/** The Memory page an account gets: the subject index once its labels are verified, today's list until then. */
export type MemoryPageLayout = "subjects" | "list";
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
/** A state Hindsight kept before the entry's current one, with when it was said (null when undated). */
export interface MemoryEarlierState {
	text: string;
	saidAt: string | null;
}
/** One entry of the subject index's page (layout C), as recall reads it. */
export interface MemorySubjectEntry {
	ref: MemoryRef;
	text: string;
	/** Unlabelled, or labelled for the other bank kind: "other". */
	subject: MemorySubject;
	kind: MemoryKind | null;
	/** Quiet is an ongoing entry not mentioned for a while: still shown as current. */
	timeState: "current" | "quiet" | "earlier";
	/** When the person last mentioned it (its newest fact), ISO; null when no fact has a date. */
	lastMentionedAt: string | null;
	/** Whole weeks since the last mention, for a quiet entry only. */
	quietWeeks: number | null;
	/** Hindsight's dated earlier-state notes only, newest first; never Previous versions. */
	earlierStates: MemoryEarlierState[];
}
/** One row of the subject index: a subject with at least one current entry. */
export interface MemorySubjectSummary {
	subject: MemorySubject;
	/** Current entries, quiet ones included. */
	count: number;
	/** The most recently mentioned current entry. */
	preview: string;
	/** The Projects row's tag: an ongoing entry that is current. False for every other row. */
	active: boolean;
	earlierCount: number;
	/** Up to three of the subject's Earlier entries, most recently mentioned first. */
	earlierPreview: string[];
}
export interface MemorySubjectIndex {
	authority: "legacy" | "preparing" | "hindsight";
	scope: MemoryScope;
	generation: string;
	status: MemoryUpdateStatus;
	/** In the bank kind's list order; a subject with no current entry is left out. */
	subjects: MemorySubjectSummary[];
	/** Every Earlier entry, across subjects. */
	earlier: { count: number; preview: string[] };
	/** Every current entry, quiet ones included: what the Overview is written from. */
	currentCount: number;
}
/** A subject's slug, or every subject. */
export type MemorySubjectKey = MemorySubject | "all";
export interface MemorySubjectPage {
	scope: MemoryScope;
	generation: string;
	subject: MemorySubjectKey;
	state: "current" | "earlier";
	/** Most recently mentioned first. */
	entries: MemorySubjectEntry[];
	total: number;
	nextCursor: string | null;
}
/**
 * The Overview of a scope: one paragraph the local model writes when the
 * person opens it, from the entries the page shows as current. Kept until an
 * entry in the scope changes; never sent to chats.
 */
export interface MemoryOverview {
	state: "written" | "none";
	/** The scope's current entries now. */
	currentCount: number;
	text: string | null;
	/** How many of the most recently mentioned current entries it was written from. */
	writtenFrom: number | null;
	writtenAt: string | null;
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
	/** The entry's kind once labelled (part 2); absent or null before labels. */
	kind?: MemoryKind | null;
	/** Earlier rows reach a turn only when its message is about them. */
	timeState?: "current" | "quiet" | "earlier";
	/** The states Hindsight kept before the current one, for the memory_context tool only. */
	earlierStates?: Array<{ text: string; saidAt: string | null }>;
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
