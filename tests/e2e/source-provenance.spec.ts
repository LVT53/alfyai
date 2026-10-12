import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { db } from "../../src/lib/server/db";
import { messages } from "../../src/lib/server/db/schema";
import { createEmptyConversation, login } from "./helpers";

// docs/plans/exfil-channels, the server's half: the browser asks the app for a
// host's icon and for a search picture, and the model writes the hosts and the
// pictures the browser asks about, so the app answers only for what a tool
// returned to THIS user. These run against the production build and the real
// session gate: what a stranger gets, what a signed-in user gets for something no
// tool returned, and that reading a conversation (which is what fills the
// in-memory ledger again after a restart) is what lets a stored source's icon
// through. None of it needs the network: a refusal makes no outbound request,
// and an allowed host whose icon cannot be fetched is the globe, kept privately.

const THUMB =
	"https://imgs.search.brave.com/Zq3s9x/rs:fit:500:0:0:0/g:ce/aHR0cHM6Ly9leGFtcGxlLmNvbS9jYXQuanBn";

function faviconPath(host: string): string {
	return `/api/favicon?domain=${encodeURIComponent(host)}`;
}

function thumbnailPath(address: string): string {
	return `/api/image-search/thumbnail?url=${encodeURIComponent(address)}`;
}

test.describe("source routes, no session", () => {
	test("the favicon and thumbnail routes answer 401 JSON, not a redirect and not an icon", async ({
		request,
	}) => {
		for (const path of [faviconPath("example.com"), thumbnailPath(THUMB)]) {
			const response = await request.get(path, { maxRedirects: 0 });

			expect(response.status(), path).toBe(401);
			expect(response.headers()["content-type"], path).toContain(
				"application/json",
			);
		}
	});
});

test.describe("source routes, signed in", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("a host no tool returned gets the globe, and the answer is never cached", async ({
		page,
	}) => {
		const response = await page.request.get(
			faviconPath(`never-returned-${randomUUID().slice(0, 8)}.example.com`),
		);

		expect(response.status()).toBe(200);
		expect(response.headers()["content-type"]).toBe("image/svg+xml");
		expect(response.headers()["cache-control"]).toBe("no-store");
	});

	test("a picture no search returned is a bare 404, whether or not the address is Brave's", async ({
		page,
	}) => {
		for (const address of [
			THUMB,
			"https://evil.example/collect?d=secret",
			"http://imgs.search.brave.com/Zq3s9x/abc",
		]) {
			const response = await page.request.get(thumbnailPath(address));

			expect(response.status(), address).toBe(404);
			expect(await response.text(), address).toBe("");
			expect(response.headers()["cache-control"], address).toBe("no-store");
		}
		const missing = await page.request.get("/api/image-search/thumbnail");
		expect(missing.status()).toBe(404);
	});

	test("reading a conversation lets the icon of a source its stored tool calls returned through", async ({
		page,
	}) => {
		const host = `stored-source-${randomUUID().slice(0, 8)}.invalid`;
		const conversationId = await createEmptyConversation(page, "Source ledger");
		await db.insert(messages).values({
			id: randomUUID(),
			conversationId,
			messageSequence: 1,
			role: "assistant",
			content: "I found a source.",
			createdAt: new Date(),
			toolCalls: JSON.stringify([
				{
					type: "tool_call",
					name: "research_web",
					input: { query: "anything" },
					status: "done",
					candidates: [
						{
							id: "c1",
							title: "A stored source",
							url: `https://${host}/article`,
							sourceType: "web",
						},
					],
				},
			]),
		});

		// The server has not seen this source since it started: refused.
		const before = await page.request.get(faviconPath(host));
		expect(before.headers()["cache-control"]).toBe("no-store");

		// The chat page's own read of the conversation: it is what notes the
		// stored tool calls' sources for the user.
		const detail = await page.request.get(
			`/api/conversations/${conversationId}`,
		);
		expect(detail.ok()).toBe(true);

		// Now the host is one a tool returned: the proxy goes for its icon. That
		// host does not exist, so it answers with the globe, kept only privately
		// and briefly — not the refusal's `no-store`.
		const after = await page.request.get(faviconPath(host), {
			timeout: 30_000,
		});
		expect(after.status()).toBe(200);
		expect(after.headers()["cache-control"]).toMatch(/^private, max-age=/);

		// A neighbouring host the conversation never returned is still refused.
		const neighbour = await page.request.get(faviconPath(`other-${host}`));
		expect(neighbour.headers()["cache-control"]).toBe("no-store");
	});
});
