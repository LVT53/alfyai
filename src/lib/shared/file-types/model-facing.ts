// EN/HU model-facing and user-facing format prose, derived from the registry.
//
// A SEPARATE entry point because it carries Hungarian prose that no client
// chunk should ever download. Imported only by `$lib/server/prompts.ts`,
// `$lib/server/services/normal-chat-tools/index.ts` and
// `$lib/server/services/knowledge/store/attachments.ts`.
//
// NOTE for slice E: the `produce_file` tool descriptions and `prompts.ts`'s
// row stay HAND-WRITTEN. They sit inside a cached prompt prefix (Flash-Next
// caches on 1600-token blocks), so a one-character change evicts every cached
// prefix for every user. `format-prose.test.ts` verifies them against the
// registry instead of generating them.

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
 * The EN rendering is byte-identical to the literal at
 * `knowledge/store/attachments.ts:234` today.
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
 * The ids the readiness error names, in the order the English literal names
 * them. `registry.test.ts` asserts each one is a real entry that is NOT
 * rejected at intake, so the prose can never advertise a format the upload
 * endpoint refuses.
 */
const EXTRACTION_SUMMARY_IDS: readonly string[] = [
	"txt",
	"html",
	"json",
	"pdf",
	"docx",
	"pptx",
	"xlsx",
];

const EXTRACTION_SUMMARY_LABELS: Readonly<
	Record<ModelFacingLocale, Readonly<Record<string, string>>>
> = {
	en: {
		txt: "text",
		html: "HTML",
		json: "JSON",
		pdf: "PDF",
		docx: "DOCX",
		pptx: "PPTX",
		xlsx: "XLSX",
	},
	hu: {
		txt: "szöveg",
		html: "HTML",
		json: "JSON",
		pdf: "PDF",
		docx: "DOCX",
		pptx: "PPTX",
		xlsx: "XLSX",
	},
};

const EXTRACTION_SUMMARY_TAILS: Readonly<Record<ModelFacingLocale, string>> = {
	// EN is byte-identical to the literal it replaced and must stay so.
	en: ", and common image formats (including HEIC/HEIF when server conversion support is installed)",
	// "telepítve van a konvertálási támogatás" is a word-for-word rendering of
	// "conversion support is installed" that Hungarian does not use — support
	// is not a thing one installs. "ha a szerveren elérhető a konvertálás"
	// ("if conversion is available on the server") says the same thing the way
	// a Hungarian reader would.
	hu: " és a gyakori képformátumok (beleértve a HEIC/HEIF formátumot is, ha a szerveren elérhető a konvertálás)",
};
