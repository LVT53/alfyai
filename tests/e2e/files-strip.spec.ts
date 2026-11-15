import { expect, type Locator, test } from "@playwright/test";
import { db } from "../../src/lib/server/db";
import { messages } from "../../src/lib/server/db/schema";
import { createEmptyConversation, login } from "./helpers";

// The compact files strip (FilesStrip.svelte) in a real browser: one `files`
// call's cards under the reply as pictures, a count tile and a list, and the
// app's one viewer a picture opens.
//
// There is no fake Nextcloud in the harness, so the call reaches the strip the
// way a reload leaves any saved reply: as a stored message. The spec seeds the
// conversation's two rows through the app's own `db` singleton (the same seam
// `artifact-card-arrival.spec.ts` uses for earlier turns), one assistant row
// whose `tool_calls` JSON is the `files` segment — the shape the server writes
// for a live turn and reads back in `readThinkingSegmentsFromRow`
// (messages.ts). Nothing is stubbed in the browser: the strip, its lazy viewer
// and the conversation detail are the real ones.
//
// 1×1 PNG, so the four pictures load without a request to a Nextcloud that is
// not there. A real installation stores the app's preview route instead; the
// strip only ever reads the address it is given.
const ONE_PIXEL_PNG =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** A Hungarian document name no tile or row can hold, so it must ellipsise. */
const LONG_HUNGARIAN_NAME =
	"Megbeszélés-jegyzőkönyv-2025-június-veszprémi-irodafelújítás-árajánlatok-összesítése-végleges-változat-2.pdf";

function pictureCard(name: string, fileId: number) {
	return {
		name,
		path: `/Photos/${name}`,
		size: 2_400_000,
		mtime: "2026-06-13T10:00:00.000Z",
		contentType: "image/png",
		previewUrl: ONE_PIXEL_PNG,
		viewUrl: ONE_PIXEL_PNG,
		webUrl: `https://cloud.example.com/apps/files/?fileid=${fileId}`,
	};
}

function documentCard(name: string, fileId: number) {
	return {
		name,
		path: `/Documents/${name}`,
		size: 24_576,
		mtime: "2025-11-04T09:00:00.000Z",
		contentType: name.endsWith(".pdf")
			? "application/pdf"
			: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		previewUrl: null,
		viewUrl: null,
		webUrl: `https://cloud.example.com/apps/files/?fileid=${fileId}`,
	};
}

/** Six cards: four pictures the strip can draw, two documents only the list has. */
const CARDS = [
	pictureCard("IMG_2043.png", 1),
	pictureCard("IMG_2044.png", 2),
	pictureCard("IMG_2045.png", 3),
	pictureCard("IMG_2046.png", 4),
	documentCard(LONG_HUNGARIAN_NAME, 5),
	documentCard("Contract draft.docx", 6),
];

/**
 * One user message and one assistant reply whose thinking segment is the
 * `files` call, in the exact shape `messages.ts` writes and parses. The
 * conversation was made through the API, so it is the signed-in person's.
 */
async function seedFilesReply(conversationId: string) {
	const now = new Date();
	await db.insert(messages).values([
		{
			id: `${conversationId}-q`,
			conversationId,
			messageSequence: 1,
			role: "user",
			content: "Melyek a negyedéves jelentések?",
			createdAt: now,
		},
		{
			id: `${conversationId}-a`,
			conversationId,
			messageSequence: 2,
			role: "assistant",
			content: "Megtaláltam őket, itt vannak a fájlok.",
			toolCalls: JSON.stringify([
				{
					type: "tool_call",
					callId: "call-files",
					name: "files",
					input: { action: "search", query: "Q3 report" },
					status: "done",
					files: { connectionId: "conn-1", cards: CARDS, total: 8 },
				},
			]),
			createdAt: now,
		},
	]);
}

/** The reply's overflow, as the browser lays it out. */
async function replyOverflow(message: Locator) {
	return message.evaluate((element: HTMLElement) => ({
		scrollWidth: element.scrollWidth,
		clientWidth: element.clientWidth,
	}));
}

test.describe("the files strip", () => {
	test("draws a files call as pictures, a count tile and a list, and opens the viewer", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		await login(page);
		const conversationId = await createEmptyConversation(page);
		await seedFilesReply(conversationId);
		await page.goto(`/chat/${conversationId}`, { waitUntil: "networkidle" });

		const message = page.getByTestId("assistant-message");
		await expect(message).toBeVisible({ timeout: 15_000 });
		const strip = message.getByTestId("files-strip");
		await expect(strip).toBeVisible();

		// The old file-card row is gone: the call is the strip, not a row with a
		// card panel under it.
		await expect(
			message.locator(
				'[data-testid="tool-activity-row"][data-icon-type="files"]',
			),
		).toHaveCount(0);
		await expect(message.locator("a.act-file")).toHaveCount(0);

		// Wide: four pictures fill the four slots, and there is no count tile to
		// say anything is left out.
		await expect(strip.getByTestId("files-strip-tile")).toHaveCount(4);
		await expect(strip.getByTestId("files-strip-count")).toHaveCount(0);
		await expect(strip.locator(".fs-tile")).toHaveCount(4);

		// The reply column does not scroll sideways at either width.
		let overflow = await replyOverflow(message);
		expect(
			overflow.scrollWidth,
			`wide reply scrollWidth ${overflow.scrollWidth} vs clientWidth ${overflow.clientWidth}`,
		).toBeLessThanOrEqual(overflow.clientWidth + 1);

		// Narrow (360px): three tiles, the third the count tile for the two
		// pictures the strip leaves out.
		await page.setViewportSize({ width: 360, height: 780 });
		await expect(strip.getByTestId("files-strip-tile")).toHaveCount(2);
		await expect(strip.locator(".fs-tile")).toHaveCount(3);
		const countTile = strip.getByTestId("files-strip-count");
		await expect(countTile).toHaveCount(1);
		await expect(countTile).toContainText("+2");
		overflow = await replyOverflow(message);
		expect(
			overflow.scrollWidth,
			`narrow reply scrollWidth ${overflow.scrollWidth} vs clientWidth ${overflow.clientWidth}`,
		).toBeLessThanOrEqual(overflow.clientWidth + 1);

		// The count tile opens the list. A long Hungarian name is cut with an
		// ellipsis in it, and its whole name stays reachable on the title.
		const list = strip.getByTestId("files-strip-list");
		await expect(list).toHaveCount(0);
		await countTile.click();
		await expect(list).toBeVisible();
		const longName = list
			.getByTestId("files-strip-name")
			.filter({ hasText: LONG_HUNGARIAN_NAME });
		await expect(longName).toHaveCount(1);
		await expect(longName).toHaveAttribute("title", LONG_HUNGARIAN_NAME);
		const nameWidths = await longName.evaluate((element: HTMLElement) => ({
			scrollWidth: element.scrollWidth,
			clientWidth: element.clientWidth,
		}));
		expect(nameWidths.clientWidth).toBeGreaterThan(0);
		expect(
			nameWidths.scrollWidth,
			`the long name is cut: scrollWidth ${nameWidths.scrollWidth} vs clientWidth ${nameWidths.clientWidth}`,
		).toBeGreaterThan(nameWidths.clientWidth);

		// The chevron closes the list a second press opens again, and the next
		// press closes it: it is a toggle, and the count tile opens the same list.
		const chevron = strip.getByTestId("files-strip-chevron");
		await expect(chevron).toHaveAttribute("aria-expanded", "true");
		await chevron.click();
		await expect(list).toHaveCount(0);
		await expect(chevron).toHaveAttribute("aria-expanded", "false");
		await chevron.click();
		await expect(list).toBeVisible();
		await chevron.click();
		await expect(list).toHaveCount(0);

		// A picture opens the app's viewer; Escape closes it and the focus comes
		// back to the tile that opened it.
		const tile = strip.getByTestId("files-strip-tile").first();
		await tile.click();
		await expect(page.getByTestId("image-lightbox")).toBeVisible({
			timeout: 15_000,
		});
		await expect(page.getByTestId("image-lightbox-image")).toBeVisible();
		// The modal took the focus; Escape gives it back to the tile.
		await expect(page.getByTestId("image-lightbox")).toBeFocused();
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("image-lightbox")).toHaveCount(0);
		await expect(tile).toBeFocused();
	});
});
