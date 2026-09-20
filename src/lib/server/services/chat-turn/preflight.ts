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
}): Promise<ChatTurnPreparationResult> {
	const { userId, request } = params;
	const admission = await admitChatTurn({ userId, request });
	if (!admission.ok) return admission;

	return prepareAdmittedChatTurn({
		userId,
		admittedTurn: admission.value,
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
}): Promise<ChatTurnPreparationResult> {
	return prepareChatTurn({
		userId: params.userId,
		request: params.admittedTurn,
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
}): Promise<ChatTurnPreparationResult> {
	const { userId, request } = params;
	const attachmentValidation = await validateAttachmentReadiness(
		userId,
		request,
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
 * this, the wait stops being "a file that was 300 ms from done" and starts
 * being a user staring at a spinner, so we answer immediately and let the
 * composer's poller do the waiting where it belongs.
 */
const MAX_ATTACHMENTS_WORTH_WAITING_FOR = 5;

/** How often the bounded wait re-reads a job while it is pending. */
const PREFLIGHT_POLL_INTERVAL_MS = 150;

type AttachmentReadinessFailure = {
	status: number;
	message: string;
	code: string;
	attachmentIds: string[];
};

function toReadinessFailure(error: unknown): AttachmentReadinessFailure {
	const readiness = error as {
		status?: number;
		message?: string;
		code?: string;
		attachmentIds?: string[];
	};
	return {
		// HTTP 422 for every readiness refusal, pending included (OQ2): both
		// client handlers and `isAttachmentReadinessError` key on that path
		// today, and a distinct `code` buys everything a new status would.
		status: readiness.status ?? 422,
		message: readiness.message ?? "Attachments are not ready.",
		code: readiness.code ?? "attachment_not_ready",
		attachmentIds: readiness.attachmentIds ?? [],
	};
}

/**
 * A `mineru` job that has not yet left `queued` has not even been handed to a
 * worker: the wait would burn the whole budget and still learn nothing (OQ1).
 * Everything else that is running is worth a couple of seconds.
 */
function isWorthWaitingFor(job: DocumentExtractionJobDTO): boolean {
	if (isTerminalExtractionStatus(job.status)) return false;
	return !(job.intakeRoute === "mineru" && job.status === "queued");
}

function toAttachmentExtraction(
	job: DocumentExtractionJobDTO,
): ChatTurnAttachmentExtraction {
	return {
		artifactId: job.sourceArtifactId ?? "",
		name: job.fileName || null,
		status: job.status,
		errorCode: job.error?.code ?? null,
		retryable: job.retryable,
	};
}

async function readExtractionJobs(
	userId: string,
	artifactIds: string[],
): Promise<DocumentExtractionJobDTO[]> {
	if (artifactIds.length === 0) return [];
	try {
		return await getExtractionJobsForArtifacts({ userId, artifactIds });
	} catch (error) {
		// The ledger being unreachable must not turn a pending attachment into
		// a hard failure; fall back to the plain readiness refusal.
		console.error("[CHAT_TURN] Failed to read extraction status", {
			userId,
			error,
		});
		return [];
	}
}

/**
 * Waits, once, for the still-running attachments — bounded by
 * `DOCUMENT_EXTRACTION_PREFLIGHT_WAIT_MS` across ALL of them, not per file.
 * The p50 direct-text and small-PDF job settles well inside the budget, so the
 * common case keeps its one-click send instead of asking the user to press
 * Send twice for a file that was a few hundred milliseconds from done (D5).
 */
async function waitForPendingExtractions(params: {
	userId: string;
	jobs: DocumentExtractionJobDTO[];
	budgetMs: number;
}): Promise<void> {
	const deadline = Date.now() + params.budgetMs;

	for (const job of params.jobs) {
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) return;
		const artifactId = job.sourceArtifactId;
		if (!artifactId) continue;

		await waitForExtractionJobVerdict({
			getJob: () =>
				getExtractionJobForArtifact({ userId: params.userId, artifactId }),
			timeoutMs: remainingMs,
			pollIntervalMs: PREFLIGHT_POLL_INTERVAL_MS,
		});
	}
}

async function validateAttachmentReadiness(
	userId: string,
	request: ParsedChatTurnRequest,
): Promise<PreflightError | null> {
	if (request.attachmentIds.length === 0) return null;

	const firstFailure = await assertReadiness(userId, request);
	if (!firstFailure) return null;

	const jobs = await readExtractionJobs(userId, firstFailure.attachmentIds);
	const waitable = jobs.filter(isWorthWaitingFor);
	const budgetMs = getExtractionConfig().preflightWaitMs;

	if (
		waitable.length > 0 &&
		waitable.length <= MAX_ATTACHMENTS_WORTH_WAITING_FOR &&
		budgetMs > 0
	) {
		await waitForPendingExtractions({ userId, jobs: waitable, budgetMs });
		const secondFailure = await assertReadiness(userId, request);
		if (!secondFailure) return null;
		return buildReadinessError(
			secondFailure,
			await readExtractionJobs(userId, secondFailure.attachmentIds),
		);
	}

	return buildReadinessError(firstFailure, jobs);
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

/**
 * Splits "not ready" into "not ready YET" and "will never be ready".
 *
 * A failure wins over a pending sibling. Both are reported in
 * `attachmentExtraction`, so a client can render everything at once, but the
 * headline code names the one the user has to act on: a pending job resolves
 * itself, a failed one never will, and telling someone to wait for a file that
 * is already broken costs them a whole round trip to find that out.
 */
function buildReadinessError(
	failure: AttachmentReadinessFailure,
	jobs: DocumentExtractionJobDTO[],
): PreflightError {
	const blocked = jobs.filter((job) => !isTerminalExtractionStatus(job.status));
	const failed = jobs.filter(
		(job) => job.status === "failed" || job.status === "canceled",
	);

	if (failed.length === 0 && blocked.length === 0) {
		// Nothing the ledger knows about: a deleted artifact, or a file that is
		// not a document at all. Existing prose, existing code, unchanged.
		return {
			ok: false,
			error: {
				status: failure.status,
				error: failure.message,
				code: failure.code,
				attachmentIds: failure.attachmentIds,
			},
		};
	}

	// Disjoint by construction — `blocked` is non-terminal, `failed` is
	// terminal — so this is every attachment with something to say, worst
	// first.
	const reported = [...failed, ...blocked];

	return {
		ok: false,
		error: {
			status: failure.status,
			error:
				failed.length > 0
					? describeFailedAttachments(failed)
					: describePendingAttachments(blocked),
			code:
				failed.length > 0
					? "attachment_extraction_failed"
					: "attachment_extraction_pending",
			attachmentIds: failure.attachmentIds,
			attachmentExtraction: reported.map(toAttachmentExtraction),
		},
	};
}

/**
 * The English fallback beside the code.
 *
 * It is a fallback and not the message: the readiness prose in
 * `knowledge/store/attachments.ts` is hard-wired English and, worse, says
 * "could not be prepared for chat" — which is simply untrue of a file that is
 * halfway through being read. These sentences at least tell the truth in one
 * language while the client renders the translated one from the code and the
 * per-attachment array.
 */
function describePendingAttachments(jobs: DocumentExtractionJobDTO[]): string {
	if (jobs.length === 1 && jobs[0].fileName) {
		return `${jobs[0].fileName} is still being processed. Wait a moment and send again.`;
	}
	return "Some attached files are still being processed. Wait a moment and send again.";
}

function describeFailedAttachments(jobs: DocumentExtractionJobDTO[]): string {
	if (jobs.length === 1) {
		const job = jobs[0];
		const reason = job.error?.message?.trim();
		const name = job.fileName || "This attachment";
		return reason
			? `${name}: ${reason}`
			: `${name} could not be processed. Remove it or try again.`;
	}
	return "Some attached files could not be processed. Remove them or try again.";
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
