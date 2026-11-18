import { expect, type Page, test } from "@playwright/test";
import { buildAiSdkUiStreamBody, login } from "./helpers";

// "Send with Enter" (Settings > Profile, the Preferences card): with it on,
// Enter sends and Shift+Enter writes a new line in the message box, and
// Ctrl/⌘+Enter still sends; a touch-only screen keeps Enter for new lines
// (src/lib/components/chat/AGENTS.md, The Enter Key). The switch is the
// signed-in person's own, and this worker's other spec files meet the same
// admin, so every test puts it back off when it ends.

const REPLY = "Sent with Enter, answered by the stub.";

async function saveSendWithEnter(page: Page, enabled: boolean) {
	const response = await page.request.patch("/api/settings/preferences", {
		data: { sendWithEnter: enabled },
	});
	expect(response.ok(), `send with enter save -> ${response.status()}`).toBe(
		true,
	);
}

function sendWithEnterSwitch(page: Page) {
	return page.getByRole("switch", { name: "Send with Enter" });
}

async function openHomeComposer(page: Page) {
	await page.goto("/", { waitUntil: "domcontentloaded" });
	const input = page.getByTestId("message-input");
	await expect(input).toBeEnabled({ timeout: 15000 });
	return input;
}

test.describe("Send with Enter", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
		await page.route("**/api/chat/stream", async (route) => {
			await route.fulfill({
				status: 200,
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
				},
				body: buildAiSdkUiStreamBody(REPLY),
			});
		});
	});

	test.afterEach(async ({ page }) => {
		await saveSendWithEnter(page, false);
	});

	test("the switch in Settings saves, and the message box then sends on Enter and writes a new line on Shift+Enter", async ({
		page,
	}) => {
		await page.goto("/settings", { waitUntil: "domcontentloaded" });
		const toggle = sendWithEnterSwitch(page);
		await expect(toggle).toHaveAttribute("aria-checked", "false");
		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-checked", "true");
		// The switch holds still while it saves; enabled again, the save is in.
		await expect(toggle).toBeEnabled();

		// It is the account's: a new page load reads it back.
		await page.reload({ waitUntil: "domcontentloaded" });
		await expect(sendWithEnterSwitch(page)).toHaveAttribute(
			"aria-checked",
			"true",
		);

		const input = await openHomeComposer(page);
		await input.fill("first line");
		await input.press("Shift+Enter");
		await input.pressSequentially("second line");
		await expect(input).toHaveValue("first line\nsecond line");

		await input.press("Enter");

		const sent = page.getByTestId("user-message").first();
		await expect(sent).toContainText("first line", { timeout: 10000 });
		await expect(sent).toContainText("second line");
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			REPLY,
			{ timeout: 15000 },
		);
	});

	test("Ctrl/⌘+Enter still sends with the switch on", async ({ page }) => {
		await saveSendWithEnter(page, true);
		const input = await openHomeComposer(page);

		await input.fill("Old habits");
		await input.press("ControlOrMeta+Enter");

		await expect(page.getByTestId("user-message").first()).toContainText(
			"Old habits",
			{ timeout: 10000 },
		);
	});

	test.describe("on a touch-only screen", () => {
		test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

		test("Enter still writes a new line, since the keyboard has no Shift+Enter", async ({
			page,
		}) => {
			await saveSendWithEnter(page, true);
			const input = await openHomeComposer(page);
			expect(
				await page.evaluate(
					() => matchMedia("(hover: none) and (pointer: coarse)").matches,
				),
			).toBe(true);

			await input.fill("from a phone");
			await input.press("Enter");
			await input.pressSequentially("still here");

			await expect(input).toHaveValue("from a phone\nstill here");
			await expect(page).toHaveURL(/\/$/);
			await expect(page.getByTestId("user-message")).toHaveCount(0);
		});
	});
});
