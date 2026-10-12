import { expect, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import { users } from "../../src/lib/server/db/schema";
import {
	AI_SMOKE_ITEM_TURN_FINAL_TEXT,
	type ItemTurnMode,
	itemTurnMessage,
} from "../fixtures/ai/chat-turn-scenarios";
import {
	createTemporaryFakeProviderModel,
	deleteTemporaryProvider,
	snapshotUserModelPreference,
	updateUserModelPreference,
} from "./artifact-live-edit.helpers";
import { createEmptyConversation, login, sendMessage } from "./helpers";

// What the specs of a turn that makes a Document and works on it share (FX-1,
// RC-A #2 and the owner's call on F16): the e2e admin's language, and the scripted
// turn itself (tests/mocks/ai-provider/chat-turn-scripts.ts), driven the way a
// reader does it: type, press Send, wait for the reply to end.

export async function setLanguage(language: "en" | "hu") {
	await db
		.update(users)
		.set({ uiLanguage: language })
		.where(eq(users.email, "admin@local"));
}

/** Runs the scripted turn in a new chat and returns once the reply has ended. */
export async function runItemTurn(
	page: Page,
	fakeProviderBaseURL: string,
	mode: ItemTurnMode,
) {
	await page.setViewportSize({ width: 1440, height: 900 });
	await login(page);
	const previousModelPreference = await snapshotUserModelPreference(page);
	const provider = await createTemporaryFakeProviderModel(
		page,
		fakeProviderBaseURL,
	);
	await updateUserModelPreference(page, provider.selectedModel);
	const conversationId = await createEmptyConversation(page);
	await page.goto(`/chat/${conversationId}`, { waitUntil: "networkidle" });
	await sendMessage(page, itemTurnMessage(mode));
	await expect(page.getByText(AI_SMOKE_ITEM_TURN_FINAL_TEXT)).toBeVisible({
		timeout: 60_000,
	});
	await expect(page.getByTestId("stop-button")).toHaveCount(0, {
		timeout: 30_000,
	});
	return {
		conversationId,
		deliverables: page.getByTestId("message-deliverables"),
		reply: page.getByTestId("assistant-message"),
		async restore() {
			await updateUserModelPreference(page, previousModelPreference);
			await deleteTemporaryProvider(page, provider.providerId);
		},
	};
}
