// Read aloud on a Document, end to end, against the fake speech service
// (read-aloud-documents). The reply's machinery reads a Document open in the side
// panel: the speaker in the panel's header, the player above the composer beside
// a docked panel and at the panel's foot on a phone, the marks in the Document's
// page, Read from here on a selection in it, and a long Document's scrubber that
// notches its headings. The session route's refusals (another person's Document,
// words the version does not hold) are held by its own tests on a real database,
// `src/routes/api/read-aloud/sessions/sessions.document.test.ts`.
import { expect, type Locator, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import { users } from "../../src/lib/server/db/schema";
import { createDocumentArtifact } from "../../src/lib/server/services/artifacts";
import {
	createEmptyConversation,
	expectTopmost,
	login,
	waitForHydration,
	waitForMotionToSettle,
	workspacePanel,
} from "./helpers";
import {
	type FakeSpeechService,
	hasRun,
	readAloudUi,
	spokenTokens,
	startFakeSpeechForSpec,
	stopFakeSpeechForSpec,
} from "./read-aloud-helpers";

let fake: FakeSpeechService;
let chatId: string | null = null;

test.beforeEach(async ({ page }) => {
	await login(page);
	fake = await startFakeSpeechForSpec(page, { secondsPerChar: 0.02 });
});

test.afterEach(async ({ page }) => {
	try {
		if (chatId) await page.request.delete(`/api/conversations/${chatId}`);
	} finally {
		chatId = null;
		await stopFakeSpeechForSpec(page, fake);
	}
});

async function adminId(): Promise<string> {
	const [admin] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, "admin@local"))
		.limit(1);
	expect(admin, "the e2e admin must exist").toBeTruthy();
	return admin.id;
}

/**
 * A chat of the e2e admin holding one Document of `markdown` (made through the real
 * service, so its body is canonical with real block ids), opened in the side panel.
 */
async function openDocument(
	page: Page,
	markdown: string,
	firstWords: string,
): Promise<Locator> {
	const conversationId = await createEmptyConversation(page);
	chatId = conversationId;
	await createDocumentArtifact({
		userId: await adminId(),
		conversationId,
		title: "Weekend plan",
		markdown,
		author: "user",
		summary: "Seeded for read aloud",
	});
	await page.goto(`/chat/${conversationId}`, { waitUntil: "domcontentloaded" });
	await waitForHydration(page);
	const phone = (page.viewportSize()?.width ?? 1440) < 768;
	await page
		.getByTestId(
			phone ? "artifact-count-button-compact" : "artifact-count-button",
		)
		.click();
	await page
		.getByTestId(phone ? "artifact-panel-list-mobile" : "artifact-panel-list")
		.getByTestId("artifact-row")
		.first()
		.click({ timeout: 30_000 });
	const shell = phone
		? page.getByTestId("document-workspace-mobile-shell")
		: workspacePanel(page);
	await expect(shell).toBeVisible({ timeout: 30_000 });
	await expect(
		shell.locator(".document-editor-host .ProseMirror"),
	).toContainText(firstWords, { timeout: 30_000 });
	return shell;
}

/** What read aloud draws in a Document's panel. */
function documentUi(page: Page, shell: Locator) {
	return {
		...readAloudUi(page),
		speaker: shell.getByTestId("read-aloud-speaker-header"),
		/** The tint of the sentence being read, in the Document's page. */
		tint: shell.locator(
			".document-read-aloud-frame .read-aloud-sentence .read-aloud-box",
		),
		/** The text column that scrolls. */
		scroller: shell.locator(".document-content-text"),
	};
}

/** Where the first tint box is, as a string a poll can compare. */
async function tintPlace(tint: Locator): Promise<string> {
	const box = await tint.first().boundingBox();
	return box
		? `${Math.round(box.x)}:${Math.round(box.y)}:${Math.round(box.width)}`
		: "none";
}

/**
 * Selects `length` characters of the page's text node that holds `needle`, the way
 * the selection bubble's own spec does: a click to put the editor's focus there,
 * then an exact range, which ProseMirror takes as the reader's selection.
 */
async function selectInDocument(
	page: Page,
	shell: Locator,
	needle: string,
	length = needle.length,
): Promise<void> {
	await shell
		.locator(".document-editor-host .ProseMirror")
		.getByText(needle, { exact: false })
		.first()
		.click();
	await page.evaluate(
		({ needle: text, length: count }) => {
			const root = document.querySelector(".document-editor-host .ProseMirror");
			if (!root) throw new Error("no Document page");
			const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
			for (let node = walker.nextNode(); node; node = walker.nextNode()) {
				const at = node.textContent?.indexOf(text) ?? -1;
				if (at < 0) continue;
				const range = document.createRange();
				range.setStart(node, at);
				range.setEnd(node, at + count);
				const selection = document.getSelection();
				selection?.removeAllRanges();
				selection?.addRange(range);
				return;
			}
			throw new Error(`no text "${text}" in the Document`);
		},
		{ needle, length },
	);
}

/**
 * A heading and five paragraphs: the fake makes sentence i only while
 * `i <= position + 2`, so a reading that stops early is one the service is still
 * making, and its DELETE reaches it (a session made to its end and read is
 * forgotten, as the service does, and there is nothing left to delete).
 */
const PLAN = [
	"# Weekend plan",
	"",
	"Book the hotel by Friday, and ask for a quiet room at the back of the house.",
	"",
	"Pay the deposit before the end of the week, by card or in cash at the desk.",
	"",
	"Pack the warm coats, because the nights up in the hills are cold in autumn.",
	"",
	"Take the long scarves as well, and the thick woollen socks for the evenings.",
	"",
	"The train leaves at nine in the morning from the main station in the town.",
].join("\n");

test("@smoke the speaker in a Document's header reads it: the player rises above the composer and the tint moves in the page", async ({
	page,
}) => {
	const shell = await openDocument(page, PLAN, "Book the hotel");
	const ui = documentUi(page, shell);
	await expect(ui.speaker).toHaveAttribute("aria-label", "Read aloud");
	await ui.speaker.click();

	// Beside a docked panel in a chat, the player is the composer's.
	const composerPlayer = page
		.locator(".composer-layer")
		.getByLabel("Read aloud player");
	await expect(composerPlayer).toBeVisible();
	await expect(composerPlayer).toHaveCSS("opacity", "1");
	await expect(ui.tint.first()).toBeVisible();
	const first = await tintPlace(ui.tint);
	await expect
		.poll(() => tintPlace(ui.tint), { timeout: 15_000 })
		.not.toBe(first);
	await expect(ui.speaker).toHaveAttribute("aria-label", "Pause reading");

	// The session names the Document and the version the panel shows.
	const body = fake.sessions[0]?.body as unknown as {
		sentences: Array<{ tokens: string[] }>;
	};
	expect(body.sentences.length).toBeGreaterThan(0);
	expect(
		hasRun(spokenTokens(fake), ["Book", "the", "hotel", "by", "Friday"]),
	).toBe(true);

	await ui.button("Stop reading").click();
	await expect(composerPlayer).toBeHidden();
	await expect.poll(() => fake.sessions.at(-1)?.deleted).toBe(true);
	await expect(ui.speaker).toHaveAttribute("aria-label", "Read aloud");
});

test("what is read is the Document as its page draws it: no table, chip or long code, and a heading's pause", async ({
	page,
}) => {
	const shell = await openDocument(
		page,
		[
			"# Weekend plan",
			"",
			'Book the hotel by Friday, and ask for a quiet room at the back. [chip kind="status" value="Booked"]',
			"",
			"| Item | Cost |",
			"| --- | --- |",
			"| TABLECELL | 90 |",
			"",
			"1. Pack the warm coats for the cold nights in the hills.",
			"2. Take the long scarves and the thick woollen socks too.",
			"",
			"```js",
			"const secretCode = 42;",
			"const other = 1;",
			"const more = 2;",
			"const again = 3;",
			"const last = 4;",
			"```",
			"",
			"Pay the deposit before the end of the week, by card or in cash.",
		].join("\n"),
		"Book the hotel",
	);
	const ui = documentUi(page, shell);
	await ui.speaker.click();
	await expect.poll(() => fake.sessions.length, { timeout: 15_000 }).toBe(1);
	const tokens = spokenTokens(fake);
	// The heading ends with the pause a paragraph gets, and a numbered list says its numbers.
	expect(tokens.slice(0, 2)).toEqual(["Weekend", "plan."]);
	expect(tokens).toContain("One.");
	expect(hasRun(tokens, ["Pay", "the", "deposit"])).toBe(true);
	for (const left of [
		"Booked",
		"Foglalt",
		"TABLECELL",
		"secret",
		"Code",
		"Item",
	])
		expect(tokens, `${left} is not read`).not.toContain(left);
});

test("Read from here on a selection in the Document reads from its sentence", async ({
	page,
}) => {
	const shell = await openDocument(page, PLAN, "Book the hotel");
	const ui = documentUi(page, shell);
	await selectInDocument(page, shell, "deposit");
	const pill = shell
		.getByTestId("selection-bubble")
		.getByRole("button", { name: "Read from here" });
	await expect(pill).toBeVisible();
	await pill.click();

	await expect.poll(() => fake.sessions.length, { timeout: 15_000 }).toBe(1);
	const first = fake.sessions[0]?.body.sentences[0]?.tokens ?? [];
	expect(first.slice(0, 3)).toEqual(["Pay", "the", "deposit"]);
	await expect(ui.speaker).toHaveAttribute("aria-label", "Pause reading");
	await expect(shell.getByTestId("selection-bubble")).toBeHidden();
});

/** Three sections of fifteen paragraphs, each under a heading of its own. */
function longDocument(): string {
	const section = (title: string) => [
		`## ${title}`,
		"",
		...Array.from({ length: 15 }, (_, i) => [
			`Paragraph ${i + 1} of this section is written here, and it is long enough to stand alone.`,
			"",
		]).flat(),
	];
	return [
		"# A long weekend plan",
		"",
		...section("Getting there by train"),
		...section("Where we will stay"),
		...section("What to pack for the hills"),
	].join("\n");
}

test("a long Document's scrubber notches its headings, Read from here on a heading starts that section, and ⌖ scrolls the page", async ({
	page,
}) => {
	const shell = await openDocument(
		page,
		longDocument(),
		"Getting there by train",
	);
	const ui = documentUi(page, shell);
	await ui.speaker.click();
	await expect(ui.player).toBeVisible();
	// 49 sentences: the title, three headings and 45 paragraphs. Past 40 the
	// scrubber marks where each section starts instead of every sentence.
	await expect(ui.slider).toHaveAttribute("aria-valuemax", "49");
	await expect(ui.player.locator(".read-aloud-notch")).toHaveCount(4);

	await selectInDocument(page, shell, "Where we will stay");
	await shell
		.getByTestId("selection-bubble")
		.getByRole("button", { name: "Read from here" })
		.click();
	await expect.poll(() => fake.sessions.length, { timeout: 15_000 }).toBe(2);
	const section = fake.sessions[1]?.body.sentences[0]?.tokens ?? [];
	expect(section).toEqual(["Where", "we", "will", "stay."]);
	await expect(ui.slider).toHaveAttribute(
		"aria-valuetext",
		/^Sentence 18 of 49$/,
	);

	// The page scrolled away from the reading: ⌖ brings it back in the panel.
	await ui.scroller.evaluate((element) => {
		element.scrollTop = element.scrollHeight;
	});
	await expect(ui.tint.first()).not.toBeInViewport();
	await ui.button("Go to where it's reading").click();
	await expect(ui.tint.first()).toBeInViewport({ timeout: 10_000 });
});

test("editing the Document while it is read stops the reading", async ({
	page,
}) => {
	const shell = await openDocument(page, PLAN, "Book the hotel");
	const ui = documentUi(page, shell);
	await ui.speaker.click();
	await expect(ui.player).toBeVisible();
	await expect(ui.speaker).toHaveAttribute("aria-label", "Pause reading");

	await shell
		.locator(".document-editor-host .ProseMirror")
		.getByText("Pack the warm coats", { exact: false })
		.click();
	await page.keyboard.type("Then ");
	await expect(ui.player).toBeHidden();
	await expect(ui.speaker).toHaveAttribute("aria-label", "Read aloud");
	await expect.poll(() => fake.sessions[0]?.deleted).toBe(true);
});

test("marks never move the Document's text and never cover the player", async ({
	page,
}) => {
	const shell = await openDocument(page, PLAN, "Book the hotel");
	const ui = documentUi(page, shell);
	const word = () =>
		page.evaluate(() => {
			const text = document.querySelector(
				".document-editor-host .ProseMirror p",
			)?.firstChild as Text;
			const range = document.createRange();
			range.setStart(text, 5);
			range.setEnd(text, 10);
			const box = range.getBoundingClientRect();
			return { x: box.x, y: box.y, width: box.width, height: box.height };
		});
	// The panel has finished opening: from here on only the marks change.
	await waitForMotionToSettle(page);
	const before = await word();
	await ui.speaker.click();
	await expect(ui.tint.first()).toBeVisible();
	await waitForMotionToSettle(page);
	const during = await word();
	expect(during.x).toBeCloseTo(before.x, 1);
	expect(during.y).toBeCloseTo(before.y, 1);
	expect(during.width).toBeCloseTo(before.width, 1);
	expect(during.height).toBeCloseTo(before.height, 1);
	await expectTopmost(ui.player, {
		message: "the marks must never paint over the player",
		probe: "center",
	});
});

test("a Document in a language with no voice has its speaker dimmed, with its note", async ({
	page,
}) => {
	const shell = await openDocument(
		page,
		"Der Hund läuft schnell durch den großen Garten. Die Kinder spielen draußen mit dem Ball und lachen laut.",
		"Der Hund",
	);
	const ui = documentUi(page, shell);
	await expect(ui.speaker).toHaveAttribute("aria-disabled", "true", {
		timeout: 15_000,
	});
	await ui.speaker.hover();
	await expect(shell.locator(".read-aloud-note")).toContainText(
		"Read aloud isn't available in German yet.",
	);
});

test("on a phone the panel covers the chat, and the player sits at the panel's foot in the same two rows", async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const shell = await openDocument(page, PLAN, "Book the hotel");
	const ui = documentUi(page, shell);
	await ui.speaker.click();

	const panelPlayer = shell.getByTestId("workspace-read-aloud-player");
	const player = panelPlayer.getByLabel("Read aloud player");
	await expect(player).toBeVisible();
	await expect(player).toHaveCSS("opacity", "1");
	await expect(ui.tint.first()).toBeVisible();
	await waitForMotionToSettle(page);
	// Not the composer's: that one stays down behind the panel.
	await expect(
		page.locator(".composer-layer").getByLabel("Read aloud player"),
	).toBeHidden();
	const pill = await player.boundingBox();
	expect(pill).toBeTruthy();
	// The phone's two rows, inside the screen, at its foot.
	expect(pill?.height).toBeCloseTo(108, 0);
	expect(pill?.x ?? -1).toBeGreaterThanOrEqual(0);
	expect((pill?.x ?? 0) + (pill?.width ?? 999)).toBeLessThanOrEqual(390);
	expect((pill?.y ?? 0) + (pill?.height ?? 0)).toBeLessThanOrEqual(844);
	expect((pill?.y ?? 0) + (pill?.height ?? 0)).toBeGreaterThan(844 - 40);
	await expectTopmost(player, {
		message: "nothing of the page paints over the panel's player",
		probe: "center",
	});
	const play = await ui.button("Pause").boundingBox();
	expect(play?.width).toBeCloseTo(52, 0);

	await ui.button("Stop reading").click();
	await expect(player).toBeHidden();
	await expect.poll(() => fake.sessions.at(-1)?.deleted).toBe(true);
});
