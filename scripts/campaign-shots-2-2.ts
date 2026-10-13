#!/usr/bin/env tsx
// Takes the AlfyAI 2.2 release campaign's screenshots (the deck's pictures) from a running
// production build whose database `scripts/seed-campaign-2-2.ts` has seeded.
//
//   CAMPAIGN_BASE_URL=http://127.0.0.1:5568 CAMPAIGN_OUT_DIR=./data/campaign-2-2-shots \
//     npx tsx scripts/campaign-shots-2-2.ts [hu] [en] [--only 3]
//
// One picture per slide and per device, in each language, at the exact size the campaign
// takes (`create-release-campaign.ts`: 16:10 at 1600x1000 for a desktop crop, 9:16 at
// 1080x1920 for a phone crop). The sizes are not resized afterwards: a desktop picture is a
// 16:10 region of a 1440x900 window, drawn at the device scale that makes the region 1600
// pixels wide, and a phone picture is a 360x640 window at scale 3. Light theme, the server's
// own rendering, nothing drawn on top.
//
// The campaign's pictures carry no language of their own (a slide has one desktop and one
// phone image for both languages), so the deck is built from one language's set; the other
// is the same scenes in the other language, for a look and for an alternate deck.

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	type Browser,
	type BrowserContext,
	chromium,
	type Page,
} from "playwright";

const BASE_URL = process.env.CAMPAIGN_BASE_URL || "http://127.0.0.1:5568";
const OUT_DIR = resolve(
	process.env.CAMPAIGN_OUT_DIR || "./data/campaign-2-2-shots",
);
const MANIFEST_PATH = resolve(
	process.env.CAMPAIGN_MANIFEST || "./data/campaign-2-2-manifest.json",
);

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 360, height: 640 };
const PHONE_SCALE = 3;
const DESKTOP_PICTURE = { width: 1600, height: 1000 };
const PHONE_PICTURE = { width: 1080, height: 1920 };

type Lang = "hu" | "en";

type Manifest = {
	timeZone: string;
	user: { email: string; password: string };
	project: { id: string };
	conversations: { plan: string; photo: string };
};

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;

// ---------------------------------------------------------------------------
// The scenes: what each slide shows, on a desktop window and on a phone
// ---------------------------------------------------------------------------

type DesktopClip = { x: number; y: number; height: number };

type Scene = {
	id: number;
	name: string;
	desktop: {
		viewport?: { width: number; height: number };
		/** The 16:10 region of the window the picture is: its width is 1.6 times its height. */
		clip: DesktopClip;
		prepare: (page: Page) => Promise<void>;
	};
	phone: { prepare: (page: Page) => Promise<void> };
};

async function settle(page: Page, ms = 1200): Promise<void> {
	await page.waitForLoadState("networkidle").catch(() => undefined);
	await page.waitForTimeout(ms);
	// The composer takes the focus when a chat opens, and draws a ring for it.
	await page.evaluate(() => {
		(document.activeElement as HTMLElement | null)?.blur?.();
	});
}

/** The chat shows its beginning: the first request and what Alfy made from it. */
async function scrollChatToTop(page: Page): Promise<void> {
	await page.evaluate(() => {
		const scroller = document.querySelector<HTMLElement>(".scroll-container");
		if (scroller) scroller.scrollTop = 0;
	});
	await page.waitForTimeout(800);
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

const PLAN = /Háromnapos program/;
const BOARD = /Program napokra/;
const NAMED_VERSION = "Ezt küldtem el a családnak";

const SCENES: Scene[] = [
	{
		// 1. Projects: the files a project knows, and what its chats made.
		id: 1,
		name: "projects",
		desktop: {
			clip: { x: 99, y: 65, height: 770 },
			prepare: async (page) => {
				await page.goto(`${BASE_URL}/projects/${manifest.project.id}`, {
					waitUntil: "domcontentloaded",
				});
				await page.getByTestId("project-files-button").click();
				await page
					.getByTestId("project-file-row")
					.first()
					.waitFor({ state: "visible", timeout: 20000 });
				await settle(page);
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
				await settle(page);
			},
		},
	},
	{
		// 2. Artifacts: what a chat made opens beside it.
		id: 2,
		name: "artifacts",
		desktop: {
			clip: { x: 0, y: 0, height: 900 },
			prepare: async (page) => {
				await openChat(page, manifest.conversations.plan);
				await openItem(page, BOARD, false);
				await page
					.locator(".svelte-flow__node")
					.first()
					.waitFor({ state: "visible", timeout: 20000 });
				await scrollChatToTop(page);
				await settle(page, 2000);
			},
		},
		phone: {
			prepare: async (page) => {
				// On a phone the cards are the way in: what Alfy made, with a way to open it.
				await openChat(page, manifest.conversations.plan);
				await settle(page);
				// The Document's card, with the change that waits for the reader, in the middle.
				await page
					.getByTestId("artifact-card")
					.first()
					.evaluate((card) => card.scrollIntoView({ block: "center" }));
				await page.waitForTimeout(800);
			},
		},
	},
	{
		// 3. Working together: Alfy's change waits for Keep or Undo, and a margin comment asked @Alfy.
		id: 3,
		name: "together",
		desktop: {
			viewport: { width: DESKTOP.width, height: 840 },
			clip: { x: 494, y: 249, height: 590 },
			prepare: async (page) => {
				await openChat(page, manifest.conversations.plan);
				await openItem(page, PLAN, false);
				await page
					.locator(".document-editor-host .ProseMirror")
					.waitFor({ state: "visible", timeout: 20000 });
				await settle(page, 2000);
			},
		},
		phone: {
			prepare: async (page) => {
				await openChat(page, manifest.conversations.plan);
				await openItem(page, PLAN, true);
				await page
					.locator(".document-editor-host .ProseMirror")
					.waitFor({ state: "visible", timeout: 20000 });
				await settle(page, 2000);
			},
		},
	},
	{
		// 4. History: a named version, previewed, with Restore.
		id: 4,
		name: "history",
		desktop: {
			clip: { x: 494, y: 48, height: 590 },
			prepare: async (page) => {
				await openChat(page, manifest.conversations.plan);
				await openItem(page, PLAN, false);
				await page
					.locator(".document-editor-host .ProseMirror")
					.waitFor({ state: "visible", timeout: 20000 });
				await openHistory(page);
				await page
					.getByTestId("history-option")
					.filter({ hasText: NAMED_VERSION })
					.click();
				await settle(page, 2000);
			},
		},
		phone: {
			prepare: async (page) => {
				await openChat(page, manifest.conversations.plan);
				await openItem(page, PLAN, true);
				await page
					.locator(".document-editor-host .ProseMirror")
					.waitFor({ state: "visible", timeout: 20000 });
				await openHistory(page);
				await settle(page, 1500);
			},
		},
	},
	{
		// 5. Privacy: a picture from an address nobody gave stays a link.
		id: 5,
		name: "privacy",
		desktop: {
			clip: { x: 372, y: 160, height: 440 },
			prepare: async (page) => {
				await openChat(page, manifest.conversations.photo);
				await settle(page);
			},
		},
		phone: {
			prepare: async (page) => {
				await openChat(page, manifest.conversations.photo);
				await settle(page);
				await scrollChatToTop(page);
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

async function signIn(browser: Browser, lang: Lang) {
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
		{ ...manifest.user, uiLanguage: lang },
	);
	if (answered.status !== 200) {
		throw new Error(`Sign-in failed at ${answered.step}: ${answered.status}`);
	}
	const state = await context.storageState();
	await context.close();
	return state;
}

async function sceneContext(
	browser: Browser,
	state: Awaited<ReturnType<typeof signIn>>,
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
			const state = await signIn(browser, lang);
			for (const scene of SCENES) {
				if (only !== null && scene.id !== only) continue;

				// Desktop: a 16:10 region, drawn at the scale that makes it 1600 wide.
				const { clip } = scene.desktop;
				const width = clip.height * 1.6;
				if (!Number.isInteger(width)) {
					throw new Error(
						`Scene ${scene.id}: a 16:10 clip needs a height that is a multiple of 5.`,
					);
				}
				const desktop = await sceneContext(
					browser,
					state,
					lang,
					"desktop",
					DESKTOP_PICTURE.width / width,
					scene.desktop.viewport ?? DESKTOP,
				);
				const desktopPage = await desktop.newPage();
				await scene.desktop.prepare(desktopPage);
				const desktopPath = join(outDir, `slide-${scene.id}-desktop.png`);
				const desktopBytes = await desktopPage.screenshot({
					path: desktopPath,
					clip: { x: clip.x, y: clip.y, width, height: clip.height },
					animations: "disabled",
				});
				await desktop.close();
				const desktopSize = pngSize(desktopBytes);
				if (
					desktopSize.width !== DESKTOP_PICTURE.width ||
					desktopSize.height !== DESKTOP_PICTURE.height
				) {
					throw new Error(
						`${desktopPath} is ${desktopSize.width}x${desktopSize.height}, not ${DESKTOP_PICTURE.width}x${DESKTOP_PICTURE.height}.`,
					);
				}

				// Phone: the whole 360x640 window at scale 3.
				const phone = await sceneContext(
					browser,
					state,
					lang,
					"phone",
					PHONE_SCALE,
					PHONE,
				);
				const phonePage = await phone.newPage();
				await scene.phone.prepare(phonePage);
				const phonePath = join(outDir, `slide-${scene.id}-mobile.png`);
				const phoneBytes = await phonePage.screenshot({
					path: phonePath,
					animations: "disabled",
				});
				await phone.close();
				const phoneSize = pngSize(phoneBytes);
				if (
					phoneSize.width !== PHONE_PICTURE.width ||
					phoneSize.height !== PHONE_PICTURE.height
				) {
					throw new Error(
						`${phonePath} is ${phoneSize.width}x${phoneSize.height}, not ${PHONE_PICTURE.width}x${PHONE_PICTURE.height}.`,
					);
				}
				console.log(
					`${lang} slide ${scene.id} (${scene.name}): ${dirname(desktopPath)}`,
				);
			}
		}
	} finally {
		await browser.close();
	}
}

await main();
