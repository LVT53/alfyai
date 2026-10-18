// The one readiness authority.
//
// "Can this attachment be sent?" and "is the extracted text worth sending?" are
// asked by the send gate (`store/attachments.ts`) and by the extraction-status
// poll route. Both now get their answer here, so a late `succeeded` job whose
// normalized document is thin cannot be told one story by the chip and another
// by the gate.
//
// Bundle hygiene is part of the contract: this module is on the poll route, so
// it reads rows and evaluates text only. It does NOT import `knowledge/store`
// (which reaches the parse bundle), an extractor, the runner, intake, or
// `node:fs` — `services/extraction/boundary.test.ts` enforces that.

import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "$lib/server/db";
import { artifactLinks, artifacts } from "$lib/server/db/schema";
import type {
	AttachmentReadinessReason,
	AttachmentReadinessSnapshot,
} from "$lib/shared/attachment-readiness";
import type { DocumentExtractionJobDTO } from "$lib/shared/extraction-status";
import { isTerminalExtractionStatus } from "$lib/shared/extraction-status";
import { getSupportedExtractionSummary } from "$lib/shared/file-types/model-facing";
import { hasMeaningfulAttachmentText } from "../attachment-trace";
import {
	buildArtifactVisibilityCondition,
	getArtifactOwnershipScope,
	isArtifactCanonicallyOwned,
} from "./ownership";

/**
 * Readiness error shown when an uploaded file produced no normalized artifact.
 *
 * Spec row 41: the format list is derived from the registry so it can never
 * advertise a format the upload endpoint refuses. The sentence around it stays
 * here — `getSupportedExtractionSummary` deliberately returns the list WITHOUT
 * a trailing full stop, so the caller owns the punctuation.
 *
 * This string is a RUNTIME error message; it is not part of any prompt, so it
 * does not sit in the model's cached prompt prefix. It still renders
 * byte-identically to the literal this replaced — asserted in
 * `attachments.test.ts` and `model-facing.test.ts`.
 */
export const NOT_PREPARED_READINESS_ERROR = `This file could not be prepared for chat. Supported extraction currently works best for ${getSupportedExtractionSummary(
	"en",
)}.`;

/**
 * Phase 3: extraction runs in the background, so "no normalized artifact yet"
 * is the NORMAL state of a freshly uploaded PDF rather than a verdict on it.
 * These two sentences are what keeps the send gate from calling a document
 * broken one second after the upload that will finish preparing it.
 */
export const STILL_PREPARING_READINESS_ERROR =
	"This file is still being prepared for chat. Wait a moment and send it again.";

export const EXTRACTION_RETRYABLE_READINESS_ERROR =
	"This file could not be prepared for chat. Try the Retry action on it, then send again.";

/** The normalized document exists, but its text is too thin to use. */
export const NO_USABLE_TEXT_READINESS_ERROR =
	"This file was uploaded, but no usable readable text could be prepared for chat from it.";

/** The attachment is not a kind whose own text can be sent at all. */
export const NOT_TEXT_READABLE_READINESS_ERROR =
	"This attachment does not contain enough readable text to use in chat. Remove it or upload a supported text-readable document.";

/** The attachment the caller is holding is gone from the Library. */
export const NOT_AVAILABLE_READINESS_ERROR =
	"Attached file is no longer available.";

/** A prompt-ready verdict: the id to attach, and no refusal. */
export interface PromptArtifactReadinessVerdict {
	promptReady: boolean;
	promptArtifactId: string | null;
	readinessError: string | null;
	readinessErrorCode: AttachmentReadinessReason | null;
}

/**
 * The content verdict for one prompt artifact.
 *
 * Missing prompt artifact means extraction produced nothing usable to attach
 * (`not_prepared`); a present artifact without meaningful text is the thinner
 * failure (`no_usable_text`). Anything else is ready.
 */
export function evaluatePromptArtifactReadiness(
	promptArtifact: { id: string; contentText: string | null } | null,
): PromptArtifactReadinessVerdict {
	if (!promptArtifact) {
		return {
			promptReady: false,
			promptArtifactId: null,
			readinessError: NOT_PREPARED_READINESS_ERROR,
			readinessErrorCode: "not_prepared",
		};
	}
	if (!hasMeaningfulAttachmentText(promptArtifact.contentText)) {
		return {
			promptReady: false,
			promptArtifactId: null,
			readinessError: NO_USABLE_TEXT_READINESS_ERROR,
			readinessErrorCode: "no_usable_text",
		};
	}
	return {
		promptReady: true,
		promptArtifactId: promptArtifact.id,
		readinessError: null,
		readinessErrorCode: null,
	};
}

/**
 * The ledger row's own verdict, layered over the caller's fallback.
 *
 * A queued/active row is "still preparing", a retryable failure is "try Retry",
 * and a terminal non-retryable failure keeps its own `ExtractionErrorCode`
 * message (the client already renders that vocabulary, so no second code is
 * minted). Anything else keeps the fallback.
 */
export function extractionReadinessError(
	job: DocumentExtractionJobDTO,
	fallback: { message: string | null; code: AttachmentReadinessReason | null },
): { message: string | null; code: AttachmentReadinessReason | null } {
	if (!isTerminalExtractionStatus(job.status)) {
		return {
			message: STILL_PREPARING_READINESS_ERROR,
			code: "still_preparing",
		};
	}
	if (job.status === "failed") {
		if (job.retryable) {
			return {
				message: EXTRACTION_RETRYABLE_READINESS_ERROR,
				code: "extraction_retryable",
			};
		}
		// A terminal, non-retryable failure carries an `ExtractionErrorCode` of
		// its own on the ledger row the client already has. It renders THAT —
		// one vocabulary, not two — so no readiness code is minted here.
		if (job.error?.message) return { message: job.error.message, code: null };
	}
	return fallback;
}

interface DisplayArtifactRow {
	id: string;
	userId: string;
	type: string;
	conversationId: string | null;
	contentText: string | null;
}

async function readNormalizedDocuments(
	userId: string,
	sourceArtifactIds: string[],
): Promise<Map<string, { id: string; contentText: string | null }>> {
	const result = new Map<string, { id: string; contentText: string | null }>();
	if (sourceArtifactIds.length === 0) return result;

	const rows = await db
		.select({
			sourceArtifactId: artifactLinks.relatedArtifactId,
			id: artifacts.id,
			contentText: artifacts.contentText,
		})
		.from(artifactLinks)
		.innerJoin(artifacts, eq(artifactLinks.artifactId, artifacts.id))
		.where(
			and(
				eq(artifactLinks.userId, userId),
				inArray(artifactLinks.relatedArtifactId, sourceArtifactIds),
				eq(artifactLinks.linkType, "derived_from"),
				eq(artifacts.type, "normalized_document"),
			),
		)
		// Oldest first: `getNormalizedArtifactForSource` takes the first link,
		// and the batch read has to answer the same document the send gate would.
		.orderBy(asc(artifactLinks.createdAt));

	for (const row of rows) {
		if (!row.sourceArtifactId || result.has(row.sourceArtifactId)) continue;
		result.set(row.sourceArtifactId, {
			id: row.id,
			contentText: row.contentText ?? null,
		});
	}

	return result;
}

/**
 * Content verdicts for a batch of display artifacts, in the caller's order.
 *
 * A source document gets its normalized document's verdict. A non-source
 * display artifact is its OWN prompt artifact — the send gate evaluates its
 * text directly — so it is ready when that text is meaningful and
 * `not_text_readable` when it is thin. Unknown and unowned ids are omitted,
 * exactly like the job read model: polling must not reveal another user's
 * artifact exists. Ownership goes through the same incognito scope as
 * `getArtifactsForUser`: visibility narrows the query, then the canonical
 * predicate filters the rows.
 */
export async function readAttachmentReadinessSnapshots(
	userId: string,
	artifactIds: string[],
): Promise<AttachmentReadinessSnapshot[]> {
	const ids = Array.from(new Set(artifactIds.filter(Boolean)));
	if (ids.length === 0) return [];

	const ownershipScope = await getArtifactOwnershipScope(userId, {
		includeIncognito: true,
	});
	const displayRows: DisplayArtifactRow[] = await db
		.select({
			id: artifacts.id,
			userId: artifacts.userId,
			type: artifacts.type,
			conversationId: artifacts.conversationId,
			contentText: artifacts.contentText,
		})
		.from(artifacts)
		.where(
			and(
				inArray(artifacts.id, ids),
				buildArtifactVisibilityCondition({ userId, ownershipScope }),
			),
		);
	const ownedDisplayRows = displayRows.filter((row) =>
		isArtifactCanonicallyOwned({ userId, ownershipScope, artifact: row }),
	);

	const displayById = new Map(ownedDisplayRows.map((row) => [row.id, row]));
	const sourceIds = ownedDisplayRows
		.filter((row) => row.type === "source_document")
		.map((row) => row.id);
	const normalizedBySource = await readNormalizedDocuments(userId, sourceIds);

	return ids.flatMap((artifactId) => {
		const display = displayById.get(artifactId);
		if (!display) return [];

		if (display.type !== "source_document") {
			// The send gate lets a non-source attachment be its own prompt
			// artifact: meaningful text is ready, thin text is `not_text_readable`
			// (not the normalized-document `no_usable_text` reason).
			const verdict = evaluatePromptArtifactReadiness(display);
			return [
				{
					artifactId,
					promptReady: verdict.promptReady,
					promptArtifactId: verdict.promptArtifactId,
					readinessError: verdict.promptReady
						? null
						: NOT_TEXT_READABLE_READINESS_ERROR,
					readinessErrorCode: verdict.promptReady
						? null
						: ("not_text_readable" as const),
				},
			];
		}

		const normalized = normalizedBySource.get(artifactId) ?? null;
		return [
			{
				artifactId,
				...evaluatePromptArtifactReadiness(normalized),
			},
		];
	});
}
