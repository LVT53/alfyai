// The App suite's browser pass (Feature 2 · Artifacts, decisions.md rulings
// 56 and 58 / slice-2.md Task A9 Step 3): headless-Chromium evaluation of one
// generated app, ported from the P1 prototype's own
// `.claude/worktrees/agent-afcaa6f617ee84abe/scripts/prototype-artifact-apps/evaluate.ts`
// rather than reinventing the interception, per ruling 56 — then corrected by
// ruling 58 to run each app "the way users get it":
//  - the app is loaded inside a CHILD IFRAME carrying the product's exact
//    `sandbox` attribute, and the iframe's document is served with the
//    product's exact CSP header — both read from
//    `artifacts/app/sandbox-response.ts`'s `APP_SANDBOX_CSP`/
//    `APP_SANDBOX_HEADERS` (reused, never copied — RV-2A's own sandbox
//    review owns that file, and whatever it lands there is what this harness
//    measures against, automatically, with no edit here)
//  - the bootstrap is the REAL one (`artifacts/app/bootstrap.ts`'s
//    `injectAppBootstrap`), not a test-only mock: it talks to "the parent" by
//    `postMessage`, exactly as it does in production, so a form's `submit`
//    not firing, `confirm()` returning false, and `eval` throwing are all
//    the SAME opaque-origin-sandbox effects the product's own frame has —
//    this is the whole reason ruling 58 exists (4 of 10 recorded apps had a
//    dead main action while the P1 harness, which ran top-level with no
//    sandbox at all, scored them "works")
//  - this module plays "the parent": it answers the bootstrap's
//    `alfy.storage` postMessage protocol with an in-memory store, the same
//    role `AppFrame.svelte` plays for real (kv persistence itself stays
//    in-memory here, per ruling 56 — only the sandbox/CSP/bootstrap-injection
//    boundary needed to become production-accurate)
//  - four page loads: 1280x800 and 390x844, light and dark
//  - every request except the served document itself is aborted (the
//    contract says "no network")
//  - console errors and uncaught exceptions are captured (Page-level events
//    aggregate across all of a page's frames, including the app's)
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
import type { Browser, Frame, Page } from "playwright";
import { injectAppBootstrap } from "$lib/server/services/artifacts/app/bootstrap";
import {
	APP_SANDBOX_CSP,
	APP_SANDBOX_HEADERS,
} from "$lib/server/services/artifacts/app/sandbox-response";

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

/**
 * A fake, never-dialed origin: `context.route` fulfills every request to it —
 * there is no real server, so nothing outside this harness's own routing
 * ever answers it. Neither path is ever counted as a "blocked" request, the
 * same way `about:`/`data:`/`blob:` never are.
 *
 * The parent shell is served from THIS SAME ORIGIN, not `page.setContent` /
 * `about:blank`: `APP_SANDBOX_CSP`'s `frame-ancestors 'self'` (ruling 58's
 * own defense-in-depth, unchanged by this harness) refuses to let the served
 * app frame into a page of any OTHER origin, exactly as it would refuse a
 * hostile parent in production — the harness has to satisfy the same rule
 * the product enforces, not work around it.
 */
const SERVED_APP_ORIGIN = "https://app.eval.alfyai.invalid";
const SERVED_APP_PATH = "/served-app.html";
const SERVED_APP_URL = `${SERVED_APP_ORIGIN}${SERVED_APP_PATH}`;
const PARENT_SHELL_PATH = "/parent-shell.html";
const PARENT_SHELL_URL = `${SERVED_APP_ORIGIN}${PARENT_SHELL_PATH}`;

/**
 * Reads the iframe `sandbox` attribute's value out of the product's own CSP
 * string (ruling 58: "read the value from the shared constant so both land
 * together") — never a hand-typed copy that could drift the moment
 * RV-2A's sandbox review changes it.
 */
function extractSandboxAttribute(csp: string): string {
	const match = csp.match(/(?:^|;)\s*sandbox\s+([^;]+)/i);
	if (!match) {
		throw new Error(
			"APP_SANDBOX_CSP has no 'sandbox' directive to read the iframe attribute from",
		);
	}
	return match[1].trim();
}

const IFRAME_SANDBOX_ATTRIBUTE = extractSandboxAttribute(APP_SANDBOX_CSP);

/**
 * The harness's own parent shell: one iframe, sized to fill the viewport (so
 * a screenshot of the PAGE still shows the app's full rendered surface), and
 * the "parent" half of the bootstrap's `alfy.storage` postMessage protocol —
 * an in-memory store per case, exactly the role `AppFrame.svelte` plays for
 * real. `event.source.postMessage` replies to whichever frame asked (this
 * harness only ever embeds the one app frame, so there is no
 * `event.source`/id check to make — the product's own listener carries that;
 * this file measures the SANDBOX's effect on the app, not re-implements the
 * parent's trust boundary).
 */
function buildParentShellHtml(sandboxAttribute: string): string {
	return `<!doctype html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0">
<iframe id="app" sandbox="${sandboxAttribute}" src="${SERVED_APP_URL}"
  style="position:fixed;inset:0;width:100%;height:100%;border:0;display:block"></iframe>
<script>
(function () {
  var mem = {};
  window.__parentAlfyCalls = [];
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.v !== 1 || data.kind !== "alfy.storage") return;
    window.__parentAlfyCalls.push([data.method, data.args && data.args[0]]);
    var reply = { v: 1, kind: "alfy.storage.result", id: data.id, ok: true, value: null };
    if (data.method === "get") {
      var key = data.args[0];
      reply.value = Object.prototype.hasOwnProperty.call(mem, key) ? mem[key] : null;
    } else if (data.method === "set") {
      mem[data.args[0]] = data.args[1];
      reply.value = true;
    } else {
      reply.ok = false;
      reply.error = "unknown method";
    }
    event.source.postMessage(reply, "*");
  });
  window.__parentAlfyMem = mem;
})();
</script>
</body></html>`;
}

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
	const servedHtml = injectAppBootstrap(html);
	const pages: PageRun[] = [];
	let interaction: InteractionRun | null = null;

	for (const shot of SHOT_VIEWPORTS) {
		const context = await browser.newContext({
			viewport: shot.viewport,
			colorScheme: shot.colorScheme,
			deviceScaleFactor: 1,
		});

		const blocked: string[] = [];
		await context.route("**/*", (route) => {
			const url = route.request().url();
			if (url === SERVED_APP_URL) {
				return route.fulfill({
					status: 200,
					headers: APP_SANDBOX_HEADERS,
					body: servedHtml,
				});
			}
			if (url === PARENT_SHELL_URL) {
				return route.fulfill({
					status: 200,
					contentType: "text/html; charset=utf-8",
					body: buildParentShellHtml(IFRAME_SANDBOX_ATTRIBUTE),
				});
			}
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
		// A sandboxed iframe with no allow-modals suppresses alert/confirm/
		// prompt outright (confirm() synchronously returns false) — this
		// handler is a safety net for the harness's OWN parent shell, not the
		// app; ruling 58's contract/audit changes are what catch a dialog call
		// in the app's source (see suites/apps.ts's audit-rule folding).
		page.on("dialog", (dialog) => {
			dialogs.push(`${dialog.type()}: ${trim(dialog.message())}`);
			void dialog.dismiss().catch(() => {});
		});

		let screenshot = "";
		let frame: Frame | null = null;
		try {
			await page.goto(PARENT_SHELL_URL, { waitUntil: "load", timeout: 15_000 });
			const frameElement = await page.waitForSelector("iframe#app", {
				timeout: 15_000,
			});
			frame = await frameElement.contentFrame();
			if (!frame) throw new Error("the app iframe never attached a document");
			await frame.waitForLoadState("load", { timeout: 15_000 });
			await page.waitForTimeout(600);
			screenshot = `shot-${appId}-${shot.label}.png`;
			await page.screenshot({
				path: join(outDir, screenshot),
				fullPage: false,
			});
		} catch (error) {
			pageErrors.push(
				`harness: iframe load/screenshot failed: ${(error as Error).message}`,
			);
		}

		const stats = await readStats(page, frame);
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
		if (shot.label === "light-1280" && frame) {
			interaction = await smokeInteraction(page, frame, dialogs);
			const after = await readStats(page, frame);
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

async function readBodyHtml(frame: Frame): Promise<string> {
	return frame.evaluate(() =>
		(document.body?.innerHTML ?? "").length.toString(),
	);
}

async function readStats(
	page: Page,
	frame: Frame | null,
): Promise<{
	textLength: number;
	textSample: string;
	controlCount: number;
	storageGets: number;
	storageSets: number;
	storageKeys: string[];
}> {
	const domStats = frame
		? await frame.evaluate(() => {
				const body = document.body;
				const text = (body?.innerText ?? "").replace(/\s+/g, " ").trim();
				const controls = body
					? body.querySelectorAll(
							"button, input, select, textarea, [role=button], a[href]",
						).length
					: 0;
				return {
					textLength: text.length,
					textSample: text.slice(0, 220),
					controlCount: controls,
				};
			})
		: { textLength: 0, textSample: "", controlCount: 0 };

	// The storage log lives on the PARENT shell (this file's own script), not
	// the app's frame: the bootstrap never exposes a test hook of its own,
	// exactly like production's real bridge.
	const storageStats = await page.evaluate(() => {
		const w = window as unknown as {
			__parentAlfyCalls?: [string, string][];
			__parentAlfyMem?: Record<string, unknown>;
		};
		const calls = w.__parentAlfyCalls ?? [];
		return {
			storageGets: calls.filter((c) => c[0] === "get").length,
			storageSets: calls.filter((c) => c[0] === "set").length,
			storageKeys: Object.keys(w.__parentAlfyMem ?? {}).slice(0, 8),
		};
	});

	return { ...domStats, ...storageStats };
}

async function smokeInteraction(
	page: Page,
	frame: Frame,
	dialogs: string[],
): Promise<InteractionRun> {
	const before = await frame.evaluate(() => ({
		text: (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().length,
		html: (document.body?.innerHTML ?? "").length,
	}));
	const beforeSets = await page.evaluate(() => {
		const w = window as unknown as { __parentAlfyCalls?: [string, string][] };
		return (w.__parentAlfyCalls ?? []).filter((c) => c[0] === "set").length;
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
		storageSetsBefore: beforeSets,
		storageSetsAfter: beforeSets,
		storageKeys: [],
		dialogs,
		note: null,
	};

	const input = frame
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
	const buttons = frame.locator("button:enabled").filter({ visible: true });
	const buttonCount = Math.min(await buttons.count(), SMOKE_CLICK_LIMIT);
	for (let index = 0; index < buttonCount; index += 1) {
		const button = buttons.nth(index);
		const htmlBeforeClick = await readBodyHtml(frame);
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
		if ((await readBodyHtml(frame)) !== htmlBeforeClick) {
			result.domChanged = true;
			result.domChangedAfter = label;
			break;
		}
	}

	const after = await frame.evaluate(() => ({
		text: (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().length,
		html: (document.body?.innerHTML ?? "").length,
	}));
	const afterStorage = await page.evaluate(() => {
		const w = window as unknown as {
			__parentAlfyCalls?: [string, string][];
			__parentAlfyMem?: Record<string, unknown>;
		};
		const calls = w.__parentAlfyCalls ?? [];
		return {
			sets: calls.filter((c) => c[0] === "set").length,
			keys: Object.keys(w.__parentAlfyMem ?? {}),
		};
	});

	result.textAfter = after.text;
	result.htmlChanged = after.html !== before.html;
	result.domChanged =
		result.domChanged ||
		after.html !== before.html ||
		after.text !== before.text;
	result.storageSetsAfter = afterStorage.sets;
	result.storageKeys = afterStorage.keys.slice(0, 8);
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
