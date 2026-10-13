// The outline popup opens next to its icon, wherever the composer is (FX-O).
//
// The owner: the "outline" icon beside an uploaded file's pill opens a popup,
// and the popup "moves to the wrong location, not next to the icon".
//
// The icon is a 24px button beside the pill; the popup is a list of the
// document's sections, `position: fixed` and measured against the window from
// the button's own rectangle. A fixed box belongs to the window only while no
// ancestor has a transform, and the composer on the home page (and on a
// project's page) sits in a layer centred with `transform: translateY(-50%)`:
// there every `left` and `bottom` the popup was given was counted from that
// layer instead, and it opened a few hundred pixels from its icon, at the top
// of the window. On a phone it was also pushed left by a width it never had.
// The chat page has no such layer, so it was right at desktop widths and only
// the phone was off, which is why the unit tests and the phone-only check in
// composer-chips.spec.ts never saw it.
//
// What the specs read is where a person looks: the icon's box and the popup's
// box, after real clicks and key presses. "Next to its icon" means the popup
// touches the icon's top (or, when there is no room above, its bottom) within
// a few pixels, spans the icon sideways, and lies wholly inside the window.
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
	createTourUser,
	markToursSeen,
	panelList,
	reopenChat,
	seedItem,
	startChatAs,
} from "./artifact-tours-helpers";
import {
	attachLease as attachLeaseFile,
	type OutlineSection as Section,
} from "./composer-attachment-helpers";
import {
	createEmptyConversation,
	expectTopmost,
	login,
	waitForMotionToSettle,
} from "./helpers";

const DESKTOP = { width: 1440, height: 900 };
// The width at which the document panel docks beside the chat, leaving the
// chat column (and the composer in it) about 390px wide.
const DOCKED = { width: 1100, height: 800 };
const PHONE = { width: 390, height: 844 };
const PHONE_SIDEWAYS = { width: 844, height: 390 };

/** The most the popup may stand off its icon: the 8px gap, and some room for rounding. */
const MAX_GAP = 16;

/**
 * Four short headings: the narrowest popup there is (it will not go under its
 * 220px minimum), and so the one a phone leaves furthest from its icon.
 */
const SHORT_OUTLINE: Section[] = [
	{
		level: 1,
		title: "1 Parties",
		offset: 0,
		preview: "The landlord and the tenant",
	},
	{
		level: 2,
		title: "2.3 Break clause",
		offset: 100,
		preview: "Either party may terminate on six months' written notice",
	},
	{
		level: 2,
		title: "2.4 Rent review",
		offset: 200,
		preview: "Rent is reviewed yearly",
	},
	{
		level: 1,
		title: "3 Deposit",
		offset: 300,
		preview: "A deposit of two months",
	},
];

/** Long headings: the widest popup there is (it stops at 320px), and as tall as the list may grow. */
function longOutline(count: number): Section[] {
	return Array.from({ length: count }, (_, index) => ({
		level: index % 3 === 0 ? 1 : 2,
		title: `${index + 1} Section ${index + 1} of the lease agreement between the parties`,
		offset: index * 100,
		preview: `Preview text of section ${index + 1}`,
	}));
}

/** Attaches the lease the way the file input does, and waits for its pill and its outline icon. */
async function attachLease(page: Page, outline: Section[] = SHORT_OUTLINE) {
	await attachLeaseFile(page, outline);
	await expect(icon(page)).toBeVisible();
	await waitForMotionToSettle(page);
}

function icon(page: Page): Locator {
	return page.getByTestId("attachment-outline-disclosure");
}

function popup(page: Page): Locator {
	return page.getByTestId("attachment-outline-popover");
}

async function boxOf(locator: Locator) {
	const box = await locator.boundingBox();
	if (!box) throw new Error("nothing on screen to measure");
	return box;
}

/**
 * What is wrong with where the popup stands, as sentences: nothing when it is
 * next to its icon and inside the window. Read, not asserted, so that a failing
 * run prints the numbers instead of "expected true".
 */
async function placementProblems(page: Page): Promise<string[]> {
	const viewport = page.viewportSize();
	if (!viewport) throw new Error("no viewport");
	if (!(await popup(page).isVisible())) return ["the popup is not open"];
	const anchor = await boxOf(icon(page));
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

	const gapAbove = anchor.y - (box.y + box.height);
	const gapBelow = box.y - (anchor.y + anchor.height);
	const touchesTop = gapAbove >= -1 && gapAbove <= MAX_GAP;
	const touchesBottom = gapBelow >= -1 && gapBelow <= MAX_GAP;
	if (!touchesTop && !touchesBottom) {
		problems.push(
			`the popup is not next to its icon: ${round(gapAbove)}px above it, ${round(gapBelow)}px below it (icon y ${round(anchor.y)}, popup y ${round(box.y)}..${round(box.y + box.height)})`,
		);
	}

	const centre = anchor.x + anchor.width / 2;
	if (centre < box.x || centre > box.x + box.width) {
		problems.push(
			`the popup does not span its icon sideways: icon centre x ${round(centre)}, popup x ${round(box.x)}..${round(box.x + box.width)}`,
		);
	}
	return problems;
}

async function expectNextToIcon(page: Page) {
	await expect
		.poll(() => placementProblems(page), { timeout: 5000 })
		.toEqual([]);
}

/** Opens the popup with a real click on the icon, and says it is the thing on top there. */
async function openByClick(page: Page) {
	await icon(page).click();
	await expect(popup(page)).toBeVisible();
	await expectTopmost(popup(page), {
		message: "the outline popup is covered by something else",
	});
}

async function startHome(page: Page, size: { width: number; height: number }) {
	await page.setViewportSize(size);
	await login(page);
	await page.goto("/", { waitUntil: "domcontentloaded" });
	await expect(page.getByTestId("message-input")).toBeEnabled({
		timeout: 20000,
	});
}

// A worker's database lives on from one spec file to the next, and the shared
// admin would keep the project a test made for the files after it: it goes with
// the test (see test.afterEach below).
let projectToRemove: string | null = null;

async function startProject(
	page: Page,
	size: { width: number; height: number },
) {
	await page.setViewportSize(size);
	await login(page);
	const response = await page.request.post("/api/projects", {
		data: { name: `Outline popup ${Date.now()}` },
	});
	expect(response.ok(), "creating a project must succeed").toBe(true);
	const project = (await response.json()) as { id: string };
	projectToRemove = project.id;
	await page.goto(`/projects/${project.id}`, { waitUntil: "domcontentloaded" });
	await expect(page.getByTestId("message-input")).toBeEnabled({
		timeout: 20000,
	});
}

async function startChat(page: Page, size: { width: number; height: number }) {
	await page.setViewportSize(size);
	await login(page);
	const id = await createEmptyConversation(page, "Outline popup");
	await page.goto(`/chat/${id}`, { waitUntil: "domcontentloaded" });
	await expect(page.getByTestId("message-input")).toBeEnabled({
		timeout: 20000,
	});
}

test.afterEach(async ({ page }) => {
	if (!projectToRemove) return;
	const id = projectToRemove;
	projectToRemove = null;
	await page.request.delete(`/api/projects/${id}`);
});

test.describe("the outline popup stands next to its icon", () => {
	for (const [name, size] of [
		["desktop", DESKTOP],
		["a narrow window", DOCKED],
		["a phone", PHONE],
	] as const) {
		test(`on the home page's composer, ${name}`, async ({ page }) => {
			await startHome(page, size);
			await attachLease(page);
			await openByClick(page);
			await expectNextToIcon(page);
		});
	}

	for (const [name, size] of [
		["desktop", DESKTOP],
		["a narrow window", DOCKED],
		["a phone", PHONE],
	] as const) {
		test(`on a project's composer, ${name}`, async ({ page }) => {
			await startProject(page, size);
			await attachLease(page);
			await openByClick(page);
			await expectNextToIcon(page);
		});
	}

	for (const [name, size] of [
		["desktop", DESKTOP],
		["a narrow window", DOCKED],
		["a phone", PHONE],
	] as const) {
		test(`in a chat, ${name}`, async ({ page }) => {
			await startChat(page, size);
			await attachLease(page);
			await openByClick(page);
			await expectNextToIcon(page);
		});
	}

	test("in a chat with the document panel docked beside it", async ({
		page,
	}) => {
		await page.setViewportSize(DOCKED);
		const user = await createTourUser("en");
		await markToursSeen(user);
		const chatId = await startChatAs(page, user);
		await seedItem(user, chatId, "document");
		await reopenChat(page, chatId);
		await page.getByTestId("artifact-count-button").click();
		await expect(panelList(page)).toBeVisible();
		await waitForMotionToSettle(page);

		await attachLease(page);
		// The panel really is docked beside the chat: the icon is in the chat
		// column, to the left of the panel, near the column's right edge.
		const panel = await boxOf(panelList(page));
		const anchor = await boxOf(icon(page));
		expect(anchor.x + anchor.width).toBeLessThan(panel.x);
		await openByClick(page);
		await expectNextToIcon(page);
	});

	test("on a phone held sideways, where there is little room above", async ({
		page,
	}) => {
		await startHome(page, PHONE_SIDEWAYS);
		await attachLease(page, longOutline(12));
		await openByClick(page);
		await expectNextToIcon(page);
	});

	test("the widest popup stays inside a phone's window", async ({ page }) => {
		await startChat(page, PHONE);
		await attachLease(page, longOutline(6));
		await openByClick(page);
		await expectNextToIcon(page);
		// 320px wide, from the right-hand margin: it still covers the icon.
		const box = await boxOf(popup(page));
		expect(box.width).toBeGreaterThan(300);
	});

	test("a long outline in a short window stays inside the window and scrolls", async ({
		page,
	}) => {
		await startHome(page, { width: 1100, height: 420 });
		await attachLease(page, longOutline(40));
		await openByClick(page);
		await expectNextToIcon(page);
		const list = popup(page);
		const scrolls = await list.evaluate(
			(element) => element.scrollHeight > element.clientHeight,
		);
		expect(
			scrolls,
			"forty sections do not fit in 420px: the popup scrolls",
		).toBe(true);
	});

	test("it follows its icon when the window changes size while it is open", async ({
		page,
	}) => {
		await startHome(page, DESKTOP);
		await attachLease(page);
		await openByClick(page);
		await expectNextToIcon(page);

		await page.setViewportSize(PHONE);
		await waitForMotionToSettle(page);
		await expectNextToIcon(page);

		await page.setViewportSize(DOCKED);
		await waitForMotionToSettle(page);
		await expectNextToIcon(page);
	});
});

test.describe("the outline popup keeps behaving like a popup", () => {
	test("a press inside it keeps it open, a press outside closes it", async ({
		page,
	}) => {
		await startHome(page, DESKTOP);
		await attachLease(page);
		await openByClick(page);

		// Its own caption is not a way out.
		await popup(page)
			.getByText(/Outline · 4 sections/)
			.click();
		await expect(popup(page)).toBeVisible();

		// The composer's own field is: the popup hangs over the middle of it, so
		// the press goes to its left-hand end, which a person can see.
		await page
			.getByTestId("message-input")
			.click({ position: { x: 24, y: 24 } });
		await expect(popup(page)).toBeHidden();
		await expect(icon(page)).toHaveAttribute("aria-expanded", "false");
	});

	test("the keyboard reaches the sections and Escape gives the icon back", async ({
		page,
	}) => {
		await startHome(page, DESKTOP);
		await attachLease(page);

		await icon(page).focus();
		await page.keyboard.press("Enter");
		await expect(popup(page)).toBeVisible();
		const rows = popup(page).locator(".attachment-outline-row");
		await expect(rows).toHaveCount(4);
		// Opened from the keyboard, the first section has the focus: the popup is
		// not next to its icon in the page's order, so Tab could not get there.
		await expect(rows.first()).toBeFocused();

		// Tab walks the sections and stays in the popup.
		await page.keyboard.press("Tab");
		await expect(rows.nth(1)).toBeFocused();
		await page.keyboard.press("Shift+Tab");
		await page.keyboard.press("Shift+Tab");
		await expect(rows.last()).toBeFocused();

		await page.keyboard.press("Escape");
		await expect(popup(page)).toBeHidden();
		await expect(icon(page)).toBeFocused();
	});

	test("picking a section still makes its quote chip", async ({ page }) => {
		await startHome(page, DESKTOP);
		await attachLease(page);
		await openByClick(page);
		await popup(page)
			.locator(".attachment-outline-row")
			.filter({ hasText: "2.3 Break clause" })
			.click();
		await expect(page.getByTestId("composer-chip-quote")).toContainText(
			"2.3 Break clause",
		);
		await expect(popup(page)).toBeHidden();
	});
});
