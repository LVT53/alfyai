// Real headless-Chromium checks for the App suite's browser pass (ruling 56).
// Unlike every other test in this harness, this one DOES launch a real
// browser — there is no faking a console error, a blocked network request or
// storage usage without actually running the page. Kept to a small number of
// cases (one browser launch each) given the cost.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluateApp } from "./browser-eval";

let outDir: string;

beforeEach(() => {
	outDir = mkdtempSync(join(tmpdir(), "browser-eval-test-"));
});

afterEach(() => {
	rmSync(outDir, { recursive: true, force: true });
});

describe("evaluateApp (ruling 56)", () => {
	it("captures a console error", async () => {
		const html = `<!doctype html><html><body>
<button id="go">Go</button>
<script>console.error("boom: something went wrong");</script>
</body></html>`;
		const browser = await chromium.launch();
		try {
			const result = await evaluateApp(browser, html, "console-error", outDir);
			expect(result.consoleErrors.some((e) => e.includes("boom"))).toBe(true);
		} finally {
			await browser.close();
		}
	}, 30_000);

	it("records a blocked network request instead of letting it through", async () => {
		const html = `<!doctype html><html><body>
<button id="go">Go</button>
<img src="https://example.invalid/should-be-blocked.png">
</body></html>`;
		const browser = await chromium.launch();
		try {
			const result = await evaluateApp(
				browser,
				html,
				"blocked-request",
				outDir,
			);
			expect(
				result.blockedRequests.some((url) =>
					url.includes("should-be-blocked.png"),
				),
			).toBe(true);
		} finally {
			await browser.close();
		}
	}, 30_000);

	it("detects window.alfy.storage use, injected before the app's own script runs", async () => {
		const html = `<!doctype html><html><body>
<button id="go">Save</button>
<script>
  document.getElementById('go').addEventListener('click', () => {
    window.alfy.storage.set('count', 1);
  });
</script>
</body></html>`;
		const browser = await chromium.launch();
		try {
			const result = await evaluateApp(browser, html, "storage-use", outDir);
			// The smoke test clicks the one enabled button, which calls
			// alfy.storage.set — proving the bootstrap mock is present before the
			// app's own script runs (it references window.alfy on page load's
			// listener registration, which only works if the mock landed first).
			expect(result.storageSets).toBeGreaterThan(0);
			expect(result.storageKeys).toContain("count");
			expect(result.interaction.clicked).toBe(true);
		} finally {
			await browser.close();
		}
	}, 30_000);

	it("writes one screenshot per of the four page runs", async () => {
		const html = `<!doctype html><html><body><p>hello</p></body></html>`;
		const browser = await chromium.launch();
		try {
			const result = await evaluateApp(browser, html, "screenshots", outDir);
			expect(result.pages).toHaveLength(4);
			expect(result.pages.map((p) => p.label).sort()).toEqual(
				["dark-1280", "dark-390", "light-1280", "light-390"].sort(),
			);
			for (const page of result.pages) {
				expect(page.screenshot).toMatch(/^shot-screenshots-.*\.png$/);
			}
		} finally {
			await browser.close();
		}
	}, 30_000);
});
