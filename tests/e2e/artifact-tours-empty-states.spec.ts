import { expect, type Page, test } from "@playwright/test";
import { ARTIFACT_TOUR_DEFAULTS } from "../../src/lib/server/artifact-tour-defaults";
import {
	adminApi,
	archiveTour,
	createTourUser,
	ITEM_TITLES,
	markToursSeen,
	openItem,
	publishTour,
	reopenChat,
	seedItem,
	startChatAs,
	startIncognitoChatAs,
	type TourKind,
	tourCard,
	tourRows,
	watchTourRequests,
} from "./artifact-tours-helpers";

// The empty states say what the tour says (Slice 6 T6; rulings 32 and 71). A
// Document, an App and a Canvas with nothing in them show the kind's one-line
// summary (the tour's own, so an admin's edit reaches it) and, beneath it, a
// quiet link that shows the tour again and writes nothing. Everything here is
// something a person does: open an item from the list, type, click the link.
//
// The readers have already finished every tour (`markToursSeen`), so no card
// is in the way of what is measured; the replay test brings it back on purpose.

const SUMMARY = {
	document: ARTIFACT_TOUR_DEFAULTS.document.summary,
	app: ARTIFACT_TOUR_DEFAULTS.app.summary,
	canvas: ARTIFACT_TOUR_DEFAULTS.canvas.summary,
};

/** A returning reader with one empty item of `kind` in a chat of their own, opened from the list. */
async function openEmpty(
	page: Page,
	kind: TourKind,
	language: "en" | "hu" = "en",
) {
	const user = await createTourUser(language);
	await markToursSeen(user);
	const chatId = await startChatAs(page, user);
	await seedItem(user, chatId, kind, { empty: true });
	await reopenChat(page, chatId);
	await openItem(page, ITEM_TITLES[kind]);
	return { user, chatId };
}

/** The link sits beneath the line, not beside it or over it. */
async function expectBeneath(
	line: ReturnType<Page["getByTestId"]>,
	link: ReturnType<Page["getByTestId"]>,
) {
	const lineBox = await line.boundingBox();
	const linkBox = await link.boundingBox();
	expect(lineBox).not.toBeNull();
	expect(linkBox).not.toBeNull();
	expect(linkBox?.y ?? 0).toBeGreaterThanOrEqual(
		(lineBox?.y ?? 0) + (lineBox?.height ?? 0) - 1,
	);
}

test.describe("the empty states say what the tour says", () => {
	test.use({ viewport: { width: 1440, height: 900 } });

	test("a new empty Canvas shows the tour's summary and a link beneath it", async ({
		page,
	}) => {
		await openEmpty(page, "canvas");
		await expect(page.getByTestId("canvas-editor")).toBeVisible({
			timeout: 20_000,
		});

		const line = page.getByTestId("canvas-empty");
		await expect(line).toHaveText(SUMMARY.canvas.en);
		const link = page.getByTestId("canvas-empty-replay");
		await expect(link).toBeVisible();
		await expect(link).toHaveText("Show it again");
		await expectBeneath(line, link);
		// The reader has seen the tour, so nothing but the empty state is on screen.
		await expect(tourCard(page)).toHaveCount(0);
	});

	test("an empty Document says it in the page, and typing makes it go", async ({
		page,
	}) => {
		await openEmpty(page, "document");
		const editor = page.locator(".document-editor-host .ProseMirror");
		await expect(editor).toBeVisible({ timeout: 20_000 });

		const line = page.getByTestId("document-empty");
		await expect(line).toHaveText(SUMMARY.document.en);
		const link = page.getByTestId("document-empty-replay");
		await expect(link).toHaveText("Show it again");
		await expectBeneath(line, link);

		// Real keys: the first letter takes the empty state away, and emptying
		// the page brings it back.
		await editor.click();
		await page.keyboard.type("Friday plans");
		await expect(editor).toContainText("Friday plans");
		await expect(line).toHaveCount(0);
		await expect(link).toHaveCount(0);

		await page.keyboard.press("ControlOrMeta+A");
		await page.keyboard.press("Backspace");
		await expect(line).toHaveText(SUMMARY.document.en);
		await expect(link).toBeVisible();
	});

	test("an App with nothing in it says so instead of showing a blank frame", async ({
		page,
	}) => {
		await openEmpty(page, "app");
		const line = page.getByTestId("app-empty");
		await expect(line).toBeVisible({ timeout: 20_000 });
		await expect(line).toHaveText(SUMMARY.app.en);
		const link = page.getByTestId("app-empty-replay");
		await expect(link).toHaveText("Show it again");
		await expectBeneath(line, link);
		await expect(page.locator("iframe")).toHaveCount(0);
	});

	test("the link shows the tour again and writes nothing", async ({ page }) => {
		const requests = watchTourRequests(page);
		const { user } = await openEmpty(page, "canvas");
		await expect(page.getByTestId("canvas-empty")).toBeVisible({
			timeout: 20_000,
		});

		await page.getByTestId("canvas-empty-replay").click();
		const card = tourCard(page);
		await expect(card).toBeVisible({ timeout: 20_000 });
		await expect(card).toHaveAttribute("data-replay", "true");
		await expect(card.getByTestId("artifact-tour-replaying")).toHaveText(
			"Replaying",
		);
		await expect(card.getByTestId("artifact-tour-step")).toHaveText(
			"Step 1 of 3",
		);

		// Through to the end with the card's own buttons: still nothing written.
		await card.getByTestId("artifact-tour-next").click();
		await card.getByTestId("artifact-tour-next").click();
		await card.getByTestId("artifact-tour-done").click();
		await expect(card).toHaveCount(0);

		expect(requests.posts()).toHaveLength(0);
		expect(await tourRows(user.id)).toHaveLength(3); // the three seen at the start
		// The empty state is still there, and so is its link.
		await expect(page.getByTestId("canvas-empty-replay")).toBeVisible();
	});

	test("after an admin edits and publishes the tour the empty state shows the edited line, and the code copy's again once it is archived", async ({
		page,
		request,
	}) => {
		const api = await adminApi(request);
		const edited = {
			en: "A blank board, ready for the first note.",
			hu: "Üres tábla, készen az első jegyzetre.",
		};
		const campaignId = await publishTour(api, "canvas", { summary: edited });
		try {
			const { user, chatId } = await openEmpty(page, "canvas");
			// The published copy is new to this reader: its card comes first.
			const card = tourCard(page);
			await expect(card).toBeVisible({ timeout: 20_000 });
			await card.getByTestId("artifact-tour-skip").click();
			await expect(card).toHaveCount(0);
			await expect(page.getByTestId("canvas-empty")).toHaveText(edited.en);

			// Archiving takes the admin's words back (ruling 71): the kind has its
			// own, which this reader finished before, so there is no card either.
			await archiveTour(api, campaignId);
			// A reload: the chat remembers its open panel, so the board is there
			// and the panel asks again as it opens.
			await reopenChat(page, chatId);
			await expect(page.getByTestId("canvas-empty")).toHaveText(
				SUMMARY.canvas.en,
				{ timeout: 20_000 },
			);
			await expect(tourCard(page)).toHaveCount(0);
			expect(
				(await tourRows(user.id)).filter((row) => row.status === "dismissed"),
			).toHaveLength(1);
		} catch (error) {
			await archiveTour(api, campaignId).catch(() => undefined);
			throw error;
		}
	});

	test("in Hungarian the line, the edited line and the link are Hungarian", async ({
		page,
	}) => {
		await openEmpty(page, "canvas", "hu");
		await expect(page.getByTestId("canvas-empty")).toHaveText(
			SUMMARY.canvas.hu,
			{ timeout: 20_000 },
		);
		await expect(page.getByTestId("canvas-empty-replay")).toHaveText(
			"Újra megnézem",
		);
	});

	test("an incognito chat's empty Canvas has its line, no link, and asked for nothing", async ({
		page,
	}) => {
		const requests = watchTourRequests(page);
		const user = await createTourUser();
		const chatId = await startIncognitoChatAs(page, user);
		await seedItem(user, chatId, "canvas", { empty: true });
		await reopenChat(page, chatId);
		await expect(page.locator(".chat-stage")).toHaveClass(/stage--incognito/);
		await openItem(page, ITEM_TITLES.canvas);

		await expect(page.getByTestId("canvas-empty")).toHaveText(
			SUMMARY.canvas.en,
			{ timeout: 20_000 },
		);
		await page.waitForTimeout(600);
		await expect(page.getByTestId("canvas-empty-replay")).toHaveCount(0);
		await expect(tourCard(page)).toHaveCount(0);
		// "Nothing" is no request at all, and no row.
		expect(requests.all()).toEqual([]);
		expect(await tourRows(user.id)).toEqual([]);
	});
});

test.describe("the empty states on a phone", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test("a Canvas's line and link fit the screen, and the link is a finger's size", async ({
		page,
	}) => {
		await openEmpty(page, "canvas");
		await expect(page.getByTestId("canvas-empty")).toBeVisible({
			timeout: 20_000,
		});
		const link = page.getByTestId("canvas-empty-replay");
		await expect(link).toBeVisible();

		const box = await link.boundingBox();
		expect(box).not.toBeNull();
		expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
		expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
		expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
		expect(
			await page.evaluate(
				() =>
					document.documentElement.scrollWidth -
					document.documentElement.clientWidth,
			),
		).toBeLessThanOrEqual(0);

		await link.click();
		await expect(tourCard(page)).toBeVisible({ timeout: 20_000 });
	});
});
