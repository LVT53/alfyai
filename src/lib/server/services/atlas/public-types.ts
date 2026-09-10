// The Atlas job contract projected to clients (conversation detail,
// AtlasCard.svelte, $lib/client/api/atlas.ts). Named distinctly from this
// directory's own internal `./types.ts` (which independently declares its
// own richer `AtlasProfile`/`AtlasAction`/`AtlasJobStatus`/`AtlasJobCard`
// for the pipeline's internal evidence-pack/report machinery) to avoid
// colliding with it — that pre-existing structural duplication between the
// internal pipeline types and this public read-model view is not
// introduced by this relocation and is out of scope for it. Relocated out
// of the former src/lib/types.ts god-module (architecture-deepening T1);
// this file carries no behavior change, only a new home.

export type AtlasProfile = "overview" | "in-depth" | "exhaustive";
export type AtlasAction = "create" | "continue" | "fork" | "revise";
export type AtlasJobStatus =
	| "queued"
	| "running"
	| "succeeded"
	| "failed"
	| "cancelled";

export interface AtlasAvailability {
	enabled: boolean;
	configured: boolean;
	reasonCode?: "disabled" | "missing_parallel" | null;
	reason?: string | null;
}

/**
 * v1 progress details: the search queries the current round is running.
 */
export interface AtlasV1ProgressDetailsView {
	queries: string[];
	roundKind?: "initial" | "gap-fill";
	focus?: string[];
}

/**
 * v2 progress details (ADR 0062). The chat UI dispatches on `pipelineVersion`:
 * v1 cards carry the shape above, v2 cards carry this one.
 *
 * It extends the v1 view rather than replacing it so a client that reads
 * `queries` / `roundKind` / `focus` unconditionally still compiles and still
 * renders; on a v2 card `queries` is always empty and the `plan` array is what
 * the UI should show instead.
 */
export interface AtlasV2ProgressDetailsView extends AtlasV1ProgressDetailsView {
	pipelineVersion: 2;
	phase: "plan" | "research" | "index" | "write" | "verify" | "render";
	plan: Array<{
		id: string;
		question: string;
		status: "queued" | "running" | "done";
		sourceCount: number;
		confidence?: "corroborated" | "single" | "mixed" | "thin";
	}>;
	round: { current: number; total: number };
	sourcesRead: number;
	next: string;
	evidence?: {
		corroborated: number;
		single: number;
		inferred: number;
		cut: number;
		filteredCount: number;
		sources: Array<{
			n: number;
			title: string;
			host: string;
			date: string | null;
			cited: boolean;
			snippet: string;
		}>;
	};
}

/**
 * v3 progress details (ADR 0063). Deliberately v2's shape with a different
 * version tag and its own phase names, so a client that dispatches on
 * `pipelineVersion === 2` falls through to the v1 branch — which reads
 * `queries`, always empty here — instead of crashing on a v3 card.
 */
export interface AtlasV3ProgressDetailsView
	extends Omit<AtlasV2ProgressDetailsView, "pipelineVersion" | "phase"> {
	pipelineVersion: 3;
	phase:
		| "ask"
		| "research"
		| "outline"
		| "answer"
		| "write"
		| "critic"
		| "verify"
		| "render";
	/** Present from the verify phase on; see ADR 0063's evaluation section. */
	qualityDiagnostics?: {
		abstained: boolean;
		verdictPresent: boolean;
		claimCount: number;
		verifiedClaimCount: number;
		contestedClaimCount: number;
		answerTableCells: number;
		derivedFigures: number;
		criticRounds: number;
		criticFindings: number;
		needsEvidenceResolved: number;
		roundsRun: number;
		searches: number;
		pagesRead: number;
		sectionsPlanned: number;
		sectionsWritten: number;
		wordCount: number;
		writerRunaways: {
			length: number;
			salvaged: number;
			retried: number;
			fallback: number;
		};
	};
}

export type AtlasProgressDetailsView =
	| AtlasV1ProgressDetailsView
	| AtlasV2ProgressDetailsView
	| AtlasV3ProgressDetailsView;

export interface AtlasJobCard {
	id: string;
	conversationId: string;
	assistantMessageId?: string | null;
	action: AtlasAction;
	parentAtlasJobId?: string | null;
	profile: AtlasProfile;
	/**
	 * 1 for the original pipeline, 2 for ADR 0062's rebuild, 3 for ADR 0063's.
	 * Optional in the client view so a card from a deployment that predates the
	 * flag still parses; absent means 1.
	 */
	pipelineVersion?: 1 | 2 | 3;
	title: string;
	status: AtlasJobStatus;
	stage?: string | null;
	progress: {
		percent: number;
		stage: string;
		details: AtlasProgressDetailsView;
	};
	sourceCounts: {
		local: number;
		web: number;
		accepted: number;
		rejected: number;
	};
	usage: {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
		costUsdMicros: number;
	};
	outputs: {
		fileProductionJobId?: string | null;
		htmlChatGeneratedFileId?: string | null;
		pdfChatGeneratedFileId?: string | null;
		markdownChatGeneratedFileId?: string | null;
	};
	error?: {
		code: string;
		message: string;
		retryable: boolean;
	} | null;
	createdAt: number;
	updatedAt: number;
	completedAt?: number | null;
}
