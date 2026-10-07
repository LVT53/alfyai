import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { desc, eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import { artifactVersions } from "../../src/lib/server/db/schema";
import type { BoardOp } from "../../src/lib/shared/artifacts/board-ops";
import type {
	CanvasBody,
	CanvasNode,
} from "../../src/lib/shared/artifacts/canvas";
import { normalizeCanvasBody } from "../../src/lib/shared/artifacts/canvas-body";
import { plannedNodeSize } from "../../src/lib/shared/artifacts/node-size";
import {
	cameraOf,
	openCanvasPanel,
	openChatAndReload,
	seedCanvas,
	settledCamera,
	storedBoard,
} from "./artifact-canvas-helpers";
import { createConversation, login } from "./helpers";

// What Alfy adds to a board is drawn, and drawn where a person would put it (the
// owner's Canvas round, ruling 74): a flowchart Alfy writes is drawn by the chat's
// own Mermaid, a note put beside another lands next to it in its frame, and a chart
// for a frame that is full makes the frame grow. Each is checked on what the panel
// DRAWS, not on what is stored: every block's box on screen against every other's,
// every child's against its frame's, and the height the board was told a diagram is
// against the height it is drawn at (the estimate is what the model reads and the
// placer reserves).
//
// The change is sent the way the panel sends one (`POST /api/artifacts/[id]/ops`),
// which judges it with the very vocabulary the model's edit does (ruling 14), so the
// places are the ones the app settled. The seeded board is the eval's own tidy board.

const SHOTS = process.env.CVA_SHOTS;

const FIXTURE = join(
	process.cwd(),
	"scripts/eval-artifact-contracts/fixtures/canvas/boards/vienna-tidy.json",
);

function viennaBoard(): CanvasBody {
	return normalizeCanvasBody(JSON.parse(readFileSync(FIXTURE, "utf8"))).body;
}

async function alfyEdits(page: Page, artifactId: string, ops: BoardOp[]) {
	const [newest] = await db
		.select({ id: artifactVersions.id })
		.from(artifactVersions)
		.where(eq(artifactVersions.artifactId, artifactId))
		.orderBy(desc(artifactVersions.versionNumber))
		.limit(1);
	const response = await page.request.post(`/api/artifacts/${artifactId}/ops`, {
		data: {
			baseVersionId: newest.id,
			diff: { id: `diff-${Date.now()}`, summary: "Alfy's change", ops },
		},
	});
	expect(response.ok(), await response.text()).toBe(true);
	const answer = (await response.json()) as {
		ok: boolean;
		applied: number;
		refused: unknown[];
	};
	expect(answer.refused).toEqual([]);
	expect(answer.applied).toBe(ops.length);
}

interface Drawn {
	id: string;
	kind: string;
	/** The block's box in board units: its screen box and the camera's zoom undone. */
	box: { x: number; y: number; width: number; height: number };
}

async function drawnBoxes(page: Page): Promise<Drawn[]> {
	const camera = await settledCamera(page);
	const origin = await page.getByTestId("canvas-board").boundingBox();
	if (!origin) throw new Error("no board");
	const nodes = page.getByTestId("canvas-node");
	const count = await nodes.count();
	const out: Drawn[] = [];
	for (let i = 0; i < count; i += 1) {
		const node = nodes.nth(i);
		const wrapper = node.locator(
			"xpath=ancestor-or-self::*[contains(@class,'svelte-flow__node')][1]",
		);
		const id = (await wrapper.getAttribute("data-id")) ?? "";
		const kind = (await node.getAttribute("data-kind")) ?? "";
		const box = await wrapper.boundingBox();
		if (!box) continue;
		out.push({
			id,
			kind,
			box: {
				x: (box.x - origin.x - camera.x) / camera.zoom,
				y: (box.y - origin.y - camera.y) / camera.zoom,
				width: box.width / camera.zoom,
				height: box.height / camera.zoom,
			},
		});
	}
	return out;
}

const SLACK = 2;

/** Whether two blocks, neither the other's frame, share space on the screen. */
function overlapsAny(drawn: Drawn[], stored: CanvasBody): string[] {
	const byId = new Map(stored.nodes.map((node) => [node.id, node]));
	const ancestors = (id: string): Set<string> => {
		const chain = new Set<string>();
		let cursor = byId.get(id)?.parentId;
		while (cursor && !chain.has(cursor)) {
			chain.add(cursor);
			cursor = byId.get(cursor)?.parentId;
		}
		return chain;
	};
	const problems: string[] = [];
	for (let i = 0; i < drawn.length; i += 1) {
		for (let j = i + 1; j < drawn.length; j += 1) {
			const a = drawn[i];
			const b = drawn[j];
			if (ancestors(a.id).has(b.id) || ancestors(b.id).has(a.id)) continue;
			const across =
				Math.min(a.box.x + a.box.width, b.box.x + b.box.width) -
				Math.max(a.box.x, b.box.x);
			const down =
				Math.min(a.box.y + a.box.height, b.box.y + b.box.height) -
				Math.max(a.box.y, b.box.y);
			if (across > SLACK && down > SLACK) {
				problems.push(`${a.id} (${a.kind}) covers ${b.id} (${b.kind})`);
			}
		}
	}
	return problems;
}

/** Every child's box lies inside its frame's, as drawn. */
function sticksOut(drawn: Drawn[], stored: CanvasBody): string[] {
	const boxes = new Map(drawn.map((entry) => [entry.id, entry.box]));
	const problems: string[] = [];
	for (const node of stored.nodes) {
		if (!node.parentId) continue;
		const child = boxes.get(node.id);
		const frame = boxes.get(node.parentId);
		if (!child || !frame) continue;
		if (
			child.x < frame.x - SLACK ||
			child.y < frame.y - SLACK ||
			child.x + child.width > frame.x + frame.width + SLACK ||
			child.y + child.height > frame.y + frame.height + SLACK
		) {
			problems.push(`${node.id} sticks out of ${node.parentId}`);
		}
	}
	return problems;
}

async function openBoardOf(
	page: Page,
	title: string,
	board: CanvasBody = viennaBoard(),
): Promise<{ artifactId: string; conversationId: string }> {
	await login(page);
	const conversationId = await createConversation(page, title);
	const artifactId = await seedCanvas(conversationId, board, title);
	return { artifactId, conversationId };
}

async function shot(page: Page, name: string) {
	if (!SHOTS) return;
	await page.getByTestId("canvas-board").screenshot({
		path: join(SHOTS, `${name}.png`),
	});
}

test.describe("what Alfy adds to a board is drawn, where a person would put it (ruling 74)", () => {
	test("a flowchart Alfy writes is drawn by the chat's own Mermaid, on free ground, at the height the board was told", async ({
		page,
	}) => {
		const { artifactId, conversationId } = await openBoardOf(
			page,
			"Alfy flowchart",
		);
		const source = [
			"flowchart TD",
			"  A[Breakfast at Café Central] --> B[Kunsthistorisches Museum]",
			"  B --> C{Raining?}",
			"  C -->|yes| D[Lunch at the Naschmarkt]",
			"  C -->|no| E[Walk along the Ringstrasse]",
			"  D --> F[Opera]",
			"  E --> F",
		].join("\n");
		await alfyEdits(page, artifactId, [
			{
				op: "add_node",
				node: {
					id: "flow",
					type: "mermaid",
					data: { kind: "mermaid", label: "Saturday", code: source },
				},
			},
		]);
		await openChatAndReload(page, conversationId);
		await openCanvasPanel(page);

		// It is drawn, by the chat's own component: an SVG with the source's words,
		// and neither the source as text nor Mermaid's error note.
		const diagram = page.getByTestId("canvas-mermaid");
		await expect(diagram.locator(".markdown-mermaid svg")).toBeVisible({
			timeout: 20_000,
		});
		await expect(diagram.locator(".markdown-diagram-error")).toHaveCount(0);
		await expect(diagram.locator(".markdown-diagram-source")).toHaveCount(0);
		await expect(diagram).toContainText("Kunsthistorisches Museum");
		await expect(diagram).toContainText("Raining?");

		const stored = await storedBoard(artifactId);
		const flow = stored.nodes.find((node) => node.id === "flow") as CanvasNode;
		expect(flow.width).toBe(480);

		// Everything is where it can be seen: nothing covers anything, as drawn.
		const drawn = await drawnBoxes(page);
		expect(overlapsAny(drawn, stored)).toEqual([]);
		expect(sticksOut(drawn, stored)).toEqual([]);

		// The height the board was told is the height it is drawn at, never short.
		const asDrawn = drawn.find((entry) => entry.id === "flow");
		const told = plannedNodeSize(flow).height;
		expect(asDrawn?.box.height ?? 0).toBeGreaterThan(300);
		expect(told).toBeGreaterThanOrEqual((asDrawn?.box.height ?? 0) - SLACK);
		expect(told).toBeLessThanOrEqual((asDrawn?.box.height ?? 0) * 1.35 + 10);
		await shot(page, "flowchart");
	});

	test("a note put next to another lands beside it, in its frame, clear of the notes around it", async ({
		page,
	}) => {
		const { artifactId, conversationId } = await openBoardOf(
			page,
			"Alfy note beside",
		);
		await alfyEdits(page, artifactId, [
			{
				op: "add_node",
				node: {
					id: "sacher",
					type: "sticky",
					near: "museum",
					data: {
						kind: "sticky",
						text: "Sachertorte at Café Sacher",
						tone: "mint",
					},
				},
			},
		]);
		await openChatAndReload(page, conversationId);
		await openCanvasPanel(page);

		const stored = await storedBoard(artifactId);
		const sacher = stored.nodes.find((node) => node.id === "sacher");
		expect(sacher?.parentId).toBe("sat");

		const drawn = await drawnBoxes(page);
		expect(overlapsAny(drawn, stored)).toEqual([]);
		expect(sticksOut(drawn, stored)).toEqual([]);
		const museum = drawn.find((entry) => entry.id === "museum");
		const added = drawn.find((entry) => entry.id === "sacher");
		if (!museum || !added) throw new Error("both notes are drawn");
		const across = Math.max(
			0,
			Math.max(museum.box.x, added.box.x) -
				Math.min(
					museum.box.x + museum.box.width,
					added.box.x + added.box.width,
				),
		);
		const down = Math.max(
			0,
			Math.max(museum.box.y, added.box.y) -
				Math.min(
					museum.box.y + museum.box.height,
					added.box.y + added.box.height,
				),
		);
		expect(Math.hypot(across, down)).toBeLessThanOrEqual(160);
		await shot(page, "note-beside");
	});

	test("a chart for a frame that is full makes the frame grow, and everything is still clear of everything", async ({
		page,
	}) => {
		const { artifactId, conversationId } = await openBoardOf(
			page,
			"Alfy chart in frame",
		);
		await alfyEdits(page, artifactId, [
			{
				op: "add_node",
				node: {
					id: "costs",
					type: "chart",
					parentId: "sat",
					data: {
						kind: "chart",
						label: "Costs",
						code: JSON.stringify({
							type: "bar",
							data: {
								labels: ["Breakfast", "Museum", "Lunch", "Tram"],
								datasets: [{ label: "EUR", data: [12, 21, 18, 8] }],
							},
						}),
					},
				},
			},
		]);
		await openChatAndReload(page, conversationId);
		await openCanvasPanel(page);

		const stored = await storedBoard(artifactId);
		const chart = stored.nodes.find((node) => node.id === "costs");
		const frame = stored.nodes.find((node) => node.id === "sat");
		expect(chart?.parentId).toBe("sat");
		expect(frame?.height).toBeGreaterThan(360);
		await expect(page.getByTestId("canvas-chart").first()).toBeVisible({
			timeout: 20_000,
		});

		const drawn = await drawnBoxes(page);
		expect(overlapsAny(drawn, stored)).toEqual([]);
		expect(sticksOut(drawn, stored)).toEqual([]);
		const camera = await cameraOf(page);
		expect(camera.zoom).toBeGreaterThan(0);
		await shot(page, "chart-in-frame");
	});

	test("a diagram asked for in a frame that has no room is drawn inside it, the frame grown wide enough, when nothing stands beside it", async ({
		page,
	}) => {
		const roomy = viennaBoard();
		roomy.nodes = roomy.nodes.filter(
			(node) => node.id !== "title" && node.id !== "pack",
		);
		const { artifactId, conversationId } = await openBoardOf(
			page,
			"Alfy diagram in frame",
			roomy,
		);
		await alfyEdits(page, artifactId, [
			{
				op: "add_node",
				node: {
					id: "flow",
					type: "mermaid",
					parentId: "sat",
					data: {
						kind: "mermaid",
						code: "flowchart LR\n  A[Plan] --> B[Build] --> C[Ship]",
					},
				},
			},
		]);
		await openChatAndReload(page, conversationId);
		await openCanvasPanel(page);

		const stored = await storedBoard(artifactId);
		expect(stored.nodes.find((node) => node.id === "flow")?.parentId).toBe(
			"sat",
		);
		expect(
			stored.nodes.find((node) => node.id === "sat")?.width,
		).toBeGreaterThanOrEqual(520);
		await expect(
			page.getByTestId("canvas-mermaid").locator(".markdown-mermaid svg"),
		).toBeVisible({ timeout: 20_000 });
		const drawn = await drawnBoxes(page);
		expect(overlapsAny(drawn, stored)).toEqual([]);
		expect(sticksOut(drawn, stored)).toEqual([]);
		await shot(page, "diagram-in-frame");
	});

	test("a diagram asked for in a frame that cannot grow without crowding what stands beside it is drawn beside the frame, and the frame stays as it was", async ({
		page,
	}) => {
		// The title and the checklist stand 60 to the right of the frame: 520 wide would touch them.
		const { artifactId, conversationId } = await openBoardOf(
			page,
			"Alfy diagram beside frame",
		);
		await alfyEdits(page, artifactId, [
			{
				op: "add_node",
				node: {
					id: "flow",
					type: "mermaid",
					parentId: "sat",
					data: {
						kind: "mermaid",
						code: "flowchart LR\n  A[Plan] --> B[Build] --> C[Ship]",
					},
				},
			},
		]);
		await openChatAndReload(page, conversationId);
		await openCanvasPanel(page);

		const stored = await storedBoard(artifactId);
		expect(
			stored.nodes.find((node) => node.id === "flow")?.parentId,
		).toBeUndefined();
		expect(stored.nodes.find((node) => node.id === "sat")?.width).toBe(460);
		await expect(
			page.getByTestId("canvas-mermaid").locator(".markdown-mermaid svg"),
		).toBeVisible({ timeout: 20_000 });
		const drawn = await drawnBoxes(page);
		expect(overlapsAny(drawn, stored)).toEqual([]);
		await shot(page, "diagram-beside-frame");
	});
});
