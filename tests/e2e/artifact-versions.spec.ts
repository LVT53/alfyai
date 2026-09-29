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
import {
	createConversation,
	login,
	sendMessage,
	waitForMotionToSettle,
} from "./helpers";

// Wave 2.5 polish G1-B (owner: "the version numbers are all over the place —
// in the overview I see v5, inside it's only v3, and in the versions tab I
// see a v4 but no v5"). Four surfaces show one artifact's version: the panel
// list row, the in-chat card, the panel header's version button and the
// Versions popover's own current row. This walks the whole life of one
// Document — created, edited by the user, edited live by Alfy, that edit
// undone, an older version restored, the restore undone — and asks every
// surface at every step, against the server's own newest version row.

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

async function serverVersion(artifactId: string): Promise<number> {
	return (await serverVersions(artifactId))[0]?.versionNumber ?? 0;
}

async function openChatAndReload(page: Page, conversationId: string) {
	await page.evaluate((id) => {
		window.sessionStorage.removeItem(`pending-chat-message:${id}`);
	}, conversationId);
	await page.goto(`/chat/${conversationId}`);
	await page.reload({ waitUntil: "networkidle" });
}

function versionOf(text: string | null | undefined): string | null {
	return text?.match(/\bv(\d+)\b/)?.[0] ?? null;
}

/**
 * The desktop shell's own version button (both shells are real DOM nodes;
 * only the visible one counts). Until the Document's body has loaded and
 * registered its Versions action the same pill is plain text, not a button —
 * on a cold dev server that is several seconds — so only the button counts.
 */
function headerPill(page: Page): Locator {
	return page
		.locator('button[data-testid="artifact-version-pill"]:visible')
		.first();
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
	await expect(headerPill(page)).toBeVisible({ timeout: 30_000 });
}

async function backToList(page: Page): Promise<void> {
	await page.locator(".artifact-panel-header-crumb:visible").first().click();
	await expect(page.getByTestId("artifact-panel-list")).toBeVisible();
}

/** What the four surfaces say right now, read the way a person reads them. */
async function readSurfaces(page: Page, withCard: boolean) {
	const header = versionOf(await headerPill(page).textContent());

	// The Versions popover's own current row.
	await headerPill(page).click();
	const popover = page.getByTestId("document-versions-popover");
	await expect(popover).toBeVisible();
	// A generous budget: on a cold dev server the first request to the
	// versions route also pays for compiling it (as the first open of the
	// editor does in the other artifact specs).
	await expect(popover.getByRole("listitem").first()).toBeVisible({
		timeout: 30_000,
	});
	const topRow = popover.getByRole("listitem").first();
	const versions = versionOf(await topRow.textContent());
	await page.keyboard.press("Escape");
	await expect(popover).toHaveCount(0);

	// The chat card (only once Alfy has made a tool call in this chat).
	const card = withCard
		? versionOf(
				await page.getByTestId("artifact-card-head").last().textContent(),
			)
		: undefined;

	// The panel list row.
	await backToList(page);
	const list = versionOf(
		await page
			.getByTestId("artifact-panel-list")
			.getByTestId("artifact-row")
			.first()
			.textContent(),
	);
	await page
		.getByTestId("artifact-panel-list")
		.getByTestId("artifact-row")
		.first()
		.click();
	await expect(headerPill(page)).toBeVisible();

	return { header, versions, list, ...(withCard ? { card } : {}) };
}

async function expectAllSurfaces(
	page: Page,
	artifactId: string,
	expected: number,
	label: string,
	withCard: boolean,
) {
	await expect
		.poll(() => serverVersion(artifactId), {
			message: `${label}: the server's newest version`,
			timeout: 15_000,
		})
		.toBe(expected);
	// Let the passive surfaces settle before the interactive read below.
	await expect
		.poll(async () => versionOf(await headerPill(page).textContent()), {
			timeout: 6_000,
		})
		.toBe(`v${expected}`)
		.catch(() => undefined);
	const seen = await readSurfaces(page, withCard);
	const want = `v${expected}`;
	expect(seen, `${label} (server says v${expected})`).toEqual({
		header: want,
		versions: want,
		list: want,
		...(withCard ? { card: want } : {}),
	});
}

test.describe("one version number on every surface", () => {
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

	test("create → user edit → Alfy edit → Undo → restore → undo the restore: the list row, the chat card, the header and the Versions popover agree at every step, and after a reload", async ({
		page,
	}) => {
		test.setTimeout(240_000);
		await login(page);
		const previousModelPreference = await snapshotUserModelPreference(page);
		let providerId: string | null = null;
		try {
			const conversationId = await createConversation(page, "Version walk");
			const userId = await testUserId();
			const artifact = await createDocumentArtifact({
				userId,
				conversationId,
				title: "Version walk",
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
			await expectAllSurfaces(page, artifactId, 1, "created", false);

			// v2 — the user edits (autosave; a fresh version because v1 was a
			// seed, not an "Edited" burst).
			const editor = page.locator(".document-editor-host .document-content");
			await editor.getByText("Book the flight.").click();
			await page.keyboard.press("End");
			await page.keyboard.type(" Window seat.");
			await expectAllSurfaces(page, artifactId, 2, "user edit", false);

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
			await expectAllSurfaces(page, artifactId, 3, "Alfy edit", true);

			// v4 — the user undoes Alfy's change: its own version, "Undid Alfy's
			// change", not another anonymous "Edited".
			await page
				.getByTestId("alfy-change-bar")
				.getByRole("button", { name: "Undo Alfy's change" })
				.click();
			await expectAllSurfaces(page, artifactId, 4, "Undo", true);
			expect((await serverVersions(artifactId))[0]?.summary).toBe(
				"Undid Alfy's change",
			);

			// v5 — restore v1 from the Versions popover (inline confirm).
			await headerPill(page).click();
			const popover = page.getByTestId("document-versions-popover");
			const v1Row = popover.getByRole("listitem").filter({ hasText: /\bv1\b/ });
			await v1Row.hover();
			await v1Row.getByRole("button", { name: "Restore" }).click();
			await v1Row.getByRole("button", { name: "Restore" }).click();
			await expect(page.getByTestId("toast-entry")).toContainText(
				"Restored v1 as v5",
			);
			await expectAllSurfaces(page, artifactId, 5, "restore", true);

			// v6 — the toast's Undo puts back what was current before the restore.
			await page
				.getByTestId("toast-entry")
				.getByRole("button", { name: "Undo" })
				.click();
			await expectAllSurfaces(page, artifactId, 6, "undo the restore", true);

			// A reload rebuilds every surface from stored state: the open item
			// comes back from the saved workspace snapshot, which was taken at
			// v1 — it must not win over the artifact's real version.
			await page.reload({ waitUntil: "networkidle" });
			await expect(headerPill(page)).toBeVisible({ timeout: 30_000 });
			await expectAllSurfaces(page, artifactId, 6, "after a reload", true);
		} finally {
			await updateUserModelPreference(page, previousModelPreference);
			if (providerId) await deleteTemporaryProvider(page, providerId);
		}
	});
});

// ---- the Versions popover itself (polish G1-B, owner: "clunky, not very nice") --

/** A Document with `extra` more versions on top of v1, alternating authors, so the list has something to show. */
async function seedDocumentWithVersions(
	conversationId: string,
	extra: number,
): Promise<string> {
	const userId = await testUserId();
	const artifact = await createDocumentArtifact({
		userId,
		conversationId,
		title: "Popover walk",
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

async function openVersionsPopover(page: Page): Promise<Locator> {
	await headerPill(page).click();
	const popover = page.getByTestId("document-versions-popover");
	await expect(popover).toBeVisible();
	await expect(popover.getByTestId("version-row").first()).toBeVisible({
		timeout: 30_000,
	});
	return popover;
}

async function boxOf(locator: Locator) {
	const box = await locator.boundingBox();
	expect(box, "the element must have a box").not.toBeNull();
	return box as { x: number; y: number; width: number; height: number };
}

for (const viewport of [
	{ width: 1440, height: 900 },
	{ width: 1280, height: 800 },
]) {
	test.describe(`the Versions popover at ${viewport.width}x${viewport.height}`, () => {
		test.beforeEach(async ({ page }) => {
			await page.setViewportSize(viewport);
			await login(page);
		});

		test("opens under its own button, inside the panel, never over the chat column", async ({
			page,
		}) => {
			const conversationId = await createConversation(page, "Popover place");
			await seedDocumentWithVersions(conversationId, 5);
			await openChatAndReload(page, conversationId);
			await openDocumentFromPanel(page);

			const popover = await openVersionsPopover(page);
			const pill = await boxOf(headerPill(page));
			const panel = await boxOf(
				page.locator(".workspace-shell-desktop").first(),
			);
			const box = await boxOf(popover);

			// Under the button, left edges aligned (unless the panel edge forces a shift).
			expect(box.y).toBeGreaterThanOrEqual(pill.y + pill.height);
			expect(box.y - (pill.y + pill.height)).toBeLessThanOrEqual(16);
			expect(Math.abs(box.x - pill.x)).toBeLessThanOrEqual(2);
			// Inside the panel on both sides: the chat column is left of panel.x.
			expect(box.x).toBeGreaterThanOrEqual(panel.x);
			expect(box.x + box.width).toBeLessThanOrEqual(panel.x + panel.width);
			// The mockup's width band.
			expect(box.width).toBeGreaterThanOrEqual(320);
			expect(box.width).toBeLessThanOrEqual(360);
			// And inside the window vertically.
			expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
			await expect(headerPill(page)).toHaveAttribute("aria-expanded", "true");
		});

		test("stays under its button in the expanded panel too", async ({
			page,
		}) => {
			const conversationId = await createConversation(page, "Popover wide");
			await seedDocumentWithVersions(conversationId, 5);
			await openChatAndReload(page, conversationId);
			await openDocumentFromPanel(page);
			await page.locator(".workspace-expand-button:visible").first().click();

			const popover = await openVersionsPopover(page);
			const pill = await boxOf(headerPill(page));
			const box = await boxOf(popover);
			expect(box.x).toBeGreaterThanOrEqual(0);
			expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
			expect(box.y).toBeGreaterThanOrEqual(pill.y + pill.height);
			expect(Math.abs(box.x - pill.x)).toBeLessThanOrEqual(2);
		});
	});
}

test.describe("the Versions popover's rows", () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await login(page);
	});

	test("are evenly spaced, and showing Restore neither moves nor resizes a row", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Popover rows");
		await seedDocumentWithVersions(conversationId, 5);
		await openChatAndReload(page, conversationId);
		await openDocumentFromPanel(page);
		const popover = await openVersionsPopover(page);

		const rows = popover.getByTestId("version-row");
		const count = await rows.count();
		expect(count).toBe(6);
		const before = [];
		for (let i = 0; i < count; i++) before.push(await boxOf(rows.nth(i)));

		// Every row after the newest is the same height, and the pitch between
		// rows never varies: no row reserves room for a button it is not showing.
		const restHeights = before.slice(1).map((b) => Math.round(b.height));
		expect(new Set(restHeights).size).toBe(1);
		const pitches = before
			.slice(1)
			.map((b, i) => Math.round(b.y - (before[i].y + before[i].height)));
		expect(new Set(pitches).size).toBe(1);

		// Hover a row: its Restore appears, and nothing moves.
		const hovered = rows.nth(2);
		const action = hovered.locator(".versions-action");
		await expect(action).toHaveCSS("opacity", "0");
		await hovered.hover();
		await expect(action).toHaveCSS("opacity", "1");
		const after = [];
		for (let i = 0; i < count; i++) after.push(await boxOf(rows.nth(i)));
		expect(after).toEqual(before);
		// The summary keeps its full width at rest and while Restore shows.
		const summaryWidth = (await boxOf(hovered.locator(".versions-summary")))
			.width;
		await page.mouse.move(0, 0);
		await expect(action).toHaveCSS("opacity", "0");
		expect((await boxOf(hovered.locator(".versions-summary"))).width).toBe(
			summaryWidth,
		);
	});

	test("scrolls inside itself when the history is long, staying inside the window", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Popover long");
		await seedDocumentWithVersions(conversationId, 18);
		await openChatAndReload(page, conversationId);
		await openDocumentFromPanel(page);
		const popover = await openVersionsPopover(page);

		const box = await boxOf(popover);
		expect(box.y + box.height).toBeLessThanOrEqual(900);
		expect(box.height).toBeLessThanOrEqual(480);
		const body = popover.locator(".anchored-popover-body");
		const scrolls = await body.evaluate(
			(el) => el.scrollHeight > el.clientHeight,
		);
		expect(scrolls, "a long history scrolls inside the popover").toBe(true);
		// The heading stays put while the list scrolls.
		const heading = popover.getByRole("heading", { name: "Versions" });
		const headingBefore = await boxOf(heading);
		await body.evaluate((el) => {
			el.scrollTop = el.scrollHeight;
		});
		expect(await boxOf(heading)).toEqual(headingBefore);
	});

	test("work with the keyboard alone: Tab reaches Restore and shows it, Enter asks, Escape closes and returns focus to the version button", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Popover keys");
		await seedDocumentWithVersions(conversationId, 3);
		await openChatAndReload(page, conversationId);
		await openDocumentFromPanel(page);
		const popover = await openVersionsPopover(page);

		const rows = popover.getByTestId("version-row");
		// Focus starts on the close button; the next Tab stop is the first
		// Restore (the newest row has none).
		await page.keyboard.press("Tab");
		const firstRestore = rows.nth(1).getByRole("button", { name: "Restore" });
		await expect(firstRestore).toBeFocused();
		await expect(rows.nth(1).locator(".versions-action")).toHaveCSS(
			"opacity",
			"1",
		);
		// Its focus ring is visible.
		const ring = await firstRestore.evaluate(
			(el) => getComputedStyle(el).boxShadow,
		);
		expect(ring).not.toBe("none");

		await page.keyboard.press("Enter");
		await expect(rows.nth(1)).toContainText(/Restore v3\?/);
		// The question's confirming button took focus.
		await expect(
			rows.nth(1).getByRole("button", { name: "Restore" }),
		).toBeFocused();
		// Cancel puts focus back on the row's own Restore.
		await rows.nth(1).getByRole("button", { name: "Cancel" }).click();
		await expect(
			rows.nth(1).getByRole("button", { name: "Restore" }),
		).toBeFocused();

		await page.keyboard.press("Escape");
		await expect(popover).toHaveCount(0);
		await expect(headerPill(page)).toBeFocused();
		await expect(headerPill(page)).not.toHaveAttribute("aria-expanded", "true");
	});
});

test.describe("the Versions sheet on a phone", () => {
	test("shows the same rows in a sheet, over the mobile shell", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await login(page);
		const conversationId = await createConversation(page, "Popover phone");
		await seedDocumentWithVersions(conversationId, 4);
		await openChatAndReload(page, conversationId);
		await page.getByTestId("artifact-count-button-compact").click();
		await page
			.getByTestId("artifact-panel-list-mobile")
			.getByTestId("artifact-row")
			.first()
			.click({ timeout: 30_000 });
		await headerPill(page).click();

		const dialog = page.getByRole("dialog", { name: "Versions" });
		await expect(dialog).toBeVisible();
		const rows = dialog.getByTestId("version-row");
		await expect(rows).toHaveCount(5);
		// Really on top: the sheet's own row is what a tap at its centre reaches.
		await waitForMotionToSettle(page);
		await expect
			.poll(
				async () => {
					const box = await boxOf(rows.first());
					return page.evaluate(
						({ x, y }) =>
							document
								.elementFromPoint(x, y)
								?.closest('[data-testid="version-row"]') !== null,
						{ x: box.x + box.width / 2, y: box.y + box.height / 2 },
					);
				},
				{ message: "a tap at the sheet's first row reaches that row" },
			)
			.toBe(true);
		const width = (await boxOf(dialog)).width;
		expect(width).toBeLessThanOrEqual(390);
	});
});

// ---- the toast's exit (polish G1-B, redesign §7.2 #33) ---------------------

async function restoreOldestVersion(page: Page) {
	const popover = await openVersionsPopover(page);
	const oldest = popover.getByTestId("version-row").last();
	await oldest.hover();
	await oldest.getByRole("button", { name: "Restore" }).click();
	await oldest.getByRole("button", { name: "Restore" }).click();
	await expect(page.getByTestId("toast-entry")).toBeVisible();
}

/** Dismisses the toast and watches it leave, frame by frame, the way a person sees it. */
async function dismissToastAndWatch(page: Page) {
	return page.evaluate(
		() =>
			new Promise<{
				gone: boolean;
				minOpacity: number;
				maxSink: number;
				ms: number;
			}>((resolve) => {
				const el = document.querySelector(
					'[data-testid="toast-entry"]',
				) as HTMLElement;
				const close = el.querySelector(
					'button[aria-label="Close"]',
				) as HTMLButtonElement;
				const start = performance.now();
				let minOpacity = 1;
				let maxSink = 0;
				close.click();
				const frame = () => {
					const ms = performance.now() - start;
					if (!el.isConnected) {
						return resolve({ gone: true, minOpacity, maxSink, ms });
					}
					const style = getComputedStyle(el);
					minOpacity = Math.min(minOpacity, Number.parseFloat(style.opacity));
					const matrix = new DOMMatrixReadOnly(
						style.transform === "none" ? undefined : style.transform,
					);
					maxSink = Math.max(maxSink, matrix.m42);
					if (ms > 2000)
						return resolve({ gone: false, minOpacity, maxSink, ms });
					requestAnimationFrame(frame);
				};
				requestAnimationFrame(frame);
			}),
	);
}

test.describe("the toast's exit", () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await login(page);
	});

	test("slides out — fading and sinking — and leaves the DOM", async ({
		page,
	}) => {
		const conversationId = await createConversation(page, "Toast exit");
		await seedDocumentWithVersions(conversationId, 2);
		await openChatAndReload(page, conversationId);
		await openDocumentFromPanel(page);
		await restoreOldestVersion(page);

		// Let its entrance finish first, so what is measured is the exit alone.
		await page.waitForTimeout(500);
		const seen = await dismissToastAndWatch(page);

		expect(seen.gone, "the toast leaves the DOM").toBe(true);
		expect(seen.minOpacity, "it faded on its way out").toBeLessThan(0.9);
		expect(seen.maxSink, "it sank on its way out").toBeGreaterThan(2);
		// The standard duration (150ms), not an instant cut and not a slow fade.
		expect(seen.ms).toBeGreaterThan(60);
		expect(seen.ms).toBeLessThan(700);
	});

	test("leaves at once when the person asked for reduced motion", async ({
		page,
	}) => {
		await page.emulateMedia({ reducedMotion: "reduce" });
		const conversationId = await createConversation(page, "Toast exit reduced");
		await seedDocumentWithVersions(conversationId, 2);
		await openChatAndReload(page, conversationId);
		await openDocumentFromPanel(page);
		await restoreOldestVersion(page);

		const seen = await dismissToastAndWatch(page);

		expect(seen.gone).toBe(true);
		expect(seen.minOpacity, "no fade was ever visible").toBe(1);
		expect(seen.maxSink, "no movement was ever visible").toBe(0);
		expect(seen.ms).toBeLessThan(100);
	});
});
