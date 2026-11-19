#!/usr/bin/env tsx
// Draws the AlfyAI 2.4 release campaign's pictures with the drawing kit, and
// photographs its cards in the app's own campaign window.
//
//   npx tsx scripts/campaign-2-4/render.ts pictures [--lang hu] [--only read-aloud,voices]
//   npx tsx scripts/campaign-2-4/render.ts cards --out <dir>
//
// `pictures` writes the deck's crops, `docs/plans/campaign-2.4/deck/slides/`
// (1600 by 1000 and 1080 by 1920, in the deck's language, Hungarian unless
// `--lang` says otherwise). `cards` takes each card of `slides.json` with those
// pictures, as the campaign window draws it on a desktop (1440 by 900) and on a
// phone (390 by 844), in Hungarian and in English, and puts each language and
// device side by side in one picture under `--out` (ImageMagick's `montage`).
//
// It starts its own dev server (`vite.config.js` here) on port 5640 and writes
// nothing else: no database, no campaign. `create-release-campaign.ts` makes
// the campaign from the deck.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { createServer } from "vite";
import {
	DESIGN_SIZE,
	deckFileName,
	PICTURE_NAMES,
	PICTURE_WIDTH,
	type PictureName,
	VARIANTS,
	type Variant,
} from "./sizes";

type Language = "hu" | "en";

const PORT = 5640;
const BASE = `http://localhost:${PORT}`;
const DECK = resolve("docs/plans/campaign-2.4/deck");
const PAGE = `${BASE}/__campaign-2-4`;
const PICTURE_ROUTE = `${BASE}/__campaign-2-4-pictures/`;

const HTML = `<!doctype html>
<html lang="hu">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>AlfyAI 2.4</title></head>
<body style="margin:0"><div id="stage"></div><script type="module" src="/scripts/campaign-2-4/mount.ts"></script></body>
</html>`;

function option(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}

async function openPage(page: Page, language: Language): Promise<void> {
	await page.route(PAGE, (route) =>
		route.fulfill({
			contentType: "text/html",
			body: HTML.replace('lang="hu"', `lang="${language}"`),
		}),
	);
	await page.route(`${PICTURE_ROUTE}**`, (route) => {
		const file = decodeURIComponent(
			new URL(route.request().url()).pathname.slice(
				new URL(PICTURE_ROUTE).pathname.length,
			),
		);
		route.fulfill({
			contentType: "image/png",
			body: readFileSync(join(DECK, file)),
		});
	});
	// The first visit can meet the dev server optimizing a dependency and
	// reloading; the page is ready once mount.ts has run.
	for (let attempt = 0; attempt < 3; attempt += 1) {
		await page.goto(PAGE, { waitUntil: "load" });
		const ready = await page
			.waitForFunction(() => Boolean(window.campaignPictures), null, {
				timeout: 60_000,
			})
			.then(() => true)
			.catch(() => false);
		if (ready) return;
	}
	throw new Error("The drawing page never loaded mount.ts.");
}

async function settle(page: Page): Promise<void> {
	await page.evaluate(async () => {
		await document.fonts.ready;
		await new Promise((done) =>
			requestAnimationFrame(() => requestAnimationFrame(done)),
		);
	});
	await page.waitForTimeout(150);
}

async function drawPictures(language: Language, only: PictureName[]) {
	const browser = await chromium.launch();
	try {
		for (const variant of VARIANTS) {
			const width = PICTURE_WIDTH[variant];
			const size = DESIGN_SIZE[variant];
			const context = await browser.newContext({
				viewport: {
					width: width + 40,
					height: Math.ceil((width * size.height) / size.width) + 40,
				},
				deviceScaleFactor: 2,
			});
			const page = await context.newPage();
			for (const name of only) {
				await openPage(page, language);
				await page.evaluate(
					([name, variant, language]) =>
						window.campaignPictures.drawPicture(
							document.getElementById("stage") as HTMLElement,
							name as PictureName,
							variant as Variant,
							language as Language,
						),
					[name, variant, language] as const,
				);
				await settle(page);
				const path = join(DECK, deckFileName(name, variant));
				mkdirSync(join(DECK, "slides"), { recursive: true });
				await page
					.locator('[data-testid="drawing-frame"]')
					.screenshot({ path });
				console.log(`${path}`);
			}
			await context.close();
		}
	} finally {
		await browser.close();
	}
}

const DEVICES = {
	desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
	phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 },
} as const;

async function photographCards(out: string) {
	type DeckSlide = Record<string, string | undefined>;
	const slides = JSON.parse(
		readFileSync(join(DECK, "slides.json"), "utf8"),
	) as DeckSlide[];
	const campaign = {
		id: "campaign-2-4-preview",
		type: "release_update",
		status: "draft",
		name: "AlfyAI 2.4",
		releaseVersion: "2.4.0",
		slides: slides.map((slide, index) => ({
			id: `slide-${index + 1}`,
			layoutType: "standard",
			semanticRole: "feature",
			sortOrder: index,
			titleEn: slide.titleEn,
			titleHu: slide.titleHu,
			bodyEn: slide.bodyEn,
			bodyHu: slide.bodyHu,
			altEn: slide.altTextEn,
			altHu: slide.altTextHu,
			actionLabelEn: slide.actionLabelEn ?? null,
			actionLabelHu: slide.actionLabelHu ?? null,
			actionDestination: slide.actionDestination ?? null,
			desktopAsset: { url: `${PICTURE_ROUTE}${slide.desktopFile}` },
			mobileAsset: { url: `${PICTURE_ROUTE}${slide.mobileFile}` },
		})),
	};
	mkdirSync(out, { recursive: true });
	const browser = await chromium.launch();
	try {
		for (const language of ["hu", "en"] as const) {
			for (const [device, settings] of Object.entries(DEVICES)) {
				const context = await browser.newContext(settings);
				const page = await context.newPage();
				const shots: string[] = [];
				for (let index = 0; index < slides.length; index += 1) {
					await openPage(page, language);
					await page.evaluate(
						([campaign, index, language]) =>
							window.campaignPictures.drawCard(
								document.getElementById("stage") as HTMLElement,
								// biome-ignore lint/suspicious/noExplicitAny: the page's own type.
								campaign as any,
								index as number,
								language as Language,
							),
						[campaign, index, language] as const,
					);
					await page.waitForFunction(() =>
						Array.from(document.images).every(
							(image) => image.complete && image.naturalWidth > 0,
						),
					);
					await settle(page);
					// A card whose words have to scroll in the window is too long.
					const scrolls = await page.evaluate(() =>
						Array.from(
							document.querySelectorAll(
								".campaign-modal-surface, .campaign-modal-surface *",
							),
						)
							.filter((element) =>
								["auto", "scroll"].includes(
									getComputedStyle(element).overflowY,
								),
							)
							.map((element) => element.scrollHeight - element.clientHeight)
							.filter((hidden) => hidden > 1),
					);
					if (scrolls.length > 0) {
						console.warn(
							`${language} ${device} card ${index + 1}: ${scrolls.join(", ")} px of its words scroll`,
						);
					}
					const shot = join(out, `${language}-${device}-${index + 1}.png`);
					await page
						.locator(".campaign-modal-surface")
						.screenshot({ path: shot });
					shots.push(shot);
				}
				await context.close();
				const sheet = join(out, `cards-${language}-${device}.png`);
				execFileSync("magick", [
					"montage",
					...shots,
					"-tile",
					`${device === "phone" ? slides.length : 3}x`,
					"-geometry",
					"+16+16",
					"-background",
					"#9a9a9a",
					sheet,
				]);
				console.log(sheet);
			}
		}
	} finally {
		await browser.close();
	}
}

const mode = process.argv[2];
const server = await createServer({
	configFile: resolve("scripts/campaign-2-4/vite.config.js"),
	server: { port: PORT, strictPort: true },
	logLevel: "warn",
});
await server.listen();
try {
	if (mode === "pictures") {
		const language = (option("--lang") ?? "hu") as Language;
		const only = (option("--only")?.split(",") ??
			PICTURE_NAMES) as PictureName[];
		await drawPictures(language, only);
	} else if (mode === "cards") {
		await photographCards(
			resolve(option("--out") ?? "data/campaign-2-4-cards"),
		);
	} else {
		throw new Error("Say what to draw: pictures or cards.");
	}
} finally {
	await server.close();
}
