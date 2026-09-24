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

const SUGGESTION_TEXT = "Only suggest trains, no flights.";
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
