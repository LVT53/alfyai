import { expect, type Locator, type Page, test } from "@playwright/test";
import { readDocumentForAlfy } from "../../src/lib/server/services/artifacts";
import {
	AI_SMOKE_EDIT_DOCUMENT_SLOWLY_FINAL_TEXT,
	AI_SMOKE_EDIT_DOCUMENT_SLOWLY_MARKER,
	encodeEditDocumentSlowlyPayload,
} from "../fixtures/ai/openai-compatible-scenarios";
import { createOpenAICompatibleProviderHarness } from "../mocks/ai-provider/openai-compatible-provider";
import {
	box,
	openDocument,
	seedDocument,
	setUiLanguage,
	testUserId,
} from "./artifact-document-polish-helpers";
import {
	createTemporaryFakeProviderModel,
	deleteTemporaryProvider,
	snapshotUserModelPreference,
	updateUserModelPreference,
} from "./artifact-live-edit.helpers";
import {
	createEmptyConversation,
	login,
	sendMessage,
	waitForStableBoundingBox,
} from "./helpers";

// The friction build's Document findings (ruling 77, FB-6): F6 Alfy is visibly at
// work, F13 a one-row review bar on a phone, F14 an @Alfy comment feels answered,
// F18 Keep does not move the text, F24 the comments column takes no room until
// there is a comment, F28 the add-tab button says what it does. Hungarian, the
// owner's language; every action is a real pointer, key or touch.

const MARKDOWN = [
	"# Bécsi hétvége",
	"",
	"Két nap a barátnőddel: szombat és vasárnap. A programok nagy része esőben is megy.",
	"",
	"## Szombat",
	"",
	"Schönbrunn és a Gloriette kilátása. Érdemes korán érkezni a tömeg elkerülése végett.",
	"",
	"Délben a Naschmarkt, utána a Karlsplatz.",
].join("\n");

test.beforeEach(async ({ page }) => {
	await setUiLanguage("hu");
	await login(page);
});

test.afterEach(async () => {
	await setUiLanguage("en");
});

/** Selects one word of the text with a real double click, where the browser draws it. */
async function selectWord(
	page: Page,
	shell: Locator,
	word: string,
): Promise<void> {
	const rect = await shell
		.locator(".document-editor-host .ProseMirror")
		.evaluate((root, target) => {
			const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
			for (let node = walker.nextNode(); node; node = walker.nextNode()) {
				const at = (node.textContent ?? "").indexOf(target);
				if (at === -1) continue;
				const range = document.createRange();
				range.setStart(node, at);
				range.setEnd(node, at + target.length);
				const r = range.getBoundingClientRect();
				return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
			}
			throw new Error(`"${target}" is not in the text`);
		}, word);
	await page.mouse.dblclick(rect.x, rect.y);
}

test.describe("F28 the add-tab button says what it does", () => {
	test("the single-tab strip shows the button's words, not a bare plus", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		const conversationId = await createEmptyConversation(page, "F28");
		await seedDocument(conversationId, {
			markdown: MARKDOWN,
			title: "Bécsi hétvége",
		});
		const shell = await openDocument(page, conversationId);
		const add = shell.getByRole("button", { name: "Fül hozzáadása" });
		await expect(add).toBeVisible();
		// The words are on the button itself (not only in its accessible name).
		await expect(add).toHaveText("Fül hozzáadása");
		// And it still adds one.
		await add.click();
		await expect(shell.getByRole("tab")).toHaveCount(2);
	});
});

test.describe("F24 the comments column takes no room until there is a comment", () => {
	test("a Document with no comments has no column, a quiet way to open one, and the text gets the room", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		const conversationId = await createEmptyConversation(page, "F24");
		await seedDocument(conversationId, {
			markdown: MARKDOWN,
			title: "Bécsi hétvége",
		});
		const shell = await openDocument(page, conversationId);
		await expect(shell.locator(".document-content-rail")).toHaveCount(0);
		const content = await box(
			shell.locator(".document-main > .document-content"),
		);
		const text = await box(shell.locator(".document-content-text"));
		// Whatever stands beside the text is a quiet strip, not a 300 px column.
		expect(content.width - text.width).toBeLessThan(64);
		await expect(
			shell.getByTestId("document-comments-affordance"),
		).toBeVisible();
	});

	test("the first comment brings the column, with the comment in it", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		const conversationId = await createEmptyConversation(page, "F24 first");
		await seedDocument(conversationId, {
			markdown: MARKDOWN,
			title: "Bécsi hétvége",
		});
		const shell = await openDocument(page, conversationId);
		await expect(shell.locator(".document-content-rail")).toHaveCount(0);
		await selectWord(page, shell, "Naschmarkt");
		await page
			.getByTestId("selection-bubble")
			.getByRole("button", { name: "Megjegyzés", exact: true })
			.click();
		await page.getByRole("textbox").last().fill("Ide menjünk ebédelni.");
		await page
			.getByTestId("selection-bubble")
			.getByRole("button", { name: "Megjegyzés", exact: true })
			.last()
			.click();
		const rail = shell.locator(".document-content-rail");
		await expect(rail).toBeVisible();
		await expect(rail.getByText("Ide menjünk ebédelni.")).toBeVisible();
		await expect(shell.getByTestId("document-comments-affordance")).toHaveCount(
			0,
		);
	});

	test("the quiet way opens the empty column, and the header's button closes it again", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		const conversationId = await createEmptyConversation(page, "F24 toggle");
		await seedDocument(conversationId, {
			markdown: MARKDOWN,
			title: "Bécsi hétvége",
		});
		const shell = await openDocument(page, conversationId);
		await shell.getByTestId("document-comments-affordance").click();
		const rail = shell.locator(".document-content-rail");
		await expect(rail).toBeVisible();
		await expect(rail).toContainText("Még nincs megjegyzés");
		const toggle = shell.getByTestId("artifact-comments-button");
		await expect(toggle).toHaveAttribute("aria-pressed", "true");
		await toggle.click();
		await expect(rail).toHaveCount(0);
		await expect(toggle).toHaveAttribute("aria-pressed", "false");
		await expect(
			shell.getByTestId("document-comments-affordance"),
		).toBeVisible();
	});
});

test.describe("F13 a pending change's review bar is one row on a phone", () => {
	test.use({ hasTouch: true });

	for (const [width, height, pendingOps] of [
		[390, 844, 2],
		[390, 844, 1],
		[360, 740, 2],
	] as const) {
		test(`count, the stepper where there is something to step through, Keep and Undo share one row of 44 px targets (${width}x${height}, ${pendingOps} pending)`, async ({
			page,
		}) => {
			await page.setViewportSize({ width, height });
			const conversationId = await createEmptyConversation(page, "F13");
			await seedDocument(conversationId, {
				markdown: MARKDOWN,
				title: "Bécsi hétvége",
				pendingOps,
			});
			const shell = await openDocument(page, conversationId);
			const bar = shell.getByRole("region", { name: "Alfy módosításai" });
			await expect(bar).toBeVisible({ timeout: 30_000 });
			await waitForStableBoundingBox(bar);

			const keep = bar.getByRole("button", { name: /Mindet megtartom/ });
			const undo = bar.getByRole("button", { name: /Mindet visszavonom/ });
			const parts = [keep, undo];
			if (pendingOps > 1) {
				await expect(bar.getByText(`1 / ${pendingOps}`)).toBeVisible();
				parts.push(
					bar.getByRole("button", { name: "Előző módosítás" }),
					bar.getByRole("button", { name: "Következő módosítás" }),
					bar.getByText(`1 / ${pendingOps}`),
				);
			} else {
				await expect(bar).toContainText("Alfy 1 részt módosított");
			}

			// One row: the bar is one button tall, and every part is centred on that row.
			const barBox = await box(bar);
			expect(barBox.height, "the bar's height").toBeLessThanOrEqual(64);
			const centres: number[] = [];
			for (const part of parts) {
				const b = await box(part);
				centres.push(b.y + b.height / 2);
				expect(b.x, "inside the screen").toBeGreaterThanOrEqual(0);
				expect(b.x + b.width, "inside the screen").toBeLessThanOrEqual(width);
			}
			expect(Math.max(...centres) - Math.min(...centres)).toBeLessThanOrEqual(
				2,
			);

			// 44 px targets, and a finger does the work.
			for (const control of parts.slice(0, pendingOps > 1 ? 4 : 2)) {
				const b = await box(control);
				expect(b.height).toBeGreaterThanOrEqual(43.5);
				expect(b.width).toBeGreaterThanOrEqual(43.5);
			}
			if (pendingOps > 1) {
				await bar.getByRole("button", { name: "Következő módosítás" }).tap();
				await expect(bar.getByText(`2 / ${pendingOps}`)).toBeVisible();
			}
			await keep.tap();
			await expect(bar).toBeHidden();
		});
	}
});

test.describe("F14 an @Alfy comment feels answered", () => {
	test("the composer closes at once, the thread says Alfy is replying until the reply comes, and a second press sends nothing more", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		const conversationId = await createEmptyConversation(page, "F14");
		await seedDocument(conversationId, {
			markdown: MARKDOWN,
			title: "Bécsi hétvége",
		});

		// Alfy's answer is held by the test (a slow model): everything else is the real
		// server, and the answer itself is whatever the real route says once released.
		const asks: string[] = [];
		const posts: string[] = [];
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		await page.route("**/api/artifacts/*/comments/*/alfy*", async (route) => {
			asks.push(route.request().url());
			await gate;
			await route.continue();
		});
		page.on("request", (request) => {
			if (
				request.method() === "POST" &&
				/\/api\/artifacts\/[^/]+\/comments(\?|$)/.test(request.url())
			) {
				posts.push(request.url());
			}
		});

		const shell = await openDocument(page, conversationId);
		await selectWord(page, shell, "Naschmarkt");
		const bubble = page.getByTestId("selection-bubble");
		await bubble.getByRole("button", { name: "Alfy megkérdezése" }).click();
		await bubble.getByRole("textbox").fill("bővítsd ki ezt");
		// A second press right behind the first.
		await bubble.getByRole("button", { name: "Alfy megkérdezése" }).dblclick();

		// The composer is gone while Alfy has not answered, and the thread says so.
		await expect(bubble).toBeHidden({ timeout: 3_000 });
		const rail = shell.locator(".document-content-rail");
		await expect(rail.getByText("bővítsd ki ezt")).toBeVisible();
		await expect(
			rail.getByRole("status").filter({ hasText: "Alfy válaszol…" }),
		).toBeVisible();

		release();
		await expect(
			rail.getByRole("status").filter({ hasText: "Alfy válaszol…" }),
		).toBeHidden({ timeout: 20_000 });
		// One comment was posted and Alfy was asked once.
		expect(posts).toHaveLength(1);
		expect(asks).toHaveLength(1);
	});
});

test.describe("F18 Keep does not make the text jump", () => {
	test.use({ hasTouch: true });

	test("what is below a change moves up over a moment, not 28 px in a frame, when Keep sends its pill away", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		const conversationId = await createEmptyConversation(page, "F18");
		await seedDocument(conversationId, {
			markdown: [
				"# Bécsi hétvége",
				"",
				"Két nap a barátnőddel: szombat és vasárnap. A programok nagy része esőben is megy, de a szabadtéri helyszínekre érdemes napos időt választani, mert a kilátás az egyik fő attrakció.",
				"",
				"## Szombat",
				"",
				"Schönbrunn és a Gloriette kilátása. Érdemes korán érkezni a tömeg elkerülése végett.",
				"",
				"Délben a Naschmarkt, utána a Karlsplatz.",
			].join("\n"),
			title: "Bécsi hétvége",
			pendingOps: 2,
		});
		const shell = await openDocument(page, conversationId);
		const bar = shell.getByRole("region", { name: "Alfy módosításai" });
		await expect(bar).toBeVisible({ timeout: 30_000 });
		await expect(
			shell.getByRole("group", { name: /Alfy módosítása/ }),
		).toHaveCount(2);

		// Where the last paragraph is, on every frame, from just before the press.
		await page.evaluate(() => {
			const w = window as unknown as { __tops: number[] };
			w.__tops = [];
			const tick = () => {
				const last = Array.from(
					document.querySelectorAll(".document-editor-host .ProseMirror p"),
				).find((p) => (p.textContent ?? "").startsWith("Délben a Naschmarkt"));
				if (last) w.__tops.push(last.getBoundingClientRect().top);
				requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
		});
		await page.waitForTimeout(300);
		await bar.getByRole("button", { name: /Mindet megtartom/ }).tap();
		// The pills say "kept" for a moment, then go.
		await expect(
			shell.getByRole("group", { name: /Alfy módosítása/ }),
		).toHaveCount(0, { timeout: 10_000 });
		await page.waitForTimeout(500);

		const tops = await page.evaluate(
			() => (window as unknown as { __tops: number[] }).__tops,
		);
		const steps = tops.slice(1).map((top, i) => Math.abs(top - tops[i]));
		const moved = tops[0] - tops[tops.length - 1];
		expect(moved, "the text did come up when the pills left").toBeGreaterThan(
			30,
		);
		expect(
			Math.max(...steps),
			"the biggest move between two frames",
		).toBeLessThan(14);
	});
});

test.describe("F6 the Document shows Alfy at work", () => {
	const fakeProvider = createOpenAICompatibleProviderHarness();

	test.beforeAll(async () => {
		await fakeProvider.start();
	});

	test.afterAll(async () => {
		await fakeProvider.stop();
	});

	test.beforeEach(async () => {
		await fakeProvider.reset();
	});

	/** The Document open in the panel, and a turn on it whose model reads it, takes `delayMs` to write its patch, then applies it. */
	async function askForSlowEdit(page: Page, delayMs: number) {
		const previousModelPreference = await snapshotUserModelPreference(page);
		const temporaryProvider = await createTemporaryFakeProviderModel(
			page,
			fakeProvider.baseURL,
		);
		await updateUserModelPreference(page, temporaryProvider.selectedModel);
		const conversationId = await createEmptyConversation(page, "F6");
		const artifactId = await seedDocument(conversationId, {
			markdown: MARKDOWN,
			title: "Bécsi hétvége",
		});
		const read = await readDocumentForAlfy({
			userId: await testUserId(),
			artifactId,
			conversationId,
		});
		const target = read.blocks.find((block) =>
			block.text.startsWith("Délben a Naschmarkt"),
		);
		expect(target, "the block Alfy will change").toBeTruthy();
		const shell = await openDocument(page, conversationId);
		await sendMessage(
			page,
			`${AI_SMOKE_EDIT_DOCUMENT_SLOWLY_MARKER} ${encodeEditDocumentSlowlyPayload(
				{
					artifactId,
					blockId: target?.blockId ?? "",
					baseHash: target?.hash ?? "",
					delayMs,
					text: "Délben a Naschmarkt, utána a Karlsplatz és a Hundertwasserhaus.",
				},
			)}`,
		);
		return {
			shell,
			cleanup: async () => {
				await updateUserModelPreference(page, previousModelPreference);
				await deleteTemporaryProvider(page, temporaryProvider.providerId);
			},
		};
	}

	test("the panel says so from the model's first look at the Document until the change lands", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		const { shell, cleanup } = await askForSlowEdit(page, 4_000);
		try {
			const working = shell.getByTestId("alfy-writing");
			// The model has the Document in hand and is writing its patch: nothing has
			// changed yet, and the panel already says Alfy is on it.
			await expect(working).toContainText("Alfy dolgozik a dokumentumon", {
				timeout: 20_000,
			});
			await expect(shell.getByTestId("alfy-change-bar")).toHaveCount(0);
			await page.waitForTimeout(1_500);
			await expect(working).toBeVisible();

			// The change lands, and the state goes with it.
			await expect(shell.getByTestId("alfy-change-bar").first()).toBeVisible({
				timeout: 30_000,
			});
			await expect(working).toHaveCount(0);
			await expect(
				page.getByText(AI_SMOKE_EDIT_DOCUMENT_SLOWLY_FINAL_TEXT),
			).toBeVisible();
		} finally {
			await cleanup();
		}
	});

	test("a stopped turn does not leave it standing", async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		const { shell, cleanup } = await askForSlowEdit(page, 30_000);
		try {
			const working = shell.getByTestId("alfy-writing");
			await expect(working).toContainText("Alfy dolgozik a dokumentumon", {
				timeout: 20_000,
			});
			await page.getByTestId("stop-button").click();
			await expect(working).toHaveCount(0, { timeout: 10_000 });
			await expect(page.getByTestId("stop-button")).toHaveCount(0);
			// Nothing was changed, and nothing waits for review.
			await expect(shell.getByTestId("alfy-change-bar")).toHaveCount(0);
			await expect(
				shell.getByRole("region", { name: "Alfy módosításai" }),
			).toHaveCount(0);
		} finally {
			await cleanup();
		}
	});
});
