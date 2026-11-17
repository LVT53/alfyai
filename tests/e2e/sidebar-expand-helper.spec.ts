// What `ensureSidebarExpanded` (tests/e2e/helpers.ts) promises the specs that call it: when it
// returns, the sidebar is open and nothing in it is still moving, so a click or a measurement
// made right after meets the settled sidebar and not one that is mid-way through its 240 ms
// width transition. Two ways of arriving at an open sidebar are held, because they start the
// transition differently: a click on the rail's expand button, and a page that remembers the
// sidebar as open, whose hydration opens it. Without the helper's wait both fail here.
import { expect, type Page, test } from "@playwright/test";
import { ensureSidebarExpanded, login } from "./helpers";

/** How long the sidebar is watched after the helper returns: its transition is 240 ms. */
const WATCH_MS = 500;

/**
 * The frames, over `WATCH_MS` from now, in which the sidebar differs from how it ends: its
 * box, or a finite animation or transition still running in it (an endless one, a spinner,
 * is not motion that settles).
 */
async function sidebarMovement(page: Page): Promise<unknown[]> {
	return page.evaluate(
		(watchMs) =>
			new Promise<unknown[]>((resolve) => {
				const frames: Array<{
					t: number;
					x: number;
					width: number;
					running: number;
				}> = [];
				const start = performance.now();
				const sample = () => {
					const aside = document.querySelector("aside.sidebar-panel");
					const box = aside?.getBoundingClientRect();
					frames.push({
						t: Math.round(performance.now() - start),
						x: box?.x ?? -1,
						width: box?.width ?? -1,
						running: aside
							? aside
									.getAnimations({ subtree: true })
									.filter(
										(animation) =>
											animation.playState === "running" &&
											animation.effect?.getComputedTiming().iterations !==
												Infinity,
									).length
							: -1,
					});
					if (performance.now() - start < watchMs)
						requestAnimationFrame(sample);
					else {
						const last = frames[frames.length - 1];
						resolve(
							frames.filter(
								(frame) =>
									frame.x !== last?.x ||
									frame.width !== last?.width ||
									frame.running > 0,
							),
						);
					}
				};
				requestAnimationFrame(sample);
			}),
		WATCH_MS,
	);
}

for (const remembered of ["collapsed", "expanded"] as const) {
	test(`ensureSidebarExpanded returns with the sidebar at rest: the page remembers it ${remembered}`, async ({
		page,
	}) => {
		await login(page);
		await page.evaluate((state) => {
			localStorage.setItem(
				"sidebarCollapsed",
				state === "collapsed" ? "true" : "false",
			);
		}, remembered);
		await page.reload({ waitUntil: "domcontentloaded" });
		await ensureSidebarExpanded(page);
		await expect(
			page.getByRole("button", { name: "Collapse sidebar" }),
		).toBeVisible();
		expect(
			await sidebarMovement(page),
			"the sidebar was still moving when ensureSidebarExpanded returned",
		).toEqual([]);
	});
}
