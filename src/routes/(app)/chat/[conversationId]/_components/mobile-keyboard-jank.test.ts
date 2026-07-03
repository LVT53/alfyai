import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ADR 0043 — Slice 1 regression guard.
 *
 * The mobile keyboard fix delegates to the browser: the viewport meta gets
 * `interactive-widget=resizes-content` so the layout viewport shrinks natively
 * when the soft keyboard opens, and the composer drops its manual
 * `visualViewport` offset math (which double-applied on Android).
 *
 * These tests assert the *outcome* of the slice by reading the source files,
 * since the removed JS had no behavior worth preserving in isolation.
 */

// Walk up from this test file to the repo root (the dir containing src/).
function findRepoRoot(start: string): string {
	let dir = start;
	for (let i = 0; i < 10; i++) {
		if (existsSync(resolve(dir, "src", "app.html"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error(`could not locate repo root from ${start}`);
}

const repoRoot = findRepoRoot(__dirname);
const appHtmlPath = resolve(repoRoot, "src/app.html");
const composerPath = resolve(
	repoRoot,
	"src/routes/(app)/chat/[conversationId]/_components/ChatComposerPanel.svelte",
);

function readSource(path: string): string {
	return readFileSync(path, "utf8");
}

describe("ADR 0043 Slice 1 — mobile keyboard jank fix", () => {
	describe("src/app.html viewport meta", () => {
		it("includes interactive-widget=resizes-content", () => {
			const html = readSource(appHtmlPath);
			const viewportMeta = html.match(
				/<meta\s+name="viewport"\s+content="([^"]*)"\s*\/?>/,
			);
			expect(viewportMeta, "viewport meta tag must exist").not.toBeNull();
			expect(viewportMeta?.[1] ?? "").toMatch(
				/\binteractive-widget\s*=\s*resizes-content\b/,
			);
		});
	});

	describe("ChatComposerPanel.svelte no longer uses manual keyboard offset", () => {
		it("does not reference keyboardOffset state", () => {
			const source = readSource(composerPath);
			expect(source).not.toMatch(/\bkeyboardOffset\b/);
		});

		it("does not reference handleVisualViewportChange", () => {
			const source = readSource(composerPath);
			expect(source).not.toMatch(/\bhandleVisualViewportChange\b/);
		});

		it("does not attach visualViewport listeners", () => {
			const source = readSource(composerPath);
			expect(source).not.toMatch(/visualViewport/i);
		});

		it("does not use a padding-bottom calc with the offset", () => {
			const source = readSource(composerPath);
			expect(source).not.toMatch(/padding-bottom:\s*calc\(/);
		});

		it("does not keep a padding-bottom transition", () => {
			const source = readSource(composerPath);
			expect(source).not.toMatch(/transition:\s*padding-bottom/);
		});
	});
});
