// Helpers for the read-aloud specs: a fake speech service in the spec's own
// process, the app pointed at it through the admin config, and a conversation
// seeded with the replies the specs read.
//
// The fake follows `deploy/speech-service/README.md` (one reader of each
// stream, sentences made only while `i <= position + 2`, errors and cuts on
// demand), so a spec drives the real routes, the registry and the browser
// against the service's contract without the GPU box.
import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import { conversations, messages, users } from "../../src/lib/server/db/schema";
import {
	createFakeSpeechService,
	type FakeSpeechOptions,
	type FakeSpeechService,
} from "../../src/lib/server/services/read-aloud/testing/fake-speech-service";
import { clearAdminConfig, waitForHydration } from "./helpers";

export type { FakeSpeechOptions, FakeSpeechService };

/** The admin keys read aloud's specs write: the switch and the service's address. */
export const READ_ALOUD_CONFIG_KEYS = ["TTS_ENABLED", "TTS_URL"] as const;

/**
 * Starts a fake speech service in the spec's own process and switches read
 * aloud on, pointed at it, through the admin config route (the way
 * `startFakeComfyUiForSpec` does for pictures). Both keys are live, so the next
 * page load sees them. A worker keeps its database from one spec file to the
 * next: put the keys back with `stopFakeSpeechForSpec`.
 */
export async function startFakeSpeechForSpec(
	page: Page,
	options?: FakeSpeechOptions,
): Promise<FakeSpeechService> {
	const fake = await createFakeSpeechService(options);
	try {
		const response = await page.request.put("/api/admin/config", {
			data: { TTS_ENABLED: "true", TTS_URL: fake.baseUrl },
		});
		expect(response.ok(), `read aloud config set -> ${response.status()}`).toBe(
			true,
		);
	} catch (error) {
		await fake.close();
		throw error;
	}
	return fake;
}

/** Puts both keys back: read aloud is off again, as a worker's server meets the next spec. */
export async function clearAdminConfigForReadAloud(page: Page): Promise<void> {
	await clearAdminConfig(page, [...READ_ALOUD_CONFIG_KEYS]);
}

/** Puts both keys back (read aloud is off again), then closes the fake. */
export async function stopFakeSpeechForSpec(
	page: Page,
	fake: FakeSpeechService,
): Promise<void> {
	try {
		await clearAdminConfigForReadAloud(page);
	} finally {
		await fake.close();
	}
}

/**
 * A conversation of the e2e admin (`admin@local`) with a user message before
 * each assistant reply, the replies being `replies` in order. Written through
 * the app's own database, as `seedConversationWithContext` does. Returns the
 * assistant messages' ids, in order: the id of reply k is `<id>-assistant-<k>`.
 */
export async function seedReadAloudChat(
	id: string,
	replies: string[],
): Promise<string[]> {
	const [admin] = await db
		.select()
		.from(users)
		.where(eq(users.email, "admin@local"))
		.limit(1);
	expect(admin, "the e2e admin must exist").toBeTruthy();

	await db.delete(messages).where(eq(messages.conversationId, id));
	await db.delete(conversations).where(eq(conversations.id, id));

	const now = new Date();
	await db.insert(conversations).values({
		id,
		userId: admin.id,
		title: "Read aloud",
		createdAt: now,
		updatedAt: now,
	});
	const rows = replies.flatMap((reply, k) => [
		{
			id: `${id}-user-${k}`,
			conversationId: id,
			messageSequence: 2 * k + 1,
			role: "user" as const,
			content: `Question ${k + 1}`,
			createdAt: now,
		},
		{
			id: `${id}-assistant-${k}`,
			conversationId: id,
			messageSequence: 2 * k + 2,
			role: "assistant" as const,
			content: reply,
			createdAt: now,
		},
	]);
	if (rows.length > 0) await db.insert(messages).values(rows);
	return replies.map((_, k) => `${id}-assistant-${k}`);
}

/**
 * Five sentences of English, so that reading to the end needs the position
 * reports: the fake holds sentence i until `i <= position + 2`, so the fourth
 * and the fifth only come once the browser says where it is.
 */
export const FIVE_SENTENCE_REPLY =
	"The garden gate opens at dawn. Small birds gather on the old stone wall. A cat watches them quietly from the porch. Later the sun climbs above the tall trees. The whole street smells of fresh bread.";

/** Two sentences of English. */
export const TWO_SENTENCE_REPLY =
	"The kettle is on the stove. Tea will be ready very soon.";

/** A language that has no voice: the speaker is dimmed with a note. */
export const GERMAN_REPLY =
	"Der Hund läuft schnell durch den großen Garten. Die Kinder spielen draußen mit dem Ball und lachen laut.";

/**
 * A reply that holds every kind of syntax the voice must not hear: a heading,
 * bold, a link, inline code, a block of two lines (read), a block of five lines
 * (left out, unless Read from here starts in it), a table, a numbered list, a
 * checklist, a quote, an emoji and a bare address.
 */
export const SYNTAX_REPLY = [
	"# Reading the syntax",
	"",
	"Here is **bold text** and a [link to the guide](https://example.com/guide) in a sentence about `getUserName()` today.",
	"",
	"```python",
	"total = price * 2",
	"print(total)",
	"```",
	"",
	"```js",
	"const secretCode = 42;",
	"const other = 1;",
	"const more = 2;",
	"const again = 3;",
	"const last = 4;",
	"```",
	"",
	"| Name | Value |",
	"| --- | --- |",
	"| TABLECELL | 7 |",
	"",
	"1. Mix the flour well",
	"2. Add the water slowly",
	"",
	"- [x] Buy the flour",
	"- [ ] Bake the bread",
	"",
	"> A quote worth hearing.",
	"",
	"Smile 😀 and visit https://www.example.com/docs for more.",
].join("\n");

/**
 * A chat of the e2e admin with `replies` as its assistant replies, opened in
 * the page. The id is new each time, so a spec never meets another's rows.
 */
export async function openReadAloudChat(
	page: Page,
	replies: string[],
): Promise<{ chatId: string; messageIds: string[] }> {
	const chatId = `read-aloud-${randomUUID()}`;
	const messageIds = await seedReadAloudChat(chatId, replies);
	await page.goto(`/chat/${chatId}`, { waitUntil: "domcontentloaded" });
	await waitForHydration(page);
	// The Markdown renders after hydration, and a code block after the
	// highlighter has loaded: a spec that acts before has no text to select or read.
	for (const id of messageIds)
		await expect(
			page.locator(`[data-message-id="${id}"] .markdown-container`),
		).toContainText(/\S/, { timeout: 15_000 });
	const fences = replies.join("\n").split("```").length - 1;
	if (fences >= 2)
		await expect(page.locator(".message-body .code-block")).toHaveCount(
			Math.floor(fences / 2),
			{ timeout: 15_000 },
		);
	return { chatId, messageIds };
}

/** Takes a chat made by `openReadAloudChat` away again: a worker keeps its database from one spec to the next. */
export async function deleteReadAloudChat(
	page: Page,
	chatId: string,
): Promise<void> {
	await page.request.delete(`/api/conversations/${chatId}`);
}

/**
 * Where read aloud's parts are on the page, by what a person (or a screen
 * reader) calls them: the speaker's and the player's accessible names are the
 * English words of `src/lib/i18n/read-aloud.ts`.
 */
export function readAloudUi(page: Page) {
	const player = page.getByLabel("Read aloud player");
	return {
		/** The speaker of the `reply`-th reply of the chat, counting from 0. */
		speaker: (reply = 0) => page.getByTestId("read-aloud-speaker").nth(reply),
		player,
		/** The player's slot (it keeps its room while hushed) and the stage inside it that fades. */
		slot: page.locator(".read-aloud-slot"),
		stage: page.locator(".read-aloud-stage"),
		/** A button of the player, by its name ("Next sentence", "Stop reading"…). */
		button: (name: string) => player.getByRole("button", { name, exact: true }),
		/** The play button, whatever its name: that says what a press does ("Play", "Pause"…). */
		play: player.locator(".read-aloud-play"),
		slider: page.getByRole("slider", { name: "Sentence" }),
		/** The speed chip ("Speed: 1×"). */
		speed: player.getByRole("button", { name: /^Speed/ }),
		note: page.locator(".read-aloud-note"),
		/** The tint of the sentence being read. */
		tint: page.locator(".read-aloud-sentence .read-aloud-box"),
		/** The marker of the word being spoken. */
		word: page.locator(".read-aloud-word"),
		pill: page.getByRole("button", { name: "Read from here" }),
	};
}

/**
 * Selects `length` characters of the first text node of the page's replies that
 * holds `needle`, from where it starts: what a person does with a mouse, made
 * exactly. Fires the page's own `selectionchange`.
 */
export async function selectInReply(
	page: Page,
	needle: string,
	length = needle.length,
): Promise<void> {
	await page.evaluate(
		({ needle: text, length: count }) => {
			const roots = document.querySelectorAll(
				".message-body .markdown-container",
			);
			for (const root of roots) {
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
			}
			throw new Error(`no text "${text}" in a reply`);
		},
		{ needle, length },
	);
}

/** The tokens the fake was asked to speak, in order, over every session it has had. */
export function spokenTokens(fake: FakeSpeechService): string[] {
	return fake.sessions.flatMap((session) =>
		session.body.sentences.flatMap((sentence) => sentence.tokens),
	);
}

/** Whether `words` come one after another in `tokens`, ignoring the pause marks at a token's end. */
export function hasRun(tokens: string[], words: string[]): boolean {
	const bare = tokens.map((token) => token.replace(/[.,;:!?…]+$/u, ""));
	return bare.some((_, start) =>
		words.every((word, offset) => bare[start + offset] === word),
	);
}

/**
 * Deletes the signed-in person's voices and puts back English Imogen,
 * Hungarian Berta and a Default speed of 1 (Plan 3). A worker keeps its
 * database from one spec file to the next, so every voices spec calls it in its
 * cleanup, while read aloud is still on: the routes answer 404 when it is off.
 */
export async function resetReadAloudVoices(page: Page): Promise<void> {
	const listed = await page.request.get("/api/read-aloud/voices");
	expect(listed.ok(), `voices read -> ${listed.status()}`).toBe(true);
	const { voices } = (await listed.json()) as { voices: Array<{ id: string }> };
	for (const voice of voices) {
		const deleted = await page.request.delete(
			`/api/read-aloud/voices/${encodeURIComponent(voice.id)}`,
		);
		expect(deleted.ok(), `voice delete -> ${deleted.status()}`).toBe(true);
	}
	const reset = await page.request.put("/api/read-aloud/preferences", {
		data: { en: "imogen", hu: "berta", defaultSpeed: 1 },
	});
	expect(reset.ok(), `preferences reset -> ${reset.status()}`).toBe(true);
}

/** Opens Settings and returns its Read aloud card, once the card's voices have loaded. */
export async function openReadAloudSettings(page: Page) {
	await page.goto("/settings", { waitUntil: "domcontentloaded" });
	await waitForHydration(page);
	const card = page.locator("#settings-section-read-aloud");
	await expect(card).toBeVisible({ timeout: 15_000 });
	await expect(
		card.getByRole("combobox", { name: "English voice" }),
	).toBeEnabled({ timeout: 15_000 });
	await card.scrollIntoViewIfNeeded();
	return card;
}
