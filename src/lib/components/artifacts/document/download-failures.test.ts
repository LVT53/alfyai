import { describe, expect, it } from "vitest";
import { exportFailureKey, exportFailureOf } from "./download-failures";

describe("what a Download that did not arrive says", () => {
	it("reads the server's reasons and the client's own", () => {
		expect(exportFailureOf("source_too_large")).toBe("tooLarge");
		expect(exportFailureOf("no_conversation")).toBe("noConversation");
		expect(exportFailureOf("conversation_required")).toBe("noConversation");
		expect(exportFailureOf("timeout")).toBe("timeout");
		// Anything else (an intake code, a failed job, a thrown start) is one sentence.
		for (const reason of ["job_failed", "no_file", "rate_limited", "failed"]) {
			expect(exportFailureOf(reason)).toBe("failed");
		}
	});

	it("says the App's own sentences for an App and the Document's for a Document", () => {
		expect(exportFailureKey("failed", "document")).toBe(
			"artifacts.document.export.failed",
		);
		expect(exportFailureKey("failed", "app")).toBe(
			"artifacts.app.download.failed",
		);
		expect(exportFailureKey("noConversation", "app")).toBe(
			"artifacts.app.download.unavailable",
		);
		expect(exportFailureKey("noConversation", "document")).toBe(
			"artifacts.document.export.noConversation",
		);
		expect(exportFailureKey("tooLarge", "document")).toBe(
			"artifacts.document.export.tooLarge",
		);
		expect(exportFailureKey("timeout", "app")).toBe(
			"artifacts.document.export.timeout",
		);
	});
});
