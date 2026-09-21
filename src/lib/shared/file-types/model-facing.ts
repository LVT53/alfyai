// EN/HU model-facing and user-facing format prose, derived from the registry.
//
// A SEPARATE entry point because it carries Hungarian prose that no client
// chunk should ever download. Imported only by `$lib/server/prompts.ts`,
// `$lib/server/services/normal-chat-tools/index.ts` and
// `$lib/server/services/knowledge/store/attachments.ts`.
//
// The `produce_file` tool descriptions and `prompts.ts`'s row stay
// HAND-WRITTEN. They sit inside a cached prompt prefix (Flash-Next caches on
// 1600-token blocks), so a one-character change evicts every cached prefix for
// every user. `format-prose.test.ts` verifies them against the registry
// instead of generating them.
//
// Slice P6-D re-confirmed that with the numbers in front of it, since it was
// the one slice allowed to change those strings: `getProducibleFormatList`
// now renders 41 tokens / 243 characters per locale, against the six-format
// "(PDF, DOCX, XLSX, PPTX, CSV, Markdown, ...)" the prose actually carries —
// and a DERIVED string would move the cached prefix on every future registry
// edit, turning a one-off eviction into a recurring one. The list stays where
// a human can weigh each word; the ASSERTIONS are what is derived.
//
// `getProducibleFormatList` therefore still has no prompt consumer. It is not
// dead: it is the honest answer to "what can produce_file make?" for any
// surface that wants the whole list rather than a curated six, and
// `model-facing.test.ts` keeps it in step with the table.

import { FILE_TYPE_ENTRIES } from "./table";

export type ModelFacingLocale = "en" | "hu";

/**
 * Per-locale display overrides for a producible type token. Both locales use
 * the bare upper-case id today; the hook exists so a translated name can be
 * added without touching call sites.
 */
const PRODUCIBLE_TOKEN_LABELS: Readonly<
	Record<ModelFacingLocale, Readonly<Record<string, string>>>
> = {
	en: {},
	hu: {},
};

/** Comma-joined upper-case tokens of every requestable type, ranked. For prompt/tool prose. */
export function getProducibleFormatList(locale: ModelFacingLocale): string {
	const labels = PRODUCIBLE_TOKEN_LABELS[locale];
	const requestable = FILE_TYPE_ENTRIES.filter(
		(entry) => entry.production.requestable,
	);
	// `exampleRank` first, in rank order, then the rest in table order.
	const ranked = [
		...requestable
			.filter((entry) => entry.production.exampleRank !== undefined)
			.sort(
				(a, b) =>
					(a.production.exampleRank ?? 0) - (b.production.exampleRank ?? 0),
			),
		...requestable.filter(
			(entry) => entry.production.exampleRank === undefined,
		),
	];
	return ranked
		.map((entry) => labels[entry.id] ?? entry.id.toUpperCase())
		.join(", ");
}

/**
 * The format list inside `attachments.ts`'s readiness error, WITHOUT the
 * trailing full stop — the caller owns the sentence:
 *
 *   `This file could not be prepared for chat. Supported extraction currently
 *    works best for ${getSupportedExtractionSummary("en")}.`
 *
 * NOT model-facing despite this module's name: no prompt and no tool
 * description consumes it (the only importer is
 * `knowledge/store/attachments.ts`), so changing it evicts no cached prompt
 * prefix. It lives here because it is registry-derived prose with a Hungarian
 * twin, which is what this module is for.
 */
export function getSupportedExtractionSummary(
	locale: ModelFacingLocale,
): string {
	const labels = EXTRACTION_SUMMARY_LABELS[locale];
	const formats = EXTRACTION_SUMMARY_IDS.map((id) => labels[id] ?? id).join(
		", ",
	);
	return `${formats}${EXTRACTION_SUMMARY_TAILS[locale]}`;
}

/**
 * The ids the readiness error names, one per FAMILY the registry admits at
 * intake. `registry.test.ts` asserts each one is a real entry that is NOT
 * rejected, so the prose can never advertise a format the upload endpoint
 * refuses.
 *
 * One id stands for its whole family: `docx` also covers `doc`, `xlsx` covers
 * `xls`, `pptx` covers `ppt`, and `odt` covers the three OpenDocument entries
 * (`odt`/`ods`/`odp`). The names are the ones a user recognises ("Word", not
 * "DOCX"), because this sentence is read by a person whose upload just failed,
 * not by the model.
 *
 * The HEIC/HEIF caveat that used to close this sentence is GONE: there is no
 * server-side conversion step. `.heic`/`.heif` are admitted like every other
 * image and handed to MinerU, so the caveat described a component that does
 * not exist. "common image formats" is what is actually true.
 */
const EXTRACTION_SUMMARY_IDS: readonly string[] = [
	"txt",
	"html",
	"json",
	"pdf",
	"docx",
	"xlsx",
	"pptx",
	"odt",
	"epub",
	"rtf",
];

const EXTRACTION_SUMMARY_LABELS: Readonly<
	Record<ModelFacingLocale, Readonly<Record<string, string>>>
> = {
	en: {
		txt: "text",
		html: "HTML",
		json: "JSON",
		pdf: "PDF",
		docx: "Word",
		xlsx: "Excel",
		pptx: "PowerPoint",
		odt: "OpenDocument",
		epub: "EPUB",
		rtf: "RTF",
	},
	hu: {
		// The product names are the same in Hungarian; only the generic word
		// for plain text is translated.
		txt: "szöveg",
		html: "HTML",
		json: "JSON",
		pdf: "PDF",
		docx: "Word",
		xlsx: "Excel",
		pptx: "PowerPoint",
		odt: "OpenDocument",
		epub: "EPUB",
		rtf: "RTF",
	},
};

const EXTRACTION_SUMMARY_TAILS: Readonly<Record<ModelFacingLocale, string>> = {
	en: ", and common image formats",
	// Hungarian does not put a comma before the closing "és".
	hu: " és a gyakori képformátumok",
};
