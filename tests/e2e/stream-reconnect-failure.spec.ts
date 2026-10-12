import { expect, type Request, test } from "@playwright/test";
import { AI_SMOKE_REFUSE_SLOWLY_MARKER } from "../fixtures/ai/openai-compatible-scenarios";
import { createOpenAICompatibleProviderHarness } from "../mocks/ai-provider/openai-compatible-provider";
import {
	createTemporaryFakeProviderModel,
	deleteTemporaryProvider,
	snapshotUserModelPreference,
	updateUserModelPreference,
} from "./artifact-live-edit.helpers";
import { createEmptyConversation, login, sendMessage } from "./helpers";

// FG's finding 1 (phase 5, FB-8): a reload within a few hundred milliseconds of a
// first turn that FAILS leaves the reconnect request open on heartbeats with no
// terminal event, and the chat shows a turn that never ends. The server's failure
// path cleared the stream's buffer (which holds the reconnected listeners) before
// it emitted the error, so the reconnect subscribed in the window heard nothing.
//
// (A reconnected turn that fails shows what the server kept of it, which for a first
// turn that failed is nothing: the assertion is that the turn ENDS, not what it leaves.)
//
// The fake provider refuses every request of the turn after 1.5 s (HTTP 500: the
// streaming attempt and the non-streaming fallback alike), so the turn is still
// failing when the reader reloads and the page has reattached to it.

const isStreamPost = (request: Request) =>
	request.method() === "POST" &&
	new URL(request.url()).pathname === "/api/chat/stream";

test.describe("A reload while a turn is still failing", () => {
	const fakeProvider = createOpenAICompatibleProviderHarness();

	test.beforeAll(async () => {
		await fakeProvider.start();
	});
	test.afterAll(async () => {
		await fakeProvider.stop();
	});
	test.beforeEach(async () => {
		await fakeProvider.reset();
	});

	test("the reconnected connection ends with the failure, and the turn does not spin for ever", async ({
		page,
	}) => {
		test.setTimeout(180_000);
		await page.setViewportSize({ width: 1440, height: 900 });
		await login(page);
		const previousModelPreference = await snapshotUserModelPreference(page);
		let providerId: string | null = null;
		try {
			const temporary = await createTemporaryFakeProviderModel(
				page,
				fakeProvider.baseURL,
			);
			providerId = temporary.providerId;
			await updateUserModelPreference(page, temporary.selectedModel);
			const conversationId = await createEmptyConversation(page);
			await page.goto(`/chat/${conversationId}`, { waitUntil: "networkidle" });

			// The stream requests this page makes, and how each one ended (the reload
			// aborts the first). Collected from the first moment: an event that comes
			// while a spec is between two awaits is never missed.
			const streamPosts: Request[] = [];
			const ended = new Set<Request>();
			page.on("request", (request) => {
				if (isStreamPost(request)) streamPosts.push(request);
			});
			page.on("requestfinished", (request) => ended.add(request));
			page.on("requestfailed", (request) => ended.add(request));

			// The reader sends; the server has the turn and the provider is holding its
			// refusal. A moment later they reload the page, which reattaches to the turn.
			await sendMessage(page, `${AI_SMOKE_REFUSE_SLOWLY_MARKER} Hello`);
			await expect.poll(() => streamPosts.length).toBe(1);
			await page.waitForTimeout(300);
			await page.reload();
			await expect
				.poll(() => streamPosts.length, {
					message:
						"the page reconnected to the turn the server is still running",
					timeout: 15_000,
				})
				.toBe(2);
			const reconnect = streamPosts[1];

			// The turn fails 1.5 s after each request the model gets; the reconnected
			// connection must hear it and end, with the reader's chat showing the failure.
			await expect
				.poll(() => ended.has(reconnect), {
					message: "the reconnect request ended",
					timeout: 45_000,
				})
				.toBe(true);
			// The reader's chat is theirs again: no turn in progress, no placeholder
			// drafting a reply that will never come, the composer offers Send, not Stop.
			await expect(page.getByTestId("stop-button")).toHaveCount(0, {
				timeout: 15_000,
			});
			await expect(page.getByTestId("send-button")).toBeVisible();
			await expect(page.getByText("Drafting response")).toHaveCount(0);
		} finally {
			await updateUserModelPreference(page, previousModelPreference);
			if (providerId) await deleteTemporaryProvider(page, providerId);
		}
	});
});
