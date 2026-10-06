import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import {
	artifacts,
	chatGeneratedFiles,
	conversations,
	users,
} from "../../src/lib/server/db/schema";
import { createArtifact } from "../../src/lib/server/services/artifacts";
import { boardJson } from "../../src/lib/shared/artifacts/canvas-body";
import { sampleBoard } from "../../src/lib/shared/artifacts/canvas-fixtures.test-helpers";
import { login, TEST_EMAIL, waitForHydration } from "./helpers";

// FU-1 (RC-3 N2's other half): a board has two Deletes, the panel's and Knowledge ->
// Documents', and the second used to leave the board's poster files behind (chat
// files that hang from no reply, so nothing lists them) until the chat itself was
// deleted. The board is seeded the way the app makes one and its posters are sent
// through the app's own route (the browser's picture of a block); the Delete is the
// reader's own clicks in the library, and the posters are looked for where they
// live: the rows, the bytes on disk, and the route that serves them.

/** One whole 1x1 PNG, which is all the route asks of a poster. */
const PNG_DATA_URL =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function sendPoster(
	page: Page,
	boardId: string,
	nodeId: string,
): Promise<string> {
	const response = await page.request.post(
		`/api/artifacts/${boardId}/exports/png`,
		{ data: { source: "canvas-poster", nodeId, dataUrl: PNG_DATA_URL } },
	);
	expect(response.ok(), `a poster for ${nodeId}`).toBe(true);
	const body = (await response.json()) as { ok: boolean; fileId: string };
	expect(body.ok).toBe(true);
	return body.fileId;
}

function fileRow(fileId: string) {
	return db
		.select({
			id: chatGeneratedFiles.id,
			storagePath: chatGeneratedFiles.storagePath,
		})
		.from(chatGeneratedFiles)
		.where(eq(chatGeneratedFiles.id, fileId))
		.get();
}

function bytesOnDisk(storagePath: string): boolean {
	return existsSync(join(process.cwd(), "data", "chat-files", storagePath));
}

test.describe("Knowledge -> Documents: deleting a board", () => {
	test("takes the board's poster files with it, and no other board's", async ({
		page,
	}) => {
		await login(page);
		const [user] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.email, TEST_EMAIL));
		const stamp = Date.now();
		const conversationId = `e2e-poster-delete-${stamp}`;
		const now = new Date();
		await db.insert(conversations).values({
			id: conversationId,
			userId: user.id,
			title: "Seeded for the poster delete e2e case",
			createdAt: now,
			updatedAt: now,
		});
		const makeBoard = async (title: string) => {
			const created = await createArtifact({
				userId: user.id,
				conversationId,
				kind: "canvas",
				title,
				body: boardJson(sampleBoard()),
				author: "user",
				versionSummary: "Created",
			});
			if (!created.ok) throw new Error(created.reason);
			return created.artifact.id;
		};
		const doomedTitle = `Doomed board ${stamp}`;
		const doomedId = await makeBoard(doomedTitle);
		const keptId = await makeBoard(`Kept board ${stamp}`);

		try {
			const doomedFiles = [
				await sendPoster(page, doomedId, "app-1"),
				await sendPoster(page, doomedId, "photo-1"),
			];
			const keptFile = await sendPoster(page, keptId, "app-1");
			for (const id of [...doomedFiles, keptFile]) {
				const row = fileRow(id);
				expect(row, "the poster row").toBeTruthy();
				expect(bytesOnDisk(row?.storagePath ?? ""), "the poster bytes").toBe(
					true,
				);
			}
			const doomedPaths = doomedFiles.map(
				(id) => fileRow(id)?.storagePath ?? "",
			);

			// The reader's own clicks: the library row's Delete, then the confirmation.
			await page.goto("/knowledge", { waitUntil: "domcontentloaded" });
			await waitForHydration(page);
			await page.getByRole("tab", { name: "Documents" }).click();
			const row = page.locator("tbody tr", { hasText: doomedTitle });
			await expect(row).toBeVisible();
			await row.getByRole("button", { name: /delete/i }).click();
			await page.getByTestId("confirm-delete").click();
			await expect(row).toHaveCount(0);

			// The board is gone, and so are its posters: rows, bytes, and what serves them.
			expect(
				db.select().from(artifacts).where(eq(artifacts.id, doomedId)).get(),
			).toBeUndefined();
			for (const [index, id] of doomedFiles.entries()) {
				expect(fileRow(id), "the poster row").toBeUndefined();
				expect(bytesOnDisk(doomedPaths[index]), "the poster bytes").toBe(false);
				const served = await page.request.get(`/api/chat/files/${id}/preview`);
				expect(served.status()).toBe(404);
			}

			// The other board is whole, and keeps its poster.
			expect(
				db.select().from(artifacts).where(eq(artifacts.id, keptId)).get(),
			).toBeTruthy();
			const kept = fileRow(keptFile);
			expect(kept, "the other board's poster row").toBeTruthy();
			expect(bytesOnDisk(kept?.storagePath ?? "")).toBe(true);
			const keptServed = await page.request.get(
				`/api/chat/files/${keptFile}/preview`,
			);
			expect(keptServed.ok()).toBe(true);
		} finally {
			await db
				.delete(artifacts)
				.where(inArray(artifacts.id, [doomedId, keptId]));
			await db
				.delete(chatGeneratedFiles)
				.where(eq(chatGeneratedFiles.conversationId, conversationId));
			await db
				.delete(conversations)
				.where(eq(conversations.id, conversationId));
			rmSync(join(process.cwd(), "data", "chat-files", conversationId), {
				recursive: true,
				force: true,
			});
		}
	});
});
