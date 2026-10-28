import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { CHAT_COLUMN_FLOOR } from "../../src/lib/client/workspace-dock";
import { db } from "../../src/lib/server/db";
import { conversations } from "../../src/lib/server/db/schema";
import { createProject } from "../../src/lib/server/services/projects";
import {
	createTourUser,
	finishTour,
	IMAGE_ITEM_TITLE,
	ITEM_TITLES,
	markToursSeen,
	openItem,
	panelList,
	panelShell,
	reopenChat,
	seedItem,
	startChatAs,
	type TourUser,
	tourCard,
} from "./artifact-tours-helpers";
import { ensureSidebarExpanded, login, waitForMotionToSettle } from "./helpers";
import {
	installMotionRecorder,
	type MotionFrame,
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
	kinds: Array<"document" | "app" | "canvas" | "image"> = ["document", "app"],
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

/**
 * The kinds whose open item runs the panel's item assertions (plan 2b T3): the
 * Image opens in the same shell as the Document and is held to the same numbers.
 * Each reader also has the Document and the App, so a delete leaves a list.
 */
const OPEN_ITEMS = [
	{ kind: "document", title: "Trip notes", seed: ["document", "app"] },
	{
		kind: "image",
		title: IMAGE_ITEM_TITLE,
		seed: ["document", "app", "image"],
	},
] as const;

/** The open item's body is drawn: the Document's text, or the Image's picture loaded full size. */
async function expectItemBody(page: Page, kind: "document" | "image") {
	await expect(
		page
			.locator(
				kind === "image"
					? '[data-testid="image-body-picture"] [data-testid="image-picture-after"].is-loaded'
					: ".workspace-stage .ProseMirror",
			)
			.first(),
	).toBeVisible({ timeout: 20_000 });
}

/** The panel's title is on screen once: the desktop shell (the phone's twin is hidden). */
function visibleTitle(page: Page) {
	return page.locator('[data-testid="artifact-panel-title"]:visible');
}

/** The box of something that is on screen. */
async function boxOf(locator: Locator) {
	const box = await locator.boundingBox();
	if (!box) throw new Error("nothing on screen to measure");
	return box;
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

	for (const item of OPEN_ITEMS) {
		test(`${item.kind}: reloading with the panel open does not cut the chat to a stub and back`, async ({
			page,
		}) => {
			await readerWithItems(page, [...item.seed]);
			await openItem(page, item.title);
			await expectItemBody(page, item.kind);
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
	}
});

test.describe("the docked column and what it holds", () => {
	/** The aside and the content laid in it, as the reader sees them at rest. */
	async function columnAndContent(page: Page) {
		return page.evaluate(() => {
			const shell = document.querySelector<HTMLElement>(
				"aside.workspace-shell-desktop",
			);
			const content = shell?.querySelector<HTMLElement>(".workspace-content");
			if (!shell || !content) return null;
			const column = shell.getBoundingClientRect();
			const held = content.getBoundingClientRect();
			return {
				column: column.width,
				content: held.width,
				contentRight: held.right,
				columnRight: column.right,
			};
		});
	}

	for (const item of OPEN_ITEMS) {
		test(`${item.kind}: what the column holds fills it at rest, after a window resize and after a drag of its edge`, async ({
			page,
		}) => {
			await readerWithItems(page, [...item.seed]);
			await openItem(page, item.title);
			await expectItemBody(page, item.kind);
			await expect(visibleTitle(page)).toBeVisible();
			await waitForMotionToSettle(page);
			await page.waitForTimeout(400);

			const fills = async (when: string) => {
				const box = await columnAndContent(page);
				expect(box, `${when}: no column`).not.toBeNull();
				// The shell has a 1 px border on its left edge; the content stands on the right.
				expect(
					Math.abs((box?.column ?? 0) - 1 - (box?.content ?? 0)),
					`${when}: the content does not fill the column`,
				).toBeLessThanOrEqual(1.5);
				expect(
					Math.abs((box?.contentRight ?? 0) - (box?.columnRight ?? 0)),
				).toBeLessThanOrEqual(1);
				return box?.column ?? 0;
			};
			const wide = await fills("at 1440");

			// The window gets narrower: the column follows the stage, and so does what it holds.
			await page.setViewportSize({ width: 1100, height: 900 });
			await page.waitForTimeout(300);
			const narrow = await fills("at 1100");
			expect(narrow).toBeLessThan(wide);

			// A drag of the column's edge.
			await page.setViewportSize({ width: 1440, height: 900 });
			await page.waitForTimeout(300);
			const handle = await boxOf(page.getByTestId("resize-handle"));
			const y = handle.y + handle.height / 2;
			await page.mouse.move(handle.x + 2, y);
			await page.mouse.down();
			await page.mouse.move(handle.x + 2 + 120, y, { steps: 6 });
			await page.mouse.up();
			await page.waitForTimeout(200);
			const dragged = await fills("after the drag");
			expect(dragged, "the drag did not make the column narrower").toBeLessThan(
				wide - 100,
			);
		});
	}
});

test.describe("a reader who asked for reduced motion", () => {
	for (const item of OPEN_ITEMS) {
		test(`${item.kind}: sees the chat and the panel change at once, on open, expand and close`, async ({
			page,
		}) => {
			await page.emulateMedia({ reducedMotion: "reduce" });
			await readerWithItems(page, [...item.seed]);

			await startRecording(page);
			await page.getByTestId("artifact-count-button").click();
			await expect(panelList(page)).toBeVisible();
			const opened = await settleAndStop(page);
			const open = profile(opened.frames, "chatW");
			expect(open.total, "the chat did not make room").toBeGreaterThan(300);
			expect(open.between, "the chat was seen part-way").toBeLessThanOrEqual(1);

			await openItem(page, item.title);
			await expectItemBody(page, item.kind);
			await expect(visibleTitle(page)).toBeVisible();
			await page.waitForTimeout(300);
			await startRecording(page);
			await page.locator(".workspace-expand-button:visible").first().click();
			await expect(
				page.locator(".workspace-shell-expanded:visible"),
			).toHaveCount(1);
			const expanded = await settleAndStop(page);
			const expand = profile(expanded.frames, "panelW");
			expect(expand.total).toBeGreaterThan(300);
			expect(expand.between, "the panel was seen growing").toBeLessThanOrEqual(
				1,
			);

			await startRecording(page);
			await page
				.locator(".workspace-shell-expanded:visible")
				.getByRole("button", { name: "Close document workspace" })
				.click();
			await expect(
				page.locator("aside.workspace-shell-desktop:visible"),
			).toHaveCount(0);
			const closed = await settleAndStop(page);
			const close = profile(closed.frames, "chatW");
			expect(close.between, "the chat was seen part-way").toBeLessThanOrEqual(
				1,
			);
		});
	}
});

test.describe("deleting, expanding and closing the open item", () => {
	for (const item of OPEN_ITEMS) {
		test(`${item.kind}: deleting the open item shows the list without closing the panel`, async ({
			page,
		}) => {
			await readerWithItems(page, [...item.seed]);
			await openItem(page, item.title);
			await expectItemBody(page, item.kind);
			await expect(visibleTitle(page)).toBeVisible();
			await waitForMotionToSettle(page);
			await page.waitForTimeout(300);

			await page
				.locator('[data-testid="artifact-delete-button"]:visible')
				.click();
			const popover = page.getByTestId("artifact-delete-popover");
			await expect(popover).toBeVisible();
			await startRecording(page);
			await popover
				.getByRole("button", { name: "Delete", exact: true })
				.click();
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

		test(`${item.kind}: expanding animates the panel and leaves the chat where it is`, async ({
			page,
		}) => {
			await readerWithItems(page, [...item.seed]);
			await openItem(page, item.title);
			await expectItemBody(page, item.kind);
			await expect(visibleTitle(page)).toBeVisible();
			await waitForMotionToSettle(page);
			await page.waitForTimeout(300);

			await startRecording(page);
			await page.locator(".workspace-expand-button:visible").first().click();
			await expect(
				page.locator(".workspace-shell-expanded:visible"),
			).toHaveCount(1);
			const run = await settleAndStop(page);

			const panel = profile(run.frames, "panelW");
			const chat = profile(run.frames, "chatW");
			noteNumbers("expand", {
				panelTravel: panel.total,
				panelMaxStepFraction: panel.maxStepFraction,
				panelBetween: panel.between,
				chatTravel: chat.total,
				shiftAll: shiftSum(run),
				shiftMaxEntry: shiftMax(run),
			});
			expect(panel.total).toBeGreaterThan(300);
			expect(
				panel.maxStepFraction,
				"the panel went to full size in one frame",
			).toBeLessThan(0.5);
			expect(
				panel.between,
				"the panel was never seen growing",
			).toBeGreaterThanOrEqual(4);
			// The chat is behind it and is not asked to re-wrap for a panel that floats over it.
			expect(
				chat.total,
				"the chat re-flowed behind the expanding panel",
			).toBeLessThanOrEqual(2);
		});

		test(`${item.kind}: the X of an expanded panel closes it, and the count button opens the list`, async ({
			page,
		}) => {
			await readerWithItems(page, [...item.seed]);
			await openItem(page, item.title);
			await expectItemBody(page, item.kind);
			await expect(visibleTitle(page)).toBeVisible();
			await page.locator(".workspace-expand-button:visible").first().click();
			await expect(
				page.locator(".workspace-shell-expanded:visible"),
			).toHaveCount(1);
			await waitForMotionToSettle(page);
			await page.waitForTimeout(300);

			await page
				.locator(".workspace-shell-expanded:visible")
				.getByRole("button", { name: "Close document workspace" })
				.click();
			// Closed, not docked: no panel of either shape is left.
			await expect(
				page.locator("aside.workspace-shell-desktop:visible"),
			).toHaveCount(0);

			// The count button opens this chat's list, never the item (Task 14).
			await page.getByTestId("artifact-count-button").click();
			await expect(panelList(page)).toBeVisible();
			await expect(visibleTitle(page)).toHaveCount(0);
		});

		test(`${item.kind}: an expanded panel can be docked again, by its own button`, async ({
			page,
		}) => {
			await readerWithItems(page, [...item.seed]);
			await openItem(page, item.title);
			await expectItemBody(page, item.kind);
			await page.locator(".workspace-expand-button:visible").first().click();
			const expanded = page.locator(".workspace-shell-expanded:visible");
			await expect(expanded).toHaveCount(1);
			await waitForMotionToSettle(page);
			await expanded
				.getByRole("button", { name: /to the docked workspace/ })
				.click();
			await expect(page.locator(".workspace-shell-expanded")).toHaveCount(0);
			await expect(visibleTitle(page)).toHaveText(item.title);
			await expect(
				page.locator("aside.workspace-shell-desktop:visible"),
			).toHaveCount(1);
		});
	}
});

/**
 * Plan 2b T3b: the shell holds its content at the size a shape change ends at.
 * Shape changes that overlap, and a window that changes under a hold, must still
 * end with the content at the shape's own size and the hold let go; a hold that
 * an older animation lets go of too early would re-flow the content mid-motion.
 */
const SHELL_CONTENT = "aside.workspace-shell-desktop > .workspace-content";

/** How many frames changed the shell content's width or height. */
function contentSizeChanges(frames: MotionFrame[]) {
	const seen = frames
		.map((frame) => frame.tracked.content)
		.filter((box) => box !== null);
	let width = 0;
	let height = 0;
	for (let index = 1; index < seen.length; index++) {
		if (Math.abs(seen[index].w - seen[index - 1].w) > 0.5) width += 1;
		if (Math.abs(seen[index].h - seen[index - 1].h) > 0.5) height += 1;
	}
	return { width, height, frames: seen.length };
}

/** The content at rest fills the shell's shape: the dock's column, or the overlay inside its border. */
async function contentFitsShell(page: Page) {
	return page.evaluate((selector) => {
		const content = document.querySelector<HTMLElement>(selector);
		const shell = content?.parentElement;
		if (!content || !shell) return null;
		const box = content.getBoundingClientRect();
		const style = getComputedStyle(shell);
		const inner = {
			right:
				shell.getBoundingClientRect().right -
				Number.parseFloat(style.borderRightWidth),
			height:
				shell.getBoundingClientRect().height -
				Number.parseFloat(style.borderTopWidth) -
				Number.parseFloat(style.borderBottomWidth),
		};
		return {
			held: content.classList.contains("workspace-content-held"),
			inlineHeight: content.style.height,
			rightGap: Math.abs(box.right - inner.right),
			heightGap: Math.abs(box.height - inner.height),
		};
	}, SHELL_CONTENT);
}

/** Presses the expanded panel's button named `name` now, wherever it is in its motion. */
async function pressMidMotion(page: Page, name: RegExp) {
	await page.evaluate((source) => {
		const pattern = new RegExp(source);
		const button = [
			...document.querySelectorAll<HTMLButtonElement>(
				".workspace-shell-expanded button",
			),
		].find((candidate) =>
			pattern.test(
				candidate.getAttribute("aria-label") ?? candidate.textContent ?? "",
			),
		);
		if (!button) throw new Error(`no button ${source}`);
		button.click();
	}, name.source);
}

/**
 * Waits until the shell's own shape animation (expand's or dock's insets) is
 * running and has drawn at least one frame, with the content held: the moment a
 * reader's press lands "mid-motion". It waits on the animation the shell started
 * (`getAnimations()`), never on a clock, so a slow frame cannot make the press
 * land before the motion or after it.
 */
async function waitForShellMidMotion(page: Page) {
	await page.waitForFunction(
		(selector) => {
			const content = document.querySelector<HTMLElement>(selector);
			const shell = content?.parentElement;
			if (!content || !shell) return false;
			if (!content.classList.contains("workspace-content-held")) return false;
			return shell.getAnimations().some((animation) => {
				const time = Number(animation.currentTime ?? 0);
				const duration = Number(animation.effect?.getTiming().duration ?? 0);
				return animation.playState === "running" && time > 0 && time < duration;
			});
		},
		SHELL_CONTENT,
		{ polling: "raf" },
	);
}

function expectAtRest(fit: Awaited<ReturnType<typeof contentFitsShell>>) {
	expect(fit, "no content").not.toBeNull();
	expect(fit?.held, "the hold was never let go").toBe(false);
	expect(fit?.inlineHeight, "a held height was left behind").toBe("");
	expect(
		fit?.rightGap ?? 99,
		"the content does not reach the shell's edge",
	).toBeLessThanOrEqual(1);
	expect(
		fit?.heightGap ?? 99,
		"the content is not the shell's height",
	).toBeLessThanOrEqual(1);
}

test.describe("shape changes that overlap, and a window that changes under them", () => {
	for (const item of OPEN_ITEMS) {
		test(`${item.kind}: dock pressed while it expands docks it, the content held throughout`, async ({
			page,
		}) => {
			await readerWithItems(page, [...item.seed]);
			await openItem(page, item.title);
			await expectItemBody(page, item.kind);
			await waitForMotionToSettle(page);
			await page.waitForTimeout(300);

			await startRecording(page, { content: SHELL_CONTENT });
			await page.locator(".workspace-expand-button:visible").first().click();
			await waitForShellMidMotion(page);
			// Pressed while the overlay still grows. Playwright's click waits for a
			// button that stops moving, which would be after the expand: this press
			// lands mid-motion, as a reader's does.
			await pressMidMotion(page, /to the docked workspace/);
			await expect(page.locator(".workspace-shell-expanded")).toHaveCount(0);
			const run = await settleAndStop(page);
			const changes = contentSizeChanges(run.frames);
			noteNumbers(`dock-mid-expand-${item.kind}`, changes);
			// Once when the expand's hold starts, once when the dock's does: the
			// expand's own end, mid-dock, must not let go of the dock's hold.
			expect(
				changes.width,
				"the content re-flowed while it docked",
			).toBeLessThanOrEqual(2);
			expect(changes.height).toBeLessThanOrEqual(2);
			expectAtRest(await contentFitsShell(page));
		});

		test(`${item.kind}: Escape pressed while it docks still docks it once, the content held throughout`, async ({
			page,
		}) => {
			await readerWithItems(page, [...item.seed]);
			await openItem(page, item.title);
			await expectItemBody(page, item.kind);
			await page.locator(".workspace-expand-button:visible").first().click();
			await expect(
				page.locator(".workspace-shell-expanded:visible"),
			).toHaveCount(1);
			await waitForMotionToSettle(page);
			await page.waitForTimeout(300);

			await startRecording(page, { content: SHELL_CONTENT });
			await page
				.locator(".workspace-shell-expanded:visible")
				.getByRole("button", { name: /to the docked workspace/ })
				.click();
			await waitForShellMidMotion(page);
			await page.keyboard.press("Escape");
			await expect(page.locator(".workspace-shell-expanded")).toHaveCount(0);
			const run = await settleAndStop(page);
			const changes = contentSizeChanges(run.frames);
			noteNumbers(`escape-mid-dock-${item.kind}`, changes);
			await expect(visibleTitle(page)).toHaveText(item.title);
			expect(
				changes.width,
				"the content re-flowed while it docked",
			).toBeLessThanOrEqual(1);
			expect(changes.height).toBeLessThanOrEqual(1);
			expectAtRest(await contentFitsShell(page));
		});

		test(`${item.kind}: a window resized right after expand leaves the content at the overlay's new size`, async ({
			page,
		}) => {
			await readerWithItems(page, [...item.seed]);
			await openItem(page, item.title);
			await expectItemBody(page, item.kind);
			await waitForMotionToSettle(page);
			await page.waitForTimeout(300);

			await page.locator(".workspace-expand-button:visible").first().click();
			await waitForShellMidMotion(page);
			await page.setViewportSize({ width: 1280, height: 860 });
			await expect(
				page.locator(".workspace-shell-expanded:visible"),
			).toHaveCount(1);
			await waitForMotionToSettle(page);
			await page.waitForTimeout(300);
			expectAtRest(await contentFitsShell(page));
		});
	}
});

/**
 * F3: the sidebar open next to a docked panel squeezed the chat to a composer of
 * 319 / 268 / 134 px at 1440 / 1280 / 1100 and ran the header's project crumb
 * into the count chip. Now the chat column keeps a floor: the sidebar folds to
 * its rail while the panel needs the room (and comes back with it), and the
 * panel gives up width before the chat goes under the floor.
 */
test.describe("the chat keeps its room beside a docked panel", () => {
	for (const width of [1100, 1280, 1440]) {
		test(`with the sidebar open at ${width}, the composer stays usable and the crumb clear of the count chip`, async ({
			page,
		}) => {
			await page.setViewportSize({ width, height: 900 });
			const user = await createTourUser("en");
			await markToursSeen(user);
			const project = await createProject(user.id, "Vienna trip");
			const chatId = randomUUID();
			await db.insert(conversations).values({
				id: chatId,
				userId: user.id,
				title: "Train options Budapest to Vienna",
				projectId: project.id,
				createdAt: new Date(),
				updatedAt: new Date(),
			});
			await seedItem(user, chatId, "document");
			await login(page, user.email, user.password);
			await page.goto(`/chat/${chatId}`, { waitUntil: "networkidle" });
			await ensureSidebarExpanded(page);
			const sidebar = page.locator("aside.sidebar-panel");
			await expect(sidebar).not.toHaveClass(/sidebar-collapsed/);
			await waitForMotionToSettle(page);
			const openWidth = (await sidebar.boundingBox())?.width ?? 0;
			expect(openWidth).toBeGreaterThan(200);

			await openItem(page, "Trip notes");
			await expect(visibleTitle(page)).toBeVisible();
			await waitForMotionToSettle(page);
			await page.waitForTimeout(400);

			const composer = await boxOf(page.locator(".composer-shell"));
			const chat = await boxOf(page.locator(".chat-main"));
			const panel = await boxOf(panelShell(page));
			const crumb = await boxOf(page.getByTestId("chat-title-project-link"));
			const count = await boxOf(page.getByTestId("artifact-count-button"));
			noteNumbers(`floor-${width}`, {
				sidebar: (await sidebar.boundingBox())?.width,
				chat: chat.width,
				composer: composer.width,
				panel: panel.width,
			});
			// The floor: the chat column is never under it, and the composer in it is usable.
			expect(chat.width).toBeGreaterThanOrEqual(CHAT_COLUMN_FLOOR - 1);
			expect(composer.width).toBeGreaterThanOrEqual(CHAT_COLUMN_FLOOR - 25);
			expect(panel.width).toBeGreaterThanOrEqual(439);
			// Where the sidebar had to give way, it is on its rail; where it did not, it was left alone.
			if (width < 1440) {
				await expect(sidebar).toHaveClass(/sidebar-collapsed/);
			}
			// The header's crumb stops short of the count chip.
			expect(crumb.x + crumb.width).toBeLessThanOrEqual(count.x);

			// With the panel gone the sidebar is back as the reader had it.
			await page.getByTestId("artifact-count-button").click();
			await expect(panelShell(page)).toHaveCount(0);
			await waitForMotionToSettle(page);
			await expect(sidebar).not.toHaveClass(/sidebar-collapsed/);
			expect((await sidebar.boundingBox())?.width ?? 0).toBeCloseTo(
				openWidth,
				0,
			);
		});
	}

	test("the sidebar a reader opens again over the panel stays open until the panel goes", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		const { user, chatId } = await readerWithItems(page, ["document"]);
		void user;
		void chatId;
		await ensureSidebarExpanded(page);
		const sidebar = page.locator("aside.sidebar-panel");
		await openItem(page, "Trip notes");
		await expect(sidebar).toHaveClass(/sidebar-collapsed/);

		await page.getByRole("button", { name: "Expand sidebar" }).click();
		await expect(sidebar).not.toHaveClass(/sidebar-collapsed/);
		await waitForMotionToSettle(page);
		await page.waitForTimeout(300);
		// Still open, with the panel still beside it (the panel gives the width up).
		await expect(sidebar).not.toHaveClass(/sidebar-collapsed/);
		await expect(panelShell(page)).toHaveCount(1);
	});
});

/**
 * F15 (ruling 77): the first time a reader opens a Document, an App, a Canvas or (plan 2b
 * T16) an Image the tour
 * card arrived ~230 ms after the item had painted and was put in the flow above it, so the
 * Document moved 120-190 px, the board re-fitted (100% -> 87%) and, when the card left,
 * moved back. FB-3 laid the card over the item (nothing moved, but the card covered the
 * toolbar and the first lines); FX-2 put it back in the flow with its room made before the
 * body paints: the item is under the card from its first frame and nothing of it is covered,
 * so nothing moves when the card ARRIVES. When the reader dismisses it the room closes with
 * the card's own short transition (what is below it glides up as the height shrinks: a
 * layout change and what it made room for move together), and on a phone the card has a
 * compact form so the text still starts above the middle of the screen while it is up.
 */
test.describe("the tour card arrives without moving what the reader just saw", () => {
	const BODIES = {
		document: ".workspace-stage .ProseMirror",
		app: ".workspace-stage iframe",
		canvas: ".workspace-stage .svelte-flow__viewport",
		// Plan 2b T16: the Image's body, the row the picture and its strip sit in.
		image: '.workspace-stage [data-testid="image-body"]',
	} as const;

	async function freshReader(
		page: Page,
		kind: keyof typeof BODIES,
		language: "en" | "hu" = "en",
	) {
		await installMotionRecorder(page);
		const user = await createTourUser(language);
		const chatId = await startChatAs(page, user);
		await seedItem(user, chatId, kind);
		await reopenChat(page, chatId);
		return { user, chatId };
	}

	/** Frames from the last one before the card is on screen: what the item showed, then everything after. */
	function sinceCard(frames: MotionFrame[]) {
		const cardAt = frames.findIndex((frame) => frame.tracked.card !== null);
		expect(cardAt, "the card never showed").toBeGreaterThan(0);
		return frames.slice(Math.max(cardAt - 1, 0));
	}

	/**
	 * How the item's top edge travels over the frames (up is positive): the whole distance, the
	 * biggest single step, how many frames moved it and over how long. A cut is one frame that
	 * takes all of it; a glide is many small ones.
	 */
	function glideOf(frames: MotionFrame[]) {
		const samples = frames.flatMap((frame) =>
			frame.tracked.body ? [{ t: frame.t, y: frame.tracked.body.y }] : [],
		);
		let maxStep = 0;
		let moving = 0;
		let firstMove = -1;
		let lastMove = 0;
		for (let index = 1; index < samples.length; index++) {
			const step = Math.abs(samples[index].y - samples[index - 1].y);
			maxStep = Math.max(maxStep, step);
			if (step > 0.5) {
				moving += 1;
				if (firstMove < 0) firstMove = samples[index].t;
				lastMove = samples[index].t;
			}
		}
		return {
			travel: (samples[0]?.y ?? 0) - (samples.at(-1)?.y ?? 0),
			maxStep,
			moving,
			spanMs: firstMove < 0 ? 0 : lastMove - firstMove,
		};
	}

	/** How far the board's blocks, taken together, stand from the middle of their pane (px, up or down). */
	async function boardOffCentre(page: Page) {
		const pane = await page.getByTestId("canvas-board").boundingBox();
		const nodes = page.getByTestId("canvas-node");
		let top = Number.POSITIVE_INFINITY;
		let bottom = Number.NEGATIVE_INFINITY;
		for (let index = 0; index < (await nodes.count()); index++) {
			const box = await nodes.nth(index).boundingBox();
			if (!box) continue;
			top = Math.min(top, box.y);
			bottom = Math.max(bottom, box.y + box.height);
		}
		if (!pane || top === Number.POSITIVE_INFINITY) {
			throw new Error("the board is not on screen");
		}
		return (top + bottom) / 2 - (pane.y + pane.height / 2);
	}

	for (const kind of ["document", "app", "canvas", "image"] as const) {
		test(`a ${kind} stays where it painted when its card arrives, and gets the card's room back as a glide when the card is dismissed`, async ({
			page,
		}) => {
			await freshReader(page, kind);
			await page.getByTestId("artifact-count-button").click();
			await expect(panelList(page)).toBeVisible();
			await waitForMotionToSettle(page);
			await startRecording(page, {
				card: '[data-testid="artifact-tour"]',
				body: BODIES[kind],
			});
			await panelList(page)
				.getByTestId("artifact-row")
				.filter({ hasText: ITEM_TITLES[kind] })
				.click();
			await expect(tourCard(page)).toBeVisible({ timeout: 20_000 });
			await page.waitForTimeout(400);
			await waitForMotionToSettle(page);
			const arrival = await stopRecording(page);

			// The room the card holds in the page: its own height and the margin above it (the
			// exit shrinks a wrapper that holds both), and, for a board, how it stands in its
			// pane with the card up.
			const room = await tourCard(page).evaluate(
				(card) =>
					card.getBoundingClientRect().height +
					Number.parseFloat(getComputedStyle(card).marginTop),
			);
			expect(room, "the card holds room in the page").toBeGreaterThan(100);
			const offCentreWithCard =
				kind === "canvas" ? await boardOffCentre(page) : 0;

			await startRecording(page, { body: BODIES[kind] });
			await finishTour(page);
			await page.waitForTimeout(300);
			await waitForMotionToSettle(page);
			const leaving = await stopRecording(page);

			const moves = (frames: MotionFrame[]) => {
				const boxes = frames
					.map((frame) => frame.tracked.body)
					.filter((box) => box !== null);
				const first = boxes[0];
				// The board's own first fit (identity -> fitted) is not the card's doing: what
				// counts is the number of different fits it shows, which is one.
				const fits = new Set(
					boxes
						.map((box) => box.transform)
						.filter(
							(transform) =>
								transform !== "none" &&
								transform !== "matrix(1, 0, 0, 1, 0, 0)",
						),
				);
				return {
					top: Math.max(...boxes.map((box) => Math.abs(box.y - first.y))),
					width: Math.max(...boxes.map((box) => Math.abs(box.w - first.w))),
					fits: fits.size,
				};
			};
			const arriving = moves(sinceCard(arrival.frames));
			const closing = glideOf(leaving.frames);
			noteNumbers(`tour-${kind}`, {
				arrivalTopMove: arriving.top,
				arrivalWidthChange: arriving.width,
				arrivalFits: arriving.fits,
				room,
				leaveTravel: closing.travel,
				leaveMaxStep: closing.maxStep,
				leaveMovingFrames: closing.moving,
				leaveSpanMs: closing.spanMs,
				shiftAll: shiftSum(arrival),
			});

			// ARRIVING: nothing under the card moves, and nothing is resized for it.
			if (kind === "canvas") {
				// The viewport element's box is its transform: the board is fitted once and stays so.
				expect(arriving.fits, "the board re-fitted for the card").toBe(1);
			} else {
				expect(
					arriving.top,
					"the item moved when the card arrived",
				).toBeLessThan(1.5);
				expect(
					arriving.width,
					"the item was resized for the card",
				).toBeLessThan(1.5);
			}

			// LEAVING: the room closes with the card's short transition and what is below it
			// moves with it, a few pixels a frame: no cut, and not a slow drift either.
			expect(
				closing.moving,
				"the room closed in one cut",
			).toBeGreaterThanOrEqual(4);
			expect(
				closing.maxStep,
				"one frame took most of the way",
			).toBeLessThanOrEqual(Math.abs(closing.travel) * 0.5 + 1);
			expect(
				closing.spanMs,
				"the room took too long to close",
			).toBeLessThanOrEqual(600);
			if (kind === "canvas") {
				// The board follows its pane as the pane grows, and ends as centred in it as it was.
				const offCentreAfter = await boardOffCentre(page);
				expect(
					Math.abs(offCentreAfter),
					"the board is not centred in its larger pane",
				).toBeLessThan(2);
				expect(Math.abs(offCentreWithCard)).toBeLessThan(2);
				expect(
					moves(leaving.frames).fits,
					"the board did not follow its pane",
				).toBeGreaterThan(1);
			} else {
				// The item goes up by exactly the room the card held: where it would have been
				// had no card ever shown.
				expect(
					Math.abs(closing.travel - room),
					"the item did not end where it would be without the card",
				).toBeLessThan(2);
			}
		});
	}

	test("the empty state's replay link is away while the replay card is up, and back when it goes", async ({
		page,
	}) => {
		const user = await createTourUser("en");
		await markToursSeen(user);
		const chatId = await startChatAs(page, user);
		await seedItem(user, chatId, "document", { empty: true });
		await reopenChat(page, chatId);
		await openItem(page, ITEM_TITLES.document);
		const link = page.getByTestId("document-empty-replay");
		await expect(link).toBeVisible({ timeout: 20_000 });

		await link.click();
		await expect(tourCard(page)).toBeVisible({ timeout: 20_000 });
		await expect(link).toHaveCount(0);

		await tourCard(page).getByTestId("artifact-tour-skip").click();
		await expect(tourCard(page)).toHaveCount(0);
		await expect(link).toBeVisible();
	});

	// A phone gets the card in its compact form (one row for the step line and the buttons, a
	// small picture): the Document's text starts above the middle of the screen while the card
	// is up, in the narrowest common width and in the language that runs longer.
	for (const { width, language } of [
		{ width: 390, language: "en" },
		{ width: 360, language: "hu" },
	] as const) {
		test.describe(`on a phone, ${width} px wide in ${language}`, () => {
			test.use({
				viewport: { width, height: 844 },
				hasTouch: true,
				isMobile: true,
			});

			test("the text does not start below the middle of the screen while the card is up", async ({
				page,
			}) => {
				await freshReader(page, "document", language);
				await page.getByTestId("artifact-count-button-compact").tap();
				await expect(panelList(page)).toBeVisible();
				await waitForMotionToSettle(page);
				await startRecording(page, {
					card: '[data-testid="artifact-tour"]',
					body: ".workspace-stage .ProseMirror",
				});
				await panelList(page)
					.getByTestId("artifact-row")
					.filter({ hasText: ITEM_TITLES.document })
					.tap();
				await expect(tourCard(page)).toBeVisible({ timeout: 20_000 });
				await page.waitForTimeout(400);
				await waitForMotionToSettle(page);
				const run = await stopRecording(page);

				const settled = run.frames.at(-1);
				const body = settled?.tracked.body;
				const card = settled?.tracked.card;
				expect(body && card).toBeTruthy();
				noteNumbers(`tour-phone-${width}-${language}`, {
					bodyTop: body?.y,
					cardBottom: card ? card.y + card.h : null,
				});
				// The text starts high on the screen (it does not wait below a card in the flow)...
				expect(body?.y ?? 9999).toBeLessThanOrEqual(844 / 2);
				// ...and what the card hides of it is the card's own height, not more than a half of the screen.
				expect((card?.y ?? 0) + (card?.h ?? 9999)).toBeLessThanOrEqual(844 / 2);
				// Nothing moved when the card came.
				const arrived = sinceCard(run.frames);
				const first = arrived[0]?.tracked.body;
				for (const frame of arrived) {
					if (!frame.tracked.body || !first) continue;
					expect(Math.abs(frame.tracked.body.y - first.y)).toBeLessThan(1.5);
				}

				// The compact card keeps a finger's room: Skip and Next are at least 44 px each way.
				for (const id of ["artifact-tour-skip", "artifact-tour-next"]) {
					const box = await tourCard(page).getByTestId(id).boundingBox();
					expect(
						box?.height ?? 0,
						`${id} is too short for a finger`,
					).toBeGreaterThanOrEqual(44);
					expect(
						box?.width ?? 0,
						`${id} is too narrow for a finger`,
					).toBeGreaterThanOrEqual(44);
				}
			});
		});
	}
});
