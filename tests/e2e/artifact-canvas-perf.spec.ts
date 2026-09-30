import { expect, type Page, test } from "@playwright/test";
import type {
	Annotation,
	CanvasBody,
	CanvasNode,
} from "../../src/lib/shared/artifacts/canvas";
import {
	boardJson,
	MAX_ANNOTATIONS_PER_BOARD,
	normalizeCanvasBody,
} from "../../src/lib/shared/artifacts/canvas-body";
import {
	dragBetween,
	openCanvasPanel,
	openChatAndReload,
	seedCanvas,
	storedAnnotations,
} from "./artifact-canvas-helpers";
import { createConversation, login } from "./helpers";

// The Canvas's performance budget (Feature 2 · Artifacts, Slice 3, T8; rulings 9
// and 16). CI asserts what is deterministic and a loose timing ceiling: the
// board's size and counts, that the drawing pad still covers the pane on a big
// board, what ending a stroke costs, and an average frame time under 33 ms during
// a scripted pan (about four times the 8.3 ms the prototype measured, so it
// catches a catastrophe and cannot fail on a slow runner). The FIGURE is measured
// and printed, never asserted: a green run must not be read as "60 fps was
// proven", and a slow machine is not a product regression (ruling 9).
//
// The bundle's budgets (the editor's initial chunk, the chat route, Chart.js and
// MapLibre kept out of the editor) are asserted by `npm run check:artifact-chunks`,
// which `npm run build` ends with, and by `scripts/check-artifact-chunks.test.ts`.

const NOTES = 150;
const STROKES = 200;
const CAMERA = { x: 40, y: 40, zoom: 0.6 };

function sticky(index: number): CanvasNode {
	return {
		id: `note-${index}`,
		type: "sticky",
		position: { x: (index % 15) * 230, y: Math.floor(index / 15) * 120 },
		width: 190,
		data: { kind: "sticky", text: `Note ${index}`, tone: "yellow" },
	};
}

function stroke(index: number): Annotation {
	return {
		id: `pen-${index}`,
		kind: "pen",
		color: "var(--ink-blue)",
		size: 4,
		points: Array.from({ length: 30 }, (_, step) => ({
			x: (index % 20) * 170 + step * 4,
			y: Math.floor(index / 20) * 330 + Math.sin(step / 3) * 20,
		})),
	};
}

/** The prototype's heavy board: 150 notes and 200 strokes of 30 points. */
function heavyBoard(): CanvasBody {
	return {
		version: 1,
		nodes: Array.from({ length: NOTES }, (_, index) => sticky(index)),
		edges: [],
		viewport: CAMERA,
		annotations: Array.from({ length: STROKES }, (_, index) => stroke(index)),
	};
}

async function open(page: Page, body: CanvasBody) {
	const conversationId = await createConversation(page, "Budget");
	const artifactId = await seedCanvas(conversationId, body);
	await openChatAndReload(page, conversationId);
	await openCanvasPanel(page);
	return artifactId;
}

async function chooseTool(page: Page, tool: string) {
	const draw = page.getByTestId("canvas-tool-draw");
	if ((await draw.getAttribute("aria-pressed")) !== "true") await draw.click();
	await page.getByTestId(`canvas-tool-${tool}`).click();
	await expect(page.getByTestId("canvas-board")).toHaveAttribute(
		"data-tool",
		tool,
	);
}

test.describe("the board's structural budget (CI)", () => {
	test("holds the board's canonical JSON under 512 kB at 150 notes and 200 strokes", () => {
		const json = boardJson(heavyBoard());
		expect(json.length).toBeLessThanOrEqual(512 * 1024);
		console.log(
			`[canvas budget] board JSON ${(json.length / 1024).toFixed(1)} kB`,
		);
	});

	test("keeps exactly 150 nodes and 200 annotations through a normalise round trip", () => {
		const read = normalizeCanvasBody(JSON.parse(boardJson(heavyBoard())));
		expect(read.body.nodes).toHaveLength(NOTES);
		expect(read.body.annotations).toHaveLength(STROKES);
		expect(read.dropped).toEqual({ nodes: [], edges: [], annotations: [] });
	});
});

test.describe("the board in the browser (CI ceilings, the figure recorded)", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("keeps the drawing pad covering at least 95% of the pane at fit view on the heavy board", async ({
		page,
	}) => {
		await open(page, { ...heavyBoard(), viewport: { x: 0, y: 0, zoom: 1 } });
		await chooseTool(page, "pen");
		const coverage = await page.evaluate(() => {
			const pane = (
				document.querySelector(".svelte-flow__pane") as HTMLElement
			).getBoundingClientRect();
			let pad = 0;
			let missed = 0;
			// 144 sample points across the pane, at the middle of a 12 x 12 grid.
			for (let i = 0; i < 12; i += 1) {
				for (let j = 0; j < 12; j += 1) {
					const top = document.elementFromPoint(
						pane.x + (pane.width * (i + 0.5)) / 12,
						pane.y + (pane.height * (j + 0.5)) / 12,
					);
					if (top?.closest('[data-testid="canvas-drawing-layer"]')) pad += 1;
					// The board's own chrome sits over the pane by design; anything else on top is a hole in the pad.
					else if (
						!top?.closest(
							".canvas-toolbar, .svelte-flow__minimap, .svelte-flow__panel, .svelte-flow__attribution",
						)
					)
						missed += 1;
				}
			}
			return { pad, missed };
		});
		console.log(
			`[canvas budget] pad coverage ${coverage.pad} of ${coverage.pad + coverage.missed} points`,
		);
		expect(
			coverage.pad / (coverage.pad + coverage.missed),
		).toBeGreaterThanOrEqual(0.95);
	});

	test("commits a stroke, from the pointer letting go to the mark on the board, in under 8 ms on average", async ({
		page,
	}) => {
		// The board starts empty and takes 200 real pointer drags: it grows to the
		// prototype's 200 strokes while the cost of ending each is measured.
		const artifactId = await open(page, {
			version: 1,
			nodes: [sticky(0)],
			edges: [],
			viewport: { x: 16, y: 16, zoom: 0.5 },
			annotations: [],
		});
		await chooseTool(page, "pen");
		const pane = await page.locator(".svelte-flow__pane").boundingBox();
		if (!pane) throw new Error("no pane");
		await page.evaluate(() => {
			const w = window as unknown as {
				__release: number[];
				__commits: number[];
				__up: number;
			};
			w.__release = [];
			w.__commits = [];
			w.__up = 0;
			const pad = document.querySelector(
				'[data-testid="canvas-drawing-layer"]',
			) as HTMLElement;
			// The moment the pointer lets go (capturing, so before the layer's own handler runs)…
			pad.addEventListener(
				"pointerup",
				() => {
					w.__up = performance.now();
				},
				{ capture: true },
			);
			// …and the moment a mark appears on the board.
			const ink = document.querySelector('[data-testid="canvas-ink"]');
			new MutationObserver(() => {
				if (w.__up > 0) {
					w.__commits.push(performance.now() - w.__up);
					w.__up = 0;
				}
			}).observe(ink as Element, { childList: true, subtree: true });
		});

		for (let index = 0; index < STROKES; index += 1) {
			const x = pane.x + 40 + (index % 20) * 30;
			const y = pane.y + 60 + Math.floor(index / 20) * 30;
			await dragBetween(page, { x, y }, { x: x + 20, y: y + 16 }, 6);
		}
		await expect(page.getByTestId("canvas-mark")).toHaveCount(STROKES);

		const commits = await page.evaluate(
			() => (window as unknown as { __commits: number[] }).__commits,
		);
		expect(commits.length).toBeGreaterThanOrEqual(STROKES - 5);
		const sorted = [...commits].sort((a, b) => a - b);
		const average = commits.reduce((sum, ms) => sum + ms, 0) / commits.length;
		const p95 = sorted[Math.floor(sorted.length * 0.95)];
		const note = `${commits.length} strokes, average ${average.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, max ${sorted[sorted.length - 1].toFixed(2)} ms`;
		console.log(`[canvas budget] stroke commit: ${note}`);
		test.info().annotations.push({ type: "stroke commit", description: note });
		expect(average).toBeLessThan(8);
		expect(MAX_ANNOTATIONS_PER_BOARD).toBeGreaterThanOrEqual(STROKES);
		await expect
			.poll(async () => (await storedAnnotations(artifactId)).length, {
				timeout: 15_000,
			})
			.toBe(STROKES);
	});

	test("keeps the average frame under the ceiling of 33 ms while the heavy board is panned, and records the figure", async ({
		page,
	}) => {
		await open(page, heavyBoard());
		await page.getByTestId("canvas-tool-pan").click();
		const pane = await page.locator(".svelte-flow__pane").boundingBox();
		if (!pane) throw new Error("no pane");
		await page.evaluate(() => {
			const w = window as unknown as { __frames: number[]; __raf: number };
			w.__frames = [];
			let last = performance.now();
			const tick = (t: number) => {
				w.__frames.push(t - last);
				last = t;
				w.__raf = requestAnimationFrame(tick);
			};
			w.__raf = requestAnimationFrame(tick);
		});
		// A scripted pan back and forth across the board.
		await page.mouse.move(pane.x + 500, pane.y + 400);
		await page.mouse.down();
		await page.mouse.move(pane.x + 100, pane.y + 150, { steps: 120 });
		await page.mouse.move(pane.x + 500, pane.y + 400, { steps: 120 });
		await page.mouse.up();
		const all = await page.evaluate(() => {
			const w = window as unknown as { __frames: number[]; __raf: number };
			cancelAnimationFrame(w.__raf);
			return w.__frames;
		});
		// The first frames are warm-up (the layers' first paint), not the pan.
		const frames = all.slice(8);
		expect(frames.length).toBeGreaterThanOrEqual(80);
		const sorted = [...frames].sort((a, b) => a - b);
		const average = frames.reduce((sum, ms) => sum + ms, 0) / frames.length;
		const p95 = sorted[Math.floor(sorted.length * 0.95)];
		const fps = 1000 / average;
		const note = `${frames.length} frames, average ${average.toFixed(1)} ms (${fps.toFixed(0)} fps), p95 ${p95.toFixed(1)} ms, max ${sorted[sorted.length - 1].toFixed(1)} ms`;
		// Printed for the record (the figure goes in the report), never asserted.
		console.log(`[canvas frame time] ${note}`);
		test.info().annotations.push({ type: "frame time", description: note });
		// Only a catastrophe reaches the ceiling (ruling 16): it is not the product's 60 fps.
		expect(average).toBeLessThan(33);
	});
});
