import { expect, test } from "@playwright/test";
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
});
