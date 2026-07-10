import { describe, expect, it } from "vitest";
import { buildMemoryReadSanitizer } from "./sanitize";

describe("memory-read sanitizer", () => {
	it("replaces the raw user id with the display name", () => {
		const sanitize = buildMemoryReadSanitizer({
			userId: "user-1",
			userDisplayName: "Ada",
		});
		expect(sanitize("A note about user-1 and their bike")).toBe(
			"A note about Ada and their bike",
		);
	});

	it("falls back to 'the user' when no display name is given", () => {
		const sanitize = buildMemoryReadSanitizer({ userId: "user-1" });
		expect(sanitize("user-1 prefers concise answers")).toBe(
			"the user prefers concise answers",
		);
	});

	it("scrubs legacy internal peer-id patterns", () => {
		const sanitize = buildMemoryReadSanitizer({
			userId: "user-1",
			userDisplayName: "Ada",
		});
		expect(sanitize("Mentioned by U_abcd1234 earlier")).toBe(
			"Mentioned by Ada earlier",
		);
	});

	it("is a no-op for text without identifiers", () => {
		const sanitize = buildMemoryReadSanitizer({
			userId: "user-1",
			userDisplayName: "Ada",
		});
		expect(sanitize("Bike setup notes")).toBe("Bike setup notes");
	});
});
