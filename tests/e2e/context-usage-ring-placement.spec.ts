// The context ring's popup opens next to its ring, wherever the composer is (FX-R).
//
// The owner: the ring at the end of the composer's toolbar opens a small popup
// (what the context holds, what the conversation has cost), and on the home page
// and a project's page, at phone width, it "opens in the wrong place".
//
// On a phone, on a touch screen and in any window narrower than 768px the popup
// is a `position: fixed` box, and a fixed box belongs to the window only while no
// ancestor has a transform. The home page (and a project's, which is the same
// surface) centres its composer in a layer with `transform: translateY(-50%)`, so
// the popup's `bottom: 5.5rem` was counted from THAT layer's bottom edge instead:
// it opened wherever the layer happened to end, on the composer's text field, or
// under the composer on a project's page, or (in a short window) over the whole
// toolbar row with the ring under it. The chat page has no such layer, so the
// sheet stood right there, which is why the ring's own spec (chat page only)
// never saw it.
//
// What the specs read is where a person looks: the ring's box and the popup's
// box, after real taps and clicks. "Next to its ring" means the popup is close
// above the ring (or, when there is no room above, close below it), spans the
// ring sideways, covers none of it, lies wholly inside the window and is the
// topmost thing where it stands. Every case also asks whether the ring is still
// the thing at its own centre, which is what a second tap on it needs (a covered
// ring cannot take one: Playwright's own click on it retries until the test times
// out, the popup being the thing it keeps hitting).
//
// The popup on a desktop hangs off the ring by CSS (absolute, 10px above it) and
// is the part that was right: those cases are guards and say what it was.
import { expect, type Locator, type Page, test } from "@playwright/test";
import { attachLease } from "./composer-attachment-helpers";
import { seedConversationWithContext } from "./context-ring-helpers";
import {
	createEmptyConversation,
	expectTopmost,
	login,
	waitForHydration,
	waitForMotionToSettle,
} from "./helpers";

type Size = { width: number; height: number };

const DESKTOP: Size = { width: 1440, height: 900 };
const DOCKED: Size = { width: 1100, height: 800 };
const TABLET: Size = { width: 1024, height: 768 };
const PHONE: Size = { width: 390, height: 844 };
const SMALL_PHONE: Size = { width: 360, height: 800 };
const PHONE_SIDEWAYS: Size = { width: 844, height: 390 };

/**
 * The most the popup may stand off its ring: the 8px gap the composer's popups
 * keep, the pixel the ring lifts when it is hovered, and room for rounding.
 */
const MAX_GAP = 16;
/**
 * What the phone sheet used to stand off the ring on the chat page (29px): the
 * guard for a surface that was right is as loose as it was, so that it passes
 * before the fix as well as after it.
 */
const SHEET_GAP = 40;

const CHAT_ID = "e2e-context-ring-placement";

type Surface = "home" | "project" | "chat" | "chat-with-file";

const ring = (page: Page): Locator => page.getByTestId("context-usage-ring");
const popup = (page: Page): Locator =>
	page.getByTestId("context-usage-popover");

// A worker's database lives on from one spec file to the next, and the shared
// admin would keep the project a test made for the files after it: it goes with
// the test (see test.afterEach below).
let projectToRemove: string | null = null;

test.afterEach(async ({ page }) => {
	if (!projectToRemove) return;
	const id = projectToRemove;
	projectToRemove = null;
	await page.request.delete(`/api/projects/${id}`);
});

/**
 * One of the surfaces that carry a ring. The home page and a project's page only
 * show it once something is attached; the chat page shows it with the numbers a
 * turn gave it (`chat`, which is where the popup is as tall as it gets) or with
 * a file attached to an empty conversation (`chat-with-file`). Returns once the
 * page has hydrated: the ring's markup is there first, and a press on it before
 * that does nothing.
 */
async function openSurface(page: Page, surface: Surface): Promise<void> {
	await login(page);
	if (surface === "home") {
		await page.goto("/", { waitUntil: "domcontentloaded" });
		await expect(page.getByTestId("message-input")).toBeEnabled({
			timeout: 20000,
		});
		await attachLease(page);
	} else if (surface === "project") {
		const response = await page.request.post("/api/projects", {
			data: { name: `Context ring ${Date.now()}` },
		});
		expect(response.ok(), "creating a project must succeed").toBe(true);
		const project = (await response.json()) as { id: string };
		projectToRemove = project.id;
		await page.goto(`/projects/${project.id}`, {
			waitUntil: "domcontentloaded",
		});
		await expect(page.getByTestId("message-input")).toBeEnabled({
			timeout: 20000,
		});
		await attachLease(page);
	} else if (surface === "chat-with-file") {
		const id = await createEmptyConversation(page, "Context ring");
		await page.goto(`/chat/${id}`, { waitUntil: "domcontentloaded" });
		await expect(page.getByTestId("message-input")).toBeEnabled({
			timeout: 20000,
		});
		await attachLease(page);
	} else {
		await seedConversationWithContext(CHAT_ID, "Context ring placement");
		await page.goto(`/chat/${CHAT_ID}`, { waitUntil: "domcontentloaded" });
	}
	await expect(ring(page)).toBeVisible({ timeout: 20000 });
	await waitForHydration(page);
	await waitForMotionToSettle(page);
}

async function boxOf(locator: Locator) {
	const box = await locator.boundingBox();
	if (!box) throw new Error("nothing on screen to measure");
	return box;
}

/** What a person sees: the popup is there, not faded out and not hidden. */
async function isShown(page: Page): Promise<boolean> {
	return popup(page).evaluate((element) => {
		const style = getComputedStyle(element);
		return (
			Number.parseFloat(style.opacity) > 0.9 && style.visibility === "visible"
		);
	});
}

async function expectShown(page: Page, shown = true) {
	await expect
		.poll(() => isShown(page), {
			message: shown
				? "the context popup is not showing"
				: "the context popup is still showing",
			timeout: 5000,
		})
		.toBe(shown);
}

/** Nothing of the ring is under the popup: a second press on it would reach it. */
async function ringIsReachable(page: Page): Promise<boolean> {
	return ring(page).evaluate((node) => {
		const rect = node.getBoundingClientRect();
		const top = document.elementFromPoint(
			rect.x + rect.width / 2,
			rect.y + rect.height / 2,
		);
		return !!top && node.contains(top);
	});
}

/**
 * What is wrong with where the popup stands, as sentences: nothing when it is
 * next to its ring and inside the window. Read, not asserted, so that a failing
 * run prints the numbers instead of "expected true".
 */
async function placementProblems(
	page: Page,
	maxGap: number,
): Promise<string[]> {
	const viewport = page.viewportSize();
	if (!viewport) throw new Error("no viewport");
	if (!(await isShown(page))) return ["the popup is not showing"];
	const anchor = await boxOf(ring(page));
	const box = await boxOf(popup(page));
	const problems: string[] = [];
	const round = (n: number) => Math.round(n);

	if (box.x < 0 || box.y < 0) {
		problems.push(
			`the popup starts outside the window (x ${round(box.x)}, y ${round(box.y)})`,
		);
	}
	if (
		box.x + box.width > viewport.width ||
		box.y + box.height > viewport.height
	) {
		problems.push(
			`the popup ends outside the window (right ${round(box.x + box.width)} of ${viewport.width}, bottom ${round(box.y + box.height)} of ${viewport.height})`,
		);
	}

	const overlapsSideways =
		box.x < anchor.x + anchor.width && box.x + box.width > anchor.x;
	const overlapsUpDown =
		box.y < anchor.y + anchor.height && box.y + box.height > anchor.y;
	if (overlapsSideways && overlapsUpDown) {
		problems.push(
			`the popup covers the ring (popup x ${round(box.x)}..${round(box.x + box.width)}, y ${round(box.y)}..${round(box.y + box.height)}; ring x ${round(anchor.x)}..${round(anchor.x + anchor.width)}, y ${round(anchor.y)}..${round(anchor.y + anchor.height)})`,
		);
	}

	const gapAbove = anchor.y - (box.y + box.height);
	const gapBelow = box.y - (anchor.y + anchor.height);
	const touchesTop = gapAbove >= -1 && gapAbove <= maxGap;
	const touchesBottom = gapBelow >= -1 && gapBelow <= maxGap;
	if (!touchesTop && !touchesBottom) {
		problems.push(
			`the popup is not next to its ring: ${round(gapAbove)}px above it, ${round(gapBelow)}px below it (ring y ${round(anchor.y)}, popup y ${round(box.y)}..${round(box.y + box.height)})`,
		);
	}

	const centre = anchor.x + anchor.width / 2;
	if (centre < box.x || centre > box.x + box.width) {
		problems.push(
			`the popup does not span its ring sideways: ring centre x ${round(centre)}, popup x ${round(box.x)}..${round(box.x + box.width)}`,
		);
	}
	return problems;
}

async function expectNextToRing(page: Page, maxGap = MAX_GAP) {
	await expect
		.poll(() => placementProblems(page, maxGap), { timeout: 5000 })
		.toEqual([]);
	expect(
		await ringIsReachable(page),
		"the popup is over the ring: a second press on the ring would land on the popup",
	).toBe(true);
}

/** Opens the popup with a real tap or click on the ring, and says it is the thing on top where it stands. */
async function openRing(page: Page, pointer: "tap" | "click") {
	if (pointer === "tap") await ring(page).tap();
	else await ring(page).click();
	await expectShown(page);
	await expectTopmost(popup(page), {
		message: "the context popup is covered by something else",
	});
}

test.describe("on a phone (a touch screen), the context popup stands next to its ring", () => {
	for (const [name, size] of [
		["390x844", PHONE],
		["360x800", SMALL_PHONE],
	] as const) {
		test.describe(name, () => {
			test.use({ viewport: size, hasTouch: true });

			for (const surface of ["home", "project"] as const) {
				test(`on the ${surface === "home" ? "home page" : "project page"}'s composer`, async ({
					page,
				}) => {
					await openSurface(page, surface);
					await openRing(page, "tap");
					await expectNextToRing(page);
				});
			}
		});
	}
});

test.describe("in a narrow window on a mouse, the context popup stands next to its ring", () => {
	test.use({ viewport: PHONE });

	for (const surface of ["home", "project"] as const) {
		test(`on the ${surface === "home" ? "home page" : "project page"}'s composer`, async ({
			page,
		}) => {
			await openSurface(page, surface);
			await openRing(page, "click");
			await expectNextToRing(page);
		});
	}
});

// A tablet is a touch screen of any width: its popup used to be the phone's
// sheet, a window wide, and a phone held sideways has the least room there is.
test.describe("on a wide touch screen and a phone held sideways", () => {
	test.describe("a tablet", () => {
		test.use({ viewport: TABLET, hasTouch: true });

		test("the popup on the home page stands next to its ring, as wide as on a desktop", async ({
			page,
		}) => {
			await openSurface(page, "home");
			await openRing(page, "tap");
			await expectNextToRing(page);
			expect((await boxOf(popup(page))).width).toBeCloseTo(400, 0);
		});
	});

	test.describe("a phone held sideways", () => {
		test.use({ viewport: PHONE_SIDEWAYS, hasTouch: true });

		for (const surface of ["home", "project"] as const) {
			test(`the popup on the ${surface === "home" ? "home page" : "project page"} does not cover the ring`, async ({
				page,
			}) => {
				await openSurface(page, surface);
				await openRing(page, "tap");
				await expectNextToRing(page);
			});
		}

		test("the tallest popup stays inside a window 390px high", async ({
			page,
		}) => {
			await openSurface(page, "chat");
			await openRing(page, "tap");
			await expectNextToRing(page, SHEET_GAP);
			const box = await boxOf(popup(page));
			expect(box.height).toBeGreaterThan(250);
		});
	});
});

// The chat page was right: the sheet stood above the composer, inside the
// window. It still does, hugging the ring now instead of standing 29px over it.
test.describe("in a chat on a phone, the popup stays where it was right", () => {
	test.use({ viewport: PHONE, hasTouch: true });

	for (const surface of ["chat", "chat-with-file"] as const) {
		test(`a chat with ${surface === "chat" ? "numbers from a turn" : "a file attached"}`, async ({
			page,
		}) => {
			await openSurface(page, surface);
			await openRing(page, "tap");
			await expectNextToRing(page, SHEET_GAP);
			// As wide as it always was: 4px from each side.
			const box = await boxOf(popup(page));
			expect(box.x).toBeGreaterThanOrEqual(0);
			expect(box.x).toBeLessThanOrEqual(8);
			expect(box.x + box.width).toBeGreaterThanOrEqual(PHONE.width - 8);
		});
	}
});

// On a desktop the popup hangs off the ring by CSS and is untouched: left edge on
// the ring's, 400px wide, a few pixels above it.
test.describe("on a desktop, the popup stays where it was", () => {
	for (const [name, size] of [
		["1440x900", DESKTOP],
		["1100x800", DOCKED],
	] as const) {
		test.describe(name, () => {
			test.use({ viewport: size });

			for (const surface of [
				"home",
				"project",
				"chat",
				"chat-with-file",
			] as const) {
				test(`on ${surface}`, async ({ page }) => {
					await openSurface(page, surface);
					await openRing(page, "click");
					const anchor = await boxOf(ring(page));
					const box = await boxOf(popup(page));
					expect(
						Math.abs(box.x - anchor.x),
						"the popup's left edge is the ring's",
					).toBeLessThanOrEqual(1);
					expect(box.width).toBeCloseTo(400, 0);
					const gap = anchor.y - (box.y + box.height);
					expect(gap, "10px above the ring's root").toBeGreaterThanOrEqual(8);
					expect(gap).toBeLessThanOrEqual(12);
					await expectNextToRing(page);
				});
			}
		});
	}
});

test.describe("the context popup keeps behaving like a popup", () => {
	test.describe("on a phone", () => {
		test.use({ viewport: PHONE, hasTouch: true });

		test("a tap on the ring opens it and a second tap puts it away", async ({
			page,
		}) => {
			await openSurface(page, "home");
			await openRing(page, "tap");
			await expectNextToRing(page);

			// The ring is not under the popup, so this lands on the ring.
			await ring(page).tap();
			await expectShown(page, false);
			await expect(ring(page)).toHaveAttribute("aria-expanded", "false");
		});

		test("a tap inside it keeps it open, a tap outside it puts it away", async ({
			page,
		}) => {
			await openSurface(page, "home");
			await openRing(page, "tap");

			await popup(page).getByText("No context yet").tap();
			await expectShown(page);

			// The page's own background, well away from the composer.
			await page.touchscreen.tap(195, 150);
			await expectShown(page, false);
		});

		test("it is painted in the page's own body and follows its ring through a resize", async ({
			page,
		}) => {
			await openSurface(page, "home");
			await openRing(page, "tap");
			await expectNextToRing(page);
			expect(
				await popup(page).evaluate(
					(element) => element.parentElement === document.body,
				),
				"the popup must not sit inside the composer's transformed layer",
			).toBe(true);

			// The composer glides to its new place for 420ms: the popup goes with it.
			await page.setViewportSize(SMALL_PHONE);
			await waitForMotionToSettle(page);
			await expectNextToRing(page);

			await page.setViewportSize(PHONE_SIDEWAYS);
			await waitForMotionToSettle(page);
			await expectNextToRing(page);
		});
	});

	test.describe("on a phone in the dark", () => {
		test.use({
			viewport: PHONE,
			hasTouch: true,
			colorScheme: "dark",
		});

		// A popup painted in <body> keeps the tokens of the theme it is shown in.
		test("it keeps the dark theme's colours where it has been moved", async ({
			page,
		}) => {
			await openSurface(page, "home");
			await openRing(page, "tap");
			await expectNextToRing(page);
			const background = await popup(page).evaluate(
				(element) => getComputedStyle(element).backgroundColor,
			);
			// "rgb(r, g, b)" has its channels in 0..255, "color(srgb r g b)" in 0..1.
			const channels = (background.match(/-?\d*\.?\d+/g) ?? []).map(Number);
			const scale = background.startsWith("color(") ? 1 : 255;
			const [r, g, b] = channels.slice(0, 3).map((n) => n / scale);
			const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
			expect(luminance, `a dark popup, not ${background}`).toBeLessThan(0.35);
		});
	});

	test.describe("in a narrow window on a mouse, then a desktop one", () => {
		test.use({ viewport: PHONE });

		test("it goes back into the composer when the window is wide again, and out again when it is narrow", async ({
			page,
		}) => {
			await openSurface(page, "home");
			await openRing(page, "click");
			await expectNextToRing(page);

			await page.setViewportSize(DOCKED);
			await waitForMotionToSettle(page);
			await expectNextToRing(page);
			expect(
				await popup(page).evaluate(
					(element) => element.parentElement === document.body,
				),
				"a desktop's popup hangs off the ring inside the composer",
			).toBe(false);

			await page.setViewportSize(PHONE);
			await waitForMotionToSettle(page);
			await expectNextToRing(page);
		});
	});

	test.describe("on a desktop", () => {
		test.use({ viewport: DESKTOP });

		test("the mouse over the ring shows it, and the mouse leaving puts it away", async ({
			page,
		}) => {
			await openSurface(page, "chat");
			await ring(page).hover();
			await expectShown(page);
			await page.mouse.move(5, 5);
			await expectShown(page, false);
		});

		test("the keyboard's focus on the ring shows it, and leaving the ring puts it away", async ({
			page,
		}) => {
			await openSurface(page, "chat");
			await page.getByTestId("message-input").focus();
			// Tab walks the composer's toolbar to the ring.
			for (let presses = 0; presses < 12; presses += 1) {
				await page.keyboard.press("Tab");
				const onRing = await ring(page).evaluate(
					(node) => document.activeElement === node,
				);
				if (onRing) break;
			}
			await expect(ring(page)).toBeFocused();
			await expectShown(page);

			await page.keyboard.press("Tab");
			await expectShown(page, false);
		});

		test("Escape puts it away, however it was opened", async ({ page }) => {
			await openSurface(page, "chat");
			await openRing(page, "click");

			await page.keyboard.press("Escape");
			await expectShown(page, false);
			await expect(ring(page)).toHaveAttribute("aria-expanded", "false");
		});

		test("a press outside it puts it away, a press inside it does not", async ({
			page,
		}) => {
			await openSurface(page, "chat");
			await openRing(page, "click");

			await popup(page).getByText("Compaction").click();
			await expectShown(page);

			// The page's own background, well away from the composer and the sidebar.
			await page.mouse.move(DESKTOP.width / 2, 150);
			await page.mouse.down();
			await page.mouse.up();
			await expectShown(page, false);
		});

		test("it is not in the page's accessibility tree until it is shown", async ({
			page,
		}) => {
			await openSurface(page, "chat");
			const dialog = page.getByRole("dialog", { name: "Context focus panel" });
			// Hidden, not only transparent: a screen reader does not meet a dialog
			// nobody opened at the end of the page.
			await expect(dialog).toHaveCount(0);

			await openRing(page, "click");
			await expect(dialog).toHaveCount(1);
			await expect(ring(page)).toHaveAttribute(
				"aria-controls",
				(await popup(page).getAttribute("id")) ?? "",
			);
		});
	});
});
