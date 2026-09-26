// The App suite's browser pass (Feature 2 · Artifacts, decisions.md ruling
// 56 / slice-2.md Task A9 Step 3): headless-Chromium evaluation of one
// generated app, ported from the P1 prototype's own
// `.claude/worktrees/agent-afcaa6f617ee84abe/scripts/prototype-artifact-apps/evaluate.ts`
// rather than reinventing the interception, per the ruling. Behavior is
// unchanged from the prototype:
//  - four page loads: 1280x800 and 390x844, light and dark
//  - every request except the document itself is aborted (the contract says
//    "no network")
//  - window.alfy.storage is injected before any app script runs
//  - console errors and uncaught exceptions are captured
//  - one smoke interaction on the light desktop page (type into the first
//    input, click up to a few enabled buttons, stop at the first one that
//    changes the DOM)
//  - one screenshot per page run, written under the caller's `outDir`
//
// This module owns the mechanics only; `suites/apps.ts`'s `evaluateAppEval`
// (the suite's SuiteEvaluator) decides WHEN to call it (only once extraction
// already found a fenced app — nothing to evaluate otherwise) and
// `score.ts`-shaped verdict rules live in `suites/apps.ts` too, alongside
// the suite's existing static-audit scorer.
import { join } from "node:path";
import type { Browser, Page } from "playwright";

export type PageRun = {
	label: string;
	colorScheme: "light" | "dark";
	viewport: { width: number; height: number };
	screenshot: string;
	consoleErrors: string[];
	pageErrors: string[];
	blockedRequests: string[];
	textLength: number;
	textSample: string;
	controlCount: number;
	storageGets: number;
	storageSets: number;
	storageKeys: string[];
};

export type InteractionRun = {
	inputSelector: string | null;
	inputValue: string | null;
	buttonText: string | null;
	/** Labels of every button the smoke test clicked, in order. */
	clickedButtons: string[];
	/** The button whose click changed the DOM, when one did. */
	domChangedAfter: string | null;
	clicked: boolean;
	domChanged: boolean;
	textBefore: number;
	textAfter: number;
	htmlChanged: boolean;
	storageSetsBefore: number;
	storageSetsAfter: number;
	storageKeys: string[];
	dialogs: string[];
	note: string | null;
};

export type AppEvaluation = {
	pages: PageRun[];
	interaction: InteractionRun;
	/** Union of the console/page errors reported by all four page runs. */
	consoleErrors: string[];
	pageErrors: string[];
	blockedRequests: string[];
	storageGets: number;
	storageSets: number;
	storageKeys: string[];
};

const STORAGE_MOCK = () => {
	type Mem = Record<string, unknown>;
	const w = window as unknown as {
		alfy?: unknown;
		__alfyMem?: Mem;
		__alfyCalls?: [string, string][];
	};
	const mem: Mem = {};
	w.__alfyMem = mem;
	w.__alfyCalls = [];
	w.alfy = {
		storage: {
			get(key: string) {
				w.__alfyCalls?.push(["get", key]);
				return Promise.resolve(Object.hasOwn(mem, key) ? mem[key] : null);
			},
			set(key: string, value: unknown) {
				w.__alfyCalls?.push(["set", key]);
				mem[key] = value;
				return Promise.resolve(true);
			},
		},
	};
};

/**
 * How long the smoke interaction watches the DOM after the click. Apps with
 * a 1 Hz display (a pomodoro countdown) legitimately change nothing within a
 * few hundred milliseconds, so the window is a named constant rather than a
 * guess (the prototype's own PROTO_APPS_INTERACTION_WAIT_MS default).
 */
const SMOKE_WAIT_MS = 700;

/** How many visible enabled buttons the smoke test is willing to try (the
 * prototype's own PROTO_APPS_CLICK_LIMIT default). */
const SMOKE_CLICK_LIMIT = 4;

const SHOT_VIEWPORTS: {
	label: string;
	colorScheme: "light" | "dark";
	viewport: { width: number; height: number };
}[] = [
	{
		label: "light-1280",
		colorScheme: "light",
		viewport: { width: 1280, height: 800 },
	},
	{
		label: "dark-1280",
		colorScheme: "dark",
		viewport: { width: 1280, height: 800 },
	},
	{
		label: "light-390",
		colorScheme: "light",
		viewport: { width: 390, height: 844 },
	},
	{
		label: "dark-390",
		colorScheme: "dark",
		viewport: { width: 390, height: 844 },
	},
];

export async function evaluateApp(
	browser: Browser,
	html: string,
	appId: string,
	outDir: string,
): Promise<AppEvaluation> {
	const pages: PageRun[] = [];
	let interaction: InteractionRun | null = null;

	for (const shot of SHOT_VIEWPORTS) {
		const context = await browser.newContext({
			viewport: shot.viewport,
			colorScheme: shot.colorScheme,
			deviceScaleFactor: 1,
		});
		await context.addInitScript(STORAGE_MOCK);

		const blocked: string[] = [];
		await context.route("**/*", (route) => {
			const url = route.request().url();
			if (
				url.startsWith("about:") ||
				url.startsWith("data:") ||
				url.startsWith("blob:")
			) {
				return route.continue();
			}
			if (blocked.length < 10) blocked.push(url);
			return route.abort();
		});

		const page = await context.newPage();
		const consoleErrors: string[] = [];
		const pageErrors: string[] = [];
		const dialogs: string[] = [];

		page.on("console", (message) => {
			if (message.type() === "error") consoleErrors.push(trim(message.text()));
		});
		page.on("pageerror", (error) => pageErrors.push(trim(error.message)));
		page.on("dialog", (dialog) => {
			dialogs.push(`${dialog.type()}: ${trim(dialog.message())}`);
			void dialog.dismiss().catch(() => {});
		});

		let screenshot = "";
		try {
			await page.setContent(html, { waitUntil: "load", timeout: 15_000 });
			await page.waitForTimeout(600);
			screenshot = `shot-${appId}-${shot.label}.png`;
			await page.screenshot({
				path: join(outDir, screenshot),
				fullPage: false,
			});
		} catch (error) {
			pageErrors.push(
				`harness: setContent/screenshot failed: ${(error as Error).message}`,
			);
		}

		const stats = await readStats(page);
		const pageRun: PageRun = {
			label: shot.label,
			colorScheme: shot.colorScheme,
			viewport: shot.viewport,
			screenshot,
			consoleErrors,
			pageErrors,
			blockedRequests: blocked,
			textLength: stats.textLength,
			textSample: stats.textSample,
			controlCount: stats.controlCount,
			storageGets: stats.storageGets,
			storageSets: stats.storageSets,
			storageKeys: stats.storageKeys,
		};
		pages.push(pageRun);

		// The smoke interaction runs on the light desktop page only.
		if (shot.label === "light-1280") {
			interaction = await smokeInteraction(page, dialogs);
			const after = await readStats(page);
			pageRun.storageGets = after.storageGets;
			pageRun.storageSets = after.storageSets;
			pageRun.storageKeys = after.storageKeys;
		}

		await context.close();
	}

	if (!interaction) {
		interaction = emptyInteraction("harness: no light-1280 page run");
	}

	return {
		pages,
		interaction,
		consoleErrors: unique(pages.flatMap((p) => p.consoleErrors)),
		pageErrors: unique(pages.flatMap((p) => p.pageErrors)),
		blockedRequests: unique(pages.flatMap((p) => p.blockedRequests)),
		storageGets: Math.max(0, ...pages.map((p) => p.storageGets)),
		storageSets: Math.max(0, ...pages.map((p) => p.storageSets)),
		storageKeys: unique(pages.flatMap((p) => p.storageKeys)),
	};
}

async function readBodyHtml(page: Page): Promise<string> {
	return page.evaluate(() =>
		(document.body?.innerHTML ?? "").length.toString(),
	);
}

async function readStats(page: Page): Promise<{
	textLength: number;
	textSample: string;
	controlCount: number;
	storageGets: number;
	storageSets: number;
	storageKeys: string[];
}> {
	return page.evaluate(() => {
		const body = document.body;
		const text = (body?.innerText ?? "").replace(/\s+/g, " ").trim();
		const controls = body
			? body.querySelectorAll(
					"button, input, select, textarea, [role=button], a[href]",
				).length
			: 0;
		const w = window as unknown as {
			__alfyCalls?: [string, string][];
			__alfyMem?: Record<string, unknown>;
		};
		const calls = w.__alfyCalls ?? [];
		return {
			textLength: text.length,
			textSample: text.slice(0, 220),
			controlCount: controls,
			storageGets: calls.filter((c) => c[0] === "get").length,
			storageSets: calls.filter((c) => c[0] === "set").length,
			storageKeys: Object.keys(w.__alfyMem ?? {}).slice(0, 8),
		};
	});
}

async function smokeInteraction(
	page: Page,
	dialogs: string[],
): Promise<InteractionRun> {
	const before = await page.evaluate(() => {
		const w = window as unknown as { __alfyCalls?: [string, string][] };
		return {
			text: (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().length,
			html: (document.body?.innerHTML ?? "").length,
			sets: (w.__alfyCalls ?? []).filter((c) => c[0] === "set").length,
		};
	});

	const result: InteractionRun = {
		inputSelector: null,
		inputValue: null,
		buttonText: null,
		clickedButtons: [],
		domChangedAfter: null,
		clicked: false,
		domChanged: false,
		textBefore: before.text,
		textAfter: before.text,
		htmlChanged: false,
		storageSetsBefore: before.sets,
		storageSetsAfter: before.sets,
		storageKeys: [],
		dialogs,
		note: null,
	};

	const input = page
		.locator(
			"input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]), textarea",
		)
		.filter({ visible: true })
		.first();
	try {
		if ((await input.count()) > 0) {
			const type = (await input.getAttribute("type")) ?? "text";
			const value =
				type === "number" || type === "range" || type === "date"
					? "42"
					: "teszt";
			await input.fill(value, { timeout: 3000 });
			result.inputSelector = `input[type=${type}]`;
			result.inputValue = value;
		}
	} catch (error) {
		result.note = `fill failed: ${(error as Error).message}`;
	}

	// Click up to SMOKE_CLICK_LIMIT buttons and stop at the first one that does
	// something. A single "first button" is a coin flip: in the flashcard app it
	// is the already-active category tab, whose correct behaviour is a no-op.
	const buttons = page.locator("button:enabled").filter({ visible: true });
	const buttonCount = Math.min(await buttons.count(), SMOKE_CLICK_LIMIT);
	for (let index = 0; index < buttonCount; index += 1) {
		const button = buttons.nth(index);
		const htmlBeforeClick = await readBodyHtml(page);
		let label = "";
		try {
			label = trim((await button.innerText()) || "");
			await button.click({ timeout: 3000 });
			result.clicked = true;
			result.buttonText = label;
			result.clickedButtons.push(label);
		} catch (error) {
			result.note = `${result.note ? `${result.note}; ` : ""}click "${label}" failed: ${(error as Error).message}`;
			continue;
		}
		await page.waitForTimeout(SMOKE_WAIT_MS);
		if ((await readBodyHtml(page)) !== htmlBeforeClick) {
			result.domChanged = true;
			result.domChangedAfter = label;
			break;
		}
	}

	const after = await page.evaluate(() => {
		const w = window as unknown as {
			__alfyCalls?: [string, string][];
			__alfyMem?: Record<string, unknown>;
		};
		const calls = w.__alfyCalls ?? [];
		return {
			text: (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().length,
			html: (document.body?.innerHTML ?? "").length,
			sets: calls.filter((c) => c[0] === "set").length,
			keys: Object.keys(w.__alfyMem ?? {}),
		};
	});

	result.textAfter = after.text;
	result.htmlChanged = after.html !== before.html;
	result.domChanged =
		result.domChanged ||
		after.html !== before.html ||
		after.text !== before.text;
	result.storageSetsAfter = after.sets;
	result.storageKeys = after.keys.slice(0, 8);
	if (!result.clicked)
		result.note = `${result.note ? `${result.note}; ` : ""}no enabled button found`;

	return result;
}

function emptyInteraction(note: string): InteractionRun {
	return {
		inputSelector: null,
		inputValue: null,
		buttonText: null,
		clickedButtons: [],
		domChangedAfter: null,
		clicked: false,
		domChanged: false,
		textBefore: 0,
		textAfter: 0,
		htmlChanged: false,
		storageSetsBefore: 0,
		storageSetsAfter: 0,
		storageKeys: [],
		dialogs: [],
		note,
	};
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}

function trim(value: string): string {
	return value.replace(/\s+/g, " ").trim().slice(0, 300);
}
