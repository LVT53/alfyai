import { expect, type Page, type Route, test } from "@playwright/test";
import type {
	MemoryDetail,
	MemoryOverview,
	MemoryPage,
	MemorySubjectIndex,
	MemorySubjectPage,
} from "../../src/lib/memory-types";
import { setUiLanguage } from "./artifact-document-polish-helpers";
import { login, waitForHydration, waitForMotionToSettle } from "./helpers";
import { keepAdminOnTodaysMemoryPage } from "./memory-helpers";

// The Memory page once an account's labels are verified (Memory part 3,
// layout C), with browser contract fixtures as memory-replacement.spec.ts
// uses: the reads are the server's (subject-read.test.ts, overview.test.ts);
// this holds what the page draws from them, on a phone and a computer, in
// English and Hungarian. Synthetic data only.

const scope = { kind: "personal" } as const;
const ref = (rowId: string) => ({ scope, generation: "g1", rowId });
const index: MemorySubjectIndex = {
	authority: "hindsight",
	scope,
	generation: "g1",
	status: "ready",
	subjects: [
		{
			subject: "about_you",
			count: 3,
			preview: "Speaks Hungarian, English and some Portuguese.",
			active: false,
			earlierCount: 0,
			earlierPreview: [],
		},
		{
			subject: "home_family",
			count: 1,
			preview: "Studies in Lisbon; spends holidays with her parents in Graz.",
			active: false,
			earlierCount: 0,
			earlierPreview: [],
		},
		{
			subject: "work_study",
			count: 2,
			preview: "Third-year architecture student at the University of Lisbon.",
			active: false,
			earlierCount: 2,
			earlierPreview: ["An exam on 12 November", "A group project that ended"],
		},
		{
			subject: "projects",
			count: 2,
			preview: "Building a memory app for her family.",
			active: true,
			earlierCount: 0,
			earlierPreview: [],
		},
		{
			subject: "interests",
			count: 1,
			preview: "Plays a board game with friends on Fridays.",
			active: false,
			earlierCount: 0,
			earlierPreview: [],
		},
	],
	earlier: {
		count: 5,
		preview: ["A flu", "A toothache", "An exam on 12 November"],
	},
	currentCount: 9,
};
const degree = {
	ref: ref("degree"),
	text: "Third-year architecture student at the University of Lisbon.",
	subject: "work_study" as const,
	kind: "lasting" as const,
	timeState: "current" as const,
	lastMentionedAt: "2026-10-14T12:00:00.000Z",
	quietWeeks: null,
	earlierStates: [
		{ text: "Lived in Budapest", saidAt: "2025-03-14T09:30:00.000Z" },
	],
};
const thesis = {
	ref: ref("thesis"),
	text: "Writing a thesis on timber housing, due June 2027.",
	subject: "work_study" as const,
	kind: "ongoing" as const,
	timeState: "quiet" as const,
	lastMentionedAt: "2026-10-20T12:00:00.000Z",
	quietWeeks: 4,
	earlierStates: [],
};
const exam = {
	ref: ref("exam"),
	text: "An exam on 12 November.",
	subject: "work_study" as const,
	kind: "temporary" as const,
	timeState: "earlier" as const,
	lastMentionedAt: "2026-10-01T12:00:00.000Z",
	quietWeeks: null,
	earlierStates: [],
};
function subjectPage(
	subject: MemorySubjectPage["subject"],
	state: MemorySubjectPage["state"],
	entries: MemorySubjectPage["entries"],
): MemorySubjectPage {
	return {
		scope,
		generation: "g1",
		subject,
		state,
		entries,
		total: entries.length,
		nextCursor: null,
	};
}
const list: MemoryPage = {
	authority: "hindsight",
	scope,
	generation: "g1",
	rows: [
		{
			ref: degree.ref,
			text: degree.text,
			updatedAt: degree.lastMentionedAt,
			sourceCount: 1,
		},
	],
	nextCursor: null,
	total: 1,
	status: "ready",
};
const detail: MemoryDetail = {
	row: list.rows[0],
	sources: [],
	versions: [],
	canEdit: true,
	canRemove: true,
};
const OVERVIEW_TEXT =
	"Maya is a third-year architecture student in Lisbon who speaks Hungarian, English and some Portuguese, and is building a memory app for her family.";

const WORDS = {
	en: {
		subjects: ["About you", "Home and family", "Work and study", "Projects"],
		active: "active",
		earlier: "Earlier · 5",
		overview: "Overview of you",
		hint: "Written when you open it",
		search: "Search Memory",
		pane: "Work and study",
		lastMentioned: "Last mentioned 14 October",
		earlierState: "Earlier: Lived in Budapest · said March 2025",
		quiet: "quiet 4 weeks",
		fold: "Earlier in Work and study · 2",
		back: "Memory",
		writing: "Writing your overview…",
		writingFrom: "From your 9 current entries.",
		written:
			"Written just now from your 9 current entries. It is written again whenever your Memory changes, and it is never sent to chats.",
		rewrite: "Rewrite",
		done: "Done",
	},
	hu: {
		subjects: ["Rólad", "Otthon és család", "Munka és tanulás", "Projektek"],
		active: "aktív",
		earlier: "Korábbiak · 5",
		overview: "Áttekintés rólad",
		hint: "Megnyitáskor készül",
		search: "Keresés a Memóriában",
		pane: "Munka és tanulás",
		lastMentioned: "Utoljára említve: október 14.",
		earlierState: "Korábban: Lived in Budapest · 2025. március",
		quiet: "4 hete csendes",
		fold: "Korábbiak: Munka és tanulás · 2",
		back: "Memória",
		writing: "Készül az áttekintésed…",
		writingFrom: "9 aktuális bejegyzésedből.",
		written:
			"Most készült 9 aktuális bejegyzésedből. Ha változik a Memóriád, újra elkészül, és sosem kerül a beszélgetésekbe.",
		rewrite: "Újraírás",
		done: "Kész",
	},
} as const;

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

/** Serves the page's reads; the Overview's write waits until `release` is called. */
async function stub(page: Page) {
	let release: () => void = () => {};
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	const overviewWrites: unknown[] = [];
	const at = (path: string) => (url: URL) => url.pathname === path;
	await page.route(at("/api/knowledge/memory"), (route) =>
		route.fulfill({ json: list }),
	);
	await page.route(at("/api/knowledge/memory/degree"), (route) =>
		route.fulfill({ json: detail }),
	);
	await page.route(at("/api/knowledge/memory/subjects"), (route) =>
		route.fulfill({ json: index }),
	);
	await page.route(
		(url) => url.pathname.startsWith("/api/knowledge/memory/subjects/"),
		(route: Route) => {
			const url = new URL(route.request().url());
			const subject = url.pathname.split("/").at(-1);
			const state = url.searchParams.get("state");
			return route.fulfill({
				json:
					subject === "work_study" && state === "current"
						? subjectPage("work_study", "current", [degree, thesis])
						: subject === "work_study"
							? subjectPage("work_study", "earlier", [exam])
							: subjectPage("all", "earlier", [exam]),
			});
		},
	);
	await page.route(
		at("/api/knowledge/memory/scope-overview"),
		async (route) => {
			if (route.request().method() === "GET") {
				const none: MemoryOverview = {
					state: "none",
					currentCount: 9,
					text: null,
					writtenFrom: null,
					writtenAt: null,
				};
				return route.fulfill({ json: none });
			}
			overviewWrites.push(route.request().postDataJSON());
			await released;
			const written: MemoryOverview = {
				state: "written",
				currentCount: 9,
				text: OVERVIEW_TEXT,
				writtenFrom: 9,
				writtenAt: new Date().toISOString(),
			};
			return route.fulfill({ json: written });
		},
	);
	return { release, overviewWrites };
}

async function mount(page: Page, viewport: { width: number; height: number }) {
	await page.setViewportSize(viewport);
	await login(page);
	const stubs = await stub(page);
	await page.goto("/knowledge?tab=memory");
	await waitForHydration(page);
	await expect(page.getByTestId("memory-subjects")).toBeVisible();
	return stubs;
}

/** Nothing on the page is wider than the window, and no row is wider than itself. */
async function expectNoOverflow(page: Page) {
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth,
		),
	).toBe(true);
	const clipped = await page.evaluate(() =>
		[
			...document.querySelectorAll<HTMLElement>(
				".memory-subject-row, .memory-earlier-row, .memory-entry, .memory-overview-row, .memory-subjects-top",
			),
		]
			.filter((element) => element.scrollWidth > element.clientWidth + 1)
			.map((element) => element.className),
	);
	expect(clipped).toEqual([]);
}

test.afterEach(async () => {
	await setUiLanguage("en");
});

for (const language of ["en", "hu"] as const) {
	const words = WORDS[language];
	test(`a phone shows the index, a pushed subject, Earlier and the Overview sheet (${language})`, {
		tag: language === "en" ? "@smoke" : [],
	}, async ({ page }) => {
		await setUiLanguage(language);
		const { release, overviewWrites } = await mount(page, PHONE);
		const rows = page.locator(".memory-subject-row");
		await expect(rows).toHaveCount(5);
		for (const [i, name] of words.subjects.entries())
			await expect(rows.nth(i)).toContainText(name);
		await expect(rows.nth(3)).toContainText(words.active);
		const first = await rows.nth(0).boundingBox();
		const second = await rows.nth(1).boundingBox();
		expect(second?.y ?? 0).toBeGreaterThan(first?.y ?? 0);
		await expect(
			page.getByRole("button", { name: new RegExp(words.earlier) }),
		).toBeVisible();
		await expect(
			page.getByRole("searchbox", { name: words.search }),
		).toBeVisible();
		await expectNoOverflow(page);

		// An opened subject is a pushed screen with a back link to Memory.
		await rows.nth(2).click();
		const pane = page.getByTestId("memory-subject-pane");
		await expect(pane.getByRole("heading", { name: words.pane })).toBeFocused();
		await expect(rows.nth(0)).toBeHidden();
		await expect(pane).toContainText(words.lastMentioned);
		await expect(pane).toContainText(words.earlierState);
		await expect(pane).toContainText(words.quiet);
		await pane.getByRole("button", { name: new RegExp(words.fold) }).click();
		await expect(page.getByTestId("memory-earlier-fold")).toContainText(
			exam.text,
		);
		await expectNoOverflow(page);
		await pane.getByRole("button", { name: words.back }).click();
		await expect(rows.nth(2)).toBeFocused();

		// The Overview: a bottom sheet that writes itself, then Rewrite and Done.
		await page
			.getByRole("button", { name: new RegExp(words.overview) })
			.click();
		const sheet = page.getByTestId("memory-overview-sheet");
		await expect(sheet).toContainText(words.writing);
		await expect(sheet).toContainText(words.writingFrom);
		release();
		await expect(sheet).toContainText(OVERVIEW_TEXT);
		await expect(sheet).toContainText(words.written);
		await expect(
			page.getByRole("button", { name: words.rewrite, exact: true }),
		).toBeVisible();
		await waitForMotionToSettle(page);
		const dialog = await page.getByRole("dialog").boundingBox();
		expect(
			Math.round((dialog?.y ?? 0) + (dialog?.height ?? 0)),
		).toBeGreaterThanOrEqual(PHONE.height - 2);
		await expectNoOverflow(page);
		await page.getByRole("button", { name: words.done, exact: true }).click();
		await expect(sheet).toHaveCount(0);
		expect(overviewWrites).toEqual([{ rewrite: false }]);
	});

	test(`a computer shows tiles, the subject beside the index, and a centred Overview (${language})`, async ({
		page,
	}) => {
		await setUiLanguage(language);
		const { release } = await mount(page, DESKTOP);
		const rows = page.locator(".memory-subject-row");
		const first = await rows.nth(0).boundingBox();
		const second = await rows.nth(1).boundingBox();
		// Tiles: two subjects side by side.
		expect(Math.abs((first?.y ?? 0) - (second?.y ?? 1))).toBeLessThan(2);
		expect(second?.x ?? 0).toBeGreaterThan(first?.x ?? 0);

		// The opened subject is a pane beside the index, which becomes a list.
		await rows.nth(2).click();
		const pane = page.getByTestId("memory-subject-pane");
		await expect(pane.getByRole("heading", { name: words.pane })).toBeVisible();
		await expect(rows.nth(0)).toBeVisible();
		await expect(rows.nth(2)).toHaveAttribute("aria-current", "true");
		await expect(pane.getByRole("button", { name: words.back })).toBeHidden();
		const list = await rows.nth(0).boundingBox();
		const paneBox = await pane.boundingBox();
		expect(paneBox?.x ?? 0).toBeGreaterThan(
			(list?.x ?? 0) + (list?.width ?? 0),
		);
		await expect(pane).toContainText(words.earlierState);

		await page
			.getByRole("button", { name: new RegExp(words.overview) })
			.click();
		const sheet = page.getByTestId("memory-overview-sheet");
		await expect(sheet).toContainText(words.writing);
		release();
		await expect(sheet).toContainText(words.written);
		await waitForMotionToSettle(page);
		const dialog = await page.getByRole("dialog").boundingBox();
		const middle = (dialog?.y ?? 0) + (dialog?.height ?? 0) / 2;
		expect(Math.abs(middle - DESKTOP.height / 2)).toBeLessThan(
			DESKTOP.height / 4,
		);
		await page.getByRole("button", { name: words.done, exact: true }).click();
		await expect(sheet).toHaveCount(0);
	});
}

test("Hungarian rows fit a 360px phone", async ({ page }) => {
	await setUiLanguage("hu");
	await mount(page, { width: 360, height: 780 });
	await expectNoOverflow(page);
	await page.locator(".memory-subject-row").nth(2).click();
	await expect(page.getByTestId("memory-subject-pane")).toContainText(
		WORDS.hu.quiet,
	);
	await expectNoOverflow(page);
});

test("a Workspace Search link opens its entry on the subject index, and Back returns to the index", async ({
	page,
}) => {
	await login(page);
	await stub(page);
	await page.goto(
		"/knowledge?tab=memory&memoryScope=personal&memoryEntry=degree&memoryQuery=architecture",
	);
	await waitForHydration(page);
	await expect(page.getByTestId("memory-detail")).toContainText(degree.text);
	await page.getByRole("button", { name: "Back to memories" }).click();
	await expect(page.getByTestId("memory-subjects")).toBeVisible();
	await expect(page.locator(".memory-subject-row")).toHaveCount(5);
});

test("an account whose labels are not verified keeps today's list", async ({
	page,
}) => {
	const restore = keepAdminOnTodaysMemoryPage();
	try {
		await login(page);
		await stub(page);
		await page.goto("/knowledge?tab=memory");
		await waitForHydration(page);
		await expect(page.getByTestId("memory-list")).toBeVisible();
		await expect(page.getByTestId("memory-subjects")).toHaveCount(0);
	} finally {
		restore();
	}
});
