import { describe, expect, it } from "vitest";
import {
	DOCUMENT_EXTRACTION_STATUSES,
	EXTRACTION_ERROR_CODES,
} from "$lib/shared/extraction-status";
import { collectDictionaryKeys } from "../i18n.test-helpers";
import knowledgeDict from "./knowledge";

type KnowledgeKey = keyof typeof knowledgeDict.en;

describe("knowledge.extraction dictionary", () => {
	it("localizes every extraction status the ledger can report", () => {
		// The Knowledge list renders whatever status the DTO carries. A status
		// without a key would print `knowledge.extraction.status.parsing` into
		// the Status column, which is worse than saying nothing at all.
		for (const status of DOCUMENT_EXTRACTION_STATUSES) {
			const key = `knowledge.extraction.status.${status}` as KnowledgeKey;
			expect(knowledgeDict.en[key]).toBeTruthy();
			expect(knowledgeDict.hu[key]).toBeTruthy();
		}
	});

	it("localizes every extraction error code, including auth_failed", () => {
		// `auth_failed` is the code the Phase 2 seam added late; it is named
		// here explicitly because the loop would happily pass with it missing
		// from the shared list rather than from the dictionary.
		expect(EXTRACTION_ERROR_CODES).toContain("auth_failed");

		for (const code of EXTRACTION_ERROR_CODES) {
			const key = `knowledge.extraction.error.${code}` as KnowledgeKey;
			expect(knowledgeDict.en[key]).toBeTruthy();
			expect(knowledgeDict.hu[key]).toBeTruthy();
		}
	});

	it("actually translates the extraction strings rather than copying English", () => {
		const shared = Object.keys(knowledgeDict.en).filter((key) =>
			key.startsWith("knowledge.extraction."),
		) as KnowledgeKey[];

		expect(shared.length).toBeGreaterThan(0);
		for (const key of shared) {
			expect(knowledgeDict.hu[key]).not.toBe(knowledgeDict.en[key]);
		}
	});

	it("audits the extraction prefixes for EN/HU parity", () => {
		const keys = collectDictionaryKeys();
		const auditedExtractionKeys = keys.en.filter((key) =>
			key.startsWith("knowledge.extraction."),
		);

		// If the prefix were missing from AUDITED_PREFIXES the parity test in
		// i18n.test.ts would silently stop covering these keys, so assert the
		// collector sees them at all.
		expect(auditedExtractionKeys.length).toBeGreaterThan(0);
		expect(
			keys.hu.filter((key) => key.startsWith("knowledge.extraction.")),
		).toEqual(auditedExtractionKeys);
	});

	// Ruling 60: the Documents tab's second-tier file-family row. `knowledge.`
	// as a whole is not in i18n.test.ts's AUDITED_PREFIXES (pre-existing
	// drift — see that file's comment), so this narrow, explicit check is the
	// only thing that would catch one of these seven labels landing in EN and
	// not in HU.
	it("gives every fileFamily label and the renamed Files chip both an EN and a natural HU string", () => {
		const fileFamilyKeys = (
			Object.keys(knowledgeDict.en) as KnowledgeKey[]
		).filter((key) => key.startsWith("knowledge.documents.fileFamily."));

		// The seven family labels plus the row's own group label.
		expect(fileFamilyKeys.length).toBe(8);
		for (const key of fileFamilyKeys) {
			expect(knowledgeDict.en[key]).toBeTruthy();
			expect(knowledgeDict.hu[key]).toBeTruthy();
		}
		// "PDF" and "Word" are the same word in both languages by design — every
		// OTHER family must actually be translated, not copied.
		const translated = fileFamilyKeys.filter(
			(key) =>
				!key.endsWith(".pdf") &&
				!key.endsWith(".word") &&
				!key.endsWith(".groupLabel"),
		);
		expect(translated.length).toBeGreaterThan(0);
		for (const key of translated) {
			expect(knowledgeDict.hu[key]).not.toBe(knowledgeDict.en[key]);
		}

		// The chip covering the same Files bucket must have moved off the old
		// "Uploaded" text in both languages, not just English.
		expect(knowledgeDict.en["knowledge.documents.filter.uploaded"]).toBe(
			"Files",
		);
		expect(knowledgeDict.hu["knowledge.documents.filter.uploaded"]).toBe(
			"Fájlok",
		);
	});
});
