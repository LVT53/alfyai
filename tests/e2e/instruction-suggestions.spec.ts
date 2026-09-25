import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import { conversations, users } from "../../src/lib/server/db/schema";
import { createConversation as createServerConversation } from "../../src/lib/server/services/conversations";
import { createMessage } from "../../src/lib/server/services/messages";
import type { InstructionSuggestion } from "../../src/lib/shared/instructions";
import { login, TEST_EMAIL, waitForHydration } from "./helpers";

/**
 * The AI instruction offer, end to end: a row under the reply, Review and
 * Dismiss, and the answer surviving a reload.
 *
 * The suggestion itself is seeded into the message's metadata rather than
 * produced by a real turn — what these tests are about is what the row does
 * with an offer and where the answer is kept, not how the model came to make
 * one.
 */

/**
 * Deliberately hostile to a phone-width row: a model-written instruction can
 * carry a long unbreakable token (here a link) and a quote is arbitrary text
 * either way. A row that only survives short sentences is not the slice's
 * "wraps rather than overflowing on the phone" claim.
 */
const SUGGESTION_TEXT =
	"Always cite https://intranet.example.internal/teams/engineering/handbook/meetings/retrospective/checklist at the end of every summary.";
const ASSISTANT_REPLY = "Understood, trains only.";

function makeSuggestion(): InstructionSuggestion {
	return {
		id: randomUUID(),
		status: "pending",
		text: SUGGESTION_TEXT,
		scope: { kind: "personal" },
		createdAt: Date.now(),
	};
}

async function adminUserId(): Promise<string> {
	const [row] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, TEST_EMAIL))
		.limit(1);
	if (!row) throw new Error(`Seeded user ${TEST_EMAIL} not found`);
	return row.id;
}

async function seedConversationWithSuggestion(params: {
	incognito?: boolean;
}): Promise<string> {
	const userId = await adminUserId();
	const conversation = await createServerConversation(
		userId,
		"Instruction suggestion E2E",
	);
	if (params.incognito) {
		await db
			.update(conversations)
			.set({ memoryIncognito: true })
			.where(eq(conversations.id, conversation.id));
	}
	await createMessage(
		conversation.id,
		"user",
		"From now on, only suggest trains. We don't fly.",
	);
	await createMessage(
		conversation.id,
		"assistant",
		ASSISTANT_REPLY,
		undefined,
		undefined,
		{ instructionSuggestions: [makeSuggestion()] },
	);
	return conversation.id;
}

async function setPersonalInstructions(page: Page, text: string) {
	const result = await page.evaluate(async (value) => {
		const response = await fetch("/api/settings/preferences", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ personalInstructions: value }),
		});
		return { ok: response.ok, status: response.status };
	}, text);
	expect(result.ok, `Failed to set instructions: ${result.status}`).toBe(true);
}

async function readPersonalInstructions(page: Page): Promise<string | null> {
	const value = await page.evaluate(async () => {
		const response = await fetch("/api/settings");
		const body = (await response.json()) as {
			preferences?: { personalInstructions?: string | null };
		};
		return body.preferences?.personalInstructions ?? null;
	});
	return value;
}

async function openSeededChat(page: Page, conversationId: string) {
	await page.goto(`/chat/${conversationId}`, { waitUntil: "domcontentloaded" });
	await waitForHydration(page);
	await expect(page.getByText(ASSISTANT_REPLY)).toBeVisible({ timeout: 15000 });
}

async function setTheme(page: Page, theme: "system" | "light" | "dark") {
	const result = await page.evaluate(async (nextTheme) => {
		const response = await fetch("/api/settings/preferences", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ theme: nextTheme }),
		});
		return { ok: response.ok, status: response.status };
	}, theme);
	expect(result.ok, `Failed to set theme: ${result.status}`).toBe(true);
}

const PHONE = { width: 390, height: 844 };

/**
 * The row may wrap, but nothing in it may leave the phone's width or be
 * clipped by its own box — the slice's §M4 "the row wraps rather than
 * overflowing on the phone" claim.
 */
async function expectRowFitsPhone(
	page: Page,
	row: ReturnType<typeof suggestionRow>,
) {
	await expect(row).toBeVisible();
	const documentOverflow = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		innerWidth: window.innerWidth,
	}));
	expect(
		documentOverflow.scrollWidth,
		"the page must not scroll sideways on a phone",
	).toBeLessThanOrEqual(documentOverflow.innerWidth + 1);

	// The quote is an inline span, so its per-line fragments are the honest
	// measurement — a union rect would claim space between the lines it wraps
	// over. Each fragment has to stay inside the row's box and off the
	// buttons: text painted under Review/Dismiss is the failure that a
	// "wraps anywhere" rule prevents.
	const geometry = await row.evaluate((element) => {
		const text = element.querySelector(".instruction-suggestion__text");
		if (!text) throw new Error("Suggestion quote element not found.");
		const range = document.createRange();
		range.selectNodeContents(text);
		const rowRect = element.getBoundingClientRect();
		return {
			row: {
				left: rowRect.left,
				right: rowRect.right,
				top: rowRect.top,
				bottom: rowRect.bottom,
			},
			fragments: Array.from(range.getClientRects()).map((rect) => ({
				left: rect.left,
				right: rect.right,
				top: rect.top,
				bottom: rect.bottom,
			})),
		};
	});
	expect(
		geometry.fragments.length,
		"the quote must be measurable",
	).toBeGreaterThan(0);

	const actions = await row
		.locator(".instruction-suggestion__actions")
		.boundingBox();
	if (!actions) throw new Error("Suggestion actions were not measurable.");
	const actionsRect = {
		left: actions.x,
		right: actions.x + actions.width,
		top: actions.y,
		bottom: actions.y + actions.height,
	};

	for (const fragment of geometry.fragments) {
		expect(
			fragment.left,
			"the quote must start inside its row",
		).toBeGreaterThanOrEqual(geometry.row.left - 1);
		expect(
			fragment.right,
			"the quote must end inside its row",
		).toBeLessThanOrEqual(geometry.row.right + 1);
		const overlapsActions =
			fragment.right > actionsRect.left + 1 &&
			fragment.left < actionsRect.right - 1 &&
			fragment.bottom > actionsRect.top + 1 &&
			fragment.top < actionsRect.bottom - 1;
		expect(
			overlapsActions,
			"the quote must not be painted over the Review/Dismiss buttons",
		).toBe(false);
	}

	const buttons = await Promise.all(
		[
			row.getByRole("button", { name: "Review" }),
			row.getByRole("button", { name: "Dismiss" }),
		].map((locator) => locator.boundingBox()),
	);
	for (const box of buttons) {
		if (!box) throw new Error("Suggestion row button was not measurable.");
		expect(box.x).toBeGreaterThanOrEqual(-1);
		expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width + 1);
	}
}

const suggestionRow = (page: Page) =>
	page.getByTestId("instruction-suggestion");

test.describe("AI instruction suggestions", () => {
	test("keeps a dismissed suggestion dismissed after a reload", async ({
		page,
	}) => {
		await login(page);
		const conversationId = await seedConversationWithSuggestion({});
		await openSeededChat(page, conversationId);

		const row = suggestionRow(page);
		await expect(row).toBeVisible({ timeout: 15000 });
		await expect(row).toContainText(SUGGESTION_TEXT);

		await row.getByRole("button", { name: "Dismiss" }).click();
		await expect(suggestionRow(page)).toHaveCount(0);

		await page.reload({ waitUntil: "domcontentloaded" });
		await waitForHydration(page);
		await expect(page.getByText(ASSISTANT_REPLY)).toBeVisible({
			timeout: 15000,
		});
		await expect(suggestionRow(page)).toHaveCount(0);
	});

	test("keeps a reviewed suggestion reviewed after a reload, and saves the text", async ({
		page,
	}) => {
		await login(page);
		await setPersonalInstructions(page, "Always answer in Hungarian.");
		const conversationId = await seedConversationWithSuggestion({});
		await openSeededChat(page, conversationId);

		const row = suggestionRow(page);
		await expect(row).toBeVisible({ timeout: 15000 });

		// Review is not an accept: cancelling leaves both the instructions and
		// the offer exactly as they were.
		await row.getByRole("button", { name: "Review" }).click();
		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible({ timeout: 10000 });
		await expect(
			page.getByRole("textbox", { name: "Instructions for Personal" }),
		).toHaveValue(`Always answer in Hungarian.\n${SUGGESTION_TEXT}`);
		await expect(dialog.locator("mark")).toHaveText(SUGGESTION_TEXT);
		await dialog.getByRole("button", { name: "Cancel" }).click();
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await expect(suggestionRow(page)).toBeVisible();
		expect(await readPersonalInstructions(page)).toBe(
			"Always answer in Hungarian.",
		);

		await suggestionRow(page).getByRole("button", { name: "Review" }).click();
		await expect(page.getByRole("dialog")).toBeVisible({ timeout: 10000 });
		await page
			.getByRole("dialog")
			.getByRole("button", { name: "Save" })
			.click();
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await expect(suggestionRow(page)).toHaveCount(0);
		expect(await readPersonalInstructions(page)).toBe(
			`Always answer in Hungarian.\n${SUGGESTION_TEXT}`,
		);

		await page.reload({ waitUntil: "domcontentloaded" });
		await waitForHydration(page);
		await expect(page.getByText(ASSISTANT_REPLY)).toBeVisible({
			timeout: 15000,
		});
		await expect(suggestionRow(page)).toHaveCount(0);
	});

	test("wraps the row on a phone, in both themes", async ({ page }) => {
		await page.setViewportSize(PHONE);
		await login(page);
		const previousTheme = await page.evaluate(async () => {
			const response = await fetch("/api/settings");
			const body = (await response.json()) as {
				preferences?: { theme?: "system" | "light" | "dark" };
			};
			return body.preferences?.theme ?? "system";
		});
		try {
			const conversationId = await seedConversationWithSuggestion({});
			await openSeededChat(page, conversationId);
			await expectRowFitsPhone(page, suggestionRow(page));

			// The theme is switched through the preference, not localStorage:
			// the store reads the preference, and the class on <html> is the
			// only proof the dark stylesheet is actually in force.
			await setTheme(page, "dark");
			await page.reload({ waitUntil: "domcontentloaded" });
			await waitForHydration(page);
			await expect(page.locator("html")).toHaveClass(/(^|\s)dark(\s|$)/);
			await expect(suggestionRow(page)).toBeVisible({ timeout: 15000 });
			await expectRowFitsPhone(page, suggestionRow(page));
		} finally {
			await setTheme(page, previousTheme);
		}
	});

	test("shows no suggestion row in an incognito conversation", async ({
		page,
	}) => {
		await login(page);
		const conversationId = await seedConversationWithSuggestion({
			incognito: true,
		});
		await openSeededChat(page, conversationId);

		await expect(page.getByTestId("incognito-opening")).toBeVisible({
			timeout: 15000,
		});
		await expect(suggestionRow(page)).toHaveCount(0);
	});
});
