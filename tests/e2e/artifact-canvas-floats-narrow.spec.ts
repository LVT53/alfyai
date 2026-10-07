import { expect, type Locator, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import { users } from "../../src/lib/server/db/schema";
import { openBoard, sixNotes } from "./artifact-canvas-helpers";

/**
 * The layers that float over the board stay off each other at the widths a docked
 * panel gives it (final re-check RC-F, IMP-4).
 *
 * The palette (centred along the bottom, wider in Hungarian: its two buttons have
 * words on them), the zoom control (bottom right) and the overview (above it) each
 * come to be where the others are as the pane narrows. At 1100 docked the pane is
 * 713 px wide: the palette reached 54 px under the zoom control and covered its
 * "zoom out" button, which nothing under a real pointer could press.
 *
 * Driven the way a reader does: the window is resized, every zoom button is
 * pressed with a real click at its centre, and what is under each of them is asked
 * of the browser's own hit test.
 */

async function setLanguage(language: "en" | "hu") {
	await db
		.update(users)
		.set({ uiLanguage: language })
		.where(eq(users.email, "admin@local"));
}

type Rect = { left: number; top: number; right: number; bottom: number };

async function rectOf(locator: Locator): Promise<Rect | null> {
	const box = await locator.boundingBox();
	if (!box) return null;
	return {
		left: box.x,
		top: box.y,
		right: box.x + box.width,
		bottom: box.y + box.height,
	};
}

function meet(a: Rect, b: Rect): boolean {
	return (
		a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
	);
}

/** What the browser puts under the middle of an element: the element itself, or a part of it, when nothing covers it. */
async function topmostAtCentre(page: Page, locator: Locator): Promise<boolean> {
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

const WIDTHS = [1000, 1100, 1200, 1280, 1366, 1440, 1600];

for (const language of ["hu", "en"] as const) {
	test.describe(`the palette, the zoom control and the overview (${language})`, () => {
		test.beforeEach(async () => {
			await setLanguage(language);
		});
		test.afterAll(async () => {
			await setLanguage("en");
		});

		test("meet nowhere across the widths a docked panel gives the board, and every zoom button can be pressed", async ({
			page,
		}) => {
			await page.setViewportSize({ width: 1440, height: 800 });
			await openBoard(page, `Floats ${language}`, sixNotes());
			const palette = page.getByTestId("canvas-toolbar");
			const zoom = page.getByTestId("canvas-zoom");
			const minimap = page.locator(".svelte-flow__minimap");
			const seen: string[] = [];

			for (const width of WIDTHS) {
				await page.setViewportSize({ width, height: 800 });
				// The panel and the board settle at the new size.
				await expect
					.poll(
						async () =>
							(await page.getByTestId("canvas-board").boundingBox())?.width,
					)
					.toBeGreaterThan(300);
				await page.waitForTimeout(250);
				const pane = (await page.getByTestId("canvas-board").boundingBox())
					?.width;
				const rects = {
					palette: await rectOf(palette),
					zoom: await rectOf(zoom),
					minimap: (await minimap.count()) ? await rectOf(minimap) : null,
				};
				seen.push(
					`${width}: pane ${Math.round(pane ?? 0)}, palette ${Math.round((rects.palette?.right ?? 0) - (rects.palette?.left ?? 0))} wide`,
				);
				const where = `at ${width} (pane ${Math.round(pane ?? 0)})`;
				if (!rects.palette || !rects.zoom)
					throw new Error(`no layers ${where}`);
				expect(
					meet(rects.palette, rects.zoom),
					`the palette meets the zoom control ${where}`,
				).toBe(false);
				if (rects.minimap) {
					expect(
						meet(rects.minimap, rects.zoom),
						`the overview meets the zoom control ${where}`,
					).toBe(false);
					expect(
						meet(rects.minimap, rects.palette),
						`the overview meets the palette ${where}`,
					).toBe(false);
				}
				for (const id of ["canvas-zoom-out", "canvas-zoom-in", "canvas-fit"]) {
					expect(
						await topmostAtCentre(page, page.getByTestId(id)),
						`${id} is covered ${where}`,
					).toBe(true);
				}
			}
			test
				.info()
				.annotations.push({ type: "widths", description: seen.join(" | ") });

			// A real click on the zoom-out button zooms out (the narrowest width, where it was covered).
			await page.setViewportSize({ width: 1100, height: 800 });
			await page.waitForTimeout(300);
			const level = page.getByTestId("canvas-zoom-level");
			const before = Number.parseInt((await level.textContent()) ?? "0", 10);
			const out = await page.getByTestId("canvas-zoom-out").boundingBox();
			if (!out) throw new Error("no zoom-out button");
			await page.mouse.click(out.x + out.width / 2, out.y + out.height / 2);
			await expect
				.poll(async () =>
					Number.parseInt((await level.textContent()) ?? "0", 10),
				)
				.toBeLessThan(before);
		});
	});
}
