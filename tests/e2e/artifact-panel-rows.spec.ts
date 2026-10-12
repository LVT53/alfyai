import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import {
	artifacts,
	artifactVersions,
	fileProductionJobFiles,
	fileProductionJobs,
	messages,
} from "../../src/lib/server/db/schema";
import { storeGeneratedFile } from "../../src/lib/server/services/chat-files";
import {
	createTourUser,
	markToursSeen,
	openPanelList,
	panelList,
	panelShell,
	reopenChat,
	seedItem,
	startChatAs,
	type TourUser,
} from "./artifact-tours-helpers";

/**
 * The panel's rows and headers (FB-5, ruling 77: F21, F9, F29, F28).
 *
 * F21: a File opened from a chat card used to get the panel's older header
 * ("ACTIVE DOCUMENT", a title with an arrow, an "AI" chip, an icon-only back) while
 * the same file opened from the list got the standard one (a way back, the title,
 * the kind). F9: three things with one name could not be told apart in the list
 * (two identical Apps, two identical DOCX files, a board and its PNG): a file row
 * now says its extension and size, and a row whose name another row shares says
 * when it was made. Real input throughout.
 */

type SeededFile = { chatFileId: string; artifactId: string };

/**
 * One produced file the way the pipeline leaves it: the stored bytes, the chat file,
 * the artifact the panel lists it by, the succeeded job and the reply the job hangs
 * from (so the chat shows its card).
 */
async function seedFileCard(
	user: TourUser,
	chatId: string,
	file: {
		filename: string;
		mimeType: string;
		content: string;
		sequence: number;
		madeAt?: Date;
	},
): Promise<SeededFile> {
	const madeAt = file.madeAt ?? new Date();
	const assistantMessageId = randomUUID();
	await db.insert(messages).values({
		id: assistantMessageId,
		conversationId: chatId,
		role: "assistant",
		content: `Here is ${file.filename}.`,
		messageSequence: file.sequence,
		createdAt: madeAt,
	});
	const stored = await storeGeneratedFile(chatId, user.id, {
		filename: file.filename,
		mimeType: file.mimeType,
		content: Buffer.from(file.content, "utf8"),
		assistantMessageId,
	});
	const artifactId = randomUUID();
	await db.insert(artifacts).values({
		id: artifactId,
		userId: user.id,
		conversationId: chatId,
		type: "generated_output",
		retrievalClass: "durable",
		name: file.filename,
		mimeType: file.mimeType,
		contentText: `Generated file: ${file.filename}`,
		metadataJson: JSON.stringify({
			generatedFile: true,
			originalChatFileId: stored.id,
			generatedFilename: file.filename,
			documentLabel: file.filename,
			versionNumber: 1,
		}),
		createdAt: madeAt,
		updatedAt: madeAt,
	});
	const jobId = randomUUID();
	await db.insert(fileProductionJobs).values({
		id: jobId,
		conversationId: chatId,
		assistantMessageId,
		userId: user.id,
		title: file.filename,
		status: "succeeded",
		origin: "unified_produce",
		sourceMode: "inline_text",
		createdAt: madeAt,
		updatedAt: madeAt,
		completedAt: madeAt,
	});
	await db.insert(fileProductionJobFiles).values({
		id: randomUUID(),
		jobId,
		chatGeneratedFileId: stored.id,
		sortOrder: 0,
		createdAt: madeAt,
	});
	return { chatFileId: stored.id, artifactId };
}

async function readerWithFile(
	page: Page,
	language: "en" | "hu" = "en",
): Promise<{ user: TourUser; chatId: string }> {
	const user = await createTourUser(language);
	await markToursSeen(user);
	const chatId = await startChatAs(page, user);
	await seedFileCard(user, chatId, {
		filename: "trip-notes.md",
		mimeType: "text/markdown",
		content: "# Trip notes\n\nSaturday: the market.\n",
		sequence: 900,
	});
	await reopenChat(page, chatId);
	return { user, chatId };
}

/** The header the panel draws for the open item: its parts, as a reader sees them. */
async function headerParts(page: Page): Promise<{
	crumb: boolean;
	title: string;
	kind: string;
	legacyEyebrow: boolean;
}> {
	const shell = panelShell(page);
	const header = shell.locator(".artifact-panel-header:visible").first();
	return {
		crumb: await shell
			.locator(".artifact-panel-header-crumb:visible")
			.first()
			.isVisible()
			.catch(() => false),
		title:
			(await header
				.locator('[data-testid="artifact-panel-title"]')
				.textContent()
				.catch(() => null)) ?? "",
		kind:
			(
				await header
					.locator(".artifact-panel-header-kind")
					.textContent()
					.catch(() => null)
			)?.trim() ?? "",
		legacyEyebrow: await shell
			.locator(".workspace-eyebrow:visible")
			.first()
			.isVisible()
			.catch(() => false),
	};
}

function fileCardButton(page: Page, filename: string): Locator {
	return page
		.getByTestId("file-production-card")
		.getByRole("button", { name: `Preview ${filename}` });
}

test.describe("a File has one header wherever it is opened from (F21)", () => {
	test.use({ viewport: { width: 1440, height: 900 } });

	test("the chat card and the list open the same header: a way back, the title, the kind", async ({
		page,
	}) => {
		await readerWithFile(page);

		// From the chat card's Preview.
		await fileCardButton(page, "trip-notes.md").click({ timeout: 30_000 });
		await expect(
			page.locator('[data-testid="artifact-panel-title"]:visible'),
		).toHaveText("trip-notes.md", { timeout: 30_000 });
		const fromCard = await headerParts(page);

		// From the list: the header's way back, then the row.
		await panelShell(page)
			.locator(".artifact-panel-header-crumb:visible")
			.first()
			.click();
		await expect(panelList(page)).toBeVisible({ timeout: 15_000 });
		await panelList(page)
			.getByTestId("artifact-row")
			.filter({ hasText: "trip-notes.md" })
			.click();
		await expect(
			page.locator('[data-testid="artifact-panel-title"]:visible'),
		).toHaveText("trip-notes.md", { timeout: 30_000 });
		const fromList = await headerParts(page);

		expect(
			fromCard.legacyEyebrow,
			"the card's open has no older 'Active document' header",
		).toBe(false);
		expect(fromCard.crumb, "the card's open has a way back to the list").toBe(
			true,
		);
		expect(fromCard.kind).toBe("File");
		expect(fromCard, "both ways in show the same header").toEqual(fromList);
	});
});

/** The artifact's latest moment, set to `madeAt` on the row and on its version (the list reads one or the other). */
async function madeAt(artifactId: string, at: Date): Promise<void> {
	await db
		.update(artifacts)
		.set({ createdAt: at, updatedAt: at })
		.where(eq(artifacts.id, artifactId));
	await db
		.update(artifactVersions)
		.set({ createdAt: at })
		.where(eq(artifactVersions.artifactId, artifactId));
}

/** What one row of the list says, as a reader reads it: its visible text, one line. */
async function rowText(row: Locator): Promise<string> {
	return ((await row.innerText()) ?? "").replace(/\s+/g, " ").trim();
}

test.describe("rows with one name can be told apart (F9)", () => {
	test.use({ viewport: { width: 1440, height: 900 } });

	test("a file row says its extension and size; a name that is its own says no time", async ({
		page,
	}) => {
		const user = await createTourUser("en");
		await markToursSeen(user);
		const chatId = await startChatAs(page, user);
		await seedFileCard(user, chatId, {
			filename: "trip-notes.md",
			mimeType: "text/markdown",
			content: "# Trip notes\n\nSaturday: the market.\n",
			sequence: 900,
		});
		await seedItem(user, chatId, "document");
		await reopenChat(page, chatId);
		await openPanelList(page);

		const file = await rowText(
			panelList(page)
				.getByTestId("artifact-row")
				.filter({ hasText: "trip-notes.md" }),
		);
		expect(file, "the kind, the extension and the size").toContain(
			"File · MD · 36 B",
		);
		const document = await rowText(
			panelList(page)
				.getByTestId("artifact-row")
				.filter({ hasText: "Trip notes" })
				.filter({ hasNotText: "trip-notes.md" }),
		);
		expect(document, "a name nobody shares says no clock time").not.toMatch(
			/\d{2}:\d{2}/,
		);
	});

	test("two Apps with one name and two files with one name each say when they were made", async ({
		page,
	}) => {
		const user = await createTourUser("en");
		await markToursSeen(user);
		const chatId = await startChatAs(page, user);
		const earlier = new Date(Date.now() - 20 * 60_000);
		const later = new Date(Date.now() - 2 * 60_000);
		const appA = await seedItem(user, chatId, "app", {
			title: "Tip calculator",
		});
		const appB = await seedItem(user, chatId, "app", {
			title: "Tip calculator",
		});
		await madeAt(appA, earlier);
		await madeAt(appB, later);
		const fileA = await seedFileCard(user, chatId, {
			filename: "itinerary.md",
			mimeType: "text/markdown",
			content: "# Itinerary\n",
			sequence: 901,
			madeAt: earlier,
		});
		const fileB = await seedFileCard(user, chatId, {
			filename: "itinerary.md",
			mimeType: "text/markdown",
			content: "# Itinerary\n\nWith the Sunday plan added.\n",
			sequence: 902,
			madeAt: later,
		});
		expect(fileA.artifactId).not.toBe(fileB.artifactId);
		await reopenChat(page, chatId);
		await openPanelList(page);

		const apps = panelList(page)
			.getByTestId("artifact-row")
			.filter({ hasText: "Tip calculator" });
		await expect(apps).toHaveCount(2);
		const appRows = [await rowText(apps.nth(0)), await rowText(apps.nth(1))];
		for (const text of appRows) {
			expect(text, "an App row of a shared name says when").toMatch(
				/App · \d{2}:\d{2}|App · \d{1,2} \w+, \d{2}:\d{2}/,
			);
		}
		expect(new Set(appRows).size, "the two App rows do not read the same").toBe(
			2,
		);

		const files = panelList(page)
			.getByTestId("artifact-row")
			.filter({ hasText: "itinerary.md" });
		await expect(files).toHaveCount(2);
		const fileRows = [await rowText(files.nth(0)), await rowText(files.nth(1))];
		for (const text of fileRows) {
			expect(text, "a file row says its extension, its size and when").toMatch(
				/File · MD · \d+ B · (\d{2}:\d{2}|\d{1,2} \w+, \d{2}:\d{2})/,
			);
		}
		expect(
			new Set(fileRows).size,
			"the two file rows do not read the same",
		).toBe(2);
	});
});
