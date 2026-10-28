import { expect, type Locator, test } from "@playwright/test";
import {
	buildAiSdkUiStreamBody,
	login,
	openConversationComposer,
	waitForAssistantResponse,
} from "./helpers";

// A follow-up chip is the person's next message: a tap sends its text, as it
// stands, as the user's own message (no composer in between), so what the chip
// says is what lands in the conversation.

const CHIP_COMPARE = "Compare the two options in a table";
const CHIP_DRAFT = "Draft the email to my landlord";
const FIRST_REPLY = "Both flats are fine; the second has the shorter commute.";
const SECOND_REPLY = "Here is the comparison you asked for.";

/**
 * What a reader actually sees of an element: its own opacity times every
 * ancestor's. `toBeVisible()` cannot say: an element at opacity 0 is "visible"
 * to Playwright, which is how chips that were invisible at rest passed.
 */
async function seenOpacity(locator: Locator): Promise<number> {
	return locator.evaluate((element) => {
		let opacity = 1;
		for (let node: Element | null = element; node; node = node.parentElement) {
			opacity *= Number.parseFloat(getComputedStyle(node).opacity);
		}
		return opacity;
	});
}

async function openChatWithChips(page: import("@playwright/test").Page) {
	const streamRequests: string[] = [];
	await page.route("**/api/chat/stream", async (route) => {
		streamRequests.push(route.request().postData() ?? "");
		const first = streamRequests.length === 1;
		await route.fulfill({
			status: 200,
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
			body: first
				? buildAiSdkUiStreamBody(FIRST_REPLY, {
						followUps: [CHIP_COMPARE, CHIP_DRAFT],
					})
				: buildAiSdkUiStreamBody(SECOND_REPLY),
		});
	});

	await openConversationComposer(page);
	await page.getByTestId("message-input").fill("Which flat should I take?");
	await page.getByTestId("send-button").click();
	await waitForAssistantResponse(page);
	await expect(page.getByText(FIRST_REPLY)).toBeVisible();
	return streamRequests;
}

test.describe("Follow-up chips", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("shows the chips under the latest reply, named for what a tap does", async ({
		page,
	}) => {
		await openChatWithChips(page);

		await expect(
			page.getByRole("button", { name: `Send: ${CHIP_COMPARE}` }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: `Send: ${CHIP_DRAFT}` }),
		).toBeVisible();
	});

	test("a pointer tap sends the chip's own text as the user's next message", async ({
		page,
	}) => {
		const streamRequests = await openChatWithChips(page);

		await page.getByRole("button", { name: `Send: ${CHIP_COMPARE}` }).click();

		// The text the person tapped is the message that went out, and the one
		// they now see as theirs.
		await expect.poll(() => streamRequests.length).toBe(2);
		expect(streamRequests[1]).toContain(CHIP_COMPARE);
		await expect(page.getByText(SECOND_REPLY)).toBeVisible();
		await expect(
			page.getByText(CHIP_COMPARE, { exact: true }).first(),
		).toBeVisible();
	});

	test("the keyboard reaches a chip and Enter sends it", async ({ page }) => {
		const streamRequests = await openChatWithChips(page);

		const chip = page.getByRole("button", { name: `Send: ${CHIP_DRAFT}` });
		await chip.focus();
		await expect(chip).toBeFocused();
		await page.keyboard.press("Enter");

		await expect.poll(() => streamRequests.length).toBe(2);
		expect(streamRequests[1]).toContain(CHIP_DRAFT);
		await expect(page.getByText(SECOND_REPLY)).toBeVisible();
	});
	// Task 15 (the owner's call, reversing F17): on a desktop the chips wait for
	// the pointer like the message's icon row above them, and are revealed with
	// it, by the same rule: one hover shows both, and nothing moves.
	test("hides the chips at rest on a desktop and reveals them with the icon row, moving nothing", async ({
		page,
	}) => {
		await openChatWithChips(page);
		await page.mouse.move(4, 4);

		// The last "Copy message" is the reply's (the first is the question's).
		const copy = page.getByRole("button", { name: "Copy message" }).last();
		const chip = page.getByRole("button", { name: `Send: ${CHIP_COMPARE}` });
		await expect.poll(() => seenOpacity(chip)).toBe(0);
		await expect.poll(() => seenOpacity(copy)).toBe(0);
		const chipBefore = await chip.boundingBox();
		const copyBefore = await copy.boundingBox();

		await page.getByText(FIRST_REPLY).hover();
		await expect.poll(() => seenOpacity(copy)).toBe(1);
		await expect.poll(() => seenOpacity(chip)).toBe(1);
		// The reveal is opacity alone: the rows kept their space.
		expect(await chip.boundingBox()).toEqual(chipBefore);
		expect(await copy.boundingBox()).toEqual(copyBefore);

		// And they leave together.
		await page.mouse.move(4, 4);
		await expect.poll(() => seenOpacity(chip)).toBe(0);
		await expect.poll(() => seenOpacity(copy)).toBe(0);

		// A little room between the icon row and the chips (a space token).
		const copyBox = await copy.boundingBox();
		const chipBox = await chip.boundingBox();
		expect(copyBox && chipBox).toBeTruthy();
		if (copyBox && chipBox) {
			expect(chipBox.y - (copyBox.y + copyBox.height)).toBeGreaterThanOrEqual(
				8,
			);
		}
	});

	test("keyboard focus on a chip reveals the chips and the icon row together", async ({
		page,
	}) => {
		await openChatWithChips(page);
		await page.mouse.move(4, 4);
		const copy = page.getByRole("button", { name: "Copy message" }).last();
		const chip = page.getByRole("button", { name: `Send: ${CHIP_DRAFT}` });
		await expect.poll(() => seenOpacity(chip)).toBe(0);

		await chip.focus();
		await expect.poll(() => seenOpacity(chip)).toBe(1);
		await expect.poll(() => seenOpacity(copy)).toBe(1);
	});

	test("reduced motion: the reveal does not animate", async ({ browser }) => {
		const context = await browser.newContext({ reducedMotion: "reduce" });
		const page = await context.newPage();
		try {
			await login(page);
			await openChatWithChips(page);
			const chip = page.getByRole("button", { name: `Send: ${CHIP_COMPARE}` });
			const duration = await chip.evaluate((element) => {
				const block = element.closest(".message-actions");
				return block ? getComputedStyle(block).transitionDuration : "";
			});
			expect(Number.parseFloat(duration)).toBeLessThan(0.001);
		} finally {
			await context.close();
		}
	});
});

test.describe("Follow-up chips on a phone", () => {
	test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	// The icon row's own touch rule: below md there is no hover, so both rows show at rest.
	test("shows the chips and the icon row at rest", async ({ page }) => {
		await openChatWithChips(page);
		const chip = page.getByRole("button", { name: `Send: ${CHIP_COMPARE}` });
		const copy = page.getByRole("button", { name: "Copy message" }).last();
		await expect.poll(() => seenOpacity(chip)).toBe(1);
		await expect.poll(() => seenOpacity(copy)).toBe(1);
	});
});

// Fix round 1 (review Minor 1): the reveal follows the device, not the width. A
// wide touch screen (an iPad in landscape: no hover) keeps both rows shown at
// rest, as a phone does; only a device that can hover waits for the pointer.
test.describe("Follow-up chips on a wide touch screen", () => {
	test.use({ viewport: { width: 1180, height: 820 }, hasTouch: true });

	test.beforeEach(async ({ page }) => {
		const cdp = await page.context().newCDPSession(page);
		await cdp.send("Emulation.setEmulatedMedia", {
			features: [
				{ name: "hover", value: "none" },
				{ name: "any-hover", value: "none" },
				{ name: "pointer", value: "coarse" },
			],
		});
		await login(page);
	});

	test("shows the chips and the icon row at rest", async ({ page }) => {
		await openChatWithChips(page);
		await page.mouse.move(4, 4);
		const chip = page.getByRole("button", { name: `Send: ${CHIP_COMPARE}` });
		const copy = page.getByRole("button", { name: "Copy message" }).last();
		await expect.poll(() => seenOpacity(chip)).toBe(1);
		await expect.poll(() => seenOpacity(copy)).toBe(1);
	});
});
