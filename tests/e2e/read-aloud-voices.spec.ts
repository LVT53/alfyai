// Read aloud's voices, end to end (Plan 3, Task 13): the Read aloud card in
// Settings, the voice editor rendering through the fake speech service's
// preview, a personal voice reading the replies, and a personal voice staying
// its maker's. Made-up data only: the admin, a second person made here, and a
// voice called "Test Voice".
import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { login, waitForMotionToSettle } from "./helpers";
import {
	deleteReadAloudChat,
	type FakeSpeechService,
	FIVE_SENTENCE_REPLY,
	openReadAloudChat,
	openReadAloudSettings,
	readAloudUi,
	resetReadAloudVoices,
	startFakeSpeechForSpec,
	stopFakeSpeechForSpec,
} from "./read-aloud-helpers";

const RUPERT = "default_3765f0d1140c05c0";
const IMOGEN = "default_b78b28baf5c31a1d";
const SAVANNAH = "default_de4d191ca7574982";
/** The Bedtime style, as slider values and as the controls the owner approved on the box. */
const BEDTIME_KNOBS = {
	pace: -1,
	pitch: 0,
	depth: 1,
	energy: -2.5,
	projection: -0.6,
};
const BEDTIME_CONTROLS = {
	"delivery.tempo": -1,
	"texture.deep": 1,
	"mood.arousal": -2.5,
	"delivery.whisper": 0.6,
};

let fake: FakeSpeechService;
const chats: string[] = [];

test.beforeEach(async ({ page }) => {
	await login(page);
	fake = await startFakeSpeechForSpec(page, { secondsPerChar: 0.02 });
});

test.afterEach(async ({ page }) => {
	try {
		for (const chatId of chats.splice(0))
			await deleteReadAloudChat(page, chatId);
		await resetReadAloudVoices(page);
	} finally {
		await stopFakeSpeechForSpec(page, fake);
	}
});

const sameControls = (a: Record<string, number>, b: Record<string, number>) =>
	JSON.stringify(Object.entries(a).sort()) ===
	JSON.stringify(Object.entries(b).sort());

/** Reads a reply aloud and returns the session the fake was asked for. */
async function readReply(page: Page) {
	const opened = await openReadAloudChat(page, [FIVE_SENTENCE_REPLY]);
	chats.push(opened.chatId);
	const ui = readAloudUi(page);
	const before = fake.sessions.length;
	await ui.speaker().click();
	await expect
		.poll(() => fake.sessions.length, { timeout: 15_000 })
		.toBeGreaterThan(before);
	return { ui, session: fake.sessions.at(-1) };
}

async function choice(page: Page) {
	const response = await page.request.get("/api/read-aloud/voices");
	expect(response.ok()).toBe(true);
	return (await response.json()) as {
		choice: { en: string; hu: string };
		defaultSpeed: number;
		voices: Array<{ id: string; name: string; knobs: typeof BEDTIME_KNOBS }>;
	};
}

async function makeVoice(page: Page, base: string) {
	const made = await page.request.post("/api/read-aloud/voices", {
		data: { name: "Test Voice", base, knobs: BEDTIME_KNOBS },
	});
	expect(made.status(), "voice made").toBe(201);
	return ((await made.json()) as { voice: { id: string } }).voice;
}

/** Opens the editor for a new voice from the card. */
async function newVoice(page: Page) {
	const card = await openReadAloudSettings(page);
	await card.getByRole("button", { name: "New voice" }).click();
	const editor = page.getByRole("dialog", { name: "New voice" });
	await expect(editor).toBeVisible();
	// Taller than the window, it scrolls inside itself once its intro has ended
	// (a centred DialogShell lost its overflow to that intro until Plan 3).
	await waitForMotionToSettle(page);
	if (!(await editor.getAttribute("class"))?.includes("dialog-sheet"))
		expect(
			await editor.evaluate((element) => getComputedStyle(element).overflowY),
		).toBe("auto");
	return { card, editor };
}

test("Settings shows the Read aloud card, and a chosen voice reads the replies", async ({
	page,
}) => {
	const card = await openReadAloudSettings(page);
	await expect(card.getByRole("heading", { name: "Read aloud" })).toBeVisible();
	await card
		.getByRole("combobox", { name: "English voice" })
		.selectOption("rupert");
	await expect.poll(async () => (await choice(page)).choice.en).toBe("rupert");
	await page.reload();
	const again = await openReadAloudSettings(page);
	await expect(
		again.getByRole("combobox", { name: "English voice" }),
	).toHaveValue("rupert");
	const { session } = await readReply(page);
	expect(session?.body.sentences[0]?.voice.speaker_id).toBe(RUPERT);
});

test("the editor renders a style through the fake and saves the voice", async ({
	page,
}) => {
	const { card, editor } = await newVoice(page);
	await editor.getByRole("button", { name: /^Savannah/ }).click();
	await editor
		.getByRole("group", { name: "A style to start with" })
		.getByRole("button", { name: "Bedtime" })
		.click();
	await expect(editor.getByRole("slider", { name: "Pace" })).toHaveAttribute(
		"aria-valuetext",
		"Slower",
	);
	await expect(editor.getByRole("textbox", { name: "Name" })).toHaveValue(
		"Bedtime Savannah",
	);
	await expect
		.poll(
			() =>
				fake.previews.some(
					(preview) =>
						preview.voice.speaker_id === SAVANNAH &&
						sameControls(preview.voice.controls, BEDTIME_CONTROLS),
				),
			{ timeout: 15_000 },
		)
		.toBe(true);
	// The dialog's pill plays it.
	await expect(
		editor
			.getByRole("group", { name: "Read aloud player" })
			.getByRole("button", { name: "Pause" }),
	).toBeVisible({ timeout: 15_000 });
	await page.getByRole("button", { name: "Save voice" }).click();
	await expect(editor).toBeHidden();
	const list = card.getByRole("list");
	await expect(list.getByText("Bedtime Savannah")).toBeVisible();
	await expect(
		list.getByText(
			"from Savannah · slower, a little fuller, very calm, softer",
		),
	).toBeVisible();
});

test("Yours / Original plays the base voice", async ({ page }) => {
	const { editor } = await newVoice(page);
	await editor
		.getByRole("group", { name: "A style to start with" })
		.getByRole("button", { name: "Bedtime" })
		.click();
	await expect
		.poll(
			() =>
				fake.previews.some((preview) =>
					sameControls(preview.voice.controls, BEDTIME_CONTROLS),
				),
			{ timeout: 15_000 },
		)
		.toBe(true);
	const before = fake.previews.length;
	await editor
		.getByRole("group", { name: "Compare" })
		.getByRole("button", { name: "Original" })
		.click();
	await expect
		.poll(() => fake.previews.length, { timeout: 15_000 })
		.toBeGreaterThan(before);
	expect(fake.previews.at(-1)?.voice).toEqual({
		speaker_id: IMOGEN,
		controls: {},
	});
});

test("a personal voice reads the replies, and deleting it gives the reading back to its base", async ({
	page,
}) => {
	const voice = await makeVoice(page, "savannah");
	const card = await openReadAloudSettings(page);
	await card
		.getByRole("combobox", { name: "English voice" })
		.selectOption(voice.id);
	await expect.poll(async () => (await choice(page)).choice.en).toBe(voice.id);
	const first = await readReply(page);
	expect(first.session?.body.sentences[0]?.voice).toEqual({
		speaker_id: SAVANNAH,
		controls: BEDTIME_CONTROLS,
	});

	const settings = await openReadAloudSettings(page);
	await settings.getByRole("button", { name: "Edit Test Voice" }).click();
	const editor = page.getByRole("dialog", { name: "Edit voice" });
	await editor.getByRole("button", { name: "Delete" }).click();
	const confirm = page.getByRole("dialog", { name: "Delete this voice?" });
	await expect(confirm).toContainText(
		"Delete “Test Voice”? Readings that use it go back to Savannah.",
	);
	await confirm.getByRole("button", { name: "Delete" }).click();
	await expect(
		settings.getByRole("combobox", { name: "English voice" }),
	).toHaveValue("savannah");
	await expect(settings.getByRole("list")).toHaveCount(0);

	const second = await readReply(page);
	expect(second.session?.body.sentences[0]?.voice).toEqual({
		speaker_id: SAVANNAH,
		controls: {},
	});
});

test("a preview that fails says so, and Try again plays it", async ({
	page,
}) => {
	fake.setOptions({ secondsPerChar: 0.02, failPreview: "failed" });
	const { editor } = await newVoice(page);
	await editor
		.getByRole("group", { name: "A style to start with" })
		.getByRole("button", { name: "Brisk" })
		.click();
	const note = editor.locator(".read-aloud-note");
	await expect(note).toContainText("Couldn't play the sample.", {
		timeout: 15_000,
	});
	// It sits in the dialog's flow (jsdom cannot see this; Plan 3, Task 8).
	expect(
		await note.evaluate((element) => getComputedStyle(element).position),
	).not.toBe("absolute");
	fake.setOptions({ secondsPerChar: 0.02 });
	await note.getByRole("button", { name: "Try again" }).click();
	await expect(note).toHaveCount(0);
	await expect(
		editor
			.getByRole("group", { name: "Read aloud player" })
			.getByRole("button", { name: "Pause" }),
	).toBeVisible({ timeout: 15_000 });
});

test("a Default speed starts every reading at it", async ({ page }) => {
	const card = await openReadAloudSettings(page);
	await card
		.getByRole("combobox", { name: "Default speed" })
		.selectOption("1.5");
	await expect.poll(async () => (await choice(page)).defaultSpeed).toBe(1.5);
	const { ui } = await readReply(page);
	await expect(ui.player).toBeVisible({ timeout: 15_000 });
	await expect(ui.player.locator(".read-aloud-speed-chip")).toHaveText("1.5×");
});

test("on a phone the editor is a full sheet without Cancel", async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const { editor } = await newVoice(page);
	await expect(editor).toHaveClass(/dialog-sheet--full/);
	await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Save voice" })).toBeVisible();
	// Nothing in it runs off the side.
	expect(
		await editor.evaluate(
			(element) => element.scrollWidth <= element.clientWidth + 1,
		),
	).toBe(true);
});

test("under reduced motion a style moves the sliders at once", async ({
	page,
}) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	const { editor } = await newVoice(page);
	await editor
		.getByRole("group", { name: "A style to start with" })
		.getByRole("button", { name: "Bedtime" })
		.click();
	expect(await editor.getByRole("slider", { name: "Pace" }).inputValue()).toBe(
		"-1",
	);
	expect(
		await editor.getByRole("slider", { name: "Energy" }).inputValue(),
	).toBe("-2.5");
});

test("another person never sees or uses my voice", async ({
	page,
	browser,
	baseURL,
}) => {
	const voice = await makeVoice(page, "imogen");
	const email = `read-aloud-b-${randomUUID().slice(0, 8)}@local.test`;
	const password = `read-aloud-${randomUUID()}`;
	const created = await page.request.post("/api/admin/users", {
		data: { email, name: "Test User B", password, role: "user" },
	});
	expect(created.ok(), `user made -> ${created.status()}`).toBe(true);
	const context = await browser.newContext({ baseURL });
	try {
		const other = await context.newPage();
		await login(other, email, password);
		const listed = await other.request.get("/api/read-aloud/voices");
		expect(listed.ok()).toBe(true);
		const theirs = (await listed.json()) as { voices: Array<{ id: string }> };
		expect(theirs.voices.map((entry) => entry.id)).not.toContain(voice.id);
		const path = `/api/read-aloud/voices/${encodeURIComponent(voice.id)}`;
		expect(
			(await other.request.patch(path, { data: { name: "Taken" } })).status(),
		).toBe(404);
		expect((await other.request.delete(path)).status()).toBe(404);
		expect(
			(
				await other.request.put("/api/read-aloud/preferences", {
					data: { en: voice.id },
				})
			).status(),
		).toBe(400);
	} finally {
		await context.close();
		const users = (await (
			await page.request.get("/api/admin/users")
		).json()) as {
			users: Array<{ id: string; email: string }>;
		};
		const second = users.users.find((user) => user.email === email);
		if (second) await page.request.delete(`/api/admin/users/${second.id}`);
	}
	const mine = await choice(page);
	expect(mine.voices).toEqual([
		expect.objectContaining({
			id: voice.id,
			name: "Test Voice",
			knobs: BEDTIME_KNOBS,
		}),
	]);
});
