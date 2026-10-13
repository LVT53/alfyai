#!/usr/bin/env tsx
// Takes the AlfyAI 2.2 release campaign's previews (or the first-run onboarding's: the campaign is
// the draft named by CAMPAIGN_NAME, and the signed-in administrator is the manifest's `user` or, in
// the onboarding sample's manifest, `anna`) from a running production build whose scratch database
// holds the draft (`scripts/create-release-campaign.ts`, run on that database):
//
//   * the reader's card, slide by slide, as the app's own modal draws it, on a desktop window and
//     on a phone, in Hungarian and in English, put side by side in one picture per language and device;
//   * the admin Campaigns pane with the draft open, in both languages.
//
//   CAMPAIGN_BASE_URL=http://127.0.0.1:5581 CAMPAIGN_OUT_DIR=./data/campaign-2-2-previews \
//     npx tsx scripts/campaign-previews-2-2.ts [hu] [en]
//
// Nothing is published and nothing is written to the database. The reader's cards are the real
// modal at its real size: the browser's answer to `/api/campaigns/eligible` is replaced by the
// draft's admin payload, so the app opens it the way it opens a campaign a reader has not seen.
// The one-picture-per-language montage is made with ImageMagick (`magick montage`).

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Browser, chromium, type Page } from "playwright";

const BASE_URL = process.env.CAMPAIGN_BASE_URL || "http://127.0.0.1:5581";
const OUT_DIR = resolve(
	process.env.CAMPAIGN_OUT_DIR || "./data/campaign-2-2-previews",
);
const MANIFEST_PATH = resolve(
	process.env.CAMPAIGN_MANIFEST || "./data/campaign-2-2-manifest.json",
);
const CAMPAIGN_NAME = process.env.CAMPAIGN_NAME || "AlfyAI 2.2";

const DESKTOP = { width: 1440, height: 900 };
// A regular phone, a little narrower than the picture set's window: the card is what is looked at.
const PHONE = { width: 390, height: 844 };

type Lang = "hu" | "en";

const sample = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
	timeZone: string;
	user?: { email: string; password: string };
	anna?: { email: string; password: string };
};
const manifest = {
	timeZone: sample.timeZone,
	user: sample.user ?? sample.anna ?? { email: "", password: "" },
};

async function signIn(browser: Browser, lang: Lang) {
	const context = await browser.newContext({
		viewport: DESKTOP,
		locale: lang === "hu" ? "hu-HU" : "en-GB",
		timezoneId: manifest.timeZone,
	});
	const page = await context.newPage();
	await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded" });
	const status = await page.evaluate(
		async ({ email, password, uiLanguage }) => {
			const login = await fetch("/api/auth/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email, password }),
			});
			if (!login.ok) return login.status;
			const preferences = await fetch("/api/settings/preferences", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ uiLanguage, theme: "light" }),
			});
			return preferences.status;
		},
		{ ...manifest.user, uiLanguage: lang },
	);
	if (status !== 200) throw new Error(`Sign-in failed: ${status}`);
	const state = await context.storageState();
	// The draft, as the admin pane has it.
	const draft = await page.evaluate(async (name) => {
		const list = await fetch("/api/admin/campaigns");
		const body = await list.json();
		const rows = Array.isArray(body) ? body : (body.campaigns ?? []);
		const row = rows.find(
			(campaign: { name?: string; status?: string }) =>
				campaign.name === name && campaign.status === "draft",
		);
		if (!row) return null;
		const full = await fetch(`/api/admin/campaigns/${row.id}`);
		const payload = await full.json();
		return payload.campaign ?? payload;
	}, CAMPAIGN_NAME);
	await context.close();
	if (!draft) throw new Error(`No draft named "${CAMPAIGN_NAME}" was found.`);
	return { state, draft };
}

async function readerCards(
	browser: Browser,
	auth: Awaited<ReturnType<typeof signIn>>,
	lang: Lang,
	device: "desktop" | "phone",
	outDir: string,
): Promise<string[]> {
	const context = await browser.newContext({
		storageState: auth.state,
		viewport: device === "desktop" ? DESKTOP : PHONE,
		deviceScaleFactor: 2,
		locale: lang === "hu" ? "hu-HU" : "en-GB",
		timezoneId: manifest.timeZone,
		colorScheme: "light",
		...(device === "phone" ? { isMobile: true, hasTouch: true } : {}),
	});
	await context.route("**/api/system/capabilities", (route) =>
		route.fulfill({ json: { degraded: [], checkedAt: "" } }),
	);
	await context.route("**/api/campaigns/eligible", (route) =>
		route.fulfill({ json: { campaign: auth.draft } }),
	);
	// A draft has nothing to record: the app's event calls are answered, not forwarded.
	await context.route(/\/api\/campaigns\/[^/]+\/(events|complete)/, (route) =>
		route.fulfill({ json: { ok: true } }),
	);
	const page = await context.newPage();
	await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
	const surface = page.locator(".campaign-modal-surface");
	await surface.waitFor({ state: "visible", timeout: 20000 });
	const slides = (auth.draft.slides as unknown[]).length;
	const files: string[] = [];
	for (let index = 0; index < slides; index += 1) {
		await waitForPicture(page);
		const path = join(outDir, `card-${String(index + 1).padStart(2, "0")}.png`);
		await surface.screenshot({ path, animations: "disabled" });
		files.push(path);
		// A body that does not fit makes the card scroll: say which, so a longer edit is seen.
		const scrolls = await page
			.locator(".campaign-modal-body")
			.evaluate((body) => body.scrollHeight > body.clientHeight + 1);
		if (scrolls) console.warn(`${lang} ${device} card ${index + 1} scrolls.`);
		if (index < slides - 1) {
			await page.getByRole("button", { name: /^(Következő|Next)$/ }).click();
		}
	}
	await context.close();
	return files;
}

/** The slide's picture has been drawn (not the grey frame it starts as). */
async function waitForPicture(page: Page): Promise<void> {
	await page
		.locator(".campaign-modal-surface img")
		.first()
		.evaluate(
			(image) =>
				new Promise<void>((done) => {
					const element = image as HTMLImageElement;
					if (element.complete && element.naturalWidth > 0) return done();
					element.addEventListener("load", () => done(), { once: true });
					setTimeout(done, 8000);
				}),
		)
		.catch(() => undefined);
	await page.waitForTimeout(900);
}

async function adminPane(
	browser: Browser,
	auth: Awaited<ReturnType<typeof signIn>>,
	lang: Lang,
	outPath: string,
): Promise<void> {
	const context = await browser.newContext({
		storageState: auth.state,
		viewport: DESKTOP,
		deviceScaleFactor: 1,
		locale: lang === "hu" ? "hu-HU" : "en-GB",
		timezoneId: manifest.timeZone,
		colorScheme: "light",
	});
	await context.route("**/api/system/capabilities", (route) =>
		route.fulfill({ json: { degraded: [], checkedAt: "" } }),
	);
	const page = await context.newPage();
	await page.goto(`${BASE_URL}/settings`, { waitUntil: "networkidle" });
	await page
		.getByRole("tab", {
			name: lang === "hu" ? "Adminisztráció" : "Administration",
		})
		.click();
	await page
		.getByRole("button", {
			name: lang === "hu" ? "Kampányok" : "Campaigns",
			exact: true,
		})
		.click();
	const row = page
		.getByTestId("admin-campaign-row")
		.filter({ hasText: CAMPAIGN_NAME })
		.first();
	await row.waitFor({ state: "visible", timeout: 20000 });
	await row.click();
	await page.waitForTimeout(2000);
	// The editor opens on English; the pane is shown in the language it is read in.
	await page
		.getByRole("button", { name: lang === "hu" ? "HU" : "EN", exact: true })
		.first()
		.click();
	await page.waitForTimeout(1200);
	await page.screenshot({ path: outPath });
	await context.close();
}

/** One picture of all the cards of a language and device, in a grid. */
function montage(files: string[], out: string, columns: number): void {
	// A card is drawn at 2x; the montage shows it at 1x (its CSS pixels). The width is the PNG's own.
	const cardWidth = readFileSync(files[0]).readUInt32BE(16) / 2;
	// The options go before the pictures: montage reads them in order.
	execFileSync("magick", [
		"montage",
		"-background",
		"#9a9a9a",
		"-tile",
		`${columns}x`,
		"-geometry",
		`${cardWidth}x+16+16`,
		...files,
		out,
	]);
	// 256 colours, as the deck's pictures are: the montage is for looking at, and halves in size.
	execFileSync("magick", [
		out,
		"-strip",
		"-colors",
		"256",
		"-dither",
		"None",
		"-define",
		"png:compression-level=9",
		`PNG8:${out}`,
	]);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const langs = (["hu", "en"] as Lang[]).filter(
		(lang) =>
			!args.some((arg) => arg === "hu" || arg === "en") || args.includes(lang),
	);
	mkdirSync(OUT_DIR, { recursive: true });
	const browser = await chromium.launch();
	try {
		for (const lang of langs) {
			const auth = await signIn(browser, lang);
			for (const device of ["desktop", "phone"] as const) {
				const dir = join(OUT_DIR, "cards", `${lang}-${device}`);
				mkdirSync(dir, { recursive: true });
				const files = await readerCards(browser, auth, lang, device, dir);
				montage(
					files,
					join(OUT_DIR, `cards-${lang}-${device}.png`),
					device === "desktop" ? 4 : 5,
				);
				console.log(`${lang} ${device}: ${files.length} cards`);
			}
			await adminPane(browser, auth, lang, join(OUT_DIR, `admin-${lang}.png`));
			console.log(`${lang} admin`);
		}
	} finally {
		await browser.close();
	}
	console.log(`Previews in ${OUT_DIR}: ${readdirSync(OUT_DIR).join(", ")}`);
}

await main();
