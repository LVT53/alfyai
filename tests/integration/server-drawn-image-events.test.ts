import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

// A picture the server draws can finish, or fail, before the page's code runs.
// Svelte remembers that event with an inline `onload`/`onerror` attribute and
// replays it when the page wakes up, but the policy the boxes enforce
// (CSP_MODE=enforce, no inline handlers) refuses the attribute, so nothing hears
// the event: the Knowledge list showed none of its pictures, and a picture that
// failed kept the broken-picture glyph where its fallback belongs (an avatar's
// initial, a model's initial, a hidden favicon). Dev and the e2e servers only
// report the policy, so this never shows there.
//
// So every element Svelte replays that way (`img`, `iframe`, `embed`, `object`,
// `track`) and that waits for its load or error carries
// `use:replayEarlyImageEvent` (src/lib/utils/early-image-event.ts), which hands
// it the event it missed, or ImagePicture's own `showIfHeld`. The exceptions
// are elements the server never draws, each with its reason. A new one is
// either: say which.

const ROOT = process.cwd();
const SRC_DIR = join(ROOT, "src");
const REPLAYED_ELEMENT = /<(?:img|iframe|embed|object|track)\b/g;
const WAITS_FOR_LOAD_OR_ERROR = /\son(?:load|error)=/;
const HEARS_AN_EARLY_EVENT = /\buse:(?:replayEarlyImageEvent|showIfHeld)\b/;

/** Elements made only once the page runs, so no early event can be missed. */
const DRAWN_IN_THE_BROWSER: Array<{ file: string; tag?: string; why: string }> =
	[
		{
			file: "src/lib/components/artifacts/image/ImagePicture.svelte",
			tag: 'data-testid="image-picture-before"',
			why: "the Before picture is asked for only once After is shown",
		},
		{
			file: "src/lib/components/artifacts/image/CompareWipe.svelte",
			why: "History's version preview, loaded on demand",
		},
		{
			file: "src/lib/components/artifacts/image/UploadPictureMarks.svelte",
			why: "the document preview, loaded on demand, and the photo-mark dialog, opened by a press",
		},
		{
			file: "src/lib/components/artifacts/canvas/nodes/LiveWebNode.svelte",
			why: "a Canvas node, loaded on demand",
		},
		{
			file: "src/lib/components/artifacts/canvas/nodes/PhotoNode.svelte",
			why: "a Canvas node, loaded on demand",
		},
		{
			file: "src/lib/components/document-workspace/preview-runtime/image/ImagePreview.svelte",
			why: "the document preview, loaded on demand",
		},
		{
			file: "src/lib/components/chat/ImageLightbox.svelte",
			why: "the lightbox, loaded and opened by a press",
		},
		{
			file: "src/lib/components/campaign-admin/CampaignCropModal.svelte",
			why: "opened by an admin's press",
		},
		{
			file: "src/lib/components/campaigns/CampaignModal.svelte",
			why: "the shell chooses a campaign only in the browser",
		},
		{
			file: "src/lib/components/search/SearchModal.svelte",
			why: "a search result's thumbnail, drawn once the browser has fetched the results",
		},
	];

function svelteFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...svelteFiles(path));
		else if (entry.name.endsWith(".svelte") && !entry.name.includes(".test."))
			files.push(path);
	}
	return files;
}

/** The markup: script and style blocks and comments blanked, lines kept. */
function markupOf(source: string): string {
	return source.replace(
		/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<!--[\s\S]*?-->/g,
		(block) => block.replace(/[^\n]/g, " "),
	);
}

/** The opening tag that starts at `start`: a `>` inside braces or quotes is not its end. */
function tagAt(markup: string, start: number): string {
	let depth = 0;
	let quote: string | null = null;
	for (let i = start; i < markup.length; i += 1) {
		const character = markup[i];
		if (quote) {
			if (character === quote) quote = null;
		} else if (character === '"' || character === "'" || character === "`") {
			quote = character;
		} else if (character === "{") depth += 1;
		else if (character === "}") depth -= 1;
		else if (character === ">" && depth === 0)
			return markup.slice(start, i + 1);
	}
	return markup.slice(start);
}

type Waiting = { file: string; line: number; tag: string };

function waitingElements(): Waiting[] {
	const found: Waiting[] = [];
	for (const path of svelteFiles(SRC_DIR)) {
		const file = relative(ROOT, path).split(sep).join("/");
		const markup = markupOf(readFileSync(path, "utf8"));
		for (const match of markup.matchAll(REPLAYED_ELEMENT)) {
			const tag = tagAt(markup, match.index);
			if (!WAITS_FOR_LOAD_OR_ERROR.test(tag)) continue;
			const line = markup.slice(0, match.index).split("\n").length;
			found.push({ file, line, tag });
		}
	}
	return found;
}

const drawnInTheBrowser = ({ file, tag }: Waiting) =>
	DRAWN_IN_THE_BROWSER.some(
		(entry) =>
			entry.file === file &&
			(entry.tag === undefined || tag.includes(entry.tag)),
	);

describe("an element the server draws hears the load or error it missed", () => {
	const waiting = waitingElements();

	it("finds the elements that wait for one", () => {
		expect(waiting.length).toBeGreaterThan(10);
	});

	it("carries replayEarlyImageEvent unless only the browser draws it", () => {
		const deaf = waiting
			.filter((element) => !HEARS_AN_EARLY_EVENT.test(element.tag))
			.filter((element) => !drawnInTheBrowser(element))
			.map(({ file, line }) => `${file}:${line}`);
		expect(deaf).toEqual([]);
	});

	it("names in its list of exceptions only elements that still wait", () => {
		const stale = DRAWN_IN_THE_BROWSER.filter(
			(entry) =>
				!waiting.some(
					(element) =>
						element.file === entry.file &&
						(entry.tag === undefined || element.tag.includes(entry.tag)) &&
						!HEARS_AN_EARLY_EVENT.test(element.tag),
				),
		).map((entry) => entry.file);
		expect(stale).toEqual([]);
	});
});
