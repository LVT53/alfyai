import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { clearAdminConfig, login, setDraining } from "./helpers";
import {
	type FakeSpeechOptions,
	type FakeSpeechService,
	FIVE_SENTENCE_REPLY,
	READ_ALOUD_CONFIG_KEYS,
	seedReadAloudChat,
	startFakeSpeechForSpec,
	stopFakeSpeechForSpec,
} from "./read-aloud-helpers";

// Every failure of spec §4.8 that a reading can meet, end to end on the fake
// speech service: a busy voice, a start that fails, a voice that stops while
// reading, a dropped connection, an update of AlfyAI, word timing that fails,
// and the feature switched off. Each is amber or calm, explained, and
// recoverable; none touches the chat.

let fake: FakeSpeechService | null = null;
let drained = false;

test.beforeEach(async ({ page }) => {
	await login(page);
});

test.afterEach(async ({ page, context }) => {
	await context.setOffline(false);
	if (drained) {
		await setDraining(page, false);
		drained = false;
	}
	if (fake) await stopFakeSpeechForSpec(page, fake);
	fake = null;
});

async function startFake(
	page: Page,
	options: FakeSpeechOptions = {},
): Promise<FakeSpeechService> {
	fake = await startFakeSpeechForSpec(page, {
		secondsPerChar: 0.02,
		...options,
	});
	return fake;
}

async function openChat(
	page: Page,
	reply = FIVE_SENTENCE_REPLY,
): Promise<string> {
	const id = `read-aloud-failures-${randomUUID()}`;
	const [replyId] = await seedReadAloudChat(id, [reply]);
	await page.goto(`/chat/${id}`, { waitUntil: "domcontentloaded" });
	await expect(
		page.locator(`[data-message-id="${replyId}"] .markdown-container`),
	).toContainText(reply.slice(0, 20), { timeout: 15_000 });
	return replyId as string;
}

const speaker = (page: Page, messageId: string) =>
	page
		.locator(`div.group:has(> [data-message-id="${messageId}"])`)
		.getByTestId("read-aloud-speaker");
const slot = (page: Page) => page.locator(".read-aloud-slot");
const player = (page: Page) =>
	page.getByRole("group", { name: "Read aloud player" });
const note = (page: Page, text: string) =>
	page.getByRole("status").filter({ hasText: text });

test("the voice is busy: the note shows after 2.5 s", async ({ page }) => {
	await startFake(page, { firstAudioDelayMs: 4000 });
	const reply = await openChat(page);
	await speaker(page, reply).click();
	const busy = note(
		page,
		"The voice is busy with another reading. Yours starts in a moment.",
	);
	await expect(busy).toBeVisible({ timeout: 4000 });
	await expect(slot(page)).toHaveAttribute("data-open", "", {
		timeout: 15_000,
	});
	await expect(busy).toHaveCount(0);
});

test("it can't start: the crossed speaker and Try again", async ({ page }) => {
	await startFake(page, { refuseSessions: true });
	const reply = await openChat(page);
	await speaker(page, reply).click();
	const failed = note(
		page,
		"Couldn't start reading. The voice isn't answering right now.",
	);
	await expect(failed).toBeVisible({ timeout: 15_000 });
	await expect(speaker(page, reply).locator(".lucide-volume-x")).toBeVisible();
	await expect(failed.getByRole("button", { name: "Try again" })).toBeVisible();
	await expect(slot(page)).not.toHaveAttribute("data-open", "");
	// The speaker settles after 3 s; the note can be dismissed.
	await expect(speaker(page, reply).locator(".lucide-volume-2")).toBeVisible({
		timeout: 6000,
	});
	await failed.getByRole("button", { name: "Dismiss" }).click();
	await expect(failed).toHaveCount(0);
});

test("on a phone the can't-start note stays on the screen", async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await startFake(page, { refuseSessions: true });
	const reply = await openChat(page);
	await speaker(page, reply).click();
	const failed = note(
		page,
		"Couldn't start reading. The voice isn't answering right now.",
	);
	await expect(failed).toBeVisible({ timeout: 15_000 });
	for (const part of [
		failed,
		failed.getByRole("button", { name: "Try again" }),
		failed.getByRole("button", { name: "Dismiss" }),
	]) {
		const box = await part.boundingBox();
		expect(box, "the note and its buttons are laid out").toBeTruthy();
		expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
		expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
	}
});

test("it stops while reading: an amber player, and Try again resumes", async ({
	page,
}) => {
	// The real voice takes about a second for a first sentence, so the app's readers are
	// attached when it fails; the fake would fail before that and drop the audio.
	const voice = await startFake(page, {
		failAtSentence: 1,
		firstAudioDelayMs: 300,
	});
	const reply = await openChat(page);
	await speaker(page, reply).click();
	await expect(player(page)).toHaveAttribute("data-failed", "", {
		timeout: 15_000,
	});
	const stopped = note(page, "Reading stopped. The voice stopped answering.");
	await expect(stopped).toBeVisible();
	await expect(
		player(page).getByRole("button", { name: "Try again" }),
	).toBeVisible();
	// The sentence stays tinted.
	await expect(
		page
			.locator(
				`[data-message-id="${reply}"] .read-aloud-sentence .read-aloud-box`,
			)
			.first(),
	).toBeVisible();
	voice.setOptions({ secondsPerChar: 0.02 });
	await stopped.getByRole("button", { name: "Try again" }).click();
	await expect(player(page)).not.toHaveAttribute("data-failed", "");
	await expect(speaker(page, reply)).toHaveAttribute(
		"aria-label",
		"Pause reading",
		{ timeout: 15_000 },
	);
	expect(voice.sessions.at(-1)?.body.sentences[0]?.id).toBe("s1");
});

test("the connection drops: the offline note, then the resume", async ({
	page,
	context,
}) => {
	const voice = await startFake(page);
	const reply = await openChat(page);
	await speaker(page, reply).click();
	await expect(speaker(page, reply)).toHaveAttribute(
		"aria-label",
		"Pause reading",
		{ timeout: 15_000 },
	);
	await context.setOffline(true);
	const offline = note(
		page,
		"You're offline. Reading continues when you're back.",
	);
	await expect(offline).toBeVisible({ timeout: 10_000 });
	await expect(offline.getByRole("button")).toHaveCount(0);
	await expect(
		player(page).getByRole("button", { name: "Waiting to continue" }),
	).toBeVisible();
	const sessions = voice.sessions.length;
	await context.setOffline(false);
	await expect(offline).toHaveCount(0, { timeout: 15_000 });
	await expect(speaker(page, reply)).toHaveAttribute(
		"aria-label",
		"Pause reading",
		{ timeout: 15_000 },
	);
	expect(voice.sessions.length).toBe(sessions + 1);
});

test("AlfyAI updates: the note, then the resume", async ({ page }) => {
	// The fake makes sentence 3 only once the browser says sentence 1 is playing
	// (i <= position + 2), so the connections are cut while the reading plays.
	const voice = await startFake(page, { cutAtSentence: 3 });
	const reply = await openChat(page);
	await setDraining(page, true);
	drained = true;
	await speaker(page, reply).click();
	const updating = note(
		page,
		"AlfyAI is updating. Reading continues when it is back.",
	);
	await expect(updating).toBeVisible({ timeout: 20_000 });
	await expect(updating.getByRole("button")).toHaveCount(0);
	const stoppedAt =
		Number(
			await page
				.getByRole("slider", { name: "Sentence" })
				.getAttribute("aria-valuenow"),
		) - 1;
	expect(stoppedAt).toBeGreaterThan(0);
	voice.setOptions({ secondsPerChar: 0.02 });
	await setDraining(page, false);
	drained = false;
	await expect(updating).toHaveCount(0, { timeout: 15_000 });
	await expect(speaker(page, reply)).toHaveAttribute(
		"aria-label",
		"Pause reading",
		{ timeout: 15_000 },
	);
	// It goes on from the sentence it stopped at.
	expect(voice.sessions.at(-1)?.body.sentences[0]?.id).toBe(`s${stoppedAt}`);
});

test("word timing fails: the tint without the word marker", async ({
	page,
}) => {
	await startFake(page, { wordTimes: "null" });
	const reply = await openChat(page);
	await speaker(page, reply).click();
	await expect(page.getByRole("slider", { name: "Sentence" })).toHaveAttribute(
		"aria-valuenow",
		"2",
		{
			timeout: 15_000,
		},
	);
	await expect(
		page
			.locator(
				`[data-message-id="${reply}"] .read-aloud-sentence .read-aloud-box`,
			)
			.first(),
	).toBeVisible();
	await expect(page.locator(".read-aloud-word")).toHaveCount(0);
	// Nothing is said about it: no read-aloud note.
	await expect(page.locator(".read-aloud-note")).toHaveCount(0);
});

test("switched off: no speaker anywhere", async ({ page }) => {
	await clearAdminConfig(page, [...READ_ALOUD_CONFIG_KEYS]);
	const reply = await openChat(page);
	await expect(
		page.locator(
			`div.group:has(> [data-message-id="${reply}"]) .message-actions`,
		),
	).toBeAttached();
	await expect(page.getByTestId("read-aloud-speaker")).toHaveCount(0);
	await expect(page.locator(".read-aloud-slot")).toHaveCount(0);
});
