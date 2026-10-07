import { expect, type Page, test } from "@playwright/test";
import {
	bareSpot,
	CHAT_DIAGRAM,
	centre,
	click,
	drag,
	idOfKind,
	insertFromMenu,
	nodeOf,
	openTheBoard,
	seedChat,
	wrapperOf,
} from "./artifact-canvas-edit-helpers";
import { storedBoard } from "./artifact-canvas-helpers";
import { setUiLanguage } from "./artifact-document-polish-helpers";
import { login } from "./helpers";

// Everything a reader inserts on a board can be changed afterwards (Feature 2 ·
// Canvas, CV-B). The owner: "I can't edit pieces that were already added, in any
// way or shape. This goes for all Insert options." Every block here is put on the
// board through the real Insert menu and changed with the pointer and the keyboard
// only (never a component's callback, never state set through the page): a note and
// a text block by their Edit button and by a double-click anywhere on them, a frame
// renamed and deleted by its toolbar, a chart's and a diagram's source edited in
// place (validated, one step of the board's own undo), and the title of every block
// that has one.

const EDIT = "canvas-node-edit";
const FORM = "canvas-edit-form";

/** Selects a block by pressing on a spot of it that is not a control, then waits for its toolbar. */
async function select(
	page: Page,
	id: string,
	spot: "head" | "middle" = "head",
) {
	await click(page, "mouse", await bareSpot(page));
	const node = nodeOf(page, id);
	const head = node.locator(".canvas-node__head").first();
	const at =
		spot === "head" && (await head.count())
			? centre((await head.boundingBox()) as never)
			: centre((await wrapperOf(page, id).boundingBox()) as never);
	await click(page, "mouse", at);
	await expect(node).toHaveAttribute("data-selected", "true");
	await expect(page.getByTestId("canvas-node-toolbar")).toBeVisible();
}

/** Presses the toolbar's Edit button with a real click on its centre. */
async function pressEdit(page: Page) {
	const edit = page.getByTestId(EDIT);
	await expect(edit).toBeVisible();
	await click(page, "mouse", centre((await edit.boundingBox()) as never));
}

/** Replaces what a field holds by typing over it: select all, then insert the text. */
async function typeOver(
	page: Page,
	field: ReturnType<Page["getByTestId"]>,
	text: string,
) {
	await field.click();
	await page.keyboard.press("ControlOrMeta+a");
	await page.keyboard.insertText(text);
}

async function storedData(boardId: string, id: string) {
	return (await storedBoard(boardId)).nodes.find((node) => node.id === id)
		?.data as Record<string, unknown> | undefined;
}

test.describe("everything inserted can be changed afterwards", () => {
	test.beforeEach(async ({ page }) => {
		await setUiLanguage("en");
		await page.setViewportSize({ width: 1440, height: 900 });
		await login(page);
	});

	for (const [label, row, kind, placeholder] of [
		["sticky note", /^Sticky note/, "sticky", "First note"],
		["text block", /^Text$/, "text", "First text"],
	] as const) {
		test(`a ${label}: its Edit button, and a double-click anywhere on it once the reader made it taller`, async ({
			page,
		}) => {
			const { conversationId, boardId } = await seedChat(page);
			await openTheBoard(page, conversationId);
			await insertFromMenu(page, row);
			await page.keyboard.type(placeholder);
			await page.keyboard.press("Escape");
			const id = await idOfKind(page, kind);

			// Taller than its words: the bottom right corner pulled down.
			await select(page, id, "middle");
			const corner = wrapperOf(page, id).locator(
				".svelte-flow__resize-control.bottom.right",
			);
			const grip = centre((await corner.boundingBox()) as never);
			await drag(page, "mouse", grip, { x: grip.x, y: grip.y + 120 });
			const grown = (await wrapperOf(page, id).boundingBox()) as {
				x: number;
				y: number;
				width: number;
				height: number;
			};
			expect(grown.height).toBeGreaterThan(110);

			// A double-click low on the block, well below its one line of words.
			await click(page, "mouse", await bareSpot(page));
			await click(
				page,
				"mouse",
				{ x: grown.x + grown.width / 2, y: grown.y + grown.height * 0.85 },
				2,
			);
			const field = page.locator("textarea.text-field__input");
			await expect(field).toBeVisible();
			await page.keyboard.type(" and more");
			await page.keyboard.press("Escape");
			await expect
				.poll(async () => (await storedData(boardId, id))?.text)
				.toBe(`${placeholder} and more`);

			// The same block, through its toolbar.
			await click(page, "mouse", await bareSpot(page));
			await select(page, id, "middle");
			await pressEdit(page);
			await expect(field).toBeVisible();
			await page.keyboard.type("!");
			await page.keyboard.press("Escape");
			await expect
				.poll(async () => (await storedData(boardId, id))?.text)
				.toBe(`${placeholder} and more!`);
		});
	}

	test("a frame: its Edit button renames it, its toolbar deletes it, and Undo brings it back", async ({
		page,
	}) => {
		const { conversationId, boardId } = await seedChat(page);
		await openTheBoard(page, conversationId);
		await insertFromMenu(page, /^Frame$/);
		await page.keyboard.type("Plans");
		await page.keyboard.press("Enter");
		const id = await idOfKind(page, "frame");
		await expect
			.poll(async () => (await storedData(boardId, id))?.label)
			.toBe("Plans");

		await click(page, "mouse", await bareSpot(page));
		const chip = nodeOf(page, id).locator(".canvas-node__chip");
		await click(page, "mouse", centre((await chip.boundingBox()) as never));
		await expect(nodeOf(page, id)).toHaveAttribute("data-selected", "true");
		await pressEdit(page);
		const name = nodeOf(page, id).locator(".chip__input");
		await expect(name).toBeFocused();
		await page.keyboard.press("ControlOrMeta+a");
		await page.keyboard.type("Weekend");
		await page.keyboard.press("Enter");
		await expect
			.poll(async () => (await storedData(boardId, id))?.label)
			.toBe("Weekend");

		// The toolbar's Delete is pressed where it is drawn.
		await click(page, "mouse", await bareSpot(page));
		await click(page, "mouse", centre((await chip.boundingBox()) as never));
		const del = page.getByTestId("canvas-node-delete");
		await expect(del).toBeVisible();
		await click(page, "mouse", centre((await del.boundingBox()) as never));
		await expect(wrapperOf(page, id)).toHaveCount(0);
		await page.keyboard.press("ControlOrMeta+z");
		await expect(wrapperOf(page, id)).toHaveCount(1);
	});

	test("a chart from Insert: its data, type and title are editable in place, checked, and one step of undo", async ({
		page,
	}) => {
		const { conversationId, boardId } = await seedChat(page);
		await openTheBoard(page, conversationId);
		await insertFromMenu(page, /^Chart$/);
		const id = await idOfKind(page, "chart");
		const before = await storedData(boardId, id);
		await select(page, id);
		await pressEdit(page);

		const form = page.getByTestId(FORM);
		await expect(form).toBeVisible();
		const source = form.getByTestId("canvas-edit-source");
		const title = form.getByTestId("canvas-edit-title");
		const save = form.getByTestId("canvas-edit-save");
		await expect(source).toHaveValue(/"type":\s*"bar"/);

		// Source that is not a chart is said so, and cannot be saved.
		await typeOver(page, source, "{ not a chart");
		await expect(form.getByTestId("canvas-edit-error")).toBeVisible();
		await expect(save).toBeDisabled();

		const line = {
			type: "line",
			data: {
				labels: ["Mon", "Tue", "Wed"],
				datasets: [{ label: "Visits", data: [3, 5, 4] }],
			},
		};
		await typeOver(page, source, JSON.stringify(line));
		await expect(form.getByTestId("canvas-edit-error")).toHaveCount(0);
		await typeOver(page, title, "Visits per day");
		await click(page, "mouse", centre((await save.boundingBox()) as never));
		await expect(form).toHaveCount(0);
		await expect(nodeOf(page, id).locator(".canvas-node__title")).toHaveText(
			"Visits per day",
		);
		await expect
			.poll(
				async () =>
					JSON.parse(String((await storedData(boardId, id))?.code)).type,
			)
			.toBe("line");
		expect((await storedData(boardId, id))?.label).toBe("Visits per day");

		// One press of Undo takes the whole edit back.
		await page.keyboard.press("ControlOrMeta+z");
		await expect(nodeOf(page, id).locator(".canvas-node__title")).toHaveText(
			"Chart",
		);
		await expect
			.poll(async () => (await storedData(boardId, id))?.code)
			.toBe(before?.code);
		expect((await storedData(boardId, id))?.label).toBeUndefined();

		// Cancel leaves the block as it is.
		await select(page, id);
		await pressEdit(page);
		await typeOver(page, form.getByTestId("canvas-edit-source"), "{}");
		await click(
			page,
			"mouse",
			centre(
				(await form.getByTestId("canvas-edit-cancel").boundingBox()) as never,
			),
		);
		await expect(form).toHaveCount(0);
		expect((await storedData(boardId, id))?.code).toBe(before?.code);
	});

	test("a chart the chat drew: the board holds the chat's source, and it can be changed", async ({
		page,
	}) => {
		const { conversationId, boardId } = await seedChat(page);
		await openTheBoard(page, conversationId);
		await insertFromMenu(page, /Sales by fruit/);
		const id = await idOfKind(page, "chart");
		await select(page, id);
		await pressEdit(page);
		const form = page.getByTestId(FORM);
		const source = form.getByTestId("canvas-edit-source");
		await expect(source).toHaveValue(/Apples/);
		const edited = String(await source.inputValue()).replace("Apples", "Plums");
		await typeOver(page, source, edited);
		await click(
			page,
			"mouse",
			centre(
				(await form.getByTestId("canvas-edit-save").boundingBox()) as never,
			),
		);
		await expect(form).toHaveCount(0);
		await expect
			.poll(async () => String((await storedData(boardId, id))?.code))
			.toContain("Plums");
	});

	test("a diagram the chat drew: its Mermaid source is editable in place, and Undo restores it", async ({
		page,
	}) => {
		const { conversationId, boardId } = await seedChat(page);
		await openTheBoard(page, conversationId);
		await insertFromMenu(page, /Flowchart/);
		const id = await idOfKind(page, "mermaid");
		const drawing = nodeOf(page, id).getByTestId("canvas-mermaid");
		await expect(drawing).toContainText("Start", { timeout: 15_000 });
		await select(page, id);
		await pressEdit(page);
		const form = page.getByTestId(FORM);
		const source = form.getByTestId("canvas-edit-source");
		await expect(source).toHaveValue(CHAT_DIAGRAM);
		await typeOver(page, source, CHAT_DIAGRAM.replace("Start", "Begin"));
		await click(
			page,
			"mouse",
			centre(
				(await form.getByTestId("canvas-edit-save").boundingBox()) as never,
			),
		);
		await expect(form).toHaveCount(0);
		await expect(drawing).toContainText("Begin", { timeout: 15_000 });
		await expect
			.poll(async () => String((await storedData(boardId, id))?.code))
			.toContain("Begin");

		await page.keyboard.press("ControlOrMeta+z");
		await expect(drawing).toContainText("Start", { timeout: 15_000 });
		await expect
			.poll(async () => String((await storedData(boardId, id))?.code))
			.toContain("Start");
	});

	for (const [label, row, kind, field] of [
		["checklist", /^Checklist$/, "checklist", "label"],
		["map", /Cork/, "map", "label"],
		["App", /Tip calculator/, "app", "title"],
		["photos", /sunset/, "photo", "label"],
	] as const) {
		test(`a ${label} block: its title can be changed, and Undo takes it back`, async ({
			page,
		}) => {
			const { conversationId, boardId } = await seedChat(page);
			await openTheBoard(page, conversationId);
			await insertFromMenu(page, row);
			const id = await idOfKind(page, kind);
			const before = (await storedData(boardId, id))?.[field];
			await select(page, id);
			await pressEdit(page);
			const form = page.getByTestId(FORM);
			await expect(form).toBeVisible();
			// A block with nothing but a title to change has no source field.
			await expect(form.getByTestId("canvas-edit-source")).toHaveCount(0);
			await typeOver(
				page,
				form.getByTestId("canvas-edit-title"),
				"Weekend plan",
			);
			await click(
				page,
				"mouse",
				centre(
					(await form.getByTestId("canvas-edit-save").boundingBox()) as never,
				),
			);
			await expect(form).toHaveCount(0);
			await expect(nodeOf(page, id).locator(".canvas-node__title")).toHaveText(
				"Weekend plan",
			);
			await expect
				.poll(async () => (await storedData(boardId, id))?.[field])
				.toBe("Weekend plan");

			await page.keyboard.press("ControlOrMeta+z");
			await expect
				.poll(async () => (await storedData(boardId, id))?.[field])
				.toBe(before);
		});
	}

	test("a live web block keeps its Refresh and has no Edit button: the query is what it is about", async ({
		page,
	}) => {
		const { conversationId } = await seedChat(page);
		await openTheBoard(page, conversationId);
		await insertFromMenu(page, /cork weather/);
		const web = await idOfKind(page, "liveweb");
		await select(page, web);
		await expect(page.getByTestId("canvas-node-delete")).toBeVisible();
		await expect(page.getByTestId(EDIT)).toHaveCount(0);
		await expect(
			nodeOf(page, web).getByRole("button", { name: /Refresh/ }),
		).toBeVisible();
	});
});
