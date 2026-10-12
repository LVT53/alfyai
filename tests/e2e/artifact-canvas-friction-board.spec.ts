import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { db } from "../../src/lib/server/db";
import { artifacts, artifactVersions } from "../../src/lib/server/db/schema";
import { emptyCanvasBody } from "../../src/lib/shared/artifacts/canvas-body";
import {
	openCanvasPanel,
	openChatAndReload,
	seedCanvas,
	testUserId,
} from "./artifact-canvas-helpers";
import { createEmptyConversation, login } from "./helpers";

// The board's friction (phase 5, FB-4, ruling 77): what the audit found walking a
// board like the owner, built on real input. One spec for the whole round, each
// finding in its own describe, so the red run of a finding is its own.

const SHOTS = process.env.FB4_SHOTS ?? null;

function shot(name: string): string {
	if (!SHOTS) throw new Error("no screenshot folder");
	mkdirSync(SHOTS, { recursive: true });
	return join(SHOTS, name);
}

const insertButton = (page: Page) => page.getByTestId("canvas-insert-button");
const insertMenu = (page: Page) => page.getByTestId("canvas-insert-menu-list");

/** An App row in the chat, written straight to the database the way the other Canvas specs do. */
async function seedApp(
	conversationId: string,
	title: string,
	madeMinutesAgo: number,
): Promise<string> {
	const userId = await testUserId();
	const artifactId = randomUUID();
	const at = new Date(Date.now() - madeMinutesAgo * 60_000);
	const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1></body></html>`;
	await db.insert(artifacts).values({
		id: artifactId,
		userId,
		conversationId,
		type: "artifact",
		retrievalClass: "durable",
		name: title,
		contentText: html,
		metadataJson: JSON.stringify({ artifactType: "app", title }),
		createdAt: at,
		updatedAt: at,
	});
	await db.insert(artifactVersions).values({
		id: randomUUID(),
		artifactId,
		userId,
		versionNumber: 1,
		author: "alfy",
		summary: "Alfy wrote the first draft",
		body: html,
		bodyHash: "seed-hash",
		createdAt: at,
	});
	return artifactId;
}

test.describe("F9: rows of one name are told apart in the Insert menu", () => {
	test("two Apps called alike say when each was made, and a name of its own says nothing more", async ({
		page,
	}) => {
		await login(page);
		const conversationId = await createEmptyConversation(page, "Same names");
		await seedApp(conversationId, "Tip calculator", 25);
		await seedApp(conversationId, "Tip calculator", 2);
		await seedApp(conversationId, "Habit tracker", 5);
		await seedCanvas(conversationId, emptyCanvasBody(), "Board");
		await openChatAndReload(page, conversationId);
		await page.getByTestId("artifact-count-button").click();
		await page
			.getByTestId("artifact-panel-list")
			.getByTestId("artifact-row")
			.filter({ hasText: /Canvas|Tábla/ })
			.click();
		await expect(page.getByTestId("canvas-board")).toBeVisible({
			timeout: 15_000,
		});

		await insertButton(page).click();
		await expect(insertMenu(page)).toBeVisible();
		const apps = insertMenu(page)
			.getByTestId("canvas-chat-item")
			.and(page.locator('[data-kind="app"]'));
		await expect(apps).toHaveCount(3);

		const rows = await apps.allInnerTexts();
		const tips = rows.filter((row) => row.includes("Tip calculator"));
		expect(tips).toHaveLength(2);
		// Two rows that read alike no longer do: each carries its own time, never a version.
		expect(new Set(tips).size).toBe(2);
		for (const row of tips) {
			expect(row).toMatch(/\d{1,2}:\d{2}/);
			expect(row).not.toMatch(/\bv\d|version|verzi/i);
		}
		// A row with a name of its own has nothing to add.
		const habit = rows.find((row) => row.includes("Habit tracker")) ?? "";
		expect(habit.trim()).toBe("Habit tracker");
		if (SHOTS) {
			await page.screenshot({ path: shot("f9-insert-menu-same-names.png") });
		}
	});
});

void openCanvasPanel;
