#!/usr/bin/env tsx
// Puts the pictures `scripts/campaign-shots-2-2.ts` took into the 2.2 campaign's two decks.
//
//   CAMPAIGN_OUT_DIR=./data/campaign-2-2-shots npx tsx scripts/campaign-deck-pictures-2-2.ts
//
// `docs/plans/campaign-2.2/deck/slides.json` is the one place the words live: the English-interface
// alternate (`deck-en`) gets a copy of it (the test insists the two say the very same words), and each
// deck gets the pictures of its interface language, named as slides.json names them. Slide N is the
// Nth object of slides.json. The pictures are reduced to 256 colours with ImageMagick, which halves
// them and is not visible; a deck is about 1.3 MB.

import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const SHOTS = resolve(
	process.env.CAMPAIGN_OUT_DIR || "./data/campaign-2-2-shots",
);
const ROOT = resolve("docs/plans/campaign-2.2");

type Slide = { desktopFile: string; mobileFile: string };

const slides = JSON.parse(
	readFileSync(join(ROOT, "deck", "slides.json"), "utf8"),
) as Slide[];

for (const [deck, lang] of [
	["deck", "hu"],
	["deck-en", "en"],
] as const) {
	const dir = join(ROOT, deck);
	rmSync(join(dir, "slides"), { recursive: true, force: true });
	mkdirSync(join(dir, "slides"), { recursive: true });
	if (deck !== "deck") {
		copyFileSync(join(ROOT, "deck", "slides.json"), join(dir, "slides.json"));
	}
	slides.forEach((slide, index) => {
		for (const [device, file] of [
			["desktop", slide.desktopFile],
			["mobile", slide.mobileFile],
		] as const) {
			const from = join(SHOTS, lang, `slide-${index + 1}-${device}.png`);
			if (!existsSync(from)) throw new Error(`Missing ${from}`);
			const to = join(dir, file);
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
	});
	console.log(`${deck}: ${slides.length} slides`);
}
