import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import type {
	MemoryDetail,
	MemoryOperation,
	MemoryPage,
} from "../../src/lib/memory-types";
import { db } from "../../src/lib/server/db";
import { users } from "../../src/lib/server/db/schema";
import type { ConversationDetail } from "../../src/lib/server/services/conversation-detail/types";
import { createConversation as createServerConversation } from "../../src/lib/server/services/conversations";
import {
	CONVERSATION_MESSAGE_WINDOW_DEFAULT_LIMIT,
	createMessage,
} from "../../src/lib/server/services/messages";
import { setUiLanguage } from "./artifact-document-polish-helpers";
import {
	login,
	TEST_EMAIL,
	waitForHydration,
	waitForMotionToSettle,
} from "./helpers";

// Browser contract fixtures: native integration acceptance runs separately against
// the real delivery/curation boundary. These exercise the UI's asynchronous states.
const ref = {
	scope: { kind: "personal" },
	generation: "g1",
	rowId: "kayak",
} as const;
const row = {
	ref,
	text: "You own a green touring kayak and a white racing kayak.",
	updatedAt: "2026-11-18T09:00:00Z",
	sourceCount: 1,
};
const initial: MemoryPage = {
	authority: "hindsight",
	scope: ref.scope,
	generation: "g1",
	rows: [row],
	nextCursor: null,
	total: 1,
	status: "ready",
};
const detail: MemoryDetail = {
	row,
	sources: [
		{
			id: "source",
			conversationId: "fixture-chat",
			messageId: "fixture-message",
			title: "Kayak setup",
			quote: "My touring kayak is green. My racing kayak is white.",
			assertedAt: row.updatedAt,
			available: true,
		},
	],
	versions: [
		{ text: "A yellow touring kayak.", changedAt: "2026-11-16T09:00:00Z" },
	],
	canEdit: true,
	canRemove: true,
};
const failed: MemoryOperation = {
	id: "op",
	status: "failed",
	retryable: true,
	errorCode: "validation_failed",
	exclusionAcknowledged: false,
	cleanupPending: false,
	ref: null,
};
async function mount(
	page: Page,
	options: {
		operation?: MemoryOperation;
		record?: (body: unknown) => void;
	} = {},
) {
	await login(page);
	await page.route("**/api/knowledge/memory?*", async (route) => {
		const q = new URL(route.request().url()).searchParams.get("query");
		await route.fulfill({
			json: {
				...initial,
				rows:
					q && !row.text.toLowerCase().includes(q.toLowerCase()) ? [] : [row],
			},
		});
	});
	await page.route("**/api/knowledge/memory/kayak?*", (route) =>
		route.fulfill({ json: detail }),
	);
	await page.route("**/api/knowledge/memory/actions", async (route) => {
		options.record?.(route.request().postDataJSON());
		await route.fulfill({ json: options.operation ?? failed });
	});
	await page.route("**/api/knowledge/memory/operations/op", (route) =>
		route.fulfill({ json: options.operation ?? failed }),
	);
	await page.goto("/knowledge?tab=memory");
	await waitForHydration(page);
	await expect(page.getByTestId("memory-list")).toBeVisible();
}
async function open(page: Page) {
	await page.getByRole("button", { name: /You own a green/ }).click();
	await expect(page.getByTestId("memory-detail")).toBeVisible();
}
test("the approved list opens evidence and verified previous versions", {
	tag: "@smoke",
}, async ({ page }) => {
	await mount(page);
	await open(page);
	const heading = page
		.getByTestId("memory-detail")
		.getByRole("heading", { name: "Memory", exact: true });
	await expect(heading).toBeFocused();
	await expect(heading).toHaveCSS("outline-style", "none");
	await expect(page.getByRole("link", { name: "Kayak setup" })).toHaveAttribute(
		"href",
		"/chat/fixture-chat?focus_message=fixture-message",
	);
	await expect(page.getByText(detail.sources[0].quote)).toBeVisible();
	await page.getByRole("button", { name: /Previous versions/ }).click();
	await expect(page.getByText("No longer used")).toBeVisible();
	await expect(
		page.getByRole("button", { name: /Manage|Keep part|Correct/ }),
	).toHaveCount(0);
});
test("partial removal keeps the draft after rejected verification and retries the same action", async ({
	page,
}) => {
	const sent: unknown[] = [];
	await mount(page, { record: (body) => sent.push(body) });
	await open(page);
	await page.getByRole("button", { name: "Edit", exact: true }).click();
	const input = page.getByRole("textbox", { name: "Memory", exact: true });
	await input.fill("You own a touring kayak and a white racing kayak.");
	await page.getByRole("button", { name: "Save changes" }).click();
	await expect(page.getByRole("alert")).toContainText(
		"Your draft and saved memory are unchanged",
	);
	await expect(input).toHaveValue(
		"You own a touring kayak and a white racing kayak.",
	);
	await page.getByRole("button", { name: "Retry" }).click();
	await expect.poll(() => sent.length).toBe(2);
	expect(sent[1]).toEqual(sent[0]);
});
test("acknowledged removal remains excluded when its cleanup warning is dismissed", async ({
	page,
}) => {
	await mount(page, {
		operation: { ...failed, exclusionAcknowledged: true, cleanupPending: true },
	});
	await open(page);
	await page.getByRole("button", { name: "Remove", exact: true }).click();
	await page.getByRole("button", { name: "Remove", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText("no longer used");
	await page.getByRole("button", { name: "Close", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Remove", exact: true }),
	).toBeDisabled();
	await expect(
		page.getByText("This memory is no longer used. Cleanup is still pending."),
	).toBeVisible();
});
test("320px, reduced motion and keyboard return preserve the list context", async ({
	page,
}) => {
	await page.setViewportSize({ width: 320, height: 740 });
	await page.emulateMedia({ reducedMotion: "reduce" });
	await mount(page);
	const add = page.getByRole("button", { name: "Add memory" });
	async function cancelAddWithKeyboard() {
		await add.focus();
		await page.keyboard.press("Enter");
		await expect(page.getByTestId("memory-editor")).toBeVisible();
		await page.getByRole("button", { name: "Cancel" }).press("Enter");
		await expect(add).toBeFocused();
	}
	await cancelAddWithKeyboard();

	await page.getByRole("searchbox", { name: "Search memories" }).fill("kayak");
	const rowButton = page.getByRole("button", { name: /You own a green/ });
	await rowButton.focus();
	await page.keyboard.press("Enter");
	const heading = page
		.getByTestId("memory-detail")
		.getByRole("heading", { name: "Memory", exact: true });
	await expect(heading).toBeFocused();
	await expect(heading).toHaveCSS("outline-style", "solid");
	await expect(heading).toHaveCSS("outline-width", "2px");
	await expect(heading).toHaveCSS("outline-offset", "4px");
	await page.getByRole("button", { name: "Back to memories" }).click();
	await expect(
		page.getByRole("searchbox", { name: "Search memories" }),
	).toHaveValue("kayak");
	await expect(rowButton).toBeFocused();
	await cancelAddWithKeyboard();

	const chevron = rowButton.locator(".memory-row-chevron");
	await expect(chevron).toBeVisible();
	await page.mouse.move(0, 0);
	const restingX = await chevron.evaluate(
		(node) => node.getBoundingClientRect().x,
	);
	const restingColor = await rowButton.evaluate(
		(node) => getComputedStyle(node).backgroundColor,
	);
	await rowButton.hover();
	await expect
		.poll(() =>
			rowButton.evaluate((node) => getComputedStyle(node).backgroundColor),
		)
		.not.toBe(restingColor);
	await waitForMotionToSettle(page);
	expect(await chevron.evaluate((node) => node.getBoundingClientRect().x)).toBe(
		restingX,
	);

	const size = await page
		.getByTestId("memory-replacement")
		.evaluate((node) => ({
			scroll: node.scrollWidth,
			width: node.clientWidth,
		}));
	expect(size.scroll).toBeLessThanOrEqual(size.width);
	expect(
		await page
			.getByTestId("memory-replacement")
			.evaluate(
				(node) =>
					node
						.getAnimations({ subtree: true })
						.filter((animation) => animation.playState === "running").length,
			),
	).toBe(0);
});
test("a stale save requires review before another attempt", async ({
	page,
}) => {
	await mount(page, {
		operation: { ...failed, status: "stale", retryable: false },
	});
	await open(page);
	await page.getByRole("button", { name: "Edit", exact: true }).click();
	await page.getByRole("button", { name: "Save changes" }).click();
	await expect(
		page.getByRole("button", { name: "Save changes" }),
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Review latest version" }),
	).toBeVisible();
});

test("a Memory source loads the older authorized message window, highlights it, and returns to the visit", async ({
	page,
}) => {
	await mount(page);
	const [owner] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, TEST_EMAIL));
	const chat = await createServerConversation(
		owner.id,
		"Memory source navigation",
	);
	try {
		const source = await createMessage(
			chat.id,
			"user",
			"The older exact source is a green kayak.",
		);
		const laterMessages = CONVERSATION_MESSAGE_WINDOW_DEFAULT_LIMIT + 1;
		for (let index = 0; index < laterMessages; index++)
			await createMessage(
				chat.id,
				index % 2 ? "assistant" : "user",
				`Later message ${index}: enough content to make the conversation scroll.`,
			);
		const initialResponse = await page.request.get(
			`/api/conversations/${chat.id}`,
		);
		await expect(initialResponse).toBeOK();
		const initialChat: ConversationDetail = await initialResponse.json();
		expect(initialChat.hasMoreMessages).toBe(true);
		expect(initialChat.messages.map((message) => message.id)).not.toContain(
			source.id,
		);
		await page.unroute("**/api/knowledge/memory/kayak?*");
		await page.route("**/api/knowledge/memory/kayak?*", (route) =>
			route.fulfill({
				json: {
					...detail,
					sources: [
						{
							...detail.sources[0],
							conversationId: chat.id,
							messageId: source.id,
						},
					],
				},
			}),
		);
		await page
			.getByRole("searchbox", { name: "Search memories" })
			.fill("kayak");
		await open(page);
		await page.emulateMedia({ reducedMotion: "reduce" });
		let olderRequests = 0;
		page.on("request", (request) => {
			if (
				request.url().includes(`/api/conversations/${chat.id}/messages?offset=`)
			)
				olderRequests++;
		});
		await page.getByRole("link", { name: "Kayak setup" }).click();
		const target = page.locator(`[id="message-${source.id}"]`);
		await expect(target).toBeInViewport();
		await expect(target).toHaveClass(/history-flash/);
		await expect.poll(() => olderRequests).toBeGreaterThan(0);
		await expect(page).not.toHaveURL(/focus_message=/);
		await page.goBack();
		await expect(
			page.getByRole("searchbox", { name: "Search memories" }),
		).toHaveValue("kayak");
	} finally {
		await page.request.delete(`/api/conversations/${chat.id}`);
	}
});
test("a removed source message reports unavailable without jumping to a different reply", async ({
	page,
}) => {
	await mount(page);
	const [owner] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, TEST_EMAIL));
	const chat = await createServerConversation(
		owner.id,
		"Missing memory source",
	);
	try {
		await createMessage(chat.id, "user", "A surviving message.");
		await page.unroute("**/api/knowledge/memory/kayak?*");
		await page.route("**/api/knowledge/memory/kayak?*", (route) =>
			route.fulfill({
				json: {
					...detail,
					sources: [
						{
							...detail.sources[0],
							conversationId: chat.id,
							messageId: "deleted-source",
						},
					],
				},
			}),
		);
		await open(page);
		await page.getByRole("link", { name: "Kayak setup" }).click();
		await expect(
			page.getByText(
				"This message is no longer available. You can still read the rest of the conversation.",
			),
		).toBeVisible();
		await expect(page.locator(".history-flash")).toHaveCount(0);
	} finally {
		await page.request.delete(`/api/conversations/${chat.id}`);
	}
});
test("the hover treatment has real inset and motion, and long rows fit at 320px", async ({
	page,
}) => {
	await page.emulateMedia({ reducedMotion: "no-preference" });
	await mount(page);
	const item = page.getByRole("button", { name: /You own a green/ });
	const chevron = item.locator(".memory-row-chevron");
	await expect(chevron).toBeVisible();
	await page.mouse.move(0, 0);
	await waitForMotionToSettle(page);
	const restingX = await chevron.evaluate(
		(node) => node.getBoundingClientRect().x,
	);
	const rest = await item.evaluate(
		(node) => getComputedStyle(node).backgroundColor,
	);
	await item.hover();
	await expect
		.poll(() => item.evaluate((node) => getComputedStyle(node).backgroundColor))
		.not.toBe(rest);
	await waitForMotionToSettle(page);
	expect(
		await chevron.evaluate((node) => node.getBoundingClientRect().x),
	).toBeCloseTo(restingX + 2, 1);
	const padding = await item.evaluate((node) => ({
		left: parseFloat(getComputedStyle(node).paddingLeft),
		right: parseFloat(getComputedStyle(node).paddingRight),
		duration: getComputedStyle(node).transitionDuration,
	}));
	expect(padding.left).toBeGreaterThanOrEqual(12);
	expect(padding.right).toBeGreaterThanOrEqual(12);
	expect(padding.duration).toContain("0.15s");
	await page.setViewportSize({ width: 320, height: 740 });
	await page.route("**/api/knowledge/memory?*", (route) =>
		route.fulfill({
			json: {
				...initial,
				rows: [
					{
						...row,
						text: "Hosszú magyar emlék több részlettel és összetartozó információval. ".repeat(
							12,
						),
					},
				],
			},
		}),
	);
	await setUiLanguage("hu");
	await page.reload();
	try {
		await expect(
			page.getByRole("heading", { name: "Amire Alfy emlékszik" }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: /Hosszú magyar emlék/ }),
		).toBeVisible();
		await expect(page.getByTestId("memory-list")).toBeVisible();
		expect(
			await page
				.getByTestId("memory-replacement")
				.evaluate((node) => node.scrollWidth <= node.clientWidth),
		).toBe(true);
	} finally {
		await setUiLanguage("en");
	}
});
