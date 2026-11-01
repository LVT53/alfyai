// The connector permission card in the real app: what it says, and what happens
// to it once it is answered. A pending write is created by a write tool mid-turn,
// so there is no way to make one from the browser; the rows are seeded and the
// answers go through the real routes. The strings the server writes and the card
// projection are the real ones (write-card.ts reads the row).
import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import {
	connectionPendingWrites,
	messages,
	users,
} from "../../src/lib/server/db/schema";
import {
	createEmptyConversation,
	login,
	waitForHydration,
	waitForMotionToSettle,
	waitForStableBoundingBox,
} from "./helpers";

type SeededWrite = {
	op: Record<string, unknown>;
	content: string;
	provider: string;
	warnings?: string[];
};

const EVENT: SeededWrite = {
	provider: "google",
	op: {
		action: "calendar.create_event",
		destructive: false,
		reversible: true,
		target: { label: "Dentist" },
	},
	content: JSON.stringify({
		calendarId: "primary",
		event: {
			summary: "Dentist",
			start: "2026-11-03T09:00:00",
			end: "2026-11-03T09:30:00",
			location: "Kossuth tér 1",
		},
	}),
};

const EMAIL: SeededWrite = {
	provider: "imap",
	op: {
		action: "email.send",
		destructive: false,
		reversible: false,
		target: { label: "Q3 numbers → anna@example.com" },
	},
	content: JSON.stringify({
		to: "anna@example.com",
		subject: "Q3 numbers",
		body: "Hi Anna, the numbers are in.",
	}),
};

const REPLACE: SeededWrite = {
	provider: "nextcloud",
	op: {
		action: "files.put",
		destructive: true,
		reversible: false,
		target: {
			path: "/AlfyAI/Reports/atlas-report.pdf",
			withinAllowlist: true,
		},
	},
	content: "The new report.",
	warnings: [
		"This will overwrite/delete and may not be recoverable",
		"Nextcloud version history is off on this server, so this overwrite cannot be recovered.",
	],
};

async function adminId(): Promise<string> {
	const [admin] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, "admin@local"))
		.limit(1);
	return admin.id;
}

/** A reply in a new chat that proposed these writes, oldest first. */
async function seedReply(page: Page, writes: SeededWrite[]): Promise<string> {
	const conversationId = await createEmptyConversation(page, "Errands");
	const userId = await adminId();
	const now = new Date();
	const assistantId = randomUUID();
	await db.insert(messages).values([
		{
			id: randomUUID(),
			conversationId,
			messageSequence: 1,
			role: "user",
			content: "Sort these out for me.",
			createdAt: now,
		},
		{
			id: assistantId,
			conversationId,
			messageSequence: 2,
			role: "assistant",
			content: "These need your OK first.",
			createdAt: now,
		},
	]);
	for (const write of writes) {
		await db.insert(connectionPendingWrites).values({
			id: randomUUID(),
			userId,
			connectionId: `conn-${write.provider}`,
			provider: write.provider,
			opJson: JSON.stringify({ op: write.op, content: write.content }),
			idempotencyKey: randomUUID(),
			status: "pending",
			previewJson: JSON.stringify({
				title: "Proposed in English",
				detail: "internal.action — target",
				reversible: write.op.reversible,
				destructive: write.op.destructive,
				withinAllowlist: null,
				warnings: write.warnings ?? [],
			}),
			conversationId,
			assistantMessageId: assistantId,
		});
	}
	return conversationId;
}

test.describe("the permission card in a reply", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("names the file large, keeps its location small and never shows the whole path", async ({
		page,
	}) => {
		const id = await seedReply(page, [REPLACE]);
		await page.goto(`/chat/${id}`);

		const card = page.getByRole("article", {
			name: "Needs your OK: atlas-report.pdf",
		});
		await expect(card).toBeVisible();
		await expect(
			card.getByRole("heading", { name: "Replace this file?" }),
		).toBeVisible();

		const name = card.getByText("atlas-report.pdf", { exact: true });
		const location = card.getByText("/AlfyAI/Reports", { exact: true });
		await expect(name).toBeVisible();
		await expect(location).toBeVisible();
		const fontSize = (locator: typeof name) =>
			locator.evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
		expect(await fontSize(name)).toBeGreaterThan(
			(await fontSize(location)) * 1.4,
		);

		await expect(card).not.toContainText("/AlfyAI/Reports/atlas-report.pdf");
		await expect(card).not.toContainText("files.put");
		await expect(card).not.toContainText("Proposed in English");
		await expect(card).not.toContainText("The new report.");
		await expect(card).not.toContainText(/confirmation ref/i);

		// One warning, as one plain line: no pills, no second box.
		const warning = card.getByRole("status");
		await expect(warning).toHaveCount(1);
		await expect(warning).toHaveText("The current file will be gone for good.");
		const ground = await warning.evaluate(
			(node) => getComputedStyle(node).backgroundColor,
		);
		expect(ground).toBe("rgba(0, 0, 0, 0)");
	});

	test("lists a reply's writes in the order they were proposed", async ({
		page,
	}) => {
		const id = await seedReply(page, [EVENT, EMAIL, REPLACE]);
		await page.goto(`/chat/${id}`);

		await expect(page.getByRole("article")).toHaveCount(3);
		await expect(page.getByRole("article").first()).toContainText("Dentist");
		await expect(page.getByRole("article").last()).toContainText(
			"atlas-report.pdf",
		);
	});

	test("folds into an activity row once it is answered, and stays that way after a reload", async ({
		page,
	}) => {
		const id = await seedReply(page, [EMAIL]);
		await page.goto(`/chat/${id}`);
		await waitForHydration(page);

		// The page's notices can still push the reply down as they arrive.
		const decline = page.getByRole("button", { name: "Cancel: Q3 numbers" });
		await waitForStableBoundingBox(decline);
		await decline.click();

		const settled = page.getByTestId("write-confirm-settled");
		await expect(settled).toHaveAttribute("data-status", "cancelled");
		await expect(settled).toContainText("Cancelled");
		await expect(page.getByRole("article")).toHaveCount(0);

		await page.reload();
		await expect(page.getByTestId("write-confirm-settled")).toContainText(
			"Q3 numbers",
		);
		await expect(page.getByTestId("write-confirm-approve")).toHaveCount(0);
	});
});

test.describe("the permission sheet on a phone", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("raises one sheet for a reply's three writes and walks through them", async ({
		page,
	}) => {
		const id = await seedReply(page, [EVENT, EMAIL, REPLACE]);
		await page.goto(`/chat/${id}`);

		const sheet = page.getByTestId("write-confirm-sheet");
		await expect(sheet).toHaveCount(1);
		await expect(page.getByRole("dialog")).toHaveCount(1);
		await expect(sheet).toContainText("Dentist");
		await expect(sheet).toContainText("2 more waiting");

		const decline = page
			.getByRole("dialog")
			.getByTestId("write-confirm-decline");
		await decline.click();
		await expect(sheet).toContainText("Q3 numbers");
		await expect(sheet).toContainText("1 more waiting");

		await decline.click();
		await expect(sheet).toContainText("atlas-report.pdf");
		await expect(sheet).not.toContainText("more waiting");

		await decline.click();
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await expect(page.getByTestId("write-confirm-settled")).toHaveCount(3);
	});

	test("backing out decides nothing: the questions wait in the reply", async ({
		page,
	}) => {
		const id = await seedReply(page, [EVENT, EMAIL]);
		await page.goto(`/chat/${id}`);
		await expect(page.getByTestId("write-confirm-sheet")).toBeVisible();

		await page.getByTestId("dialog-sheet-grabber").click();
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await waitForMotionToSettle(page);

		await expect(page.getByRole("article")).toHaveCount(2);
		await expect(page.getByTestId("write-confirm-settled")).toHaveCount(0);
	});
});
