// Read aloud, end to end, against the fake speech service (Plan 2, Task 16).
//
// The fake follows the service's README (one reader of each stream, sentences
// made only while `i <= position + 2`, times on the stream's clock), so what
// these specs prove is the app's side of it: the speaker, the session routes,
// the replay, the player, the marks and Read from here, in the real browser on
// the production build. The failures of spec §4.8 are in
// `read-aloud-failures.spec.ts`.
import { expect, test } from "@playwright/test";
import { expectTopmost, login, waitForMotionToSettle } from "./helpers";
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

test("a code name is marked while it is read, above the code's own background", async ({
	page,
}) => {
	const ui = await open(page, [SYNTAX_REPLY]);
	await ui.speaker().click();
	await expect(ui.player).toBeVisible();
	// The inline code's sentence is the second: its code is drawn by a highlight, which
	// paints above the code's background (the overlay behind the prose cannot).
	await expect
		.poll(
			() =>
				page.evaluate(() =>
					[
						...((
							CSS as unknown as { highlights?: Map<string, Iterable<Range>> }
						).highlights?.get("read-aloud-code-sentence") ?? []),
					].map((range) => range.toString()),
				),
			{ timeout: 15_000 },
		)
		.toContain("getUserName()");
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
	const frames = await recordPlayer(page);
	await ui.speaker().click();
	await expect(ui.player).toHaveAttribute("data-finished", "", {
		timeout: 30_000,
	});
	await expect(ui.player).toBeHidden();
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
