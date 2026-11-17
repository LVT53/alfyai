import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { htmlPreviewSandbox } from "./html-sandbox";

// Read aloud's report bridge talks to a report's frame by postMessage only. Its
// security rests on the frame staying opaque: next to allow-scripts,
// allow-same-origin would let a script in the report lift its own sandbox and act
// as the app. So no sandbox an HTML preview gets may ever carry it.
describe("htmlPreviewSandbox", () => {
	it("never grants allow-same-origin, for a static file or a standard report", () => {
		for (const trustedRuntime of [false, true])
			expect(htmlPreviewSandbox(trustedRuntime)).not.toMatch(
				/allow-same-origin/i,
			);
	});

	it("is empty for a static file, and scripts and popups for a standard report", () => {
		expect(htmlPreviewSandbox(false)).toBe("");
		expect(htmlPreviewSandbox(true)).toBe(
			"allow-scripts allow-popups allow-popups-to-escape-sandbox",
		);
	});

	it("is the only sandbox the preview's frames are drawn with: the report's, framed by its address, and the static file's", () => {
		const renderer = readFileSync(
			"src/lib/components/document-workspace/DocumentPreviewRenderer.svelte",
			"utf8",
		);
		const sandboxes =
			renderer.match(/sandbox=\{[^}]*\}|sandbox="[^"]*"/g) ?? [];
		expect(sandboxes).toEqual([
			"sandbox={htmlPreviewSandbox(true)}",
			"sandbox={htmlPreviewSandbox(false)}",
		]);
		expect(renderer.match(/<iframe\b/g)).toHaveLength(2);
		expect(renderer).not.toMatch(/allow-same-origin/i);
	});
});
