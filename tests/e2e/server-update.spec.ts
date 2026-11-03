import { expect, type Page, test } from "@playwright/test";
import {
	buildAiSdkUiStreamBody,
	createEmptyConversation,
	login,
	waitForHydration,
} from "./helpers";

// ADR-0054, "An Update During A Turn". A deploy drains the server (a new message is
// turned away) and then restarts it (the reverse proxy answers a maintenance page).
// A message sent meanwhile used to fail after four seconds with a sentence about
// the model provider, and the Refresh notice came up to a minute late. Now the
// message waits, says so, and goes when the update is done.
//
// The server is the worker's real one: `POST /api/admin/drain` (with the test's
// admin session) makes it refuse new turns exactly as a deploy does, and the real
// `/api/chat/stream` route is what answers a message sent meanwhile. The replies
// themselves are mocked at the browser, as in the other chat specs. A worker keeps
// its server from one spec file to the next, so every test puts the drain back.

const UPDATING = "AlfyAI is being updated. Waiting for it to come back…";
const CUT =
	"AlfyAI was updated while this reply was being written, so it was cut off. Press Retry to send your message again.";

async function setDraining(page: Page, draining: boolean) {
	const response = await page.request.post("/api/admin/drain", {
		data: { draining },
	});
	expect(response.ok(), `drain -> ${response.status()}`).toBe(true);
	expect(((await response.json()) as { draining: boolean }).draining).toBe(
		draining,
	);
}

/** An empty chat, open and hydrated, with the composer ready. */
async function openEmptyChat(page: Page) {
	const conversationId = await createEmptyConversation(page);
	await page.goto(`/chat/${conversationId}`, { waitUntil: "domcontentloaded" });
	await waitForHydration(page);
	await expect(page.getByTestId("message-input")).toBeEnabled({
		timeout: 15_000,
	});
	return conversationId;
}

async function send(page: Page, text: string) {
	await page.getByTestId("message-input").fill(text);
	await expect(page.getByTestId("send-button")).toBeEnabled();
	await page.getByTestId("send-button").click();
}

const sseHeaders = {
	"Content-Type": "text/event-stream",
	"Cache-Control": "no-cache",
};

/**
 * Answers the page's turns with `reply`, except while `state.draining` is set,
 * when the request goes on to the real server, which refuses it as a draining
 * server does. `calls` counts every request the page made.
 */
async function answerTurns(page: Page, reply: string) {
	const state = { draining: false, calls: 0 };
	await page.route("**/api/chat/stream", async (route) => {
		state.calls += 1;
		if (state.draining) {
			await route.continue();
			return;
		}
		await route.fulfill({
			status: 200,
			headers: sseHeaders,
			body: buildAiSdkUiStreamBody(reply),
		});
	});
	return state;
}

test.describe("An update during a turn", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test.afterEach(async ({ page }) => {
		// The worker's server outlives this file: it must not stay draining, and a
		// put-back that fails fails this test (setDraining asserts the answer), so the
		// next file does not meet a server that turns its messages away.
		await setDraining(page, false);
	});

	test("a message sent while the server drains waits and says so, and Stop returns the words", {
		tag: "@smoke",
	}, async ({ page }) => {
		await openEmptyChat(page);
		await setDraining(page, true);

		await send(page, "Is it going to rain?");

		// The real server refused it as a draining server does; the page does not
		// count down three tries and blame the provider, it waits and says so.
		await expect(page.getByTestId("awaiting-update-status")).toHaveText(
			UPDATING,
		);
		await expect(page.getByTestId("server-draining-notice")).toBeVisible();
		await expect(page.getByRole("button", { name: /retry/i })).toHaveCount(0);
		await expect(page.getByTestId("user-message")).toHaveCount(1);

		// Stop ends the wait: the message never reached the server, so its bubble
		// goes and its words are back in the composer.
		await page.getByTestId("stop-button").click();
		await expect(page.getByTestId("message-input")).toHaveValue(
			"Is it going to rain?",
		);
		await expect(page.getByTestId("user-message")).toHaveCount(0);
		await expect(page.getByTestId("awaiting-update-status")).toHaveCount(0);
		await expect(page.getByRole("button", { name: /retry/i })).toHaveCount(0);
	});

	test("a message sent while the server drains is sent by itself when the update is done", async ({
		page,
	}) => {
		const turns = await answerTurns(page, "It will stay dry all day");
		await openEmptyChat(page);
		await send(page, "And tomorrow?");
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"It will stay dry all day",
			{ timeout: 20_000 },
		);

		// The update begins, with the page open and nothing else happening on it.
		turns.draining = true;
		await setDraining(page, true);
		await send(page, "And the day after?");

		await expect(page.getByTestId("awaiting-update-status")).toHaveText(
			UPDATING,
		);
		// The shell was told, and shows the banner without a reload or a focus.
		await expect(page.getByTestId("server-draining-notice")).toBeVisible();
		await expect(page.getByTestId("user-message")).toHaveCount(2);
		await expect(page.getByRole("button", { name: /retry/i })).toHaveCount(0);

		// The update is done: the same message goes by itself, with no press.
		turns.draining = false;
		await setDraining(page, false);
		await expect(page.getByTestId("assistant-message").nth(1)).toContainText(
			"It will stay dry all day",
			{ timeout: 20_000 },
		);
		await expect(page.getByTestId("awaiting-update-status")).toHaveCount(0);
		await expect(page.getByRole("button", { name: /retry/i })).toHaveCount(0);
		await expect(page.getByTestId("user-message")).toHaveCount(2);
		await expect(page.getByTestId("assistant-message")).toHaveCount(2);
		// The first message, the refusal, and the same message again.
		expect(turns.calls).toBe(3);
		// And the banner goes once the server is not draining.
		await expect(page.getByTestId("server-draining-notice")).toHaveCount(0, {
			timeout: 15_000,
		});
	});

	test("the Refresh notice waits for a message that waits for the update, and comes up within seconds of it", async ({
		page,
	}) => {
		const turns = await answerTurns(page, "It will stay dry all day");
		await openEmptyChat(page);
		await send(page, "And tomorrow?");
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"It will stay dry all day",
			{ timeout: 20_000 },
		);

		turns.draining = true;
		await setDraining(page, true);
		await send(page, "And the day after?");
		await expect(page.getByTestId("awaiting-update-status")).toBeVisible();
		// The shell's watch has looked at the draining server: its banner is up.
		await expect(page.getByTestId("server-draining-notice")).toBeVisible();
		await expect(page.getByTestId("server-update-notice")).toHaveCount(0);

		// The deploy is live: the version file now names another release.
		await page.route("**/_app/version.json", (route) =>
			route.fulfill({ json: { version: "a-newer-release" } }),
		);

		// The watch asks for the version every few seconds, and it ends on the first
		// look that finds a new one, which takes its draining banner down. So the
		// banner going is the sign that the version was read and the shell has its
		// notice ready (the layout sets it before the watch ends), and the check
		// below is a real one: if the notice were not held it would be on the screen
		// in the same frame as the banner leaves.
		await expect(page.getByTestId("server-draining-notice")).toHaveCount(0, {
			timeout: 15_000,
		});
		await expect(page.getByTestId("awaiting-update-status")).toBeVisible();
		// A reload now would lose the message, so the notice is held back.
		await expect(page.getByTestId("server-update-notice")).toHaveCount(0);

		// The message goes, and the notice comes up as soon as nothing waits.
		turns.draining = false;
		await setDraining(page, false);
		await expect(page.getByTestId("server-update-notice")).toBeVisible({
			timeout: 20_000,
		});
		await expect(page.getByTestId("assistant-message").nth(1)).toContainText(
			"It will stay dry all day",
		);
		await expect(page.getByTestId("awaiting-update-status")).toHaveCount(0);
	});

	test("the Refresh notice waits for the words of a chat that was left, and comes up once they have reached the server", async ({
		page,
	}) => {
		// The restart answers the draft's save with the proxy's page, as it answers
		// everything: the words a waiting message left behind are in no other place.
		let serverIsAway = true;
		const draftSaves: string[] = [];
		await page.route("**/api/conversations/*/draft", async (route) => {
			const request = route.request();
			if (request.method() !== "PUT") {
				await route.continue();
				return;
			}
			draftSaves.push(
				(JSON.parse(request.postData() ?? "{}") as { draftText: string })
					.draftText,
			);
			if (serverIsAway) {
				await route.fulfill({
					status: 503,
					contentType: "text/html",
					body: "<html><body>Back soon</body></html>",
				});
				return;
			}
			await route.continue();
		});
		await openEmptyChat(page);
		await setDraining(page, true);
		await send(page, "Words that wait");
		await expect(page.getByTestId("awaiting-update-status")).toBeVisible();
		await expect(page.getByTestId("server-draining-notice")).toBeVisible();

		// The person goes Home, client side: the waiting message is saved as the chat's
		// draft, and the save meets the restart.
		await page.getByTestId("new-conversation").click();
		await expect(page).toHaveURL("/");
		await expect.poll(() => draftSaves.length).toBeGreaterThan(0);

		// The deploy is live. The banner going is the sign that the version was read.
		await page.route("**/_app/version.json", (route) =>
			route.fulfill({ json: { version: "a-newer-release" } }),
		);
		await expect(page.getByTestId("server-draining-notice")).toHaveCount(0, {
			timeout: 15_000,
		});
		// A reload now would lose the words, which have not reached the server: the
		// save is sent again every few seconds, and the notice is held back.
		await expect
			.poll(() => draftSaves.length, { timeout: 15_000 })
			.toBeGreaterThan(1);
		await expect(page.getByTestId("server-update-notice")).toHaveCount(0);

		// The server is back: the save lands, and the notice comes up.
		serverIsAway = false;
		await expect(page.getByTestId("server-update-notice")).toBeVisible({
			timeout: 20_000,
		});
		expect(new Set(draftSaves)).toEqual(new Set(["Words that wait"]));
	});

	test("the proxy's maintenance page is waited out the same way", async ({
		page,
	}) => {
		let calls = 0;
		await page.route("**/api/chat/stream", async (route) => {
			calls += 1;
			if (calls === 1) {
				// Apache's page for a backend that is away: a 503 with HTML.
				await route.fulfill({
					status: 503,
					headers: { "Content-Type": "text/html" },
					body: "<html><body>AlfyAI is being updated</body></html>",
				});
				return;
			}
			await route.fulfill({
				status: 200,
				headers: sseHeaders,
				body: buildAiSdkUiStreamBody("Back again"),
			});
		});
		await openEmptyChat(page);

		await send(page, "Anybody there?");

		await expect(page.getByTestId("awaiting-update-status")).toHaveText(
			UPDATING,
		);
		await expect(page.getByRole("button", { name: /retry/i })).toHaveCount(0);
		// The server answers its health route (it is the real one), so the message
		// goes again at the next look.
		await expect(page.getByTestId("assistant-message").first()).toContainText(
			"Back again",
			{ timeout: 20_000 },
		);
		expect(calls).toBe(2);
		await expect(page.getByRole("button", { name: /retry/i })).toHaveCount(0);
	});

	// A reply is cut when the connection fails: some of the reply, and then the
	// stream ends without its terminal event.
	async function cutEveryReply(page: Page) {
		const state = { calls: 0 };
		await page.route("**/api/chat/stream", async (route) => {
			state.calls += 1;
			await route.fulfill({
				status: 200,
				headers: sseHeaders,
				body: [
					`data: ${JSON.stringify({ type: "text-start", id: "answer" })}\n\n`,
					`data: ${JSON.stringify({ type: "text-delta", id: "answer", delta: "The report begins " })}\n\n`,
				].join(""),
			});
		});
		return state;
	}

	test("a reply cut off by the restart says so and is not sent again by itself", async ({
		page,
	}) => {
		const stream = await cutEveryReply(page);
		// The restart: the app process is away, and Apache answers its own 503 page for
		// the health route too. That, and not a lost connection, is what says it.
		const restart = { on: false };
		await page.route("**/api/health", async (route) => {
			if (!restart.on) {
				await route.continue();
				return;
			}
			await route.fulfill({
				status: 503,
				headers: { "Content-Type": "text/html" },
				body: "<html><body>AlfyAI is being updated</body></html>",
			});
		});
		await openEmptyChat(page);
		restart.on = true;

		await send(page, "Write the report");

		// The page looks for the reply's stream, finds none, and asks what the server
		// is doing: the proxy answers for it, so the restart cut the reply. It waits,
		// and keeps what it has of the reply.
		await expect(page.getByTestId("awaiting-update-status")).toHaveText(
			UPDATING,
			{ timeout: 20_000 },
		);
		await expect(page.getByTestId("assistant-message")).toContainText(
			"The report begins",
		);
		await expect(page.getByRole("button", { name: /retry/i })).toHaveCount(0);

		// The server is back and holds nothing of the turn: the sentence for it,
		// and Retry, which is the person's to press.
		restart.on = false;
		await expect(page.getByText(CUT)).toBeVisible({ timeout: 20_000 });
		await expect(page.getByRole("button", { name: /retry/i })).toBeVisible();
		await expect(page.getByTestId("user-message")).toHaveCount(1);
		await expect(page.getByTestId("assistant-message")).toHaveCount(0);
		// Nothing was sent again, however long the server has been back.
		await expect(page.getByTestId("awaiting-update-status")).toHaveCount(0);
		expect(stream.calls).toBe(1);
	});

	// The server is only getting ready to restart: the old process is alive, finishes
	// the replies it runs and answers its health route. A connection that failed
	// meanwhile did not end the turn, so there is nothing to wait for: the page looks
	// for the reply's stream and, finding none, asks the server what it holds.
	test("a reply cut off while the server only drains is not waited for", async ({
		page,
	}) => {
		const stream = await cutEveryReply(page);
		await openEmptyChat(page);
		await setDraining(page, true);

		await send(page, "Write the report");

		// Retry is on the screen within seconds. Had the page waited for an update
		// it would be on the screen eight minutes from now, and the server is still
		// draining.
		await expect(page.getByRole("button", { name: /retry/i })).toBeVisible({
			timeout: 20_000,
		});
		// The error it always was, not the sentence for an update.
		await expect(
			page.getByText(/model provider returned an error/i),
		).toBeVisible();
		await expect(page.getByText(CUT)).toHaveCount(0);
		await expect(page.getByTestId("awaiting-update-status")).toHaveCount(0);
		await expect(page.getByTestId("user-message")).toHaveCount(1);
		expect(stream.calls).toBe(1);
	});

	// A phone that lost its signal looks like a restart to a reply that was running,
	// and it is not one.
	test("a reply cut off by a lost connection is not taken for an update", async ({
		page,
	}) => {
		const stream = await cutEveryReply(page);
		// The health route cannot be reached either, as when the phone has no signal.
		const offline = { on: false };
		await page.route("**/api/health", async (route) => {
			if (offline.on) {
				await route.abort("connectionfailed");
				return;
			}
			await route.continue();
		});
		await openEmptyChat(page);
		offline.on = true;

		await send(page, "Write the report");

		await expect(page.getByRole("button", { name: /retry/i })).toBeVisible({
			timeout: 20_000,
		});
		await expect(page.getByText(CUT)).toHaveCount(0);
		await expect(page.getByTestId("awaiting-update-status")).toHaveCount(0);
		expect(stream.calls).toBe(1);
	});
});
