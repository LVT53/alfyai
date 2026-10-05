import { expect, test } from "@playwright/test";
import { ARTIFACT_TOUR_DEFAULTS } from "../../src/lib/server/artifact-tour-defaults";
import {
	adminApi,
	backToList,
	createTourUser,
	finishTour,
	ITEM_TITLES,
	isMobile,
	openItem,
	panelShell,
	publishTour,
	removeTour,
	reopenChat,
	seedItem,
	seedProducedFile,
	startChatAs,
	type TourKind,
	tourCard,
	tourRows,
	waitForTourAnswer,
	watchTourRequests,
} from "./artifact-tours-helpers";
import { ensureSidebarExpanded, login } from "./helpers";

// The first-open tours, through a real browser with real clicks and keys
// (Slice 6; rulings 4, 8, 32, 33, 69). Every flow here is something a person
// does: open an item from the panel's list, read a card, press its buttons or
// the keys. Nothing calls a component callback or sets state through the page.
//
// The shared e2e admin has seen every tour (global-setup), so no other spec
// meets a card; each test here signs in as a user of its own, who has not.

const SLIDE_ONE: Record<TourKind, string> = {
	document: ARTIFACT_TOUR_DEFAULTS.document.slides[0].title.en,
	app: ARTIFACT_TOUR_DEFAULTS.app.slides[0].title.en,
	canvas: ARTIFACT_TOUR_DEFAULTS.canvas.slides[0].title.en,
};

/** Opens the item of `kind`, waits for the panel to be answered, and returns once the card is on screen. */
async function openAndExpectTour(
	page: Parameters<typeof openItem>[0],
	kind: TourKind,
) {
	await openItem(page, ITEM_TITLES[kind]);
	const card = tourCard(page);
	await expect(card).toBeVisible({ timeout: 20_000 });
	await expect(card.getByTestId("artifact-tour-title")).toHaveText(
		SLIDE_ONE[kind],
	);
	await expect(card).toHaveAttribute("data-kind", kind);
	return card;
}

test.describe("the first-open tours", () => {
	test.use({ viewport: { width: 1440, height: 900 } });

	test("a Document shows its tour on the first open, above the page, and not on the second", async ({
		page,
	}) => {
		const user = await createTourUser();
		const requests = watchTourRequests(page);
		const chatId = await startChatAs(page, user);
		await seedItem(user, chatId, "document");
		await reopenChat(page, chatId);

		const card = await openAndExpectTour(page, "document");
		await expect(card.getByTestId("artifact-tour-step")).toHaveText(
			"Step 1 of 3",
		);

		// In the panel's content area, above the artifact, not floating over it.
		const shell = panelShell(page);
		const editor = shell.locator(".document-editor-host .ProseMirror");
		await expect(editor).toBeVisible();
		const cardBox = await card.boundingBox();
		const editorBox = await editor.boundingBox();
		const shellBox = await shell.boundingBox();
		expect(cardBox).not.toBeNull();
		expect(editorBox).not.toBeNull();
		expect(shellBox).not.toBeNull();
		expect(cardBox?.y ?? 0).toBeGreaterThanOrEqual(shellBox?.y ?? 0);
		expect((cardBox?.y ?? 0) + (cardBox?.height ?? 0)).toBeLessThanOrEqual(
			(editorBox?.y ?? 0) + 1,
		);

		// All of it shows, buttons included: nothing scrolls inside the card.
		expect(
			await card.evaluate(
				(element) => element.scrollHeight - element.clientHeight,
			),
		).toBeLessThanOrEqual(1);

		// Showing it wrote nothing: only finishing does.
		expect(await tourRows(user.id)).toEqual([]);
		expect(requests.posts()).toHaveLength(0);

		await finishTour(page);
		await expect.poll(async () => (await tourRows(user.id)).length).toBe(1);
		const [row] = await tourRows(user.id);
		expect(row).toMatchObject({
			artifactType: "document",
			status: "completed",
			slideCount: 3,
			lastSlide: 2,
		});
		expect(row.contentKey).toMatch(/^(default|snapshot):/);

		// The second open of the same kind: asked, answered "seen", and no card.
		await backToList(page);
		const answered = waitForTourAnswer(page, "document");
		await openItem(page, ITEM_TITLES.document);
		await answered;
		await expect(editor).toBeVisible();
		await page.waitForTimeout(400);
		await expect(tourCard(page)).toHaveCount(0);
		expect(requests.posts()).toHaveLength(1);

		// And not after a reload either: the state is the server's, not the tab's.
		await page.reload({ waitUntil: "networkidle" });
		await page.waitForTimeout(400);
		await expect(tourCard(page)).toHaveCount(0);
	});

	test("closing the panel mid-tour writes nothing, and the tour is met again from its first slide", async ({
		page,
	}) => {
		const user = await createTourUser();
		const requests = watchTourRequests(page);
		const chatId = await startChatAs(page, user);
		await seedItem(user, chatId, "document");
		await reopenChat(page, chatId);

		const card = await openAndExpectTour(page, "document");
		await card.getByTestId("artifact-tour-next").click();
		await expect(card.getByTestId("artifact-tour-step")).toHaveText(
			"Step 2 of 3",
		);

		await panelShell(page)
			.getByRole("button", { name: "Close document workspace" })
			.click();
		await expect(tourCard(page)).toHaveCount(0);
		await page.waitForTimeout(400);
		expect(requests.posts()).toHaveLength(0);
		expect(await tourRows(user.id)).toEqual([]);

		// Not seen, so met again, from the start: the reader did not finish it.
		await openItem(page, ITEM_TITLES.document);
		const again = tourCard(page);
		await expect(again).toBeVisible({ timeout: 20_000 });
		await expect(again.getByTestId("artifact-tour-step")).toHaveText(
			"Step 1 of 3",
		);
	});

	test("an App and a Canvas each show their own tour, a different kind meeting its own", async ({
		page,
	}) => {
		const user = await createTourUser();
		const chatId = await startChatAs(page, user);
		await seedItem(user, chatId, "app");
		await seedItem(user, chatId, "canvas");
		await reopenChat(page, chatId);

		await openAndExpectTour(page, "app");
		await finishTour(page);
		await backToList(page);

		// Having seen the App's, the Canvas still has its own to show.
		await openAndExpectTour(page, "canvas");
		await finishTour(page);
		await expect
			.poll(async () =>
				(await tourRows(user.id)).map((row) => row.artifactType).sort(),
			)
			.toEqual(["app", "canvas"]);
	});

	test("a File never shows a tour, and never asks for one", async ({
		page,
	}) => {
		const user = await createTourUser();
		const requests = watchTourRequests(page);
		const chatId = await startChatAs(page, user);
		await seedProducedFile(user, chatId, "Vienna trip summary.pdf");
		await reopenChat(page, chatId);

		await openItem(page, "Vienna trip summary.pdf");
		await expect(
			panelShell(page).getByTestId("artifact-panel-title"),
		).toBeVisible({ timeout: 20_000 });
		await page.waitForTimeout(600);

		await expect(tourCard(page)).toHaveCount(0);
		expect(requests.all()).toEqual([]);
		expect(await tourRows(user.id)).toEqual([]);
	});

	test("Skip at the second slide is a dismissal, and the tour does not come back", async ({
		page,
	}) => {
		const user = await createTourUser();
		const chatId = await startChatAs(page, user);
		await seedItem(user, chatId, "document");
		await reopenChat(page, chatId);

		const card = await openAndExpectTour(page, "document");
		await card.getByTestId("artifact-tour-next").click();
		await expect(card.getByTestId("artifact-tour-step")).toHaveText(
			"Step 2 of 3",
		);
		await card.getByTestId("artifact-tour-skip").click();
		await expect(tourCard(page)).toHaveCount(0);

		await expect.poll(async () => (await tourRows(user.id)).length).toBe(1);
		const [row] = await tourRows(user.id);
		expect(row).toMatchObject({
			artifactType: "document",
			status: "dismissed",
			lastSlide: 1,
		});

		await backToList(page);
		const answered = waitForTourAnswer(page, "document");
		await openItem(page, ITEM_TITLES.document);
		await answered;
		await page.waitForTimeout(400);
		await expect(tourCard(page)).toHaveCount(0);
	});

	test("the tour can be finished with the keyboard alone, and Escape leaves it", async ({
		page,
	}) => {
		const user = await createTourUser();
		const chatId = await startChatAs(page, user);
		await seedItem(user, chatId, "document");
		await seedItem(user, chatId, "app");
		await reopenChat(page, chatId);

		// The Document: Tab into the card, Enter through its slides.
		const card = await openAndExpectTour(page, "document");
		await expect(card).toBeFocused();
		await page.keyboard.press("Tab");
		await expect(card.getByTestId("artifact-tour-skip")).toBeFocused();
		await page.keyboard.press("Tab");
		const primary = card.getByRole("button", { name: "Next" });
		await expect(primary).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(card.getByTestId("artifact-tour-step")).toHaveText(
			"Step 2 of 3",
		);
		// The focused control survives the slide: the keyboard never loses its place.
		await expect(primary).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(card.getByTestId("artifact-tour-step")).toHaveText(
			"Step 3 of 3",
		);
		await expect(card.getByRole("button", { name: "Got it" })).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(tourCard(page)).toHaveCount(0);
		await expect.poll(async () => (await tourRows(user.id)).length).toBe(1);
		expect((await tourRows(user.id))[0]).toMatchObject({
			artifactType: "document",
			status: "completed",
			lastSlide: 2,
		});
		// Focus went back to where it was, not to the top of the page.
		await expect(
			panelShell(page).getByTestId("artifact-panel-title"),
		).toBeFocused();

		// The App: Escape is Skip.
		await backToList(page);
		const appCard = await openAndExpectTour(page, "app");
		await expect(appCard).toBeFocused();
		await page.keyboard.press("Escape");
		await expect(tourCard(page)).toHaveCount(0);
		await expect
			.poll(async () =>
				(await tourRows(user.id)).map((row) => row.status).sort(),
			)
			.toEqual(["completed", "dismissed"]);
		const appRow = (await tourRows(user.id)).find(
			(row) => row.artifactType === "app",
		);
		expect(appRow).toMatchObject({ status: "dismissed", lastSlide: 0 });
		// Escape on a docked panel closes only the card, not the panel.
		await expect(panelShell(page)).toBeVisible();
	});

	test("the sidebar version badge never opens a tour, even with one published", async ({
		page,
		request,
	}) => {
		const user = await createTourUser();
		await login(page, user.email, user.password);
		const api = await adminApi(request);
		const campaignId = await publishTour(api, "canvas");
		try {
			await page.reload({ waitUntil: "networkidle" });
			await ensureSidebarExpanded(page);
			const badge = page.getByRole("button", { name: /^App version/ });
			await expect(badge).toBeVisible({ timeout: 15_000 });

			const latest = page.waitForResponse(
				(response) =>
					new URL(response.url()).pathname === "/api/campaigns/latest",
			);
			await badge.click();
			const body = (await (await latest).json()) as {
				campaign: { type?: string } | null;
			};
			// The badge asks for release notes only: with a tour published and no
			// release note, there is nothing to open and nothing opens.
			expect(body.campaign?.type ?? null).not.toBe("artifact_tour");
			await page.waitForTimeout(500);
			await expect(page.getByRole("dialog")).toHaveCount(0);
		} finally {
			await removeTour(campaignId);
		}
	});

	test("replays from the list's menu, and writes nothing", async ({ page }) => {
		const user = await createTourUser();
		const requests = watchTourRequests(page);
		const chatId = await startChatAs(page, user);
		await seedItem(user, chatId, "document");
		await reopenChat(page, chatId);

		await openAndExpectTour(page, "document");
		await finishTour(page);
		await expect.poll(async () => (await tourRows(user.id)).length).toBe(1);
		const before = await tourRows(user.id);
		const postsBefore = requests.posts().length;

		await backToList(page);
		await page
			.getByRole("button", { name: `More actions for ${ITEM_TITLES.document}` })
			.click();
		const menu = page.getByTestId("artifact-delete-popover");
		await expect(menu).toBeVisible();
		await menu.getByRole("menuitem", { name: "How this kind works" }).click();

		// The item opens with the same card, labelled as a replay, from slide one.
		const card = tourCard(page);
		await expect(card).toBeVisible({ timeout: 20_000 });
		await expect(card.getByTestId("artifact-tour-replaying")).toHaveText(
			"Replaying",
		);
		await expect(card.getByTestId("artifact-tour-step")).toHaveText(
			"Step 1 of 3",
		);
		await expect(card.getByTestId("artifact-tour-title")).toHaveText(
			SLIDE_ONE.document,
		);
		// A replay does not say "you'll see this once": that was said the first time.
		await card.getByTestId("artifact-tour-next").click();
		await card.getByTestId("artifact-tour-next").click();
		await expect(card.getByTestId("artifact-tour-step")).toHaveText(
			"Step 3 of 3",
		);
		await expect(card.getByTestId("artifact-tour-hint")).toHaveCount(0);
		await card.getByTestId("artifact-tour-done").click();
		await expect(tourCard(page)).toHaveCount(0);

		// Skip leaves a replay just as quietly.
		await backToList(page);
		await page
			.getByRole("button", { name: `More actions for ${ITEM_TITLES.document}` })
			.click();
		await page
			.getByTestId("artifact-delete-popover")
			.getByRole("menuitem", { name: "How this kind works" })
			.click();
		await expect(tourCard(page)).toBeVisible({ timeout: 20_000 });
		await tourCard(page).getByTestId("artifact-tour-skip").click();
		await expect(tourCard(page)).toHaveCount(0);

		await page.waitForTimeout(400);
		expect(requests.posts()).toHaveLength(postsBefore);
		expect(await tourRows(user.id)).toEqual(before);
	});

	test("a failed tour request leaves the panel working, with a warning and no card", async ({
		page,
	}) => {
		const user = await createTourUser();
		const chatId = await startChatAs(page, user);
		await seedItem(user, chatId, "document");
		await reopenChat(page, chatId);
		const warnings: string[] = [];
		page.on("console", (message) => {
			if (message.type() === "warning") warnings.push(message.text());
		});
		await page.route("**/api/artifact-tours/**", (route) =>
			route.fulfill({
				status: 500,
				contentType: "application/json",
				body: JSON.stringify({ error: "boom" }),
			}),
		);

		const answered = waitForTourAnswer(page, "document");
		await openItem(page, ITEM_TITLES.document);
		await answered;
		const shell = panelShell(page);
		await expect(
			shell.locator(".document-editor-host .ProseMirror"),
		).toBeVisible({ timeout: 20_000 });
		await page.waitForTimeout(400);
		await expect(tourCard(page)).toHaveCount(0);
		expect(warnings.some((text) => /tour|introduction/i.test(text))).toBe(true);

		// The panel still works: the page can be written in.
		const editor = shell.locator(".document-editor-host .ProseMirror");
		await editor.click();
		await page.keyboard.type(" Still here.");
		await expect(editor).toContainText("Still here.");
		expect(await tourRows(user.id)).toEqual([]);
	});

	test("a failed write closes the card anyway, and the tour shows again next time", async ({
		page,
	}) => {
		const user = await createTourUser();
		const chatId = await startChatAs(page, user);
		await seedItem(user, chatId, "document");
		await reopenChat(page, chatId);
		await page.route("**/api/artifact-tours/*/seen", (route) => route.abort());

		await openAndExpectTour(page, "document");
		await finishTour(page);
		await page.waitForTimeout(400);
		expect(await tourRows(user.id)).toEqual([]);

		await backToList(page);
		await openAndExpectTour(page, "document");
	});

	test("an incognito chat shows no tour and asks for none", async ({
		page,
	}) => {
		const user = await createTourUser();
		const requests = watchTourRequests(page);
		await login(page, user.email, user.password);
		await page.getByTestId("incognito-arm").click();
		await expect(page.locator(".chat-stage")).toHaveClass(/stage--incognito/);
		const composer = page.getByTestId("message-input");
		await composer.fill("Nothing of this is kept.");
		await page.getByTestId("send-button").click();
		await page.waitForURL(/\/chat\//, { timeout: 20_000 });
		const chatId = page.url().match(/\/chat\/([^/?#]+)/)?.[1] ?? "";
		expect(chatId).not.toBe("");

		await seedItem(user, chatId, "document");
		await seedItem(user, chatId, "canvas");
		await reopenChat(page, chatId);
		await expect(page.locator(".chat-stage")).toHaveClass(/stage--incognito/);

		await openItem(page, ITEM_TITLES.document);
		await expect(
			panelShell(page).locator(".document-editor-host .ProseMirror"),
		).toBeVisible({ timeout: 20_000 });
		await backToList(page);
		await openItem(page, ITEM_TITLES.canvas);
		await expect(page.getByTestId("canvas-editor")).toBeVisible({
			timeout: 20_000,
		});
		await page.waitForTimeout(600);

		await expect(tourCard(page)).toHaveCount(0);
		// "Nothing" means no request at all, not a request that was ignored.
		expect(requests.all()).toEqual([]);
		expect(await tourRows(user.id)).toEqual([]);
		// And no replay in an incognito chat's list menu.
		await backToList(page);
		await page
			.getByRole("button", { name: `More actions for ${ITEM_TITLES.document}` })
			.click();
		await expect(
			page.getByRole("menuitem", { name: "How this kind works" }),
		).toHaveCount(0);
	});

	test("a second user still sees a tour the first one finished", async ({
		page,
		browser,
	}) => {
		const first = await createTourUser();
		const firstChat = await startChatAs(page, first);
		await seedItem(first, firstChat, "canvas");
		await reopenChat(page, firstChat);
		await openAndExpectTour(page, "canvas");
		await finishTour(page);
		await expect.poll(async () => (await tourRows(first.id)).length).toBe(1);

		const context = await browser.newContext({
			viewport: { width: 1440, height: 900 },
		});
		try {
			const other = await context.newPage();
			const second = await createTourUser();
			const secondChat = await startChatAs(other, second);
			await seedItem(second, secondChat, "canvas");
			await reopenChat(other, secondChat);
			await openAndExpectTour(other, "canvas");
			// Their state is theirs: the first user's row is untouched by it.
			expect(await tourRows(second.id)).toEqual([]);
			expect(await tourRows(first.id)).toHaveLength(1);
		} finally {
			await context.close();
		}
	});

	test("a tour that changed while it was being read starts again from its first slide", async ({
		page,
		request,
	}) => {
		const user = await createTourUser();
		const requests = watchTourRequests(page);
		const chatId = await startChatAs(page, user);
		await seedItem(user, chatId, "canvas");
		await reopenChat(page, chatId);
		const api = await adminApi(request);

		const card = await openAndExpectTour(page, "canvas");
		await card.getByTestId("artifact-tour-next").click();
		await expect(card.getByTestId("artifact-tour-step")).toHaveText(
			"Step 2 of 3",
		);

		// An admin publishes while the user reads: the key they hold is stale.
		const campaignId = await publishTour(api, "canvas");
		try {
			await card.getByTestId("artifact-tour-skip").click();
			// Refused with a 409, nothing written; the new copy begins at slide one.
			const again = tourCard(page);
			await expect(again).toBeVisible({ timeout: 20_000 });
			await expect(again.getByTestId("artifact-tour-step")).toHaveText(
				"Step 1 of 3",
			);
			expect(requests.gets().length).toBeGreaterThanOrEqual(2);
			expect(await tourRows(user.id)).toEqual([]);

			// Finishing the new one is recorded against the new key.
			await finishTour(page);
			await expect.poll(async () => (await tourRows(user.id)).length).toBe(1);
			expect((await tourRows(user.id))[0].contentKey).toMatch(/^snapshot:/);
		} finally {
			await removeTour(campaignId);
		}
	});
});

test.describe("the first-open tour on a phone", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test("fits the 390 px panel without overflowing, with touch-sized buttons", async ({
		page,
	}) => {
		const user = await createTourUser();
		const chatId = await startChatAs(page, user);
		await seedItem(user, chatId, "canvas");
		await reopenChat(page, chatId);
		expect(isMobile(page)).toBe(true);

		const card = await openAndExpectTour(page, "canvas");
		const box = await card.boundingBox();
		expect(box).not.toBeNull();
		expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
		expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);

		// Nothing in the page or the card is wider than the screen.
		const overflow = await page.evaluate(() => ({
			page: document.documentElement.scrollWidth - window.innerWidth,
			card:
				(document.querySelector('[data-testid="artifact-tour"]') as HTMLElement)
					.scrollWidth -
				(document.querySelector('[data-testid="artifact-tour"]') as HTMLElement)
					.clientWidth,
		}));
		expect(overflow.page).toBeLessThanOrEqual(0);
		expect(overflow.card).toBeLessThanOrEqual(0);

		for (const id of ["artifact-tour-skip", "artifact-tour-next"]) {
			const button = await card.getByTestId(id).boundingBox();
			expect(button?.height ?? 0, id).toBeGreaterThanOrEqual(44);
		}
		// The whole card shows: its two buttons are not hidden below a scroll
		// inside the card (a cap that is too low clips them and still leaves every
		// box the size it should be).
		const scrolls = await card.evaluate(
			(element) => element.scrollHeight - element.clientHeight,
		);
		expect(scrolls).toBeLessThanOrEqual(1);
		const cardBottom = (box?.y ?? 0) + (box?.height ?? 0);
		for (const id of ["artifact-tour-skip", "artifact-tour-next"]) {
			const button = await card.getByTestId(id).boundingBox();
			expect(
				(button?.y ?? 0) + (button?.height ?? 0),
				`${id} inside the card`,
			).toBeLessThanOrEqual(cardBottom + 1);
		}
		// It sits in the panel's own scroll area: not fixed, not sticky.
		const position = await card.evaluate(
			(element) => getComputedStyle(element).position,
		);
		expect(position).toBe("static");

		await finishTour(page);
	});
});
