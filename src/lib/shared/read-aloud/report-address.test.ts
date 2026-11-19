import { describe, expect, it } from "vitest";
import { reportAddressOf } from "./report-address";

// Read aloud on a standard report reads the report the panel's preview showed, by
// that preview's own address: a chat file's, or a library item's.
describe("reportAddressOf", () => {
	it("names a report opened from a chat by its chat file", () => {
		expect(reportAddressOf("/api/chat/files/file-9/preview")).toEqual({
			fileId: "file-9",
		});
	});

	it("names a report opened from the Knowledge library by its library item", () => {
		expect(reportAddressOf("/api/knowledge/lib-1/preview")).toEqual({
			artifactId: "lib-1",
		});
	});

	it("reads an id the address escaped", () => {
		expect(reportAddressOf("/api/knowledge/a%20b/preview")).toEqual({
			artifactId: "a b",
		});
	});

	it("names no report for any other address", () => {
		for (const address of [
			null,
			"",
			"/api/chat/files/file-9/download",
			"/api/chat/files/file-9/preview?rb=1",
			"/api/chat/files//preview",
			"/api/artifacts/a1/app",
			"https://elsewhere.example/api/chat/files/file-9/preview",
			"/api/knowledge/%E0%A4%A/preview",
		])
			expect(reportAddressOf(address), String(address)).toBeNull();
	});
});
