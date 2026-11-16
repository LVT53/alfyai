import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { expectTopmost, login, waitForStableBoundingBox } from "./helpers";
import {
	type FakeSpeechService,
	FIVE_SENTENCE_REPLY,
	GERMAN_REPLY,
	SYNTAX_REPLY,
	seedReadAloudChat,
	startFakeSpeechForSpec,
	stopFakeSpeechForSpec,
	TWO_SENTENCE_REPLY,
} from "./read-aloud-helpers";

// Read aloud end to end, against a fake of the speech service in this process
// (docs/superpowers/plans/2026-11-16-read-aloud-2-reading-in-chat.md, Task 16):
// the speaker, the speech script built from the rendered reply, the session
// routes and their containment check, the registry's replay, the browser's
// audio and timeline, the marks and the player. Every wait is on a state.

let fake: FakeSpeechService;

test.beforeEach(async ({ page }) => {
	await login(page);
	fake = await startFakeSpeechForSpec(page, { secondsPerChar: 0.02 });
});

test.afterEach(async ({ page }) => {
	await stopFakeSpeechForSpec(page, fake);
});

async function openChat(page: Page, replies: string[]): Promise<string[]> {
	const id = `read-aloud-${randomUUID()}`;
	const ids = await seedReadAloudChat(id, replies);
	await page.goto(`/chat/${id}`, { waitUntil: "domcontentloaded" });
	await expect(speaker(page, ids[ids.length - 1] as string)).toBeAttached({
		timeout: 15_000,
	});
	return ids;
}

/** A reply's speaker: in its action row, beside (not inside) the message body. */
const speaker = (page: Page, messageId: string) =>
	page
		.locator(`div.group:has(> [data-message-id="${messageId}"])`)
		.getByTestId("read-aloud-speaker");
const slot = (page: Page) => page.locator(".read-aloud-slot");
const player = (page: Page) =>
	page.getByRole("group", { name: "Read aloud player" });
const scrubber = (page: Page) => page.getByRole("slider", { name: "Sentence" });
const tokensOf = (session: FakeSpeechService["sessions"][number]) =>
	session.body.sentences.flatMap((s) => s.tokens);

async function startReading(page: Page, messageId: string): Promise<void> {
	await speaker(page, messageId).click();
	await expect(slot(page)).toHaveAttribute("data-open", "", {
		timeout: 15_000,
	});
}

/** Selects `length` characters of `text` in the reply, from where `text` starts. */
async function selectText(
	root: Locator,
	text: string,
	length: number,
): Promise<void> {
	await root.evaluate(
		(element, { text: needle, length: count }) => {
			const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
			for (let node = walker.nextNode(); node; node = walker.nextNode()) {
				const index = (node as Text).data.indexOf(needle);
				if (index < 0) continue;
				const range = document.createRange();
				range.setStart(node, index);
				range.setEnd(node, index + count);
				const selection = document.getSelection() as Selection;
				selection.removeAllRanges();
				selection.addRange(range);
				return;
			}
			throw new Error(`no text node holds ${needle}`);
		},
		{ text, length },
	);
}

test("@smoke the speaker reads a reply: the player rises and the tint moves", async ({
	page,
}) => {
	const [reply] = await openChat(page, [FIVE_SENTENCE_REPLY]);
	await startReading(page, reply as string);
	await expect(player(page)).toBeVisible();
	await expect(speaker(page, reply as string)).toHaveAttribute(
		"aria-label",
		"Pause reading",
	);
	// The second sentence is read: the scrubber says so, and the reply is tinted.
	await expect(scrubber(page)).toHaveAttribute("aria-valuenow", "2", {
		timeout: 15_000,
	});
	await expect(
		page
			.locator(
				`[data-message-id="${reply}"] .read-aloud-sentence .read-aloud-box`,
			)
			.first(),
	).toBeVisible();
	expect(fake.sessions[0]?.body.sentences.map((s) => s.id)).toEqual([
		"s0",
		"s1",
		"s2",
		"s3",
		"s4",
	]);
});

test("no syntax reaches the voice, and code is read the way a teacher says it", async ({
	page,
}) => {
	const [reply] = await openChat(page, [SYNTAX_REPLY]);
	await startReading(page, reply as string);
	await expect.poll(() => fake.sessions.length).toBeGreaterThan(0);
	const tokens = tokensOf(
		fake.sessions[0] as FakeSpeechService["sessions"][number],
	);
	for (const token of tokens) {
		for (const mark of ["*", "`", "#", "|", "[", "]", "http", "www."])
			expect(token).not.toContain(mark);
		expect(["secret", "secretCode", "TABLECELL"]).not.toContain(token);
	}
	const spoken = tokens.join(" ");
	expect(spoken).toContain("get User Name");
	expect(spoken).toContain("total equals price star two");
	expect(spoken).toContain("One.");
	expect(spoken).toContain("example dot com");
	expect(spoken).toContain("link to the guide");
});

test("a code name is marked while it is read, above the code's own background", async ({
	page,
}) => {
	const [reply] = await openChat(page, [SYNTAX_REPLY]);
	await startReading(page, reply as string);
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
	const [five, again] = await openChat(page, [
		FIVE_SENTENCE_REPLY,
		FIVE_SENTENCE_REPLY,
	]);
	// Reading the five sentences to their end needs the position reports: the fake
	// makes sentence i only once i <= position + 2.
	await startReading(page, five as string);
	await expect(player(page)).toHaveAttribute("data-finished", "", {
		timeout: 30_000,
	});
	await expect(player(page).getByText("Finished")).toBeVisible();
	await expect(slot(page)).not.toHaveAttribute("data-open", "", {
		timeout: 5000,
	});
	expect(fake.sessions[0]?.positions).toEqual(
		expect.arrayContaining(["s1", "s2"]),
	);

	// ✕ while the service still has sentences to make: the session is cancelled.
	await startReading(page, again as string);
	await player(page).getByRole("button", { name: "Stop reading" }).click();
	await expect(slot(page)).not.toHaveAttribute("data-open", "", {
		timeout: 5000,
	});
	await expect.poll(() => fake.sessions.at(-1)?.deleted).toBe(true);
	await expect(speaker(page, again as string)).toHaveAttribute(
		"aria-label",
		"Read aloud",
	);
});

test("a slash command hushes the player, and reading goes on", async ({
	page,
}) => {
	const [reply] = await openChat(page, [FIVE_SENTENCE_REPLY]);
	await startReading(page, reply as string);
	const input = page.getByTestId("message-input");
	await input.fill("/");
	await expect(slot(page)).toHaveAttribute("data-hushed", "");
	await expect(scrubber(page)).toHaveAttribute("aria-valuenow", "2", {
		timeout: 15_000,
	});
	expect(fake.sessions[0]?.deleted).toBe(false);
	await input.fill("");
	await expect(slot(page)).not.toHaveAttribute("data-hushed", "");
	await expect(slot(page)).toHaveAttribute("data-open", "");
});

test("another reply's speaker switches without the player leaving", async ({
	page,
}) => {
	const [five, two] = await openChat(page, [
		FIVE_SENTENCE_REPLY,
		TWO_SENTENCE_REPLY,
	]);
	await startReading(page, five as string);
	// Watch the slot: it must never close during the switch.
	await page.evaluate(() => {
		const element = document.querySelector(".read-aloud-slot") as HTMLElement;
		(window as unknown as { slotClosed: boolean }).slotClosed = false;
		new MutationObserver(() => {
			if (!element.hasAttribute("data-open"))
				(window as unknown as { slotClosed: boolean }).slotClosed = true;
		}).observe(element, { attributes: true });
	});
	await speaker(page, two as string).click();
	await expect.poll(() => fake.sessions.length).toBe(2);
	await expect(speaker(page, two as string)).toHaveAttribute(
		"aria-label",
		"Pause reading",
		{ timeout: 15_000 },
	);
	expect(fake.sessions[1]?.body.sentences).toHaveLength(2);
	await expect.poll(() => fake.sessions[0]?.deleted).toBe(true);
	expect(
		await page.evaluate(
			() => (window as unknown as { slotClosed: boolean }).slotClosed,
		),
	).toBe(false);
});

test("the scrubber jumps to a sentence, and the arrows step", async ({
	page,
}) => {
	const [reply] = await openChat(page, [FIVE_SENTENCE_REPLY]);
	await startReading(page, reply as string);
	await scrubber(page).focus();
	await page.keyboard.press("End");
	await expect
		.poll(() => fake.sessions.at(-1)?.body.sentences[0]?.id)
		.toBe("s4");
	await expect(scrubber(page)).toHaveAttribute("aria-valuenow", "5");
	await page.keyboard.press("ArrowLeft");
	await expect
		.poll(() => fake.sessions.at(-1)?.body.sentences[0]?.id)
		.toBe("s3");
	await expect(scrubber(page)).toHaveAttribute(
		"aria-valuetext",
		"Sentence 4 of 5",
	);
});

test("marks never move the text and never cover the player", async ({
	page,
}) => {
	const [reply] = await openChat(page, [FIVE_SENTENCE_REPLY]);
	const firstWordBox = () =>
		page
			.locator(`[data-message-id="${reply}"] .markdown-container p`)
			.first()
			.evaluate((p) => {
				const range = document.createRange();
				const text = p.firstChild as Text;
				range.setStart(text, 0);
				range.setEnd(text, 3);
				const rect = range.getBoundingClientRect();
				return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
			});
	const before = await firstWordBox();
	await startReading(page, reply as string);
	await expect(
		page
			.locator(
				`[data-message-id="${reply}"] .read-aloud-sentence .read-aloud-box`,
			)
			.first(),
	).toBeVisible();
	await page.evaluate(() =>
		document.querySelector(".scroll-container")?.scrollTo({ top: 0 }),
	);
	const during = await firstWordBox();
	expect(during.width).toBeCloseTo(before.width, 1);
	expect(during.height).toBeCloseTo(before.height, 1);
	expect(during.x).toBeCloseTo(before.x, 1);
	await expectTopmost(player(page), {
		message: "the player is above the marks and the thread",
		probe: "center",
	});
});

test("a German reply's speaker is dimmed with a note", async ({ page }) => {
	const [reply] = await openChat(page, [GERMAN_REPLY]);
	const button = speaker(page, reply as string);
	await expect(button).toHaveAttribute("aria-disabled", "true", {
		timeout: 15_000,
	});
	await button.hover();
	await expect(
		page
			.getByRole("status")
			.filter({ hasText: "Read aloud isn't available in German yet." }),
	).toBeVisible();
	// A dimmed speaker is aria-disabled: a press reads nothing.
	await button.click({ force: true });
	expect(fake.sessions).toHaveLength(0);
});

test("Read from here starts at the selected sentence", async ({ page }) => {
	const [reply] = await openChat(page, [FIVE_SENTENCE_REPLY]);
	const prose = page.locator(
		`[data-message-id="${reply}"] .markdown-container`,
	);
	await expect(speaker(page, reply as string)).toBeAttached();
	await selectText(prose, "A cat watches", 5);
	const pill = page.getByRole("button", { name: "Read from here" });
	await expect(pill).toBeVisible({ timeout: 10_000 });
	await pill.click();
	await expect
		.poll(() => fake.sessions.at(-1)?.body.sentences[0]?.id)
		.toBe("s2");
	await expect(slot(page)).toHaveAttribute("data-open", "", {
		timeout: 15_000,
	});
});

test("Read from here inside the long code block reads it", async ({ page }) => {
	const [reply] = await openChat(page, [SYNTAX_REPLY]);
	const code = page
		.locator(`[data-message-id="${reply}"] .code-block`)
		.filter({ hasText: "secretCode" });
	await expect(code).toBeVisible({ timeout: 15_000 });
	await selectText(code, "secretCode", 6);
	const pill = page.getByRole("button", { name: "Read from here" });
	await expect(pill).toBeVisible({ timeout: 10_000 });
	await pill.click();
	await expect.poll(() => fake.sessions.length).toBeGreaterThan(0);
	expect(
		tokensOf(
			fake.sessions.at(-1) as FakeSpeechService["sessions"][number],
		).join(" "),
	).toContain("secret Code equals forty-two");
});

test("the phone layout", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const [reply] = await openChat(page, [FIVE_SENTENCE_REPLY]);
	await startReading(page, reply as string);
	const pill = player(page);
	await expect(pill).toBeVisible();
	// Measured once the pill has risen into place.
	await waitForStableBoundingBox(pill);
	const scrubberBox = await scrubber(page).boundingBox();
	const play = pill.getByRole("button", { name: "Pause" });
	const playBox = await play.boundingBox();
	const nextBox = await pill
		.getByRole("button", { name: "Next sentence" })
		.boundingBox();
	const stopBox = await pill
		.getByRole("button", { name: "Stop reading" })
		.boundingBox();
	expect(scrubberBox && playBox && nextBox && stopBox).toBeTruthy();
	// Two rows: the scrubber above, the buttons below.
	expect(
		(playBox?.y ?? 0) >= (scrubberBox?.y ?? 0) + (scrubberBox?.height ?? 0) - 1,
	).toBe(true);
	expect(nextBox?.width).toBe(44);
	expect(stopBox?.width).toBe(44);
	expect(playBox?.width).toBe(52);
	expect(playBox?.height).toBe(52);
});

test("reduced motion: the player appears without moving", async ({ page }) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	const [reply] = await openChat(page, [FIVE_SENTENCE_REPLY]);
	await startReading(page, reply as string);
	const durations = await player(page).evaluate((element) =>
		getComputedStyle(element)
			.transitionDuration.split(",")
			.map(
				(value) =>
					Number.parseFloat(value) * (value.trim().endsWith("ms") ? 1 : 1000),
			),
	);
	for (const ms of durations) expect(ms).toBeLessThanOrEqual(0.01);
	const slotDurations = await slot(page).evaluate((element) =>
		getComputedStyle(element)
			.transitionDuration.split(",")
			.map(
				(value) =>
					Number.parseFloat(value) * (value.trim().endsWith("ms") ? 1 : 1000),
			),
	);
	for (const ms of slotDurations) expect(ms).toBeLessThanOrEqual(0.01);
});
