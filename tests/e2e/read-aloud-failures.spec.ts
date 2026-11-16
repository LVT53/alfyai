// Every failure of read aloud's spec §4.8, end to end, against the fake speech
// service (Plan 2, Task 16): each one amber, explained and recoverable, and none
// of them touching the chat itself.
import { expect, test } from "@playwright/test";
import { login, setDraining } from "./helpers";
import {
	clearAdminConfigForReadAloud,
	deleteReadAloudChat,
	type FakeSpeechService,
	FIVE_SENTENCE_REPLY,
	openReadAloudChat,
	readAloudUi,
	startFakeSpeechForSpec,
	stopFakeSpeechForSpec,
} from "./read-aloud-helpers";

let fake: FakeSpeechService | null = null;
let chatId: string | null = null;

test.beforeEach(async ({ page }) => {
	await login(page);
});

test.afterEach(async ({ page, context }) => {
	// A drain, an offline browser and a fake that is still up are put back, so
	// the next spec on this worker meets a server as it was.
	await context.setOffline(false);
	await setDraining(page, false);
	try {
		if (chatId) await deleteReadAloudChat(page, chatId);
	} finally {
		chatId = null;
		if (fake) await stopFakeSpeechForSpec(page, fake);
		else await clearAdminConfigForReadAloud(page);
		fake = null;
	}
});

async function start(
	page: import("@playwright/test").Page,
	options: Parameters<typeof startFakeSpeechForSpec>[1],
) {
	fake = await startFakeSpeechForSpec(page, options);
	const opened = await openReadAloudChat(page, [FIVE_SENTENCE_REPLY]);
	chatId = opened.chatId;
	return readAloudUi(page);
}

test("the voice is busy: the note shows after 2.5 s", async ({ page }) => {
	const ui = await start(page, {
		secondsPerChar: 0.02,
		firstAudioDelayMs: 4000,
	});
	await ui.speaker().click();
	// The spinner runs, and not at once: the note shows only after a while.
	await expect(ui.note).toHaveCount(0);
	await expect(ui.note).toContainText(
		"The voice is busy with another reading. Yours starts in a moment.",
		{ timeout: 6000 },
	);
	// It goes away when reading starts.
	await expect(ui.player).toBeVisible({ timeout: 10_000 });
	await expect(ui.note).toHaveCount(0);
});

test("it can't start: the crossed speaker and Try again", async ({ page }) => {
	const ui = await start(page, { refuseSessions: true });
	await ui.speaker().click();
	await expect(ui.note).toContainText(
		"Couldn't start reading. The voice isn't answering right now.",
	);
	await expect(ui.player).toBeHidden();

	// The voice comes back: Try again reads.
	fake?.setOptions({});
	await ui.note.getByRole("button", { name: "Try again" }).click();
	await expect(ui.player).toBeVisible();
	await expect(ui.note).toHaveCount(0);
	expect(fake?.sessions.length).toBe(1);
});

test("a failed start settles by itself: the speaker returns and the note closes", async ({
	page,
}) => {
	const ui = await start(page, { refuseSessions: true });
	await ui.speaker().click();
	await expect(ui.note).toBeVisible();
	// The speaker returns to normal after 3 s, the note after at most 8 s.
	await expect(ui.speaker()).toHaveAttribute("aria-label", "Read aloud", {
		timeout: 6000,
	});
	await expect(ui.note).toHaveCount(0, { timeout: 10_000 });
	// Dismissing closes it at once.
	await ui.speaker().click();
	await expect(ui.note).toBeVisible();
	await ui.note.getByRole("button", { name: "Dismiss" }).click();
	await expect(ui.note).toHaveCount(0);
});

test("it stops while reading: an amber player, and Try again resumes", async ({
	page,
}) => {
	// A first sentence of about 3 s: the browser needs that much audio before
	// it starts playing a stream with no length.
	const ui = await start(page, {
		secondsPerChar: 0.1,
		failAtSentence: 1,
		errorDelayMs: 1500,
	});
	await ui.speaker().click();
	await expect(ui.player).toBeVisible();
	await expect(ui.note).toContainText(
		"Reading stopped. The voice stopped answering.",
		{
			timeout: 15_000,
		},
	);
	// The player stays, and play has become Try again; the sentence stays tinted.
	await expect(ui.player).toBeVisible();
	await expect(ui.tint.first()).toBeVisible();

	fake?.setOptions({ secondsPerChar: 0.02 });
	await ui.note.getByRole("button", { name: "Try again" }).click();
	await expect.poll(() => fake?.sessions.length).toBe(2);
	// The first sentence's audio played out, then the reading stopped at the
	// second, the one that was never made: Try again restarts there.
	expect(fake?.sessions[1]?.body.sentences[0]?.id).toBe("s1");
	await expect(ui.note).toHaveCount(0, { timeout: 10_000 });
	await expect(ui.speaker()).toHaveAttribute("aria-label", "Pause reading");
});

test("the connection drops: the offline note, then the resume", async ({
	page,
	context,
}) => {
	const ui = await start(page, { secondsPerChar: 0.02 });
	await ui.speaker().click();
	await expect(ui.player).toBeVisible();
	await expect(ui.tint.first()).toBeVisible();

	await context.setOffline(true);
	await expect(ui.note).toContainText(
		"You're offline. Reading continues when you're back.",
		{
			timeout: 15_000,
		},
	);
	// A calm note, without Try again.
	await expect(ui.note.getByRole("button", { name: "Try again" })).toHaveCount(
		0,
	);

	const sessions = fake?.sessions.length ?? 0;
	await context.setOffline(false);
	// Reading resumes by itself, in a new session.
	await expect
		.poll(() => fake?.sessions.length, { timeout: 15_000 })
		.toBeGreaterThan(sessions);
	await expect(ui.note).toHaveCount(0, { timeout: 15_000 });
	await expect(ui.speaker()).toHaveAttribute("aria-label", "Pause reading");
});

test("AlfyAI updates: the note, then the resume", async ({ page }) => {
	const ui = await start(page, {
		secondsPerChar: 0.1,
		cutAtSentence: 1,
		errorDelayMs: 2500,
	});
	await ui.speaker().click();
	await expect(ui.player).toBeVisible();
	// The deploy drains the server while the voice is being read; the stream
	// breaks (the fake cuts it at the second sentence).
	await setDraining(page, true);
	await expect(ui.note).toContainText(
		"AlfyAI is updating. Reading continues when it is back.",
		{ timeout: 20_000 },
	);
	await expect(ui.note.getByRole("button", { name: "Try again" })).toHaveCount(
		0,
	);

	const sessions = fake?.sessions.length ?? 0;
	// The update ends: the server is back, and the voice is as it was.
	fake?.setOptions({ secondsPerChar: 0.02 });
	await setDraining(page, false);
	// The watch asks the server every 3 s.
	await expect
		.poll(() => fake?.sessions.length, { timeout: 20_000 })
		.toBeGreaterThan(sessions);
	await expect(ui.note).toHaveCount(0, { timeout: 15_000 });
});

test("word timing fails: the tint without the word marker", async ({
	page,
}) => {
	const ui = await start(page, { secondsPerChar: 0.02, wordTimes: "null" });
	await ui.speaker().click();
	await expect(ui.player).toBeVisible();
	await expect(ui.tint.first()).toBeVisible();
	// Nothing is said about it, and the word marker never shows.
	await expect(ui.note).toHaveCount(0);
	await expect(ui.word).toHaveCount(0);
	await expect(ui.speaker()).toHaveAttribute("aria-label", "Pause reading");
});

test("switched off: no speaker anywhere", async ({ page }) => {
	// Read aloud is on for this spec's server first, then switched off.
	fake = await startFakeSpeechForSpec(page);
	const opened = await openReadAloudChat(page, [FIVE_SENTENCE_REPLY]);
	chatId = opened.chatId;
	const ui = readAloudUi(page);
	await expect(ui.speaker()).toBeVisible();

	await clearAdminConfigForReadAloud(page);
	await page.reload({ waitUntil: "domcontentloaded" });
	await expect(page.getByTestId("message-input")).toBeVisible();
	await expect(page.locator(".message-actions").first()).toBeAttached();
	await expect(ui.speaker()).toHaveCount(0);
	// Nor does a selection in a reply bring a pill.
	await expect(ui.pill).toHaveCount(0);
});
