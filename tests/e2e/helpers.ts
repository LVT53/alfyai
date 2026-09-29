import { expect, type Locator, type Page } from "@playwright/test";

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

/**
 * SvelteKit renders `#svelte-announcer` only once the root component has
 * mounted, so its arrival is the framework's own word that the page is
 * hydrated. Clicking before that lands on inert server markup: the button is
 * visible, enabled and unobstructed — every actionability check Playwright
 * makes passes — but no handler is attached yet and the click is silently
 * swallowed.
 */
export async function waitForHydration(page: Page) {
	await page.waitForSelector("#svelte-announcer", {
		state: "attached",
		timeout: 20_000,
	});
}

export async function logout(page: Page) {
	const logoutBtn = page.getByRole("button", { name: "Logout" });
	if (await logoutBtn.isVisible()) {
		await logoutBtn.click();
		// ADR-0043 Slice 16: logout now opens a ConfirmDialog before ending
		// the session. Confirm to proceed to /login.
		const confirmBtn = page.getByTestId("confirm-delete");
		if (await confirmBtn.isVisible().catch(() => false)) {
			await confirmBtn.click();
		}
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

/**
 * Waits until `locator`'s bounding box reports the same rect across two
 * consecutive animation frames. A plain `.boundingBox()` call has no
 * actionability wait at all (unlike `.click()`, which Playwright itself
 * holds back until its target is frame-stable) — reading it right after
 * an action that starts a CSS/WAAPI transition, such as the Document
 * panel's open/push entrance motion (1c1634d2, a46d8fd8), can capture a
 * mid-slide rect instead of the settled one. Callers that snapshot a
 * container's box to assert something against it later should await this
 * first.
 */
export async function waitForStableBoundingBox(
	locator: Locator,
	options: { timeout?: number } = {},
): Promise<void> {
	const timeout = options.timeout ?? 5000;
	const deadline = Date.now() + timeout;
	const page = locator.page();
	let previous = await locator.boundingBox();
	while (Date.now() < deadline) {
		await page.evaluate(
			() =>
				new Promise<void>((resolve) => {
					requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
				}),
		);
		const current = await locator.boundingBox();
		if (
			previous &&
			current &&
			previous.x === current.x &&
			previous.y === current.y &&
			previous.width === current.width &&
			previous.height === current.height
		) {
			return;
		}
		previous = current;
	}
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

/**
 * The open workspace panel's landmark name is the item it shows ("Trip notes,
 * Document"; rd/review-2-5.md:276-279), so it is found by that shape and not by
 * one fixed name. Matches the kind at the end, in English.
 */
const WORKSPACE_PANEL_NAME = /, (Document|App|Canvas|Slides|File)$/;

export function workspacePanel(page: Page): Locator {
	return page.getByRole("complementary", { name: WORKSPACE_PANEL_NAME });
}
