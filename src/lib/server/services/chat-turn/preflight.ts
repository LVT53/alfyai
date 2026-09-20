import { getConfig } from "$lib/server/config-store";
import type { DepthMetadata } from "$lib/server/services/chat-turn/depth-metadata-types";
import { getConversation } from "$lib/server/services/conversations";
import {
	getExtractionConfig,
	getExtractionJobForArtifact,
	getExtractionJobsForArtifacts,
	waitForExtractionJobVerdict,
} from "$lib/server/services/extraction";
import {
	assertPromptReadyAttachments,
	isAttachmentReadinessError,
} from "$lib/server/services/knowledge";
import {
	addConversationLinkedContextSources,
	isLinkedContextSourceError,
} from "$lib/server/services/linked-context-sources";
import { resolvePendingSkillApplication } from "$lib/server/services/skills/prompt-context";
import type { PendingSkillSelection } from "$lib/server/services/skills/types";
import type { DocumentExtractionJobDTO } from "$lib/shared/extraction-status";
import { isTerminalExtractionStatus } from "$lib/shared/extraction-status";
import { resolveReasoningDepthSelection } from "./depth-selection";
import type {
	AdmittedChatTurn,
	AppliedSkillContext,
	ChatTurnAdmissionResult,
	ChatTurnAttachmentExtraction,
	ChatTurnPreparationResult,
	ChatTurnRequestError,
	ParsedChatTurnRequest,
} from "./types";

type PreflightError = { ok: false; error: ChatTurnRequestError };

export async function preflightChatTurn(params: {
	userId: string;
	request: ParsedChatTurnRequest;
	/** The HTTP request's signal. Aborting releases the bounded wait at once. */
	signal?: AbortSignal;
}): Promise<ChatTurnPreparationResult> {
	const { userId, request } = params;
	const admission = await admitChatTurn({ userId, request });
	if (!admission.ok) return admission;

	return prepareAdmittedChatTurn({
		userId,
		admittedTurn: admission.value,
		signal: params.signal,
	});
}

export async function admitChatTurnStream(params: {
	userId: string;
	request: ParsedChatTurnRequest;
}): Promise<ChatTurnAdmissionResult> {
	return admitChatTurn(params);
}

export async function prepareAdmittedChatTurn(params: {
	userId: string;
	admittedTurn: AdmittedChatTurn;
	signal?: AbortSignal;
}): Promise<ChatTurnPreparationResult> {
	return prepareChatTurn({
		userId: params.userId,
		request: params.admittedTurn,
		signal: params.signal,
	});
}

async function admitChatTurn(params: {
	userId: string;
	request: ParsedChatTurnRequest;
}): Promise<ChatTurnAdmissionResult> {
	const { userId, request } = params;
	const conversation = await getConversation(userId, request.conversationId);
	if (!conversation) {
		return {
			ok: false,
			error: { status: 404, error: "Conversation not found" },
		};
	}

	return {
		ok: true,
		value: request as AdmittedChatTurn,
	};
}

async function prepareChatTurn(params: {
	userId: string;
	request: ParsedChatTurnRequest;
	signal?: AbortSignal;
}): Promise<ChatTurnPreparationResult> {
	const { userId, request } = params;
	const attachmentValidation = await validateAttachmentReadiness(
		userId,
		request,
		params.signal,
	);
	if (attachmentValidation) return attachmentValidation;

	const resolvedLinkedSources = await resolveLinkedSources(userId, request);
	if (!resolvedLinkedSources.ok) return resolvedLinkedSources;

	let appliedSkill: AppliedSkillContext | null = null;
	if (request.pendingSkill) {
		const applied = await resolveAppliedSkill({
			userId,
			pendingSkill: request.pendingSkill,
			requestText: request.normalizedMessage,
		});
		if (!applied.ok) return applied;
		appliedSkill = applied.value;
	}

	const { depthMetadata, linkedSources } = await resolveDepthMetadata(
		userId,
		request,
		resolvedLinkedSources.value,
	);

	return {
		ok: true,
		value: {
			...request,
			linkedSources,
			depthMetadata,
			appliedSkill,
		},
	};
}

export async function preflightAtlasTurnSources(params: {
	userId: string;
	request: ParsedChatTurnRequest;
	signal?: AbortSignal;
}): Promise<
	| {
			ok: true;
			value: { linkedSources: ParsedChatTurnRequest["linkedSources"] };
	  }
	| PreflightError
> {
	const { userId, request } = params;
	const conversation = await getConversation(userId, request.conversationId);
	if (!conversation) {
		return {
			ok: false,
			error: { status: 404, error: "Conversation not found" },
		};
	}

	const attachmentValidation = await validateAttachmentReadiness(
		userId,
		request,
		params.signal,
	);
	if (attachmentValidation) return attachmentValidation;

	const resolvedLinkedSources = await resolveLinkedSources(userId, request);
	if (!resolvedLinkedSources.ok) return resolvedLinkedSources;

	return {
		ok: true,
		value: { linkedSources: resolvedLinkedSources.value },
	};
}

/**
 * The most attachments we are willing to wait on inside a send request. Past
 * this, the wait stops being "a file that was 300 ms from done" and becomes a
 * user staring at a spinner, so we answer at once and leave the waiting to the
 * composer's poller, where it belongs.
 */
const MAX_ATTACHMENTS_WORTH_WAITING_FOR = 5;

/** How often the bounded wait re-reads a job while it is still running. */
const PREFLIGHT_POLL_INTERVAL_MS = 150;

type AttachmentReadinessFailure = {
	status: number;
	message: string;
	code: string;
	attachmentIds: string[];
	items: ChatTurnAttachmentExtraction[];
};

/**
 * `AttachmentReadinessError` already carries the classification and the
 * per-attachment rows — `knowledge/store/attachments.ts` joins the ledger
 * while it resolves the prompt artifacts, so it knows pending from failed
 * without a second read. This reads it structurally rather than by
 * `instanceof` because the error crosses a module boundary that tests mock.
 */
function toReadinessFailure(error: unknown): AttachmentReadinessFailure {
	const readiness = error as {
		status?: number;
		message?: string;
		code?: string;
		attachmentIds?: string[];
		items?: ChatTurnAttachmentExtraction[];
	};
	return {
		// HTTP 422 for every readiness refusal, pending included (OQ2): both
		// client handlers and `isAttachmentReadinessError` key on that path
		// today, and a distinct `code` buys everything a new status would.
		status: readiness.status ?? 422,
		message: readiness.message ?? "Attachments are not ready.",
		code: readiness.code ?? "attachment_not_ready",
		attachmentIds: readiness.attachmentIds ?? [],
		items: readiness.items ?? [],
	};
}

/**
 * A `mineru` job that has not yet left `queued` has not been handed to a
 * worker at all: the wait would burn the whole budget and still learn nothing
 * (OQ1). Everything already running is worth a couple of seconds.
 */
function isWorthWaitingFor(job: DocumentExtractionJobDTO): boolean {
	if (isTerminalExtractionStatus(job.status)) return false;
	return !(job.intakeRoute === "mineru" && job.status === "queued");
}

/**
 * The one thing the readiness check cannot answer: which of the pending jobs
 * are far enough along to be worth waiting for. `AttachmentExtractionStatusItem`
 * carries the status but not the intake route, and OQ1 turns on the route.
 */
async function readWaitableJobs(
	userId: string,
	artifactIds: string[],
): Promise<DocumentExtractionJobDTO[]> {
	if (artifactIds.length === 0) return [];
	try {
		const jobs = await getExtractionJobsForArtifacts({ userId, artifactIds });
		return jobs.filter(isWorthWaitingFor);
	} catch (error) {
		// The ledger being unreachable must not turn a pending attachment into
		// a hard failure. Skip the wait and report what the readiness check
		// already decided.
		console.error("[CHAT_TURN] Failed to read extraction status", {
			userId,
			error,
		});
		return [];
	}
}

/**
 * Waits, once, for the still-running attachments — bounded by
 * `DOCUMENT_EXTRACTION_PREFLIGHT_WAIT_MS` across ALL of them together, not per
 * file. The p50 direct-text and small-PDF job settles well inside the budget,
 * so the common case keeps its one-click send instead of asking a user to
 * press Send twice for a file that was a few hundred milliseconds from done
 * (D5).
 */
async function waitForPendingExtractions(params: {
	userId: string;
	jobs: DocumentExtractionJobDTO[];
	budgetMs: number;
	/**
	 * The request's own signal. A user who closed the tab or pressed Stop has
	 * nobody left to answer, and holding a server task for the rest of
	 * `DOCUMENT_EXTRACTION_PREFLIGHT_WAIT_MS` polling the ledger on their
	 * behalf is pure waste, so the wait releases the moment they abort.
	 */
	signal?: AbortSignal;
}): Promise<void> {
	const deadline = Date.now() + params.budgetMs;

	for (const job of params.jobs) {
		if (params.signal?.aborted) return;
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) return;
		const artifactId = job.sourceArtifactId;
		if (!artifactId) continue;

		await waitForExtractionJobVerdict({
			getJob: () =>
				getExtractionJobForArtifact({ userId: params.userId, artifactId }),
			timeoutMs: remainingMs,
			pollIntervalMs: PREFLIGHT_POLL_INTERVAL_MS,
			signal: params.signal,
		});
	}
}

/**
 * The send gate.
 *
 * Extraction happens after the upload request returns, so `promptReady: false`
 * no longer means "broken" — for a PDF it is the normal state for a few
 * seconds. The readiness check says which of the three refusals it is; this
 * adds the one thing it cannot do from inside a resolution pass, which is to
 * wait a moment and ask again.
 */
async function validateAttachmentReadiness(
	userId: string,
	request: ParsedChatTurnRequest,
	signal?: AbortSignal,
): Promise<PreflightError | null> {
	if (request.attachmentIds.length === 0) return null;

	const failure = await assertReadiness(userId, request);
	if (!failure) return null;

	if (failure.code !== "attachment_extraction_pending") {
		// Failed, or not a ledger matter at all (a deleted artifact, a file
		// that is not a document). Neither gets better by waiting.
		return toPreflightError(failure);
	}

	const budgetMs = getExtractionConfig().preflightWaitMs;
	const waitable = await readWaitableJobs(userId, failure.attachmentIds);
	if (
		budgetMs <= 0 ||
		waitable.length === 0 ||
		waitable.length > MAX_ATTACHMENTS_WORTH_WAITING_FOR
	) {
		return toPreflightError(failure);
	}

	await waitForPendingExtractions({ userId, jobs: waitable, budgetMs, signal });

	const settledFailure = await assertReadiness(userId, request);
	return settledFailure ? toPreflightError(settledFailure) : null;
}

function toPreflightError(failure: AttachmentReadinessFailure): PreflightError {
	const carriesExtraction =
		failure.code === "attachment_extraction_pending" ||
		failure.code === "attachment_extraction_failed";

	return {
		ok: false,
		error: {
			status: failure.status,
			error: failure.message,
			code: failure.code,
			attachmentIds: failure.attachmentIds,
			// Only the two extraction refusals carry the per-attachment rows.
			// The server's sentence is English either way, so this is what lets
			// the composer render a translated one from `status` + `errorCode`.
			...(carriesExtraction && failure.items.length > 0
				? { attachmentExtraction: failure.items }
				: {}),
		},
	};
}

async function assertReadiness(
	userId: string,
	request: ParsedChatTurnRequest,
): Promise<AttachmentReadinessFailure | null> {
	try {
		await assertPromptReadyAttachments({
			userId,
			conversationId: request.conversationId,
			attachmentIds: request.attachmentIds,
			traceId: request.attachmentTraceId,
		});
		return null;
	} catch (error) {
		if (!isAttachmentReadinessError(error)) {
			throw error;
		}
		return toReadinessFailure(error);
	}
}

async function resolveLinkedSources(
	userId: string,
	request: ParsedChatTurnRequest,
): Promise<
	{ ok: true; value: ParsedChatTurnRequest["linkedSources"] } | PreflightError
> {
	if (request.linkedSources.length === 0) {
		return {
			ok: true,
			value: request.linkedSources,
		};
	}

	if (!getConfig().composerCommandRegistryEnabled) {
		return {
			ok: false,
			error: {
				status: 403,
				error: "Composer Command Registry is disabled.",
				code: "composer_commands_disabled",
			},
		};
	}

	try {
		const linkedSources = await addConversationLinkedContextSources({
			userId,
			conversationId: request.conversationId,
			linkedSources: request.linkedSources,
			attachmentIds: request.attachmentIds,
		});
		return {
			ok: true,
			value: linkedSources,
		};
	} catch (error) {
		if (!isLinkedContextSourceError(error)) {
			throw error;
		}
		return {
			ok: false,
			error: {
				status: error.status,
				error: error.message,
				code: error.code,
			},
		};
	}
}

// Resolves an explicit `$` composer selection into this turn's forced skill
// injection (see AppliedSkillContext) — no durable session row. Both the
// "Composer Command Registry disabled" and "skill no longer available"
// failures surface the same request-level errors the pre-refactor
// session-starting flow returned, so existing client error handling for
// `pending_skill_unavailable` / `composer_commands_disabled` keeps working.
//
// Exported for retry.ts, which probes availability with it BEFORE preflighting
// so a since-deleted or disabled skill degrades to a plain regenerate instead
// of failing the turn with the 409 a fresh send would (rightly) get.
export async function resolveAppliedSkill(params: {
	userId: string;
	pendingSkill: PendingSkillSelection;
	requestText: string;
}): Promise<{ ok: true; value: AppliedSkillContext } | PreflightError> {
	const { userId, pendingSkill, requestText } = params;

	if (!getConfig().composerCommandRegistryEnabled) {
		return {
			ok: false,
			error: {
				status: 403,
				error: "Composer Command Registry is disabled.",
				code: "composer_commands_disabled",
			},
		};
	}

	const resolved = await resolvePendingSkillApplication({
		userId,
		pendingSkill,
		requestText,
	});
	if (!resolved.ok) {
		return {
			ok: false,
			error: {
				status: 409,
				error: "Selected skill is no longer available.",
				code: "pending_skill_unavailable",
			},
		};
	}

	return {
		ok: true,
		value: {
			skillId: resolved.skillId,
			skillOwnership: resolved.skillOwnership,
			skillKind: resolved.skillKind,
			skillDisplayName: resolved.displayName,
			// The user picked this skill with `$`; say so, or the model reads
			// the catalogue line and calls use_skill for the same skill again.
			instructionsEnvelope: `Skill "${resolved.displayName}" was selected by the user and is already loaded for this turn — do not call use_skill for it.\n\n${resolved.envelope}`,
		},
	};
}

async function resolveDepthMetadata(
	userId: string,
	request: ParsedChatTurnRequest,
	linkedSources: ParsedChatTurnRequest["linkedSources"],
): Promise<{
	depthMetadata: DepthMetadata;
	linkedSources: ParsedChatTurnRequest["linkedSources"];
}> {
	const turnForDepthSelection = {
		...request,
		linkedSources,
	};

	return {
		depthMetadata: (
			await resolveReasoningDepthSelection({
				userId,
				conversationId: request.conversationId,
				request: turnForDepthSelection,
			})
		).metadata,
		linkedSources,
	};
}
