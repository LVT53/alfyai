// Locale parity and byte-identity for the model-facing / user-facing prose
// helpers (slice E).
//
// `registry.test.ts` already checks that the formats these helpers name exist
// and are admitted at intake. This file covers what that one cannot: that the
// EN rendering has not moved a byte, and that the HU rendering names the same
// formats in the same order as the EN one.

import { describe, expect, it } from "vitest";
import {
	getProducibleFormatList,
	getSupportedExtractionSummary,
	type ModelFacingLocale,
} from "./model-facing";
import { FILE_TYPE_ENTRIES } from "./table";

const LOCALES: readonly ModelFacingLocale[] = ["en", "hu"];

/**
 * FROZEN: the format list inside `knowledge/store/attachments.ts:234` as it
 * read before slice E, with the sentence and its full stop removed — the
 * caller owns those (spec section 10, "Per slice: E").
 */
const FROZEN_EN_EXTRACTION_SUMMARY =
	"text, HTML, JSON, PDF, DOCX, PPTX, XLSX, and common image formats (including HEIC/HEIF when server conversion support is installed)";

/** Upper-case format names, e.g. "PDF" — the part a translation must not drop. */
function formatTokens(prose: string): string[] {
	return [...prose.matchAll(/\b[A-Z][A-Z0-9]{1,5}\b/g)].map(
		(match) => match[0],
	);
}

describe("getSupportedExtractionSummary", () => {
	it("renders the English list byte-identically to the literal it replaced", () => {
		expect(getSupportedExtractionSummary("en")).toBe(
			FROZEN_EN_EXTRACTION_SUMMARY,
		);
	});

	it("leaves the terminal punctuation to the caller", () => {
		for (const locale of LOCALES) {
			const summary = getSupportedExtractionSummary(locale);
			expect(summary.endsWith("."), locale).toBe(false);
			expect(summary.trim(), locale).toBe(summary);
			expect(summary.length, locale).toBeGreaterThan(40);
		}
	});

	it("names the same formats, in the same order, in both locales", () => {
		// The HU string is a first-pass translation (spec section 10). The
		// format names inside it are not translatable, so a drift here means a
		// format was dropped or added on one side only.
		expect(formatTokens(getSupportedExtractionSummary("hu"))).toEqual(
			formatTokens(getSupportedExtractionSummary("en")),
		);
	});

	it("keeps the HEIC/HEIF caveat in both locales", () => {
		// Carried over verbatim from the English literal. It is a deliberate
		// hold-over: the registry admits .heic/.heif unconditionally, while the
		// server-side conversion is optional, so the caveat is still true.
		for (const locale of LOCALES) {
			expect(getSupportedExtractionSummary(locale), locale).toContain(
				"HEIC/HEIF",
			);
		}
	});

	it("advertises only formats the registry admits at intake", () => {
		for (const locale of LOCALES) {
			const summary = getSupportedExtractionSummary(locale);
			for (const id of ["pdf", "docx", "pptx", "xlsx", "json", "html"]) {
				const entry = FILE_TYPE_ENTRIES.find(
					(candidate) => candidate.id === id,
				);
				expect(entry?.intake.route, `${locale}/${id}`).not.toBe("reject");
				expect(summary, `${locale}/${id}`).toContain(id.toUpperCase());
			}
		}
	});
});

describe("getProducibleFormatList", () => {
	it("lists only requestable types, in both locales", () => {
		const requestable = new Set(
			FILE_TYPE_ENTRIES.filter((entry) => entry.production.requestable).map(
				(entry) => entry.id.toUpperCase(),
			),
		);
		for (const locale of LOCALES) {
			const listed = getProducibleFormatList(locale).split(", ");
			expect(new Set(listed), locale).toEqual(requestable);
			expect(listed.length, locale).toBe(requestable.size);
		}
	});

	it("keeps the two locales in step until a token is actually translated", () => {
		// PRODUCIBLE_TOKEN_LABELS is empty for both locales today; the hook
		// exists so a translated name can land without touching call sites.
		expect(getProducibleFormatList("hu")).toBe(getProducibleFormatList("en"));
	});

	it("puts the ranked examples first", () => {
		expect(getProducibleFormatList("en").split(", ").slice(0, 6)).toEqual([
			"XLSX",
			"DOCX",
			"PPTX",
			"PDF",
			"CSV",
			"ZIP",
		]);
	});
});
