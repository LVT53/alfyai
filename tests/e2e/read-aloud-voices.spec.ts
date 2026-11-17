// Read aloud's voices, end to end (Plan 3, Task 13): the Read aloud card in
// Settings, the voice editor rendering through the fake speech service's
// preview, a personal voice reading the replies, and a personal voice staying
// its maker's. Made-up data only: the admin, a second person made here, and a
// voice called "Test Voice".
import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
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

test("dragging the editor's player to either end keeps its bubble inside it", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const { editor } = await newVoice(page);
	await editor
		.getByRole("group", { name: "A style to start with" })
		.getByRole("button", { name: "Bedtime" })
		.click();
	const player = editor.getByRole("group", { name: "Read aloud player" });
	await expect(player.getByRole("button", { name: "Pause" })).toBeVisible({
		timeout: 15_000,
	});
	// The pointer presses where the player is drawn, so it must be in view first.
	await player.scrollIntoViewIfNeeded();
	await waitForMotionToSettle(page);
	const line = await player
		.getByRole("slider", { name: "Sentence" })
		.boundingBox();
	const pill = await player.boundingBox();
	if (!line || !pill) throw new Error("the editor's player has no box");
	const y = line.y + line.height / 2;
	const bubble = player.locator(".read-aloud-bubble");
	/** How far the bubble's edges are inside the player's, at least (negative: outside). */
	const room = async () => {
		const box = await bubble.boundingBox();
		if (!box) return -1;
		return Math.round(
			Math.min(box.x - pill.x, pill.x + pill.width - (box.x + box.width)),
		);
	};

	await page.mouse.move(line.x + 1, y);
	await page.mouse.down();
	await expect(bubble).toHaveCSS("opacity", "1");
	await expect.poll(room).toBeGreaterThanOrEqual(5);
	await page.mouse.move(line.x + line.width - 1, y, { steps: 8 });
	await expect.poll(room).toBeGreaterThanOrEqual(5);
	await page.mouse.up();
	await expect(
		player.getByRole("slider", { name: "Sentence" }),
	).toHaveAttribute("aria-valuetext", "Sentence 2 of 2");
	expect(errors).toEqual([]);
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

test("the arrow keys move a knob off Normal in one press, and back", async ({
	page,
}) => {
	const { editor } = await newVoice(page);
	const pace = editor.getByRole("slider", { name: "Pace" });
	await pace.focus();
	// Normal snaps within 4% of the range; a key step leaves it at the first value outside.
	await page.keyboard.press("ArrowRight");
	await expect(pace).toHaveAttribute("aria-valuetext", "A little faster");
	await page.keyboard.press("ArrowLeft");
	await expect(pace).toHaveAttribute("aria-valuetext", "Normal");
	await page.keyboard.press("ArrowLeft");
	await expect(pace).toHaveAttribute("aria-valuetext", "A little slower");
});

test("↺ gives focus to its slider", async ({ page }) => {
	const { editor } = await newVoice(page);
	const pace = editor.getByRole("slider", { name: "Pace" });
	await pace.focus();
	await page.keyboard.press("PageUp");
	await expect(pace).not.toHaveAttribute("aria-valuetext", "Normal");
	await page.keyboard.press("Shift+Tab");
	await expect(
		editor.getByRole("button", { name: "Pace back to normal" }),
	).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(pace).toHaveAttribute("aria-valuetext", "Normal");
	await expect(pace).toBeFocused();
});

/** Puts the signed-in person's interface in a language: the next page load shows it. */
async function setUiLanguage(page: Page, language: "en" | "hu") {
	const response = await page.request.patch("/api/settings/preferences", {
		data: { uiLanguage: language },
	});
	expect(response.ok(), `language -> ${response.status()}`).toBe(true);
}

/** Opens Settings in whatever language the interface is in, and returns its Read aloud card. */
async function readAloudCard(page: Page) {
	await page.goto("/settings", { waitUntil: "domcontentloaded" });
	await waitForHydration(page);
	const card = page.locator("#settings-section-read-aloud");
	await expect(card.getByRole("combobox").first()).toBeEnabled({
		timeout: 15_000,
	});
	await card.scrollIntoViewIfNeeded();
	return card;
}

test("in Hungarian every knob's ↺ is clear of its slider and resets it", async ({
	page,
}) => {
	await setUiLanguage(page, "hu");
	try {
		const card = await readAloudCard(page);
		await card.getByRole("button", { name: "Új hang" }).click();
		const editor = page.getByRole("dialog", { name: "Új hang" });
		await expect(editor).toBeVisible();
		await waitForMotionToSettle(page);
		await editor
			.getByRole("group", { name: "Egy stílus kezdésnek" })
			.getByRole("button", { name: "Vidám" })
			.click();
		// Cheerful moves Pace, Pitch, Energy and Projection.
		for (const name of ["Tempó", "Hangmagasság", "Energia", "Hangerő"]) {
			const reset = editor.getByRole("button", {
				name: `${name} vissza normálra`,
			});
			const slider = editor.getByRole("slider", { name, exact: true });
			await reset.scrollIntoViewIfNeeded();
			await expectTopmost(reset, {
				message: `${name}'s ↺ must not sit under its slider`,
				probe: "center",
			});
			const a = await reset.boundingBox();
			const b = await slider.boundingBox();
			if (!a || !b) throw new Error(`${name} has no box`);
			expect(
				a.x + a.width <= b.x || b.x + b.width <= a.x,
				`${name}'s ↺ overlaps its slider`,
			).toBe(true);
		}
		await editor
			.getByRole("button", { name: "Hangmagasság vissza normálra" })
			.click();
		await expect(
			editor.getByRole("slider", { name: "Hangmagasság", exact: true }),
		).toHaveAttribute("aria-valuetext", "Normál");
		// The longest words ("Kicsit nyugodtabb", Newsreader's Energy) fit their column.
		await editor
			.getByRole("group", { name: "Egy stílus kezdésnek" })
			.getByRole("button", { name: "Hírolvasó" })
			.click();
		await expect(
			editor.getByRole("slider", { name: "Energia", exact: true }),
		).toHaveAttribute("aria-valuetext", "Kicsit nyugodtabb");
		const spilled = await editor
			.locator(".voice-knob-word")
			.evaluateAll((words) =>
				words
					.filter((word) => word.scrollWidth > word.clientWidth + 1)
					.map((word) => word.textContent),
			);
		expect(spilled).toEqual([]);
	} finally {
		await setUiLanguage(page, "en");
	}
});

for (const language of ["en", "hu"] as const)
	test(`on a 375 px phone the edit footer's buttons never overlap (${language})`, async ({
		page,
	}) => {
		await makeVoice(page, "imogen");
		await setUiLanguage(page, language);
		try {
			await page.setViewportSize({ width: 375, height: 812 });
			const card = await readAloudCard(page);
			await card
				.getByRole("button", {
					name: language === "hu" ? "Szerkesztés" : "Edit",
				})
				.first()
				.click();
			const editor = page.getByRole("dialog", {
				name: language === "hu" ? "Hang szerkesztése" : "Edit voice",
			});
			await expect(editor).toBeVisible();
			await waitForMotionToSettle(page);
			const names =
				language === "hu"
					? ["Törlés", "Mentés újként", "Módosítások mentése"]
					: ["Delete", "Save as new", "Save changes"];
			const boxes = [];
			for (const name of names) {
				const button = editor.getByRole("button", { name, exact: true });
				await expectTopmost(button, {
					message: `${name} must not be covered`,
					probe: "center",
				});
				boxes.push(await button.boundingBox());
			}
			for (let i = 0; i < boxes.length; i++) {
				const box = boxes[i];
				if (!box) throw new Error(`${names[i]} has no box`);
				expect(
					box.height,
					`${names[i]} is a 44 px target`,
				).toBeGreaterThanOrEqual(44);
				expect(box.x).toBeGreaterThanOrEqual(0);
				expect(box.x + box.width).toBeLessThanOrEqual(375);
				const previous = boxes[i - 1];
				if (previous)
					expect(
						previous.x + previous.width,
						`${names[i - 1]} overlaps ${names[i]}`,
					).toBeLessThanOrEqual(box.x + 0.5);
			}
			// The labels are whole: none is cut or spills out of its button.
			for (const name of names)
				expect(
					await editor
						.getByRole("button", { name, exact: true })
						.evaluate(
							(element) => element.scrollWidth <= element.clientWidth + 1,
						),
					`${name}'s label fits`,
				).toBe(true);
		} finally {
			await setUiLanguage(page, "en");
		}
	});

test("on a phone the voice rows' labels start where every other row's does", async ({
	page,
}) => {
	await page.setViewportSize({ width: 375, height: 812 });
	const card = await openReadAloudSettings(page);
	const english = await card
		.getByText("English voice", { exact: true })
		.boundingBox();
	const speed = await card
		.getByText("Default speed", { exact: true })
		.boundingBox();
	expect(english?.x).toBeCloseTo(speed?.x ?? 0, 0);
});

test("the Read aloud card is in the server's page, so it never appears late and pushes Settings down", async ({
	page,
}) => {
	const response = await page.request.get("/settings");
	expect(response.ok()).toBe(true);
	expect(await response.text()).toContain('id="settings-section-read-aloud"');
});

test("Settings brings the saved voices with the page: the card draws them at once and does not grow", async ({
	page,
}) => {
	await makeVoice(page, "imogen");
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/api/read-aloud/voices", async (route) => {
		if (route.request().method() === "GET") await held;
		await route.continue();
	});
	try {
		await page.goto("/settings", { waitUntil: "domcontentloaded" });
		await waitForHydration(page);
		const card = page.locator("#settings-section-read-aloud");
		// Its voice is there while any request for the voices is still held.
		await expect(card.getByRole("list").getByText("Test Voice")).toBeVisible({
			timeout: 15_000,
		});
		await card.scrollIntoViewIfNeeded();
		const first = (await card.boundingBox())?.height ?? 0;
		release();
		await page.waitForTimeout(400);
		await waitForMotionToSettle(page);
		expect((await card.boundingBox())?.height).toBeCloseTo(first, 0);
	} finally {
		release();
		await page.unroute("**/api/read-aloud/voices");
	}
});

test("the Listen switches show the app's focus ring", async ({ page }) => {
	const { editor } = await newVoice(page);
	await editor
		.getByRole("group", { name: "Compare" })
		.getByRole("button", { name: "Original" })
		.focus();
	await page.keyboard.press("Tab");
	const toggle = editor.getByRole("switch", { name: "Play after each change" });
	await expect(toggle).toBeFocused();
	await expect(toggle).toHaveCSS("outline-style", "solid");
	await expect(toggle).toHaveCSS("outline-width", "2px");
});

test("after Delete, focus lands on New voice", async ({ page }) => {
	await makeVoice(page, "imogen");
	const card = await openReadAloudSettings(page);
	await card.getByRole("button", { name: "Edit" }).first().click();
	const editor = page.getByRole("dialog", { name: "Edit voice" });
	await expect(editor).toBeVisible();
	await editor.getByRole("button", { name: "Delete", exact: true }).click();
	const confirm = page.getByRole("dialog", { name: "Delete this voice?" });
	await confirm.getByRole("button", { name: "Delete", exact: true }).click();
	await expect(editor).toBeHidden();
	await expect(card.getByRole("button", { name: "New voice" })).toBeFocused();
});

test("the card keeps its size while its voices load, and the voice labels sit level with their pickers", async ({
	page,
}) => {
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/api/read-aloud/voices", async (route) => {
		if (route.request().method() === "GET") await held;
		await route.continue();
	});
	try {
		await page.goto("/settings", { waitUntil: "domcontentloaded" });
		await waitForHydration(page);
		const card = page.locator("#settings-section-read-aloud");
		await expect(card).toBeVisible({ timeout: 15_000 });
		await card.scrollIntoViewIfNeeded();
		const english = card.getByRole("combobox", { name: "English voice" });
		// The page brought the voices: there is no load to wait for.
		await expect(english).toBeEnabled();
		const loading = {
			card: (await card.boundingBox())?.height ?? 0,
			picker: (await english.boundingBox())?.width ?? 0,
		};
		release();
		await expect(english).toBeEnabled({ timeout: 15_000 });
		await waitForMotionToSettle(page);
		expect((await card.boundingBox())?.height).toBeCloseTo(loading.card, 0);
		expect((await english.boundingBox())?.width).toBeCloseTo(loading.picker, 0);
		const label = await card
			.getByText("English voice", { exact: true })
			.boundingBox();
		const picker = await english.boundingBox();
		if (!label || !picker) throw new Error("the row has no box");
		expect(
			Math.abs(label.y + label.height / 2 - (picker.y + picker.height / 2)),
		).toBeLessThan(1.5);
	} finally {
		release();
		await page.unroute("**/api/read-aloud/voices");
	}
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

for (const [where, size] of [
	["a short desktop window", { width: 1280, height: 700 }],
	["a phone", { width: 390, height: 700 }],
] as const)
	test(`Tab never puts focus behind the editor's head or its footer, on ${where}`, async ({
		page,
	}) => {
		// WCAG 2.2 SC 2.4.11: the editor scrolls under a sticky head and footer, and a
		// control the browser leaves under either is a hidden focus (Plan 3 fix
		// verification, D2).
		await page.setViewportSize(size);
		const { editor } = await newVoice(page);
		await expect(editor.locator(".voice-editor-head")).toBeVisible();
		const hidden: string[] = [];
		const check = async (key: string) => {
			const result = await page.evaluate(() => {
				const active = document.activeElement as HTMLElement | null;
				const dialog = active?.closest('[role="dialog"]');
				if (!active || !dialog) return null;
				if (
					active.closest(".dialog-shell__footer") ||
					active.closest(".voice-editor-head")
				)
					return null;
				const box = active.getBoundingClientRect();
				const footer = dialog
					.querySelector(".dialog-shell__footer")
					?.getBoundingClientRect();
				const head = dialog
					.querySelector(".voice-editor-head")
					?.getBoundingClientRect();
				return {
					name:
						active.getAttribute("aria-label") ??
						active.textContent?.trim() ??
						active.tagName,
					// Hidden: overlapped by the footer or the head, not merely above or below
					// them (the sheet's grabber sits above the head).
					under: footer
						? box.bottom > footer.top + 1 && box.top < footer.bottom
						: false,
					over: head
						? box.top < head.bottom - 1 && box.bottom > head.top
						: false,
				};
			});
			if (result && (result.under || result.over))
				hidden.push(
					`${key}: ${result.name}${result.under ? " (under the footer)" : " (under the head)"}`,
				);
		};
		for (let i = 0; i < 32; i++) {
			await page.keyboard.press("Tab");
			await check("Tab");
		}
		for (let i = 0; i < 32; i++) {
			await page.keyboard.press("Shift+Tab");
			await check("Shift+Tab");
		}
		expect(hidden).toEqual([]);
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
