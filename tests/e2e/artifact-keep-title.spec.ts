import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import { artifacts, messages } from "../../src/lib/server/db/schema";
import { createEmptyConversation, login } from "./helpers";

// F20 (ruling 77, the friction audit): "Open as document" titled the Document with
// the first 120 characters of a one-paragraph reply, cut mid-word ("... kiváló k"),
// in a two-line panel header, and the composer's placeholder repeated it in three
// lines. A title now ends at a word or a sentence, near 60 characters. The reply
// is the audit's own; the press is a real click on the real button.

const CAFE_REPLY =
	"Szubjektív, de ha egyet kellene mondani, a Café Central (Herrengasse 14) a legjobb: lenyűgöző neogótikus terem, kiváló kávé és sütemények, és történelmileg is ez volt a város szellemi központja. Ha inkább a csendesebb, eredeti bécsi hangulatot keresed, a Café Sperl vagy a Café Hawelka a jobb választás.";
const EXPECTED_TITLE =
	"Szubjektív, de ha egyet kellene mondani, a Café Central…";

test.describe("the title 'Open as document' gives (F20)", () => {
	test("ends at a word, near 60 characters, in the panel and in the composer's placeholder", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await login(page);
		const conversationId = await createEmptyConversation(
			page,
			"Bécsi kávéházak",
		);
		await db.insert(messages).values({
			id: randomUUID(),
			conversationId,
			messageSequence: 1,
			role: "assistant",
			content: CAFE_REPLY,
			createdAt: new Date(),
		});
		await page.evaluate((id) => {
			window.sessionStorage.removeItem(`pending-chat-message:${id}`);
		}, conversationId);
		await page.goto(`/chat/${conversationId}`);
		await page.reload({ waitUntil: "networkidle" });

		await page.getByTestId("assistant-message").first().hover();
		await page.getByRole("button", { name: "Open as document" }).click();

		// The Document is open in the panel, under the title the reply earned.
		const panel = page.getByRole("complementary", {
			name: new RegExp(`${EXPECTED_TITLE}, Document$`),
		});
		await expect(panel).toBeVisible({ timeout: 30_000 });
		// The composer says what it is about, in the same words.
		await expect(page.getByTestId("message-input")).toHaveAttribute(
			"placeholder",
			new RegExp(`${EXPECTED_TITLE}$`),
		);

		// And it is what was stored: a whole word, with the mark that says so.
		const [kept] = await db
			.select({ name: artifacts.name })
			.from(artifacts)
			.where(eq(artifacts.conversationId, conversationId));
		expect(kept.name).toBe(EXPECTED_TITLE);
		expect(kept.name.length).toBeLessThanOrEqual(61);
	});
});
