import { describe, expect, it } from "vitest";
import legalDict, { PRIVACY_POLICY_SECTIONS } from "./legal";

describe("legal i18n dictionary", () => {
	it("has an en key for every hu key and vice versa", () => {
		const enKeys = Object.keys(legalDict.en).sort();
		const huKeys = Object.keys(legalDict.hu).sort();

		expect(enKeys).toEqual(huKeys);
	});

	it("has no empty translations", () => {
		for (const [key, value] of Object.entries(legalDict.en)) {
			expect(value.trim(), `en.${key}`).not.toBe("");
		}
		for (const [key, value] of Object.entries(legalDict.hu)) {
			expect(value.trim(), `hu.${key}`).not.toBe("");
		}
	});

	it("every key is namespaced under legal.", () => {
		for (const key of Object.keys(legalDict.en)) {
			expect(key.startsWith("legal.")).toBe(true);
		}
	});

	it("has a title/body pair for every section in PRIVACY_POLICY_SECTIONS", () => {
		for (const section of PRIVACY_POLICY_SECTIONS) {
			expect(
				legalDict.en[`legal.privacy.section.${section}.title` as never],
			).toBeTruthy();
			expect(
				legalDict.en[`legal.privacy.section.${section}.body` as never],
			).toBeTruthy();
			expect(
				legalDict.hu[`legal.privacy.section.${section}.title` as never],
			).toBeTruthy();
			expect(
				legalDict.hu[`legal.privacy.section.${section}.body` as never],
			).toBeTruthy();
		}
	});

	it("has a last-updated line", () => {
		expect(legalDict.en["legal.privacy.lastUpdatedLabel"]).toBeTruthy();
		expect(legalDict.en["legal.privacy.lastUpdatedDate"]).toBeTruthy();
		expect(legalDict.hu["legal.privacy.lastUpdatedLabel"]).toBeTruthy();
		expect(legalDict.hu["legal.privacy.lastUpdatedDate"]).toBeTruthy();
	});

	describe("required substantive sections (grounded in AlfyAI's real data handling)", () => {
		const allEnText = Object.values(legalDict.en).join(" \n ");

		it("covers connectors and credential encryption", () => {
			expect(allEnText).toMatch(/calendar/i);
			expect(allEnText).toMatch(/email/i);
			expect(allEnText).toMatch(/photos/i);
			expect(allEnText).toMatch(/contacts/i);
			expect(allEnText).toMatch(/encrypted/i);
			expect(allEnText).toMatch(/AES-GCM/);
		});

		it("covers data locality (local processing + first-time cloud warning) without internal labels", () => {
			expect(allEnText).toMatch(/local model/i);
			expect(allEnText).toMatch(/one-time warning/i);
			expect(allEnText).not.toMatch(/option a/i);
			expect(allEnText).not.toMatch(/option c/i);
		});

		it("covers third-party model providers", () => {
			expect(allEnText).toMatch(/third-party cloud model/i);
			expect(allEnText).toMatch(/model provider/i);
		});

		it("covers memory and incognito (saved-but-untracked)", () => {
			expect(allEnText).toMatch(/memory/i);
			expect(allEnText).toMatch(/incognito/i);
			expect(allEnText).toMatch(/saved-but-untracked/i);
		});

		it("covers writes are confirmed, never autonomous", () => {
			expect(allEnText).toMatch(/explicitly review and confirm/i);
			expect(allEnText).toMatch(/never.*on its own|autonomously/i);
		});

		it("covers data export and account erasure", () => {
			expect(allEnText).toMatch(/account data archive/i);
			expect(allEnText).toMatch(/account erasure|erasure/i);
			expect(allEnText).toMatch(/anonymous aggregate/i);
		});

		it("names the entity AlfyAI and the contact address", () => {
			expect(allEnText).toMatch(/AlfyAI/);
			expect(allEnText).toMatch(/levente@alfydesign\.com/);
		});

		it("flags unresolved legal specifics as placeholders instead of inventing them", () => {
			expect(allEnText).toMatch(/placeholder/i);
		});
	});
});
