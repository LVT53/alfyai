// What a chip SAYS about an attachment, a linked document or a quote —
// the pure half of the chips redesign, shared by the composer
// (MessageInput) and the stream (MessageBubble) so the same file cannot be
// described two different ways in two places.
//
// Boundary rule, per `activity-presentation.ts`: nothing Svelte-reactive and
// nothing that imports the `$t` store. A meta clause comes back as the
// numbers and a template key for the caller to localize.

import type {
	DocumentExtractionJobDTO,
	DocumentExtractionStatus,
	ExtractionErrorCode,
} from "$lib/shared/extraction-status";
import { isTerminalExtractionStatus } from "$lib/shared/extraction-status";
import { displayablePageCountUnit } from "$lib/shared/page-count";
import { getFileType } from "./attachment-file-type";
import type { ComposerChipKind } from "./composer-chip-kinds";

export type AttachmentChipSource = {
	name: string;
	mimeType?: string | null;
	tokenEstimate?: number | undefined;
	pageCount?: number | undefined;
	/**
	 * What `pageCount` counts. Absent for every document parsed before the
	 * structured extractor, which is exactly why the chip shows no count at all
	 * when it is missing — see `attachmentChipMeta`.
	 */
	pageCountKind?: string | null | undefined;
};

/**
 * Which kind of chip a piece of attached material is. An image gets its own
 * kind so the pill can wear a crop of the real file instead of a glyph; a
 * document the user LINKED from the Library gets the shelf mark, which is
 * what separates it from a file they just uploaded.
 */
export function attachmentChipKind(
	source: AttachmentChipSource,
	options: { linked?: boolean } = {},
): ComposerChipKind {
	if (options.linked) return "library";
	return getFileType(source.mimeType ?? null, source.name) === "image"
		? "image"
		: "file";
}

/** "18k", "2M" — the same compaction the old two-line cost card used. */
export function formatTokenCount(value: number): string {
	if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}M`;
	if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
	return String(value);
}

export type AttachmentChipMeta =
	| { key: "composerChips.fileMeta"; pages: string; tokens: string }
	| { key: "composerChips.filePages"; pages: string }
	| { key: "composerChips.fileSlidesMeta"; pages: string; tokens: string }
	| { key: "composerChips.fileSlides"; pages: string }
	| { key: "composerChips.fileSheetsMeta"; pages: string; tokens: string }
	| { key: "composerChips.fileSheets"; pages: string }
	| { key: "composerChips.fileTokens"; tokens: string }
	| null;

/** The two i18n keys each unit owns: with a token clause, and without. */
const CHIP_COUNT_KEYS = {
	page: ["composerChips.fileMeta", "composerChips.filePages"],
	slide: ["composerChips.fileSlidesMeta", "composerChips.fileSlides"],
	sheet: ["composerChips.fileSheetsMeta", "composerChips.fileSheets"],
} as const;

/**
 * The muted clause after the middle dot: "24 pp · 18k tok".
 *
 * This is the redesign's acknowledged trade-off. The old chip was a two-line
 * card whose second line said "18k tokens per turn" in full; the pill has one
 * line, so the cost warning shrinks to "18k tok" and can be ellipsised away
 * on a narrow window. It is still the FIRST thing dropped when the row runs
 * short (see ComposerChip's shrink factors) — deliberately, because a label
 * the user can no longer read is worse than a number they have to widen the
 * window for. Returns null when the turn knows neither figure.
 *
 * The count is only ever shown in the unit it is actually IN. A PPTX counts
 * slides, an XLSX counts sheets, a DOCX reports a `declared` count that is 1
 * for a four-heading document, and a CSV's `logical` count corresponds to
 * nothing a reader could turn to. This chip said "N pp" for all of them —
 * a small, confident lie on every attachment. `displayablePageCountUnit`
 * decides; a document whose kind is unknown (everything parsed before the
 * structured extractor) shows no count rather than a guess.
 */
export function attachmentChipMeta(
	source: AttachmentChipSource,
): AttachmentChipMeta {
	const unit = displayablePageCountUnit(
		source.pageCount ?? null,
		source.pageCountKind ?? null,
	);
	const pages = unit ? String(source.pageCount) : null;
	const tokens =
		typeof source.tokenEstimate === "number" && source.tokenEstimate > 0
			? formatTokenCount(source.tokenEstimate)
			: null;

	if (unit && pages) {
		const [withTokens, alone] = CHIP_COUNT_KEYS[unit];
		return tokens
			? ({ key: withTokens, pages, tokens } as AttachmentChipMeta)
			: ({ key: alone, pages } as AttachmentChipMeta);
	}
	if (tokens) return { key: "composerChips.fileTokens", tokens };
	return null;
}

/**
 * The 18px crop an image chip wears. The artifact is already uploaded by the
 * time it has a chip, so the existing authenticated preview endpoint serves
 * the bytes; there is no second upload and no blob to revoke. A non-image, or
 * an artifact with no id yet, gets null and the chip falls back to its stroke
 * icon.
 */
export function attachmentThumbnailUrl(
	source: AttachmentChipSource & { id?: string | null },
): string | null {
	if (!source.id) return null;
	if (getFileType(source.mimeType ?? null, source.name) !== "image")
		return null;
	return `/api/knowledge/${encodeURIComponent(source.id)}/preview`;
}

/**
 * A quote chip's label: the section heading the user picked, which is the
 * clause before the first colon of the quote the outline built. The rest of
 * the quote is what gets expanded into the message on send, so the pill
 * stays the user's own words rather than 90 characters of the document's.
 */
export function quoteChipLabel(quote: string): string {
	const trimmed = quote.trim();
	const colon = trimmed.indexOf(":");
	const head = colon > 0 ? trimmed.slice(0, colon) : trimmed;
	return head.trim() || trimmed;
}

/**
 * What a chip says, and which controls stand beside it, for a document the
 * extraction ledger is still working on.
 *
 * Progress comes back as `progressKey` (the muted meta clause after the middle
 * dot) and failure as `errorKey` (the chip's short danger clause), rather than
 * both landing in the same slot: the chip paints `status` in `--danger`, and a
 * red "Waiting to be read" would make a perfectly healthy upload look broken.
 * Which is also why a job with no DTO at all — an old server build, or a draft
 * attachment restored from before the ledger — returns all nulls and false:
 * the chip then looks exactly as it did before this phase existed.
 */
export type ExtractionChipState = {
	/** Muted meta clause while the job is queued or running. */
	progressKey: string | null;
	/** Danger clause once the job failed or was stopped. */
	errorKey: string | null;
	/** The "waiting, not attached" dashed edge. */
	dashed: boolean;
	canRetry: boolean;
	canCancel: boolean;
};

const EXTRACTION_PROGRESS_KEYS: Record<string, string> = {
	queued: "chat.extraction.queued",
	uploading: "chat.extraction.parsing",
	parsing: "chat.extraction.parsing",
	downloading: "chat.extraction.parsing",
	indexing: "chat.extraction.indexing",
};

/**
 * The reason clause for one attachment the send gate refused.
 *
 * The 422 carries `status` + `errorCode` + `retryable` per attachment beside
 * an English sentence the server built from hard-wired literals; this is what
 * turns those three facts into the same clause the chip beside the composer is
 * already showing. Same tables, deliberately: two mappings of one vocabulary
 * would drift, and the user would be told two different things about one file.
 */
export function extractionReasonKey(item: {
	status: DocumentExtractionStatus;
	errorCode: ExtractionErrorCode | null;
	retryable: boolean;
}): string {
	if (item.status === "succeeded") return "chat.extraction.queued";
	if (item.status === "canceled") {
		return item.retryable
			? "chat.extraction.canceledRetry"
			: "chat.extraction.canceled";
	}
	if (item.status === "failed") {
		if (item.retryable) return "chat.extraction.failedRetry";
		return item.errorCode
			? `chat.extraction.error.${item.errorCode}`
			: "chat.extraction.failed";
	}
	return EXTRACTION_PROGRESS_KEYS[item.status] ?? "chat.extraction.queued";
}

export function extractionChipState(
	job: DocumentExtractionJobDTO | null | undefined,
): ExtractionChipState {
	const idle: ExtractionChipState = {
		progressKey: null,
		errorKey: null,
		dashed: false,
		canRetry: false,
		canCancel: false,
	};
	if (!job) return idle;

	if (job.status === "succeeded") return idle;

	if (job.status === "canceled") {
		// Stopping a read is undoable. The ledger has always allowed a retry from
		// `canceled`, so the chip offers it: the alternative for someone who hit
		// Stop by mistake was removing the file and uploading it again.
		return {
			progressKey: null,
			errorKey: job.retryable
				? "chat.extraction.canceledRetry"
				: "chat.extraction.canceled",
			dashed: false,
			canRetry: job.retryable,
			canCancel: false,
		};
	}

	if (job.status === "failed") {
		// A retryable failure leads with the offer rather than the cause: the
		// cause of a `max_attempts` or a `stale_worker` is infrastructure the
		// user can do nothing about, and the one useful thing they CAN do is
		// press the button now standing beside the chip.
		const errorKey = job.retryable
			? "chat.extraction.failedRetry"
			: job.error
				? `chat.extraction.error.${job.error.code}`
				: "chat.extraction.failed";
		return {
			progressKey: null,
			errorKey,
			dashed: false,
			canRetry: job.retryable,
			canCancel: false,
		};
	}

	return {
		progressKey: EXTRACTION_PROGRESS_KEYS[job.status] ?? null,
		errorKey: null,
		dashed: true,
		canRetry: false,
		canCancel: job.cancelable,
	};
}

/** The dashed "waiting, not attached" edge. Split out for the §4.3 table. */
export function extractionChipDashed(
	job: DocumentExtractionJobDTO | null | undefined,
): boolean {
	return extractionChipState(job).dashed;
}

/**
 * Whether this attachment is still on its way. `undefined` (no DTO) counts as
 * settled: a build whose upload endpoint says nothing about extraction must
 * not hold Send hostage to a status it will never learn.
 */
export function isExtractionPending(
	job: DocumentExtractionJobDTO | null | undefined,
): boolean {
	if (!job) return false;
	return !isTerminalExtractionStatus(job.status);
}

export type OutlineQuoteSource = {
	title: string;
	preview?: string | null | undefined;
};

/**
 * The text a picked outline section becomes: `"<title>: <preview>…"`, or the
 * bare title when the entry has no preview. This is the ONE place that
 * string is built — AttachmentOutline calls it to make the quote, and
 * `splitUserMessageQuotes` calls it to recognise the quote again in a sent
 * message — so the two can never drift apart.
 */
export function buildOutlineQuote(entry: OutlineQuoteSource): string {
	const preview = (entry.preview ?? "").trim();
	return preview ? `${entry.title}: ${preview}…` : entry.title;
}

export type UserMessageQuoteSplit = {
	/** Section headings to draw as quote chips, in the order they were sent. */
	quoteLabels: string[];
	/** The message text with those quote blocks removed. */
	body: string;
};

/**
 * Splits a SENT user message back into its quote chips and the sentence the
 * user actually typed.
 *
 * The composer expands a quote chip into the message body on send, and there
 * is no persisted field for it (unlike the assistant side, whose provenance
 * line reads a persisted `userIntent` record — see message-provenance.ts —
 * because tool calls cannot say who chose them; here the text itself can be
 * recognised exactly), so the only honest way to draw the chip again
 * in the stream is to recognise the text it produced. That text is not
 * guessed at: `buildOutlineQuote` builds it from an outline entry that is
 * PERSISTED on the attachment, so a leading block is treated as a quote only
 * when it is, byte for byte, the quote one of THIS message's outline entries
 * expands to. Matching the whole quote rather than only the heading before
 * the colon is what keeps a sentence the user typed themselves — "Summary:
 * please give me one" under a document with a "Summary" heading — from being
 * swallowed into a chip.
 *
 * Anything that does not match is left in the body untouched, which is the
 * safe direction to fail: a quote shown as prose is a cosmetic miss, but
 * prose eaten as a quote would lose the user's words.
 */
export function splitUserMessageQuotes(
	content: string,
	outline: OutlineQuoteSource[],
): UserMessageQuoteSplit {
	if (outline.length === 0) return { quoteLabels: [], body: content };
	const quotesByText = new Map<string, string>();
	for (const entry of outline) {
		const quote = buildOutlineQuote(entry).trim();
		if (quote && !quotesByText.has(quote)) {
			quotesByText.set(quote, quoteChipLabel(quote));
		}
	}
	const quoteLabels: string[] = [];
	let rest = content;
	// Quotes are expanded ABOVE the typed text, separated by a blank line, in
	// pick order — so peel whole quotes off the front until one does not
	// match. A quote is only consumed when what follows it is the blank-line
	// separator or the end of the message, so a quote's text merely
	// PREFIXING a longer paragraph is left alone.
	for (;;) {
		const trimmed = rest.trimStart();
		if (!trimmed) break;
		let matched: string | null = null;
		for (const [quote, label] of quotesByText) {
			if (!trimmed.startsWith(quote)) continue;
			const after = trimmed.slice(quote.length);
			const separated = after.trim() === "" || /^[ \t]*\n\s*\n/.test(after);
			if (!separated) continue;
			matched = quote;
			quoteLabels.push(label);
			rest = after;
			break;
		}
		if (!matched) break;
	}
	return { quoteLabels, body: quoteLabels.length > 0 ? rest.trim() : content };
}
