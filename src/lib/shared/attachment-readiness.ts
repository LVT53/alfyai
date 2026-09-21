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
