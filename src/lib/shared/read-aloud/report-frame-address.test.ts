import { describe, expect, it } from "vitest";
import {
	REPORT_BRIDGE_VERSION,
	reportFrameAddress,
} from "./report-frame-address";

// A preview is cached for an hour (`Cache-Control: private, max-age=3600`): a
// browser that opened a report before the bridge existed, or before it changed,
// could frame that copy. The frame asks by an address of its own, which the
// preview routes ignore.
describe("the report frame's address", () => {
	it("is the preview's address with the bridge's version, which the server ignores", () => {
		expect(REPORT_BRIDGE_VERSION).toBeGreaterThanOrEqual(1);
		expect(reportFrameAddress("/api/chat/files/file-9/preview")).toBe(
			`/api/chat/files/file-9/preview?rb=${REPORT_BRIDGE_VERSION}`,
		);
	});

	it("keeps what the address already asks, and names the version once", () => {
		expect(reportFrameAddress("/api/knowledge/a1/preview?x=1")).toBe(
			`/api/knowledge/a1/preview?x=1&rb=${REPORT_BRIDGE_VERSION}`,
		);
		expect(reportFrameAddress("/api/knowledge/a1/preview?rb=0")).toBe(
			`/api/knowledge/a1/preview?rb=${REPORT_BRIDGE_VERSION}`,
		);
		expect(
			reportFrameAddress("https://alfy.example/api/chat/files/f/preview"),
		).toBe(
			`https://alfy.example/api/chat/files/f/preview?rb=${REPORT_BRIDGE_VERSION}`,
		);
	});
});
