import { expect, type Locator, type Page, test } from "@playwright/test";
import {
	openDocument,
	seedDocument,
	setUiLanguage,
} from "./artifact-document-polish-helpers";
import { createConversation, login } from "./helpers";

// G3, keyboard undo and redo in the Document. Everything here is a real
// browser: the keys, the focus and the browser's own undo are what is under
// test. Playwright's Desktop Chrome reports a Windows platform, so the two key
// mappings are forced through `navigator.platform` before the page loads: the
// editor reads it live (⌘ on a Mac, Ctrl elsewhere).

type Keys = {
	platform: string;
	undo: string;
	redo: string;
	redoAlt: string;
	alfyUndo: string;
	alfyRedo: string;
	undoName: string;
	redoName: string;
};

const WINDOWS_LINUX: Keys = {
	platform: "Linux x86_64",
	undo: "Control+z",
	redo: "Control+Shift+z",
	redoAlt: "Control+y",
	alfyUndo: "Control+Alt+z",
	alfyRedo: "Control+Alt+Shift+z",
	undoName: "Undo (Ctrl+Z)",
	redoName: "Redo (Ctrl+Y)",
};

const MAC: Keys = {
	platform: "MacIntel",
	undo: "Meta+z",
	redo: "Meta+Shift+z",
	redoAlt: "Meta+y",
	alfyUndo: "Meta+Alt+z",
	alfyRedo: "Meta+Alt+Shift+z",
	undoName: "Undo (⌘Z)",
	redoName: "Redo (⇧⌘Z)",
};

async function forcePlatform(page: Page, platform: string): Promise<void> {
	await page.addInitScript((value) => {
		// Both sources a page can ask: the old `navigator.platform` and the newer
		// client hint, which Chrome fills from the (Windows) device it emulates.
		Object.defineProperty(Navigator.prototype, "platform", {
			get: () => value,
		});
		Object.defineProperty(Navigator.prototype, "userAgentData", {
			get: () => ({ platform: value === "MacIntel" ? "macOS" : "Linux" }),
		});
	}, platform);
}

/** Records, at the document (after the editor has had its say), whether each keydown was claimed. */
async function probeKeys(page: Page): Promise<void> {
	await page.evaluate(() => {
		const probe: { key: string; prevented: boolean }[] = [];
		(window as unknown as { __keys: typeof probe }).__keys = probe;
		document.addEventListener("keydown", (event) => {
			probe.push({ key: event.key, prevented: event.defaultPrevented });
		});
	});
}

async function lastKeyWasClaimed(page: Page): Promise<boolean> {
	return page.evaluate(() => {
		const probe = (
			window as unknown as { __keys: { key: string; prevented: boolean }[] }
		).__keys;
		return probe[probe.length - 1]?.prevented ?? false;
	});
}

async function text(pm: Locator): Promise<string> {
	return pm.evaluate((el) =>
		(el as HTMLElement).innerText
			.replace(/​/g, "")
			.replace(/\s*\n+\s*/g, " | ")
			.trim(),
	);
}

/** Two typing bursts, more than the history's 500ms grouping apart: two undo steps. */
async function typeTwice(page: Page, pm: Locator): Promise<void> {
	await pm.getByText("Alpha.").click();
	await page.keyboard.press("End");
	await page.keyboard.type(" one");
	await page.waitForTimeout(700);
	await page.keyboard.type(" two");
}

const isEditorFocused = (page: Page) =>
	page.evaluate(
		() =>
			!!document.activeElement?.closest(".document-editor-host .ProseMirror"),
	);

for (const [name, keys] of [
	["Windows and Linux keys", WINDOWS_LINUX],
	["Mac keys", MAC],
] as const) {
	test.describe(`Keyboard undo and redo (${name})`, () => {
		test.beforeEach(async ({ page }) => {
			await forcePlatform(page, keys.platform);
			await login(page);
		});

		test("undo, redo and the second redo binding work in the text, and each key is claimed", async ({
			page,
		}) => {
			await page.setViewportSize({ width: 1440, height: 900 });
			const conversationId = await createConversation(page, "Keys in text");
			await seedDocument(conversationId, {
				markdown: "Alpha.\n\nBeta.\n\nGamma.",
			});
			const shell = await openDocument(page, conversationId);
			const pm = shell.locator(".document-editor-host .ProseMirror");
			await probeKeys(page);
			await typeTwice(page, pm);
			expect(await text(pm)).toBe("Alpha. one two | Beta. | Gamma.");

			await page.keyboard.press(keys.undo);
			expect(await text(pm)).toBe("Alpha. one | Beta. | Gamma.");
			expect(await lastKeyWasClaimed(page)).toBe(true);
			await page.keyboard.press(keys.undo);
			expect(await text(pm)).toBe("Alpha. | Beta. | Gamma.");

			await page.keyboard.press(keys.redo);
			expect(await text(pm)).toBe("Alpha. one | Beta. | Gamma.");
			expect(await lastKeyWasClaimed(page)).toBe(true);
			await page.keyboard.press(keys.redoAlt);
			expect(await text(pm)).toBe("Alpha. one two | Beta. | Gamma.");

			// Nothing left to redo, and then nothing left to undo: the key is still
			// claimed, so the browser's own undo never rewrites the text under the
			// editor.
			await page.keyboard.press(keys.redo);
			expect(await lastKeyWasClaimed(page)).toBe(true);
			expect(await text(pm)).toBe("Alpha. one two | Beta. | Gamma.");
			await page.keyboard.press(keys.undo);
			await page.keyboard.press(keys.undo);
			await page.keyboard.press(keys.undo);
			expect(await lastKeyWasClaimed(page)).toBe(true);
			expect(await text(pm)).toBe("Alpha. | Beta. | Gamma.");
		});

		test("the toolbar's Undo and Redo hand the focus back to the text, so the keys keep working", async ({
			page,
		}) => {
			await page.setViewportSize({ width: 1440, height: 900 });
			const conversationId = await createConversation(
				page,
				"Keys after toolbar",
			);
			await seedDocument(conversationId, {
				markdown: "Alpha.\n\nBeta.\n\nGamma.",
			});
			const shell = await openDocument(page, conversationId);
			const pm = shell.locator(".document-editor-host .ProseMirror");
			await typeTwice(page, pm);

			await shell.getByRole("button", { name: keys.undoName }).click();
			await expect.poll(() => isEditorFocused(page)).toBe(true);
			expect(await text(pm)).toBe("Alpha. one | Beta. | Gamma.");

			// The focus is in the text again: the keys act on it right away.
			await page.keyboard.press(keys.undo);
			expect(await text(pm)).toBe("Alpha. | Beta. | Gamma.");
			await shell.getByRole("button", { name: keys.redoName }).click();
			await expect.poll(() => isEditorFocused(page)).toBe(true);
			expect(await text(pm)).toBe("Alpha. one | Beta. | Gamma.");
			await page.keyboard.press(keys.redo);
			expect(await text(pm)).toBe("Alpha. one two | Beta. | Gamma.");
		});

		test("the keys work with the focus on a toolbar button too, and bring the focus back to the text", async ({
			page,
		}) => {
			await page.setViewportSize({ width: 1440, height: 900 });
			const conversationId = await createConversation(
				page,
				"Keys from toolbar",
			);
			await seedDocument(conversationId, {
				markdown: "Alpha.\n\nBeta.\n\nGamma.",
			});
			const shell = await openDocument(page, conversationId);
			const pm = shell.locator(".document-editor-host .ProseMirror");
			await typeTwice(page, pm);

			// A keyboard-only reader moves to the toolbar with the arrow keys / Tab
			// and presses the undo key there.
			await shell.getByRole("button", { name: /^Bold/ }).focus();
			expect(await isEditorFocused(page)).toBe(false);
			await page.keyboard.press(keys.undo);
			expect(await text(pm)).toBe("Alpha. one | Beta. | Gamma.");
			await expect.poll(() => isEditorFocused(page)).toBe(true);

			await shell.getByRole("button", { name: /^Bold/ }).focus();
			await page.keyboard.press(keys.redo);
			expect(await text(pm)).toBe("Alpha. one two | Beta. | Gamma.");
		});

		test("Undo and Redo say their keys in the tooltip and the accessible name", async ({
			page,
		}) => {
			await page.setViewportSize({ width: 1440, height: 900 });
			const conversationId = await createConversation(page, "Tooltip keys");
			await seedDocument(conversationId, { markdown: "Some text." });
			const shell = await openDocument(page, conversationId);
			const undo = shell.getByRole("button", { name: keys.undoName });
			const redo = shell.getByRole("button", { name: keys.redoName });
			await expect(undo).toHaveAttribute("title", keys.undoName);
			await expect(redo).toHaveAttribute("title", keys.redoName);
			await expect(undo).toHaveAttribute("aria-keyshortcuts", /.+/);
		});
	});
}

test.describe("Keyboard undo and redo: what must keep its own", () => {
	test.beforeEach(async ({ page }) => {
		await forcePlatform(page, WINDOWS_LINUX.platform);
		await login(page);
	});

	test("Ctrl+Z in the comment box undoes the comment's own typing and leaves the document alone", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		const conversationId = await createConversation(page, "Keys in comment");
		await seedDocument(conversationId, {
			markdown: "Alpha and beta.\n\nBeta.\n\nGamma.",
		});
		const shell = await openDocument(page, conversationId);
		const pm = shell.locator(".document-editor-host .ProseMirror");
		await pm.getByText("Beta.", { exact: true }).click();
		await page.keyboard.press("End");
		await page.keyboard.type(" mine");
		await page.waitForTimeout(700);
		expect(await text(pm)).toBe("Alpha and beta. | Beta. mine | Gamma.");

		// Select a word and open the comment composer, then type into its box.
		await pm.getByText("Alpha and beta.").dblclick();
		await page.keyboard.press("Control+Alt+m");
		const box = page.getByRole("textbox").last();
		await box.waitFor({ timeout: 10_000 });
		await box.fill("A comment about it");
		await box.press("Control+z");

		// The document is untouched: the key was the comment box's own.
		expect(await text(pm)).toBe("Alpha and beta. | Beta. mine | Gamma.");
		await expect(box).toBeFocused();
	});
});

test.describe("Keyboard: Alfy's change stays apart from the text history", () => {
	test.beforeEach(async ({ page }) => {
		await forcePlatform(page, WINDOWS_LINUX.platform);
		await login(page);
	});

	async function seedTwoChanges(page: Page): Promise<{
		shell: Locator;
		pm: Locator;
	}> {
		await page.setViewportSize({ width: 1440, height: 900 });
		const conversationId = await createConversation(page, "Alfy chords");
		await seedDocument(conversationId, {
			markdown: "Alpha.\n\nBeta.\n\nGamma.",
			pendingOps: 2,
		});
		const shell = await openDocument(page, conversationId);
		const pm = shell.locator(".document-editor-host .ProseMirror");
		await expect(shell.getByTestId("alfy-change-bar")).toHaveCount(2, {
			timeout: 30_000,
		});
		return { shell, pm };
	}

	test("the reader's undo never takes Alfy's changes back; only Keep and Undo do", async ({
		page,
	}) => {
		const { shell, pm } = await seedTwoChanges(page);
		await pm.getByText("Gamma.").click();
		await page.keyboard.press("End");
		await page.keyboard.type(" mine");
		expect(await text(pm)).toContain("Gamma. mine");

		await page.keyboard.press("Control+z");
		expect(await text(pm)).not.toContain("mine");
		// A second, third and fourth undo have nothing of the reader's to take
		// back: Alfy's text and both pills stay.
		for (let i = 0; i < 3; i++) await page.keyboard.press("Control+z");
		const after = await text(pm);
		expect(after).toContain("Alpha. (Alfy edit 0)");
		expect(after).toContain("Beta. (Alfy edit 1)");
		await expect(shell.getByTestId("alfy-change-bar")).toHaveCount(2);
	});

	test("Ctrl+Alt+Z undoes the Alfy change in the block the caret is in, keeps the focus in the text, and Ctrl+Alt+Shift+Z brings it back", async ({
		page,
	}) => {
		const { shell, pm } = await seedTwoChanges(page);
		// The caret at the start of the second changed block (clicking its middle
		// could land on the pill that follows the text).
		await pm
			.getByText("Beta. (Alfy edit 1)")
			.click({ position: { x: 4, y: 8 } });

		await page.keyboard.press("Control+Alt+z");
		// Only the second change is undone, and its "Undone · Redo" pill sits at the
		// end of ITS block (the text got shorter: the pill must not have slid into
		// the next paragraph); the first still reads as Alfy's, pending.
		await expect
			.poll(() => text(pm))
			.toContain(
				"Alpha. (Alfy edit 0) | Alfy | Keep | Undo | Beta. | Undone | Redo | Gamma.",
			);
		expect(await isEditorFocused(page)).toBe(true);
		await expect(
			shell.getByRole("button", { name: "Redo Alfy's change" }),
		).toBeVisible();

		await page.keyboard.press("Control+Alt+Shift+z");
		await expect
			.poll(() => text(pm))
			.toContain("Beta. (Alfy edit 1) | Alfy | Keep | Undo");
		await expect(shell.getByTestId("alfy-change-bar")).toHaveCount(2);
		// The reader's own text history was not involved either way.
		await page.keyboard.press("Control+z");
		expect(await text(pm)).toContain("Beta. (Alfy edit 1)");
	});

	test("Tab reaches a pill's Keep and Undo; Enter and Space operate them as buttons and edit nothing in the text", async ({
		page,
	}) => {
		const { shell, pm } = await seedTwoChanges(page);
		const blocks = () =>
			pm.evaluate((el) => Array.from(el.children).map((c) => c.tagName));
		expect(await blocks()).toEqual(["P", "P", "P"]);
		await pm.getByText("Gamma.").click();
		await page.keyboard.press("Tab");
		await expect(
			shell.getByRole("button", { name: "Keep Alfy's change" }).first(),
		).toBeFocused();
		await page.keyboard.press("Tab");
		const undo = shell
			.getByRole("button", { name: "Undo Alfy's change" })
			.first();
		await expect(undo).toBeFocused();
		await expect(undo).toHaveAttribute(
			"title",
			"Undo Alfy's change (Ctrl+Alt+Z)",
		);

		// Enter is the button's, not the editor's ("split the paragraph"): the first
		// change is undone, the focus lands on its Redo, and no block was inserted.
		await page.keyboard.press("Enter");
		const redo = shell.getByRole("button", { name: "Redo Alfy's change" });
		await expect(redo).toBeVisible();
		await expect(redo).toBeFocused();
		expect(await blocks()).toEqual(["P", "P", "P"]);
		expect(await text(pm)).toContain("Alpha. | Undone | Redo |");

		// Space does the same on Redo, and is not typed into the text; the focus
		// moves to the fresh pill's Undo so the two can be toggled from the keys.
		await page.keyboard.press("Space");
		await expect(shell.getByTestId("alfy-change-bar")).toHaveCount(2);
		await expect(redo).toHaveCount(0);
		await expect(
			shell.getByRole("button", { name: "Undo Alfy's change" }).first(),
		).toBeFocused();
		expect(await blocks()).toEqual(["P", "P", "P"]);
		expect(await text(pm)).toContain("Alpha. (Alfy edit 0)");
	});

	test("Ctrl+Z with the focus on a pill's button undoes the reader's own typing, not Alfy's change", async ({
		page,
	}) => {
		const { shell, pm } = await seedTwoChanges(page);
		await pm.getByText("Gamma.").click();
		await page.keyboard.press("End");
		await page.keyboard.type(" mine");
		expect(await text(pm)).toContain("Gamma. mine");
		await shell
			.getByRole("button", { name: "Keep Alfy's change" })
			.first()
			.focus();
		await page.keyboard.press("Control+z");
		expect(await text(pm)).not.toContain("mine");
		await expect(shell.getByTestId("alfy-change-bar")).toHaveCount(2);
		expect(await text(pm)).toContain("Alpha. (Alfy edit 0)");
	});

	// After every Keep the whole Document body was rebuilt — editor, caret, undo
	// history, pending pills — because the workspace rendered it inside an
	// `{#await}` that shows its pending state when a `flushSync` (`tick()`, which
	// Keep's focus move awaits) lands in the turn its expression is re-read. The
	// reader's own undo history did not survive a Keep.
	test("Keep does not rebuild the editor: the same element, and what the reader typed is still undoable", async ({
		page,
	}) => {
		const { shell, pm } = await seedTwoChanges(page);
		await pm.getByText("Gamma.").click();
		await page.keyboard.press("End");
		await page.keyboard.type(" mine");
		expect(await text(pm)).toContain("Gamma. mine");
		await pm.evaluate((el) => {
			(el as HTMLElement & { __kept?: boolean }).__kept = true;
		});

		await shell
			.getByRole("button", { name: "Keep Alfy's change" })
			.first()
			.click();
		// Keep's own settle window (1.4s) and the focus move have both run.
		await expect(shell.getByTestId("alfy-change-bar")).toHaveCount(1, {
			timeout: 10_000,
		});
		await page.waitForTimeout(600);
		expect(
			await pm.evaluate(
				(el) => (el as HTMLElement & { __kept?: boolean }).__kept === true,
			),
		).toBe(true);

		// The focus is on the review bar or in the text; either way the key acts.
		await page.keyboard.press("Control+z");
		expect(await text(pm)).not.toContain("mine");
	});

	test("the chords are written in Hungarian on a Hungarian UI", async ({
		page,
	}) => {
		await setUiLanguage("hu");
		try {
			const { shell } = await seedTwoChanges(page);
			await expect(
				shell
					.getByRole("button", { name: /^Visszavonom — Alfy módosítása/ })
					.first(),
			).toHaveAttribute("title", "Visszavonom — Alfy módosítása (Ctrl+Alt+Z)");
			await expect(
				shell.getByRole("button", { name: "Visszavonás (Ctrl+Z)" }),
			).toBeVisible();
		} finally {
			await setUiLanguage("en");
		}
	});
});
