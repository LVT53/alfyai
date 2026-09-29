import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import {
	artifacts,
	artifactVersions,
	users,
} from "../../src/lib/server/db/schema";
import type { CanvasBody } from "../../src/lib/shared/artifacts/canvas";
import { boardJson } from "../../src/lib/shared/artifacts/canvas-body";
import { waitForStableBoundingBox } from "./helpers";

// What every Canvas e2e spec needs: a board seeded straight into the database
// (the convention artifacts-panel.spec.ts and artifact-app.spec.ts established,
// since `create_artifact` has no scriptable tool-call fixture), the panel opened
// on it, and a look at what was actually saved.

async function testUserId(): Promise<string> {
	const [user] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, "admin@local"))
		.limit(1);
	expect(user, "the e2e admin must exist").toBeTruthy();
	return user.id;
}

export async function seedCanvas(
	conversationId: string,
	body: CanvasBody,
	title = "Weekend board",
): Promise<string> {
	const userId = await testUserId();
	const artifactId = randomUUID();
	const now = new Date();
	const json = boardJson(body);
	await db.insert(artifacts).values({
		id: artifactId,
		userId,
		conversationId,
		type: "artifact",
		retrievalClass: "durable",
		name: title,
		contentText: json,
		metadataJson: JSON.stringify({ artifactType: "canvas", title }),
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(artifactVersions).values({
		id: randomUUID(),
		artifactId,
		userId,
		versionNumber: 1,
		author: "alfy",
		summary: "Alfy made the board",
		body: json,
		bodyHash: "seed-hash",
		createdAt: now,
	});
	return artifactId;
}

export async function storedBoard(artifactId: string): Promise<CanvasBody> {
	const [row] = await db
		.select({ contentText: artifacts.contentText })
		.from(artifacts)
		.where(eq(artifacts.id, artifactId))
		.limit(1);
	return JSON.parse(row.contentText ?? "{}") as CanvasBody;
}

export async function openChatAndReload(page: Page, conversationId: string) {
	await page.evaluate((id) => {
		window.sessionStorage.removeItem(`pending-chat-message:${id}`);
	}, conversationId);
	await page.goto(`/chat/${conversationId}`);
	await page.reload({ waitUntil: "networkidle" });
}

/** Opens the panel on the chat's one Canvas (the count button, then its row); a no-op when the reload already restored it. */
export async function openCanvasPanel(page: Page) {
	const isMobile = (page.viewportSize()?.width ?? 1440) < 768;
	const editor = page.getByTestId("canvas-editor");
	const alreadyShowing = await editor
		.waitFor({ state: "visible", timeout: 2_000 })
		.then(() => true)
		.catch(() => false);
	if (!alreadyShowing) {
		await page
			.getByTestId(
				isMobile ? "artifact-count-button-compact" : "artifact-count-button",
			)
			.click();
		await page
			.getByTestId(
				isMobile ? "artifact-panel-list-mobile" : "artifact-panel-list",
			)
			.getByTestId("artifact-row")
			.first()
			.click();
	}
	await expect(editor).toBeVisible();
	// The loading skeleton gives way to the board.
	await expect(page.getByTestId("canvas-board")).toBeVisible({
		timeout: 15_000,
	});
	// Svelte Flow reveals a node only once it has measured it.
	await expect(async () => {
		const hidden = await page
			.locator(".svelte-flow__node")
			.evaluateAll(
				(nodes) =>
					nodes.filter((node) => getComputedStyle(node).visibility === "hidden")
						.length,
			);
		expect(hidden).toBe(0);
	}).toPass({ timeout: 10_000 });
	// The panel slides in: what is measured next is measured where it will stay.
	await waitForStableBoundingBox(page.getByTestId("canvas-board"));
}

export async function nodeCount(page: Page): Promise<number> {
	return page.getByTestId("canvas-node").count();
}

export async function savedStatus(page: Page) {
	await expect(page.getByTestId("canvas-save-status")).toHaveText(/Saved/, {
		timeout: 10_000,
	});
}

/** The version rows a board has, oldest first: what a save added (or, when it coalesced, did not). */
export async function versionRows(
	artifactId: string,
): Promise<{ versionNumber: number; author: string }[]> {
	return db
		.select({
			versionNumber: artifactVersions.versionNumber,
			author: artifactVersions.author,
		})
		.from(artifactVersions)
		.where(eq(artifactVersions.artifactId, artifactId))
		.orderBy(artifactVersions.versionNumber);
}

/** A node's box on screen (the library's wrapper, whatever the kind). */
export async function nodeBox(page: Page, id: string) {
	const box = await page
		.locator(`.svelte-flow__node[data-id="${id}"]`)
		.boundingBox();
	if (!box) throw new Error(`no box for node ${id}`);
	return box;
}

/** Presses on a point, drags to another in steps, and lets go: one pointer gesture. */
export async function dragBetween(
	page: Page,
	from: { x: number; y: number },
	to: { x: number; y: number },
	steps = 14,
) {
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(to.x, to.y, { steps });
	await page.mouse.up();
}

/** The marks a board was saved with, in the order they were drawn. */
export async function storedAnnotations(artifactId: string) {
	return (await storedBoard(artifactId)).annotations;
}

/** The camera as the viewport element carries it, so a test can say "it did not move". */
export async function cameraOf(
	page: Page,
): Promise<{ x: number; y: number; zoom: number }> {
	return page.evaluate(() => {
		const viewport = document.querySelector(".svelte-flow__viewport");
		const match =
			/translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)\s*scale\((-?[\d.]+)\)/.exec(
				(viewport as HTMLElement | null)?.style.transform ?? "",
			);
		if (!match) return { x: 0, y: 0, zoom: 1 };
		return { x: Number(match[1]), y: Number(match[2]), zoom: Number(match[3]) };
	});
}
