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

export interface AtlasJobCard {
	id: string;
	conversationId: string;
	assistantMessageId?: string | null;
	action: AtlasAction;
	parentAtlasJobId?: string | null;
	profile: AtlasProfile;
	title: string;
	status: AtlasJobStatus;
	stage?: string | null;
	progress: {
		percent: number;
		stage: string;
		details: {
			queries: string[];
			roundKind?: "initial" | "gap-fill";
			focus?: string[];
		};
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
