import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Two habits that made parallel e2e runs flaky, held as tests so that a spec written next
// month does not bring them back. Both are about what the app does on a fast production
// build with several workers; neither shows on a quiet machine with one worker.
//
// 1. A conversation made through the landing page (`createConversation`) sends a first
//    message. A spec that then clears `pending-chat-message:<id>` from sessionStorage wants
//    NO first turn, but whether the page or the spec reaches the key first is a race; when the
//    page wins, a turn to the server's unreachable default model starts, fails a few hundred
//    ms later, and a reload in that window waits for a terminal event that never comes.
//    Such a spec asks for the state it wants: `createEmptyConversation(page, title)`.
//
// 2. A block that cannot be photographed (the map, an App, photos, live web) gets a poster,
//    and while it does the editor keeps a hidden copy of it in <body> with the same test
//    ids. `page.getByTestId("canvas-map")` finds two for a moment (seconds on a busy
//    machine) and a strict assertion fails on the count. The live block is
//    `liveBlock(page, "canvas-map")` (artifact-canvas-helpers.ts).

const E2E_DIR = join(process.cwd(), "tests", "e2e");

const CALLS_CREATE_CONVERSATION = /\bcreateConversation\(/;
const CLEARS_PENDING_MESSAGE = /pending-chat-message/;
const POSTER_BLOCK_ON_PAGE =
	/page\s*\.getByTestId\(\s*["'`]canvas-(?:map|app|photo|web)[a-z-]*["'`]\s*\)/;

/** The files (name -> text) that break either habit, each with the rule it breaks. */
function conventionViolations(files: Record<string, string>): string[] {
	const names = Object.keys(files);
	// A module that clears the key, or a spec that imports one that does, is "a spec that
	// does not want a first turn".
	const clearers = names.filter((name) =>
		CLEARS_PENDING_MESSAGE.test(files[name]),
	);
	const importsClearer = (text: string) =>
		clearers.some((clearer) =>
			new RegExp(
				`from\\s+["']\\./${clearer.replace(/\.ts$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`,
			).test(text),
		);
	const found: string[] = [];
	for (const name of names) {
		const text = files[name];
		if (
			CALLS_CREATE_CONVERSATION.test(text) &&
			(CLEARS_PENDING_MESSAGE.test(text) || importsClearer(text))
		) {
			found.push(
				`${name}: calls createConversation() but clears (or imports a helper that clears) the pending first message; it wants no first turn, so use createEmptyConversation(page, title)`,
			);
		}
		if (POSTER_BLOCK_ON_PAGE.test(text)) {
			found.push(
				`${name}: addresses a poster block by page.getByTestId(...); a hidden copy of it lives in <body> while its poster is made, so use liveBlock(page, testId)`,
			);
		}
	}
	return found;
}

function readE2eFiles(): Record<string, string> {
	const files: Record<string, string> = {};
	for (const name of readdirSync(E2E_DIR)) {
		if (!name.endsWith(".ts")) continue;
		files[name] = readFileSync(join(E2E_DIR, name), "utf8");
	}
	return files;
}

describe("e2e conventions", () => {
	it("holds on the specs in the tree", () => {
		expect(conventionViolations(readE2eFiles())).toEqual([]);
	});

	describe("what the check recognises", () => {
		it("flags a spec that makes a conversation through the landing page and clears the pending message", () => {
			const found = conventionViolations({
				"a.spec.ts": `const id = await createConversation(page, "x");\nwindow.sessionStorage.removeItem(\`pending-chat-message:\${id}\`);`,
			});
			expect(found).toHaveLength(1);
			expect(found[0]).toContain("createEmptyConversation");
		});

		it("flags a spec that gets its clearing from a helper module", () => {
			const found = conventionViolations({
				"helpers-a.ts": `sessionStorage.removeItem("pending-chat-message:1");`,
				"b.spec.ts": `import { open } from "./helpers-a";\nawait createConversation(page, "x");`,
			});
			expect(found).toHaveLength(1);
			expect(found[0]).toContain("b.spec.ts");
		});

		it("leaves a spec that really sends a first message alone", () => {
			expect(
				conventionViolations({
					"c.spec.ts": `await createConversation(page, "hello");\nawait waitForAssistantResponse(page);`,
				}),
			).toEqual([]);
		});

		it("flags a poster block addressed on the page, and accepts it addressed in the board", () => {
			expect(
				conventionViolations({
					"d.spec.ts": `await expect(page.getByTestId("canvas-map")).toBeVisible();`,
				}),
			).toHaveLength(1);
			expect(
				conventionViolations({
					"d.spec.ts": `await expect(page\n\t.getByTestId('canvas-photo-thumb')).toHaveCount(6);`,
				}),
			).toHaveLength(1);
			expect(
				conventionViolations({
					"e.spec.ts": `await expect(liveBlock(page, "canvas-map")).toBeVisible();\nawait expect(page.getByTestId("canvas-chart")).toBeVisible();`,
				}),
			).toEqual([]);
		});
	});
});
