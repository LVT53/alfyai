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
 * FROZEN: the format list, with the sentence and its full stop removed — the
 * caller owns those (spec section 10, "Per slice: E").
 *
 * DELIBERATELY RE-FROZEN. The previous copy named "DOCX, PPTX, XLSX" and ended
 * with "(including HEIC/HEIF when server conversion support is installed)".
 * There is no server-side HEIC conversion — `.heic`/`.heif` are admitted like
 * any other image and handed straight to MinerU — so the caveat described a
 * component that does not exist, and the list left out four families the
 * registry does admit (OpenDocument, EPUB, RTF, and the legacy
 * `.doc`/`.xls`/`.ppt`). The sentence is a runtime error shown to a user whose
 * upload just failed; it is not in any prompt or tool description, so moving
 * it evicts no cached prompt prefix.
 */
const FROZEN_EN_EXTRACTION_SUMMARY =
	"text, HTML, JSON, PDF, Word, Excel, PowerPoint, OpenDocument, EPUB, RTF, and common image formats";

/** The Hungarian twin, frozen the same way. */
const FROZEN_HU_EXTRACTION_SUMMARY =
	"szöveg, HTML, JSON, PDF, Word, Excel, PowerPoint, OpenDocument, EPUB, RTF és a gyakori képformátumok";

/** Upper-case format names, e.g. "PDF" — the part a translation must not drop. */
function formatTokens(prose: string): string[] {
	return [...prose.matchAll(/\b[A-Z][A-Z0-9]{1,5}\b/g)].map(
		(match) => match[0],
	);
}

describe("getSupportedExtractionSummary", () => {
	it("renders the English list byte-identically to its frozen copy", () => {
		expect(getSupportedExtractionSummary("en")).toBe(
			FROZEN_EN_EXTRACTION_SUMMARY,
		);
	});

	it("renders the Hungarian list byte-identically to its frozen copy", () => {
		expect(getSupportedExtractionSummary("hu")).toBe(
			FROZEN_HU_EXTRACTION_SUMMARY,
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

	it("claims no server-side HEIC/HEIF conversion, because there is none", () => {
		// The registry hands .heic/.heif to MinerU like any other image; no
		// conversion component exists to be "installed". The sentence must not
		// promise one, in either locale.
		for (const locale of LOCALES) {
			const summary = getSupportedExtractionSummary(locale);
			expect(summary, locale).not.toContain("HEIC");
			expect(summary, locale).not.toContain("HEIF");
			expect(summary.toLowerCase(), locale).not.toContain("convers");
			expect(summary.toLowerCase(), locale).not.toContain("konvert");
		}
	});

	it("advertises only formats the registry admits at intake", () => {
		// Every id the summary names must be a real, non-rejected entry — and
		// its label must actually appear in both locales.
		const named: Record<string, string> = {
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
		};
		for (const locale of LOCALES) {
			const summary = getSupportedExtractionSummary(locale);
			for (const [id, label] of Object.entries(named)) {
				const entry = FILE_TYPE_ENTRIES.find(
					(candidate) => candidate.id === id,
				);
				expect(entry, `${locale}/${id}`).toBeDefined();
				expect(entry?.intake.route, `${locale}/${id}`).not.toBe("reject");
				if (id !== "txt") {
					expect(summary, `${locale}/${id}`).toContain(label);
				}
			}
		}
	});

	it("names at least one admitted image entry's family generically", () => {
		// "common image formats" is only honest while the registry still admits
		// images at all.
		const images = FILE_TYPE_ENTRIES.filter(
			(entry) => entry.category === "image" && entry.intake.route !== "reject",
		);
		expect(images.length).toBeGreaterThan(0);
		expect(getSupportedExtractionSummary("en")).toContain(
			"common image formats",
		);
		expect(getSupportedExtractionSummary("hu")).toContain("képformátumok");
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
