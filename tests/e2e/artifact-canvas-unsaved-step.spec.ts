import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
	createArtifact,
	updateArtifactBody,
} from "../../src/lib/server/services/artifacts";
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
	nodeBox,
	openCanvasPanel,
	openChatAndReload,
	storedBoard,
	testUserId,
	versionRows,
} from "./artifact-canvas-helpers";
import { setUiLanguage } from "./artifact-document-polish-helpers";
import {
	createTemporaryFakeProviderModel,
	deleteTemporaryProvider,
	snapshotUserModelPreference,
	updateUserModelPreference,
} from "./artifact-live-edit.helpers";
import { createConversation, login, sendMessage } from "./helpers";

// A step the reader has not saved yet, and Alfy's change to the same board (Feature
// 2 · Canvas, RV-3 I2). Alfy's version is written by the server while the reader's
// last step is still in the browser (typed a moment ago, or made while Alfy works),
// and the reader's save is then against a version the server is past. The step used
// to be refused as stale, the board said "someone changed it" and offered a Reload,
// and the Reload took the step away. Two things keep it now: the open board's
// pending step is saved before a chat turn starts, and a step that still meets a
// newer version is rebased onto it (the reader's words win where both changed the
// same thing, and the board says so).

const LUNCH = "note-lunch";
const MUSEUM = "note-museum";
const CAMERA = { x: 16, y: 16, zoom: 1 };

function note(id: string, x: number, y: number, text: string): CanvasNode {
	return {
		id,
		type: "sticky",
		position: { x, y },
		width: 180,
		data: { kind: "sticky", text, tone: "yellow" },
	};
}

function board(): CanvasBody {
	return {
		version: 1,
		nodes: [
			note(LUNCH, 24, 64, "Lunch at the market"),
			note(MUSEUM, 420, 40, "Museum, 14:00"),
		],
		edges: [],
		viewport: CAMERA,
		annotations: [],
	};
}

/** Alfy's change: a new note, and the museum moved. */
const ARRANGE = [
	{
		op: "add_node",
		node: {
			id: "note-booked",
			type: "sticky",
			position: { x: 420, y: 260 },
			data: { kind: "sticky", text: "Booked for 15:30", tone: "mint" },
		},
	},
	{ op: "move", id: MUSEUM, to: { x: 470, y: 120 } },
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
	await setUiLanguage("en");
});

type Scene = {
	conversationId: string;
	artifactId: string;
	cleanup: () => Promise<void>;
};

/** A board made through the service (its version's hash is real, which the edit tool's own write is checked against), a fake model to script it, the chat open on it. */
async function open(page: Page): Promise<Scene> {
	await login(page);
	const previousPreference = await snapshotUserModelPreference(page);
	const conversationId = await createConversation(page, "A board");
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
	await openCanvasPanel(page);
	return {
		conversationId,
		artifactId: created.artifact.id,
		cleanup: async () => {
			await updateUserModelPreference(page, previousPreference);
			await deleteTemporaryProvider(page, provider.providerId);
		},
	};
}

/** A board made through the service, and the chat open on it: no model, for the tests that write Alfy's version themselves. */
async function openBoardOnly(page: Page): Promise<Scene> {
	await login(page);
	const conversationId = await createConversation(page, "A board");
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
	await openChatAndReload(page, conversationId);
	await openCanvasPanel(page);
	return {
		conversationId,
		artifactId: created.artifact.id,
		cleanup: async () => {},
	};
}

/** Alfy's version of the board, written the way its tool writes one: a version of its own on top of the newest, from the board as it is stored. */
async function writeAlfyVersion(
	artifactId: string,
	change: (stored: CanvasBody) => CanvasBody,
) {
	const written = await updateArtifactBody({
		userId: await testUserId(),
		artifactId,
		body: boardJson(change(await storedBoard(artifactId))),
		author: "alfy",
		summary: "Alfy changed the board",
	});
	if (!written.ok) throw new Error(written.reason);
}

/** What the reader asks the chat: the fake model answers it with an `edit_artifact` call of exactly these ops. */
async function askAlfy(
	page: Page,
	artifactId: string,
	ops: unknown[],
	summary = "Arranged the board",
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

async function textOf(artifactId: string, id: string): Promise<string | null> {
	const node = (await storedBoard(artifactId)).nodes.find(
		(candidate) => candidate.id === id,
	);
	return node && "text" in node.data ? (node.data.text as string) : null;
}

/** Puts the focus back on the board itself, so a note that was being typed in shows its words again. */
async function leaveNote(page: Page) {
	await page
		.getByTestId("canvas-board")
		.click({ position: { x: 150, y: 560 } });
}

/** Edits a note's words the way a reader does, and leaves them typed (the focus is still in the note). */
async function typeIntoNote(page: Page, id: string, suffix: string) {
	const box = await nodeBox(page, id);
	await page.mouse.dblclick(box.x + 60, box.y + 30);
	await page.keyboard.press("End");
	await page.keyboard.type(suffix);
}

test.describe("a step the reader has not saved yet, and Alfy's change", () => {
	test("what the reader has just typed is saved before the turn is sent: Alfy's change lands on it, both are kept, and nothing says anything conflicted", async ({
		page,
	}) => {
		const scene = await open(page);
		try {
			// Typed, and then the reader asks Alfy at once: the step is still inside the
			// board's settle delay and the save's debounce.
			await typeIntoNote(page, LUNCH, " (two seats)");
			await askAlfy(page, scene.artifactId, ARRANGE);
			await landed(page);

			await expect(page.getByTestId("canvas-conflict")).toHaveCount(0);
			// The reader's words are in the saved board, and so is Alfy's change.
			expect(await textOf(scene.artifactId, LUNCH)).toBe(
				"Lunch at the market (two seats)",
			);
			const stored = await storedBoard(scene.artifactId);
			expect(stored.nodes.map((node) => node.id)).toContain("note-booked");
			expect(stored.nodes.find((node) => node.id === MUSEUM)?.position).toEqual(
				{ x: 470, y: 120 },
			);
			// The reader's step came first, as a version of their own; Alfy's is on top of it.
			expect(
				(await versionRows(scene.artifactId)).map((row) => row.author),
			).toEqual(["user", "user", "alfy"]);
			// And both are on the screen, the reader's words still in the note.
			await expect(
				page.getByText("Lunch at the market (two seats)"),
			).toBeVisible();
			await expect(page.getByText("Booked for 15:30")).toBeVisible();
		} finally {
			await scene.cleanup();
		}
	});
});

test.describe("a step that meets a newer version of the board", () => {
	test("is put on top of it instead of being refused: both are on the board and in the saved one, and nothing tells the reader to reload", async ({
		page,
	}) => {
		const scene = await openBoardOnly(page);
		await typeIntoNote(page, LUNCH, " (two seats)");
		await leaveNote(page);
		// Alfy's version is written while the step is still in the browser: the save
		// that follows is against a version the server is past.
		await writeAlfyVersion(scene.artifactId, (stored) => ({
			...stored,
			nodes: [
				...stored.nodes,
				note("note-booked", 420, 260, "Booked for 15:30"),
			],
		}));

		await expect(page.getByText("Booked for 15:30")).toBeVisible({
			timeout: 15_000,
		});
		await expect(
			page.getByText("Lunch at the market (two seats)"),
		).toBeVisible();
		await expect
			.poll(async () => (await versionRows(scene.artifactId)).at(-1)?.author, {
				timeout: 15_000,
			})
			.toBe("user");
		await expect(page.getByTestId("canvas-conflict")).toHaveCount(0);
		// Nothing the reader wrote was set aside, so there is nothing to say.
		await expect(page.getByTestId("canvas-rebased-notice")).toHaveCount(0);
		expect(await textOf(scene.artifactId, LUNCH)).toBe(
			"Lunch at the market (two seats)",
		);
		expect(
			(await storedBoard(scene.artifactId)).nodes.map((n) => n.id),
		).toContain("note-booked");
		// The reader's step is a version of their own, on top of Alfy's.
		expect(
			(await versionRows(scene.artifactId)).map((row) => row.author),
		).toEqual(["user", "alfy", "user"]);
		// And the board goes on saving what comes next.
		await typeIntoNote(page, MUSEUM, " (tickets)");
		await leaveNote(page);
		await expect
			.poll(async () => textOf(scene.artifactId, MUSEUM), { timeout: 15_000 })
			.toBe("Museum, 14:00 (tickets)");
		await expect(page.getByTestId("canvas-conflict")).toHaveCount(0);
	});

	test("keeps the reader's words where Alfy changed the same words, and says which block, once", async ({
		page,
	}) => {
		const scene = await openBoardOnly(page);
		await typeIntoNote(page, LUNCH, " (two seats)");
		await leaveNote(page);
		await writeAlfyVersion(scene.artifactId, (stored) => ({
			...stored,
			nodes: [
				...stored.nodes.map((node) =>
					node.id === LUNCH
						? { ...node, data: { ...node.data, text: "Lunch at noon" } }
						: node,
				),
				note("note-booked", 420, 260, "Booked for 15:30"),
			],
		}));

		await expect(page.getByText("Booked for 15:30")).toBeVisible({
			timeout: 15_000,
		});
		// The reader's version stands on the board and in the saved one; Alfy's is in History.
		await expect(
			page.getByText("Lunch at the market (two seats)"),
		).toBeVisible();
		await expect(page.getByText("Lunch at noon")).toHaveCount(0);
		const notice = page.getByTestId("canvas-rebased-notice");
		await expect(notice).toContainText(
			"Alfy changed 1 block you had also changed. Your version was kept.",
		);
		await expect(page.getByTestId("canvas-conflict")).toHaveCount(0);
		await expect
			.poll(async () => (await versionRows(scene.artifactId)).at(-1)?.author, {
				timeout: 15_000,
			})
			.toBe("user");
		expect(await textOf(scene.artifactId, LUNCH)).toBe(
			"Lunch at the market (two seats)",
		);
		await notice.getByRole("button", { name: "Dismiss" }).click();
		await expect(notice).toHaveCount(0);
	});
});

test.describe("the code that puts the two together", () => {
	test("is fetched with the first step, and when it is slow the newer version waits for it instead of being refused: both still end up on the board", async ({
		page,
	}) => {
		const scene = await openBoardOnly(page);
		let requested = 0;
		await page.route("**/canvas/rebase-board*", async (route) => {
			requested += 1;
			await new Promise((resolve) => setTimeout(resolve, 3_000));
			await route.continue();
		});
		await typeIntoNote(page, LUNCH, " (two seats)");
		await leaveNote(page);
		await writeAlfyVersion(scene.artifactId, (stored) => ({
			...stored,
			nodes: [
				...stored.nodes,
				note("note-booked", 420, 260, "Booked for 15:30"),
			],
		}));

		await expect(page.getByText("Booked for 15:30")).toBeVisible({
			timeout: 20_000,
		});
		await expect(
			page.getByText("Lunch at the market (two seats)"),
		).toBeVisible();
		await expect(page.getByTestId("canvas-conflict")).toHaveCount(0);
		await expect
			.poll(async () => (await versionRows(scene.artifactId)).at(-1)?.author, {
				timeout: 15_000,
			})
			.toBe("user");
		expect(await textOf(scene.artifactId, LUNCH)).toBe(
			"Lunch at the market (two seats)",
		);
		// One fetch, made with the first step, not one per change.
		expect(requested).toBe(1);
	});
});

test.describe("a save that is refused with nothing newer on the server", () => {
	test("is a race with the reader's own save: the step goes once more against the version the board has now, and lands, with nothing to reload", async ({
		page,
	}) => {
		const scene = await openBoardOnly(page);
		let refused = 0;
		await page.route("**/api/artifacts/*/body**", async (route) => {
			if (refused === 0 && route.request().method() !== "GET") {
				refused += 1;
				await route.fulfill({
					status: 409,
					contentType: "application/json",
					body: JSON.stringify({ ok: false, reason: "version_conflict" }),
				});
				return;
			}
			await route.continue();
		});
		await typeIntoNote(page, LUNCH, " (two seats)");
		await leaveNote(page);

		await expect
			.poll(async () => textOf(scene.artifactId, LUNCH), { timeout: 15_000 })
			.toBe("Lunch at the market (two seats)");
		expect(refused).toBe(1);
		await expect(page.getByTestId("canvas-conflict")).toHaveCount(0);
		await expect(page.getByTestId("canvas-save-status")).toHaveText(/Saved/);
	});
});

// Screenshots for the report, not part of the gates: run with FC_SHOTS=<dir>.
const SHOTS = process.env.FC_SHOTS;
test.describe("screenshots of a board after a send that raced an edit", () => {
	test.skip(
		!SHOTS,
		"set FC_SHOTS to a folder to write the report's screenshots",
	);

	test.afterAll(async () => {
		await setUiLanguage("en");
	});

	test("the board after the reader typed and asked at once, Hungarian, light, 1440x900", async ({
		page,
	}) => {
		await setUiLanguage("hu");
		await page.setViewportSize({ width: 1440, height: 900 });
		const scene = await open(page);
		try {
			await typeIntoNote(page, LUNCH, " (két főre)");
			await askAlfy(page, scene.artifactId, ARRANGE);
			await landed(page);
			await page.waitForTimeout(1_500);
			await page.screenshot({
				path: join(SHOTS as string, "1440-light-board-after-raced-send.png"),
			});
		} finally {
			await scene.cleanup();
		}
	});

	test("the board that kept the reader's words over Alfy's, with its notice, Hungarian, light, 1440x900", async ({
		page,
	}) => {
		await setUiLanguage("hu");
		await page.setViewportSize({ width: 1440, height: 900 });
		const scene = await openBoardOnly(page);
		await typeIntoNote(page, LUNCH, " (két főre)");
		await leaveNote(page);
		await writeAlfyVersion(scene.artifactId, (stored) => ({
			...stored,
			nodes: [
				...stored.nodes.map((node) =>
					node.id === LUNCH
						? { ...node, data: { ...node.data, text: "Ebéd délben" } }
						: node,
				),
				note("note-booked", 420, 260, "Lefoglalva 15:30-ra"),
			],
		}));
		await expect(page.getByTestId("canvas-rebased-notice")).toBeVisible({
			timeout: 15_000,
		});
		await page.waitForTimeout(1_500);
		await page.screenshot({
			path: join(SHOTS as string, "1440-light-board-kept-notice.png"),
		});
	});

	test("the same notice on a phone, Hungarian, 390x844", async ({ page }) => {
		await setUiLanguage("hu");
		await page.setViewportSize({ width: 390, height: 844 });
		const scene = await openBoardOnly(page);
		await typeIntoNote(page, LUNCH, " (két főre)");
		await leaveNote(page);
		await writeAlfyVersion(scene.artifactId, (stored) => ({
			...stored,
			nodes: [
				...stored.nodes.map((node) =>
					node.id === LUNCH
						? { ...node, data: { ...node.data, text: "Ebéd délben" } }
						: node,
				),
				note("note-booked", 420, 260, "Lefoglalva 15:30-ra"),
			],
		}));
		await expect(page.getByTestId("canvas-rebased-notice")).toBeVisible({
			timeout: 15_000,
		});
		await page.waitForTimeout(1_500);
		await page.screenshot({
			path: join(SHOTS as string, "390-light-board-kept-notice.png"),
		});
	});
});
