import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { db } from "../../src/lib/server/db";
import { messages } from "../../src/lib/server/db/schema";
import { emptyCanvasBody } from "../../src/lib/shared/artifacts/canvas-body";
import {
	nodeCount,
	openCanvasPanel,
	openChatAndReload,
	savedStatus,
	seedCanvas,
	storedBoard,
} from "./artifact-canvas-helpers";
import { setUiLanguage } from "./artifact-document-polish-helpers";
import { createConversation, login, waitForStableBoundingBox } from "./helpers";

// Every chart and diagram the chat draws is drawn on a board too (the owner's walk
// on ai.dev: "all other chart types that would load in chat do not load inside the
// canvases"). One case per kind the chat can make: a reply drew it, the Insert
// menu's "From this chat" offered it, a pick put it on the board, and the board
// drew it, before and after a reload. "Drew" is the thing's own rendered state, not
// the presence of an element: a chart that failed still leaves a blank <canvas>, a
// diagram that failed still leaves its source in a <pre>. The same check is made on
// the chat's own copy first, so what the board is held to is what the chat does.
//
// Four families, because the chat has four ways to make a visual:
//   1. a ```chart fence: Chart.js, every type the chat accepts;
//   2. what the production model really writes in one (no colours, Chart.js 2's
//      `options.title`, a tooltip callback as a string);
//   3. a chart the chat rescues from text art (a bar-column table, an ASCII fence);
//   4. a ```mermaid fence: flowchart, sequence, class, state, ER, Gantt, pie.

type ChartCase = {
	reply: string;
	/** The row's name: the chart's own title, else its type. */
	name: string;
	/** What the stored chart code must read back as, when the fence is JSON. */
	config?: Record<string, unknown>;
	/** Colours the chart must have painted; each must be on the canvas. */
	colors: string[];
};

const RED = "#e74c3c";
const BLUE = "#3498db";
const GREEN = "#2ecc71";
const PURPLE = "#8e44ad";
const ORANGE = "#e67e22";
const TEAL = "#16a085";
const NAVY = "#2980b9";
// The first two colours Chart.js's own colours plugin gives datasets and slices
// that name none (it is part of `chart.js/auto`, which the chat loads).
const PALETTE_BLUE = "#36a2eb";
const PALETTE_PINK = "#ff6384";

const LABELS = ["Apples", "Pears", "Plums"];

function titled(text: string) {
	return { plugins: { title: { display: true, text } } };
}

function fence(language: string, body: string): string {
	return `Here it is.\n\n\`\`\`${language}\n${body}\n\`\`\`\n`;
}

function chartReply(config: Record<string, unknown>): string {
	return fence("chart", JSON.stringify(config));
}

function chartCase(
	name: string,
	config: Record<string, unknown>,
	colors: string[],
): ChartCase {
	return { name, reply: chartReply(config), config, colors };
}

/** Chart.js's chart types, each with colours of its own so the pixels say which was drawn. */
const CHART_TYPES: Record<string, ChartCase> = {
	bar: chartCase(
		"Bar: sales by fruit",
		{
			type: "bar",
			data: {
				labels: LABELS,
				datasets: [
					{ label: "Sales", data: [30, 20, 40], backgroundColor: RED },
				],
			},
			options: titled("Bar: sales by fruit"),
		},
		[RED],
	),
	line: chartCase(
		"Line: sales by month",
		{
			type: "line",
			data: {
				labels: LABELS,
				datasets: [
					{
						label: "Sales",
						data: [30, 20, 40],
						borderColor: BLUE,
						backgroundColor: BLUE,
						borderWidth: 4,
						pointRadius: 6,
					},
				],
			},
			options: titled("Line: sales by month"),
		},
		[BLUE],
	),
	pie: chartCase(
		"Pie: share by fruit",
		{
			type: "pie",
			data: {
				labels: LABELS,
				datasets: [{ data: [30, 20, 50], backgroundColor: [RED, BLUE, GREEN] }],
			},
			options: titled("Pie: share by fruit"),
		},
		[RED, BLUE, GREEN],
	),
	doughnut: chartCase(
		"Doughnut: share by fruit",
		{
			type: "doughnut",
			data: {
				labels: LABELS,
				datasets: [{ data: [30, 20, 50], backgroundColor: [RED, BLUE, GREEN] }],
			},
			options: titled("Doughnut: share by fruit"),
		},
		[RED, BLUE, GREEN],
	),
	radar: chartCase(
		"Radar: skills",
		{
			type: "radar",
			data: {
				labels: ["Speed", "Power", "Range", "Grip", "Focus"],
				datasets: [
					{
						label: "Skills",
						data: [4, 3, 5, 2, 4],
						borderColor: PURPLE,
						backgroundColor: "rgba(142, 68, 173, 0.3)",
						borderWidth: 4,
						pointBackgroundColor: PURPLE,
						pointRadius: 5,
					},
				],
			},
			options: titled("Radar: skills"),
		},
		[PURPLE],
	),
	polarArea: chartCase(
		"Polar area: share by fruit",
		{
			type: "polarArea",
			data: {
				labels: LABELS,
				datasets: [{ data: [30, 20, 50], backgroundColor: [RED, BLUE, GREEN] }],
			},
			options: titled("Polar area: share by fruit"),
		},
		[RED, BLUE, GREEN],
	),
	scatter: chartCase(
		"Scatter: height and weight",
		{
			type: "scatter",
			data: {
				datasets: [
					{
						label: "People",
						data: [
							{ x: 1, y: 2 },
							{ x: 2, y: 4 },
							{ x: 3, y: 3 },
							{ x: 4, y: 6 },
						],
						backgroundColor: ORANGE,
						pointRadius: 9,
					},
				],
			},
			options: titled("Scatter: height and weight"),
		},
		[ORANGE],
	),
	bubble: chartCase(
		"Bubble: market size",
		{
			type: "bubble",
			data: {
				datasets: [
					{
						label: "Markets",
						data: [
							{ x: 1, y: 2, r: 14 },
							{ x: 3, y: 5, r: 20 },
							{ x: 5, y: 3, r: 10 },
						],
						backgroundColor: TEAL,
					},
				],
			},
			options: titled("Bubble: market size"),
		},
		[TEAL],
	),
	mixed: chartCase(
		"Mixed: bars and a trend",
		{
			type: "bar",
			data: {
				labels: LABELS,
				datasets: [
					{ label: "Sales", data: [30, 20, 40], backgroundColor: RED },
					{
						type: "line",
						label: "Trend",
						data: [25, 28, 35],
						borderColor: NAVY,
						backgroundColor: NAVY,
						borderWidth: 4,
						pointRadius: 6,
					},
				],
			},
			options: titled("Mixed: bars and a trend"),
		},
		[RED, NAVY],
	),
};

/**
 * Charts as the production model writes them (a live run of `qwen3-6-27b` on the
 * chat's own chart instructions, 2026-10-01): pretty-printed, no colours (the
 * chat's colours plugin gives them), Chart.js 2's `options.title` (ignored by
 * Chart.js 4), and, in one, a tooltip callback written out as a string.
 */
const MODEL_WRITTEN: Record<string, ChartCase> = {
	"a pie chart with no colours": {
		name: "Pie chart",
		reply: fence(
			"chart",
			`{
  "type": "pie",
  "data": {
    "labels": ["Samsung", "Apple", "Xiaomi", "Others"],
    "datasets": [{ "label": "Market Share", "data": [20, 24, 13, 43] }]
  }
}`,
		),
		colors: [PALETTE_BLUE, PALETTE_PINK],
	},
	"a bar chart with a version 2 title": {
		name: "Bar chart",
		reply: fence(
			"chart",
			`{"type":"bar","data":{"labels":["Jan 2026","Feb 2026","Mar 2026"],"datasets":[{"label":"Revenue (k)","data":[12,15,18]}]},"options":{"title":{"display":true,"text":"Monthly Revenue Q1 2026"}}}`,
		),
		colors: [PALETTE_BLUE],
	},
	"a bubble chart whose tooltip callback is a string": {
		name: "Bubble chart",
		reply: fence(
			"chart",
			`{
  "type": "bubble",
  "data": {
    "datasets": [
      { "label": "United States", "data": [{"x": 25.46, "y": 334.9, "r": 12}],
        "backgroundColor": "rgba(54, 162, 235, 0.6)", "borderColor": "rgba(54, 162, 235, 1)", "borderWidth": 1 },
      { "label": "China", "data": [{"x": 17.73, "y": 1425.7, "r": 14}],
        "backgroundColor": "rgba(255, 99, 132, 0.6)", "borderColor": "rgba(255, 99, 132, 1)", "borderWidth": 1 }
    ]
  },
  "options": {
    "scales": { "x": { "title": {"display": true, "text": "GDP (Trillion USD)"} } },
    "plugins": { "tooltip": { "callbacks": { "label": "function(context) { return context.dataset.label; }" } } }
  }
}`,
		),
		colors: [PALETTE_BLUE, PALETTE_PINK],
	},
	"a line chart with a filled area": {
		name: "Line chart",
		reply: fence(
			"chart",
			`{
  "type": "line",
  "data": {
    "labels": ["Oct", "Nov", "Dec", "Jan", "Feb", "Mar"],
    "datasets": [{
      "label": "Average temperature",
      "data": [11.5, 6.2, 1.8, -0.5, 1.2, 7.4],
      "borderColor": "rgb(75, 192, 192)",
      "backgroundColor": "rgba(75, 192, 192, 0.2)",
      "fill": true,
      "tension": 0.1
    }]
  },
  "options": { "scales": { "y": { "beginAtZero": false } } }
}`,
		),
		colors: ["#4bc0c0"],
	},
};

/**
 * The local model's classic defect: JSON one closing brace short. The chat reads it
 * the way `parseJsonLenient` does and draws the chart, so the board has to read it
 * the same way: the plot's box (a pie is square) comes from the same reading.
 */
const ONE_BRACE_SHORT = {
	name: "Pie: one brace short",
	reply: fence(
		"chart",
		'{"type":"pie","data":{"labels":["A","B","C"],"datasets":[{"data":[30,20,50],"backgroundColor":["#e74c3c","#3498db","#2ecc71"]}]},"options":{"plugins":{"title":{"display":true,"text":"Pie: one brace short"}}}',
	),
	colors: [RED, BLUE, GREEN],
};

/** The chat turns text art into a chart; the board holds the chart it made. */
const RESCUED: Record<string, ChartCase> = {
	"a chart rescued from a bar-column table": {
		name: "Bar chart",
		reply: [
			"| Brand | Price | Scale |",
			"|---|---:|---|",
			"| Riverstone | €20 | `██████████` |",
			"| Cutters Choice | €22 | `███████████` |",
			"| Golden Virginia | €24 | `████████████` |",
		].join("\n"),
		colors: [PALETTE_BLUE],
	},
	"a chart rescued from an ASCII fence": {
		name: "Bar chart",
		reply: [
			"Prices:",
			"",
			"```",
			"Riverstone       ████████████████████░░░░░░░  €24.25",
			"Cutters Choice   █████████████████████░░░░░░  €25.75",
			"Golden Virginia  ███████████████████████░░░░  €27.00",
			"```",
		].join("\n"),
		colors: [PALETTE_BLUE],
	},
};

type DiagramCase = {
	/** The row's name in "From this chat": the diagram's own title, else its type. */
	name: string;
	/** The same row's name in Hungarian (the report's screenshots are taken there). */
	huName: string;
	source: string;
	/** Words in the source that the drawn diagram must carry. */
	words: string[];
};

/** Mermaid, which the chat draws from a ```mermaid fence. The first four are what its instructions teach. */
const DIAGRAMS: Record<string, DiagramCase> = {
	flowchart: {
		name: "Flowchart",
		huName: "Folyamatábra",
		source: [
			"flowchart TD",
			"    Start([Start]) --> Check{Input valid?}",
			"    Check -- No --> Fix[Show the error]",
			"    Check -- Yes --> Done([Done])",
		].join("\n"),
		words: ["Input valid?", "Show the error"],
	},
	sequence: {
		name: "Sequence diagram",
		huName: "Szekvenciadiagram",
		source: [
			"sequenceDiagram",
			"    participant User",
			"    participant Shop",
			"    User->>Shop: Checkout",
			"    Shop-->>User: Order confirmed",
		].join("\n"),
		words: ["Checkout", "Order confirmed"],
	},
	class: {
		name: "Class diagram",
		huName: "Osztálydiagram",
		source: [
			"classDiagram",
			"    class Library {",
			"        +String name",
			"        +addBook(Book)",
			"    }",
			"    class Book {",
			"        +String title",
			"    }",
			'    Library "1" --> "*" Book : manages',
		].join("\n"),
		words: ["Library", "addBook"],
	},
	state: {
		name: "State diagram",
		huName: "Állapotdiagram",
		source: [
			"stateDiagram-v2",
			"    [*] --> Pending",
			"    Pending --> Shipped: Dispatched",
			"    Shipped --> [*]",
		].join("\n"),
		words: ["Pending", "Dispatched"],
	},
	"entity relationship": {
		name: "ER diagram",
		huName: "ER-diagram",
		source: ["erDiagram", "    CUSTOMER ||--o{ ORDER : places"].join("\n"),
		words: ["CUSTOMER", "places"],
	},
	gantt: {
		name: "Release plan",
		huName: "Release plan",
		source: [
			"gantt",
			"    title Release plan",
			"    dateFormat YYYY-MM-DD",
			"    section Build",
			"    Write code :a1, 2026-01-01, 10d",
			"    Test :after a1, 5d",
		].join("\n"),
		words: ["Release plan", "Write code"],
	},
	pie: {
		name: "Pets adopted",
		huName: "Pets adopted",
		source: [
			"pie title Pets adopted",
			'    "Dogs" : 386',
			'    "Cats" : 85',
		].join("\n"),
		words: ["Pets adopted", "Dogs"],
	},
};

let sequence = 500;

/** A chat whose replies are these, oldest first, and an empty board beside them. */
async function seedChat(
	page: Page,
	replies: string[],
): Promise<{ conversationId: string; boardId: string }> {
	const conversationId = await createConversation(page, "Chart board");
	for (const reply of replies) {
		sequence += 1;
		await db.insert(messages).values({
			id: randomUUID(),
			conversationId,
			messageSequence: sequence,
			role: "assistant",
			content: reply,
			createdAt: new Date(Date.now() + sequence),
		});
	}
	const boardId = await seedCanvas(conversationId, emptyCanvasBody(), "Board");
	return { conversationId, boardId };
}

/**
 * How many pixels of each wanted colour a canvas shows. A chart that drew nothing
 * (or drew and failed) shows none, whatever its element looks like. A translucent
 * fill keeps its colour in its pixels (the canvas stores straight colour and
 * alpha), so a pixel is counted from half opacity up.
 */
async function paintedPixels(
	canvas: Locator,
	colors: string[],
): Promise<number[]> {
	return canvas.evaluate((element, wanted) => {
		const target = element as HTMLCanvasElement;
		const context = target.getContext("2d");
		if (!context || target.width === 0 || target.height === 0) {
			return wanted.map(() => 0);
		}
		const { data } = context.getImageData(0, 0, target.width, target.height);
		const rgb = wanted.map((hex) => [
			Number.parseInt(hex.slice(1, 3), 16),
			Number.parseInt(hex.slice(3, 5), 16),
			Number.parseInt(hex.slice(5, 7), 16),
		]);
		const counts = wanted.map(() => 0);
		for (let offset = 0; offset < data.length; offset += 4) {
			if (data[offset + 3] < 100) continue;
			for (let index = 0; index < rgb.length; index += 1) {
				const [r, g, b] = rgb[index];
				if (
					Math.abs(data[offset] - r) <= 6 &&
					Math.abs(data[offset + 1] - g) <= 6 &&
					Math.abs(data[offset + 2] - b) <= 6
				) {
					counts[index] += 1;
				}
			}
		}
		return counts;
	}, colors);
}

/** Every colour the chart asked for is on the canvas, in more than a stray pixel or two. */
async function expectPainted(canvas: Locator, colors: string[]) {
	await expect
		.poll(
			async () => (await paintedPixels(canvas, colors)).map((n) => n >= 40),
			{ timeout: 20_000, message: "the chart's own colours on its canvas" },
		)
		.toEqual(colors.map(() => true));
}

const insertButton = (page: Page) => page.getByTestId("canvas-insert-button");
const menu = (page: Page) => page.getByTestId("canvas-insert-menu-list");

/** Opens "From this chat", waits for it to have read the chat, and picks the first row of a group. */
async function pickFromChat(
	page: Page,
	group: string,
	name: string | RegExp,
	reading = "Looking through this chat…",
) {
	await insertButton(page).click();
	await expect(menu(page)).toBeVisible();
	await expect(menu(page).getByText(reading)).toHaveCount(0);
	await menu(page)
		.getByRole("group", { name: group })
		.getByRole("menuitem", { name })
		.first()
		.click();
	await expect(menu(page)).toHaveCount(0);
}

const chartNodes = (page: Page) =>
	page.locator('[data-testid="canvas-node"][data-kind="chart"]');

/** A chart reply: drawn in the chat, offered, picked, drawn on the board, saved, and drawn again after a reload. */
async function expectChartOnBoard(page: Page, chart: ChartCase) {
	const seeded = await seedChat(page, [chart.reply]);
	await openChatAndReload(page, seeded.conversationId);

	// The chat draws it: the bar the board is held to.
	await expectPainted(
		page.locator(".markdown-chart canvas").first(),
		chart.colors,
	);

	await openCanvasPanel(page);
	await pickFromChat(page, "Charts", chart.name);
	await expect(chartNodes(page)).toHaveCount(1);
	const plot = page.getByTestId("canvas-chart");
	await expect(plot.locator(".markdown-diagram-error")).toHaveCount(0);
	await expectPainted(plot.locator("canvas"), chart.colors);

	await savedStatus(page);
	const stored = await storedBoard(seeded.boardId);
	expect(stored.nodes.map((node) => node.type)).toEqual(["chart"]);
	if (chart.config) {
		expect(JSON.parse((stored.nodes[0].data as { code: string }).code)).toEqual(
			chart.config,
		);
	}

	await page.reload({ waitUntil: "networkidle" });
	await openCanvasPanel(page);
	expect(await nodeCount(page)).toBe(1);
	await expect(
		page.getByTestId("canvas-chart").locator(".markdown-diagram-error"),
	).toHaveCount(0);
	await expectPainted(
		page.getByTestId("canvas-chart").locator("canvas"),
		chart.colors,
	);
}

/** A diagram is drawn when its SVG is there with the source's own words, and neither the source's <pre> nor the error note is. */
async function expectDiagramDrawn(scope: Locator, words: string[]) {
	await expect(scope.locator("svg").first()).toBeVisible({ timeout: 30_000 });
	for (const word of words) await expect(scope).toContainText(word);
	await expect(scope.locator(".markdown-diagram-error")).toHaveCount(0);
	await expect(scope.locator(".markdown-mermaid-placeholder")).toHaveCount(0);
	const box = await scope.locator("svg").first().boundingBox();
	expect(box?.width ?? 0).toBeGreaterThan(60);
	expect(box?.height ?? 0).toBeGreaterThan(40);
}

test.describe("every chart and diagram the chat draws is drawn on the board", () => {
	test.beforeEach(async ({ page }) => {
		await setUiLanguage("en");
		await login(page);
	});

	for (const [kind, chart] of Object.entries(CHART_TYPES)) {
		test(`a ${kind} chart from the chat is painted on the board, and after a reload`, async ({
			page,
		}) => {
			await expectChartOnBoard(page, chart);
		});
	}

	for (const [what, chart] of Object.entries(MODEL_WRITTEN)) {
		test(`${what}, as the model writes it, is painted on the board, and after a reload`, async ({
			page,
		}) => {
			await expectChartOnBoard(page, chart);
		});
	}

	test("a pie whose JSON is one brace short is drawn whole on the board, as the chat draws it", async ({
		page,
	}) => {
		await expectChartOnBoard(page, ONE_BRACE_SHORT);
		// The plot is a pie: as tall as it is wide, and all of it inside its block.
		const canvas = page.getByTestId("canvas-chart").locator("canvas");
		const plot = await canvas.boundingBox();
		const block = await page
			.locator('[data-testid="canvas-node"][data-kind="chart"]')
			.boundingBox();
		if (!plot || !block) throw new Error("the chart is not on screen");
		expect(plot.width / plot.height).toBeGreaterThan(0.9);
		expect(plot.width / plot.height).toBeLessThan(1.1);
		expect(plot.y + plot.height).toBeLessThanOrEqual(
			block.y + block.height + 1,
		);
	});

	for (const [what, chart] of Object.entries(RESCUED)) {
		test(`${what} is offered and painted on the board, and after a reload`, async ({
			page,
		}) => {
			await expectChartOnBoard(page, chart);
		});
	}

	for (const [kind, diagram] of Object.entries(DIAGRAMS)) {
		test(`a ${kind} diagram from the chat is drawn on the board, and after a reload`, async ({
			page,
		}) => {
			const seeded = await seedChat(page, [fence("mermaid", diagram.source)]);
			await openChatAndReload(page, seeded.conversationId);

			// The chat draws it: the bar the board is held to.
			await expectDiagramDrawn(
				page.locator(".markdown-mermaid"),
				diagram.words,
			);

			await openCanvasPanel(page);
			await pickFromChat(page, "Diagrams", diagram.name);
			const node = page.locator(
				'[data-testid="canvas-node"][data-kind="mermaid"]',
			);
			await expect(node).toHaveCount(1);
			const block = page.getByTestId("canvas-mermaid");
			await expectDiagramDrawn(block, diagram.words);

			await savedStatus(page);
			const stored = await storedBoard(seeded.boardId);
			expect(stored.nodes.map((entry) => entry.type)).toEqual(["mermaid"]);
			expect(stored.nodes[0].data).toMatchObject({
				kind: "mermaid",
				code: diagram.source,
			});

			await page.reload({ waitUntil: "networkidle" });
			await openCanvasPanel(page);
			expect(await nodeCount(page)).toBe(1);
			await expectDiagramDrawn(
				page.getByTestId("canvas-mermaid"),
				diagram.words,
			);
		});
	}

	// A chart's height is its plot's: a pie is as tall as it is wide and a bar chart
	// half that, so the room a chart is given when it is placed comes from the chart,
	// not from one number for every kind of chart (a pie placed in a bar's room
	// reaches over whatever is below it).
	test("puts every chart type on the board without one laying over another", async ({
		page,
	}) => {
		const charts = Object.values(CHART_TYPES);
		const seeded = await seedChat(
			page,
			charts.map((chart) => chart.reply),
		);
		await openChatAndReload(page, seeded.conversationId);
		await openCanvasPanel(page);

		for (const [index, chart] of charts.entries()) {
			await pickFromChat(page, "Charts", chart.name);
			await expect(chartNodes(page)).toHaveCount(index + 1);
			// Each is drawn (so its real size is known to the board) before the next is placed.
			await expectPainted(
				page.getByTestId("canvas-chart").nth(index).locator("canvas"),
				chart.colors,
			);
		}

		const boxes = await chartNodes(page).evaluateAll((nodes) =>
			nodes.map((node) => {
				const { x, y, width, height } = node.getBoundingClientRect();
				return { x, y, width, height };
			}),
		);
		expect(boxes).toHaveLength(charts.length);
		for (const [a, first] of boxes.entries()) {
			for (const [b, second] of boxes.entries()) {
				if (b <= a) continue;
				const across =
					Math.min(first.x + first.width, second.x + second.width) -
					Math.max(first.x, second.x);
				const down =
					Math.min(first.y + first.height, second.y + second.height) -
					Math.max(first.y, second.y);
				expect(
					across > 1 && down > 1,
					`${charts[a].name} lies over ${charts[b].name}`,
				).toBe(false);
			}
		}
	});

	test("offers every kind of visual one chat drew, each under its own heading, newest first", async ({
		page,
	}) => {
		const seeded = await seedChat(page, [
			fence("mermaid", DIAGRAMS.flowchart.source),
			chartReply(CHART_TYPES.bar.config as Record<string, unknown>),
			fence("mermaid", DIAGRAMS.sequence.source),
		]);
		await openChatAndReload(page, seeded.conversationId);
		await openCanvasPanel(page);
		await insertButton(page).click();
		await expect(menu(page)).toBeVisible();
		await expect(
			menu(page).getByText("Looking through this chat…"),
		).toHaveCount(0);
		const charts = menu(page).getByRole("group", { name: "Charts" });
		const diagrams = menu(page).getByRole("group", { name: "Diagrams" });
		await expect(charts.getByRole("menuitem")).toHaveCount(1);
		// Newest first: the sequence diagram was drawn after the flowchart.
		await expect(diagrams.getByRole("menuitem")).toHaveText([
			/Sequence diagram/,
			/Flowchart/,
		]);
	});
});

// The report's screenshots: a board holding every kind of chart the chat draws, then
// every diagram beside them, in Hungarian at 1440x900, light and dark. Set
// OWC_SHOTS to a folder to write them.
const SHOTS = process.env.OWC_SHOTS;

test.describe("the board with every chart and diagram (screenshots)", () => {
	test.skip(!SHOTS, "set OWC_SHOTS to a folder to write the screenshots");

	// The other specs assume an English UI.
	test.afterAll(async () => {
		await setUiLanguage("en");
	});

	for (const scheme of ["light", "dark"] as const) {
		test(`every chart type, then every diagram, Hungarian, ${scheme}, 1440x900`, async ({
			page,
		}) => {
			test.setTimeout(300_000);
			await setUiLanguage("hu");
			await page.emulateMedia({ colorScheme: scheme });
			await page.setViewportSize({ width: 1440, height: 900 });
			await login(page);
			const seeded = await seedChat(page, [
				...Object.values(CHART_TYPES).map((chart) => chart.reply),
				...Object.values(DIAGRAMS).map((diagram) =>
					fence("mermaid", diagram.source),
				),
			]);
			await openChatAndReload(page, seeded.conversationId);
			await openCanvasPanel(page);
			await page
				.getByRole("button", { name: /kibontása a dokumentum-munkaterületen/ })
				.click();
			await waitForStableBoundingBox(page.getByTestId("canvas-board"));
			const reading = "A beszélgetés átnézése…";

			for (const [index, chart] of Object.values(CHART_TYPES).entries()) {
				await pickFromChat(page, "Diagramok", chart.name, reading);
				// A block is measured as it stands, so the next is placed around it once it has drawn.
				await expectPainted(
					page.getByTestId("canvas-chart").nth(index).locator("canvas"),
					chart.colors,
				);
			}
			await expect(chartNodes(page)).toHaveCount(
				Object.keys(CHART_TYPES).length,
			);
			await expectPainted(
				page.getByTestId("canvas-chart").first().locator("canvas"),
				Object.values(CHART_TYPES)[0].colors,
			);
			await fitBoard(page);
			await page.screenshot({
				path: join(SHOTS as string, `1440-${scheme}-charts.png`),
			});

			for (const [index, diagram] of Object.values(DIAGRAMS).entries()) {
				await pickFromChat(page, "Ábrák", diagram.huName, reading);
				// A diagram is as tall as what Mermaid draws, which the board learns when it
				// has drawn it: the next block is placed around what is really there.
				await expect(
					page.getByTestId("canvas-mermaid").nth(index).locator("svg").first(),
				).toBeVisible({ timeout: 30_000 });
			}
			await expect(page.getByTestId("canvas-mermaid")).toHaveCount(
				Object.keys(DIAGRAMS).length,
			);
			await fitBoard(page);
			await page.screenshot({
				path: join(SHOTS as string, `1440-${scheme}-all.png`),
			});
		});
	}
});

/**
 * Fits everything on the board into the view, so every block is on screen to be
 * seen. The zoom control steps aside while a selected block is under it (the block
 * a pick has just put on the board is selected), so the button is pressed by the
 * page, not by a pointer that would find it hidden.
 */
async function fitBoard(page: Page) {
	await page.getByTestId("canvas-fit").dispatchEvent("click");
	// The camera tweens; it has arrived when the zoom stops reading 100%.
	await expect(page.getByTestId("canvas-zoom-level")).not.toHaveText("100%");
	await page.waitForTimeout(800);
}

test.describe("the Insert menu and a phone (screenshots)", () => {
	test.skip(!SHOTS, "set OWC_SHOTS to a folder to write the screenshots");

	test.afterAll(async () => {
		await setUiLanguage("en");
	});

	test("From this chat with its Diagrams heading, Hungarian, light, 1440x900", async ({
		page,
	}) => {
		await setUiLanguage("hu");
		await page.emulateMedia({ colorScheme: "light" });
		await page.setViewportSize({ width: 1440, height: 900 });
		await login(page);
		const seeded = await seedChat(page, [
			chartReply(CHART_TYPES.pie.config),
			fence("mermaid", DIAGRAMS.flowchart.source),
			fence("mermaid", DIAGRAMS.sequence.source),
			fence("mermaid", DIAGRAMS.gantt.source),
		]);
		await openChatAndReload(page, seeded.conversationId);
		await openCanvasPanel(page);
		await insertButton(page).click();
		await expect(
			menu(page).getByRole("group", { name: "Ábrák" }),
		).toBeVisible();
		await expect(menu(page).getByText("A beszélgetés átnézése…")).toHaveCount(
			0,
		);
		await page.waitForTimeout(400);
		await page.screenshot({
			path: join(SHOTS as string, "1440-light-insert-menu.png"),
		});
	});

	test("a chart and two diagrams on a phone, Hungarian, light, 390x844", async ({
		page,
	}) => {
		await setUiLanguage("hu");
		await page.emulateMedia({ colorScheme: "light" });
		await page.setViewportSize({ width: 390, height: 844 });
		await login(page);
		const seeded = await seedChat(page, [
			chartReply(CHART_TYPES.doughnut.config),
			fence("mermaid", DIAGRAMS.flowchart.source),
			fence("mermaid", DIAGRAMS.state.source),
		]);
		await openChatAndReload(page, seeded.conversationId);
		await openCanvasPanel(page);
		const reading = "A beszélgetés átnézése…";
		await pickFromChat(page, "Diagramok", CHART_TYPES.doughnut.name, reading);
		await expectPainted(
			page.getByTestId("canvas-chart").locator("canvas"),
			CHART_TYPES.doughnut.colors,
		);
		await pickFromChat(page, "Ábrák", DIAGRAMS.flowchart.huName, reading);
		await expect(
			page.getByTestId("canvas-mermaid").first().locator("svg").first(),
		).toBeVisible({ timeout: 30_000 });
		await pickFromChat(page, "Ábrák", DIAGRAMS.state.huName, reading);
		await expect(
			page.getByTestId("canvas-mermaid").nth(1).locator("svg").first(),
		).toBeVisible({ timeout: 30_000 });
		await fitBoard(page);
		await page.screenshot({
			path: join(SHOTS as string, "390-light-board.png"),
		});
	});
});
