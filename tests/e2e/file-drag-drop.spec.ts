import { expect, type Page, test } from "@playwright/test";
import { buildAiSdkUiStreamBody, login } from "./helpers";

async function dispatchChatDrag(
	page: Page,
	eventType: "dragenter" | "dragleave",
	types: string[],
	dropEffect: DataTransfer["dropEffect"] = "copy",
): Promise<{ defaultPrevented: boolean }> {
	return page.locator(".chat-page").evaluate(
		(element, payload) => {
			const dataTransfer = {
				types: payload.types,
				files: { length: payload.types.includes("Files") ? 1 : 0 },
				dropEffect: payload.dropEffect,
				effectAllowed: "all",
			};
			const event = new Event(payload.eventType, {
				bubbles: true,
				cancelable: true,
			});
			Object.defineProperty(event, "dataTransfer", {
				value: dataTransfer,
			});

			element.dispatchEvent(event);
			return { defaultPrevented: event.defaultPrevented };
		},
		{ eventType, types, dropEffect },
	);
}

test.describe("File Drag and Drop", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("drop zone overlay appears when dragging files onto landing page", async ({
		page,
	}) => {
		await page.goto("/");
		await expect(page.getByTestId("message-input")).toBeVisible({
			timeout: 10000,
		});
		await page.getByTestId("message-input").click();

		await expect(
			dispatchChatDrag(page, "dragenter", ["Files"]),
		).resolves.toEqual({
			defaultPrevented: true,
		});

		await expect(page.getByTestId("drop-zone-overlay")).toBeVisible();
		await expect(page.getByTestId("drop-zone-overlay")).toContainText(
			"Drop files to attach",
		);

		await dispatchChatDrag(page, "dragleave", ["Files"]);

		await expect(page.getByTestId("drop-zone-overlay")).not.toBeVisible();
	});

	test("drop zone overlay appears when dragging files onto chat page", async ({
		page,
	}) => {
		await page.route("**/api/chat/stream", async (route) => {
			await route.fulfill({
				status: 200,
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
				},
				body: buildAiSdkUiStreamBody("Ready"),
			});
		});

		await page.getByTestId("new-conversation").click();
		await expect(page.getByTestId("message-input")).toBeVisible({
			timeout: 10000,
		});

		await page.getByTestId("message-input").fill("Hello");
		await page.getByTestId("send-button").click();
		await page.waitForURL(/\/chat\//, { timeout: 15000 });
		await expect(page.getByTestId("message-input")).toBeVisible({
			timeout: 10000,
		});
		await expect(page.getByTestId("assistant-message")).toContainText("Ready", {
			timeout: 10000,
		});
		await page.getByTestId("message-input").click();

		await expect(
			dispatchChatDrag(page, "dragenter", ["Files"]),
		).resolves.toEqual({
			defaultPrevented: true,
		});

		await expect(page.getByTestId("drop-zone-overlay")).toBeVisible();
		await expect(page.getByTestId("drop-zone-overlay")).toContainText(
			"Drop files to attach",
		);
	});

	test("internal conversation drag does not trigger drop zone overlay", async ({
		page,
	}) => {
		await page.goto("/");
		await expect(page.getByTestId("message-input")).toBeVisible({
			timeout: 10000,
		});

		// Internal conversation DnD uses application/x-alfyai-conversation, not Files
		await expect(
			dispatchChatDrag(
				page,
				"dragenter",
				["application/x-alfyai-conversation", "text/plain"],
				"move",
			),
		).resolves.toEqual({ defaultPrevented: false });

		await expect(page.getByTestId("drop-zone-overlay")).not.toBeVisible();
	});

	test("drop zone is rejected when streaming is active", async ({ page }) => {
		let releaseStream: (() => void) | undefined;
		const heldStream = new Promise<void>((resolve) => {
			releaseStream = resolve;
		});
		await page.route("**/api/chat/stream", async (route) => {
			await Promise.race([
				heldStream,
				new Promise((resolve) => setTimeout(resolve, 15_000)),
			]);
			await route.fulfill({
				status: 200,
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
				},
				body: buildAiSdkUiStreamBody("Hello"),
			});
		});

		await page.getByTestId("new-conversation").click();
		await expect(page.getByTestId("message-input")).toBeVisible({
			timeout: 10000,
		});

		await page.getByTestId("message-input").fill("Test");
		await page.getByTestId("send-button").click();
		await page.waitForURL(/\/chat\//, { timeout: 15000 });
		await page.waitForTimeout(500);

		await expect(
			dispatchChatDrag(page, "dragenter", ["Files"]),
		).resolves.toEqual({
			defaultPrevented: true,
		});

		await expect(page.getByTestId("drop-zone-overlay")).toBeVisible();
		await expect(page.getByTestId("drop-zone-overlay")).toContainText(
			"Cannot upload while generating",
		);
		releaseStream?.();
	});

	test("drag without Files dataTransfer type is ignored", async ({ page }) => {
		await page.goto("/");
		await expect(page.getByTestId("message-input")).toBeVisible({
			timeout: 10000,
		});

		// Text selection drag has no Files type — should not trigger overlay
		await expect(
			dispatchChatDrag(page, "dragenter", ["text/plain"]),
		).resolves.toEqual({ defaultPrevented: false });

		await expect(page.getByTestId("drop-zone-overlay")).not.toBeVisible();
	});
});
