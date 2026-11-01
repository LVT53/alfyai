import { appendFileSync } from "node:fs";
import type { Page } from "@playwright/test";

/**
 * What the panel-motion specs measure with (FB-3, ruling 77).
 *
 * The owner sees a layout change as a CUT: the chat column jumps to its new
 * width in one frame while the panel it made room for fades in a moment later.
 * These helpers record what a person's eye sees, frame by frame, and nothing
 * else: a `requestAnimationFrame` sampler of the chat column, the panel and the
 * composer, and a `layout-shift` observer. Both are observation only; the specs
 * drive the page with real pointer and keyboard input.
 *
 * The recorder must exist before the page's own scripts run (a reload with the
 * panel open is one of the cases), so `installMotionRecorder` is an init script:
 * call it at the start of the test, before any navigation.
 */

export type MotionFrame = {
	/** ms since `start()` */
	t: number;
	stageW: number;
	chatW: number;
	chatX: number;
	/** The docked panel's box, zero when there is none on screen. */
	panelW: number;
	panelX: number;
	panelOpacity: number;
	contentOpacity: number;
	composerW: number;
	/** The sidebar's width (0 when absent). */
	sidebarW: number;
	/** What `startRecording` was asked to follow: each selector's box and transform, null while it is not on screen. */
	tracked: Record<string, TrackedBox | null>;
};

export type TrackedBox = {
	x: number;
	y: number;
	w: number;
	h: number;
	transform: string;
	/** The element's own computed opacity (not its ancestors'). */
	opacity: number;
};

export type ShiftEntry = {
	t: number;
	value: number;
	hadRecentInput: boolean;
	/** What moved (the nearest `data-testid`, else the first class), when the browser says. */
	sources?: string[];
};

/** A frame the main thread held longer than 50 ms (`long-animation-frame`). */
export type LongFrame = { t: number; duration: number };

/**
 * A CSS transition that ran while recording: the property it animated and what it
 * ran on (the nearest `data-testid`, else the element's first class), so a spec can
 * hold "only transform and opacity animate" (MOTION-PARITY 3).
 */
export type SeenTransition = {
	t: number;
	property: string;
	target: string;
	/** ms: under reduced motion the app's global rule makes every transition 0.01 ms. */
	duration: number;
	/** The timing function the transition runs on (its keyframe's, where the browser keeps it there). */
	easing: string;
};

/**
 * A script-driven animation (`element.animate`, the dock's expand and dock insets)
 * that ran while recording: what it animated, on what, for how long and on which
 * curve, so a spec can put one kind's timing beside another's.
 */
export type SeenAnimation = {
	t: number;
	target: string;
	properties: string[];
	duration: number;
	easing: string;
};

export type MotionRun = {
	frames: MotionFrame[];
	shifts: ShiftEntry[];
	/** ms since `start()` of the last pointer or key press, or null. */
	inputAt: number | null;
	longFrames: LongFrame[];
	transitions: SeenTransition[];
	animations: SeenAnimation[];
};

export async function installMotionRecorder(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const w = window as unknown as Record<string, unknown>;
		const shifts: ShiftEntry[] = [];
		let frames: MotionFrame[] = [];
		let running = false;
		let t0 = 0;
		let inputAt: number | null = null;
		let tracks: Record<string, string> = {};
		const box = (selector: string): DOMRect | null => {
			const element = document.querySelector<HTMLElement>(selector);
			if (!element) return null;
			if (getComputedStyle(element).display === "none") return null;
			return element.getBoundingClientRect();
		};
		const opacity = (selector: string): number => {
			const element = document.querySelector<HTMLElement>(selector);
			return element ? Number(getComputedStyle(element).opacity) : 0;
		};
		let observer: PerformanceObserver | null = null;
		const collect = (entries: PerformanceEntryList) => {
			for (const entry of entries as unknown as Array<{
				startTime: number;
				value: number;
				hadRecentInput: boolean;
				sources?: Array<{ node?: Node | null }>;
			}>) {
				if (!running) continue;
				shifts.push({
					t: entry.startTime - t0,
					value: entry.value,
					hadRecentInput: entry.hadRecentInput,
					sources: (entry.sources ?? []).map((source) => {
						const node = source.node;
						const element =
							node instanceof Element ? node : (node?.parentElement ?? null);
						const named = element?.closest("[data-testid]");
						return (
							named?.getAttribute("data-testid") ??
							element?.classList?.[0] ??
							element?.tagName.toLowerCase() ??
							"?"
						);
					}),
				});
			}
		};
		try {
			observer = new PerformanceObserver((list) => collect(list.getEntries()));
			observer.observe({ type: "layout-shift", buffered: false });
		} catch {
			observer = null;
		}
		const longFrames: LongFrame[] = [];
		let loafObserver: PerformanceObserver | null = null;
		const collectLong = (entries: PerformanceEntryList) => {
			for (const entry of entries) {
				if (!running || entry.duration <= 50) continue;
				longFrames.push({ t: entry.startTime - t0, duration: entry.duration });
			}
		};
		try {
			loafObserver = new PerformanceObserver((list) =>
				collectLong(list.getEntries()),
			);
			loafObserver.observe({ type: "long-animation-frame", buffered: false });
		} catch {
			loafObserver = null;
		}
		const transitions: SeenTransition[] = [];
		const animations: SeenAnimation[] = [];
		const seenTransitions = new WeakSet<Animation>();
		const easingOf = (effect: KeyframeEffect | null): string => {
			const timing = effect?.getTiming().easing ?? "linear";
			if (timing !== "linear") return timing;
			const keyframes = effect?.getKeyframes() ?? [];
			return String(keyframes[0]?.easing ?? timing);
		};
		const describe = (node: Element | null): string => {
			const named = node?.closest("[data-testid]");
			if (named) return named.getAttribute("data-testid") ?? "";
			return node?.classList?.[0] ?? node?.tagName.toLowerCase() ?? "";
		};
		const noteTransitions = () => {
			for (const animation of document.getAnimations()) {
				if (seenTransitions.has(animation)) continue;
				const property = (
					animation as Animation & { transitionProperty?: string }
				).transitionProperty;
				const effect = animation.effect as KeyframeEffect | null;
				seenTransitions.add(animation);
				if (!property) {
					// A CSS @keyframes animation names itself; only script-driven ones are recorded.
					if (
						(animation as Animation & { animationName?: string }).animationName
					) {
						continue;
					}
					const keyframes = effect?.getKeyframes() ?? [];
					animations.push({
						t: performance.now() - t0,
						target: describe(effect?.target ?? null),
						properties: [
							...new Set(
								keyframes.flatMap((frame) =>
									Object.keys(frame).filter(
										(key) =>
											![
												"offset",
												"computedOffset",
												"easing",
												"composite",
											].includes(key),
									),
								),
							),
						],
						duration: Number(effect?.getTiming().duration ?? 0),
						easing: easingOf(effect),
					});
					continue;
				}
				transitions.push({
					t: performance.now() - t0,
					property,
					target: describe(effect?.target ?? null),
					duration: Number(effect?.getTiming().duration ?? 0),
					easing: easingOf(effect),
				});
			}
		};
		const remember = (event: Event) => {
			if (running) inputAt = event.timeStamp - t0;
		};
		window.addEventListener("pointerdown", remember, true);
		window.addEventListener("keydown", remember, true);
		const sample = () => {
			if (!running) return;
			noteTransitions();
			const stage = box(".chat-stage");
			const chat = box(".chat-main");
			const panel = box("aside.workspace-shell-desktop");
			const composer = box(".composer-shell");
			const sidebar = box("aside.sidebar-panel");
			const tracked: Record<string, TrackedBox | null> = {};
			for (const [name, selector] of Object.entries(tracks)) {
				const element = document.querySelector<HTMLElement>(selector);
				const rect = element ? element.getBoundingClientRect() : null;
				tracked[name] =
					element && rect && rect.width > 0
						? {
								x: rect.x,
								y: rect.y,
								w: rect.width,
								h: rect.height,
								transform: getComputedStyle(element).transform,
								opacity: Number(getComputedStyle(element).opacity),
							}
						: null;
			}
			frames.push({
				t: performance.now() - t0,
				stageW: stage?.width ?? 0,
				chatW: chat?.width ?? 0,
				chatX: chat?.x ?? 0,
				panelW: panel?.width ?? 0,
				panelX: panel?.x ?? 0,
				panelOpacity: panel ? opacity("aside.workspace-shell-desktop") : 0,
				contentOpacity: panel
					? opacity("aside.workspace-shell-desktop .workspace-content")
					: 0,
				composerW: composer?.width ?? 0,
				sidebarW: sidebar?.width ?? 0,
				tracked,
			});
			requestAnimationFrame(sample);
		};
		const api = {
			start(follow?: Record<string, string>) {
				tracks = follow ?? {};
				frames = [];
				shifts.length = 0;
				longFrames.length = 0;
				transitions.length = 0;
				animations.length = 0;
				inputAt = null;
				t0 = performance.now();
				running = true;
				requestAnimationFrame(sample);
			},
			stop(): MotionRun {
				if (observer) collect(observer.takeRecords());
				if (loafObserver) collectLong(loafObserver.takeRecords());
				noteTransitions();
				running = false;
				return {
					frames: frames.slice(),
					shifts: shifts.slice(),
					inputAt,
					longFrames: longFrames.slice(),
					transitions: transitions.slice(),
					animations: animations.slice(),
				};
			},
		};
		w.__panelMotion = api;
		// A page load that was asked to be recorded from its first frame (a reload is one of the cases).
		try {
			if (sessionStorage.getItem("__panelMotionAuto") === "1") {
				sessionStorage.removeItem("__panelMotionAuto");
				api.start();
			}
		} catch {
			// no storage: nothing to resume
		}
	});
}

/** The next load of this tab is recorded from its first frame. Setup, not input. */
export async function recordNextLoad(page: Page): Promise<void> {
	await page.evaluate(() => sessionStorage.setItem("__panelMotionAuto", "1"));
}

/** Starts the sampler. `follow` names elements (by selector) whose box and transform every frame also records. */
export async function startRecording(
	page: Page,
	follow?: Record<string, string>,
): Promise<void> {
	await page.evaluate(
		(tracks) =>
			(
				window as unknown as {
					__panelMotion: { start(follow?: Record<string, string>): void };
				}
			).__panelMotion.start(tracks),
		follow,
	);
}

export async function stopRecording(page: Page): Promise<MotionRun> {
	return page.evaluate(() =>
		(
			window as unknown as { __panelMotion: { stop(): unknown } }
		).__panelMotion.stop(),
	) as Promise<MotionRun>;
}

export type Profile = {
	first: number;
	last: number;
	/** |last - first|: the whole distance the value travels. */
	total: number;
	/** The biggest change between two consecutive frames. */
	maxStep: number;
	/** `maxStep / total` (0 when nothing moved): 1 is a cut. */
	maxStepFraction: number;
	/** Frames whose value is strictly between the start and the end (more than 2 px from both). */
	between: number;
	/** ms after the first frame that moved at which the value last moved by more than 1 px. */
	settledAt: number;
	/** ms of the first frame that moved. */
	movedAt: number;
};

/** How one measured value travels over the frames: a cut, or a motion. */
export function profile(
	frames: MotionFrame[],
	key: keyof Omit<MotionFrame, "t">,
): Profile {
	const values = frames.map((frame) => frame[key]);
	const first = values[0] ?? 0;
	const last = values.at(-1) ?? 0;
	const total = Math.abs(last - first);
	let maxStep = 0;
	let between = 0;
	let settledAt = 0;
	let movedAt = -1;
	for (let index = 0; index < values.length; index++) {
		if (index > 0) {
			const step = Math.abs(values[index] - values[index - 1]);
			maxStep = Math.max(maxStep, step);
			if (step > 1) {
				settledAt = frames[index].t;
				if (movedAt < 0) movedAt = frames[index].t;
			}
		}
		if (
			Math.abs(values[index] - first) > 2 &&
			Math.abs(values[index] - last) > 2
		)
			between += 1;
	}
	return {
		first,
		last,
		total,
		maxStep,
		maxStepFraction: total > 0 ? maxStep / total : 0,
		between,
		settledAt,
		movedAt,
	};
}

export function shiftSum(
	run: MotionRun,
	options: { ignoreRecentInput?: boolean } = {},
): number {
	return run.shifts
		.filter((entry) => !(options.ignoreRecentInput && entry.hadRecentInput))
		.reduce((sum, entry) => sum + entry.value, 0);
}

export function shiftMax(run: MotionRun): number {
	return run.shifts.reduce((max, entry) => Math.max(max, entry.value), 0);
}

/**
 * Appends one line of numbers for the report (the file named by FB3_NUMBERS,
 * when the run sets it). The assertions never read it back.
 */
export function noteNumbers(label: string, numbers: Record<string, unknown>) {
	const file = process.env.FB3_NUMBERS;
	if (!file) return;
	appendFileSync(file, `${JSON.stringify({ label, ...numbers })}\n`);
}
