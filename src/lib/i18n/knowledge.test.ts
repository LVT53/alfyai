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
});
