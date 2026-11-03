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
		// The worker's server outlives this file: it must not stay draining.
		await setDraining(page, false).catch(() => undefined);
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

		// The deploy is live: the version file now names another release.
		let versionLooks = 0;
		await page.route("**/_app/version.json", async (route) => {
			versionLooks += 1;
			await route.fulfill({ json: { version: "a-newer-release" } });
		});
		turns.draining = true;
		await setDraining(page, true);
		await send(page, "And the day after?");
		await expect(page.getByTestId("awaiting-update-status")).toBeVisible();

		// The shell looks at the version within seconds of the sign (SvelteKit's own
		// poll is a minute apart) and has the notice ready; a reload now would lose
		// the message, so it is held back.
		await expect
			.poll(() => versionLooks, { timeout: 10_000 })
			.toBeGreaterThanOrEqual(1);
		await expect(page.getByTestId("awaiting-update-status")).toBeVisible();
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

	test("a reply cut off by the update says so and is not sent again by itself", async ({
		page,
	}) => {
		let calls = 0;
		await page.route("**/api/chat/stream", async (route) => {
			calls += 1;
			// Some of a reply, and then the connection ends without its terminal event.
			await route.fulfill({
				status: 200,
				headers: sseHeaders,
				body: [
					`data: ${JSON.stringify({ type: "text-start", id: "answer" })}\n\n`,
					`data: ${JSON.stringify({ type: "text-delta", id: "answer", delta: "The report begins " })}\n\n`,
				].join(""),
			});
		});
		await openEmptyChat(page);
		// The update has begun: a reply that was already running is not refused
		// for it, it is cut when the server stops.
		await setDraining(page, true);

		await send(page, "Write the report");

		// The page looks for the reply's stream, finds none, and asks whether the
		// server is being updated: it says so, and keeps what it has of the reply.
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
		await setDraining(page, false);
		await expect(page.getByText(CUT)).toBeVisible({ timeout: 20_000 });
		await expect(page.getByRole("button", { name: /retry/i })).toBeVisible();
		await expect(page.getByTestId("user-message")).toHaveCount(1);
		await expect(page.getByTestId("assistant-message")).toHaveCount(0);
		// Nothing was sent again, however long the server has been back.
		await expect(page.getByTestId("awaiting-update-status")).toHaveCount(0);
		expect(calls).toBe(1);
	});
});
