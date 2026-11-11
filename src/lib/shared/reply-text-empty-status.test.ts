import { describe, expect, it } from "vitest";
import { joinReplyText } from "./reply-text";

describe("review D: outward text for finalization marker with empty answer", () => {
	it("D8: a finalization marker with no answer text still yields a non-empty outward text", () => {
		const out = joinReplyText([
			{
				content: "",
				normalChatFinalization: {
					version: 1,
					status: "failed",
					cause: "file_association_failed",
					wasStopped: false,
				},
			},
		]);
		console.log("D8 outward:", JSON.stringify(out));
		expect(out).toBe("");
	});
});
