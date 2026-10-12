import { expect, type Page, test } from "@playwright/test";
import {
	createTourUser,
	markToursSeen,
	openItem,
	panelList,
	panelShell,
	reopenChat,
	seedItem,
	startChatAs,
	type TourUser,
} from "./artifact-tours-helpers";
import { waitForMotionToSettle } from "./helpers";
import {
	installMotionRecorder,
	noteNumbers,
	profile,
	recordNextLoad,
	shiftMax,
	shiftSum,
	startRecording,
	stopRecording,
} from "./panel-motion-helpers";

/**
 * One motion language for the panel (FB-3, ruling 77: F4, F19, F26).
 *
 * A layout change and what it makes room for move together: the chat column and
 * the panel change width on the same curve and duration, so the chat re-wraps as
 * the panel arrives and nothing jumps after its first frame. The audit saw the
 * opposite: the chat cut to its new width in one frame (layout shift 0.25 on open,
 * 1.0 on expand, 2.35 on delete) while the panel faded in 100-250 ms later.
 *
 * Real clicks only. The recorder is observation: a requestAnimationFrame sampler
 * of the chat column, the panel and the composer, and the page's own
 * `layout-shift` entries.
 */

test.use({ viewport: { width: 1440, height: 900 } });

async function readerWithItems(
	page: Page,
	kinds: Array<"document" | "app" | "canvas"> = ["document", "app"],
): Promise<{ user: TourUser; chatId: string }> {
	await installMotionRecorder(page);
	const user = await createTourUser("en");
	await markToursSeen(user);
	const chatId = await startChatAs(page, user);
	for (const kind of kinds) await seedItem(user, chatId, kind);
	await reopenChat(page, chatId);
	await expect(page.getByTestId("artifact-count-button")).toBeVisible();
	return { user, chatId };
}

/** The panel's title is on screen once: the desktop shell (the phone's twin is hidden). */
function visibleTitle(page: Page) {
	return page.locator('[data-testid="artifact-panel-title"]:visible');
}

/** Lets the motion that follows an input run out, then reads what the recorder saw. */
async function settleAndStop(page: Page) {
	await page.waitForTimeout(120);
	await waitForMotionToSettle(page);
	await page.waitForTimeout(160);
	return stopRecording(page);
}

test.describe("the panel and the chat move together", () => {
	test("opening the panel narrows the chat as the panel arrives, never a cut and then a fade", async ({
		page,
	}) => {
		await readerWithItems(page);
		await startRecording(page);
		await page.getByTestId("artifact-count-button").click();
		await expect(panelList(page)).toBeVisible();
		const run = await settleAndStop(page);

		const chat = profile(run.frames, "chatW");
		const panel = profile(run.frames, "panelW");
		noteNumbers("open", {
			chatTravel: chat.total,
			chatMaxStepFraction: chat.maxStepFraction,
			chatBetween: chat.between,
			panelMaxStepFraction: panel.maxStepFraction,
			shiftAll: shiftSum(run),
			shiftMaxEntry: shiftMax(run),
			shiftNoInput: shiftSum(run, { ignoreRecentInput: true }),
			settledAt: chat.settledAt,
		});

		// The chat really narrowed.
		expect(chat.total).toBeGreaterThan(300);
		// Not a cut: no frame carries most of the travel, and the chat is seen on its way.
		expect(
			chat.maxStepFraction,
			"the chat column went to its new width in one frame",
		).toBeLessThan(0.5);
		expect(
			chat.between,
			"the chat column was never seen mid-way",
		).toBeGreaterThanOrEqual(4);
		// The panel and the chat share the space: their widths always add up to the stage.
		for (const frame of run.frames) {
			if (frame.panelW === 0) continue;
			expect(
				Math.abs(frame.chatW + frame.panelW - frame.stageW),
				"a frame leaves a gap or an overlap between the chat and the panel",
			).toBeLessThanOrEqual(2);
		}
		// Nothing is left to jump after the motion: it has run out within a quarter second.
		expect(chat.settledAt - chat.movedAt).toBeLessThan(450);
	});

	test("the panel is not an empty column while the chat has already made room", async ({
		page,
	}) => {
		await readerWithItems(page);
		await startRecording(page);
		await page.getByTestId("artifact-count-button").click();
		await expect(panelList(page)).toBeVisible();
		const run = await settleAndStop(page);

		// By the time the chat has given up most of its travel the panel shows content.
		const chat = profile(run.frames, "chatW");
		const mostGone = run.frames.find(
			(frame) => Math.abs(frame.chatW - chat.first) >= chat.total * 0.8,
		);
		expect(mostGone).toBeTruthy();
		expect(
			(mostGone?.contentOpacity ?? 0) * (mostGone?.panelOpacity ?? 0),
			"most of the space was made, but the panel is still blank",
		).toBeGreaterThan(0.4);
	});

	test("closing the panel hands the width back to the chat on the same curve", async ({
		page,
	}) => {
		await readerWithItems(page);
		await page.getByTestId("artifact-count-button").click();
		await expect(panelList(page)).toBeVisible();
		await waitForMotionToSettle(page);
		await page.waitForTimeout(300);

		await startRecording(page);
		await page
			.getByRole("button", { name: "Close document workspace" })
			.first()
			.click();
		await expect(panelShell(page)).toHaveCount(0);
		const run = await settleAndStop(page);

		const chat = profile(run.frames, "chatW");
		noteNumbers("close", {
			chatTravel: chat.total,
			chatMaxStepFraction: chat.maxStepFraction,
			chatBetween: chat.between,
			shiftAll: shiftSum(run),
			shiftMaxEntry: shiftMax(run),
		});
		expect(chat.total).toBeGreaterThan(300);
		expect(
			chat.maxStepFraction,
			"the chat column went back to full width in one frame",
		).toBeLessThan(0.5);
		expect(chat.between).toBeGreaterThanOrEqual(3);
		// The panel keeps its place at the right edge while it is leaving, shrinking, never fading out of a void.
		for (const frame of run.frames) {
			if (frame.panelW === 0) continue;
			expect(
				Math.abs(frame.chatW + frame.panelW - frame.stageW),
			).toBeLessThanOrEqual(2);
		}
	});

	test("reloading with the panel open does not cut the chat to a stub and back", async ({
		page,
	}) => {
		await readerWithItems(page);
		await openItem(page, "Trip notes");
		await expect(visibleTitle(page)).toBeVisible();
		await waitForMotionToSettle(page);
		await page.waitForTimeout(300);

		await recordNextLoad(page);
		await page.reload({ waitUntil: "domcontentloaded" });
		await expect(visibleTitle(page)).toBeVisible({
			timeout: 20_000,
		});
		const run = await settleAndStop(page);
		const chat = profile(
			run.frames.filter((frame) => frame.chatW > 0),
			"chatW",
		);
		noteNumbers("reload", {
			chatFirst: chat.first,
			chatLast: chat.last,
			chatMaxStepFraction: chat.maxStepFraction,
			chatMinWidth: Math.min(
				...run.frames.filter((f) => f.chatW > 0).map((f) => f.chatW),
			),
			shiftAll: shiftSum(run),
			shiftMaxEntry: shiftMax(run),
		});
		// The panel arrives the way it does on any open: the chat narrows in step with it,
		// and is not cut from the page's full width to its docked one in a frame.
		expect(
			chat.maxStepFraction,
			"the chat column went to its docked width in one frame",
		).toBeLessThan(0.5);
		// The chat is never narrower than where it ends up: no stub first, no overshoot.
		const final = chat.last;
		for (const frame of run.frames) {
			if (frame.chatW === 0) continue;
			expect(
				frame.chatW,
				"the chat column was squeezed below its final width on the way",
			).toBeGreaterThanOrEqual(final - 2);
		}
	});
});

test.describe("deleting the open item", () => {
	test("deleting the open item shows the list without closing the panel", async ({
		page,
	}) => {
		await readerWithItems(page);
		await openItem(page, "Trip notes");
		await expect(visibleTitle(page)).toBeVisible();
		await waitForMotionToSettle(page);
		await page.waitForTimeout(300);

		await page
			.locator('[data-testid="artifact-delete-button"]:visible')
			.click();
		const popover = page.getByTestId("artifact-delete-popover");
		await expect(popover).toBeVisible();
		await startRecording(page);
		await popover.getByRole("button", { name: "Delete", exact: true }).click();
		await expect(panelList(page)).toBeVisible({ timeout: 15_000 });
		const run = await settleAndStop(page);

		const settled = run.frames.at(-1);
		const docked = settled?.chatW ?? 0;
		noteNumbers("delete", {
			shiftAll: shiftSum(run),
			shiftMaxEntry: shiftMax(run),
			framesWithNoPanel: run.frames.filter((frame) => frame.panelW === 0)
				.length,
			widestChat: Math.max(...run.frames.map((frame) => frame.chatW)),
			dockedChat: docked,
		});
		// There is no frame of a chat at full width: the panel stays up from the click to the list.
		for (const frame of run.frames) {
			expect(frame.panelW, "a frame has no panel").toBeGreaterThan(200);
			expect(
				frame.chatW,
				"a frame shows the chat wider than it is beside the panel",
			).toBeLessThanOrEqual(docked + 2);
		}
		await expect(
			panelList(page)
				.getByTestId("artifact-row")
				.filter({ hasText: "Tip calculator" }),
		).toBeVisible();
	});
});
