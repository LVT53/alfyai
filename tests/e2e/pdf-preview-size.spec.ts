import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import {
	chatGeneratedFiles,
	fileProductionJobs,
	messages,
} from "../../src/lib/server/db/schema";
import {
	cleanUpConversation,
	seedDocument,
	TITLE,
} from "./artifact-download-helpers";
import { login } from "./helpers";

/**
 * A PDF's preview takes the page's final size at once (friction audit F25).
 *
 * It painted a default-sized canvas box (316x166 with its padding) and jumped to the
 * page's real size (888x719, a layout shift of 0.38 on top of the panel's own) when
 * the first render began. The page's box is sampled on every frame from the moment it
 * is in the document, after a real click on the file card's Open: it has one size,
 * from its first frame.
 */

/** A real PDF, made by the export route, as the file of a reply's card: the job and the file hang from an assistant message of the chat. */
async function seedPdfCard(
	request: import("@playwright/test").APIRequestContext,
	conversationId: string,
	artifactId: string,
): Promise<void> {
	const exported = await request.post(`/api/artifacts/${artifactId}/export`, {
		data: { format: "pdf" },
	});
	expect(exported.status()).toBe(202);
	const { job } = (await exported.json()) as { job: { id: string } };
	await expect
		.poll(
			async () =>
				(
					(await (
						await request.get(`/api/chat/files/jobs/${job.id}`)
					).json()) as {
						job: { status: string };
					}
				).job.status,
			{ timeout: 30_000 },
		)
		.toBe("succeeded");

	const assistantMessageId = randomUUID();
	await db.insert(messages).values({
		id: assistantMessageId,
		conversationId,
		role: "assistant",
		content: "Here is the PDF.",
		messageSequence: 1,
		createdAt: new Date(),
	});
	// The export is the reader's own and hangs from no reply; for this spec it is
	// what a reply's produce_file made.
	await db
		.update(fileProductionJobs)
		.set({ assistantMessageId, origin: "unified_produce" })
		.where(eq(fileProductionJobs.conversationId, conversationId));
	await db
		.update(chatGeneratedFiles)
		.set({ assistantMessageId })
		.where(eq(chatGeneratedFiles.conversationId, conversationId));
}

test("a PDF's preview takes the page's final size at once, with no default-sized box that jumps", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const { conversationId, artifactId } = await seedDocument();
	try {
		await login(page);
		await seedPdfCard(page.request, conversationId, artifactId);
		await page.goto(`/chat/${conversationId}`, { waitUntil: "networkidle" });

		const open = page
			.getByTestId("file-production-card")
			.getByRole("button", { name: /^Preview .*\.pdf$/ });
		await expect(open).toBeEnabled({ timeout: 30_000 });

		// One sample per frame of the first page's box, kept when it changes.
		await page.evaluate(() => {
			const seen: string[] = [];
			(window as unknown as { __pdfBoxes: string[] }).__pdfBoxes = seen;
			const sample = () => {
				const canvas = document.querySelector(".pdf-canvas");
				if (canvas) {
					const box = canvas.getBoundingClientRect();
					const size = `${Math.round(box.width)}x${Math.round(box.height)}`;
					if (seen[seen.length - 1] !== size) seen.push(size);
				}
				requestAnimationFrame(sample);
			};
			sample();
		});
		await open.click();
		await expect(page.locator(".pdf-canvas").first()).toBeVisible({
			timeout: 30_000,
		});
		// Drawn: the rendering overlay is gone, and the panel has had its time to settle.
		await expect(page.locator(".pdf-rendering-overlay")).toHaveCount(0, {
			timeout: 30_000,
		});
		await page.waitForTimeout(600);

		const boxes = await page.evaluate(
			() => (window as unknown as { __pdfBoxes: string[] }).__pdfBoxes,
		);
		expect(boxes, `the page's box changed: ${boxes.join(" -> ")}`).toHaveLength(
			1,
		);
		// A page, not the canvas element's default 300x150.
		const [width, height] = boxes[0].split("x").map(Number);
		expect(width).toBeGreaterThan(300);
		expect(height).toBeGreaterThan(width);
		expect(TITLE.length).toBeGreaterThan(0);
	} finally {
		await cleanUpConversation(conversationId);
	}
});
