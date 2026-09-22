import { describe, expect, it } from "vitest";
import {
	DOCUMENT_EXTRACTION_STATUSES,
	EXTRACTION_ERROR_CODES,
} from "$lib/shared/extraction-status";
import { TOOL_ACTIVITY_I18N_KEYS } from "$lib/utils/tool-activity";
import chatDict, { INCOGNITO_GREETINGS } from "./chat";

describe("chat i18n dictionary", () => {
	it("has an en key for every hu key and vice versa", () => {
		const enKeys = Object.keys(chatDict.en).sort();
		const huKeys = Object.keys(chatDict.hu).sort();

		expect(enKeys).toEqual(huKeys);
	});

	// The incognito landing greeting is picked by array index (spec §3), so
	// an en/hu length mismatch would either throw or silently pick from the
	// wrong line once the shorter list runs out — pin the lengths together,
	// not just "both non-empty".
	it("keeps the incognito greeting pools index-aligned and non-empty", () => {
		expect(INCOGNITO_GREETINGS.en.length).toBe(INCOGNITO_GREETINGS.hu.length);
		expect(INCOGNITO_GREETINGS.en.length).toBeGreaterThan(0);
		for (const line of [...INCOGNITO_GREETINGS.en, ...INCOGNITO_GREETINGS.hu]) {
			expect(line.trim().length).toBeGreaterThan(0);
		}
	});

	// Unified tool activity rows — a verb the dictionary is missing would not
	// fail a build; it would silently print the raw key ("toolActivity.read")
	// in the chat. This pins every key a row can emit, in both languages.
	it("resolves every tool activity row key in both en and hu", () => {
		for (const key of TOOL_ACTIVITY_I18N_KEYS) {
			for (const lang of ["en", "hu"] as const) {
				const value =
					chatDict[lang][key as keyof (typeof chatDict)[typeof lang]];
				expect(typeof value, `${lang}.${key} is missing`).toBe("string");
				expect(String(value).trim(), `${lang}.${key} is empty`).not.toBe("");
			}
		}
	});

	// The composer names an extraction failure by its code. A code the
	// dictionary is missing would print itself — "chat.extraction.error.
	// auth_failed" — in the chip, to the user least able to act on it. The
	// source of truth is the ledger's own code list, so a code added there
	// fails here rather than in production.
	it("names every extraction error code in both en and hu", () => {
		for (const code of EXTRACTION_ERROR_CODES) {
			const key = `chat.extraction.error.${code}`;
			for (const lang of ["en", "hu"] as const) {
				const value =
					chatDict[lang][key as keyof (typeof chatDict)[typeof lang]];
				expect(typeof value, `${lang}.${key} is missing`).toBe("string");
				expect(String(value).trim(), `${lang}.${key} is empty`).not.toBe("");
			}
		}
	});

	// The four non-terminal statuses and `canceled` each get a clause; the two
	// remaining terminals (`succeeded`, `failed`) are covered by the plain chip
	// and by `chat.extraction.failed` / `.failedRetry` respectively.
	it("has a clause for every extraction status the chip narrates", () => {
		const narrated = DOCUMENT_EXTRACTION_STATUSES.filter(
			(status) => status !== "succeeded" && status !== "failed",
		);
		const keys: Record<string, string> = {
			queued: "chat.extraction.queued",
			uploading: "chat.extraction.parsing",
			parsing: "chat.extraction.parsing",
			downloading: "chat.extraction.parsing",
			indexing: "chat.extraction.indexing",
			canceled: "chat.extraction.canceled",
		};

		for (const status of narrated) {
			const key = keys[status];
			expect(key, `no clause mapped for status ${status}`).toBeDefined();
			for (const lang of ["en", "hu"] as const) {
				const value =
					chatDict[lang][key as keyof (typeof chatDict)[typeof lang]];
				expect(typeof value, `${lang}.${key} is missing`).toBe("string");
			}
		}
	});

	it("has no empty translations", () => {
		for (const [key, value] of Object.entries(chatDict.en)) {
			expect(value.trim(), `en.${key}`).not.toBe("");
		}
		for (const [key, value] of Object.entries(chatDict.hu)) {
			expect(value.trim(), `hu.${key}`).not.toBe("");
		}
	});
});
