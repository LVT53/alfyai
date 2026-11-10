import { expect, type Locator, type Page, test } from "@playwright/test";
import { SPOTLIGHT_IDS, type SpotlightId } from "../../src/lib/app-places";
import {
	GUIDE_ENTRIES,
	GUIDE_SECTION_IDS,
} from "../../src/lib/components/guide/guide-content";
import { createConversation as createServerConversation } from "../../src/lib/server/services/conversations";
import { createMessage } from "../../src/lib/server/services/messages";
import { createTourUser } from "./artifact-tours-helpers";
import {
	clearAdminConfig,
	ensureSidebarExpanded,
	login,
	waitForHydration,
} from "./helpers";

// The Feature Guide (`/guide`, "What AlfyAI can do"), end to end: the three ways
// in, Try it, every Show me, the page at phone width in both languages, the
// keyboard and the dark theme. What the page is made of, and the rules this spec
// holds it to: src/lib/components/guide/AGENTS.md.

const GUIDE_TITLE = "What AlfyAI can do";
const GUIDE_TITLE_HU = "Amit az AlfyAI tud";
const SECTION_NAMES = [
	"Ask",
	"Make",
	"It knows you",
	"Your things",
	"Stay organized",
	"Your account",
];
const MAPS_EXAMPLE =
	"How do I get from Keleti station to the airport by public transport?";

/** Goes to the guide the way a reload or a bookmark does, and waits until it is alive. */
async function openGuide(page: Page, title = GUIDE_TITLE) {
	await page.goto("/guide", { waitUntil: "domcontentloaded" });
	await waitForHydration(page);
	await expect(
		page.getByRole("heading", { level: 1, name: title }),
	).toBeVisible();
}

// ---------------------------------------------------------------------------
// Seeing a ring from inside the page.
//
// A Show me rings its control for two seconds. A test that samples the class
// from outside (`toHaveClass`) meets the ring only if one of its polls lands
// inside that window, and the runner shares a machine with five other workers
// and vitest. So the page watches itself: this recorder is installed before any
// script of every document, notes each element that gains `spotlight-ring` and
// when it loses it, and 1.5 s into the ring (`checkAtMs`) looks at what the
// person would see: is the class still on, what is the computed box-shadow (the
// cascade, which jsdom never ran), and is the control the topmost thing at its
// own centre (not off screen in a shut drawer, not under another layer). Its
// timer is set after the ring's own, for an earlier moment, so it fires first
// even in a starved renderer.
// ---------------------------------------------------------------------------

type RingRecord = {
	el: Element;
	on: number;
	off: number | null;
	checked: { still: boolean; shadow: string; seen: boolean } | null;
};
type RingWindow = Window & { __rings?: RingRecord[] };

const RING_CLASS = "spotlight-ring";
/** `SPOTLIGHT_RING_MS` in src/lib/actions/spotlight.ts. */
const RING_MS = 2000;
const RING_CHECK_AT_MS = 1500;

/** Runs in the page, so it names nothing from this file but what it is given. */
function installRingRecorder({
	ringClass,
	checkAtMs,
}: {
	ringClass: string;
	checkAtMs: number;
}) {
	const win = window as RingWindow;
	if (win.__rings) return;
	const log: RingRecord[] = [];
	const wearing = new Map<Element, RingRecord>();
	win.__rings = log;
	new MutationObserver((mutations) => {
		const changed = new Set<Element>();
		for (const mutation of mutations) changed.add(mutation.target as Element);
		for (const el of changed) {
			const has = el.classList.contains(ringClass);
			const record = wearing.get(el);
			if (has && !record) {
				const started: RingRecord = {
					el,
					on: performance.now(),
					off: null,
					checked: null,
				};
				log.push(started);
				wearing.set(el, started);
				setTimeout(() => {
					const box = el.getBoundingClientRect();
					const hit = document.elementFromPoint(
						box.left + box.width / 2,
						box.top + box.height / 2,
					);
					started.checked = {
						still: el.classList.contains(ringClass),
						shadow: getComputedStyle(el).boxShadow,
						seen: hit !== null && el.contains(hit),
					};
				}, checkAtMs);
			} else if (!has && record) {
				record.off = performance.now();
				wearing.delete(el);
			}
		}
	}).observe(document, {
		subtree: true,
		attributes: true,
		attributeFilter: ["class"],
	});
}

async function recordRings(page: Page) {
	await page.addInitScript(installRingRecorder, {
		ringClass: RING_CLASS,
		checkAtMs: RING_CHECK_AT_MS,
	});
}

/** Waits for the first ring to come on, then hands back the element that wears it. */
async function firstRinging(page: Page) {
	await page.waitForFunction(
		() => ((window as RingWindow).__rings?.length ?? 0) > 0,
		undefined,
		{ timeout: 20_000 },
	);
	return page.evaluateHandle(() => (window as RingWindow).__rings?.[0]?.el);
}

/** Waits until every ring that came on has been looked at and has gone out. */
async function ringsThatHaveEnded(page: Page) {
	await page.waitForFunction(
		() =>
			((window as RingWindow).__rings ?? []).every(
				(ring) => ring.off !== null && ring.checked !== null,
			),
		undefined,
		{ timeout: 15_000 },
	);
	return page.evaluate(() =>
		((window as RingWindow).__rings ?? []).map(({ on, off, checked }) => ({
			on,
			off,
			checked,
		})),
	);
}

// ---------------------------------------------------------------------------
// The eighteen Show me rows: the row, the control it rings, and where that is.
//
// A Show me whose control moves keeps its marker, so it keeps ringing; a Show me
// added to the guide without a line here fails the first test below.
// ---------------------------------------------------------------------------

/**
 * Where the person is. `narrow` is a window under 1024 px: the sidebar is a
 * drawer and the header has the mask button (Home's own is `display: none`).
 * `rail` is a desktop sidebar folded to its icon rail, which is how a new
 * visitor's sidebar starts.
 */
type Where = { narrow: boolean; rail: boolean };

type ShowMeRow = {
	/** The entry's id in guide-content.ts. */
	entry: string;
	/** What the row is called: its button is "Show me: <name>". */
	name: string;
	spotlight: SpotlightId;
	/** The real control, as the person finds it. */
	control: (page: Page, where: Where) => Locator;
};

const settingsRowWith = (page: Page, testId: string) =>
	page.locator(".settings-row").filter({ has: page.getByTestId(testId) });

const SHOW_ME: readonly ShowMeRow[] = [
	{
		entry: "askAnything",
		name: "Ask anything",
		spotlight: "composer.thinking",
		control: (page) => page.getByTestId("thinking-bar-toggle"),
	},
	{
		entry: "pictureOrFile",
		name: "Show it a picture or a file",
		spotlight: "composer.attach",
		control: (page) => page.getByTestId("composer-menu-attach"),
	},
	{
		entry: "atlasResearch",
		name: "Atlas research",
		spotlight: "composer.atlas",
		control: (page) => page.getByTestId("composer-menu-atlas"),
	},
	{
		entry: "memory",
		name: "Memory",
		spotlight: "knowledge.memory",
		control: (page) => page.locator("#memory-profile-tab"),
	},
	{
		entry: "instructions",
		name: "Instructions",
		spotlight: "settings.instructions",
		control: (page) => settingsRowWith(page, "personal-instructions-open"),
	},
	{
		entry: "styleAndModel",
		name: "Style and model",
		spotlight: "settings.style",
		control: (page) => page.getByTestId("settings-style-group"),
	},
	{
		entry: "skills",
		name: "Skills",
		spotlight: "settings.skills",
		control: (page) => settingsRowWith(page, "skills-summary-card"),
	},
	{
		entry: "knowledgeBase",
		name: "Knowledge Base",
		spotlight: "knowledge.library",
		control: (page) => page.locator("#documents-tab"),
	},
	{
		entry: "useADocument",
		name: "Use a document in a chat",
		spotlight: "composer.library",
		control: (page) => page.getByTestId("composer-menu-library"),
	},
	{
		entry: "connectedAccounts",
		name: "Connected accounts",
		spotlight: "settings.connections",
		control: (page) => page.getByTestId("connections-heading"),
	},
	{
		entry: "projects",
		name: "Projects",
		spotlight: "sidebar.projects",
		control: (page) => page.getByTestId("sidebar-projects-header"),
	},
	{
		entry: "search",
		name: "Search",
		spotlight: "sidebar.search",
		control: (page, where) =>
			where.rail
				? page
						.locator(".collapsed-rail")
						.getByRole("button", { name: "Search conversations and documents" })
				: page.locator("aside .search-pill"),
	},
	{
		entry: "incognito",
		name: "Incognito",
		spotlight: "home.incognito",
		// Two buttons answer to one id; only the one with layout is on screen.
		control: (page, where) =>
			page.getByTestId(where.narrow ? "incognito-arm-phone" : "incognito-arm"),
	},
	{
		entry: "home",
		name: "Home",
		spotlight: "home.home",
		control: (page) => page.locator(".home-band"),
	},
	{
		entry: "languageAndLook",
		name: "Language and look",
		spotlight: "settings.language",
		control: (page) => page.getByRole("group", { name: "Interface language" }),
	},
	{
		entry: "twoStep",
		name: "Two-step sign-in",
		spotlight: "settings.twoStep",
		control: (page) => page.getByTestId("two-step-row"),
	},
	{
		entry: "yourData",
		name: "Your data",
		spotlight: "settings.data",
		control: (page) => page.locator("#settings-section-data-privacy"),
	},
	{
		entry: "yourActivity",
		name: "Your activity",
		spotlight: "settings.activity",
		control: (page) => page.locator("#settings-section-your-activity"),
	},
];

function showMeRow(spotlight: SpotlightId): ShowMeRow {
	const row = SHOW_ME.find((entry) => entry.spotlight === spotlight);
	if (!row) throw new Error(`no Show me row for ${spotlight}`);
	return row;
}

/**
 * Presses a row's Show me on the guide and checks what the person would see:
 * the ring is on the control (and on nothing else), it is drawn (a computed
 * box-shadow, not "none"), it is where the person can see it, and it lasts its
 * two seconds. Returns the control, for a check of what the ring left behind.
 */
async function expectShowMeRings(
	page: Page,
	row: ShowMeRow,
	where: Where,
): Promise<Locator> {
	await openGuide(page);
	const control = row.control(page, where);
	await page.getByRole("button", { name: `Show me: ${row.name}` }).click();

	const ringing = await firstRinging(page);
	await expect(
		control,
		`${row.spotlight}: the control Show me points at is on the page`,
	).toHaveCount(1);
	expect(
		await control.evaluate((node, ring) => node === ring, ringing),
		`${row.spotlight}: the ring is on the control Show me points at`,
	).toBe(true);
	// Not a control drawn disabled (the Atlas row without its key).
	await expect(
		control,
		`${row.spotlight}: the control is enabled`,
	).toBeEnabled();

	const rings = await ringsThatHaveEnded(page);
	expect(rings, `${row.spotlight}: only that control rang`).toHaveLength(1);
	const [{ on, off, checked }] = rings;
	expect(checked?.still, `${row.spotlight}: still ringing at 1.5 s`).toBe(true);
	expect(checked?.shadow, `${row.spotlight}: the ring is drawn`).toBeTruthy();
	expect(checked?.shadow, `${row.spotlight}: the ring is drawn`).not.toBe(
		"none",
	);
	expect(checked?.seen, `${row.spotlight}: the person can see it`).toBe(true);
	// A timer never fires early, so a ring that goes out sooner than its two
	// seconds was cut short (a class attribute written again while it was on).
	expect(
		(off ?? 0) - on,
		`${row.spotlight}: ms the ring lasted`,
	).toBeGreaterThanOrEqual(RING_MS - 100);
	return control;
}

/**
 * The configuration the Show me rows lean on. The Atlas row is drawn disabled
 * without a search key, and a disabled row is not the control a person is sent
 * to, so the key is set here and taken away afterwards. Nothing else needs
 * setting: the Thinking button is there because the built-in model has
 * reasoning controls, and the Skills row has its button because the command
 * registry is on unless an admin turns it off (`COMPOSER_COMMAND_REGISTRY_ENABLED`).
 */
const GUIDE_CONFIG_KEYS = ["ATLAS_WORKER_ENABLED", "PARALLEL_API_KEY"];

async function makeAtlasAvailable(page: Page) {
	const response = await page.request.put("/api/admin/config", {
		data: {
			ATLAS_WORKER_ENABLED: "true",
			PARALLEL_API_KEY: "fake-feature-guide-key",
		},
	});
	expect(response.ok(), `admin config -> ${response.status()}`).toBe(true);
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

test.describe("the Feature Guide: what it lists", () => {
	test("the table of Show me rows below is the guide's own list", () => {
		const fromGuide = GUIDE_ENTRIES.flatMap((entry) =>
			entry.action.kind === "showMe"
				? [{ entry: entry.id, spotlight: entry.action.spotlight }]
				: [],
		);
		expect(
			SHOW_ME.map(({ entry, spotlight }) => ({ entry, spotlight })),
			"a Show me row in the guide needs a line in SHOW_ME",
		).toEqual(fromGuide);
		expect(
			SHOW_ME.map((row) => row.spotlight).sort(),
			"every control Show me can ring",
		).toEqual([...SPOTLIGHT_IDS].sort());
		expect(GUIDE_SECTION_IDS).toHaveLength(SECTION_NAMES.length);
	});
});

test.describe("the Feature Guide: the ways in", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("the ? beside the version badge opens the guide", {
		tag: "@smoke",
	}, async ({ page }) => {
		await ensureSidebarExpanded(page);
		await page
			.locator(".sidebar-header")
			.getByRole("button", { name: GUIDE_TITLE })
			.click();

		await expect(page).toHaveURL(/\/guide$/);
		await expect(
			page.getByRole("heading", { level: 1, name: GUIDE_TITLE }),
		).toBeVisible();
		await expect(
			page.getByTestId("guide-section").getByRole("heading", { level: 2 }),
		).toHaveText(SECTION_NAMES);
		await expect(page.getByTestId("guide-row")).toHaveCount(30);
	});

	test("the collapsed rail and the phone menu open it too", async ({
		page,
	}) => {
		await ensureSidebarExpanded(page);
		await page.getByRole("button", { name: "Collapse sidebar" }).click();
		await page
			.locator(".collapsed-rail")
			.getByRole("button", { name: GUIDE_TITLE })
			.click();
		await expect(page).toHaveURL(/\/guide$/);
		await expect(
			page.getByRole("heading", { level: 1, name: GUIDE_TITLE }),
		).toBeVisible();

		// A phone: the "?" is a row of the header's user menu.
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto("/", { waitUntil: "domcontentloaded" });
		await waitForHydration(page);
		await page.locator('button[aria-label="Open user menu"]').click();
		const menu = page.locator(".header-menu");
		await expect(menu).toBeVisible();
		// Scoped to the menu: the shut drawer has a "?" of its own.
		await menu.getByRole("button", { name: GUIDE_TITLE }).click();

		await expect(page).toHaveURL(/\/guide$/);
		await expect(menu).toHaveCount(0);
		await expect(
			page.getByRole("heading", { level: 1, name: GUIDE_TITLE }),
		).toBeVisible();
	});
});

test.describe("the Feature Guide: Try it", () => {
	// A throwaway user: a saved Home draft (words, a file, Atlas mode) of the
	// shared admin would change what Try it does, and would outlive the test.
	test("Try it puts the example in the Home box and sends nothing", async ({
		page,
	}) => {
		const user = await createTourUser("en");
		await login(page, user.email, user.password);
		const sent: string[] = [];
		page.on("request", (request) => {
			const { pathname } = new URL(request.url());
			if (pathname === "/api/chat/stream") sent.push(pathname);
		});

		await openGuide(page);
		await page.getByRole("button", { name: "Try it: Maps and travel" }).click();

		await expect(page).toHaveURL(/\/$/);
		const box = page.getByTestId("message-input");
		await expect(box).toHaveValue(MAPS_EXAMPLE);
		// The caret is in it, so the person can change the words first.
		await expect(box).toBeFocused();
		// Nothing was sent: still Home, and no turn was started.
		await expect(page).toHaveURL(/\/$/);
		expect(sent, "requests to the chat stream").toEqual([]);
	});

	test("Try it keeps an unsent Home draft", async ({ page }) => {
		const user = await createTourUser("en");
		await login(page, user.email, user.password);
		const box = page.getByTestId("message-input");
		const saved = page.waitForResponse(
			(response) =>
				/^\/api\/conversations\/[^/]+\/draft$/.test(
					new URL(response.url()).pathname,
				) && response.request().method() === "PUT",
		);
		await box.fill("my words");
		await saved;

		await ensureSidebarExpanded(page);
		await page
			.locator(".sidebar-header")
			.getByRole("button", { name: GUIDE_TITLE })
			.click();
		await expect(page).toHaveURL(/\/guide$/);
		await page.getByRole("button", { name: "Try it: Maps and travel" }).click();

		await expect(page).toHaveURL(/\/$/);
		// The toast is what tells that the example was left out; after it nothing
		// else writes to the box.
		await expect(page.getByTestId("toast-entry")).toContainText(
			"Your unsent message is still in the box, so the example was not added.",
		);
		await expect(box).toHaveValue("my words");
	});
});

test.describe("the Feature Guide: every Show me rings its control", () => {
	test.beforeEach(async ({ page }) => {
		await recordRings(page);
		// A throwaway admin (the Atlas key is an admin setting): its model, language
		// and Home are the defaults, whatever an earlier spec on this worker did to
		// the shared one.
		const admin = await createTourUser("en", "admin");
		await login(page, admin.email, admin.password);
		await makeAtlasAvailable(page);
	});

	test.afterEach(async ({ page }) => {
		await clearAdminConfig(page, GUIDE_CONFIG_KEYS);
	});

	for (const row of SHOW_ME) {
		test(`${row.spotlight}: Show me ${row.name}`, async ({ page }) => {
			await ensureSidebarExpanded(page);
			await expectShowMeRings(page, row, { narrow: false, rail: false });
		});
	}

	// A new visitor's sidebar is the rail (`sidebarCollapsed` starts true): Search
	// rings the rail's own button and leaves the rail alone, Projects has no row on
	// the rail, so the sidebar opens for it.
	test("sidebar.search on the collapsed rail", async ({ page }) => {
		await expect(
			page.getByRole("button", { name: "Expand sidebar" }),
		).toBeVisible();
		await expectShowMeRings(page, showMeRow("sidebar.search"), {
			narrow: false,
			rail: true,
		});
		await expect(
			page.getByRole("button", { name: "Expand sidebar" }),
			"Search leaves the rail as it was",
		).toBeVisible();
	});

	test("sidebar.projects on the collapsed rail opens the sidebar", async ({
		page,
	}) => {
		await expect(
			page.getByRole("button", { name: "Expand sidebar" }),
		).toBeVisible();
		await expectShowMeRings(page, showMeRow("sidebar.projects"), {
			narrow: false,
			rail: true,
		});
		await expect(
			page.getByRole("button", { name: "Collapse sidebar" }),
		).toBeVisible();
	});

	test.describe("on a phone", () => {
		test.use({ viewport: { width: 390, height: 844 } });

		for (const spotlight of [
			"sidebar.search",
			"sidebar.projects",
			"home.incognito",
			"composer.atlas",
		] as const) {
			test(`${spotlight} at 390 px`, async ({ page }) => {
				await expectShowMeRings(page, showMeRow(spotlight), {
					narrow: true,
					rail: false,
				});
			});
		}
	});
});

/** What is scrolled on the way from `control` up to the page, as "tag.class (x, y)". */
async function scrolledAbove(control: Locator): Promise<string[]> {
	return control.evaluate((node) => {
		const scrolled: string[] = [];
		for (let el = node.parentElement; el; el = el.parentElement) {
			if (el.scrollTop !== 0 || el.scrollLeft !== 0) {
				scrolled.push(
					`${el.tagName.toLowerCase()}.${el.getAttribute("class") ?? ""} (${el.scrollLeft}, ${el.scrollTop})`,
				);
			}
		}
		return scrolled;
	});
}

test.describe("the Feature Guide: Show me on Home at a short window", () => {
	// `.chat-stage` is `overflow: hidden`: nothing the person does can scroll it, so
	// a scrollIntoView that moved it would leave Home shifted until a reload.
	// Chats make Home's board tall enough for a short window to matter.
	for (const size of [
		{ width: 1280, height: 560 },
		{ width: 844, height: 390 },
	]) {
		test(`leaves Home's stage unscrolled at ${size.width}x${size.height}`, async ({
			page,
		}) => {
			const user = await createTourUser("en");
			for (let index = 0; index < 12; index++) {
				const chat = await createServerConversation(
					user.id,
					`A chat to fill the board ${index}`,
				);
				await createMessage(chat.id, "user", `Question ${index}`);
				await createMessage(chat.id, "assistant", `Answer ${index}`);
			}
			await page.setViewportSize(size);
			await recordRings(page);
			await login(page, user.email, user.password);
			const narrow = size.width < 1024;

			for (const spotlight of [
				"composer.thinking",
				"home.incognito",
				"home.home",
			] as const) {
				const control = await expectShowMeRings(page, showMeRow(spotlight), {
					narrow,
					rail: false,
				});
				await expect(page.getByTestId("home-board")).toBeVisible();
				expect(
					await scrolledAbove(control),
					`${spotlight}: what is left scrolled around the control`,
				).toEqual([]);
			}
		});
	}
});

// ---------------------------------------------------------------------------
// The page at phone width: nothing wider than the screen, and a tap lights.
// ---------------------------------------------------------------------------

/** A box from Playwright is in viewport coordinates, so "inside" is a plain comparison. */
function expectInside(
	box: { x: number; y: number; width: number; height: number } | null,
	size: { width: number; height: number } | null,
	what: string,
) {
	expect(box, `${what}: has a box`).not.toBeNull();
	expect(size, "the viewport").not.toBeNull();
	if (!box || !size) return;
	expect(box.x, `${what}: left edge`).toBeGreaterThanOrEqual(0);
	expect(box.y, `${what}: top edge`).toBeGreaterThanOrEqual(0);
	expect(box.x + box.width, `${what}: right edge`).toBeLessThanOrEqual(
		size.width,
	);
	expect(box.y + box.height, `${what}: bottom edge`).toBeLessThanOrEqual(
		size.height,
	);
}

/**
 * The guide's own scroller and its six drawings do not scroll sideways, and a
 * tap on a row lights its spot with the drawing in view (a row with no spot lights
 * nothing). A finger's pointerenter and pointerleave are ignored by design, so
 * only a real tap (a context with touch) lights a row.
 */
async function expectGuideHoldsTogether(page: Page, title: string) {
	await openGuide(page, title);
	const size = page.viewportSize();

	const scroller = page.getByTestId("guide-scroller");
	expect(
		await scroller.evaluate((node) => node.scrollWidth - node.clientWidth),
		"px the guide's scroller is wider than itself",
	).toBeLessThanOrEqual(0);
	const frames = page.getByTestId("drawing-frame");
	await expect(frames).toHaveCount(6);
	expect(
		await frames.evaluateAll((nodes) =>
			Math.max(...nodes.map((node) => node.scrollWidth - node.clientWidth)),
		),
		"px the widest drawing is wider than its frame",
	).toBeLessThanOrEqual(0);

	for (const entry of GUIDE_ENTRIES) {
		const row = page.locator(
			`[data-testid="guide-row"][data-entry-id="${entry.id}"]`,
		);
		const section = page.locator(`#guide-section-${entry.section}`);
		await row.locator("p").first().tap();

		if (entry.drawingSpot === null) {
			await expect(
				section.locator(".drawing-spot-lit"),
				`${entry.id} has no spot, so it lights nothing`,
			).toHaveCount(0);
			continue;
		}
		await expect
			.poll(
				() =>
					section
						.locator(".drawing-spot-lit")
						.evaluateAll((nodes) => [
							...new Set(nodes.map((n) => n.getAttribute("data-drawing-spot"))),
						]),
				{ message: `the spots lit by a tap on ${entry.id}` },
			)
			.toEqual([entry.drawingSpot]);
		expectInside(
			await section.getByTestId("drawing-frame").boundingBox(),
			size,
			`${entry.id}: the drawing`,
		);
		expectInside(
			await section
				.locator(`[data-drawing-spot="${entry.drawingSpot}"]`)
				.first()
				.boundingBox(),
			size,
			`${entry.id}: the spot ${entry.drawingSpot}`,
		);
	}
}

test.describe("the Feature Guide on a phone", () => {
	test.describe("Hungarian at 360 px", () => {
		test.use({ viewport: { width: 360, height: 780 }, hasTouch: true });

		test("Hungarian at 360 px holds together", async ({ page }) => {
			const user = await createTourUser("hu");
			await login(page, user.email, user.password);
			await expectGuideHoldsTogether(page, GUIDE_TITLE_HU);
		});
	});

	test.describe("English at 390 px", () => {
		test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

		test("English at 390 px holds together", async ({ page }) => {
			await login(page);
			await expectGuideHoldsTogether(page, GUIDE_TITLE);
		});
	});
});

// ---------------------------------------------------------------------------
// Keyboard and the dark theme
// ---------------------------------------------------------------------------

test.describe("the Feature Guide: keyboard and theme", () => {
	test("Tab onto a row's button lights its spot, and leaving puts it out", async ({
		page,
	}) => {
		await login(page);
		await openGuide(page);
		const lit = (spot: string) =>
			page.locator(
				`#guide-section-ask [data-drawing-spot="${spot}"].drawing-spot-lit`,
			);

		// From the last of the section chips, the next stop is the first row's button.
		await page.getByRole("link", { name: "Your account" }).focus();
		await page.keyboard.press("Tab");
		await expect(
			page.getByRole("button", { name: "Show me: Ask anything" }),
		).toBeFocused();
		await expect(lit("thinking").first()).toBeVisible();

		// The next row takes the light; one light at a time.
		await page.keyboard.press("Tab");
		await expect(
			page.getByRole("button", { name: "Try it: Web and links" }),
		).toBeFocused();
		await expect(lit("sources").first()).toBeVisible();
		await expect(lit("thinking")).toHaveCount(0);

		// Shift+Tab gives it back.
		await page.keyboard.press("Shift+Tab");
		await expect(lit("thinking").first()).toBeVisible();
		await expect(lit("sources")).toHaveCount(0);

		// Focus leaves the section's rows: nothing stays lit.
		await page.getByRole("link", { name: "Make" }).focus();
		await expect(
			page.locator("#guide-section-ask .drawing-spot-lit"),
		).toHaveCount(0);
	});

	// A throwaway user, whose theme is the default (follow the system): the shared
	// admin's saved theme is not this test's to depend on.
	test("dark mode: the drawings take the dark surface", async ({ page }) => {
		const user = await createTourUser("en");
		await login(page, user.email, user.password);
		await openGuide(page);
		const frame = page.getByTestId("drawing-frame").first();
		const frameBackground = () =>
			frame.evaluate((node) => getComputedStyle(node).backgroundColor);
		// What `--surface-elevated` is right now, as the browser writes a colour.
		const elevated = () =>
			page.evaluate(() => {
				const probe = document.createElement("div");
				probe.style.background = "var(--surface-elevated)";
				document.body.append(probe);
				const colour = getComputedStyle(probe).backgroundColor;
				probe.remove();
				return colour;
			});

		await expect(page.locator("html")).not.toHaveClass(/dark/);
		const light = await frameBackground();
		expect(light, "light: the frame is the elevated surface").toBe(
			await elevated(),
		);

		try {
			await page.emulateMedia({ colorScheme: "dark" });
			await expect(page.locator("html")).toHaveClass(/dark/);
			const dark = await elevated();
			expect(dark, "the dark surface is not the light one").not.toBe(light);
			await expect
				.poll(frameBackground, { message: "dark: the frame's background" })
				.toBe(dark);
		} finally {
			await page.emulateMedia({ colorScheme: "light" });
		}
		await expect(page.locator("html")).not.toHaveClass(/dark/);
		await expect.poll(frameBackground).toBe(light);
	});
});
