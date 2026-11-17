// Read aloud, end to end, against the fake speech service (Plan 2, Task 16).
//
// The fake follows the service's README (one reader of each stream, sentences
// made only while `i <= position + 2`, times on the stream's clock), so what
// these specs prove is the app's side of it: the speaker, the session routes,
// the replay, the player, the marks and Read from here, in the real browser on
// the production build. The failures of spec §4.8 are in
// `read-aloud-failures.spec.ts`.
import { expect, test } from "@playwright/test";
import {
	expectTopmost,
	login,
	waitForHydration,
	waitForMotionToSettle,
} from "./helpers";
import {
	deleteReadAloudChat,
	type FakeSpeechService,
	FIVE_SENTENCE_REPLY,
	GERMAN_REPLY,
	hasRun,
	openReadAloudChat,
	readAloudUi,
	SYNTAX_REPLY,
	selectInReply,
	spokenTokens,
	startFakeSpeechForSpec,
	stopFakeSpeechForSpec,
	TWO_SENTENCE_REPLY,
} from "./read-aloud-helpers";

let fake: FakeSpeechService;
let chatId: string | null = null;

test.beforeEach(async ({ page }) => {
	await login(page);
	fake = await startFakeSpeechForSpec(page, { secondsPerChar: 0.02 });
});

test.afterEach(async ({ page }) => {
	try {
		if (chatId) await deleteReadAloudChat(page, chatId);
	} finally {
		chatId = null;
		await stopFakeSpeechForSpec(page, fake);
	}
});

async function open(page: import("@playwright/test").Page, replies: string[]) {
	const opened = await openReadAloudChat(page, replies);
	chatId = opened.chatId;
	return readAloudUi(page);
}

/** Where the first tint box is, as a string a poll can compare. */
async function tintPlace(ui: ReturnType<typeof readAloudUi>): Promise<string> {
	const box = await ui.tint.first().boundingBox();
	return box
		? `${Math.round(box.x)}:${Math.round(box.y)}:${Math.round(box.width)}`
		: "none";
}

test("@smoke the speaker reads a reply: the player rises and the tint moves", async ({
	page,
}) => {
	const ui = await open(page, [FIVE_SENTENCE_REPLY]);
	await expect(ui.speaker()).toHaveAttribute("aria-label", "Read aloud");
	await ui.speaker().click();

	await expect(ui.player).toBeVisible();
	// Playwright counts an element at opacity 0 as visible: the pill must have risen.
	await expect(ui.player).toHaveCSS("opacity", "1");
	await expect(ui.tint.first()).toBeVisible();
	const first = await tintPlace(ui);
	expect(first).not.toBe("none");
	// The second sentence's tint shows: the same box, somewhere else.
	await expect.poll(() => tintPlace(ui), { timeout: 15_000 }).not.toBe(first);
	await expect(ui.speaker()).toHaveAttribute("aria-label", "Pause reading");
});

test("no syntax reaches the voice, and code is read the way a teacher says it", async ({
	page,
}) => {
	const ui = await open(page, [SYNTAX_REPLY]);
	await ui.speaker().click();
	await expect.poll(() => fake.sessions.length).toBeGreaterThan(0);

	const tokens = spokenTokens(fake);
	expect(tokens.length).toBeGreaterThan(10);
	for (const token of tokens) {
		for (const forbidden of ["*", "`", "#", "|", "[", "]", "http", "www."])
			expect(token, `a token holds ${forbidden}`).not.toContain(forbidden);
		expect(["secret", "secretCode", "TABLECELL"]).not.toContain(token);
	}
	// A name is split, a two-line block is read, a numbered list says its numbers
	// and a bare address says its site.
	expect(hasRun(tokens, ["get", "User", "Name"])).toBe(true);
	expect(hasRun(tokens, ["total", "equals", "price", "star", "two"])).toBe(
		true,
	);
	expect(tokens).toContain("One.");
	expect(hasRun(tokens, ["example", "dot", "com"])).toBe(true);
	// The five-line block and the table are left out.
	expect(tokens.join(" ")).not.toContain("forty-two");
});

test("plain arithmetic in a sentence is read with its operators", async ({
	page,
}) => {
	const ui = await open(page, [
		"We know that 3 + 4 = 7 and 12 - 5 = 7 here. So €10 + €5 = €15 and 1,000 + 2,000 = 3,000, and x + 2 = 7 for x.",
	]);
	await ui.speaker().click();
	await expect.poll(() => fake.sessions.length, { timeout: 15_000 }).toBe(1);
	const tokens = spokenTokens(fake);
	expect(hasRun(tokens, ["3", "plus", "4", "equals", "7"])).toBe(true);
	expect(hasRun(tokens, ["12", "minus", "5", "equals", "7"])).toBe(true);
	// Money, thousands and a letter (the third re-walk's New 4); the session route
	// checks every one of these tokens, so the reading starts only if they fit.
	expect(hasRun(tokens, ["€10", "plus", "€5", "equals", "€15"])).toBe(true);
	expect(hasRun(tokens, ["1000", "plus", "2000", "equals", "3000"])).toBe(true);
	expect(hasRun(tokens, ["x", "plus", "2", "equals", "7"])).toBe(true);
});

test("a Hungarian sum is read in Hungarian, its money and decimal commas too", async ({
	page,
}) => {
	const ui = await open(page, [
		"Tehát €10 + €5 = €15 összesen, és 1,5 + 2,25 = 3,75 is igaz, valamint az x + 2 = 7 egyenlet megoldása könnyű.",
	]);
	await ui.speaker().click();
	await expect.poll(() => fake.sessions.length, { timeout: 15_000 }).toBe(1);
	const tokens = spokenTokens(fake);
	expect(
		hasRun(tokens, ["10", "€", "plusz", "5", "€", "egyenlő", "15", "€"]),
	).toBe(true);
	expect(hasRun(tokens, ["1,5", "plusz", "2,25", "egyenlő", "3,75"])).toBe(
		true,
	);
	expect(hasRun(tokens, ["x", "plusz", "2", "egyenlő", "7"])).toBe(true);
});

/** Records every media element `play()` is called on, so a spec can reach the reading's audio (it is not in the page). */
async function recordMediaElements(page: import("@playwright/test").Page) {
	await page.addInitScript(() => {
		const played: HTMLMediaElement[] = [];
		(window as unknown as { __played: HTMLMediaElement[] }).__played = played;
		const play = HTMLMediaElement.prototype.play;
		HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
			if (!played.includes(this)) played.push(this);
			return play.call(this);
		};
	});
}

/** What a media key or Now Playing does: plays the reading's audio element again. Whether it sounded. */
function wakeReadingAudio(page: import("@playwright/test").Page) {
	return page.evaluate(async () => {
		const audio = (window as unknown as { __played: HTMLMediaElement[] })
			.__played[0];
		if (!audio) return "no element";
		const at = audio.currentTime;
		await audio.play().catch(() => undefined);
		await new Promise((resolve) => setTimeout(resolve, 400));
		return !audio.paused && audio.currentTime > at ? "sounded" : "silent";
	});
}

test("a reading another tab starts after the voice has finished ends this one quietly (early review R7)", async ({
	page,
	context,
}) => {
	// Two sentences: the fake makes both at once, so the service's `done` is in long before
	// this tab has played them. The browser keeps its events stream open after `done`, so the
	// second tab's press still reaches it.
	const opened = await openReadAloudChat(page, [TWO_SENTENCE_REPLY]);
	chatId = opened.chatId;
	// Slow speech, so that this tab is still playing, many seconds on, however long the second
	// tab takes to load on a busy machine (at 0.02 s a character the whole reply is over in 3 s).
	fake.setOptions({ secondsPerChar: 0.3 });
	const ui = readAloudUi(page);
	const failed: string[] = [];
	page.on("response", (response) => {
		if (response.status() >= 400 && response.url().includes("/api/read-aloud/"))
			failed.push(
				`${response.request().method()} ${response.url()} -> ${response.status()}`,
			);
	});
	const eventsRequest = page.waitForRequest(
		/\/api\/read-aloud\/sessions\/[^/]+\/events$/,
	);
	await ui.speaker().click();
	await expect(ui.player).toBeVisible();
	const eventsUrl = (await eventsRequest).url();

	// The service has said `done`: asked again, the server's replay of the timeline ends in it.
	await expect
		.poll(
			() =>
				page.evaluate(async (url) => {
					const abort = new AbortController();
					const timer = setTimeout(() => abort.abort(), 4000);
					try {
						const reply = await fetch(url, { signal: abort.signal });
						if (!reply.ok) return `answered ${reply.status}`;
						const reader = (
							reply.body as ReadableStream<Uint8Array>
						).getReader();
						let seen = "";
						while (!seen.includes("event: done")) {
							const { done, value } = await reader.read();
							if (done) break;
							seen += new TextDecoder().decode(value);
						}
						abort.abort();
						return seen.includes("event: done")
							? "done"
							: `no done in ${JSON.stringify(seen.slice(-160))}`;
					} catch (error) {
						return `threw ${String(error)}`;
					} finally {
						clearTimeout(timer);
					}
				}, eventsUrl),
			{
				message:
					"the server still holds the finished reading, and its timeline ends in done",
				timeout: 15_000,
			},
		)
		.toBe("done");
	await expect(ui.speaker()).toHaveAttribute("aria-label", "Pause reading");

	// The same person starts a reading in another tab.
	const other = await context.newPage();
	try {
		await other.goto(`/chat/${opened.chatId}`, {
			waitUntil: "domcontentloaded",
		});
		await waitForHydration(other);
		const otherUi = readAloudUi(other);
		await expect(
			other.locator(
				`[data-message-id="${opened.messageIds[0]}"] .markdown-container`,
			),
		).toContainText(/\S/, { timeout: 15_000 });
		await otherUi.speaker().click();
		await expect(otherUi.player).toBeVisible();
		await expect(otherUi.speaker()).toHaveAttribute(
			"aria-label",
			"Pause reading",
		);

		// This tab's reading ended with nothing said, and nothing failed on the way.
		await expect(ui.player).toHaveCount(0);
		await expect(ui.speaker()).toHaveAttribute("aria-label", "Read aloud");
		await expect(ui.note).toHaveCount(0);
		expect(failed).toEqual([]);
	} finally {
		await other.close();
	}
});

test("after ✕ nothing wakes the reading: the Media Session is let go, and its old audio plays nothing", async ({
	page,
}) => {
	await recordMediaElements(page);
	const ui = await open(page, [FIVE_SENTENCE_REPLY]);
	await ui.speaker().click();
	await expect(ui.speaker()).toHaveAttribute("aria-label", "Pause reading");
	expect(await page.evaluate(() => navigator.mediaSession.playbackState)).toBe(
		"playing",
	);
	await ui.button("Stop reading").click();
	await expect(ui.player).toBeHidden();
	expect(await page.evaluate(() => navigator.mediaSession.playbackState)).toBe(
		"none",
	);
	expect(await wakeReadingAudio(page)).toBe("silent");
	await expect(ui.speaker()).toHaveAttribute("aria-label", "Read aloud");
});

test("a paused reading is not woken by the OS: a play it did not ask for is paused at once", async ({
	page,
}) => {
	await recordMediaElements(page);
	const ui = await open(page, [FIVE_SENTENCE_REPLY]);
	await ui.speaker().click();
	await expect(ui.speaker()).toHaveAttribute("aria-label", "Pause reading");
	await ui.button("Pause").click();
	await expect(ui.speaker()).toHaveAttribute("aria-label", "Resume reading");
	expect(await page.evaluate(() => navigator.mediaSession.playbackState)).toBe(
		"paused",
	);
	expect(await wakeReadingAudio(page)).toBe("silent");
	await expect(ui.speaker()).toHaveAttribute("aria-label", "Resume reading");
	// The person's own play still plays.
	await ui.button("Play").click();
	await expect(ui.speaker()).toHaveAttribute("aria-label", "Pause reading");
});

/** Where the reading's audio is: paused or not, its position and its source. */
function readingAudioState(page: import("@playwright/test").Page) {
	return page.evaluate(() => {
		const audio = (window as unknown as { __played: HTMLMediaElement[] })
			.__played[0];
		return {
			paused: audio.paused,
			at: audio.currentTime,
			src: audio.currentSrc,
		};
	});
}

test('while the voice catches up a press on the spinning play button pauses, and a second press resumes where it was (owner: "Yes, press pauses")', async ({
	page,
}) => {
	await recordMediaElements(page);
	const ui = await open(page, [FIVE_SENTENCE_REPLY]);
	await ui.speaker().click();
	await expect(ui.speaker()).toHaveAttribute("aria-label", "Pause reading");
	// The voice falls behind: the reading's audio says it waits for data. (The fake
	// keeps its stream ahead of the reading, so the spec says it for the audio.)
	await page.evaluate(() =>
		(
			window as unknown as { __played: HTMLMediaElement[] }
		).__played[0].dispatchEvent(new Event("waiting")),
	);
	const spinner = ui.play.locator(".mini-spinner");
	await expect(spinner).toBeVisible();
	const nameWhileSpinning = await ui.play.getAttribute("aria-label");

	// A press pauses, exactly as at any other moment: the spinner stops and the button shows play.
	await ui.play.click();
	await expect(ui.speaker()).toHaveAttribute("aria-label", "Resume reading");
	await expect(spinner).toHaveCount(0);
	await expect(ui.play).toHaveAttribute("aria-label", "Play");
	expect(await page.evaluate(() => navigator.mediaSession.playbackState)).toBe(
		"paused",
	);
	const paused = await readingAudioState(page);
	expect(paused.paused).toBe(true);
	expect(paused.at).toBeGreaterThan(0);

	// A second press resumes where the reading was: the same audio, on from there.
	await ui.play.click();
	expect((await readingAudioState(page)).at).toBeGreaterThanOrEqual(paused.at);
	await expect(ui.speaker()).toHaveAttribute("aria-label", "Pause reading");
	await expect
		.poll(async () => {
			const now = await readingAudioState(page);
			return now.src === paused.src && !now.paused && now.at > paused.at;
		})
		.toBe(true);
	expect(fake.sessions.length).toBe(1);
	// While it spun, its name said what a press does.
	expect(nameWhileSpinning).toBe("Pause");
});

test("simple math is read, as the owner's sum showed on staging", async ({
	page,
}) => {
	// The Markdown as the model writes it: marked shows "\\(" as a plain bracket.
	const ui = await open(page, [
		"It wouldn't read this at all: \\(€4{,}341.0505 \\times 0.88 = €3{,}820.12444\\)",
	]);
	await expect(page.locator(".message-body .markdown-container")).toContainText(
		"(€4{,}341.0505 \\times 0.88 = €3{,}820.12444)",
	);
	await ui.speaker().click();
	await expect.poll(() => fake.sessions.length, { timeout: 15_000 }).toBe(1);
	const tokens = spokenTokens(fake);
	expect(
		hasRun(tokens, ["€4341.0505", "times", "0.88", "equals", "€3820.12444"]),
	).toBe(true);
});

test("a code name is marked while it is read, above the code's own background", async ({
	page,
}) => {
	const ui = await open(page, [SYNTAX_REPLY]);
	await ui.speaker().click();
	await expect(ui.player).toBeVisible();
	// The inline code's sentence is the second: the code is tinted whole by an attribute,
	// drawn as an inset shadow above its own background (the overlay behind the prose
	// cannot), so its padding and its rounded corners are tinted too.
	const code = page.locator(".markdown-container code", {
		hasText: "getUserName()",
	});
	await expect(code).toHaveAttribute(
		"data-read-aloud-code-mark",
		/^(sentence|word)$/,
		{ timeout: 15_000 },
	);
	expect(
		await code.evaluate((node) => getComputedStyle(node).boxShadow),
	).toContain("inset");
	// A code block's sentence is one highlight per line: the spaces between its words too.
	const blockRuns = () =>
		page.evaluate(() =>
			[
				...((
					CSS as unknown as { highlights?: Map<string, Iterable<Range>> }
				).highlights?.get("read-aloud-code-sentence") ?? []),
			].map((range) => range.toString()),
		);
	await expect
		.poll(blockRuns, { timeout: 15_000 })
		.toContain("total = price * 2");

	// ✕ fades the block's highlights out, as the prose's marks fade, then clears them.
	await page.evaluate(() => {
		const w = window as unknown as {
			__codeFade: Array<{ drawn: boolean; strength: string }>;
		};
		w.__codeFade = [];
		const step = () => {
			w.__codeFade.push({
				drawn:
					(
						CSS as unknown as { highlights?: Map<string, unknown> }
					).highlights?.has("read-aloud-code-sentence") ?? false,
				strength: getComputedStyle(document.documentElement)
					.getPropertyValue("--read-aloud-code-strength")
					.trim(),
			});
			requestAnimationFrame(step);
		};
		requestAnimationFrame(step);
	});
	await ui.button("Stop reading").click();
	await expect.poll(blockRuns).toEqual([]);
	const fade = await page.evaluate(
		() =>
			(
				window as unknown as {
					__codeFade: Array<{ drawn: boolean; strength: string }>;
				}
			).__codeFade,
	);
	expect(
		fade.some((frame) => {
			const strength = Number.parseFloat(frame.strength);
			return frame.drawn && strength > 0 && strength < 1;
		}),
	).toBe(true);
});

test("✕ stops, and the end shows Finished", async ({ page }) => {
	const ui = await open(page, [FIVE_SENTENCE_REPLY]);
	await ui.speaker().click();
	await expect(ui.player).toBeVisible();

	// Reading to the end needs the position reports: the fake holds sentence i
	// until i <= position + 2, so the last two only come once the browser says
	// where it is.
	await expect(ui.player).toHaveAttribute("data-finished", "", {
		timeout: 30_000,
	});
	await expect(ui.player.getByText("Finished")).toBeVisible();
	expect(fake.sessions[0]?.positions.length).toBeGreaterThan(0);
	await expect(ui.player).toBeHidden();
	await expect(ui.speaker()).toHaveAttribute("aria-label", "Read aloud");

	await ui.speaker().click();
	await expect(ui.player).toBeVisible();
	await ui.button("Stop reading").click();
	await expect(ui.player).toBeHidden();
	await expect.poll(() => fake.sessions.at(-1)?.deleted).toBe(true);
	await expect(ui.speaker()).toHaveAttribute("aria-label", "Read aloud");
});

/** What the floating player looked like in one animation frame. */
type PlayerFrame = {
	/** The slot's height: the player's room. */
	room: number;
	pill: boolean;
	/** A CSS transition ran on the pill's opacity (it faded). */
	fading: boolean;
	/** A CSS transition ran on the slot's margin (the room's edge moved, not jumped). */
	edge: boolean;
	finished: boolean;
	time: string | null;
	value: string | null;
	/** ✕ had been pressed. */
	stopped: boolean;
};

/** Starts writing down, once per animation frame, what the floating player shows. */
async function recordPlayer(page: import("@playwright/test").Page) {
	await page.evaluate(() => {
		const w = window as unknown as {
			__playerFrames: PlayerFrame[];
			__stopPressed: boolean;
		};
		w.__playerFrames = [];
		w.__stopPressed = false;
		document.addEventListener(
			"pointerdown",
			(event) => {
				if (
					(event.target as Element | null)?.closest?.(
						'[aria-label="Stop reading"]',
					)
				)
					w.__stopPressed = true;
			},
			true,
		);
		const slot = document.querySelector(".read-aloud-slot") as HTMLElement;
		const running = (element: Element | null, property: string) =>
			(element?.getAnimations() ?? []).some(
				(animation) =>
					(animation as CSSTransition).transitionProperty === property,
			);
		const step = () => {
			const pill = document.querySelector(
				".read-aloud-pill[data-variant='floating']",
			);
			w.__playerFrames.push({
				room: slot.getBoundingClientRect().height,
				pill: pill !== null,
				fading: running(pill, "opacity"),
				edge: running(slot, "margin-top"),
				finished: pill?.hasAttribute("data-finished") ?? false,
				time: pill?.querySelector(".read-aloud-time")?.textContent ?? null,
				value:
					pill
						?.querySelector('[role="slider"]')
						?.getAttribute("aria-valuetext") ?? null,
				stopped: w.__stopPressed,
			});
			requestAnimationFrame(step);
		};
		requestAnimationFrame(step);
	});
	return () =>
		page.evaluate(
			() =>
				(window as unknown as { __playerFrames: PlayerFrame[] }).__playerFrames,
		);
}

test("the player fades in as it rises; on ✕ it leaves as it was while its room closes", async ({
	page,
}) => {
	const ui = await open(page, [FIVE_SENTENCE_REPLY]);
	const frames = await recordPlayer(page);
	await ui.speaker().click();
	await expect(ui.player).toHaveCSS("opacity", "1");
	await waitForMotionToSettle(page);
	const opening = await frames();
	// It faded in from its own start, and the room's edge moved with the room.
	expect(opening.some((frame) => frame.fading)).toBe(true);
	expect(opening.some((frame) => frame.edge)).toBe(true);
	const room = Math.max(...opening.map((frame) => frame.room));

	// Let the reading move on, so its controls are not at their start.
	await expect(ui.slider).not.toHaveAttribute(
		"aria-valuetext",
		"Sentence 1 of 5",
		{ timeout: 15_000 },
	);
	await ui.button("Stop reading").click();
	await expect(ui.player).toBeHidden();
	const leaving = (await frames()).filter(
		(frame) => frame.stopped && frame.pill,
	);
	// Its controls stay as they were while it sinks and its room closes.
	expect(new Set(leaving.map((frame) => frame.value)).size).toBe(1);
	expect(new Set(leaving.map((frame) => frame.time)).size).toBe(1);
	expect(leaving[0]?.value).not.toBe("Sentence 1 of 5");
	// The room closes around it over several frames: the thread follows, never jumps.
	expect(
		leaving.filter((frame) => frame.room > 0.5 && frame.room < room - 0.5)
			.length,
	).toBeGreaterThanOrEqual(2);
	expect(leaving.some((frame) => frame.edge)).toBe(true);
});

test("the end keeps Finished over its controls until the player has gone", async ({
	page,
}) => {
	const ui = await open(page, [TWO_SENTENCE_REPLY]);
	// Nothing asks for a session the server has already closed (it closes one once
	// the browser has all its audio): no position report or DELETE answers 404.
	const missing: string[] = [];
	page.on("response", (response) => {
		if (
			response.url().includes("/api/read-aloud/sessions/") &&
			response.status() === 404
		)
			missing.push(
				`${response.request().method()} ${new URL(response.url()).pathname}`,
			);
	});
	const frames = await recordPlayer(page);
	await ui.speaker().click();
	await expect(ui.player).toHaveAttribute("data-finished", "", {
		timeout: 30_000,
	});
	await expect(ui.player).toBeHidden();
	expect(missing).toEqual([]);
	const all = await frames();
	const end = all.slice(all.findIndex((frame) => frame.finished));
	const shown = end.filter((frame) => frame.pill);
	expect(shown.length).toBeGreaterThan(0);
	// "Finished" stays over the end's controls: no 0:00, no handle back at the start.
	expect(shown.every((frame) => frame.finished)).toBe(true);
	expect(new Set(shown.map((frame) => frame.time)).size).toBe(1);
	expect(shown[0]?.time).not.toBe("0:00");
});

test("a switch spins the new reply's speaker, and the player never counts no sentences", async ({
	page,
}) => {
	const ui = await open(page, [FIVE_SENTENCE_REPLY, TWO_SENTENCE_REPLY]);
	await ui.speaker(0).click();
	await expect(ui.speaker(0)).toHaveAttribute("aria-label", "Pause reading");
	await waitForMotionToSettle(page);
	// The second reply's voice takes a while, as a real one does.
	fake.setOptions({ secondsPerChar: 0.02, firstAudioDelayMs: 700 });
	await page.evaluate(() => {
		const w = window as unknown as {
			__switchFrames: Array<{
				label: string | null;
				spinning: boolean;
				value: string | null;
			}>;
		};
		w.__switchFrames = [];
		const step = () => {
			const speaker = document.querySelectorAll(
				'[data-testid="read-aloud-speaker"]',
			)[1];
			w.__switchFrames.push({
				label: speaker?.getAttribute("aria-label") ?? null,
				spinning: speaker?.querySelector(".mini-spinner") != null,
				value:
					document
						.querySelector(
							".read-aloud-pill[data-variant='floating'] [role='slider']",
						)
						?.getAttribute("aria-valuetext") ?? null,
			});
			requestAnimationFrame(step);
		};
		requestAnimationFrame(step);
	});
	await ui.speaker(1).click();
	await expect(ui.speaker(1)).toHaveAttribute("aria-label", "Pause reading", {
		timeout: 15_000,
	});
	const frames = await page.evaluate(
		() =>
			(
				window as unknown as {
					__switchFrames: Array<{
						label: string | null;
						spinning: boolean;
						value: string | null;
					}>;
				}
			).__switchFrames,
	);
	// While it gets the voice it spins, and never says "Resume" for a reply that has not played.
	expect(frames.some((frame) => frame.spinning)).toBe(true);
	expect(frames.map((frame) => frame.label)).not.toContain("Resume reading");
	expect(frames.filter((frame) => /of 0$/.test(frame.value ?? "")).length).toBe(
		0,
	);
});

test("a slash command hushes the player, and reading goes on", async ({
	page,
}) => {
	const config = await page.request.put("/api/admin/config", {
		data: { COMPOSER_COMMAND_REGISTRY_ENABLED: "true" },
	});
	expect(config.ok()).toBe(true);
	try {
		const ui = await open(page, [FIVE_SENTENCE_REPLY]);
		await ui.speaker().click();
		await expect(ui.player).toBeVisible();
		await waitForMotionToSettle(page);
		const room = await ui.slot.boundingBox();
		const opacity = () =>
			ui.stage.evaluate((node) => getComputedStyle(node).opacity);
		await expect.poll(opacity).toBe("1");

		await page.getByTestId("message-input").fill("/");
		await expect(page.locator("#composer-command-tray")).toBeVisible();
		// Hushed: gone from sight, keeping its room, and the reading goes on.
		await expect(ui.slot).toHaveAttribute("data-hushed", "");
		await expect.poll(opacity).toBe("0");
		expect((await ui.slot.boundingBox())?.height).toBeCloseTo(
			room?.height ?? 0,
			0,
		);
		await expect(ui.speaker()).toHaveAttribute("aria-label", "Pause reading");

		await page.getByTestId("message-input").fill("");
		await expect(page.locator("#composer-command-tray")).toBeHidden();
		await expect(ui.slot).not.toHaveAttribute("data-hushed", "");
		await expect.poll(opacity).toBe("1");
	} finally {
		await page.request.put("/api/admin/config", {
			data: { COMPOSER_COMMAND_REGISTRY_ENABLED: "" },
		});
	}
});

test("another reply's speaker switches without the player leaving", async ({
	page,
}) => {
	const ui = await open(page, [FIVE_SENTENCE_REPLY, TWO_SENTENCE_REPLY]);
	await ui.speaker(0).click();
	await expect(ui.player).toBeVisible();
	await waitForMotionToSettle(page);
	const handle = await ui.player.elementHandle();

	await ui.speaker(1).click();
	// The player stays: the same element, still shown, with no exit and re-entry.
	await expect(ui.player).toBeVisible();
	await expect(ui.speaker(1)).toHaveAttribute("aria-label", "Pause reading");
	await expect.poll(() => fake.sessions.length).toBe(2);
	expect(await handle?.evaluate((node) => node.isConnected)).toBe(true);
	await expect(ui.speaker(0)).toHaveAttribute("aria-label", "Read aloud");
	await expect.poll(() => fake.sessions[0]?.deleted).toBe(true);
});

test("the scrubber jumps to a sentence, and the arrows step", async ({
	page,
}) => {
	const ui = await open(page, [FIVE_SENTENCE_REPLY]);
	await ui.speaker().click();
	await expect(ui.player).toBeVisible();
	await expect(ui.slider).toBeVisible();
	const firstSentence = () => fake.sessions.at(-1)?.body.sentences[0]?.id;

	await ui.slider.focus();
	await page.keyboard.press("End");
	await expect.poll(firstSentence).toBe("s4");
	await page.keyboard.press("ArrowLeft");
	await expect.poll(firstSentence).toBe("s3");
	await page.keyboard.press("Home");
	await expect.poll(firstSentence).toBe("s0");

	// A tap near the end of the line jumps like a drag.
	const box = await ui.slider.boundingBox();
	expect(box).toBeTruthy();
	await ui.slider.click({
		position: { x: (box?.width ?? 100) - 2, y: (box?.height ?? 32) / 2 },
	});
	await expect.poll(firstSentence).toBe("s4");
	// Each jump is a new session.
	await expect.poll(() => fake.sessions.length).toBeGreaterThanOrEqual(5);

	// The buttons step too.
	await ui.button("Previous sentence").click();
	await expect.poll(firstSentence).toBe("s3");
	await ui.button("Next sentence").click();
	await expect.poll(firstSentence).toBe("s4");
});

test("marks never move the text and never cover the player", async ({
	page,
}) => {
	const ui = await open(page, [FIVE_SENTENCE_REPLY]);
	const word = () =>
		page.evaluate(() => {
			const text = document.querySelector(".message-body .markdown-container p")
				?.firstChild as Text;
			const range = document.createRange();
			range.setStart(text, 4);
			range.setEnd(text, 10);
			const box = range.getBoundingClientRect();
			return { x: box.x, y: box.y, width: box.width, height: box.height };
		});

	// Before the reading: marking itself must not reflow the line. Its x, width and
	// height stay; its y may move, as the thread makes room for the player.
	const before = await word();
	await ui.speaker().click();
	await expect(ui.player).toBeVisible();
	await expect(ui.tint.first()).toBeVisible();
	// The player makes room for itself (the thread follows it down), and then it
	// is settled: from here on only the marks change.
	await waitForMotionToSettle(page);
	const first = await word();
	expect(first.x).toBeCloseTo(before.x, 1);
	expect(first.width).toBeCloseTo(before.width, 1);
	expect(first.height).toBeCloseTo(before.height, 1);
	const place = await tintPlace(ui);
	await expect.poll(() => tintPlace(ui), { timeout: 15_000 }).not.toBe(place);
	const second = await word();
	expect(second.x).toBeCloseTo(first.x, 1);
	expect(second.y).toBeCloseTo(first.y, 1);
	expect(second.width).toBeCloseTo(first.width, 1);
	expect(second.height).toBeCloseTo(first.height, 1);
	await expectTopmost(ui.player, {
		message: "the marks must never paint over the player",
		probe: "center",
	});
});

test("the speaker shows its label as a tooltip on hover, as its neighbours do", async ({
	page,
}) => {
	const ui = await open(page, [TWO_SENTENCE_REPLY]);
	const tooltip = page.locator(".read-aloud-speaker-tooltip").first();
	await expect(tooltip).toHaveCSS("opacity", "0");
	await ui.speaker().hover();
	await expect(tooltip).toHaveCSS("opacity", "1");
	await expect(tooltip).toHaveText("Read aloud");
	// Whole, as Copy's is: not inside the button, whose hover fades it to 0.78.
	await waitForMotionToSettle(page);
	expect(
		await tooltip.evaluate((node) => {
			let opacity = 1;
			for (let at: Element | null = node; at; at = at.parentElement)
				opacity *= Number(getComputedStyle(at).opacity);
			return opacity;
		}),
	).toBeCloseTo(1, 2);
});

test("a German reply's speaker is dimmed with a note", async ({ page }) => {
	const ui = await open(page, [GERMAN_REPLY]);
	const speaker = ui.speaker();
	await expect(speaker).toHaveAttribute("aria-disabled", "true", {
		timeout: 15_000,
	});
	await speaker.hover();
	await expect(ui.note).toContainText(
		"Read aloud isn't available in German yet.",
	);
	// Dimmed, it takes no hover fill: the row's hover rule must not win.
	await expect(speaker).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
	// The note sits on the raised surface of the row's tooltips, not the page's.
	const surface = await page.evaluate(() => {
		const tip = document.querySelector(".action-tooltip .tooltip-content");
		return tip ? getComputedStyle(tip).backgroundColor : null;
	});
	expect(surface).not.toBeNull();
	await expect(ui.note).toHaveCSS("background-color", surface ?? "");
	// Pressing it starts nothing (it is dimmed, not disabled, so a tap shows its note).
	await speaker.click({ force: true });
	expect(fake.sessions).toHaveLength(0);
	await expect(ui.player).toBeHidden();
});

test("Read from here starts at the selected sentence", async ({ page }) => {
	const ui = await open(page, [FIVE_SENTENCE_REPLY]);
	await expect(ui.speaker()).toHaveAttribute("aria-label", "Read aloud");
	// "A cat watches…" is the third sentence.
	await selectInReply(page, "cat watches", 11);
	await expect(ui.pill).toBeVisible();
	await ui.pill.click();

	await expect(ui.player).toBeVisible();
	await expect.poll(() => fake.sessions.length).toBe(1);
	expect(fake.sessions[0]?.body.sentences[0]?.id).toBe("s2");
	await expect(ui.pill).toBeHidden();
});

test("Read from here inside the long code block reads it", async ({ page }) => {
	const ui = await open(page, [SYNTAX_REPLY]);
	await expect(ui.speaker()).toHaveAttribute("aria-label", "Read aloud");
	await selectInReply(page, "secretCode", 10);
	await expect(ui.pill).toBeVisible();
	await ui.pill.click();

	await expect.poll(() => fake.sessions.length).toBe(1);
	expect(
		hasRun(spokenTokens(fake), ["secret", "Code", "equals", "forty-two"]),
	).toBe(true);
});

test("the phone layout: two rows, 44 px buttons and a 52 px play", async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const ui = await open(page, [FIVE_SENTENCE_REPLY]);
	await ui.speaker().click();
	await expect(ui.player).toBeVisible();
	await waitForMotionToSettle(page);

	const next = await ui.button("Next sentence").boundingBox();
	const play = await ui.button("Pause").boundingBox();
	const line = await ui.slider.boundingBox();
	expect(next?.width).toBeCloseTo(44, 0);
	expect(next?.height).toBeCloseTo(44, 0);
	expect(play?.width).toBeCloseTo(52, 0);
	expect(play?.height).toBeCloseTo(52, 0);
	// The scrubber's row is above the buttons' row.
	expect((line?.y ?? 0) + (line?.height ?? 0)).toBeLessThanOrEqual(
		(play?.y ?? 0) + 1,
	);
	// The player stays inside the phone's width.
	const pill = await ui.player.boundingBox();
	expect(pill?.x ?? -1).toBeGreaterThanOrEqual(0);
	expect((pill?.x ?? 0) + (pill?.width ?? 999)).toBeLessThanOrEqual(390);
	// About 108 px tall, with a 20 px play icon (spec §4.3, the prototype).
	expect(pill?.height).toBeCloseTo(108, 0);
	const icon = await ui.button("Pause").locator("svg").boundingBox();
	expect(icon?.width).toBeCloseTo(20, 0);
});

test("the speed chip keeps its width at every speed, so the notches never move", async ({
	page,
}) => {
	const ui = await open(page, [FIVE_SENTENCE_REPLY]);
	await ui.speaker().click();
	await expect(ui.player).toBeVisible();
	await ui.button("Pause").click();
	await waitForMotionToSettle(page);
	const line = await ui.slider.boundingBox();
	const widths = new Set<number>();
	for (const speed of ["0.75×", "1.25×", "1.5×", "1.75×", "2×", "1×"]) {
		await ui.speed.click();
		const item = ui.player.getByRole("menuitemradio", { name: speed });
		// The menu's hover eases in, as the app's other menus do.
		expect(
			await item.evaluate((node) => getComputedStyle(node).transitionDuration),
		).toContain("0.15s");
		await item.click();
		await expect(ui.speed).toHaveAccessibleName(`Speed: ${speed}`);
		const chip = await ui.speed.boundingBox();
		widths.add(Math.round((chip?.width ?? 0) * 10) / 10);
		const now = await ui.slider.boundingBox();
		expect(now?.x).toBeCloseTo(line?.x ?? 0, 1);
		expect(now?.width).toBeCloseTo(line?.width ?? 0, 1);
	}
	expect([...widths]).toHaveLength(1);
});

test("on a 375, 360 or 320 px phone the player fits its column, and no two of its buttons overlap", async ({
	page,
}) => {
	await page.setViewportSize({ width: 375, height: 812 });
	const ui = await open(page, [FIVE_SENTENCE_REPLY]);
	await ui.speaker().click();
	await expect(ui.player).toBeVisible();
	// Paused, so the player stays while it is measured at both widths.
	await ui.button("Pause").click();
	for (const width of [375, 360, 320]) {
		await page.setViewportSize({ width, height: 812 });
		await waitForMotionToSettle(page);
		// Inside the composer's column, as the composer is.
		const column = await page.getByTestId("composer-box").boundingBox();
		const player = await ui.player.boundingBox();
		if (!column || !player) throw new Error("no column or player box");
		expect(player.x, `${width} px: the player's left`).toBeGreaterThanOrEqual(
			column.x - 0.5,
		);
		expect(
			player.x + player.width,
			`${width} px: the player's right`,
		).toBeLessThanOrEqual(column.x + column.width + 0.5);
		// The bottom row, left to right: the speed chip, ⏮ ▶ ⏭, then ⌖ ✕.
		const row = [
			ui.speed,
			ui.button("Previous sentence"),
			ui.button("Play"),
			ui.button("Next sentence"),
			ui.button("Go to where it's reading"),
			ui.button("Stop reading"),
		];
		const boxes = [];
		for (const control of row) boxes.push(await control.boundingBox());
		for (let i = 1; i < boxes.length; i++) {
			const left = boxes[i - 1];
			const right = boxes[i];
			if (!left || !right) throw new Error("a control has no box");
			expect(
				left.x + left.width,
				`${width} px: control ${i - 1} overlaps control ${i}`,
			).toBeLessThanOrEqual(right.x + 0.5);
		}
		const pill = await ui.player.boundingBox();
		const last = boxes.at(-1);
		expect((last?.x ?? 0) + (last?.width ?? 0)).toBeLessThanOrEqual(
			(pill?.x ?? 0) + (pill?.width ?? 0),
		);
	}
});

test("the total dropping its ≈ moves nothing: the scrubber keeps its width", async ({
	page,
}) => {
	const ui = await open(page, [FIVE_SENTENCE_REPLY]);
	await ui.speaker().click();
	await expect(ui.player).toBeVisible();
	await waitForMotionToSettle(page);
	const total = ui.player.locator(".read-aloud-time").last();
	await expect(total).toHaveText(/^≈/);
	const before = await ui.slider.boundingBox();
	// The total is corrected as the sentences are made, and loses its ≈.
	await expect
		.poll(() => total.evaluate((node) => (node as HTMLElement).innerText), {
			timeout: 15_000,
		})
		.toMatch(/^\d/);
	const after = await ui.slider.boundingBox();
	expect(after?.width).toBeCloseTo(before?.width ?? 0, 1);
	expect(after?.x).toBeCloseTo(before?.x ?? 0, 1);
});

test("a drag to either end on a phone keeps the bubble inside the player, and the page goes on working", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.setViewportSize({ width: 375, height: 812 });
	const ui = await open(page, [FIVE_SENTENCE_REPLY]);
	await ui.speaker().click();
	await expect(ui.player).toBeVisible();
	await waitForMotionToSettle(page);
	const line = await ui.slider.boundingBox();
	const pill = await ui.player.boundingBox();
	if (!line || !pill) throw new Error("the player has no box");
	const y = line.y + line.height / 2;
	const bubble = page.locator(".read-aloud-bubble");
	/** How far the bubble's edges are inside the player's, at least (negative: outside). */
	const room = async () => {
		const box = await bubble.boundingBox();
		if (!box) return -1;
		return Math.round(
			Math.min(box.x - pill.x, pill.x + pill.width - (box.x + box.width)),
		);
	};

	// A touch at the very start, held: the bubble moves right to stay inside.
	await page.mouse.move(line.x + 1, y);
	await page.mouse.down();
	await expect(bubble).toHaveCSS("opacity", "1");
	await expect.poll(room).toBeGreaterThanOrEqual(5);
	// Dragged to the very end and held: it moves left to stay inside.
	await page.mouse.move(line.x + line.width - 1, y, { steps: 8 });
	await expect.poll(room).toBeGreaterThanOrEqual(5);
	await page.mouse.up();

	// The page goes on working: the drag lands on the last sentence, and ✕ ends it.
	await expect(ui.slider).toHaveAttribute("aria-valuetext", "Sentence 5 of 5");
	await ui.button("Stop reading").click();
	await expect(ui.player).toBeHidden();
	expect(errors).toEqual([]);
});

test("reduced motion: the player appears without moving", async ({ page }) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	const ui = await open(page, [FIVE_SENTENCE_REPLY]);
	await ui.speaker().click();
	await expect(ui.player).toBeVisible();
	const longest = await ui.player.evaluate((node) => {
		const toMs = (value: string) =>
			value.endsWith("ms")
				? Number.parseFloat(value)
				: Number.parseFloat(value) * 1000;
		return Math.max(
			...getComputedStyle(node)
				.transitionDuration.split(",")
				.map((value) => toMs(value.trim())),
		);
	});
	expect(longest).toBeLessThanOrEqual(0.01);
});
