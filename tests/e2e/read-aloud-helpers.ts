// Helpers for the read-aloud specs: a fake speech service in the spec's own
// process, the app pointed at it through the admin config, and a conversation
// seeded with the replies the specs read.
//
// The fake follows `deploy/speech-service/README.md` (one reader of each
// stream, sentences made only while `i <= position + 2`, errors and cuts on
// demand), so a spec drives the real routes, the registry and the browser
// against the service's contract without the GPU box.
import { expect, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import { conversations, messages, users } from "../../src/lib/server/db/schema";
import {
	createFakeSpeechService,
	type FakeSpeechOptions,
	type FakeSpeechService,
} from "../../src/lib/server/services/read-aloud/testing/fake-speech-service";
import { clearAdminConfig } from "./helpers";

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

/** Puts both keys back (read aloud is off again), then closes the fake. */
export async function stopFakeSpeechForSpec(
	page: Page,
	fake: FakeSpeechService,
): Promise<void> {
	try {
		await clearAdminConfig(page, [...READ_ALOUD_CONFIG_KEYS]);
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
