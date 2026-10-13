#!/usr/bin/env tsx
// Takes the AlfyAI 2.2 first-run onboarding's screenshots (the deck's pictures) from a running
// production build whose scratch database `scripts/seed-campaign-2-2.ts` and
// `scripts/seed-onboarding-2-2.ts` have seeded.
//
//   CAMPAIGN_BASE_URL=http://127.0.0.1:5597 CAMPAIGN_OUT_DIR=./data/onboarding-2-2-shots \
//     npx tsx scripts/campaign-shots-onboarding-2-2.ts [hu] [en] [--only 3] [--deck]
//
// One picture per slide and per device, in each interface language, at the exact size the
// campaign takes (`create-release-campaign.ts`: 16:10 at 1600x1000 for a desktop crop, 9:16 at
// 1080x1920 for a phone crop). Nothing is resized afterwards: a desktop picture is a 16:10 region
// of the window, drawn at the device scale that makes the region 1600 pixels wide, and a phone
// picture is a 432x768 window at scale 2.5. Light theme, the server's own rendering, nothing drawn
// on top.
//
// The welcome is for a person who has never used AlfyAI, so the pictures come from two accounts of
// the sample: Bence, who has just signed up (an empty home page, the Settings page of a user who
// is not an administrator), and Anna, whose workspace has things in it (the sidebar, a chat that
// made a Document, an App and a board, the project page, a Document with a history, the Memory
// profile). Each scene names whose it is.
//
// A campaign slide has one desktop and one phone picture for both languages, so the deck is built
// from one language's set; the other is the same scenes in the other language, for a look and for
// an alternate deck. With `--deck` the pictures are also reduced to 256 colours (ImageMagick,
// which halves them and is not visible) and put where `docs/plans/onboarding-2.2/deck/slides.json`
// names them: `deck/` from the Hungarian set and `deck-en/` from the English one.

import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	type Browser,
	type BrowserContext,
	chromium,
	type Page,
} from "playwright";

const BASE_URL = process.env.CAMPAIGN_BASE_URL || "http://127.0.0.1:5597";
const OUT_DIR = resolve(
	process.env.CAMPAIGN_OUT_DIR || "./data/onboarding-2-2-shots",
);
const MANIFEST_PATH = resolve(
	process.env.CAMPAIGN_MANIFEST || "./data/campaign-onboarding-manifest.json",
);
const DECK_ROOT = resolve("docs/plans/onboarding-2.2");

// CAMPAIGN_PROBE=1 also saves each desktop scene as a whole window (for choosing the clip by eye).
const PROBE = process.env.CAMPAIGN_PROBE === "1";

const DESKTOP = { width: 1440, height: 900 };
// A large phone (432 CSS pixels wide, as a Pixel Pro or an iPhone Pro Max is): 9:16 at exactly 2.5x gives 1080x1920.
const PHONE = { width: 432, height: 768 };
const PHONE_SCALE = 2.5;
const DESKTOP_PICTURE = { width: 1600, height: 1000 };
const PHONE_PICTURE = { width: 1080, height: 1920 };

type Lang = "hu" | "en";
type Who = "anna" | "bence";

type Manifest = {
	timeZone: string;
	anna: { email: string; password: string };
	bence: { email: string; password: string };
	project: { id: string };
	conversations: { plan: string };
	conversationsMore: { menu: string };
};

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function settle(page: Page, ms = 1200): Promise<void> {
	await page.waitForLoadState("networkidle").catch(() => undefined);
	await page.waitForTimeout(ms);
	// The composer takes the focus when a page opens, and draws a ring for it.
	await page.evaluate(() => {
		(document.activeElement as HTMLElement | null)?.blur?.();
	});
	// And the pointer stays where the last click was, hovering whatever is there now.
	const size = page.viewportSize();
	if (size) await page.mouse.move(size.width - 2, size.height - 2);
	await page.waitForTimeout(250);
}

async function openHome(page: Page): Promise<void> {
	await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
	await page
		.getByTestId("home-greeting")
		.waitFor({ state: "visible", timeout: 20000 });
}

async function openChat(page: Page, conversationId: string): Promise<void> {
	await page.goto(`${BASE_URL}/chat/${conversationId}`, {
		waitUntil: "domcontentloaded",
	});
	await page
		.getByTestId("assistant-message")
		.first()
		.waitFor({ state: "visible", timeout: 20000 });
}

/** Opens the panel on the item whose title is `title`: through the header's count button and the list. */
async function openItem(
	page: Page,
	title: RegExp,
	phone: boolean,
): Promise<void> {
	await page
		.getByTestId(
			phone ? "artifact-count-button-compact" : "artifact-count-button",
		)
		.click();
	const list = page.getByTestId(
		phone ? "artifact-panel-list-mobile" : "artifact-panel-list",
	);
	await list
		.getByTestId("artifact-row")
		.filter({ hasText: title })
		.first()
		.click();
}

async function openHistory(page: Page): Promise<void> {
	await page
		.locator('[data-testid="artifact-history-button"]:visible')
		.first()
		.click();
	await page
		.getByTestId("history-option")
		.first()
		.waitFor({ state: "visible", timeout: 20000 });
	// The one-time line about Cmd+Z is dismissed the way a reader dismisses it.
	const dismiss = page.locator('[data-testid="history-help"] .help-dismiss');
	if (await dismiss.isVisible().catch(() => false)) await dismiss.click();
}

/** The phone's header menu button: the sidebar is a drawer there. */
async function openPhoneSidebar(page: Page): Promise<void> {
	await page
		.getByRole("button", {
			name: /^(Oldalsáv ki\/bekapcsolása|Toggle sidebar)$/,
		})
		.first()
		.click();
	await page.waitForTimeout(700);
}

/** Types the query into the search box (on a phone the box is not focused for you: that would raise the keyboard). */
async function typeInSearch(page: Page): Promise<void> {
	const box = page.getByRole("textbox", {
		name: /^(Keresés a munkaterületen|Search conversations and documents)$/,
	});
	await box.click();
	await box.fill(SEARCH_QUERY);
}

/** Brings the first element whose text matches to the top of its scroller. */
async function scrollTextToTop(page: Page, text: RegExp): Promise<void> {
	await page
		.getByText(text)
		.first()
		.evaluate((element) => element.scrollIntoView({ block: "start" }));
	await page.waitForTimeout(500);
}

const MENU = /Heti menü/;
const NAMED_MENU_VERSION = "Mielőtt bevásárolok";
const SEARCH_QUERY = "szállás";
const DATA_HEADING = /^(Adatok és adatvédelem|Data & privacy)$/;

// ---------------------------------------------------------------------------
// The scenes: what each slide shows, on a desktop window and on a phone
// ---------------------------------------------------------------------------

/** `y` may be read from the page once it is laid out (a scrolled page is not where a number would put it). */
type DesktopClip = {
	x: number;
	y: number | ((page: Page) => Promise<number>);
	height: number;
};

type Scene = {
	id: number;
	name: string;
	who: Who;
	desktop: {
		viewport?: { width: number; height: number };
		/** The 16:10 region of the window the picture is: its width is 1.6 times its height. */
		clip: DesktopClip;
		prepare: (page: Page, lang: Lang) => Promise<void>;
	};
	phone: { who?: Who; prepare: (page: Page, lang: Lang) => Promise<void> };
};

const SCENES: Scene[] = [
	{
		// 1. Welcome: the home page of a person who has just signed up.
		id: 1,
		name: "welcome",
		who: "bence",
		desktop: {
			clip: { x: 350, y: 215, height: 500 },
			prepare: async (page) => {
				await openHome(page);
				await settle(page, 1500);
			},
		},
		phone: {
			prepare: async (page) => {
				await openHome(page);
				await settle(page, 1500);
			},
		},
	},
	{
		// 2. Finding your way: the sidebar with everything it holds.
		id: 2,
		name: "map",
		who: "anna",
		desktop: {
			// Wide, so the home page's greeting stands to the right of what is cut.
			viewport: { width: 1800, height: 900 },
			clip: { x: 0, y: 0, height: 375 },
			prepare: async (page) => {
				await openHome(page);
				const logo = page.getByTestId("sidebar-logo");
				if (
					/kibontása|Expand/i.test(
						(await logo.getAttribute("aria-label")) ?? "",
					)
				) {
					await logo.click();
				}
				await page
					.getByText(/^(Projektek|Projects)$/i)
					.first()
					.waitFor({ state: "visible", timeout: 20000 });
				await settle(page, 1500);
			},
		},
		phone: {
			prepare: async (page) => {
				await openHome(page);
				await openPhoneSidebar(page);
				await settle(page, 1200);
			},
		},
	},
	{
		// 3. The first question: the box, and the "+" menu behind it (model, style, thinking, files).
		id: 3,
		name: "ask",
		who: "bence",
		desktop: {
			clip: { x: 350, y: 160, height: 400 },
			prepare: async (page) => {
				await openHome(page);
				await page.getByTestId("composer-tools-trigger").click();
				await page.waitForTimeout(800);
				await settle(page, 800);
			},
		},
		phone: {
			prepare: async (page) => {
				await openHome(page);
				await page.getByTestId("composer-tools-trigger").click();
				await page.waitForTimeout(900);
				// The sheet's first row takes the focus when it opens, and draws it as a pressed row.
				await settle(page, 600);
			},
		},
	},
	{
		// 4. Alfy makes things: what the chat made, listed beside it.
		id: 4,
		name: "makes",
		who: "anna",
		desktop: {
			viewport: { width: 1100, height: 700 },
			// Just the panel: the chat's own cards would stand in the strip beside it.
			clip: { x: 412, y: 0, height: 430 },
			prepare: async (page) => {
				await openChat(page, manifest.conversations.plan);
				await page.getByTestId("artifact-count-button").click();
				await page
					.getByTestId("artifact-panel-list")
					.getByTestId("artifact-row")
					.first()
					.waitFor({ state: "visible", timeout: 20000 });
				await settle(page, 1500);
			},
		},
		phone: {
			prepare: async (page) => {
				await openChat(page, manifest.conversationsMore.menu);
				await page.evaluate(() => {
					const scroller =
						document.querySelector<HTMLElement>(".scroll-container");
					if (scroller) scroller.scrollTop = scroller.scrollHeight;
				});
				await settle(page, 1500);
			},
		},
	},
	{
		// 5. Going back: a Document's History, with what is waiting, what was kept and what was named.
		id: 5,
		name: "history",
		who: "anna",
		desktop: {
			clip: { x: 496, y: 0, height: 590 },
			prepare: async (page) => {
				await openChat(page, manifest.conversationsMore.menu);
				await openItem(page, MENU, false);
				await page
					.locator(".document-editor-host .ProseMirror")
					.waitFor({ state: "visible", timeout: 20000 });
				await openHistory(page);
				await page
					.getByTestId("history-option")
					.filter({ hasText: NAMED_MENU_VERSION })
					.click();
				await settle(page, 2000);
			},
		},
		phone: {
			prepare: async (page) => {
				await openChat(page, manifest.conversationsMore.menu);
				await openItem(page, MENU, true);
				await page
					.locator(".document-editor-host .ProseMirror")
					.waitFor({ state: "visible", timeout: 20000 });
				await openHistory(page);
				await settle(page, 1500);
			},
		},
	},
	{
		// 6. Projects: a project's own page, with its chats, its instructions and its files.
		id: 6,
		name: "projects",
		who: "anna",
		desktop: {
			clip: { x: 350, y: 240, height: 500 },
			prepare: async (page) => {
				await page.goto(`${BASE_URL}/projects/${manifest.project.id}`, {
					waitUntil: "domcontentloaded",
				});
				await page
					.getByTestId("project-greeting")
					.waitFor({ state: "visible", timeout: 20000 });
				await settle(page, 1500);
			},
		},
		phone: {
			prepare: async (page) => {
				await page.goto(`${BASE_URL}/projects/${manifest.project.id}`, {
					waitUntil: "domcontentloaded",
				});
				await page
					.getByTestId("project-greeting")
					.waitFor({ state: "visible", timeout: 20000 });
				await settle(page, 1500);
			},
		},
	},
	{
		// 7. Everything findable: the workspace search, over chats and documents.
		id: 7,
		name: "search",
		who: "anna",
		desktop: {
			clip: { x: 340, y: 135, height: 500 },
			prepare: async (page) => {
				await openHome(page);
				await page
					.getByRole("button", {
						name: /^(Keresés beszélgetések és dokumentumok között|Search conversations and documents)$/,
					})
					.first()
					.click();
				await page.waitForTimeout(600);
				await typeInSearch(page);
				await page
					.getByTestId("search-result-count")
					.waitFor({ state: "visible", timeout: 20000 });
				await settle(page, 1200);
			},
		},
		phone: {
			prepare: async (page) => {
				await openHome(page);
				await openPhoneSidebar(page);
				await page
					.getByRole("button", {
						name: /^(Keresés beszélgetések és dokumentumok között|Search conversations and documents)$/,
					})
					.first()
					.click();
				await page.waitForTimeout(600);
				await typeInSearch(page);
				await page
					.getByText(/Szállások összehasonlítása/)
					.first()
					.waitFor({ state: "visible", timeout: 20000 });
				await settle(page, 1200);
			},
		},
	},
	{
		// 8. Memory: what Alfy has kept about a person, readable and editable.
		id: 8,
		name: "memory",
		who: "anna",
		desktop: {
			clip: { x: 222, y: 180, height: 450 },
			prepare: async (page) => {
				await page.goto(`${BASE_URL}/knowledge`, {
					waitUntil: "domcontentloaded",
				});
				await page
					.getByRole("tab", { name: /^(Memóriaprofil|Memory Profile)$/i })
					.click();
				await page
					.getByTestId("memory-row")
					.first()
					.waitFor({ state: "visible", timeout: 20000 });
				await settle(page, 1500);
			},
		},
		phone: {
			prepare: async (page) => {
				await page.goto(`${BASE_URL}/knowledge`, {
					waitUntil: "domcontentloaded",
				});
				await page
					.getByRole("tab", { name: /^(Memóriaprofil|Memory Profile)$/i })
					.click();
				await page
					.getByTestId("memory-row")
					.first()
					.waitFor({ state: "visible", timeout: 20000 });
				await settle(page, 1500);
			},
		},
	},
	{
		// 9. Bring what you have: the accounts that can be connected.
		id: 9,
		name: "bring",
		who: "bence",
		desktop: {
			viewport: { width: 928, height: 580 },
			clip: { x: 0, y: 0, height: 580 },
			prepare: async (page) => {
				await page.goto(`${BASE_URL}/settings`, {
					waitUntil: "domcontentloaded",
				});
				await page
					.getByRole("tab", { name: /^(Kapcsolatok|Connections)$/ })
					.click();
				await page
					.getByText(/^(Kapcsolat hozzáadása|Add a connection)$/)
					.first()
					.waitFor({ state: "visible", timeout: 20000 });
				await scrollTextToTop(
					page,
					/^(Kapcsolat hozzáadása|Add a connection)$/,
				);
				await settle(page, 1500);
			},
		},
		phone: {
			prepare: async (page) => {
				await page.goto(`${BASE_URL}/settings`, {
					waitUntil: "domcontentloaded",
				});
				await page
					.getByRole("tab", { name: /^(Kapcsolatok|Connections)$/ })
					.click();
				await page
					.getByText(/^(Kapcsolat hozzáadása|Add a connection)$/)
					.first()
					.waitFor({ state: "visible", timeout: 20000 });
				await scrollTextToTop(
					page,
					/^(Kapcsolat hozzáadása|Add a connection)$/,
				);
				await settle(page, 1200);
			},
		},
	},
	{
		// 10. Where your data goes: the policy, the import, the download, in the Settings page's own card.
		id: 10,
		name: "data",
		who: "bence",
		desktop: {
			clip: {
				x: 520,
				// The picture starts a little above the Skills row, which stands 215 pixels over the card's heading.
				y: async (page) =>
					(await page
						.getByText(DATA_HEADING)
						.first()
						.evaluate((heading) => heading.getBoundingClientRect().top)) - 215,
				height: 560,
			},
			prepare: async (page) => {
				await page.goto(`${BASE_URL}/settings`, {
					waitUntil: "domcontentloaded",
				});
				await page
					.getByText(DATA_HEADING)
					.first()
					.waitFor({ state: "visible", timeout: 20000 });
				// Let the page finish growing (the activity numbers arrive late) before scrolling.
				await settle(page, 1500);
				await scrollTextToTop(page, DATA_HEADING);
				await settle(page, 1200);
			},
		},
		phone: {
			prepare: async (page) => {
				await page.goto(`${BASE_URL}/settings`, {
					waitUntil: "domcontentloaded",
				});
				await page
					.getByText(DATA_HEADING)
					.first()
					.waitFor({ state: "visible", timeout: 20000 });
				await settle(page, 1500);
				await scrollTextToTop(page, DATA_HEADING);
				await settle(page, 1200);
			},
		},
	},
];

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

function pngSize(bytes: Buffer): { width: number; height: number } {
	return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

type States = Record<Who, Awaited<ReturnType<BrowserContext["storageState"]>>>;

async function signIn(
	browser: Browser,
	lang: Lang,
	who: Who,
): Promise<States[Who]> {
	const context = await browser.newContext({
		viewport: DESKTOP,
		locale: lang === "hu" ? "hu-HU" : "en-GB",
		timezoneId: manifest.timeZone,
	});
	const page = await context.newPage();
	await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded" });
	const answered = await page.evaluate(
		async ({ email, password, uiLanguage }) => {
			const login = await fetch("/api/auth/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email, password }),
			});
			if (!login.ok) return { step: "login", status: login.status };
			const preferences = await fetch("/api/settings/preferences", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ uiLanguage, theme: "light" }),
			});
			return { step: "preferences", status: preferences.status };
		},
		{ ...manifest[who], uiLanguage: lang },
	);
	if (answered.status !== 200) {
		throw new Error(
			`Sign-in of ${who} failed at ${answered.step}: ${answered.status}`,
		);
	}
	const state = await context.storageState();
	await context.close();
	return state;
}

async function sceneContext(
	browser: Browser,
	state: States[Who],
	lang: Lang,
	device: "desktop" | "phone",
	deviceScaleFactor: number,
	viewport: { width: number; height: number },
): Promise<BrowserContext> {
	const context = await browser.newContext({
		storageState: state,
		viewport,
		deviceScaleFactor,
		locale: lang === "hu" ? "hu-HU" : "en-GB",
		timezoneId: manifest.timeZone,
		colorScheme: "light",
		...(device === "phone" ? { isMobile: true, hasTouch: true } : {}),
	});
	// The sample instance is healthy: no "degraded capabilities" bar over the pictures.
	await context.route("**/api/system/capabilities", (route) =>
		route.fulfill({ json: { degraded: [], checkedAt: "" } }),
	);
	return context;
}

type DeckSlide = { desktopFile: string; mobileFile: string };

/** The 256-colour copy of a picture, which halves it and is not visible. */
function reduce(from: string, to: string): void {
	mkdirSync(dirname(to), { recursive: true });
	execFileSync("magick", [
		from,
		"-strip",
		"-colors",
		"256",
		"-dither",
		"None",
		"-define",
		"png:compression-level=9",
		to,
	]);
}

function putInDeck(lang: Lang): void {
	const slidesPath = join(DECK_ROOT, "deck", "slides.json");
	if (!existsSync(slidesPath)) {
		throw new Error(
			`${slidesPath} is missing: the deck's words come first, then its pictures.`,
		);
	}
	const slides = JSON.parse(readFileSync(slidesPath, "utf8")) as DeckSlide[];
	const deck = lang === "hu" ? "deck" : "deck-en";
	const dir = join(DECK_ROOT, deck);
	rmSync(join(dir, "slides"), { recursive: true, force: true });
	if (deck !== "deck") {
		mkdirSync(dir, { recursive: true });
		copyFileSync(slidesPath, join(dir, "slides.json"));
	}
	slides.forEach((slide, index) => {
		for (const [device, file] of [
			["desktop", slide.desktopFile],
			["mobile", slide.mobileFile],
		] as const) {
			const from = join(OUT_DIR, lang, `slide-${index + 1}-${device}.png`);
			if (!existsSync(from)) throw new Error(`Missing ${from}`);
			reduce(from, join(dir, file));
		}
	});
	console.log(`${deck}: ${slides.length} slides`);
}

/** A scene that waits on a page can miss its moment once in a while: try it again in a fresh window, then say so. */
async function twice<T>(label: string, attempt: () => Promise<T>): Promise<T> {
	try {
		return await attempt();
	} catch (error) {
		console.warn(
			`${label} failed once (${String(error).split("\n")[0]}); trying again.`,
		);
		return attempt();
	}
}

async function shootDesktop(
	browser: Browser,
	states: States,
	lang: Lang,
	scene: Scene,
	outDir: string,
): Promise<void> {
	// A 16:10 region, drawn at the scale that makes it 1600 wide.
	const { clip } = scene.desktop;
	const width = clip.height * 1.6;
	if (!Number.isInteger(width)) {
		throw new Error(
			`Scene ${scene.id}: a 16:10 clip needs a height that is a multiple of 5.`,
		);
	}
	const desktop = await sceneContext(
		browser,
		states[scene.who],
		lang,
		"desktop",
		DESKTOP_PICTURE.width / width,
		scene.desktop.viewport ?? DESKTOP,
	);
	try {
		const page = await desktop.newPage();
		await scene.desktop.prepare(page, lang);
		const path = join(outDir, `slide-${scene.id}-desktop.png`);
		if (PROBE) {
			mkdirSync(join(outDir, "probe"), { recursive: true });
			await page.screenshot({
				path: join(outDir, "probe", `slide-${scene.id}-desktop.png`),
				animations: "disabled",
			});
		}
		const clipY = typeof clip.y === "function" ? await clip.y(page) : clip.y;
		const bytes = await page.screenshot({
			path,
			clip: { x: clip.x, y: clipY, width, height: clip.height },
			animations: "disabled",
		});
		const size = pngSize(bytes);
		if (
			size.width !== DESKTOP_PICTURE.width ||
			size.height !== DESKTOP_PICTURE.height
		) {
			throw new Error(
				`${path} is ${size.width}x${size.height}, not ${DESKTOP_PICTURE.width}x${DESKTOP_PICTURE.height}.`,
			);
		}
	} finally {
		await desktop.close();
	}
}

async function shootPhone(
	browser: Browser,
	states: States,
	lang: Lang,
	scene: Scene,
	outDir: string,
): Promise<void> {
	// The whole 432x768 window at scale 2.5.
	const phone = await sceneContext(
		browser,
		states[scene.phone.who ?? scene.who],
		lang,
		"phone",
		PHONE_SCALE,
		PHONE,
	);
	try {
		const page = await phone.newPage();
		await scene.phone.prepare(page, lang);
		const path = join(outDir, `slide-${scene.id}-mobile.png`);
		const bytes = await page.screenshot({ path, animations: "disabled" });
		const size = pngSize(bytes);
		if (
			size.width !== PHONE_PICTURE.width ||
			size.height !== PHONE_PICTURE.height
		) {
			throw new Error(
				`${path} is ${size.width}x${size.height}, not ${PHONE_PICTURE.width}x${PHONE_PICTURE.height}.`,
			);
		}
	} finally {
		await phone.close();
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const only = args.includes("--only")
		? Number(args[args.indexOf("--only") + 1])
		: null;
	const langs = (["hu", "en"] as Lang[]).filter(
		(lang) =>
			!args.some((arg) => arg === "hu" || arg === "en") || args.includes(lang),
	);
	const browser = await chromium.launch();
	try {
		for (const lang of langs) {
			const outDir = join(OUT_DIR, lang);
			mkdirSync(outDir, { recursive: true });
			const states: States = {
				anna: await signIn(browser, lang, "anna"),
				bence: await signIn(browser, lang, "bence"),
			};
			for (const scene of SCENES) {
				if (only !== null && scene.id !== only) continue;
				const label = `${lang} slide ${scene.id} (${scene.name})`;
				await twice(`${label}, desktop`, () =>
					shootDesktop(browser, states, lang, scene, outDir),
				);
				await twice(`${label}, phone`, () =>
					shootPhone(browser, states, lang, scene, outDir),
				);
				console.log(`${label}: ${outDir}`);
			}
		}
		if (args.includes("--deck")) {
			for (const lang of langs) putInDeck(lang);
		}
	} finally {
		await browser.close();
	}
}

await main();
