import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { db } from "../../src/lib/server/db";
import { artifacts, artifactVersions } from "../../src/lib/server/db/schema";
import type { CanvasBody } from "../../src/lib/shared/artifacts/canvas";
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


// ---- F11 ---------------------------------------------------------------------

/** The audit's own: the way from the airport to the hotel, five boxes across. */
const AIRPORT = [
	"flowchart LR",
	"  A[Bécs-Schwechat reptér] --> B[S-Bahn S7 vagy CAT]",
	"  B --> C[Wien Mitte]",
	"  C --> D[Metró vagy villamos]",
	"  D --> E[Szálloda a belvárosban]",
].join("\n");

function flowBoard(): CanvasBody {
	return {
		version: 1,
		nodes: [
			{
				id: "flow",
				type: "mermaid",
				position: { x: 40, y: 40 },
				width: 480,
				data: { kind: "mermaid", label: "Reptér → szálloda", code: AIRPORT },
			},
		],
		edges: [],
		// A camera of its own, so the board is not fitted: 100% is what the reader gets.
		viewport: { x: 16, y: 16, zoom: 1 },
		annotations: [],
	};
}

test.describe("F11: a wide flowchart is drawn where it can be read", () => {
	test.use({ viewport: { width: 1440, height: 900 } });

	test("the audit's five-box flowchart is read at its own size at 100%, and its block never shows the raw source first", async ({
		page,
	}) => {
		// Every moment the source of a diagram is in the block, seen from the first frame on.
		await page.addInitScript(() => {
			const w = window as unknown as { __rawSourceSeen: boolean };
			w.__rawSourceSeen = false;
			const look = () => {
				if (
					document.querySelector(
						'[data-testid="canvas-mermaid"] .markdown-diagram-source, [data-testid="canvas-mermaid"] .markdown-mermaid-placeholder',
					)
				) {
					w.__rawSourceSeen = true;
				}
			};
			new MutationObserver(look).observe(document, {
				childList: true,
				subtree: true,
			});
		});
		await login(page);
		const conversationId = await createEmptyConversation(page, "Flowchart");
		await seedCanvas(conversationId, flowBoard(), "Flow board");
		await openChatAndReload(page, conversationId);
		await openCanvasPanel(page);

		const svg = page
			.getByTestId("canvas-mermaid")
			.locator(".markdown-mermaid svg");
		await expect(svg).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId("canvas-zoom-level")).toHaveText("100%");

		// What the picture is drawn at, against its own size: a third made the words 5 px.
		const drawn = await svg.evaluate((element) => {
			const box = element.getBoundingClientRect();
			const own = (element as unknown as SVGSVGElement).viewBox.baseVal;
			// The smallest line of words in the picture, as it stands on the screen.
			const heights = Array.from(element.querySelectorAll("text"))
				.filter((text) => (text.textContent ?? "").trim() !== "")
				.map((text) => text.getBoundingClientRect().height);
			return {
				scale: box.width / own.width,
				labelHeight: heights.length > 0 ? Math.min(...heights) : 0,
			};
		});
		expect(drawn.scale).toBeGreaterThan(0.7);
		expect(drawn.labelHeight).toBeGreaterThan(14);

		expect(
			await page.evaluate(
				() => (window as unknown as { __rawSourceSeen: boolean }).__rawSourceSeen,
			),
			"the block showed the raw Mermaid source before the drawing",
		).toBe(false);
		if (SHOTS) {
			await page.screenshot({ path: shot("f11-wide-flowchart-1440.png") });
		}
	});
});
