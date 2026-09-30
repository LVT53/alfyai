import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import { artifacts, artifactVersions } from "../../src/lib/server/db/schema";
import { createArtifact } from "../../src/lib/server/services/artifacts";
import type {
	CanvasBody,
	CanvasNode,
} from "../../src/lib/shared/artifacts/canvas";
import { boardJson } from "../../src/lib/shared/artifacts/canvas-body";
import {
	AI_SMOKE_CANVAS_EDIT_FINAL_TEXT,
	AI_SMOKE_CANVAS_EDIT_MARKER,
	encodeCanvasEditScenarioPayload,
} from "../fixtures/ai/openai-compatible-scenarios";
import { createOpenAICompatibleProviderHarness } from "../mocks/ai-provider/openai-compatible-provider";
import {
	dragBetween,
	nodeBox,
	openCanvasPanel,
	openChatAndReload,
	savedStatus,
	storedBoard,
	testUserId,
} from "./artifact-canvas-helpers";
import {
	createTemporaryFakeProviderModel,
	deleteTemporaryProvider,
	snapshotUserModelPreference,
	updateUserModelPreference,
} from "./artifact-live-edit.helpers";
import { createConversation, login, sendMessage } from "./helpers";

// Alfy's change to a board, seen and decided (Feature 2 · Artifacts, Slice 3, T6
// and ruling 63). A REAL `edit_artifact` call on a board, driven through the real
// `/api/chat/stream` by the fake OpenAI-compatible provider (the mechanism
// `artifact-document.spec.ts`'s "T8 live" established): the model is scripted with
// the exact ops, the real handler judges them and writes one Alfy version, and the
// open panel draws it. What the unit suites cannot see is here: that the frame and
// the pill really show, that the structure is drawn before the glide and the glide
// is a glide, that a change is decided as one change and survives a reload, and
// that a body built after the call settled does not draw it a second time.

const FRAME = "frame-saturday";
const LUNCH = "note-lunch";
const MUSEUM = "note-museum";
const DINNER = "note-dinner";
const PLAN = "text-plan";
const MUSEUM_AT = { x: 420, y: 40 };
const CAMERA = { x: 16, y: 16, zoom: 1 };

function note(
	id: string,
	x: number,
	y: number,
	text: string,
	parentId?: string,
): CanvasNode {
	return {
		id,
		type: "sticky",
		position: { x, y },
		width: 180,
		...(parentId ? { parentId } : {}),
		data: { kind: "sticky", text, tone: "yellow" },
	};
}

function board(): CanvasBody {
	return {
		version: 1,
		nodes: [
			{
				id: FRAME,
				type: "frame",
				position: { x: 20, y: 20 },
				width: 320,
				height: 260,
				data: { kind: "frame", label: "Saturday", width: 320, height: 260 },
			},
			note(LUNCH, 24, 64, "Lunch at the market", FRAME),
			note(MUSEUM, MUSEUM_AT.x, MUSEUM_AT.y, "Museum, 14:00"),
			note(DINNER, 420, 200, "Dinner, 19:30"),
			{
				id: PLAN,
				type: "text",
				position: { x: 420, y: 340 },
				data: { kind: "text", text: "Weekend plan" },
			},
		],
		edges: [],
		viewport: CAMERA,
		annotations: [],
	};
}

/** The change most tests script: a new frame with a note in it, and the museum moved. A highlight points at the lunch. */
const PLANNED_SUNDAY = [
	{
		op: "add_frame",
		id: "frame-sunday",
		label: "Sunday",
		position: { x: 20, y: 320 },
		size: { width: 320, height: 200 },
	},
	{
		op: "add_node",
		node: {
			id: "note-brunch",
			type: "sticky",
			parentId: "frame-sunday",
			position: { x: 20, y: 60 },
			data: { kind: "sticky", text: "Brunch, 10:30", tone: "mint" },
		},
	},
	{ op: "move", id: MUSEUM, to: { x: 470, y: 100 } },
	{ op: "highlight", ids: [LUNCH] },
];

const fakeProvider = createOpenAICompatibleProviderHarness();

test.beforeAll(async () => {
	await fakeProvider.start();
});
test.afterAll(async () => {
	await fakeProvider.stop();
});
test.beforeEach(async () => {
	await fakeProvider.reset();
});

type Scene = {
	conversationId: string;
	artifactId: string;
	cleanup: () => Promise<void>;
};

/** A board made through the service (its version's hash is real, which the edit tool's own write is checked against), a fake model to script it, the chat open on it. */
async function open(
	page: Page,
	options: { panel?: boolean } = {},
): Promise<Scene> {
	await login(page);
	const previousPreference = await snapshotUserModelPreference(page);
	const conversationId = await createConversation(page, "Board review");
	const userId = await testUserId();
	const created = await createArtifact({
		userId,
		conversationId,
		kind: "canvas",
		title: "Weekend board",
		body: boardJson(board()),
		author: "user",
		versionSummary: "Created",
	});
	if (!created.ok) throw new Error(created.reason);
	const provider = await createTemporaryFakeProviderModel(
		page,
		fakeProvider.baseURL,
	);
	await updateUserModelPreference(page, provider.selectedModel);
	await openChatAndReload(page, conversationId);
	if (options.panel !== false) await openCanvasPanel(page);
	return {
		conversationId,
		artifactId: created.artifact.id,
		cleanup: async () => {
			await updateUserModelPreference(page, previousPreference);
			await deleteTemporaryProvider(page, provider.providerId);
		},
	};
}

/** What the reader asks the chat: the fake model answers it with an `edit_artifact` call of exactly these ops. */
async function askAlfy(
	page: Page,
	artifactId: string,
	ops: unknown[],
	summary = "Planned Sunday",
) {
	await sendMessage(
		page,
		`${AI_SMOKE_CANVAS_EDIT_MARKER} ${encodeCanvasEditScenarioPayload({ artifactId, summary, ops })}`,
	);
}

async function landed(page: Page) {
	await expect(page.getByText(AI_SMOKE_CANVAS_EDIT_FINAL_TEXT)).toBeVisible({
		timeout: 30_000,
	});
	await expect(page.getByTestId("canvas-change-pill")).toBeVisible({
		timeout: 15_000,
	});
}

async function versions(artifactId: string) {
	return db
		.select({
			versionNumber: artifactVersions.versionNumber,
			author: artifactVersions.author,
			summary: artifactVersions.summary,
		})
		.from(artifactVersions)
		.where(eq(artifactVersions.artifactId, artifactId))
		.orderBy(artifactVersions.versionNumber);
}

async function marker(artifactId: string) {
	const [row] = await db
		.select({ metadataJson: artifacts.metadataJson })
		.from(artifacts)
		.where(eq(artifacts.id, artifactId));
	return (JSON.parse(row.metadataJson ?? "{}") as { review?: unknown }).review;
}

const bar = (page: Page) => page.getByTestId("canvas-review-bar");
const pill = (page: Page) => page.getByTestId("canvas-change-pill");
const rings = (page: Page) => page.getByTestId("canvas-alfy-ring");
const pulsing = (page: Page) => page.locator(".ring--pulse");
const keepAll = (page: Page) => page.getByRole("button", { name: /^Keep all/ });
const undoAll = (page: Page) => page.getByRole("button", { name: /^Undo all/ });

test.describe("Alfy's change lands where the reader can see it", () => {
	test("frames what Alfy arranges, draws the structure first, glides what moves, and rings what was touched", async ({
		page,
	}) => {
		const scene = await open(page);
		try {
			const before = await nodeBox(page, MUSEUM);
			// A sampler in the page: where the museum is on every frame, and when the new
			// note first exists, so the order is measured rather than believed.
			await page.evaluate((id) => {
				const w = window as unknown as {
					__glide: { t: number; x: number }[];
					__brunchAt?: number;
				};
				w.__glide = [];
				const sample = () => {
					const el = document.querySelector(
						`.svelte-flow__node[data-id="${id}"]`,
					);
					if (el) {
						w.__glide.push({
							t: performance.now(),
							x: el.getBoundingClientRect().left,
						});
					}
					requestAnimationFrame(sample);
				};
				requestAnimationFrame(sample);
				new MutationObserver(() => {
					if (
						w.__brunchAt === undefined &&
						document.querySelector('.svelte-flow__node[data-id="note-brunch"]')
					) {
						w.__brunchAt = performance.now();
					}
				}).observe(document.body, { childList: true, subtree: true });
			}, MUSEUM);

			await askAlfy(page, scene.artifactId, PLANNED_SUNDAY);

			// While it works: "Alfy is arranging…" with the call's own summary, and a
			// dashed frame around the blocks it is addressing.
			await expect(page.getByTestId("canvas-arranging")).toContainText(
				"Alfy is arranging: Planned Sunday",
				{ timeout: 20_000 },
			);
			await expect(page.getByTestId("canvas-arranging-frame")).toBeVisible();

			await landed(page);
			await expect(page.getByTestId("canvas-arranging")).toBeHidden();
			await expect(page.getByTestId("canvas-arranging-frame")).toBeHidden();

			// The structure (the frame and its note) is on the board, the museum has moved.
			await expect(
				page.locator('.svelte-flow__node[data-id="note-brunch"]'),
			).toBeVisible();
			const after = await nodeBox(page, MUSEUM);
			expect(after.x).toBeGreaterThan(before.x + 30);

			// A glide, not a jump, and the structure came first.
			const samples = await page.evaluate(() => {
				const w = window as unknown as {
					__glide: { t: number; x: number }[];
					__brunchAt?: number;
				};
				return { glide: w.__glide, brunchAt: w.__brunchAt ?? null };
			});
			const start = samples.glide[0].x;
			const end = samples.glide[samples.glide.length - 1].x;
			expect(end).toBeGreaterThan(start + 30);
			const between = samples.glide.filter(
				(sample) => sample.x > start + 2 && sample.x < end - 2,
			);
			expect(between.length).toBeGreaterThan(3);
			const firstMove = samples.glide.find(
				(sample) => Math.abs(sample.x - start) > 1,
			);
			expect(samples.brunchAt).not.toBeNull();
			expect(samples.brunchAt as number).toBeLessThan(firstMove?.t ?? 0);

			// Every touched block is ringed, strongly at first; the lunch a highlight
			// pointed at is ringed for the moment too, and is not part of what waits.
			await expect(pulsing(page).first()).toBeVisible();
			const ringed = await rings(page).evaluateAll((elements) =>
				elements.map((element) => element.getAttribute("data-node-id")),
			);
			expect(ringed).toContain("frame-sunday");
			expect(ringed).toContain("note-brunch");
			expect(ringed).toContain(MUSEUM);
			expect(ringed).toContain(LUNCH);
			await expect(pulsing(page)).toHaveCount(0, { timeout: 10_000 });
			// After 3.2 s the ring rests; the lunch's is gone, the waiting three stay.
			await expect(rings(page)).toHaveCount(3);

			// One pill at the corner of what was touched, one bar below the board.
			await expect(bar(page)).toContainText("Alfy changed 3 blocks.");
			await expect(bar(page).getByText("1 / 3")).toBeVisible();
			await expect(
				pill(page).getByRole("group", { name: /Planned Sunday/ }),
			).toBeVisible();

			// What was saved is Alfy's one version, with the diff's summary and a marker
			// that survives a reload.
			const rows = await versions(scene.artifactId);
			expect(rows.map((row) => [row.versionNumber, row.author])).toEqual([
				[1, "user"],
				[2, "alfy"],
			]);
			expect(rows[1].summary).toBe("Planned Sunday");
			expect(await marker(scene.artifactId)).toEqual({
				throughVersion: 1,
				keptBlockIds: [],
			});
			const stored = await storedBoard(scene.artifactId);
			expect(stored.nodes.some((node) => node.id === "note-brunch")).toBe(true);
		} finally {
			await scene.cleanup();
		}
	});

	test("steps through the touched blocks and centres the camera on each", async ({
		page,
	}) => {
		const scene = await open(page);
		try {
			await askAlfy(page, scene.artifactId, PLANNED_SUNDAY);
			await landed(page);
			await expect(pulsing(page)).toHaveCount(0, { timeout: 10_000 });

			const centre = async (id: string) => {
				const box = await nodeBox(page, id);
				return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
			};
			const paneCentre = async () => {
				const pane = await page.getByTestId("canvas-board").boundingBox();
				if (!pane) throw new Error("no pane");
				return { x: pane.x + pane.width / 2, y: pane.y + pane.height / 2 };
			};

			// Next: the second touched block (in the board's own order: the museum? the
			// frame first, then the note, then the museum — the museum was on the board
			// first, so the order is the board's: museum, frame-sunday, note-brunch).
			await page.getByRole("button", { name: "Next change" }).click();
			await expect(bar(page).getByText("2 / 3")).toBeVisible();
			const ring = page.locator(".ring--active");
			await expect(ring).toHaveCount(1);
			const activeId = await ring.getAttribute("data-node-id");
			expect(activeId).toBeTruthy();
			await expect
				.poll(
					async () => {
						const [c, p] = [
							await centre(activeId as string),
							await paneCentre(),
						];
						return Math.hypot(c.x - p.x, c.y - p.y);
					},
					{ timeout: 5000 },
				)
				.toBeLessThan(60);
		} finally {
			await scene.cleanup();
		}
	});

	test("names what Alfy skipped in the shared notice, and lets it go", async ({
		page,
	}) => {
		const scene = await open(page);
		try {
			await askAlfy(page, scene.artifactId, [
				{ op: "move", id: MUSEUM, to: { x: 470, y: 100 } },
				{ op: "move", id: "ghost", to: { x: 5, y: 5 } },
			]);
			await landed(page);
			const notice = page.getByTestId("refusal-notice");
			await expect(notice).toContainText("Alfy skipped 1 change.");
			await expect(notice).toContainText(
				"nothing is at that position any more",
			);
			// The bar says so too, and the link goes to the notice.
			await expect(bar(page)).toContainText("Left 1 alone.");
			await notice.getByRole("button", { name: "Dismiss" }).click();
			await expect(notice).toBeHidden();
			// What did apply stands.
			expect(
				(await storedBoard(scene.artifactId)).nodes.find((n) => n.id === MUSEUM)
					?.position,
			).toEqual({ x: 470, y: 100 });
		} finally {
			await scene.cleanup();
		}
	});

	test("names what Alfy left alone when it refused every op: nothing to review, and no version", async ({
		page,
	}) => {
		const scene = await open(page);
		try {
			await askAlfy(page, scene.artifactId, [
				{ op: "move", id: "ghost", to: { x: 5, y: 5 } },
				{ op: "move", id: "phantom", to: { x: 9, y: 9 } },
			]);
			const notice = page.getByTestId("refusal-notice");
			await expect(notice).toContainText("Alfy skipped 2 changes.", {
				timeout: 30_000,
			});
			await expect(notice).toContainText("ghost");
			await expect(notice).toContainText(
				"nothing is at that position any more",
			);
			// Nothing changed, so nothing waits for the reader.
			await expect(bar(page)).toBeHidden();
			await expect(pill(page)).toBeHidden();
			expect((await versions(scene.artifactId)).length).toBe(1);
		} finally {
			await scene.cleanup();
		}
	});

	test("a highlight rings for a moment and asks for nothing to review: it writes no version", async ({
		page,
	}) => {
		const scene = await open(page);
		try {
			await askAlfy(page, scene.artifactId, [
				{ op: "highlight", ids: [MUSEUM, DINNER] },
			]);
			await expect(pulsing(page).first()).toBeVisible({ timeout: 30_000 });
			await expect(pulsing(page)).toHaveCount(2);
			await expect(pulsing(page)).toHaveCount(0, { timeout: 10_000 });
			await expect(rings(page)).toHaveCount(0);
			await expect(bar(page)).toBeHidden();
			await expect(pill(page)).toBeHidden();
			expect((await versions(scene.artifactId)).length).toBe(1);
			expect(await marker(scene.artifactId)).toBeUndefined();
		} finally {
			await scene.cleanup();
		}
	});
});

test("the toolbar's Ask Alfy waits while Alfy is arranging, and says why, then is back", async ({
	page,
}) => {
	const scene = await open(page);
	try {
		await askAlfy(page, scene.artifactId, PLANNED_SUNDAY);
		const ask = page.getByTestId("canvas-tool-ask");
		await expect(page.getByTestId("canvas-arranging")).toBeVisible({
			timeout: 20_000,
		});
		await expect(ask).toBeDisabled();
		await expect(ask).toHaveAttribute(
			"title",
			"Alfy is still arranging. Try again in a moment.",
		);
		await landed(page);
		await expect(page.getByTestId("canvas-arranging")).toBeHidden();
		await expect(ask).toBeEnabled();
	} finally {
		await scene.cleanup();
	}
});

test.describe("a change waits for the reader, once, however often the panel is built", () => {
	test("is not drawn a second time by a body built later, and survives a reload as the same one change", async ({
		page,
	}) => {
		const scene = await open(page);
		try {
			await askAlfy(page, scene.artifactId, PLANNED_SUNDAY);
			await landed(page);
			await expect(pulsing(page)).toHaveCount(0, { timeout: 10_000 });

			// Close the panel and open it again: a new body, handed the same settled call.
			await page.getByTestId("artifact-count-button").click();
			await expect(page.getByTestId("canvas-editor")).toBeHidden();
			await openCanvasPanel(page);
			await expect(pill(page)).toBeVisible({ timeout: 15_000 });
			await expect(bar(page)).toContainText("Alfy changed 3 blocks.");
			// Restored, not landed: no strong ring, nothing arranging, and no second count.
			await expect(pulsing(page)).toHaveCount(0);
			await expect(page.getByTestId("canvas-arranging")).toBeHidden();
			await expect(rings(page)).toHaveCount(3);

			// A reload: the same panel, the same one change, still no landing.
			await page.reload({ waitUntil: "networkidle" });
			await openCanvasPanel(page);
			await expect(pill(page)).toBeVisible({ timeout: 15_000 });
			await expect(bar(page)).toContainText("Alfy changed 3 blocks.");
			await expect(pulsing(page)).toHaveCount(0);
			await expect(rings(page)).toHaveCount(3);
			expect((await versions(scene.artifactId)).length).toBe(2);
		} finally {
			await scene.cleanup();
		}
	});

	test("lights the count button's dot while the panel is closed, and follows Keep and the reload", async ({
		page,
	}) => {
		const scene = await open(page);
		try {
			// The panel is closed while Alfy works: the change lands on the server only.
			await page.getByTestId("artifact-count-button").click();
			await expect(page.getByTestId("canvas-editor")).toBeHidden();
			await askAlfy(page, scene.artifactId, PLANNED_SUNDAY);
			await expect(page.getByText(AI_SMOKE_CANVAS_EDIT_FINAL_TEXT)).toBeVisible(
				{
					timeout: 30_000,
				},
			);
			const dot = page
				.getByTestId("artifact-count-button")
				.getByTestId("artifact-count-dot");
			await expect(dot).toBeVisible({ timeout: 15_000 });

			// Opened afterwards, it shows what waits, restored: no landing.
			await openCanvasPanel(page);
			await expect(pill(page)).toBeVisible({ timeout: 15_000 });
			await expect(pulsing(page)).toHaveCount(0);

			await keepAll(page).click();
			await expect(pill(page)).toBeHidden({ timeout: 5000 });
			await page.getByTestId("artifact-count-button").click();
			await expect(dot).toBeHidden();

			// The dot is the persisted state: still dark after a reload.
			await page.reload({ waitUntil: "networkidle" });
			await expect(
				page
					.getByTestId("artifact-count-button")
					.getByTestId("artifact-count-dot"),
			).toBeHidden();
		} finally {
			await scene.cleanup();
		}
	});
});

test.describe("Keep and Undo, for the whole change", () => {
	test("Keep moves the marker: nothing waits, in this session and after a reload", async ({
		page,
	}) => {
		const scene = await open(page);
		try {
			await askAlfy(page, scene.artifactId, PLANNED_SUNDAY);
			await landed(page);
			await keepAll(page).click();
			await expect(pill(page)).toContainText("Kept");
			await expect(bar(page)).toBeHidden();
			await expect(pill(page)).toBeHidden({ timeout: 5000 });
			await expect(rings(page)).toHaveCount(0);
			await expect
				.poll(async () => marker(scene.artifactId))
				.toEqual({ throughVersion: 2, keptBlockIds: [] });

			await page.reload({ waitUntil: "networkidle" });
			await openCanvasPanel(page);
			await expect(pill(page)).toBeHidden();
			await expect(bar(page)).toBeHidden();
			await expect(rings(page)).toHaveCount(0);
			// Keep is not an edit: no version was added.
			expect((await versions(scene.artifactId)).length).toBe(2);
		} finally {
			await scene.cleanup();
		}
	});

	test("Undo saves the board from before Alfy's change back as the reader's own version, and Redo puts it back", async ({
		page,
	}) => {
		const scene = await open(page);
		try {
			const museumBefore = await nodeBox(page, MUSEUM);
			await askAlfy(page, scene.artifactId, PLANNED_SUNDAY);
			await landed(page);
			await expect(pulsing(page)).toHaveCount(0, { timeout: 10_000 });
			const museumAfter = await nodeBox(page, MUSEUM);
			expect(museumAfter.x).toBeGreaterThan(museumBefore.x + 30);

			await undoAll(page).click();
			await expect(pill(page)).toContainText("Undone", { timeout: 10_000 });
			// What was taken back is not ringed any more (RV-3 Minor 11), though the pill stays for Redo.
			await expect(rings(page)).toHaveCount(0, { timeout: 1500 });
			await expect(
				page.locator('.svelte-flow__node[data-id="note-brunch"]'),
			).toHaveCount(0);
			// The museum glides back to where it was.
			await expect
				.poll(async () => (await nodeBox(page, MUSEUM)).x, { timeout: 5000 })
				.toBeCloseTo(museumBefore.x, 0);

			// A version of the reader's, named for what it is; the marker is past Alfy's.
			await expect
				.poll(async () => (await versions(scene.artifactId)).length)
				.toBe(3);
			const rows = await versions(scene.artifactId);
			expect(rows[2]).toMatchObject({
				author: "user",
				summary: "Undid Alfy's change",
			});
			const stored = await storedBoard(scene.artifactId);
			expect(stored.nodes.find((node) => node.id === MUSEUM)?.position).toEqual(
				MUSEUM_AT,
			);
			expect(stored.nodes.some((node) => node.id === "note-brunch")).toBe(
				false,
			);
			await expect
				.poll(async () => marker(scene.artifactId))
				.toEqual({ throughVersion: 2, keptBlockIds: [] });

			// Redo, within its window: Alfy's board is the reader's own edit now.
			await pill(page)
				.getByRole("button", { name: "Redo Alfy's change" })
				.click();
			await expect(
				page.locator('.svelte-flow__node[data-id="note-brunch"]'),
			).toBeVisible({ timeout: 10_000 });
			await expect
				.poll(async () => (await versions(scene.artifactId)).length)
				.toBe(4);
			const redone = await storedBoard(scene.artifactId);
			expect(redone.nodes.find((node) => node.id === MUSEUM)?.position).toEqual(
				{
					x: 470,
					y: 100,
				},
			);
		} finally {
			await scene.cleanup();
		}
	});

	// RV-3 I3: Redo wrote Alfy's board back as the reader's own version and then
	// said the change waited again, so the pill offered an Undo the server refused
	// (its last versions are the reader's), and the card counted a change the server
	// does not have. Redo is the reader taking Alfy's change back: it is Kept, the
	// count is the server's, and nothing is offered that would dead-end.
	test("Redo keeps Alfy's change: the count, the pill and the server say the same, and nothing is offered that would be refused", async ({
		page,
	}) => {
		const scene = await open(page);
		const serverCount = async () => {
			const response = await page.request.get(
				`/api/artifacts/${scene.artifactId}/review?conversationId=${scene.conversationId}`,
			);
			return ((await response.json()) as { review: { count: number } }).review
				.count;
		};
		const dot = page
			.getByTestId("artifact-count-button")
			.getByTestId("artifact-count-dot");
		try {
			await askAlfy(page, scene.artifactId, PLANNED_SUNDAY);
			await landed(page);
			expect(await serverCount()).toBeGreaterThan(0);

			await undoAll(page).click();
			await expect(pill(page)).toContainText("Undone", { timeout: 10_000 });
			expect(await serverCount()).toBe(0);

			await pill(page)
				.getByRole("button", { name: "Redo Alfy's change" })
				.click();
			await expect(
				page.locator('.svelte-flow__node[data-id="note-brunch"]'),
			).toBeVisible({ timeout: 10_000 });
			await expect
				.poll(async () => (await versions(scene.artifactId)).length)
				.toBe(4);
			// Kept, with nothing left to decide: no Keep or Undo on the pill or the bar.
			await expect(pill(page)).toContainText("Kept");
			await expect(pill(page).getByRole("button")).toHaveCount(0);
			await expect(bar(page)).toBeHidden();
			await expect(pill(page)).toBeHidden({ timeout: 5000 });
			await expect(page.getByTestId("refusal-notice")).toHaveCount(0);
			expect(await serverCount()).toBe(0);

			// What the panel tells the chat is the server's number: the dot is dark.
			await page.getByTestId("artifact-count-button").click();
			await expect(page.getByTestId("canvas-editor")).toBeHidden();
			await expect(dot).toBeHidden();
			await page.reload({ waitUntil: "networkidle" });
			await expect(dot).toBeHidden();
			expect(await serverCount()).toBe(0);
		} finally {
			await scene.cleanup();
		}
	});

	test("Undo is refused once the reader has changed the board: it writes nothing and points to the versions", async ({
		page,
	}) => {
		const scene = await open(page);
		try {
			await askAlfy(page, scene.artifactId, PLANNED_SUNDAY);
			await landed(page);
			await expect(pulsing(page)).toHaveCount(0, { timeout: 10_000 });

			// The reader moves a block Alfy did not touch, and it is saved.
			const from = await nodeBox(page, PLAN);
			await dragBetween(
				page,
				{ x: from.x + from.width / 2, y: from.y + from.height / 2 },
				{ x: from.x + from.width / 2 - 60, y: from.y + from.height / 2 + 30 },
			);
			await savedStatus(page);
			await expect
				.poll(async () => (await versions(scene.artifactId)).length)
				.toBe(3);
			const boardBefore = await storedBoard(scene.artifactId);

			await undoAll(page).click();
			const notice = page.getByTestId("refusal-notice");
			await expect(notice).toContainText(
				"can't be undone here because the board has changed since",
				{ timeout: 10_000 },
			);
			// Nothing was written, and the change still waits.
			expect((await versions(scene.artifactId)).length).toBe(3);
			expect(await storedBoard(scene.artifactId)).toEqual(boardBefore);
			await expect(bar(page)).toBeVisible();

			await notice.getByRole("button", { name: "Open Versions" }).click();
			await expect(page.getByTestId("versions-list")).toBeVisible();
		} finally {
			await scene.cleanup();
		}
	});

	test("the chord for Alfy's change is the Document's, and never the reader's own undo", async ({
		page,
	}) => {
		// The platform decides which modifier is the command key: pinned, so the chord
		// pressed here is the one the app reads on any machine this runs on.
		await page.addInitScript(() => {
			Object.defineProperty(Navigator.prototype, "platform", {
				get: () => "Linux x86_64",
			});
			Object.defineProperty(Navigator.prototype, "userAgentData", {
				get: () => ({ platform: "Linux" }),
			});
		});
		const scene = await open(page);
		try {
			await askAlfy(page, scene.artifactId, PLANNED_SUNDAY);
			await landed(page);
			await expect(pulsing(page)).toHaveCount(0, { timeout: 10_000 });
			// Focus is on the board (a control inside the editor), then the chord.
			await page.getByRole("button", { name: "Next change" }).focus();
			await page.keyboard.press("Control+Alt+z");
			await expect(pill(page)).toContainText("Undone", { timeout: 10_000 });
			await page.keyboard.press("Control+Alt+Shift+z");
			await expect(
				page.locator('.svelte-flow__node[data-id="note-brunch"]'),
			).toBeVisible({ timeout: 10_000 });
		} finally {
			await scene.cleanup();
		}
	});
});
