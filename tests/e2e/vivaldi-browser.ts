// A real Vivaldi for the e2e specs, when the machine has one.
//
// Playwright cannot drive Vivaldi the way it drives its own Chromium: with its
// own launch flags Vivaldi's headless run crashes, and `newPage()` never
// resolves (Vivaldi's tabs live inside its own UI window, an "app" target).
// What works, measured on Vivaldi 8.2 (Chromium 152) on Linux:
//   1. start Vivaldi ourselves, headless, with a DevTools port of the OS's
//      choosing and a throwaway profile;
//   2. wait for its first tab (the welcome page, on a new profile) and
//      navigate it to about:blank: Playwright's `connectOverCDP` never
//      finishes initialising while Vivaldi's welcome page (an extension page)
//      is open;
//   3. connect over CDP and drive that one tab.
// `--force-device-scale-factor` gives the tab a real fractional device pixel
// ratio (what a Linux desktop at 125 % scaling gives Vivaldi), not an emulated one.
import { type ChildProcess, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "@playwright/test";

export const VIVALDI_PATH =
	process.env.VIVALDI_PATH ?? "/usr/bin/vivaldi-stable";

export function hasVivaldi(): boolean {
	return existsSync(VIVALDI_PATH);
}

export type VivaldiTab = {
	browser: Browser;
	/** Its DevTools HTTP port. */
	port: number;
	page: Page;
	/** Closes the browser and removes the throwaway profile. */
	close: () => Promise<void>;
};

type Target = {
	id: string;
	type: string;
	url: string;
	webSocketDebuggerUrl: string;
};

/** `Page.navigate` on one target over its own DevTools socket. */
async function navigateTarget(target: Target, url: string): Promise<void> {
	const socket = new WebSocket(target.webSocketDebuggerUrl);
	try {
		await new Promise<void>((resolve, reject) => {
			socket.onopen = () => resolve();
			socket.onerror = () => reject(new Error("[vivaldi] tab socket failed"));
		});
		const replied = new Promise<void>((resolve) => {
			socket.onmessage = () => resolve();
		});
		socket.send(
			JSON.stringify({ id: 1, method: "Page.navigate", params: { url } }),
		);
		await replied;
	} finally {
		socket.close();
	}
}

const until = async <T>(
	what: string,
	probe: () => Promise<T | undefined> | T | undefined,
	timeoutMs = 20_000,
): Promise<T> => {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`[vivaldi] timed out: ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
};

async function targets(port: number): Promise<Target[]> {
	const response = await fetch(`http://127.0.0.1:${port}/json/list`);
	return (await response.json()) as Target[];
}

/**
 * Grows Vivaldi's window until the tab's viewport is `width`×`height` CSS
 * pixels: its own UI (the panel strip, the tab and address bars) takes a
 * share of the window. Real geometry rather than an emulated viewport, which
 * Vivaldi drops when the tab changes renderer and which Playwright would pin
 * to a device pixel ratio of 1.
 */
async function fitViewport(
	browser: Browser,
	page: Page,
	width: number,
	height: number,
): Promise<void> {
	const tab = await page.context().newCDPSession(page);
	const { targetInfo } = await tab.send("Target.getTargetInfo");
	await tab.detach();
	const session = await browser.newBrowserCDPSession();
	const { windowId } = await session.send("Browser.getWindowForTarget", {
		targetId: targetInfo.targetId,
	});
	const viewport = () =>
		page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
	for (let attempt = 0; attempt < 4; attempt++) {
		const inner = await viewport();
		if (inner.width === width && inner.height === height) break;
		const { bounds } = await session.send("Browser.getWindowBounds", {
			windowId,
		});
		await session.send("Browser.setWindowBounds", {
			windowId,
			bounds: {
				width: (bounds.width ?? width) + width - inner.width,
				height: (bounds.height ?? height) + height - inner.height,
			},
		});
		await until(
			"the window to take its new size",
			async () => {
				const now = await viewport();
				return now.width !== inner.width || now.height !== inner.height
					? true
					: undefined;
			},
			5_000,
		).catch(() => undefined);
	}
	await session.detach();
	// At a fractional ratio the window is sized in whole device-independent
	// pixels and the tab in whole device pixels: a pixel or two either way.
	const inner = await viewport();
	if (
		Math.abs(inner.width - width) > 2 ||
		Math.abs(inner.height - height) > 2
	) {
		throw new Error(
			`[vivaldi] viewport is ${inner.width}x${inner.height}, wanted ${width}x${height}`,
		);
	}
}

/**
 * Vivaldi, headless, one tab of our own, at `deviceScaleFactor` (a real
 * device pixel ratio) and a `width`×`height` CSS-pixel viewport.
 */
export async function launchVivaldi(options: {
	width: number;
	height: number;
	deviceScaleFactor: number;
}): Promise<VivaldiTab> {
	const profile = mkdtempSync(join(tmpdir(), "alfyai-vivaldi-"));
	// Downloads start by themselves (Vivaldi's own "Download …?" dialog would
	// wait for a click no one makes) and land in the throwaway profile, never in
	// the machine's ~/Downloads, until `saveDownloadsTo` names a folder.
	const downloads = join(profile, "Downloads");
	mkdirSync(join(profile, "Default"), { recursive: true });
	writeFileSync(
		join(profile, "Default", "Preferences"),
		JSON.stringify({
			download: { default_directory: downloads, prompt_for_download: false },
			savefile: { default_directory: downloads },
			vivaldi: { downloads: { start_automatically: true } },
		}),
	);
	let child: ChildProcess | null = spawn(
		VIVALDI_PATH,
		[
			"--headless",
			"--remote-debugging-port=0",
			`--user-data-dir=${profile}`,
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-sync",
			`--force-device-scale-factor=${options.deviceScaleFactor}`,
			`--window-size=${options.width},${options.height}`,
			"about:blank",
		],
		// Its own process group, so the browser and its helpers stop together.
		{ stdio: "ignore", detached: true },
	);
	const exited = new Promise<void>((resolve) =>
		child?.once("exit", () => resolve()),
	);
	// A test that times out never reaches its `finally`, and a detached group
	// outlives the worker: the worker's own exit takes the browser down too.
	const group = child.pid;
	const killGroupOnExit = () => {
		try {
			if (group) process.kill(-group, "SIGKILL");
		} catch {
			// Already gone.
		}
		rmSync(profile, { recursive: true, force: true });
	};
	process.once("exit", killGroupOnExit);
	const cleanUp = async () => {
		process.off("exit", killGroupOnExit);
		const running = child;
		child = null;
		if (
			running?.pid &&
			running.exitCode === null &&
			running.signalCode === null
		) {
			// A polite stop lets Vivaldi take its own helpers down with it;
			// then the whole group, in case one lingers on.
			running.kill("SIGTERM");
			await Promise.race([
				exited,
				new Promise((resolve) => setTimeout(resolve, 10_000)),
			]);
			try {
				process.kill(-running.pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}
		rmSync(profile, { recursive: true, force: true, maxRetries: 10 });
	};
	try {
		// Chromium writes the port it chose (first line) once DevTools listens.
		const port = await until("DevTools port", () => {
			const file = join(profile, "DevToolsActivePort");
			if (!existsSync(file)) return undefined;
			const first = readFileSync(file, "utf8").split("\n")[0];
			const port = Number(first);
			return Number.isInteger(port) && port > 0 ? port : undefined;
		});
		// The first tab: Vivaldi's welcome page on a new profile. Navigated away
		// over its own DevTools socket, it becomes the tab we drive. (Making a new
		// tab instead only works once Vivaldi's UI has finished starting, which
		// nothing announces.)
		const first = await until("the first tab", async () => {
			const pages = (await targets(port).catch(() => [])).filter(
				(target) => target.type === "page",
			);
			return pages[0];
		});
		await navigateTarget(first, "about:blank");
		await until("one blank tab", async () => {
			const pages = (await targets(port)).filter(
				(target) => target.type === "page",
			);
			return pages.length === 1 && pages[0].url === "about:blank"
				? true
				: undefined;
		});

		const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
			timeout: 20_000,
		});
		const page = browser.contexts()[0]?.pages()[0];
		if (!page) throw new Error("[vivaldi] connected, but no tab to drive");
		await fitViewport(browser, page, options.width, options.height);
		return {
			browser,
			port,
			page,
			close: async () => {
				await browser.close().catch(() => {});
				await cleanUp();
			},
		};
	} catch (error) {
		await cleanUp();
		throw error;
	}
}

export type SavedDownload = {
	/** The name the browser proposed from the response (Content-Disposition, else the URL). */
	suggestedFilename: string;
	/** The name of the file it wrote to `dir`: what the person finds on disk. */
	savedAs: string;
};

/**
 * Lets Vivaldi save downloads into `dir` under the names it picks itself
 * (Playwright's own download handling renames every file to a GUID), and
 * hands back each finished one.
 */
export async function saveDownloadsTo(
	browser: Browser,
	dir: string,
): Promise<{ next: () => Promise<SavedDownload> }> {
	const session = await browser.newBrowserCDPSession();
	await session.send("Browser.setDownloadBehavior", {
		behavior: "allow",
		downloadPath: dir,
		eventsEnabled: true,
	});
	const suggested = new Map<string, string>();
	const finished: SavedDownload[] = [];
	const waiting: ((download: SavedDownload) => void)[] = [];
	const known = new Set(readdirSync(dir));
	session.on("Browser.downloadWillBegin", (event) => {
		suggested.set(event.guid, event.suggestedFilename);
	});
	session.on("Browser.downloadProgress", (event) => {
		if (event.state !== "completed") return;
		const fresh = readdirSync(dir).filter(
			(name) => !known.has(name) && !name.endsWith(".crdownload"),
		);
		for (const name of fresh) known.add(name);
		const download = {
			suggestedFilename: suggested.get(event.guid) ?? "",
			savedAs: fresh.join(" + "),
		};
		const waiter = waiting.shift();
		if (waiter) waiter(download);
		else finished.push(download);
	});
	return {
		next: () => {
			const ready = finished.shift();
			if (ready) return Promise.resolve(ready);
			return new Promise((resolve) => waiting.push(resolve));
		},
	};
}
