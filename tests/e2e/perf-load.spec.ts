// A load-measurement harness, not a test: it measures how the deployed app
// loads over a slow connection on a slow CPU, writes everything it saw as JSON
// and a short report, and asserts nothing about the numbers.
//
// It is INERT everywhere else. The release gate, the smoke tier and every
// normal run skip it at collection time (one line, no page, no server call):
//
//   PERF_RUN=1 npx playwright test tests/e2e/perf-load.spec.ts \
//     --project=chromium --reporter=line --workers=1
//
// The five scenarios share one test because they share state on purpose: the
// warm reload reuses the cold landing's context (and its cache), and the
// landing → chat transition reuses the conversation the cold chat scenario was
// measured with. Every scenario is isolated in its own try/catch, so one that
// cannot be measured is recorded as such and the rest still run.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type Browser,
	type BrowserContext,
	type CDPSession,
	type Page,
	test,
} from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import { users } from "../../src/lib/server/db/schema";
import { createConversation as createServerConversation } from "../../src/lib/server/services/conversations";
import { createMessage } from "../../src/lib/server/services/messages";
import { e2eBaseUrl, e2eSlot } from "./e2e-env";
import { TEST_EMAIL, TEST_PASSWORD } from "./helpers";

test.skip(!process.env.PERF_RUN, "measurement harness: set PERF_RUN=1");

// ---------------------------------------------------------------- the profile

const THROTTLE = {
	latencyMs: 400,
	downloadThroughputBps: 51200,
	uploadThroughputBps: 51200,
	connectionType: "cellular3g",
	cpuThrottleRate: 4,
} as const;

const BASE_URL = e2eBaseUrl(e2eSlot());

/** The composer's own field: the app's primary control on both `/` and `/chat/<id>`. */
const USABLE_SELECTOR = '[data-testid="message-input"]';

/** SvelteKit renders this once the root component has mounted (`waitForHydration`). */
const HYDRATED_SELECTOR = "#svelte-announcer";

/** The chat surface (MessageArea). The landing page has no scroll container of its own. */
const CHAT_SURFACE_SELECTOR = ".scroll-container";

/** Generous: a cold document at 50 KB/s and CPU ×4 is slow by construction. */
const OP_TIMEOUT_MS = 120_000;
const CLICK_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 1_200_000;

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

const CONVERSATION_MESSAGES = 8;

// ------------------------------------------------------------------- outputs

const OUTPUT_DIR = join(process.cwd(), "docs", "plans", "perf-load-2026-11");

function localDateStamp(): string {
	const now = new Date();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${now.getFullYear()}-${month}-${day}`;
}

const DATE_STAMP = localDateStamp();

// --------------------------------------------------------------------- types

type CacheMode = "cold" | "warm";

type Viewport = { width: number; height: number };

type ResourceType =
	| "script"
	| "stylesheet"
	| "font"
	| "image"
	| "fetch"
	| "other";

type ResourceRecord = {
	name: string;
	initiatorType: string;
	type: ResourceType;
	startTime: number;
	duration: number;
	responseStart: number;
	responseEnd: number;
	transferSize: number;
	encodedBodySize: number;
	decodedBodySize: number;
};

type TypeSummary = {
	requests: number;
	transferBytes: number;
	encodedBodySize: number;
};

type BiggestResource = {
	name: string;
	type: ResourceType;
	transferSize: number;
	duration: number;
	startTime: number;
	responseEnd: number;
};

type Aggregates = {
	requestCount: number;
	totalTransferBytes: number;
	totalEncodedBodySize: number;
	totalDecodedBodySize: number;
	byType: Record<ResourceType, TypeSummary>;
	scriptChunkCount: number;
	lastScriptResponseEndMs: number;
	cachedResourceCount: number;
	biggest: BiggestResource[];
};

type NavigationTiming = {
	type: string;
	redirectCount: number;
	redirectStart: number;
	redirectEnd: number;
	requestStart: number;
	responseStart: number;
	responseEnd: number;
	ttfbMs: number;
	domInteractive: number;
	domContentLoadedEventStart: number;
	domContentLoadedEventEnd: number;
	loadEventStart: number;
	loadEventEnd: number;
	duration: number;
	transferSize: number;
	encodedBodySize: number;
	decodedBodySize: number;
};

type PaintSummary = {
	fcpMs: number | null;
	lcpMs: number | null;
	lcpEntries: Array<{
		startTime: number;
		size: number;
		element: string | null;
		url: string | null;
	}>;
	firstSeenAtMs: number | null;
	firstInputAtMs: number | null;
};

type ClsSummary = {
	total: number;
	excludingRecentInput: number;
	entries: Array<{
		startTime: number;
		value: number;
		hadRecentInput: boolean;
	}>;
};

type LongTaskSummary = {
	count: number;
	totalMs: number;
	tbtApproxMs: number;
	longest: { startTime: number; duration: number; name: string } | null;
	entries: Array<{ startTime: number; duration: number; name: string }>;
};

type UsableSummary = {
	selector: string;
	method: string;
	existsAtMs: number | null;
	clickedAtMs: number | null;
	usableApproxMs: number | null;
	clickMethod: string;
	clickError: string | null;
	hydratedAtMs: number | null;
	hydrationError: string | null;
	caveat: string;
};

type ScenarioStatus = "ok" | "partial" | "failed" | "not-measured";

type ScenarioResult = {
	id: string;
	label: string;
	kind: "document" | "client-nav" | "unknown";
	status: ScenarioStatus;
	startedAt: string;
	durationMs: number;
	error?: string;
	notMeasuredReason?: string;
	url?: string;
	viewport?: Viewport;
	cache?: { mode: CacheMode; detail: string };
	throttle?: typeof THROTTLE;
	documentStatus?: number | null;
	navigation?: NavigationTiming | null;
	paints?: PaintSummary | null;
	cls?: ClsSummary | null;
	longTasks?: LongTaskSummary | null;
	performanceMetrics?: Record<string, number>;
	performanceMetricsBaseline?: Record<string, number>;
	performanceMetricsDelta?: Record<string, number>;
	performanceMetricsBeforeClick?: Record<string, number>;
	resources?: ResourceRecord[];
	aggregates?: Aggregates;
	usable?: UsableSummary | null;
	pageErrors?: string[];
	consoleErrors?: string[];
	requestFailures?: Array<{ url: string; failure: string }>;
	notes?: string[];
	/** Client-side transition only: the document that preceded the click, measured the same way. */
	landingDocument?: ScenarioResult;
	transition?: {
		linkSelector: string | null;
		clickedAtMs: number | null;
		urlChangedAtMs: number | null;
		chatSurfaceAtMs: number | null;
		composerVisibleAtMs: number | null;
		usableAtMs: number | null;
		usableFromClickMs: number | null;
		usableFromNavStartMs: number | null;
	} | null;
	paintsNote?: string;
};

type RunMeta = {
	startedAt: string;
	generatedAt: string;
	complete: boolean;
	node: string;
	baseUrl: string;
	commit: string | null;
	throttle: typeof THROTTLE;
	usableSelector: string;
	scenarios: string[];
	cache: string;
	classification: string;
	signIn: string;
};

// ------------------------------------------------------------- in-page pieces

type PerfState = {
	fcpMs: number | null;
	lcp: Array<{
		startTime: number;
		size: number;
		element: string | null;
		url: string | null;
	}>;
	cls: Array<{ startTime: number; value: number; hadRecentInput: boolean }>;
	longTasks: Array<{ startTime: number; duration: number; name: string }>;
	firstSeenAtMs: number | null;
	firstInputAtMs: number | null;
};

/**
 * Installs the observers before the document's own scripts run. A reload gets a
 * fresh document, so it gets a fresh state (and fresh paint/LCP/CLS numbers);
 * a client-side navigation keeps both, which is why the transition scenario
 * only reads entries after the click.
 */
async function installPerfRecorder(page: Page): Promise<void> {
	await page.addInitScript((usableSelector: string) => {
		const state: {
			fcpMs: number | null;
			lcp: Array<{
				startTime: number;
				size: number;
				element: string | null;
				url: string | null;
			}>;
			cls: Array<{
				startTime: number;
				value: number;
				hadRecentInput: boolean;
			}>;
			longTasks: Array<{
				startTime: number;
				duration: number;
				name: string;
			}>;
			firstSeenAtMs: number | null;
			firstInputAtMs: number | null;
		} = {
			fcpMs: null,
			lcp: [],
			cls: [],
			longTasks: [],
			firstSeenAtMs: null,
			firstInputAtMs: null,
		};
		(window as unknown as { __perfLoad: typeof state }).__perfLoad = state;

		// A landing page can pull more than the 250-entry default buffer; without
		// raising it the earliest chunks would fall out of the resource list.
		try {
			performance.setResourceTimingBufferSize(5000);
		} catch {
			// an engine without the setter keeps its default buffer
		}

		const observe = (
			type: string,
			callback: (entries: PerformanceEntryList) => void,
		) => {
			try {
				const observer = new PerformanceObserver((list) =>
					callback(list.getEntries()),
				);
				observer.observe({ type, buffered: true });
			} catch {
				// this entry type does not exist here
			}
		};

		observe("paint", (entries) => {
			for (const entry of entries) {
				if (entry.name === "first-contentful-paint") {
					state.fcpMs = entry.startTime;
				}
			}
		});

		observe("largest-contentful-paint", (entries) => {
			for (const entry of entries) {
				const candidate = entry as PerformanceEntry & {
					size?: number;
					element?: Element | null;
					url?: string;
				};
				const element = candidate.element ?? null;
				state.lcp.push({
					startTime: entry.startTime,
					size: Number(candidate.size ?? 0),
					element: element
						? (element.getAttribute("data-testid") ??
							element.id ??
							element.getAttribute("class") ??
							element.tagName.toLowerCase())
						: null,
					url: candidate.url || null,
				});
			}
		});

		observe("layout-shift", (entries) => {
			for (const entry of entries) {
				const shift = entry as PerformanceEntry & {
					value?: number;
					hadRecentInput?: boolean;
				};
				state.cls.push({
					startTime: entry.startTime,
					value: Number(shift.value ?? 0),
					hadRecentInput: shift.hadRecentInput === true,
				});
			}
		});

		observe("longtask", (entries) => {
			for (const entry of entries) {
				state.longTasks.push({
					startTime: entry.startTime,
					duration: entry.duration,
					name: entry.name,
				});
			}
		});

		// When the usable control first exists. The scenario's own "usable at" is
		// the click-based approximation; this is the earlier, cheaper signal.
		const checkForUsable = () => {
			if (state.firstSeenAtMs !== null) return;
			if (!document.querySelector(usableSelector)) return;
			state.firstSeenAtMs = performance.now();
			observer.disconnect();
		};
		const observer = new MutationObserver(checkForUsable);
		observer.observe(document, { childList: true, subtree: true });
		document.addEventListener("DOMContentLoaded", checkForUsable);
		checkForUsable();

		const noteInput = () => {
			state.firstInputAtMs ??= performance.now();
		};
		window.addEventListener("pointerdown", noteInput, { capture: true });
		window.addEventListener("keydown", noteInput, { capture: true });
	}, USABLE_SELECTOR);
}

// --------------------------------------------------------------- CDP wiring

async function applyThrottle(cdp: CDPSession, cache: CacheMode): Promise<void> {
	await cdp.send("Network.enable");
	await cdp.send("Network.emulateNetworkConditions", {
		offline: false,
		latency: THROTTLE.latencyMs,
		downloadThroughput: THROTTLE.downloadThroughputBps,
		uploadThroughput: THROTTLE.uploadThroughputBps,
		connectionType: THROTTLE.connectionType,
	});
	await cdp.send("Emulation.setCPUThrottlingRate", {
		rate: THROTTLE.cpuThrottleRate,
	});
	if (cache === "cold") {
		// A fresh context starts with an empty cache; clearing it as well holds
		// the scenario to "cold" even if the context is ever reused by mistake.
		await cdp.send("Network.clearBrowserCache");
	}
}

async function readPerformanceMetrics(
	cdp: CDPSession,
): Promise<Record<string, number>> {
	const result = (await cdp.send("Performance.getMetrics")) as {
		metrics: Array<{ name: string; value: number }>;
	};
	const metrics: Record<string, number> = {};
	for (const metric of result.metrics) {
		metrics[metric.name] = metric.value;
	}
	return metrics;
}

function metricDelta(
	after: Record<string, number> | undefined,
	before: Record<string, number> | undefined,
): Record<string, number> | undefined {
	if (!after || !before) return undefined;
	const delta: Record<string, number> = {};
	for (const key of Object.keys(after)) {
		const beforeValue = before[key];
		if (typeof beforeValue === "number") {
			delta[key] = after[key] - beforeValue;
		}
	}
	return delta;
}

// ----------------------------------------------------------------- a session

type Session = {
	context: BrowserContext;
	page: Page;
	cdp: CDPSession;
	events: {
		pageErrors: string[];
		consoleErrors: string[];
		requestFailures: Array<{ url: string; failure: string }>;
	};
	close: () => Promise<void>;
};

async function openSession(
	browser: Browser,
	viewport: Viewport,
	cache: CacheMode,
): Promise<Session> {
	const context = await browser.newContext({
		viewport,
		baseURL: BASE_URL,
		deviceScaleFactor: 1,
	});
	// Sign-in through the context's request client, not through the page: a page
	// visit would fetch the app shell and warm the very cache this run measures.
	const signIn = await context.request.post(`${BASE_URL}/api/auth/login`, {
		data: { email: TEST_EMAIL, password: TEST_PASSWORD },
	});
	if (!signIn.ok()) {
		throw new Error(
			`Sign-in for the measurement session failed: HTTP ${signIn.status()}`,
		);
	}
	const page = await context.newPage();
	const events: Session["events"] = {
		pageErrors: [],
		consoleErrors: [],
		requestFailures: [],
	};
	page.on("pageerror", (error) => events.pageErrors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") events.consoleErrors.push(message.text());
	});
	page.on("requestfailed", (request) => {
		events.requestFailures.push({
			url: request.url(),
			failure: request.failure()?.errorText ?? "unknown",
		});
	});
	await installPerfRecorder(page);
	const cdp = await context.newCDPSession(page);
	await cdp.send("Performance.enable").catch(() => undefined);
	await applyThrottle(cdp, cache);
	return {
		context,
		page,
		cdp,
		events,
		close: async () => {
			await cdp.detach().catch(() => undefined);
			await context.close();
		},
	};
}

// -------------------------------------------------------------- classification

const SCRIPT_EXTENSIONS = /\.(?:js|mjs)$/;
const STYLESHEET_EXTENSIONS = /\.css$/;
const FONT_EXTENSIONS = /\.(?:woff2?|ttf|otf|eot)$/;
const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|webp|avif|gif|svg|ico|bmp)$/;

function classifyResource(name: string, initiatorType: string): ResourceType {
	const path = name.split("?")[0].toLowerCase();
	if (SCRIPT_EXTENSIONS.test(path)) return "script";
	if (STYLESHEET_EXTENSIONS.test(path)) return "stylesheet";
	if (FONT_EXTENSIONS.test(path)) return "font";
	if (IMAGE_EXTENSIONS.test(path)) return "image";
	if (initiatorType === "script") return "script";
	if (initiatorType === "img" || initiatorType === "image") return "image";
	if (initiatorType === "fetch" || initiatorType === "xmlhttprequest") {
		return "fetch";
	}
	return "other";
}

function emptyTypeSummary(): Record<ResourceType, TypeSummary> {
	return {
		script: { requests: 0, transferBytes: 0, encodedBodySize: 0 },
		stylesheet: { requests: 0, transferBytes: 0, encodedBodySize: 0 },
		font: { requests: 0, transferBytes: 0, encodedBodySize: 0 },
		image: { requests: 0, transferBytes: 0, encodedBodySize: 0 },
		fetch: { requests: 0, transferBytes: 0, encodedBodySize: 0 },
		other: { requests: 0, transferBytes: 0, encodedBodySize: 0 },
	};
}

function summarizeResources(resources: ResourceRecord[]): Aggregates {
	const byType = emptyTypeSummary();
	let totalTransferBytes = 0;
	let totalEncodedBodySize = 0;
	let totalDecodedBodySize = 0;
	let cachedResourceCount = 0;
	const scriptNames = new Set<string>();
	let lastScriptResponseEndMs = 0;
	for (const resource of resources) {
		byType[resource.type].requests += 1;
		byType[resource.type].transferBytes += resource.transferSize;
		byType[resource.type].encodedBodySize += resource.encodedBodySize;
		totalTransferBytes += resource.transferSize;
		totalEncodedBodySize += resource.encodedBodySize;
		totalDecodedBodySize += resource.decodedBodySize;
		if (resource.transferSize === 0) cachedResourceCount += 1;
		if (resource.type === "script") {
			scriptNames.add(resource.name);
			lastScriptResponseEndMs = Math.max(
				lastScriptResponseEndMs,
				resource.responseEnd,
			);
		}
	}
	const biggest = [...resources]
		.sort((left, right) => right.transferSize - left.transferSize)
		.slice(0, 10)
		.map((resource) => ({
			name: resource.name,
			type: resource.type,
			transferSize: resource.transferSize,
			duration: resource.duration,
			startTime: resource.startTime,
			responseEnd: resource.responseEnd,
		}));
	return {
		requestCount: resources.length,
		totalTransferBytes,
		totalEncodedBodySize,
		totalDecodedBodySize,
		byType,
		scriptChunkCount: scriptNames.size,
		lastScriptResponseEndMs,
		cachedResourceCount,
		biggest,
	};
}

// -------------------------------------------------------------- page reading

type CollectedDocument = {
	now: number;
	readyState: string;
	navigation: NavigationTiming | null;
	resources: ResourceRecord[];
	state: PerfState | null;
	metrics: Record<string, number>;
};

async function collectDocument(
	page: Page,
	cdp: CDPSession,
): Promise<CollectedDocument> {
	const inPage = await page.evaluate(() => {
		const state =
			(
				window as unknown as {
					__perfLoad?: {
						fcpMs: number | null;
						lcp: Array<{
							startTime: number;
							size: number;
							element: string | null;
							url: string | null;
						}>;
						cls: Array<{
							startTime: number;
							value: number;
							hadRecentInput: boolean;
						}>;
						longTasks: Array<{
							startTime: number;
							duration: number;
							name: string;
						}>;
						firstSeenAtMs: number | null;
						firstInputAtMs: number | null;
					};
				}
			).__perfLoad ?? null;
		const navigationEntry = performance.getEntriesByType("navigation")[0] as
			| PerformanceNavigationTiming
			| undefined;
		const navigation = navigationEntry
			? {
					type: navigationEntry.type,
					redirectCount: navigationEntry.redirectCount,
					redirectStart: navigationEntry.redirectStart,
					redirectEnd: navigationEntry.redirectEnd,
					requestStart: navigationEntry.requestStart,
					responseStart: navigationEntry.responseStart,
					responseEnd: navigationEntry.responseEnd,
					ttfbMs: navigationEntry.responseStart - navigationEntry.requestStart,
					domInteractive: navigationEntry.domInteractive,
					domContentLoadedEventStart:
						navigationEntry.domContentLoadedEventStart,
					domContentLoadedEventEnd: navigationEntry.domContentLoadedEventEnd,
					loadEventStart: navigationEntry.loadEventStart,
					loadEventEnd: navigationEntry.loadEventEnd,
					duration: navigationEntry.duration,
					transferSize: navigationEntry.transferSize,
					encodedBodySize: navigationEntry.encodedBodySize,
					decodedBodySize: navigationEntry.decodedBodySize,
				}
			: null;
		const resources = performance.getEntriesByType("resource").map((entry) => {
			const resource = entry as PerformanceResourceTiming;
			return {
				name: resource.name,
				initiatorType: resource.initiatorType,
				startTime: resource.startTime,
				duration: resource.duration,
				responseStart: resource.responseStart,
				responseEnd: resource.responseEnd,
				transferSize: resource.transferSize,
				encodedBodySize: resource.encodedBodySize,
				decodedBodySize: resource.decodedBodySize,
			};
		});
		return {
			now: performance.now(),
			readyState: document.readyState,
			navigation,
			resources,
			state,
		};
	});
	return {
		...inPage,
		metrics: await readPerformanceMetrics(cdp),
	};
}

function summarizePaints(state: PerfState | null): PaintSummary | null {
	if (!state) return null;
	const lcpEntries = [...state.lcp].sort(
		(left, right) => left.startTime - right.startTime,
	);
	return {
		fcpMs: state.fcpMs,
		lcpMs: lcpEntries.at(-1)?.startTime ?? null,
		lcpEntries,
		firstSeenAtMs: state.firstSeenAtMs,
		firstInputAtMs: state.firstInputAtMs,
	};
}

function summarizeCls(state: PerfState | null): ClsSummary | null {
	if (!state) return null;
	let total = 0;
	let excludingRecentInput = 0;
	for (const entry of state.cls) {
		total += entry.value;
		if (!entry.hadRecentInput) excludingRecentInput += entry.value;
	}
	return { total, excludingRecentInput, entries: state.cls };
}

function summarizeLongTasks(state: PerfState | null): LongTaskSummary | null {
	if (!state) return null;
	let totalMs = 0;
	let tbtApproxMs = 0;
	let longest: LongTaskSummary["longest"] = null;
	for (const entry of state.longTasks) {
		totalMs += entry.duration;
		tbtApproxMs += Math.max(0, entry.duration - 50);
		if (!longest || entry.duration > longest.duration) {
			longest = {
				startTime: entry.startTime,
				duration: entry.duration,
				name: entry.name,
			};
		}
	}
	return {
		count: state.longTasks.length,
		totalMs,
		tbtApproxMs,
		longest,
		entries: state.longTasks,
	};
}

// ------------------------------------------------------------- page settling

/**
 * Waits for the document to stop fetching: `document.fonts.ready` (fonts are
 * part of both layout and LCP), then a 1 s window with no new resource entries.
 * Bounded, and a timeout is a note rather than a failure — the numbers already
 * gathered stay honest.
 */
async function settlePage(page: Page, notes: string[]): Promise<void> {
	await page.evaluate(async () => {
		const timeout = new Promise<void>((resolve) => {
			setTimeout(resolve, 30_000);
		});
		await Promise.race([document.fonts.ready.then(() => undefined), timeout]);
	});
	try {
		const quiet = await page.evaluate(async () => {
			const count = () => performance.getEntriesByType("resource").length;
			const deadline = performance.now() + 30_000;
			let last = count();
			let lastChange = performance.now();
			await new Promise<void>((resolve) => {
				const tick = () => {
					const now = performance.now();
					const current = count();
					if (current !== last) {
						last = current;
						lastChange = now;
					}
					if (now - lastChange >= 1_000 || now > deadline) {
						resolve();
						return;
					}
					setTimeout(tick, 100);
				};
				tick();
			});
			return count();
		});
		if (quiet === 0) notes.push("no subresource entries were recorded");
	} catch (error) {
		notes.push(
			`the resource-quiet window could not be measured: ${errorMessage(error)}`,
		);
	}
}

// ---------------------------------------------------------------- navigation

type NavigateResult = { status(): number } | null;

async function waitForHydrationWithTimeout(
	page: Page,
	notes: string[],
): Promise<{ at: number | null; error: string | null }> {
	try {
		await page.waitForSelector(HYDRATED_SELECTOR, {
			state: "attached",
			timeout: OP_TIMEOUT_MS,
		});
		return { at: await page.evaluate(() => performance.now()), error: null };
	} catch (error) {
		const message = errorMessage(error);
		notes.push(`hydration marker not seen: ${message}`);
		return { at: null, error: message };
	}
}

/** The click-based usability approximation, shared by both kinds of scenario. */
async function clickUsableControl(
	page: Page,
	notes: string[],
): Promise<{
	existsAtMs: number | null;
	clickedAtMs: number | null;
	clickMethod: string;
	clickError: string | null;
}> {
	let existsAtMs: number | null = null;
	let clickedAtMs: number | null = null;
	let clickMethod = "locator.click()";
	let clickError: string | null = null;
	try {
		await page.waitForSelector(USABLE_SELECTOR, {
			state: "visible",
			timeout: OP_TIMEOUT_MS,
		});
		existsAtMs = await page.evaluate(() => performance.now());
	} catch (error) {
		notes.push(
			`the usable control never became visible: ${errorMessage(error)}`,
		);
	}
	if (existsAtMs === null) {
		return { existsAtMs, clickedAtMs, clickMethod, clickError };
	}
	const locator = page.locator(USABLE_SELECTOR).first();
	try {
		await locator.click({ timeout: CLICK_TIMEOUT_MS });
		clickedAtMs = await page.evaluate(() => performance.now());
	} catch (error) {
		clickError = errorMessage(error);
		clickMethod =
			"locator.click({ force: true }) after the plain click was refused";
		try {
			await locator.click({ force: true, timeout: CLICK_TIMEOUT_MS });
			clickedAtMs = await page.evaluate(() => performance.now());
		} catch (forcedError) {
			clickError = `${clickError}; the forced click also failed: ${errorMessage(forcedError)}`;
			notes.push(
				"the usable control exists but a click could not be delivered",
			);
		}
	}
	return { existsAtMs, clickedAtMs, clickMethod, clickError };
}

async function measureDocument(options: {
	id: string;
	label: string;
	session: Session;
	cache: CacheMode;
	navigate: () => Promise<NavigateResult>;
	extraNotes?: string[];
}): Promise<ScenarioResult> {
	const { session, cache } = options;
	const { page, cdp } = session;
	const startedAt = new Date();
	const startedMs = Date.now();
	const notes: string[] = [...(options.extraNotes ?? [])];

	session.events.pageErrors.length = 0;
	session.events.consoleErrors.length = 0;
	session.events.requestFailures.length = 0;
	const metricsBaseline = await readPerformanceMetrics(cdp).catch(
		() => undefined,
	);

	let documentStatus: number | null = null;
	const response = await options.navigate();
	if (response) documentStatus = response.status();

	const usable = await clickUsableControl(page, notes);

	// Before the load event on purpose: hydration usually happens earlier, and
	// the number wanted is the browser's own mount moment, not this harness's
	// arrival after a long load.
	const hydration = await waitForHydrationWithTimeout(page, notes);

	try {
		await page.waitForLoadState("load", { timeout: OP_TIMEOUT_MS });
	} catch (error) {
		notes.push(`the load event did not arrive: ${errorMessage(error)}`);
	}

	await settlePage(page, notes);

	const collected = await collectDocument(page, cdp);
	const resources: ResourceRecord[] = collected.resources.map((resource) => ({
		...resource,
		type: classifyResource(resource.name, resource.initiatorType),
	}));
	const paints = summarizePaints(collected.state);
	const usableSummary: UsableSummary = {
		selector: USABLE_SELECTOR,
		method:
			"page.waitForSelector(visible) + locator.click(); the value is performance.now() read one CDP round trip after the click, so it includes Playwright's actionability checks",
		existsAtMs: usable.existsAtMs,
		clickedAtMs: usable.clickedAtMs,
		usableApproxMs: usable.clickedAtMs,
		clickMethod: usable.clickMethod,
		clickError: usable.clickError,
		hydratedAtMs: hydration.at,
		hydrationError: hydration.error,
		caveat:
			"the click can land on server-rendered markup before hydration, so this measures that a control exists and accepts a click, not that the app's handlers are attached (hydratedAtMs is the framework's own marker)",
	};

	const missing: string[] = [];
	if (!collected.navigation) missing.push("navigation timing entry");
	if (usableSummary.usableApproxMs === null) {
		missing.push("usable-at measurement");
	}

	return {
		id: options.id,
		label: options.label,
		kind: "document",
		status: missing.length === 0 ? "ok" : "partial",
		startedAt: startedAt.toISOString(),
		durationMs: Date.now() - startedMs,
		...(missing.length > 0 ? { error: `missing: ${missing.join(", ")}` } : {}),
		url: page.url(),
		viewport: page.viewportSize() ?? undefined,
		cache: {
			mode: cache,
			detail:
				cache === "cold"
					? "fresh browser context; Network.clearBrowserCache before the navigation"
					: "same browser context as the cold landing scenario; cache kept across the reload",
		},
		throttle: THROTTLE,
		documentStatus,
		navigation: collected.navigation,
		paints,
		cls: summarizeCls(collected.state),
		longTasks: summarizeLongTasks(collected.state),
		performanceMetrics: collected.metrics,
		performanceMetricsBaseline: metricsBaseline,
		performanceMetricsDelta: metricDelta(collected.metrics, metricsBaseline),
		resources,
		aggregates: summarizeResources(resources),
		usable: usableSummary,
		pageErrors: [...session.events.pageErrors],
		consoleErrors: [...session.events.consoleErrors],
		requestFailures: [...session.events.requestFailures],
		notes,
	};
}

// ------------------------------------------------------------- chat seeding

async function adminUserId(): Promise<string> {
	const [row] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, TEST_EMAIL))
		.limit(1);
	if (!row) throw new Error(`Seeded user ${TEST_EMAIL} not found`);
	return row.id;
}

/**
 * A conversation with eight messages, written through the app's own services
 * (the same way `chat-scroll-on-load.spec.ts` seeds): the chat scenario then
 * measures loading a real thread, not an empty page. Plain prose only, so the
 * render does not wait on the asynchronous code highlighter.
 */
async function seedChat(): Promise<string> {
	const conversation = await createServerConversation(
		await adminUserId(),
		"Perf load: chat cold",
	);
	for (let turn = 1; turn <= CONVERSATION_MESSAGES / 2; turn += 1) {
		await createMessage(
			conversation.id,
			"user",
			`Measurement question ${turn}: what does this page cost to load when the connection is slow and the CPU is throttled?`,
		);
		await createMessage(
			conversation.id,
			"assistant",
			[
				`Measurement answer ${turn}. This reply exists so the thread has real content to parse, lay out and paint, with a few sentences of ordinary prose and no fenced code block, so the answer's own rendering is what the numbers include.`,
				`It keeps going for one more sentence so several messages make the thread taller than a phone window and roughly one desktop window.`,
				`End of answer ${turn}.`,
			].join(" "),
		);
	}
	return conversation.id;
}

// -------------------------------------------------------------- transitions

/**
 * Landing page first (measured like any document), then the conversation link
 * on that page is clicked: a client-side navigation, so no new document, no
 * paint entry and no navigation timing. Everything here is relative to the
 * click, with the landing document kept whole beside it.
 */
async function measureClientTransition(options: {
	session: Session;
	conversationId: string;
	extraNotes?: string[];
}): Promise<ScenarioResult> {
	const { session, conversationId } = options;
	const { page, cdp } = session;
	const startedAt = new Date();
	const startedMs = Date.now();
	const notes: string[] = [...(options.extraNotes ?? [])];

	const landing = await measureDocument({
		id: "landing-before-transition",
		label: "landing document before the client-side transition (cold desktop)",
		session,
		cache: "cold",
		navigate: () =>
			page.goto("/", { waitUntil: "commit", timeout: OP_TIMEOUT_MS }),
	});
	notes.push(
		"the landing document before the click was measured the same way as the cold landing scenario; its numbers are in landingDocument, not in this scenario's navigation/paints",
	);

	// The app hydrates after its first paint, and a link clicked before that is
	// inert (`waitForHydration`). That wait is setup, not the measurement.
	const hydration = await waitForHydrationWithTimeout(page, notes);

	const linkSelector = `[data-testid="home-recent-line"][href="/chat/${conversationId}"]`;
	const transition: NonNullable<ScenarioResult["transition"]> = {
		linkSelector,
		clickedAtMs: null,
		urlChangedAtMs: null,
		chatSurfaceAtMs: null,
		composerVisibleAtMs: null,
		usableAtMs: null,
		usableFromClickMs: null,
		usableFromNavStartMs: null,
	};

	// Fresh event buffers: what the transition itself fails or logs.
	session.events.pageErrors.length = 0;
	session.events.consoleErrors.length = 0;
	session.events.requestFailures.length = 0;
	const metricsBeforeClick = await readPerformanceMetrics(cdp).catch(
		() => undefined,
	);

	let notMeasuredReason: string | undefined;
	const link = page.locator(linkSelector).first();
	try {
		await link.waitFor({ state: "visible", timeout: OP_TIMEOUT_MS });
	} catch (error) {
		notMeasuredReason = `the conversation link was not visible on / within ${OP_TIMEOUT_MS} ms: ${errorMessage(error)}`;
		notes.push(notMeasuredReason);
	}

	if (!notMeasuredReason) {
		try {
			// Taken just before the click call: the transition's usable time
			// therefore includes Playwright's dispatch of this click and the
			// composer click's own round trip. Stated, not corrected.
			transition.clickedAtMs = await page.evaluate(() => performance.now());
			await link.click({ timeout: CLICK_TIMEOUT_MS });
			await page.waitForURL(`**/chat/${conversationId}`, {
				timeout: OP_TIMEOUT_MS,
			});
			transition.urlChangedAtMs = await page.evaluate(() => performance.now());
			await page.waitForSelector(CHAT_SURFACE_SELECTOR, {
				state: "attached",
				timeout: OP_TIMEOUT_MS,
			});
			transition.chatSurfaceAtMs = await page.evaluate(() => performance.now());
			const composer = await clickUsableControl(page, notes);
			transition.composerVisibleAtMs = composer.existsAtMs;
			transition.usableAtMs = composer.clickedAtMs;
			if (composer.clickError) notes.push(composer.clickError);
			if (transition.clickedAtMs !== null && transition.usableAtMs !== null) {
				transition.usableFromClickMs =
					transition.usableAtMs - transition.clickedAtMs;
				// The page clock still belongs to the landing document (a soft
				// navigation starts no new one), so the clickable composer's own
				// timestamp is already "ms since the landing navigation start".
				transition.usableFromNavStartMs = transition.usableAtMs;
			}
			await settlePage(page, notes);
			const collected = await collectDocument(page, cdp);
			const clickAt = transition.clickedAtMs ?? 0;
			const addedResources: ResourceRecord[] = collected.resources
				.filter((resource) => resource.startTime >= clickAt)
				.map((resource) => ({
					...resource,
					type: classifyResource(resource.name, resource.initiatorType),
				}));
			const addedLongTasks = collected.state
				? collected.state.longTasks.filter(
						(entry) => entry.startTime >= clickAt,
					)
				: [];
			const transitionState: PerfState | null = collected.state
				? {
						...collected.state,
						lcp: collected.state.lcp.filter(
							(entry) => entry.startTime >= clickAt,
						),
						cls: collected.state.cls.filter(
							(entry) => entry.startTime >= clickAt,
						),
						longTasks: addedLongTasks,
					}
				: null;
			return {
				id: "landing-to-chat-transition",
				label:
					"landing → chat client-side transition (a conversation clicked on /)",
				kind: "client-nav",
				status: "ok",
				startedAt: startedAt.toISOString(),
				durationMs: Date.now() - startedMs,
				url: page.url(),
				viewport: page.viewportSize() ?? undefined,
				cache: {
					mode: "cold",
					detail:
						"fresh browser context, cleared cache, then the landing document; the conversation was clicked on that page (the chat route's chunks were not in the cache)",
				},
				throttle: THROTTLE,
				documentStatus: null,
				navigation: null,
				paints: null,
				paintsNote:
					"a client-side navigation creates no new document, navigation timing entry or paint entry; the landing document's FCP/LCP/DCL/load are in landingDocument",
				cls: summarizeCls(transitionState),
				longTasks: summarizeLongTasks(transitionState),
				performanceMetrics: collected.metrics,
				performanceMetricsBeforeClick: metricsBeforeClick,
				performanceMetricsDelta: metricDelta(
					collected.metrics,
					metricsBeforeClick,
				),
				resources: addedResources,
				aggregates: summarizeResources(addedResources),
				usable: {
					selector: USABLE_SELECTOR,
					method:
						"the chat link was clicked, then the chat surface and the composer were waited for and the composer was clicked; usableAtMs minus clickedAtMs is the transition's usable time",
					existsAtMs: transition.composerVisibleAtMs,
					clickedAtMs: transition.usableAtMs,
					usableApproxMs: transition.usableFromClickMs,
					clickMethod:
						"locator.click() on the conversation link, then on the composer",
					clickError: null,
					hydratedAtMs: landing.usable?.hydratedAtMs ?? hydration.at,
					hydrationError: hydration.error,
					caveat:
						"the composer is the same test id on both pages; the chat surface's arrival and the URL change are recorded too, so the shared-control caveat is visible in the numbers",
				},
				pageErrors: [...session.events.pageErrors],
				consoleErrors: [...session.events.consoleErrors],
				requestFailures: [...session.events.requestFailures],
				notes,
				landingDocument: landing,
				transition,
			};
		} catch (error) {
			notes.push(
				`the transition could not be completed: ${errorMessage(error)}`,
			);
			notMeasuredReason = `the conversation link was clicked but the chat page did not become measurable: ${errorMessage(error)}`;
		}
	}

	return {
		id: "landing-to-chat-transition",
		label:
			"landing → chat client-side transition (a conversation clicked on /)",
		kind: "client-nav",
		status: "not-measured",
		startedAt: startedAt.toISOString(),
		durationMs: Date.now() - startedMs,
		notMeasuredReason,
		url: page.url(),
		viewport: page.viewportSize() ?? undefined,
		cache: {
			mode: "cold",
			detail: "fresh browser context, cleared cache, landing document loaded",
		},
		throttle: THROTTLE,
		navigation: null,
		paints: null,
		paintsNote:
			"the transition was not completed, so it has no usable-at, resource or long-task numbers; the landing document it started from is in landingDocument",
		performanceMetricsBeforeClick: metricsBeforeClick,
		usable: null,
		pageErrors: [...session.events.pageErrors],
		consoleErrors: [...session.events.consoleErrors],
		requestFailures: [...session.events.requestFailures],
		notes,
		landingDocument: landing,
		transition,
	};
}

// ------------------------------------------------------------------- report

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function round(value: number, digits = 1): number {
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

function ms(value: number | null | undefined): string {
	return typeof value === "number" && Number.isFinite(value)
		? `${round(value)} ms`
		: "n/a";
}

function kb(bytes: number | null | undefined): string {
	return typeof bytes === "number" && Number.isFinite(bytes)
		? `${round(bytes / 1024)} KB`
		: "n/a";
}

function pct(part: number | undefined, whole: number | undefined): string {
	if (typeof part !== "number" || typeof whole !== "number" || whole <= 0) {
		return "n/a";
	}
	return `${round((part / whole) * 100)}%`;
}

function shortName(name: string): string {
	// The origin is the same for every resource; a report line does not need it.
	return name.replace(BASE_URL, "");
}

function cacheLine(result: ScenarioResult): string {
	return result.cache ? `${result.cache.mode} — ${result.cache.detail}` : "n/a";
}

function headlineUsableMs(result: ScenarioResult): number | null {
	if (result.kind === "client-nav") {
		return result.transition?.usableFromClickMs ?? null;
	}
	return result.usable?.usableApproxMs ?? null;
}

function usableLabel(result: ScenarioResult): string {
	return result.kind === "client-nav"
		? "Usable (approx., link click → clickable composer)"
		: "Usable (approx., navigation start → clickable composer)";
}

function metricTableRows(result: ScenarioResult): Array<[string, string]> {
	const navigation = result.navigation;
	const aggregates = result.aggregates;
	const byType = aggregates?.byType;
	const clientNav = result.kind === "client-nav";
	const rows: Array<[string, string]> = [
		["URL", result.url ? `\`${shortName(result.url)}\`` : "n/a"],
		[
			"Viewport",
			result.viewport
				? `${result.viewport.width} × ${result.viewport.height}`
				: "n/a",
		],
		["Cache", cacheLine(result)],
		[
			"TTFB (responseStart − requestStart)",
			clientNav
				? "n/a (client-side navigation: no new document)"
				: ms(navigation?.ttfbMs),
		],
		[
			"Document response (requestStart → responseEnd)",
			clientNav
				? "n/a (no new document)"
				: ms(
						navigation
							? navigation.responseEnd - navigation.requestStart
							: null,
					),
		],
		["FCP", clientNav ? "n/a (no new document)" : ms(result.paints?.fcpMs)],
		["LCP", clientNav ? "n/a (no new document)" : ms(result.paints?.lcpMs)],
		[
			"DOMContentLoaded",
			clientNav
				? "n/a (no new document)"
				: ms(navigation?.domContentLoadedEventEnd),
		],
		[
			"load",
			clientNav ? "n/a (no new document)" : ms(navigation?.loadEventEnd),
		],
		[usableLabel(result), ms(headlineUsableMs(result))],
		[
			clientNav
				? "Hydrated on the landing document (before the click) — not the transition's own readiness"
				: "Hydrated (#svelte-announcer) — the framework's own readiness, not the click",
			ms(result.usable?.hydratedAtMs),
		],
		[
			"Requests (subresources, document excluded)",
			`${aggregates?.requestCount ?? "n/a"}`,
		],
		["Transfer", kb(aggregates?.totalTransferBytes)],
		["Script", kb(byType?.script.transferBytes)],
		["Font", kb(byType?.font.transferBytes)],
		[
			"Script chunks (distinct URLs)",
			`${aggregates?.scriptChunkCount ?? "n/a"}`,
		],
		[
			clientNav
				? "Last script response end (from the landing navigation start)"
				: "Last script response end",
			ms(aggregates?.lastScriptResponseEndMs),
		],
	];
	if (clientNav && result.transition) {
		rows.push(
			[
				"URL changed after click",
				ms(
					result.transition.urlChangedAtMs !== null &&
						result.transition.clickedAtMs !== null
						? result.transition.urlChangedAtMs - result.transition.clickedAtMs
						: null,
				),
			],
			[
				"Chat surface attached after click",
				ms(
					result.transition.chatSurfaceAtMs !== null &&
						result.transition.clickedAtMs !== null
						? result.transition.chatSurfaceAtMs - result.transition.clickedAtMs
						: null,
				),
			],
			[
				"Composer visible after click",
				ms(
					result.transition.composerVisibleAtMs !== null &&
						result.transition.clickedAtMs !== null
						? result.transition.composerVisibleAtMs -
								result.transition.clickedAtMs
						: null,
				),
			],
		);
	}
	return rows;
}

function resourceTable(resources: BiggestResource[], limit: number): string[] {
	const lines: string[] = [];
	lines.push("| # | resource | type | transfer | duration |");
	lines.push("| --- | --- | --- | --- | --- |");
	for (const [index, resource] of resources.slice(0, limit).entries()) {
		lines.push(
			`| ${index + 1} | \`${shortName(resource.name)}\` | ${resource.type} | ${kb(resource.transferSize)} | ${ms(resource.duration)} |`,
		);
	}
	return lines;
}

function globalTopResources(
	results: ScenarioResult[],
	limit: number,
): Array<{
	name: string;
	type: ResourceType;
	transferSize: number;
	scenarios: string[];
}> {
	const byName = new Map<
		string,
		{
			name: string;
			type: ResourceType;
			transferSize: number;
			scenarios: string[];
		}
	>();
	for (const result of results) {
		for (const resource of result.resources ?? []) {
			const existing = byName.get(resource.name);
			if (existing) {
				existing.transferSize = Math.max(
					existing.transferSize,
					resource.transferSize,
				);
				if (!existing.scenarios.includes(result.id)) {
					existing.scenarios.push(result.id);
				}
				continue;
			}
			byName.set(resource.name, {
				name: resource.name,
				type: resource.type,
				transferSize: resource.transferSize,
				scenarios: [result.id],
			});
		}
	}
	return [...byName.values()]
		.sort((left, right) => right.transferSize - left.transferSize)
		.slice(0, limit);
}

function buildObservations(results: ScenarioResult[]): string {
	const sentences: string[] = [];
	sentences.push(
		`Every scenario ran over a 400 ms-RTT cellular3g profile at 50 KB/s down and up with the CPU throttled ×4; a "cold" run started from a fresh browser context with its cache cleared, and the warm run reloaded the cold landing context with its cache kept.`,
	);

	const coldLanding = results.find(
		(result) => result.id === "landing-cold-desktop",
	);
	if (coldLanding?.aggregates && coldLanding.paints) {
		const aggregates = coldLanding.aggregates;
		sentences.push(
			`The cold desktop landing painted FCP at ${ms(coldLanding.paints.fcpMs)} and LCP at ${ms(coldLanding.paints.lcpMs)}, reached DOMContentLoaded at ${ms(coldLanding.navigation?.domContentLoadedEventEnd)} and load at ${ms(coldLanding.navigation?.loadEventEnd)}, and its composer accepted a click at ${ms(coldLanding.usable?.usableApproxMs)}; it made ${aggregates.requestCount} subresource requests for ${kb(aggregates.totalTransferBytes)}, of which script was ${kb(aggregates.byType.script.transferBytes)} (${pct(aggregates.byType.script.transferBytes, aggregates.totalTransferBytes)}), fonts ${kb(aggregates.byType.font.transferBytes)} (${pct(aggregates.byType.font.transferBytes, aggregates.totalTransferBytes)}), stylesheets ${kb(aggregates.byType.stylesheet.transferBytes)} and fetch/xhr ${kb(aggregates.byType.fetch.transferBytes)}, in ${aggregates.scriptChunkCount} distinct script chunks whose last response ended at ${ms(aggregates.lastScriptResponseEndMs)}.`,
		);
	}

	const coldPhone = results.find(
		(result) => result.id === "landing-cold-phone",
	);
	if (
		coldPhone?.aggregates &&
		coldLanding?.aggregates &&
		coldPhone.navigation &&
		coldLanding.navigation
	) {
		const phone = coldPhone.aggregates;
		const desktop = coldLanding.aggregates;
		const requestDelta = Math.abs(phone.requestCount - desktop.requestCount);
		const byteDelta = Math.abs(
			round((phone.totalTransferBytes - desktop.totalTransferBytes) / 1024),
		);
		sentences.push(
			`The phone landing (390 × 844) made ${phone.requestCount} requests for ${kb(phone.totalTransferBytes)} (${requestDelta} ${phone.requestCount >= desktop.requestCount ? "more" : "fewer"} ${requestDelta === 1 ? "request" : "requests"} and ${byteDelta} KB ${phone.totalTransferBytes >= desktop.totalTransferBytes ? "more" : "less"} than the desktop run), with FCP at ${ms(coldPhone.paints?.fcpMs)} against ${ms(coldLanding.paints?.fcpMs)}, and its composer accepted a click at ${ms(coldPhone.usable?.usableApproxMs)}.`,
		);
	}

	const warm = results.find((result) => result.id === "landing-warm-reload");
	const warmAggregates = warm?.aggregates;
	if (warm && warmAggregates && coldLanding?.aggregates) {
		sentences.push(
			`The warm reload of the same landing page made ${warmAggregates.requestCount} requests for ${kb(warmAggregates.totalTransferBytes)} (${pct(warmAggregates.totalTransferBytes, coldLanding.aggregates.totalTransferBytes)} of the cold transfer), of which ${warmAggregates.cachedResourceCount} requests reported a transfer size of 0, and its composer accepted a click at ${ms(warm.usable?.usableApproxMs)} with FCP at ${ms(warm.paints?.fcpMs)}.`,
		);
	}

	const coldChat = results.find((result) => result.id === "chat-cold");
	if (coldChat?.aggregates) {
		const aggregates = coldChat.aggregates;
		sentences.push(
			`The cold chat load of a seeded eight-message conversation made ${aggregates.requestCount} requests for ${kb(aggregates.totalTransferBytes)} (script ${kb(aggregates.byType.script.transferBytes)}, fonts ${kb(aggregates.byType.font.transferBytes)}), in ${aggregates.scriptChunkCount} distinct script chunks whose last response ended at ${ms(aggregates.lastScriptResponseEndMs)}, with FCP at ${ms(coldChat.paints?.fcpMs)}, LCP at ${ms(coldChat.paints?.lcpMs)}, DOMContentLoaded at ${ms(coldChat.navigation?.domContentLoadedEventEnd)}, load at ${ms(coldChat.navigation?.loadEventEnd)} and its composer clickable at ${ms(coldChat.usable?.usableApproxMs)}.`,
		);
	}

	const transition = results.find(
		(result) => result.id === "landing-to-chat-transition",
	);
	if (
		transition?.status === "ok" &&
		transition.transition &&
		transition.aggregates
	) {
		sentences.push(
			`From the landing page, clicking the conversation reached the chat URL after ${ms(transition.transition.urlChangedAtMs !== null && transition.transition.clickedAtMs !== null ? transition.transition.urlChangedAtMs - transition.transition.clickedAtMs : null)}, attached the chat surface after ${ms(transition.transition.chatSurfaceAtMs !== null && transition.transition.clickedAtMs !== null ? transition.transition.chatSurfaceAtMs - transition.transition.clickedAtMs : null)} and a clickable composer after ${ms(transition.transition.usableFromClickMs)}, adding ${transition.aggregates.requestCount} subresource requests for ${kb(transition.aggregates.totalTransferBytes)} with no new document, paint entry or navigation timing entry.`,
		);
	} else if (transition?.status === "not-measured") {
		sentences.push(
			`The landing → chat client-side transition was not measured: ${transition.notMeasuredReason ?? "the reason was not recorded"}.`,
		);
	}

	const top = globalTopResources(results, 3);
	if (top.length > 0) {
		sentences.push(
			`Across the measured loads the three resources contributing the most bytes were ${top
				.map(
					(resource, index) =>
						`${index + 1}) \`${shortName(resource.name)}\` (${resource.type}) at ${kb(resource.transferSize)}`,
				)
				.join(", ")}.`,
		);
	}

	const hydration = results.filter(
		(result) =>
			result.kind === "document" &&
			result.status === "ok" &&
			typeof result.usable?.hydratedAtMs === "number" &&
			typeof headlineUsableMs(result) === "number",
	);
	if (hydration.length > 0) {
		const coldHydration = hydration.filter(
			(result) => result.cache?.mode === "cold",
		);
		const hydrationAfterClick = (result: ScenarioResult) =>
			(result.usable?.hydratedAtMs ?? 0) - (headlineUsableMs(result) ?? 0);
		const allColdAfterClick =
			coldHydration.length > 0 &&
			coldHydration.every((result) => hydrationAfterClick(result) > 100);
		sentences.push(
			`The framework's hydration marker was recorded at ${hydration
				.map(
					(result) =>
						`${ms(result.usable?.hydratedAtMs)} on ${result.id} (composer clickable at ${ms(headlineUsableMs(result))})`,
				)
				.join("; ")}${
				allColdAfterClick
					? ", so on the cold documents the first click landed on server-rendered markup before the app mounted"
					: ""
			}.`,
		);
	}

	const transitionHydration = results.find(
		(result) =>
			result.id === "landing-to-chat-transition" &&
			result.status === "ok" &&
			typeof result.usable?.hydratedAtMs === "number",
	);
	if (transitionHydration) {
		sentences.push(
			`The landing document the transition started from had hydrated at ${ms(transitionHydration.usable?.hydratedAtMs)} (landing navigation start), before the conversation was clicked.`,
		);
	}
	return sentences.join(" ");
}

function buildReport(results: ScenarioResult[], run: RunMeta): string {
	const lines: string[] = [];
	lines.push(`# AlfyAI load measurements — ${DATE_STAMP}`);
	lines.push("");
	lines.push(
		`Production build served by the e2e harness at ${run.baseUrl}${run.commit ? `; commit \`${run.commit}\`` : ""}. Node ${run.node}. Generated ${run.generatedAt}.`,
	);
	lines.push("");
	lines.push(
		"This is a measurement run, not a gate: the harness is inert unless `PERF_RUN=1` and it asserts nothing about the numbers.",
	);
	lines.push("");
	lines.push("## Method");
	lines.push("");
	lines.push(
		`- Network: CDP \`Network.emulateNetworkConditions\` — ${run.throttle.latencyMs} ms latency, ${run.throttle.downloadThroughputBps} B/s download, ${run.throttle.uploadThroughputBps} B/s upload, \`${run.throttle.connectionType}\`; CPU: \`Emulation.setCPUThrottlingRate\` at ${run.throttle.cpuThrottleRate}.`,
	);
	lines.push(`- Cache: ${run.cache}`);
	lines.push(`- Sign-in: ${run.signIn}`);
	lines.push(
		"- Usable-at: `page.waitForSelector(visible)` on `[data-testid=\"message-input\"]` followed by a real `locator.click()`; the value is `performance.now()` read one CDP round trip after the click, so it is an approximation that includes Playwright's actionability checks and the click itself. A click can land on server-rendered markup before hydration; the framework's own hydration marker (`#svelte-announcer`) is recorded separately as `hydratedAtMs`.",
	);
	lines.push(
		"- FCP/LCP/CLS come from buffered `PerformanceObserver` entries installed before the document's scripts; long tasks from `longtask`, with TBT approximated as Σ max(0, duration − 50 ms).",
	);
	lines.push(
		"- CLS is reported twice: `cls.total` sums every layout-shift value, `cls.excludingRecentInput` drops the shifts the browser attributes to recent input.",
	);
	lines.push(
		"- LCP observation ends at the first trusted input, and the usable-at step is a real click: the LCP value below is the largest contentful paint observed up to that click, not past it. `paints.firstInputAtMs` in the raw file says when that click happened.",
	);
	lines.push(
		"- A property of the measurement stack, stated so TTFB is not misread: with this CDP emulation the configured latency is applied between `responseStart` and `responseEnd`, not before `responseStart`. A standalone probe with 2 s of emulated latency made a `fetch` take 2011 ms and the document commit at 2021 ms while the resource entries reported `responseStart` about 1 ms after `requestStart`. The requested TTFB formula below therefore excludes the emulated round trip; the `Document response (requestStart → responseEnd)` row shows where that latency appears, and FCP, LCP, load and the usable numbers include it.",
	);
	lines.push(
		`- Resources: every entry from \`performance.getEntriesByType("resource")\` (name, initiatorType, startTime, duration, transferSize, encodedBodySize, decodedBodySize, responseStart, responseEnd). ${run.classification}`,
	);
	lines.push(
		"- The HTML document is not a resource entry: its own bytes are in the navigation entry (`transferSize`, `encodedBodySize`, `decodedBodySize`), and request counts and byte sums below exclude it.",
	);
	lines.push("");

	for (const [index, result] of results.entries()) {
		lines.push(`## ${index + 1}. ${result.label}`);
		lines.push("");
		if (result.status === "failed") {
			lines.push(
				`Not measured: the scenario failed — ${result.error ?? "no error message was recorded"}.`,
			);
			lines.push("");
			continue;
		}
		if (result.status === "not-measured") {
			lines.push(
				`Not measured: ${result.notMeasuredReason ?? "no reason was recorded"}. The landing document it started from is recorded in the JSON (\`landingDocument\`).`,
			);
			lines.push("");
			continue;
		}
		lines.push("| Metric | Value |");
		lines.push("| --- | --- |");
		for (const [label, value] of metricTableRows(result)) {
			lines.push(`| ${label} | ${value} |`);
		}
		lines.push("");
		if (result.kind === "client-nav" && result.landingDocument) {
			const landing = result.landingDocument;
			lines.push(
				`The landing document that preceded the click (measured the same way, cold) painted FCP at ${ms(landing.paints?.fcpMs)}, LCP at ${ms(landing.paints?.lcpMs)}, reached load at ${ms(landing.navigation?.loadEventEnd)} and made ${landing.aggregates?.requestCount ?? "n/a"} requests for ${kb(landing.aggregates?.totalTransferBytes)}.`,
			);
			lines.push("");
		}
		const biggest = result.aggregates?.biggest ?? [];
		if (biggest.length > 0) {
			lines.push("Five biggest resources by transfer size:");
			lines.push("");
			lines.push(...resourceTable(biggest, 5));
		} else {
			lines.push(
				"The transition added no subresource requests, so there are no resources to rank.",
			);
		}
		lines.push("");
		if (result.paintsNote) {
			lines.push(`${result.paintsNote}.`);
			lines.push("");
		}
		if (result.notes && result.notes.length > 0) {
			lines.push("Notes from this scenario:");
			lines.push("");
			for (const note of result.notes) lines.push(`- ${note}`);
			lines.push("");
		}
	}

	lines.push("## Observations");
	lines.push("");
	lines.push(buildObservations(results));
	lines.push("");

	const failed = results.filter(
		(result) => result.status === "failed" || result.status === "not-measured",
	);
	if (failed.length > 0) {
		lines.push("## What was not measured");
		lines.push("");
		for (const result of failed) {
			lines.push(
				`- **${result.id}**: ${result.error ?? result.notMeasuredReason ?? "no reason was recorded"}.`,
			);
		}
		lines.push("");
	}

	lines.push("## Per-run details in the raw file");
	lines.push("");
	lines.push(
		`\`raw-${DATE_STAMP}.json\` holds, per scenario: the navigation timing entry, every paint and LCP candidate, every layout-shift entry, every long-task entry, all \`Performance.getMetrics\` values (with their pre-navigation baseline and delta), every resource entry, the aggregates (by type, biggest ten, chunk count, last script response end), the usable-at numbers with the click method and any click/hydration errors, and the page errors, console errors and failed requests seen while the scenario ran.`,
	);
	lines.push("");
	return lines.join("\n");
}

// -------------------------------------------------------------- output files

function writeOutputs(results: ScenarioResult[], run: RunMeta): void {
	mkdirSync(OUTPUT_DIR, { recursive: true });
	writeFileSync(
		join(OUTPUT_DIR, `raw-${DATE_STAMP}.json`),
		`${JSON.stringify({ run, scenarios: results }, null, 2)}\n`,
	);
	writeFileSync(
		join(OUTPUT_DIR, `report-${DATE_STAMP}.md`),
		buildReport(results, run),
	);
}

function gitCommit(): string | null {
	try {
		return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
			encoding: "utf8",
		}).trim();
	} catch {
		return null;
	}
}

// --------------------------------------------------------------------- test

test("load measurements: cellular3g and 4x CPU on the landing and chat pages", async ({
	browser,
}) => {
	test.setTimeout(TEST_TIMEOUT_MS);

	const results: ScenarioResult[] = [];
	const runStartedAt = new Date().toISOString();
	const run: RunMeta = {
		startedAt: runStartedAt,
		generatedAt: runStartedAt,
		complete: false,
		node: process.version,
		baseUrl: BASE_URL,
		commit: gitCommit(),
		throttle: THROTTLE,
		usableSelector: USABLE_SELECTOR,
		scenarios: [
			"landing-cold-desktop",
			"landing-cold-phone",
			"landing-warm-reload",
			"chat-cold",
			"landing-to-chat-transition",
		],
		cache:
			"cold = a fresh browser context with Network.clearBrowserCache before the navigation; warm = the same context and page as the cold landing, reloaded with its cache kept",
		classification:
			"Each resource is classified by file extension first (js/mjs = script, css = stylesheet, woff/woff2/ttf/otf/eot = font, png/jpg/jpeg/webp/avif/gif/svg/ico/bmp = image), then by initiatorType (script, img/image, fetch/xmlhttprequest), and everything else is other.",
		signIn:
			"POST /api/auth/login through the browser context's request client (not a page visit), so no app asset was fetched into the cache before the measured navigation",
	};

	const persist = (complete: boolean) => {
		run.generatedAt = new Date().toISOString();
		run.complete = complete;
		writeOutputs(results, run);
	};

	const runScenario = async (
		id: string,
		label: string,
		scenario: () => Promise<ScenarioResult>,
	): Promise<void> => {
		const startedAt = new Date();
		try {
			const result = await scenario();
			results.push(result);
			console.log(
				`[perf] ${result.id}: ${result.status} — usable ${ms(headlineUsableMs(result))}, ${result.aggregates?.requestCount ?? "n/a"} requests, ${kb(result.aggregates?.totalTransferBytes)}`,
			);
		} catch (error) {
			results.push({
				id,
				label,
				kind: "unknown",
				status: "failed",
				startedAt: startedAt.toISOString(),
				durationMs: Date.now() - startedAt.getTime(),
				error: errorMessage(error),
			});
			console.log(`[perf] ${id}: failed — ${errorMessage(error)}`);
		}
		persist(false);
	};

	// The chat scenario's thread, and the conversation the transition clicks.
	const conversationId = await seedChat();

	// 1. landing cold, desktop.
	let landingSession: Session | undefined;
	await runScenario(
		"landing-cold-desktop",
		"landing cold, desktop 1440x900",
		async () => {
			try {
				const session = await openSession(browser, DESKTOP, "cold");
				landingSession = session;
				return await measureDocument({
					id: "landing-cold-desktop",
					label: "landing cold, desktop 1440x900",
					session,
					cache: "cold",
					navigate: () =>
						session.page.goto("/", {
							waitUntil: "commit",
							timeout: OP_TIMEOUT_MS,
						}),
				});
			} catch (error) {
				await landingSession?.close();
				landingSession = undefined;
				throw error;
			}
		},
	);

	// 2. landing cold, phone.
	await runScenario(
		"landing-cold-phone",
		"landing cold, phone 390x844",
		async () => {
			let session: Session | undefined;
			try {
				session = await openSession(browser, PHONE, "cold");
				return await measureDocument({
					id: "landing-cold-phone",
					label: "landing cold, phone 390x844",
					session,
					cache: "cold",
					navigate: () =>
						session.page.goto("/", {
							waitUntil: "commit",
							timeout: OP_TIMEOUT_MS,
						}),
				});
			} finally {
				await session?.close();
			}
		},
	);

	// 3. landing warm reload (same page and context as scenario 1, cache kept).
	await runScenario(
		"landing-warm-reload",
		"landing warm reload, desktop 1440x900 (same context, cache kept)",
		async () => {
			if (!landingSession) {
				throw new Error(
					"the cold landing context from scenario 1 is not available, so a warm reload cannot be measured",
				);
			}
			return await measureDocument({
				id: "landing-warm-reload",
				label:
					"landing warm reload, desktop 1440x900 (same context, cache kept)",
				session: landingSession,
				cache: "warm",
				navigate: () =>
					landingSession.page.reload({
						waitUntil: "commit",
						timeout: OP_TIMEOUT_MS,
					}),
			});
		},
	);
	await landingSession?.close();
	landingSession = undefined;

	// 4. chat cold, straight to /chat/<id> with the seeded thread.
	await runScenario(
		"chat-cold",
		"chat cold, desktop 1440x900 (eight seeded messages)",
		async () => {
			let session: Session | undefined;
			try {
				session = await openSession(browser, DESKTOP, "cold");
				return await measureDocument({
					id: "chat-cold",
					label: "chat cold, desktop 1440x900 (eight seeded messages)",
					session,
					cache: "cold",
					navigate: () =>
						session.page.goto(`/chat/${conversationId}`, {
							waitUntil: "commit",
							timeout: OP_TIMEOUT_MS,
						}),
				});
			} finally {
				await session?.close();
			}
		},
	);

	// 5. landing → chat client-side transition.
	await runScenario(
		"landing-to-chat-transition",
		"landing → chat client-side transition (a conversation clicked on /)",
		async () => {
			let session: Session | undefined;
			try {
				session = await openSession(browser, DESKTOP, "cold");
				return await measureClientTransition({
					session,
					conversationId,
				});
			} finally {
				await session?.close();
			}
		},
	);

	persist(true);

	const failed = results.filter((result) => result.status === "failed");
	if (failed.length > 0) {
		throw new Error(
			`The measurement run left gaps (${failed
				.map((result) => result.id)
				.join(
					", ",
				)}); both files were written and the report says what could not be measured.`,
		);
	}
});
