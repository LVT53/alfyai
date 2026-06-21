import { expect, type Page } from "@playwright/test";

const TEST_EMAIL = process.env.E2E_EMAIL || "admin@local";
const TEST_PASSWORD = process.env.E2E_PASSWORD || "admin123";

export async function login(
	page: Page,
	email = TEST_EMAIL,
	password = TEST_PASSWORD,
) {
	await page.goto("/login", { waitUntil: "domcontentloaded" });
	const result = await page.evaluate(
		async ({ email: nextEmail, password: nextPassword }) => {
			const response = await fetch("/api/auth/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email: nextEmail, password: nextPassword }),
			});

			return {
				ok: response.ok,
				status: response.status,
			};
		},
		{ email, password },
	);

	expect(result.ok, `Login failed with status ${result.status}`).toBe(true);
	await page.goto("/", { waitUntil: "domcontentloaded" });
	await expect(page.getByTestId("message-input")).toBeVisible({
		timeout: 15000,
	});
	await expect(page.getByTestId("message-input")).toBeEnabled({
		timeout: 15000,
	});
}

export async function logout(page: Page) {
	const logoutBtn = page.getByRole("button", { name: "Logout" });
	if (await logoutBtn.isVisible()) {
		await logoutBtn.click();
		await page.waitForURL("/login", { timeout: 10000 });
	}
}

export async function openConversationComposer(
	page: Page,
	_options: { skipIfAlreadyOpen?: boolean } = {},
) {
	const composer = page.getByTestId("message-input");
	if (new URL(page.url()).pathname === "/" && (await composer.isVisible())) {
		await expect(composer).toBeEnabled({ timeout: 15000 });
		return;
	}

	await page.click('[data-testid="new-conversation"]');
	await expect(page).toHaveURL("/", { timeout: 10000 });
	await composer.waitFor({ state: "visible" });
	await expect(composer).toBeEnabled({ timeout: 15000 });
}

export async function ensureSidebarExpanded(page: Page) {
	await page
		.locator("aside.transitions-enabled")
		.waitFor({ state: "visible", timeout: 5000 });
	const expandButton = page.getByRole("button", { name: "Expand sidebar" });
	if (await expandButton.isVisible().catch(() => false)) {
		await expandButton.click();
	}
	await expect(
		page.getByRole("button", { name: "Collapse sidebar" }),
	).toBeVisible({ timeout: 5000 });
}

export async function createConversation(
	page: Page,
	firstMessage = "Create a test conversation",
): Promise<string> {
	await openConversationComposer(page);
	await sendMessage(page, firstMessage);
	await page.waitForURL(/\/chat\//, { timeout: 15000 });
	const url = page.url();
	const match = url.match(/\/chat\/([^/?#]+)/);
	return match ? match[1] : "";
}

export async function sendMessage(page: Page, text: string) {
	const input = page.getByTestId("message-input");
	await input.waitFor({ state: "visible" });
	await input.fill(text);
	const sendButton = page.getByTestId("send-button");
	await expect(sendButton).toBeEnabled({ timeout: 10000 });
	await sendButton.click();
}

export async function waitForAssistantResponse(page: Page, timeout = 30000) {
	await expect(
		page.getByTestId("assistant-message").filter({ hasText: /\S/ }).first(),
	).toBeVisible({ timeout });
}

export async function advancePastConversationRefreshDebounce(page: Page) {
	await page.evaluate(() => {
		const currentNow = Date.now();
		Date.now = () => currentNow + 2100;
	});
}

export function buildAiSdkUiStreamBody(text: string): string {
	const words = text.split(" ");
	const chunks = [
		[
			"data: ",
			JSON.stringify({
				type: "text-start",
				id: "answer",
			}),
			"\n\n",
		].join(""),
	];
	chunks.push(
		...words.map((word, index) =>
			[
				"data: ",
				JSON.stringify({
					type: "text-delta",
					id: "answer",
					delta: word + (index < words.length - 1 ? " " : ""),
				}),
				"\n\n",
			].join(""),
		),
	);
	chunks.push(
		[
			"data: ",
			JSON.stringify({
				type: "text-end",
				id: "answer",
			}),
			"\n\n",
			"data: ",
			JSON.stringify({
				type: "data-stream-metadata",
				data: {},
				transient: true,
			}),
			"\n\n",
			"data: ",
			JSON.stringify({ type: "finish", finishReason: "stop" }),
			"\n\n",
			"data: [DONE]\n\n",
		].join(""),
	);
	return chunks.join("");
}

export { TEST_EMAIL, TEST_PASSWORD };
