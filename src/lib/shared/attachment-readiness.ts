/**
 * Why one attachment is not ready to send, as a CODE rather than a sentence.
 *
 * The send gate (`AttachmentReadinessError`) has carried codes plus
 * per-attachment rows since Phase 3, and the client translates those. The
 * per-attachment `readinessError` beside them did not: it was an English
 * literal built on the server, and it is what the composer's red line under a
 * chip, and the upload response, actually show. A Hungarian user got Hungarian
 * chips above an English sentence.
 *
 * This is the missing half of that vocabulary. The server keeps emitting the
 * English sentence (an API consumer, a log line and a non-Svelte caller all
 * still read it) and now emits the code beside it; the client prefers the code
 * and falls back to the sentence when it does not recognise one.
 *
 * Shared, not server-side: a client module cannot import `$lib/server`, and
 * this file carries no prose at all — only identifiers. The prose lives in
 * `$lib/i18n/chat.ts` in both locales, exactly like every other user-facing
 * string.
 */

export const ATTACHMENT_READINESS_REASONS = [
	/** The artifact the composer is holding is gone from the Library. */
	"not_available",
	/** Extraction produced no normalized artifact at all. */
	"not_prepared",
	/** A ledger row that has not reached a terminal status yet. */
	"still_preparing",
	/** A failed ledger row the user can retry from the chip. */
	"extraction_retryable",
	/** A non-document attachment whose own text is too thin to use. */
	"not_text_readable",
	/** Extraction finished, but what it produced has no usable text. */
	"no_usable_text",
] as const;

export type AttachmentReadinessReason =
	(typeof ATTACHMENT_READINESS_REASONS)[number];

const ATTACHMENT_READINESS_REASON_SET: ReadonlySet<string> = new Set<string>(
	ATTACHMENT_READINESS_REASONS,
);

export function isAttachmentReadinessReason(
	value: unknown,
): value is AttachmentReadinessReason {
	return (
		typeof value === "string" && ATTACHMENT_READINESS_REASON_SET.has(value)
	);
}

/**
 * One attachment's content verdict, as the extraction status endpoint carries
 * it beside the job.
 *
 * The job DTO says what the LIFECYCLE did; this says what the finished work is
 * worth. A terminal `succeeded` job whose normalized text is thin is the case
 * this exists for: `promptReady: false` with `no_usable_text`, rather than a
 * success the client never learns was unusable.
 *
 * `promptArtifactId` is the artifact a chat turn would actually attach — the
 * normalized document — and is null whenever `promptReady` is false.
 */
export interface AttachmentReadinessSnapshot {
	artifactId: string;
	promptReady: boolean;
	promptArtifactId: string | null;
	readinessError: string | null;
	readinessErrorCode: AttachmentReadinessReason | null;
}

/**
 * Structural validation for one readiness snapshot off the wire.
 *
 * The status endpoint is the one place these arrive from, and a malformed row
 * must not cost the caller the jobs beside it: the jobs are the lifecycle
 * truth, and a readiness row this build cannot read is dropped rather than
 * turned into an exception. An unrecognised `readinessErrorCode` is malformed
 * for this client — the chip renders that vocabulary, so it could not say
 * anything useful about it anyway.
 */
export function isAttachmentReadinessSnapshot(
	value: unknown,
): value is AttachmentReadinessSnapshot {
	if (typeof value !== "object" || value === null) return false;
	const snapshot = value as Record<string, unknown>;
	return (
		typeof snapshot.artifactId === "string" &&
		snapshot.artifactId.length > 0 &&
		typeof snapshot.promptReady === "boolean" &&
		(snapshot.promptArtifactId === null ||
			typeof snapshot.promptArtifactId === "string") &&
		(snapshot.readinessError === null ||
			typeof snapshot.readinessError === "string") &&
		(snapshot.readinessErrorCode === null ||
			isAttachmentReadinessReason(snapshot.readinessErrorCode))
	);
}

/**
 * One refused attachment, as the send gate's 422 carries it.
 *
 * The sibling of `AttachmentExtractionStatusItem`: that one describes a
 * LEDGER row and so only exists for an attachment extraction actually touched.
 * This one describes the refusal itself, and exists for every unresolved
 * attachment — including the `attachment_not_ready` cases (a deleted file, a
 * non-document) that have no ledger row at all and whose sentence was
 * therefore the one thing still rendered in the server's English.
 */
export interface AttachmentReadinessItem {
	artifactId: string;
	name: string | null;
	reason: AttachmentReadinessReason;
}

/**
 * The i18n key for a reason. Typed as `string` on purpose: `I18nKey` lives in
 * `$lib/i18n`, which pulls in a Svelte store, and this module is imported by
 * server code that must not. `chat.test.ts` asserts every key exists in both
 * dictionaries.
 */
export function attachmentReadinessReasonKey(
	reason: AttachmentReadinessReason,
): string {
	return `chat.attachmentReadiness.${reason}`;
}
