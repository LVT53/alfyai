import { expect, type Locator, type Page, test } from "@playwright/test";
import {
	AI_SMOKE_ASK_AFTER_PREFIX,
	AI_SMOKE_ASK_CALL_ID,
	AI_SMOKE_ASK_INTRO,
	AI_SMOKE_ASK_READ_BODY,
	AI_SMOKE_ASK_READ_CALL_ID,
	AI_SMOKE_ASK_READ_TAIL,
	AI_SMOKE_ASK_SECOND_CALL_ID,
	AI_SMOKE_ASK_SECOND_INTRO,
	type AskTurnMode,
	askTurnMessage,
} from "../fixtures/ai/chat-turn-scenarios";
import {
	type CapturedOpenAICompatibleRequest,
	createOpenAICompatibleProviderHarness,
	type OpenAICompatibleProviderHarness,
} from "../mocks/ai-provider/openai-compatible-provider";
import {
	createTemporaryFakeProviderModel,
	deleteTemporaryProvider,
	snapshotUserModelPreference,
	updateUserModelPreference,
} from "./artifact-live-edit.helpers";
import { setLanguage } from "./chat-item-turn-helpers";
import {
	createEmptyConversation,
	expectTopmost,
	login,
	sendMessage,
	waitForHydration,
	waitForStableBoundingBox,
} from "./helpers";

// "Ask me first" in a real browser (docs/plans/ask-me-first, design section 10): Alfy
// stops a reply to ask, the person answers on the card, and the same reply carries on.
// The model is scripted (tests/mocks/ai-provider/chat-turn-scripts.ts, `askTurnReply`);
// the page, the routes and the resume are the production build's own. Driven the way a
// reader does it: look at the card, press an answer, watch the reply go on.

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const SMALL_PHONE = { width: 360, height: 740 };

/** One message of a chat request, as the provider received it. */
type WireMessage = {
	role: string;
	content?: unknown;
	tool_call_id?: string;
	tool_calls?: Array<{ id?: string; function?: { name?: string } }>;
};

function wireMessages(request: CapturedOpenAICompatibleRequest): WireMessage[] {
	const body = request.body as { messages?: WireMessage[] } | undefined;
	return Array.isArray(body?.messages) ? body.messages : [];
}

/** A message's text, whether the provider got it as a string or as parts. */
function wireText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) =>
			part &&
			typeof part === "object" &&
			typeof (part as { text?: unknown }).text === "string"
				? (part as { text: string }).text
				: "",
		)
		.join("");
}

/**
 * The chat's own model calls: the requests that carry the tool catalogue (Ruling 39).
 * The title, the status line and the other internal calls go to the same provider
 * without tools, and are not what these tests count.
 */
function chatRequests(provider: OpenAICompatibleProviderHarness) {
	return provider.requests().filter((request) => {
		const body = request.body as { tools?: unknown } | undefined;
		return (
			request.method === "POST" &&
			request.path === "/v1/chat/completions" &&
			Array.isArray(body?.tools) &&
			body.tools.length > 0
		);
	});
}

/** What the model was told in answer to the ask call `callId`: the JSON of the tool message that carries it. */
function answerTo(
	request: CapturedOpenAICompatibleRequest,
	callId: string,
): unknown {
	const message = wireMessages(request).find(
		(candidate) =>
			candidate.role === "tool" && candidate.tool_call_id === callId,
	);
	expect(
		message,
		`the request holds a tool message for ${callId}`,
	).toBeTruthy();
	return JSON.parse(wireText(message?.content));
}

/**
 * The request is the continuation of the reply that asked, and not its history: after
 * the person's message come the assistant message that said `intro` and made the ask
 * call, and, last of all, the tool message with the answer.
 */
function expectContinuation(
	request: CapturedOpenAICompatibleRequest,
	expected: { callId: string; intro: string; personsMessage: string },
) {
	const messages = wireMessages(request);
	const answer = messages.at(-1);
	const asking = messages.at(-2);
	expect(answer?.role).toBe("tool");
	expect(answer?.tool_call_id).toBe(expected.callId);
	expect(asking?.role).toBe("assistant");
	expect(wireText(asking?.content)).toContain(expected.intro);
	expect(asking?.tool_calls?.map((call) => call.id)).toEqual([expected.callId]);
	expect(asking?.tool_calls?.[0]?.function?.name).toBe("ask_user");
	const persons = messages.findLastIndex((message) => message.role === "user");
	expect(persons, "the person's message is in the request").toBeGreaterThan(-1);
	expect(wireText(messages[persons].content)).toContain(
		expected.personsMessage,
	);
	expect(persons, "the continuation follows the person's message").toBeLessThan(
		messages.length - 2,
	);
}

/** Runs the scripted turn up to the point where the model sent its ask. */
async function startAskTurn(
	page: Page,
	fakeProviderBaseURL: string,
	mode: AskTurnMode,
	options: { viewport?: { width: number; height: number } } = {},
) {
	await page.setViewportSize(options.viewport ?? DESKTOP);
	await login(page);
	const previousModelPreference = await snapshotUserModelPreference(page);
	const provider = await createTemporaryFakeProviderModel(
		page,
		fakeProviderBaseURL,
	);
	const restore = async () => {
		await updateUserModelPreference(page, previousModelPreference);
		await deleteTemporaryProvider(page, provider.providerId);
	};
	try {
		await updateUserModelPreference(page, provider.selectedModel);
		const conversationId = await createEmptyConversation(page);
		await page.goto(`/chat/${conversationId}`, { waitUntil: "networkidle" });
		await waitForHydration(page);
		await sendMessage(page, askTurnMessage(mode));
		return { conversationId, restore };
	} catch (error) {
		await restore();
		throw error;
	}
}

/**
 * The top edge of `element` in the thread's content: where it is on the screen, less where
 * the thread's view starts, plus how far the thread is scrolled. It runs in the page (it is
 * handed to `evaluate`), so it names nothing outside itself.
 */
function topInThread(element: Element): number {
	const view = element.closest(".scroll-container") as HTMLElement;
	return (
		element.getBoundingClientRect().top -
		view.getBoundingClientRect().top +
		view.scrollTop
	);
}

/** `topInThread` of the element `locator` finds. */
async function topInThreadOf(locator: Locator): Promise<number> {
	return locator.evaluate(topInThread);
}

/**
 * From now on, every animation frame, the top edge in the thread's content of the
 * paragraph that starts with `text`; null in a frame where it is not there. The same
 * measure as `topInThread`, written out because a function cannot be handed to a callback
 * that runs in the page.
 */
async function recordTopsInThreadOf(page: Page, text: string) {
	await page.evaluate((start) => {
		const tops: Array<number | null> = [];
		(window as unknown as { __tops: Array<number | null> }).__tops = tops;
		const tick = () => {
			const paragraph = [
				...document.querySelectorAll('[data-testid="assistant-message"] p'),
			].find((candidate) => candidate.textContent?.startsWith(start));
			if (!paragraph) {
				tops.push(null);
			} else {
				const view = paragraph.closest(".scroll-container") as HTMLElement;
				tops.push(
					paragraph.getBoundingClientRect().top -
						view.getBoundingClientRect().top +
						view.scrollTop,
				);
			}
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	}, text);
}

async function readTops(page: Page): Promise<Array<number | null>> {
	return page.evaluate(
		() => (window as unknown as { __tops: Array<number | null> }).__tops,
	);
}

/**
 * The chevron of a folded line, the sign that the line opens. Nothing but its class names
 * it: the icon is decorative (`aria-hidden`, no test id). A count of 0 on a line that cannot
 * be opened means something only next to a count of 1 on one that can: check both.
 */
function chevronOf(folded: Locator): Locator {
	return folded.locator(".act-chevron");
}

/** How far the thread's view is from the bottom of the thread, in px. */
function distanceFromBottom(page: Page): Promise<number> {
	return page
		.locator(".scroll-container")
		.evaluate((view) => view.scrollHeight - view.scrollTop - view.clientHeight);
}

/** The card Alfy asked on: an article named for its question (or for the count of its questions). */
function askCard(page: Page, name = "Alfy's question"): Locator {
	return page.getByRole("article", { name });
}

/** Presses an answer, once the card has woken: its answers are off for a moment after it appears. */
async function pressWhenAwake(control: Locator) {
	await expect(control).toBeEnabled();
	await control.click();
}

/** The model has carried the reply on with `words` (what the script says after an answer), in the last segment. */
async function expectCarriedOn(page: Page, words: string) {
	await expect(
		page
			.getByTestId("assistant-message")
			.last()
			.getByText(`${AI_SMOKE_ASK_AFTER_PREFIX}${words}`),
	).toBeVisible({ timeout: 30_000 });
}

/** Waits for the reply to end: the stop button is gone and the composer takes words again. */
async function expectReplyEnded(page: Page) {
	await expect(page.getByTestId("stop-button")).toHaveCount(0, {
		timeout: 30_000,
	});
	await expect(page.getByTestId("message-input")).toBeEnabled();
}

test.describe("Alfy asks first, and the answer carries the reply on", () => {
	const fakeProvider = createOpenAICompatibleProviderHarness();
	let restoreTurn: (() => Promise<void>) | null = null;

	async function startTurn(
		page: Page,
		mode: AskTurnMode,
		options: { viewport?: { width: number; height: number } } = {},
	) {
		const turn = await startAskTurn(page, fakeProvider.baseURL, mode, options);
		restoreTurn = turn.restore;
		return turn;
	}

	test.beforeAll(async () => {
		await fakeProvider.start();
	});
	test.afterAll(async () => {
		await fakeProvider.stop();
	});
	test.beforeEach(async () => {
		await fakeProvider.reset();
	});
	test.afterEach(async () => {
		try {
			await restoreTurn?.();
		} finally {
			restoreTurn = null;
			await setLanguage("en");
		}
	});

	test("a click on an answer carries the same reply on", {
		tag: "@smoke",
	}, async ({ page }) => {
		await startTurn(page, "one");

		// The card: Alfy's question, the answers it offers, and the ways out.
		const card = askCard(page);
		await expect(card).toBeVisible({ timeout: 30_000 });
		await expect(card.getByText("Which way should we take it?")).toBeVisible();
		await expect(card.getByTestId("ask-option")).toHaveCount(3);
		await expect(
			card.getByRole("button", { name: "A party at home, recommended" }),
		).toBeVisible();
		await expect(
			card.getByRole("button", { name: "Dinner out, just close family" }),
		).toBeVisible();
		await expect(
			card.getByRole("button", { name: "A weekend away together" }),
		).toBeVisible();
		await expect(
			card.getByText("Easiest to organise, and the whole family can come"),
		).toBeVisible();
		// One answer carries the mark, and it is the first.
		await expect(card.getByText("Recommended", { exact: true })).toHaveCount(1);
		await expect(
			card.getByTestId("ask-option").first().getByText("Recommended"),
		).toBeVisible();
		await expect(
			card.getByRole("button", { name: "Type my own..." }),
		).toBeVisible();
		await expect(card.getByRole("button", { name: "Up to you" })).toBeVisible();
		await expect(
			card.getByRole("button", { name: "Close the question" }),
		).toBeVisible();
		// The words Alfy wrote before it asked are above the card, and the composer waits.
		await expect(page.getByText(AI_SMOKE_ASK_INTRO)).toBeVisible();
		await expect(page.getByTestId("message-input")).toBeDisabled();
		// This card fits the window, so the thread rests at its bottom, as it always did:
		// the end of the thread is the top of the card only when the card does not fit
		// (the phone and Hungarian tests).
		await expect.poll(() => distanceFromBottom(page)).toBeLessThan(2);

		// The press (answers wake after 400 ms).
		await pressWhenAwake(
			card.getByRole("button", { name: "A party at home, recommended" }),
		);

		// The card folds into a line that says what was asked and what was answered.
		const folded = page.getByTestId("ask-folded");
		await expect(folded).toContainText("Which way should we take it?");
		await expect(folded).toContainText("A party at home");
		await expect(card).toHaveCount(0);
		// An answered line opens, and shows its chevron: the control for the closed line,
		// which does neither (the X test).
		await expect(folded.getByRole("button", { expanded: false })).toHaveCount(
			1,
		);
		await expect(chevronOf(folded)).toHaveCount(1);

		// The reply carries on below the line, as the same reply.
		const segments = page.getByTestId("assistant-message");
		await expectCarriedOn(page, "A party at home");
		await expect(segments).toHaveCount(2);
		await expect(segments.first()).toContainText(AI_SMOKE_ASK_INTRO);
		await expect(segments.first().getByTestId("ask-folded")).toBeVisible();
		await expectReplyEnded(page);

		// One action row for the whole reply, at its end.
		const regenerate = page.getByRole("button", {
			name: "Regenerate response",
		});
		await expect(regenerate).toHaveCount(1);
		const carriedText = segments
			.last()
			.getByText(`${AI_SMOKE_ASK_AFTER_PREFIX}A party at home`);
		await waitForStableBoundingBox(carriedText);
		await waitForStableBoundingBox(regenerate);
		await waitForStableBoundingBox(folded.getByTestId("tool-activity-row"));
		const carriedBox = await carriedText.boundingBox();
		const regenerateBox = await regenerate.boundingBox();
		expect(carriedBox && regenerateBox, "both are laid out").toBeTruthy();
		expect(regenerateBox?.y).toBeGreaterThan(carriedBox?.y ?? 0);

		// The words that carry on sit right under what the asking segment drew last, as
		// one reply: about 16 to 18 px, the two paddings of the rows (the paddings and the
		// gap between rows would have left 58). The last thing is its folded line, or the
		// Sources row under it: a turn with evidence draws that row below the line
		// (Ruling 25), and the e2e user's turns all have some. Both edges are read in one
		// go, after the waits above, so that no layout change can fall between the reads.
		const { carriedTop, askingEnd } = await carriedText.evaluate((words) => {
			const [asking] = document.querySelectorAll(
				'[data-testid="assistant-message"]',
			);
			return {
				carriedTop: words.getBoundingClientRect().top,
				askingEnd: asking?.lastElementChild?.getBoundingClientRect().bottom,
			};
		});
		expect(askingEnd, "the asking segment draws something last").toBeTruthy();
		const gap = carriedTop - (askingEnd ?? 0);
		expect(
			gap,
			"px between the asking segment and the words that carry on",
		).toBeGreaterThanOrEqual(0);
		expect(
			gap,
			"px between the asking segment and the words that carry on",
		).toBeLessThan(30);

		// The model got the reply so far and the answer: two chat requests.
		await expect.poll(() => chatRequests(fakeProvider).length).toBe(2);
		const [first, resume] = chatRequests(fakeProvider);
		expect(wireMessages(first).at(-1)?.role).toBe("user");
		expect(answerTo(resume, AI_SMOKE_ASK_CALL_ID)).toMatchObject({
			status: "answered",
			answers: [
				{
					question: "Which way should we take it?",
					picked: ["A party at home"],
				},
			],
		});
		expectContinuation(resume, {
			callId: AI_SMOKE_ASK_CALL_ID,
			intro: AI_SMOKE_ASK_INTRO,
			personsMessage: askTurnMessage("one"),
		});
	});

	test("the reply carries on with everything Alfy read before it asked", async ({
		page,
	}) => {
		// The premise: the Document ends in a sentence a digest of the read would have cut.
		expect(
			AI_SMOKE_ASK_READ_BODY.indexOf(AI_SMOKE_ASK_READ_TAIL),
		).toBeGreaterThan(1_500);

		await startTurn(page, "read");
		const card = askCard(page);
		await expect(card).toBeVisible({ timeout: 30_000 });
		await pressWhenAwake(
			card.getByRole("button", { name: "A party at home, recommended" }),
		);
		await expectCarriedOn(page, "A party at home");
		await expectReplyEnded(page);

		// Create, read, ask, and the resume: four chat requests. The resume holds the read
		// whole, down to the sentence that ends the Document.
		await expect.poll(() => chatRequests(fakeProvider).length).toBe(4);
		const resume = chatRequests(fakeProvider).at(-1);
		expect(resume, "the resume request").toBeTruthy();
		const read = wireMessages(resume as CapturedOpenAICompatibleRequest).find(
			(message) =>
				message.role === "tool" &&
				message.tool_call_id === AI_SMOKE_ASK_READ_CALL_ID,
		);
		expect(read, "the resume carries the result of the read").toBeTruthy();
		const readText = wireText(read?.content);
		expect(readText).toContain(AI_SMOKE_ASK_READ_TAIL);
		expect(
			readText.length,
			"the whole read, not a digest of it",
		).toBeGreaterThan(1_500);
		expect(
			answerTo(resume as CapturedOpenAICompatibleRequest, AI_SMOKE_ASK_CALL_ID),
		).toMatchObject({
			status: "answered",
			answers: [{ picked: ["A party at home"] }],
		});
	});

	test("letters typed with nothing focused go into the card's own line, and Enter sends them", async ({
		page,
	}) => {
		const words = "Smaller, maybe a picnic by the lake";
		await startTurn(page, "one");
		const card = askCard(page);
		await expect(card).toBeVisible({ timeout: 30_000 });
		// The keys are the card's once it has woken; the composer may hold the focus until then.
		await expect(card.getByTestId("ask-up-to-you")).toBeEnabled();
		await page.evaluate(() =>
			(document.activeElement as HTMLElement | null)?.blur(),
		);
		await expect(page.locator("body")).toBeFocused();

		await page.keyboard.type(words);

		const line = card.getByTestId("ask-own-input");
		await expect(line).toHaveValue(words);
		await expect(line).toBeFocused();
		await expect(page.getByTestId("message-input")).toHaveValue("");

		await page.keyboard.press("Enter");

		await expect(page.getByTestId("ask-folded")).toContainText(`“${words}”`);
		await expect(card).toHaveCount(0);
		await expectCarriedOn(page, words);
		await expectReplyEnded(page);
		// What was typed went to the card and nowhere else.
		await expect(page.getByTestId("message-input")).toHaveValue("");
		await expect.poll(() => chatRequests(fakeProvider).length).toBe(2);
		expect(
			answerTo(chatRequests(fakeProvider)[1], AI_SMOKE_ASK_CALL_ID),
		).toMatchObject({
			status: "answered",
			answers: [{ question: "Which way should we take it?", ownWords: words }],
		});
	});

	test("Up to you leaves the choice to Alfy", async ({ page }) => {
		await startTurn(page, "one");
		const card = askCard(page);
		await expect(card).toBeVisible({ timeout: 30_000 });
		await pressWhenAwake(card.getByRole("button", { name: "Up to you" }));

		const folded = page.getByTestId("ask-folded");
		await expect(folded).toContainText("Which way should we take it?");
		await expect(folded).toContainText("A party at home");
		await expect(folded).toContainText("· left to Alfy");
		await expect(card).toHaveCount(0);
		await expectCarriedOn(page, "left to me");
		await expectReplyEnded(page);
		await expect.poll(() => chatRequests(fakeProvider).length).toBe(2);
		expect(
			answerTo(chatRequests(fakeProvider)[1], AI_SMOKE_ASK_CALL_ID),
		).toMatchObject({
			status: "left_to_you",
			answers: [
				{
					question: "Which way should we take it?",
					recommended: ["A party at home"],
				},
			],
		});
	});

	test("the X closes the question and the reply carries on", async ({
		page,
	}) => {
		await startTurn(page, "one");
		const card = askCard(page);
		await expect(card).toBeVisible({ timeout: 30_000 });
		await pressWhenAwake(
			card.getByRole("button", { name: "Close the question" }),
		);

		// A closed question has nothing to open: a muted X, "closed", and no chevron (an
		// answered line has one, as the first test checks).
		const folded = page.getByTestId("ask-folded");
		await expect(folded).toContainText("Which way should we take it?");
		await expect(folded).toContainText("· closed");
		await expect(card).toHaveCount(0);
		await expect(folded.getByRole("button")).toHaveCount(0);
		await expect(chevronOf(folded)).toHaveCount(0);

		await expectCarriedOn(page, "closed");
		await expectReplyEnded(page);
		await expect.poll(() => chatRequests(fakeProvider).length).toBe(2);
		const closed = answerTo(
			chatRequests(fakeProvider)[1],
			AI_SMOKE_ASK_CALL_ID,
		);
		expect(closed).toMatchObject({ status: "closed" });
		expect((closed as { note: string }).note).toContain("closed the question");
	});

	test("a card of several questions needs Send", async ({ page }) => {
		const ownWords = "One list, with a section for the kids' things";
		await startTurn(page, "many");
		const card = askCard(page, "Alfy's questions (2)");
		await expect(card).toBeVisible({ timeout: 30_000 });
		await expect(card.getByTestId("ask-question")).toHaveCount(2);
		await expect(card.getByText("Pick any")).toBeVisible();
		const send = card.getByTestId("ask-send");
		await expect(card.getByTestId("ask-up-to-you")).toBeEnabled();
		await expect(send).toBeDisabled();

		// The first question takes any number of picks, and one question answered is not a card answered.
		await card.getByRole("checkbox", { name: "Adults" }).click();
		await card.getByRole("checkbox", { name: "Kids" }).click();
		await expect(card.getByRole("checkbox", { name: "Adults" })).toBeChecked();
		await expect(card.getByRole("checkbox", { name: "Kids" })).toBeChecked();
		await expect(send).toBeDisabled();

		// The second is answered in the person's own words.
		const second = card.getByTestId("ask-question").nth(1);
		await second.getByTestId("ask-own-row").click();
		await second.getByTestId("ask-own-input").fill(ownWords);
		await expect(send).toBeEnabled();
		await send.click();

		const folded = page.getByTestId("ask-folded");
		await expect(folded).toContainText("2 questions");
		await expect(folded).toContainText(`Adults, Kids · “${ownWords}”`);
		await expect(card).toHaveCount(0);

		// A press opens both questions with their answers.
		await folded.getByTestId("tool-activity-row").click();
		const body = folded.getByTestId("tool-activity-body");
		await expect(body.locator("dt")).toHaveText([
			"Who's coming?",
			"How should the list be split?",
		]);
		await expect(body.locator("dd")).toHaveText([
			"Adults, Kids",
			`“${ownWords}”`,
		]);

		await expectCarriedOn(page, `Adults, Kids; ${ownWords}`);
		await expectReplyEnded(page);
		await expect.poll(() => chatRequests(fakeProvider).length).toBe(2);
		expect(
			answerTo(chatRequests(fakeProvider)[1], AI_SMOKE_ASK_CALL_ID),
		).toMatchObject({
			status: "answered",
			answers: [
				{ question: "Who's coming?", picked: ["Adults", "Kids"] },
				{ question: "How should the list be split?", ownWords },
			],
		});
	});

	test("Alfy asks again later in the same reply, under the first folded line", async ({
		page,
	}) => {
		await startTurn(page, "twice");
		const first = askCard(page);
		await expect(first).toBeVisible({ timeout: 30_000 });
		await pressWhenAwake(
			first.getByRole("button", { name: "A party at home, recommended" }),
		);

		// The second card comes under the first folded line, with the words that lead to it.
		await expect(page.getByText("Inside or in the garden?")).toBeVisible({
			timeout: 30_000,
		});
		await expect(page.getByText(AI_SMOKE_ASK_SECOND_INTRO)).toBeVisible();
		await expect(page.getByTestId("ask-folded")).toHaveCount(1);
		const secondCard = askCard(page);
		await expect(secondCard).toHaveCount(1);
		await waitForStableBoundingBox(secondCard);
		const foldedBox = await page.getByTestId("ask-folded").boundingBox();
		const secondBox = await secondCard.boundingBox();
		expect(foldedBox && secondBox, "both are laid out").toBeTruthy();
		expect(secondBox?.y).toBeGreaterThan(
			(foldedBox?.y ?? 0) + (foldedBox?.height ?? 0) - 1,
		);

		await pressWhenAwake(
			secondCard.getByRole("button", {
				name: "In the garden, with a tent, recommended",
			}),
		);
		await expectCarriedOn(page, "In the garden, with a tent");
		await expectReplyEnded(page);

		// Two folded lines, no card left, and one reply: one message of the person, one action row.
		await expect(page.getByTestId("ask-folded")).toHaveCount(2);
		await expect(page.getByTestId("ask-card")).toHaveCount(0);
		await expect(page.getByTestId("user-message")).toHaveCount(1);
		await expect(
			page.getByRole("button", { name: "Regenerate response" }),
		).toHaveCount(1);

		// Each answer travelled with the reply so far.
		await expect.poll(() => chatRequests(fakeProvider).length).toBe(3);
		const [, afterFirst, afterSecond] = chatRequests(fakeProvider);
		expectContinuation(afterFirst, {
			callId: AI_SMOKE_ASK_CALL_ID,
			intro: AI_SMOKE_ASK_INTRO,
			personsMessage: askTurnMessage("twice"),
		});
		expectContinuation(afterSecond, {
			callId: AI_SMOKE_ASK_SECOND_CALL_ID,
			intro: AI_SMOKE_ASK_SECOND_INTRO,
			personsMessage: askTurnMessage("twice"),
		});
		expect(answerTo(afterSecond, AI_SMOKE_ASK_CALL_ID)).toMatchObject({
			status: "answered",
			answers: [{ picked: ["A party at home"] }],
		});
		expect(answerTo(afterSecond, AI_SMOKE_ASK_SECOND_CALL_ID)).toMatchObject({
			status: "answered",
			answers: [
				{
					question: "Inside or in the garden?",
					picked: ["In the garden, with a tent"],
				},
			],
		});
	});

	test("the words above the card do not move when it folds or when the reply carries on", async ({
		page,
	}) => {
		// The words are measured in the thread's content, not on the screen. The view moves:
		// at 1440 x 900 the thread follows its end to show the waiting card (the words go up
		// on the screen), and when the card folds into its line the thread is shorter below
		// the view and the browser pulls the view back (they come down, 139 px in this
		// window). That is the scroll, a known item for the owner and not something this
		// spec builds away. What F16 holds is that nothing is inserted above the words, and
		// that is their place in the thread's content.
		await startTurn(page, "one");
		const card = askCard(page);
		await expect(card).toBeVisible({ timeout: 30_000 });
		const intro = page.getByText(AI_SMOKE_ASK_INTRO);
		await waitForStableBoundingBox(intro);
		const before = await topInThreadOf(intro);

		// From here to the end of the reply, every frame.
		await recordTopsInThreadOf(page, AI_SMOKE_ASK_INTRO);
		await pressWhenAwake(
			card.getByRole("button", { name: "A party at home, recommended" }),
		);
		await expectCarriedOn(page, "A party at home");
		await expectReplyEnded(page);
		await waitForStableBoundingBox(intro);
		const after = await topInThreadOf(intro);

		expect(
			Math.abs(after - before),
			"px the words above the card moved in the thread's content",
		).toBeLessThanOrEqual(1);
		const tops = (await readTops(page)).filter(
			(top): top is number => top !== null,
		);
		expect(tops.length, "frames recorded").toBeGreaterThan(0);
		expect(
			Math.max(...tops.map((top) => Math.abs(top - before))),
			"px the words moved in the worst frame",
		).toBeLessThanOrEqual(1);
	});

	test("on a phone the answers are 44 px rows and the X a 44 px target", async ({
		page,
	}) => {
		await startTurn(page, "one", { viewport: PHONE });
		const card = askCard(page);
		await expect(card).toBeVisible({ timeout: 30_000 });
		await expect(card.getByTestId("ask-up-to-you")).toBeEnabled();

		// The thread opens the card at its question: the question and the X are in view,
		// and not under the app header.
		const question = card.getByText("Which way should we take it?");
		const closeX = card.getByRole("button", { name: "Close the question" });
		await waitForStableBoundingBox(question);
		await waitForStableBoundingBox(closeX);
		await expectTopmost(question, {
			message: "the question is in view, not under the app header",
		});
		await expectTopmost(closeX, {
			message: "the X is in view, not under the app header",
		});

		// Each answer is a row of its own, as wide as the card's body inside its padding
		// (the question's block fills it) and at least 44 px high.
		const options = card.getByTestId("ask-option");
		await expect(options).toHaveCount(3);
		const block = card.getByTestId("ask-question");
		await waitForStableBoundingBox(block);
		const bodyWidth = (await block.boundingBox())?.width ?? 0;
		expect(bodyWidth, "the card's body is laid out").toBeGreaterThan(0);
		for (const row of await options.all()) {
			await waitForStableBoundingBox(row);
			const box = await row.boundingBox();
			expect(box?.height).toBeGreaterThanOrEqual(44);
			expect(
				Math.abs((box?.width ?? 0) - bodyWidth),
				"px between an answer's width and the card body's inner width",
			).toBeLessThanOrEqual(1);
		}
		const own = card.getByTestId("ask-own-row");
		await waitForStableBoundingBox(own);
		expect((await own.boundingBox())?.height).toBeGreaterThanOrEqual(44);
		const upToYou = card.getByTestId("ask-up-to-you");
		await waitForStableBoundingBox(upToYou);
		expect((await upToYou.boundingBox())?.height).toBeGreaterThanOrEqual(44);
		const closeBox = await closeX.boundingBox();
		expect(closeBox?.width).toBeGreaterThanOrEqual(44);
		expect(closeBox?.height).toBeGreaterThanOrEqual(44);

		// 16 px, or iOS zooms the page when the line takes the focus.
		await own.click();
		await expect(card.getByTestId("ask-own-input")).toHaveCSS(
			"font-size",
			"16px",
		);
	});

	test("a Hungarian reader gets the app's words in Hungarian", async ({
		page,
	}) => {
		await setLanguage("hu");
		await startTurn(page, "one", { viewport: SMALL_PHONE });
		const card = askCard(page, "Alfy kérdése");
		await expect(card).toBeVisible({ timeout: 30_000 });
		await expect(card.getByTestId("ask-up-to-you")).toBeEnabled();

		// The words the app adds are Hungarian; the question and the answers are the model's own.
		await expect(card.getByText("Javasolt", { exact: true })).toHaveCount(1);
		await expect(
			card.getByRole("button", { name: "A party at home, javasolt" }),
		).toBeVisible();
		await expect(card.getByTestId("ask-own-row")).toHaveText("Saját válasz...");
		await expect(card.getByTestId("ask-up-to-you")).toHaveText("Rád bízom");
		await expect(
			card.getByRole("button", { name: "Kérdés bezárása" }),
		).toBeVisible();
		await expect(card.getByText("Recommended")).toHaveCount(0);
		await expect(card.getByText("Up to you")).toHaveCount(0);

		// The thread opens the card at its question: the question (the model's own words,
		// in English) and the X are in view, and not under the app header.
		const question = card.getByText("Which way should we take it?");
		const closeX = card.getByRole("button", { name: "Kérdés bezárása" });
		await waitForStableBoundingBox(question);
		await waitForStableBoundingBox(closeX);
		await expectTopmost(question, {
			message: "the question is in view, not under the app header",
		});
		await expectTopmost(closeX, {
			message: "the X is in view, not under the app header",
		});

		// And nothing runs out of its row at 360 px: no answer, no way out, no card.
		await waitForStableBoundingBox(card);
		const cardBox = await card.boundingBox();
		expect(
			(cardBox?.x ?? 0) + (cardBox?.width ?? 0),
			"the card's right edge, in px",
		).toBeLessThanOrEqual(SMALL_PHONE.width);
		const measured = await card.evaluate((root) => {
			const elements = [
				...root.querySelectorAll(
					'[data-testid="ask-option"], [data-testid="ask-own-row"], [data-testid="ask-up-to-you"], [data-testid="ask-close"]',
				),
			];
			const named = (element: Element) => element.getAttribute("data-testid");
			return {
				count: elements.length,
				overflowing: elements
					.filter((element) => element.scrollWidth > element.clientWidth)
					.map(named),
				// A zero-width element has nothing to overflow, and would pass.
				unmeasured: elements
					.filter((element) => element.clientWidth === 0)
					.map(named),
			};
		});
		// Three answers, the own-line row, Up to you and the X: a test id that no longer
		// matches must not leave an empty list to pass.
		expect(measured.count, "the elements measured").toBe(6);
		expect(measured.unmeasured, "the elements with no width").toEqual([]);
		expect(measured.overflowing, "the elements wider than their box").toEqual(
			[],
		);
	});
});
