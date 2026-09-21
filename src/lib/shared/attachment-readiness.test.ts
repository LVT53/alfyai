// The readiness vocabulary, and the one thing that can silently rot about it:
// a reason with no translation prints its own key at the user, and the
// translated format list drifting away from what the upload endpoint admits.

import { describe, expect, it } from "vitest";
import chatDict from "$lib/i18n/chat";
import { getSupportedExtractionSummary } from "$lib/shared/file-types/model-facing";
import {
	ATTACHMENT_READINESS_REASONS,
	attachmentReadinessReasonKey,
	isAttachmentReadinessReason,
} from "./attachment-readiness";

describe("attachment readiness reasons", () => {
	it("names every reason in both en and hu", () => {
		for (const reason of ATTACHMENT_READINESS_REASONS) {
			const key = attachmentReadinessReasonKey(reason);
			for (const lang of ["en", "hu"] as const) {
				const value =
					chatDict[lang][key as keyof (typeof chatDict)[typeof lang]];
				expect(typeof value, `${lang}.${key} is missing`).toBe("string");
				expect(String(value).trim(), `${lang}.${key} is empty`).not.toBe("");
			}
		}
	});

	it("keeps the two locales genuinely different, not a copied English string", () => {
		for (const reason of ATTACHMENT_READINESS_REASONS) {
			const key = attachmentReadinessReasonKey(reason);
			const en = chatDict.en[key as keyof typeof chatDict.en];
			const hu = chatDict.hu[key as keyof typeof chatDict.hu];
			expect(hu, `${key} was never translated`).not.toBe(en);
		}
	});

	// The English sentence the SERVER sends is built from the registry. The
	// dictionary carries its own copy, because the client must not import the
	// module that holds the Hungarian prose for prompts. These two copies of
	// one sentence are exactly the kind of pair that drifts, so pin them.
	it("carries the registry-derived format list in both locales", () => {
		expect(chatDict.en["chat.attachmentReadiness.not_prepared"]).toContain(
			getSupportedExtractionSummary("en"),
		);
		expect(chatDict.hu["chat.attachmentReadiness.not_prepared"]).toContain(
			getSupportedExtractionSummary("hu"),
		);
	});

	it("recognises its own reasons and nothing else", () => {
		for (const reason of ATTACHMENT_READINESS_REASONS) {
			expect(isAttachmentReadinessReason(reason)).toBe(true);
		}
		for (const other of [null, undefined, "", "nope", 7, {}]) {
			expect(isAttachmentReadinessReason(other), String(other)).toBe(false);
		}
	});
});
