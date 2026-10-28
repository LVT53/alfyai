// Linux Vivaldi, the browser the owner saw the sidebar's Knowledge icon cut off
// in, and the Knowledge page's controls with it (Task 9b). It runs when the
// machine has Vivaldi (`/usr/bin/vivaldi-stable`, or VIVALDI_PATH) and skips
// cleanly otherwise; the same layout checks run in Playwright's own Chromium
// on every machine, so the fix is held where Vivaldi is not installed.
//
// Measured, not eyeballed: every control in the sidebar and on the Knowledge
// page, and every icon in one, must lie wholly inside the boxes that clip it
// (`clipping-probe.ts`), at device pixel ratios 1 and 1.25 (Linux's 125 %
// scaling), in the sidebar's collapsed rail and at its narrowest width.
//
// VIVALDI_SMOKE_SHOTS=<dir> also writes a screenshot of every state measured.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
	cleanUpConversation,
	seedDocument,
	TITLE,
} from "./artifact-download-helpers";
import { findClippedControls } from "./clipping-probe";
import { hasVivaldi, launchVivaldi, saveDownloadsTo } from "./vivaldi-browser";

const SHOTS = process.env.VIVALDI_SMOKE_SHOTS;
const SIZES = [
	{ width: 1440, height: 900 },
	{ width: 1280, height: 720 },
	// The narrowest desktop layout; also about what a 1366 px laptop window
	// leaves the page once Vivaldi's own Downloads panel opens beside it.
	{ width: 1024, height: 768 },
];
const RATIOS = [1, 1.25];
/** The sidebar's two narrow states: the icon rail, and dragged to its minimum. */
const SIDEBARS = [
	{ name: "collapsed", collapsed: true },
	{ name: "narrowest", collapsed: false },
] as const;
/** Straddles the sidebar's edge on purpose: it is the edge you drag. */
const ON_THE_EDGE = /"Resize sidebar"/;

async function logIn(page: Page, baseURL: string) {
	await page.goto(`${baseURL}/login`, { waitUntil: "domcontentloaded" });
	const status = await page.evaluate(async () => {
		const response = await fetch("/api/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "admin@local", password: "admin123" }),
		});
		return response.status;
	});
	expect(status, "the e2e admin logs in").toBe(200);
}

/** The Knowledge page with the sidebar as asked, fonts loaded and hydrated. */
async function openKnowledge(
	page: Page,
	baseURL: string,
	sidebar: (typeof SIDEBARS)[number],
) {
	await page.goto(`${baseURL}/knowledge`, { waitUntil: "domcontentloaded" });
	await page.evaluate((collapsed) => {
		localStorage.setItem("sidebarCollapsed", String(collapsed));
		localStorage.setItem("sidebarOpen", "true");
		localStorage.setItem("sidebarWidth", "240");
	}, sidebar.collapsed);
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.waitForSelector("#svelte-announcer", { state: "attached" });
	await page.evaluate(() => document.fonts.ready);
	const panel = page.locator("aside.sidebar-panel");
	await expect
		.poll(async () => (await panel.boundingBox())?.width)
		.toBe(sidebar.collapsed ? 48 : 240);
	await expect(page.locator("tbody tr").first()).toBeVisible();
	// The sidebar's width animates; measure the layout it settles on.
	await expect
		.poll(() => page.evaluate(() => document.getAnimations().length))
		.toBe(0);
}

/** What is clipped in the sidebar and on the page, as readable lines. */
async function clipped(page: Page): Promise<string[]> {
	const found = [
		...(await findClippedControls(page, "aside.sidebar-panel")),
		...(await findClippedControls(page, "main")),
	];
	return found
		.filter((item) => !ON_THE_EDGE.test(item.what))
		.map(
			(item) =>
				`${item.what} cut by ${item.by} ${JSON.stringify(
					Object.fromEntries(
						Object.entries(item.overflow)
							.filter(([, side]) => side > 0)
							.map(([side, px]) => [side, Math.round(px * 100) / 100]),
					),
				)}`,
		);
}

/** Every size, ratio and sidebar state on one page, the screenshots on request. */
async function measureEverywhere(
	label: string,
	open: (
		size: { width: number; height: number },
		ratio: number,
	) => Promise<{ page: Page; done: () => Promise<void> }>,
	baseURL: string,
	ratio: number,
) {
	const problems: string[] = [];
	for (const size of SIZES) {
		const { page, done } = await open(size, ratio);
		try {
			await logIn(page, baseURL);
			for (const sidebar of SIDEBARS) {
				await openKnowledge(page, baseURL, sidebar);
				const state = `${label} ${size.width}x${size.height}@${ratio} ${sidebar.name}`;
				if (SHOTS) {
					mkdirSync(SHOTS, { recursive: true });
					await page.screenshot({
						path: join(SHOTS, `${state.replaceAll(" ", "-")}.png`),
					});
				}
				for (const line of await clipped(page))
					problems.push(`${state}: ${line}`);
			}
		} finally {
			await done();
		}
	}
	expect(problems, "controls drawn outside their boxes").toEqual([]);
}

const seeded: string[] = [];
test.beforeAll(async () => {
	// A library with rows in it: the table's columns are part of what must fit.
	for (const suffix of ["", " (szombat–vasárnap)"]) {
		const { conversationId } = await seedDocument({
			title: `${TITLE}${suffix}`,
		});
		seeded.push(conversationId);
	}
});
test.afterAll(async () => {
	for (const conversationId of seeded.splice(0)) {
		await cleanUpConversation(conversationId);
	}
});

test.describe("Vivaldi on Linux", () => {
	test.skip(!hasVivaldi(), "Vivaldi is not installed on this machine");
	test.setTimeout(180_000);

	for (const ratio of RATIOS) {
		test(`the sidebar and the Knowledge page keep every control and icon inside its box at DPR ${ratio}`, async ({
			baseURL,
		}) => {
			await measureEverywhere(
				"vivaldi",
				async (size, deviceScaleFactor) => {
					const tab = await launchVivaldi({ ...size, deviceScaleFactor });
					return { page: tab.page, done: tab.close };
				},
				baseURL as string,
				ratio,
			);
		});
	}

	test("a Word file with an accented title and a Markdown note save under their names, with their extensions, at DPR 1.25", async ({
		baseURL,
	}) => {
		const tab = await launchVivaldi({
			width: 1440,
			height: 900,
			deviceScaleFactor: 1.25,
		});
		const dir = mkdtempSync(join(tmpdir(), "alfyai-vivaldi-downloads-"));
		try {
			const downloads = await saveDownloadsTo(tab.browser, dir);
			const { page } = tab;
			await logIn(page, baseURL as string);
			await openKnowledge(page, baseURL as string, SIDEBARS[0]);
			const title = `${TITLE} (szombat–vasárnap)`;
			const row = page
				.locator("tbody tr", { hasText: title })
				.filter({ has: page.locator(".col-type .type-artifact") });
			await expect(row).toHaveCount(1);

			for (const { item, extension, check } of [
				{
					item: "Word",
					extension: "docx",
					// A .docx is a zip.
					check: (bytes: Buffer) =>
						expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK"),
				},
				{
					item: "Markdown",
					extension: "md",
					check: (bytes: Buffer) =>
						expect(bytes.toString("utf8")).toContain("Szombat: Naschmarkt"),
				},
			]) {
				// Bounded, so a control the page has cut off fails here, by name.
				await row
					.getByTestId("artifact-row-download")
					.click({ timeout: 15_000 });
				const saved = downloads.next();
				await page
					.getByTestId("artifact-row-download-menu")
					.getByRole("menuitem", { name: item })
					.click({ timeout: 15_000 });
				const download = await saved;
				const expected = `${title}.${extension}`.normalize("NFC");
				expect(download.suggestedFilename.normalize("NFC")).toBe(expected);
				expect(download.savedAs.normalize("NFC")).toBe(expected);
				check(readFileSync(join(dir, download.savedAs)));
				// Vivaldi opens its Downloads panel beside the page on a new
				// download, and the page loses a quarter of its width (1440 to
				// about 1080 CSS px). The menu closes when the page resizes, so
				// the next one is opened once the panel is out.
				await expect
					.poll(
						() =>
							page.evaluate(async () => {
								// Settled: the same width two frames apart.
								const before = innerWidth;
								await new Promise((done) =>
									requestAnimationFrame(() => requestAnimationFrame(done)),
								);
								return before === innerWidth ? innerWidth : Infinity;
							}),
						{ message: "Vivaldi's Downloads panel opened beside the page" },
					)
					.toBeLessThan(1200);
			}

			// The Knowledge page, in what the panel left of the window.
			if (SHOTS) {
				await page.screenshot({
					path: join(SHOTS, "vivaldi-downloads-panel-open-1440x900@1.25.png"),
				});
			}
			expect(await clipped(page), "controls drawn outside their boxes").toEqual(
				[],
			);
		} finally {
			await tab.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

test.describe("Playwright's Chromium, the same measurements", () => {
	test.setTimeout(120_000);
	for (const ratio of RATIOS) {
		test(`the sidebar and the Knowledge page keep every control and icon inside its box at DPR ${ratio}`, async ({
			browser,
			baseURL,
		}) => {
			await measureEverywhere(
				"chromium",
				async (size, deviceScaleFactor) => {
					const context = await browser.newContext({
						viewport: size,
						deviceScaleFactor,
					});
					return {
						page: await context.newPage(),
						done: () => context.close(),
					};
				},
				baseURL as string,
				ratio,
			);
		});
	}
});
