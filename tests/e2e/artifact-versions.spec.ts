import { expect, type Locator, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import { users } from "../../src/lib/server/db/schema";
import {
	createDocumentArtifact,
	listVersions,
	updateArtifactBody,
} from "../../src/lib/server/services/artifacts";
import { runReadArtifactTool } from "../../src/lib/server/services/normal-chat-tools/artifact-tools/read";
import {
	AI_SMOKE_EDIT_ARTIFACT_FINAL_TEXT,
	AI_SMOKE_EDIT_ARTIFACT_MARKER,
	encodeEditArtifactScenarioPayload,
} from "../fixtures/ai/openai-compatible-scenarios";
import { createOpenAICompatibleProviderHarness } from "../mocks/ai-provider/openai-compatible-provider";
import {
	createTemporaryFakeProviderModel,
	deleteTemporaryProvider,
	snapshotUserModelPreference,
	updateUserModelPreference,
} from "./artifact-live-edit.helpers";
import { createEmptyConversation, login, sendMessage } from "./helpers";

// Wave 2.5 polish G1-B (owner: "the version numbers are all over the place —
// in the overview I see v5, inside it's only v3, and in the versions tab I
// see a v4 but no v5"), rebuilt for ruling 76: there is no number to compare
// any more, but there is still ONE answer to "what happened last", and four
// surfaces must give it (the panel header's history button, the panel list row,
// the in-chat card and History's top moment). This walks the whole life of one
// Document — created, edited by the reader, edited live by Alfy, that change
// reviewed from History and undone, an older version restored, the restore
// undone from its toast — with real pointer and keyboard input and a real
// `edit_artifact` call, and asks every surface at every step, against the
// server's own newest version row. It is also the Document's History story
// (versioning.md §11 T1): the folded Undo, no "v4" anywhere, the restore from
// the preview confirmed with Enter, the source marked "Restored from here",
// the toast's Undo folding the pair, and the same rail after a reload.

async function testUserId(): Promise<string> {
	const [user] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, "admin@local"))
		.limit(1);
	expect(user, "the e2e admin must exist").toBeTruthy();
	return user.id;
}

async function serverVersions(artifactId: string) {
	return listVersions({ userId: await testUserId(), artifactId });
}

async function openChatAndReload(page: Page, conversationId: string) {
	await page.evaluate((id) => {
		window.sessionStorage.removeItem(`pending-chat-message:${id}`);
	}, conversationId);
	await page.goto(`/chat/${conversationId}`);
	await page.reload({ waitUntil: "networkidle" });
}

/** The showing shell's history button (both shells are real DOM nodes; only the visible one counts). */
function historyButton(page: Page): Locator {
	return page
		.locator('[data-testid="artifact-history-button"]:visible')
		.first();
}

function doneButton(page: Page): Locator {
	return page.locator('[data-testid="artifact-history-done"]:visible').first();
}

async function openDocumentFromPanel(page: Page): Promise<void> {
	const countButton = page.getByTestId("artifact-count-button");
	if ((await countButton.getAttribute("aria-pressed")) !== "true") {
		await countButton.click();
	}
	await page
		.getByTestId("artifact-panel-list")
		.getByTestId("artifact-row")
		.first()
		.click({ timeout: 30_000 });
	await expect(historyButton(page)).toBeVisible({ timeout: 30_000 });
}

async function backToList(page: Page): Promise<void> {
	await page.locator(".artifact-panel-header-crumb:visible").first().click();
	await expect(page.getByTestId("artifact-panel-list")).toBeVisible();
}

const WHEN = "(?:just now|\\d+ min ago)";

/** What the surfaces say right now, read the way a person reads them. */
async function readSurfaces(page: Page, withCard: boolean) {
	const header = (await historyButton(page).textContent())
		?.replace(/\s+/g, " ")
		.trim();
	const card = withCard
		? (await page.getByTestId("artifact-card-head").last().textContent())
				?.replace(/\s+/g, " ")
				.trim()
		: undefined;

	await backToList(page);
	const row = (
		await page
			.getByTestId("artifact-panel-list")
			.getByTestId("artifact-row")
			.first()
			.textContent()
	)
		?.replace(/\s+/g, " ")
		.trim();
	await page
		.getByTestId("artifact-panel-list")
		.getByTestId("artifact-row")
		.first()
		.click();
	await expect(historyButton(page)).toBeVisible();
	return { header, card, row };
}

/**
 * Every surface agrees with the server's newest row: the header says the right
 * words and the time, the list row and the chat card say the same time, and no
 * surface prints a version number.
 */
async function expectSurfaces(
	page: Page,
	artifactId: string,
	expected: { version: number; header: RegExp },
	label: string,
	withCard: boolean,
) {
	await expect
		.poll(async () => (await serverVersions(artifactId))[0]?.versionNumber, {
			message: `${label}: the server's newest version`,
			timeout: 15_000,
		})
		.toBe(expected.version);
	await expect(historyButton(page), `${label}: the header`).toContainText(
		expected.header,
		{ timeout: 15_000 },
	);
	const seen = await readSurfaces(page, withCard);
	expect(seen.header, `${label}: the header's words`).toMatch(expected.header);
	expect(seen.header, `${label}: the header's time`).toMatch(new RegExp(WHEN));
	expect(seen.row, `${label}: the list row's time`).toMatch(new RegExp(WHEN));
	expect(seen.row, `${label}: the list row prints no number`).not.toMatch(
		/\bv\d+\b/,
	);
	if (withCard) {
		expect(seen.card, `${label}: the chat card's last fact`).toMatch(
			new RegExp(`edited ${WHEN}`),
		);
		expect(seen.card, `${label}: the chat card prints no number`).not.toMatch(
			/\bv\d+\b/,
		);
	}
	expect(seen.header, `${label}: the header prints no number`).not.toMatch(
		/\bv\d+\b/,
	);
}

test.describe("one latest moment on every surface", () => {
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

	test("create → user edit → Alfy edit → review → Undo → restore → undo the restore: the header, the list row, the chat card and History agree at every step, and after a reload", {
		tag: "@smoke",
	}, async ({ page }) => {
		test.setTimeout(300_000);
		await page.setViewportSize({ width: 1440, height: 900 });
		await login(page);
		const previousModelPreference = await snapshotUserModelPreference(page);
		let providerId: string | null = null;
		try {
			const conversationId = await createEmptyConversation(page);
			const userId = await testUserId();
			const artifact = await createDocumentArtifact({
				userId,
				conversationId,
				title: "Moment walk",
				markdown: "Book the hotel.\n\nBook the flight.",
				author: "user",
				summary: "Seeded for E2E",
			});
			const artifactId = artifact.id;

			const temporary = await createTemporaryFakeProviderModel(
				page,
				fakeProvider.baseURL,
			);
			providerId = temporary.providerId;
			await updateUserModelPreference(page, temporary.selectedModel);

			await openChatAndReload(page, conversationId);
			await openDocumentFromPanel(page);

			// v1 — created.
			await expectSurfaces(
				page,
				artifactId,
				{ version: 1, header: /Edited by you/ },
				"created",
				false,
			);

			// v2 — the reader types (autosave; a fresh version because v1 was a seed).
			const editor = page.locator(".document-editor-host .document-content");
			await editor.getByText("Book the flight.").click();
			await page.keyboard.press("End");
			await page.keyboard.type(" Window seat.");
			await expectSurfaces(
				page,
				artifactId,
				{ version: 2, header: /Edited by you/ },
				"user edit",
				false,
			);

			// v3 — Alfy edits live (a real edit_artifact call). Alfy's own read
			// happens first, so her edit is not refused as "your words win".
			const read = await runReadArtifactTool({
				userId,
				conversationId,
				artifactId,
				detail: "blocks",
				abortSignal: new AbortController().signal,
			});
			const blocks =
				read.modelPayload.success && "blocks" in read.modelPayload
					? (read.modelPayload.blocks as Array<{
							blockId: string;
							hash: string;
							text: string;
						}>)
					: [];
			const applyBlock = blocks.find((b) => b.text === "Book the hotel.");
			const refuseBlock = blocks.find((b) =>
				b.text.startsWith("Book the flight."),
			);
			expect(applyBlock, "the hotel block").toBeTruthy();
			expect(refuseBlock, "the flight block").toBeTruthy();
			await sendMessage(
				page,
				`${AI_SMOKE_EDIT_ARTIFACT_MARKER} ${encodeEditArtifactScenarioPayload({
					artifactId,
					applyBlockId: applyBlock?.blockId ?? "",
					applyBaseHash: applyBlock?.hash ?? "",
					refuseBlockId: refuseBlock?.blockId ?? "",
				})}`,
			);
			await expect(
				page.getByText(AI_SMOKE_EDIT_ARTIFACT_FINAL_TEXT),
			).toBeVisible({ timeout: 30_000 });
			await expectSurfaces(
				page,
				artifactId,
				{ version: 3, header: /Changed by Alfy/ },
				"Alfy edit",
				true,
			);

			// History says the change waits for the reader, and "Review" leads back to
			// the one place that decides it (the pill and the review bar, never History).
			await historyButton(page).click();
			const region = page.getByRole("region", {
				name: "History of Moment walk",
			});
			await expect(region).toBeVisible();
			const top = region.getByRole("option").first();
			await expect(top).toContainText("Waiting for you");
			await expect(top).toContainText("Now");
			await expect(
				region.getByRole("button", { name: /Review/ }).first(),
			).toBeVisible();
			// "From the chat": the message whose call made the version, flashed.
			await region
				.getByRole("button", { name: /From the chat/ })
				.first()
				.click();
			await expect(page.locator(".history-flash")).toHaveCount(1);
			await region
				.getByRole("button", { name: /Review/ })
				.first()
				.click();
			await expect(region).toHaveCount(0);
			await expect(page.getByTestId("alfy-change-bar")).toBeVisible();

			// v4 — the reader undoes Alfy's change with a click on the pill: its own
			// version, naming the Alfy version it undid.
			await page
				.getByTestId("alfy-change-bar")
				.getByRole("button", { name: "Undo Alfy's change" })
				.click();
			await expectSurfaces(
				page,
				artifactId,
				{ version: 4, header: /Alfy's change undone/ },
				"Undo",
				true,
			);
			expect((await serverVersions(artifactId))[0]?.summary).toMatch(
				/^Undid Alfy's change: v3$/,
			);

			// History tells the two as one story, "↳ You undid it", and prints no "v4".
			await historyButton(page).click();
			await expect(region).toBeVisible();
			const options = region.getByRole("option");
			await expect(options).toHaveCount(4);
			await expect(options.nth(0)).toHaveAccessibleName(
				/Today \d\d:\d\d, Alfy.*Undone\./,
			);
			await expect(options.nth(0)).toContainText("Undone");
			await expect(options.nth(1)).toContainText("You undid it");
			await expect(region).not.toContainText(/\bv4\b/);
			// ↓ moves the selection, and the preview follows.
			await expect(options.nth(0)).toBeFocused();
			await page.keyboard.press("ArrowDown");
			await page.keyboard.press("ArrowDown");
			await expect(options.nth(2)).toHaveAttribute("aria-selected", "true");
			await expect(region.getByTestId("history-title")).toContainText(
				"You edited",
			);
			await expect(region.getByTestId("history-preview")).toContainText(
				"Window seat.",
			);

			// v5 — restore the first version from the preview: a click asks, Enter confirms.
			await options.nth(3).click();
			await region.getByTestId("history-restore").click();
			const question = region.getByTestId("history-restore-question");
			await expect(question).toBeVisible();
			await expect(question).toContainText("Bring back");
			await expect(region.getByTestId("history-restore-confirm")).toBeFocused();
			await page.keyboard.press("Enter");
			await expect(page.getByTestId("history-toast")).toContainText("Restored");
			// The new top moment, selected, and the source says where it was restored.
			await expect(options.first()).toHaveAttribute("aria-selected", "true");
			await expect(options.first()).toContainText("You restored");
			await expect(
				region
					.getByTestId("history-option")
					.filter({ hasText: "Restored from here" }),
			).toHaveCount(1);
			await expect(
				region.getByRole("option", { name: /Restored from here/ }),
			).toHaveCount(1);
			await expect
				.poll(async () => (await serverVersions(artifactId))[0]?.versionNumber)
				.toBe(5);

			// v6 — the toast's Undo reverses the restore, and the two fold into one quiet moment.
			await page.getByTestId("history-toast-undo").click();
			await expect
				.poll(async () => (await serverVersions(artifactId))[0]?.versionNumber)
				.toBe(6);
			// It names the restore it reverses (version 5), which is what lets the two fold.
			expect((await serverVersions(artifactId))[0]?.summary).toBe(
				"Undid restoring v5",
			);
			await expect(region.getByRole("option").first()).toContainText(
				"You restored",
			);
			await expect(region.getByRole("option").nth(1)).toContainText(
				"You undid the restore",
			);
			await doneButton(page).click();
			await expect(region).toHaveCount(0);
			await expectSurfaces(
				page,
				artifactId,
				{ version: 6, header: /Edited by you/ },
				"undo the restore",
				true,
			);

			// A reload rebuilds every surface from stored state, and History shows the same rail.
			await page.reload({ waitUntil: "networkidle" });
			await expect(historyButton(page)).toBeVisible({ timeout: 30_000 });
			await expectSurfaces(
				page,
				artifactId,
				{ version: 6, header: /Edited by you/ },
				"after a reload",
				true,
			);
			await historyButton(page).click();
			const again = page.getByRole("region", {
				name: "History of Moment walk",
			});
			await expect(again.getByRole("option")).toHaveCount(6);
			await expect(again.getByRole("option").first()).toContainText(
				"You restored",
			);
			await expect(again.getByRole("option").nth(1)).toContainText(
				"You undid the restore",
			);
		} finally {
			await updateUserModelPreference(page, previousModelPreference);
			if (providerId) await deleteTemporaryProvider(page, providerId);
		}
	});
});

// ---- the restore toast's exit (polish G1-B, redesign §7.2 #33) ---------------

/** A Document with `extra` more versions on top of v1, alternating authors, so the history has something to show. */
async function seedDocumentWithVersions(
	conversationId: string,
	extra: number,
): Promise<string> {
	const userId = await testUserId();
	const artifact = await createDocumentArtifact({
		userId,
		conversationId,
		title: "Toast walk",
		markdown: "Book the hotel.\n\nBook the flight.",
		author: "alfy",
		summary: "Alfy wrote the first draft",
	});
	for (let i = 1; i <= extra; i++) {
		await updateArtifactBody({
			userId,
			artifactId: artifact.id,
			conversationId,
			body: `Book the hotel.\n\nBook the flight. Revision ${i}.`,
			author: i % 2 === 0 ? "alfy" : "user",
			summary: `A summary that is long enough to need an ellipsis in a narrow row, number ${i}`,
		});
	}
	return artifact.id;
}

/** Restores the oldest version from History's preview, so the toast shows. */
async function restoreOldestFromHistory(page: Page, title: string) {
	await historyButton(page).click();
	const region = page.getByRole("region", { name: `History of ${title}` });
	await expect(region).toBeVisible();
	await region.getByRole("option").last().click();
	await region.getByTestId("history-restore").click();
	await region.getByTestId("history-restore-confirm").click();
	await expect(page.getByTestId("history-toast")).toBeVisible();
}

/** Watches the toast leave, frame by frame, the way a person sees it: from the first frame it begins to fade until it is gone. */
async function watchToastLeave(page: Page) {
	return page.evaluate(
		() =>
			new Promise<{
				gone: boolean;
				minOpacity: number;
				maxSink: number;
				exitMs: number;
			}>((resolve) => {
				const el = document.querySelector(
					'[data-testid="history-toast"]',
				) as HTMLElement;
				let minOpacity = 1;
				let maxSink = 0;
				let exitStart: number | null = null;
				const started = performance.now();
				const frame = () => {
					const now = performance.now();
					if (!el.isConnected) {
						return resolve({
							gone: true,
							minOpacity,
							maxSink,
							exitMs: exitStart === null ? 0 : now - exitStart,
						});
					}
					const style = getComputedStyle(el);
					const opacity = Number.parseFloat(style.opacity);
					minOpacity = Math.min(minOpacity, opacity);
					const matrix = new DOMMatrixReadOnly(
						style.transform === "none" ? undefined : style.transform,
					);
					// The toast is centred with a translateX(-50%): only the sink (y) is its motion.
					maxSink = Math.max(maxSink, matrix.m42);
					if (opacity < 0.95 && exitStart === null) exitStart = now;
					if (now - started > 9000) {
						return resolve({ gone: false, minOpacity, maxSink, exitMs: 0 });
					}
					requestAnimationFrame(frame);
				};
				requestAnimationFrame(frame);
			}),
	);
}

test.describe("the restore toast's exit", () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await login(page);
	});

	test("fades and sinks away, then leaves the DOM", async ({ page }) => {
		test.setTimeout(120_000);
		const conversationId = await createEmptyConversation(page);
		await seedDocumentWithVersions(conversationId, 2);
		await openChatAndReload(page, conversationId);
		await openDocumentFromPanel(page);
		await restoreOldestFromHistory(page, "Toast walk");

		// Let its entrance finish first, so what is measured is the exit alone.
		await page.waitForTimeout(600);
		const seen = await watchToastLeave(page);

		expect(seen.gone, "the toast leaves the DOM").toBe(true);
		expect(seen.minOpacity, "it faded on its way out").toBeLessThan(0.9);
		expect(seen.maxSink, "it sank on its way out").toBeGreaterThan(2);
		// The standard duration, not an instant cut and not a slow fade.
		expect(seen.exitMs).toBeGreaterThan(40);
		expect(seen.exitMs).toBeLessThan(700);
	});

	test("leaves at once when the person asked for reduced motion", async ({
		page,
	}) => {
		test.setTimeout(120_000);
		await page.emulateMedia({ reducedMotion: "reduce" });
		const conversationId = await createEmptyConversation(page);
		await seedDocumentWithVersions(conversationId, 2);
		await openChatAndReload(page, conversationId);
		await openDocumentFromPanel(page);
		await restoreOldestFromHistory(page, "Toast walk");

		const seen = await watchToastLeave(page);

		expect(seen.gone).toBe(true);
		expect(seen.minOpacity, "no fade was ever visible").toBe(1);
		expect(seen.maxSink, "no movement was ever visible").toBe(0);
	});
});
