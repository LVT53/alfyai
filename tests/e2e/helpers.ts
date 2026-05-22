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
}

export async function logout(page: Page) {
	const logoutBtn = page.getByRole("button", { name: "Logout" });
	if (await logoutBtn.isVisible()) {
		await logoutBtn.click();
		await page.waitForURL("/login", { timeout: 10000 });
	}
}

export async function openConversationComposer(page: Page) {
	await page.click('[data-testid="new-conversation"]');
	await expect(page).toHaveURL("/", { timeout: 10000 });
	await page.getByTestId("message-input").waitFor({ state: "visible" });
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
	await page.click('[data-testid="send-button"]');
}

export async function waitForAssistantResponse(page: Page, timeout = 30000) {
	await page.waitForFunction(
		() => {
			const msgs = document.querySelectorAll(
				'[data-testid="assistant-message"]',
			);
			for (const msg of msgs) {
				if (msg.textContent && msg.textContent.trim().length > 0) {
					return true;
				}
			}
			return false;
		},
		{ timeout },
	);
}

export { TEST_EMAIL, TEST_PASSWORD };
