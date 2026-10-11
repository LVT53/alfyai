// Is the production build a working app? Asked once, before any test runs.
//
// A build can exit 0, pass its chunk check and still be broken: when `svelte-kit sync`
// (`npm run check`, or vitest starting) rewrites `.svelte-kit/` while `vite build` reads
// it, the app that comes out throws while it hydrates ("Cannot read properties of
// undefined (reading 'data')"), every input stays disabled, and an end-to-end run then
// spends most of an hour failing each test on a 15-second timeout. Measured on this
// branch (the release gate's first run). So the runner looks at the app itself first.
import type { Page } from "@playwright/test";

/** What a failed probe says: what was seen, and the one thing that most often causes it. */
export function hydrationFailure(
	baseUrl: string,
	pageErrors: string[],
): string {
	return [
		`[e2e] The production build does not start in a browser: ${baseUrl}/login never mounted its app${
			pageErrors.length > 0
				? `, and the page threw ${pageErrors.map((e) => `"${e}"`).join(", ")}`
				: " (no page error was seen either)"
		}.`,
		"      A build that exits 0 can still be broken like this when `svelte-kit sync` (`npm run check`, or vitest",
		"      starting) ran while `vite build` was reading `.svelte-kit/`. Run `npm run build` on its own, then again.",
		"      Every test would otherwise fail on a 15-second timeout.",
	].join("\n");
}

/**
 * The part of a Playwright page the probe uses, so a unit test can stand in for a
 * browser (`tests/integration/e2e-build-probe.test.ts`).
 */
export type ProbePage = Pick<Page, "on" | "goto" | "waitForSelector">;

/**
 * Loads the login page and waits for SvelteKit's root component to mount: it draws
 * `#svelte-announcer` in `onMount`, so the element is there exactly when hydration
 * worked. Throws `hydrationFailure` when it never is, or when the page threw on the
 * way (a throw can leave the element behind in a half-working page).
 */
export async function probeHydration(
	page: ProbePage,
	baseUrl: string,
	timeoutMs = 15_000,
): Promise<void> {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.goto(`${baseUrl}/login`, {
		waitUntil: "load",
		timeout: timeoutMs,
	});
	try {
		await page.waitForSelector("#svelte-announcer", {
			state: "attached",
			timeout: timeoutMs,
		});
	} catch {
		throw new Error(hydrationFailure(baseUrl, pageErrors));
	}
	if (pageErrors.length > 0) {
		throw new Error(hydrationFailure(baseUrl, pageErrors));
	}
}

/** Starts a browser for a second or two and asks `probeHydration`. */
export async function assertBuildHydrates(baseUrl: string): Promise<void> {
	// Loaded here, not at the top: the unit test of `probeHydration` imports this module
	// and needs no browser library.
	const { chromium } = await import("@playwright/test");
	const browser = await chromium.launch();
	try {
		await probeHydration(await browser.newPage(), baseUrl);
	} finally {
		await browser.close();
	}
}
