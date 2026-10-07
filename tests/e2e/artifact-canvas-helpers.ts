import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import {
	artifacts,
	artifactVersions,
	users,
} from "../../src/lib/server/db/schema";
import {
	createComment,
	resolveComment,
} from "../../src/lib/server/services/artifacts";
import type { Anchor } from "../../src/lib/shared/artifacts/anchor";
import type { CanvasBody } from "../../src/lib/shared/artifacts/canvas";
import { boardJson } from "../../src/lib/shared/artifacts/canvas-body";
import {
	createConversation,
	login,
	waitForMotionToSettle,
	waitForStableBoundingBox,
} from "./helpers";

// What every Canvas e2e spec needs: a board seeded straight into the database
// (the convention artifacts-panel.spec.ts and artifact-app.spec.ts established,
// since `create_artifact` has no scriptable tool-call fixture), the panel opened
// on it, and a look at what was actually saved.

export async function testUserId(): Promise<string> {
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

/** The camera once it has stopped moving (a fit, a glide, a transition): the same answer twice, a couple of frames apart. */
export async function settledCamera(
	page: Page,
): Promise<{ x: number; y: number; zoom: number }> {
	await waitForMotionToSettle(page);
	let last = await cameraOf(page);
	await expect
		.poll(async () => {
			await page.evaluate(
				() =>
					new Promise<void>((resolve) =>
						requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
					),
			);
			const now = await cameraOf(page);
			const still =
				now.x === last.x && now.y === last.y && now.zoom === last.zoom;
			last = now;
			return still;
		})
		.toBe(true);
	return last;
}

/** A thread on a board, written through the service the routes use (author, scope and anchor rules included). Returns its id. */
export async function seedThread(
	artifactId: string,
	anchor: Anchor,
	body: string,
	options: { resolved?: boolean; author?: "user" | "alfy" } = {},
): Promise<string> {
	const userId = await testUserId();
	const created = await createComment({
		userId,
		artifactId,
		anchor,
		author: options.author ?? "user",
		body,
	});
	if (!created) throw new Error("the seeded thread was refused");
	if (options.resolved) {
		await resolveComment({
			userId,
			artifactId,
			commentId: created.id,
			resolved: true,
		});
	}
	return created.id;
}

// ---- A phone, its on-screen keyboard and a board to look at on it ----------

/** A phone's page. */
export const PHONE = { width: 390, height: 844 };
/** What an on-screen keyboard takes of a phone's height: the page is shorter by this when it is open (`interactive-widget=resizes-content`). */
export const KEYBOARD = 336;

/** Longer than the keyboard reveal takes to start (it waits for the page to hold still) and to glide: what a pan that is going to happen has done by then. */
export const PAN_WAIT_MS = 600;

/** Six notes in two columns: tall enough that a shorter pane changes the fit, legible when fitted to a phone. */
export function sixNotes(): CanvasBody {
	return {
		version: 1,
		nodes: Array.from({ length: 6 }, (_, index) => ({
			id: `note-${index + 1}`,
			type: "sticky" as const,
			position: { x: (index % 2) * 240, y: Math.floor(index / 2) * 220 },
			width: 200,
			data: {
				kind: "sticky" as const,
				text: `Note ${index + 1}`,
				tone: "yellow" as const,
			},
		})),
		edges: [],
		viewport: { x: 0, y: 0, zoom: 1 },
		annotations: [],
	};
}

export type Camera = { x: number; y: number; zoom: number };

export function expectCamera(
	actual: Camera,
	expected: Camera,
	message: string,
) {
	expect(actual.x, `${message}: x`).toBeCloseTo(expected.x, 1);
	expect(actual.y, `${message}: y`).toBeCloseTo(expected.y, 1);
	expect(actual.zoom, `${message}: zoom`).toBeCloseTo(expected.zoom, 3);
}

/** A block's box measured from the board's own top left corner: where the reader sees it, whatever the page around the board does. */
export async function placeInPane(page: Page, id: string) {
	const pane = await page.getByTestId("canvas-board").boundingBox();
	if (!pane) throw new Error("no board");
	const box = await nodeBox(page, id);
	return { x: box.x - pane.x, y: box.y - pane.y };
}

export async function centreOf(page: Page, id: string) {
	const box = await nodeBox(page, id);
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Signs in, seeds `body` on a conversation of its own and opens the panel on it (six notes unless told otherwise). */
export async function openBoard(
	page: Page,
	title: string,
	body: CanvasBody = sixNotes(),
) {
	await login(page);
	const conversationId = await createConversation(page, title);
	await seedCanvas(conversationId, body);
	await openChatAndReload(page, conversationId);
	await openCanvasPanel(page);
}

// ---- What the board's own layers cover, asked of the browser ---------------

/** A flowchart of five boxes in a column: Mermaid draws it a moment after its block is measured, and it is taller than the block was. */
export const TRIP_FLOWCHART = [
	"flowchart TD",
	"  A[Airport] --> B[Bus or S-Bahn]",
	"  B --> C[Wien Mitte]",
	"  C --> D[U3 metro]",
	"  D --> E[Hotel]",
].join("\n");

/** A bar chart's config, the way the chat's chart fence writes it. */
export const TRIP_COSTS = JSON.stringify({
	type: "bar",
	data: {
		labels: ["Museum", "Lunch", "Dinner"],
		datasets: [{ label: "EUR", data: [40, 30, 60] }],
	},
});

/** A rectangle on the screen. */
export type ScreenBox = {
	left: number;
	top: number;
	right: number;
	bottom: number;
};

export async function screenBoxOf(locator: Locator): Promise<ScreenBox | null> {
	const box = await locator.boundingBox();
	if (!box) return null;
	return {
		left: box.x,
		top: box.y,
		right: box.x + box.width,
		bottom: box.y + box.height,
	};
}

/** Whether two boxes share any of the screen. */
export function boxesMeet(a: ScreenBox, b: ScreenBox): boolean {
	return (
		a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
	);
}

/** What the browser puts under the middle of an element: the element itself, or a part of it, when nothing covers it. */
export async function isTopmostAtCentre(
	page: Page,
	locator: Locator,
): Promise<boolean> {
	const handle = await locator.elementHandle();
	if (!handle) return false;
	return page.evaluate((element) => {
		const box = element.getBoundingClientRect();
		const hit = document.elementFromPoint(
			box.left + box.width / 2,
			box.top + box.height / 2,
		);
		return hit !== null && (hit === element || element.contains(hit));
	}, handle);
}
