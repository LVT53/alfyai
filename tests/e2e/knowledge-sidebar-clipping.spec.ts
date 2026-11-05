// The sidebar and the Knowledge page at narrow widths, where the sidebar's
// Knowledge icon and the page's controls were once cut off (Task 9b).
//
// Measured, not eyeballed: every control in the sidebar and on the Knowledge
// page, and every icon in one, must lie wholly inside the boxes that clip it
// (`clipping-probe.ts`), at device pixel ratios 1 and 1.25 (a desktop at 125 %
// scaling), in the sidebar's collapsed rail and at its narrowest width.
//
// CLIPPING_SHOTS=<dir> also writes a screenshot of every state measured.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
	cleanUpConversation,
	seedDocument,
	TITLE,
} from "./artifact-download-helpers";
import { findClippedControls } from "./clipping-probe";

const SHOTS = process.env.CLIPPING_SHOTS;
const SIZES = [
	{ width: 1440, height: 900 },
	{ width: 1280, height: 720 },
	// The narrowest desktop layout.
	{ width: 1024, height: 768 },
];
const RATIOS = [1, 1.25];
/** The sidebar's two narrow states: the icon rail, and dragged to its minimum. */
const SIDEBARS = [
	{ name: "collapsed", collapsed: true, width: 48 },
	{ name: "narrowest", collapsed: false, width: 240 },
] as const;
/** The sidebar as it opens by default. */
const DEFAULT_SIDEBAR = { name: "default", collapsed: false, width: 300 };
type Sidebar = { name: string; collapsed: boolean; width: number };
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
async function openKnowledge(page: Page, baseURL: string, sidebar: Sidebar) {
	await page.goto(`${baseURL}/knowledge`, { waitUntil: "domcontentloaded" });
	await page.evaluate(({ collapsed, width }) => {
		localStorage.setItem("sidebarCollapsed", String(collapsed));
		localStorage.setItem("sidebarOpen", "true");
		localStorage.setItem("sidebarWidth", String(collapsed ? 240 : width));
	}, sidebar);
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.waitForSelector("#svelte-announcer", { state: "attached" });
	await page.evaluate(() => document.fonts.ready);
	const panel = page.locator("aside.sidebar-panel");
	await expect
		.poll(async () => (await panel.boundingBox())?.width)
		.toBe(sidebar.width);
	await expect(page.locator("tbody tr").first()).toBeVisible();
	// The sidebar's width animates; measure the layout it settles on. Only
	// what ends is waited for: a row still being read shows a spinner that
	// turns for as long as the document service is away (as it is in e2e), and
	// it moves nothing.
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					document
						.getAnimations()
						.filter(
							(animation) =>
								animation.effect?.getComputedTiming().endTime !== Infinity,
						).length,
			),
		)
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
	// Longer than the window, as the library is wherever other specs ran first
	// on this worker's database: rows below the fold are scrolled, not clipped.
	const fillers = Array.from({ length: 8 }, (_, i) => `Filler ${i + 1}`);
	for (const title of [TITLE, `${TITLE} (szombat–vasárnap)`, ...fillers]) {
		const { conversationId } = await seedDocument({ title });
		seeded.push(conversationId);
	}
});
test.afterAll(async () => {
	for (const conversationId of seeded.splice(0)) {
		await cleanUpConversation(conversationId);
	}
});

test.describe("The sidebar and the Knowledge page at narrow widths", () => {
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

	// The Knowledge column is a border box whose padding is named once
	// (`--column-pad`): on a wide screen its content is still 65rem (1040 px)
	// with 2rem either side, and in a narrow one it is its scroller's width.
	test("the Knowledge column keeps its 1040 px content on a wide screen and its scroller's width on a narrow one", async ({
		browser,
		baseURL,
	}) => {
		const context = await browser.newContext({
			viewport: { width: 1440, height: 900 },
		});
		try {
			const page = await context.newPage();
			await logIn(page, baseURL as string);
			const column = () =>
				page
					.locator(".main-content > div")
					.first()
					.evaluate((element) => {
						const style = getComputedStyle(element);
						const padding = Number.parseFloat(style.paddingLeft);
						return {
							padding,
							content: element.clientWidth - 2 * padding,
							outer: element.getBoundingClientRect().width,
							scroller: (element.parentElement as HTMLElement).clientWidth,
						};
					});
			await openKnowledge(page, baseURL as string, SIDEBARS[0]);
			expect(await column()).toMatchObject({ padding: 32, content: 1040 });
			await page.setViewportSize({ width: 1024, height: 768 });
			await openKnowledge(page, baseURL as string, SIDEBARS[1]);
			const narrow = await column();
			expect(narrow.padding).toBe(32);
			expect(narrow.outer).toBe(narrow.scroller);
		} finally {
			await context.close();
		}
	});

	// The search pill gives way at the narrowest sidebar by dropping its Ctrl+K
	// chip (a size container, 7.5rem); the chip must still show by default.
	test("the search pill shows its shortcut chip at the default sidebar width and drops it at the narrowest", async ({
		browser,
		baseURL,
	}) => {
		const context = await browser.newContext({
			viewport: { width: 1280, height: 720 },
		});
		try {
			const page = await context.newPage();
			await logIn(page, baseURL as string);
			const chip = page.getByTestId("search-shortcut-hint");
			await openKnowledge(page, baseURL as string, DEFAULT_SIDEBAR);
			await expect(chip).toBeVisible();
			await openKnowledge(page, baseURL as string, SIDEBARS[1]);
			await expect(chip).toBeHidden();
			await expect(
				page.getByRole("button", { name: "Search conversations" }),
			).toContainText("Search");
		} finally {
			await context.close();
		}
	});
});
