import { expect, type Locator, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { THREAD_END_CARD_INSET_PX } from "../../src/lib/components/chat/thread-end-target";
import { db } from "../../src/lib/server/db";
import { askQuestions } from "../../src/lib/server/db/schema";
import {
	AI_SMOKE_ASK_AFTER_PREFIX,
	AI_SMOKE_ASK_BROKEN_CALL_ID,
	AI_SMOKE_ASK_CALL_ID,
	AI_SMOKE_ASK_FIXED,
	AI_SMOKE_ASK_HOLD_ASK,
	AI_SMOKE_ASK_HOLD_RESUME,
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
	ensureSidebarExpanded,
	expectTopmost,
	login,
	sendMessage,
	setDraining,
	UPDATING_STATUS,
	waitForHydration,
	waitForMotionToSettle,
	waitForStableBoundingBox,
} from "./helpers";

// "Ask me first" in a real browser (docs/plans/ask-me-first, design section 10): Alfy
// stops a reply to ask, the person answers on the card, and the same reply carries on.
// The model is scripted (tests/mocks/ai-provider/chat-turn-scripts.ts, `askTurnReply`);
// the page, the routes and the resume are the production build's own. Driven the way a
// reader does it: look at the card, press an answer, watch the reply go on.
//
// Two describes. The first is the answer itself (the card, each way to answer it, the
// reply that carries on, the phone and Hungarian). The second is the reply that asked
// across what happens to a page: a reload, a second tab, Retry, a message queued behind
// the reply, the sidebar, a server update and a restart.

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

/** The request is the resume of the first question the scripted turn of `mode` asks: the reply so far, and then the answer. */
function expectResumeOfFirstAsk(
	request: CapturedOpenAICompatibleRequest,
	mode: AskTurnMode = "one",
) {
	expectContinuation(request, {
		callId: AI_SMOKE_ASK_CALL_ID,
		intro: AI_SMOKE_ASK_INTRO,
		personsMessage: askTurnMessage(mode),
	});
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

/** One animation started on the question card: what it animates, for how long, its first and last frame. */
type CardPlay = {
	properties: string[];
	duration: number;
	first: Record<string, unknown>;
	last: Record<string, unknown>;
};

/**
 * From the next load of `page` on, notes every animation the page starts on the question
 * card (the browser's own `Element.animate`, which Svelte's transitions play through).
 * Read back with `cardPlays`. It runs before the page's own scripts, so the first play is
 * seen, and again in every document the page loads, so a reload starts a new list.
 */
async function watchCardAnimations(page: Page) {
	await page.addInitScript(() => {
		const plays: CardPlay[] = [];
		(window as unknown as { __cardPlays: CardPlay[] }).__cardPlays = plays;
		const animate = Element.prototype.animate;
		Element.prototype.animate = function (
			this: Element,
			keyframes: Keyframe[],
			options?: number | KeyframeAnimationOptions,
		) {
			if (this.getAttribute("data-testid") === "ask-card") {
				const frames = keyframes as Array<Record<string, unknown>>;
				plays.push({
					properties: [
						...new Set(frames.flatMap((frame) => Object.keys(frame))),
					].sort(),
					duration:
						typeof options === "number"
							? options
							: Number(options?.duration ?? 0),
					first: frames[0] ?? {},
					last: frames[frames.length - 1] ?? {},
				});
			}
			return animate.call(this, keyframes, options);
		};
	});
}

/** The animations `watchCardAnimations` has seen in this document. */
function cardPlays(page: Page): Promise<CardPlay[]> {
	return page.evaluate(
		() => (window as unknown as { __cardPlays: CardPlay[] }).__cardPlays,
	);
}

/** What the browser has for a control now: its transition, and the colours a hover changes. */
function lookOf(control: Locator) {
	return control.evaluate((element) => {
		const style = getComputedStyle(element);
		return {
			transition: style.transition,
			durations: style.transitionDuration.split(",").map(Number.parseFloat),
			background: style.backgroundColor,
			color: style.color,
		};
	});
}

/** Starts to note, on `control`, each property whose transition starts from now on. */
function noteTransitionsOf(control: Locator) {
	return control.evaluate((element) => {
		const started: string[] = [];
		(element as unknown as { __started: string[] }).__started = started;
		element.addEventListener("transitionstart", (event) =>
			started.push((event as TransitionEvent).propertyName),
		);
	});
}

/** The properties `noteTransitionsOf` has seen start. */
function transitionsStartedOn(control: Locator): Promise<string[]> {
	return control.evaluate(
		(element) => (element as unknown as { __started: string[] }).__started,
	);
}

/**
 * The controls of the card of several questions, with both questions answered so that Send
 * is on: an answer that is not picked (a picked one keeps its tint), the row for own words,
 * Decide for me, the X and Send.
 */
async function answerCardControls(page: Page) {
	const card = askCard(page);
	await expect(card).toBeVisible({ timeout: 30_000 });
	await expect(card.getByTestId("ask-up-to-you")).toBeEnabled();
	await card.getByRole("checkbox", { name: "Adults" }).click();
	const send = card.getByTestId("ask-send");
	await expect(send).toBeEnabled();
	return {
		"an answer": card.getByRole("checkbox", { name: "Kids" }),
		"the row for own words": card.getByTestId("ask-own-row").first(),
		"Decide for me": card.getByTestId("ask-up-to-you"),
		"the X": card.getByTestId("ask-close"),
		Send: send,
	};
}

/** Where an element sits and how big it is. */
type Box = { x: number; y: number; width: number; height: number };

/** The element's box once it has stopped moving. */
async function settledBox(locator: Locator): Promise<Box> {
	await waitForStableBoundingBox(locator);
	const box = await locator.boundingBox();
	expect(box, "the element is laid out").not.toBeNull();
	return box as Box;
}

/**
 * `after` is where `before` was and as big, to half a pixel. It is what the page lays out,
 * not what is painted around it: a ring drawn as a shadow takes no part.
 */
function expectSameBox(after: Box, before: Box, what: string) {
	for (const edge of ["x", "y", "width", "height"] as const) {
		expect(
			Math.abs(after[edge] - before[edge]),
			`${what}: how far its ${edge} moved, in px`,
		).toBeLessThanOrEqual(0.5);
	}
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

/** Reloads the open chat and waits until the page is up again. */
async function reloadChat(page: Page) {
	await page.reload({ waitUntil: "domcontentloaded" });
	await waitForHydration(page);
}

/** Inspect the paused segment's retained commentary through its existing disclosure.
 * It remains activity, including after reload; the canonical answer stays separate.
 */
async function inspectAskActivity(
	page: Page,
	segment = page.getByTestId("assistant-message").first(),
	text = AI_SMOKE_ASK_INTRO,
): Promise<Locator> {
	await expect(segment.locator(".prose-container")).not.toContainText(text);
	const disclosure = segment.locator(".thinking-header");
	await expect(disclosure).toBeVisible();
	if ((await disclosure.getAttribute("aria-expanded")) === "false")
		await disclosure.click();
	const intro = segment
		.getByTestId("normal-chat-commentary")
		.getByText(text, { exact: true });
	await expect(intro).toBeVisible();
	return intro;
}

/**
 * The card of the one-question script as a question that waits is drawn: the question,
 * its three answers, the words Alfy wrote before it asked, and the message box off.
 * Returns the card.
 */
async function expectWaitingCard(page: Page): Promise<Locator> {
	const card = askCard(page);
	await expect(card).toBeVisible({ timeout: 30_000 });
	await expect(card.getByText("Which way should we take it?")).toBeVisible();
	await expect(card.getByTestId("ask-option")).toHaveCount(3);
	for (const name of [
		"A party at home, recommended",
		"Dinner out, just close family",
		"A weekend away together",
	]) {
		await expect(card.getByRole("button", { name })).toBeVisible();
	}
	await inspectAskActivity(page);
	await expect(page.getByTestId("message-input")).toBeDisabled();
	return card;
}

/**
 * From the next load of `page` on, notes which of these test ids were ever in its
 * document, even for a moment, and every text each held: a look once the flow is over
 * cannot tell "never" from "was there and left", nor a wrong line that lived only while
 * a reply ran from the right one that replaced it. Read back with `wasSighted` and
 * `textsSeenOf`. The page's own scripts have not run yet when this does, and the
 * elements the server drew are seen too. Name one id that the flow is sure to draw
 * beside the one that must never be drawn: that one's sighting shows the watch works.
 */
async function watchForTestIds(page: Page, testIds: string[]) {
	await page.addInitScript((ids: string[]) => {
		const mine = window as unknown as { __sighted?: Record<string, string[]> };
		const sighted = mine.__sighted ?? {};
		mine.__sighted = sighted;
		const note = (id: string, element: Element) => {
			const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
			const seen = sighted[id] ?? [];
			sighted[id] = seen;
			if (!seen.includes(text)) seen.push(text);
		};
		const look = (node: Node) => {
			if (!(node instanceof Element)) return;
			for (const id of ids) {
				const selector = `[data-testid="${id}"]`;
				if (node.matches(selector)) note(id, node);
				for (const found of node.querySelectorAll(selector)) note(id, found);
			}
		};
		// The elements added in each batch of changes (one that came and went inside the
		// batch is still seen), then every element there is, so that a text that changed
		// inside an element that was already drawn is seen as well.
		new MutationObserver((records) => {
			for (const record of records) {
				for (const node of record.addedNodes) look(node);
			}
			if (document.documentElement) look(document.documentElement);
		}).observe(document, {
			childList: true,
			characterData: true,
			subtree: true,
		});
	}, testIds);
}

/** Every distinct text the elements `watchForTestIds` watched had in the page's current document. */
function textsSeenOf(page: Page, testId: string): Promise<string[]> {
	return page.evaluate(
		(id) =>
			(window as unknown as { __sighted?: Record<string, string[]> })
				.__sighted?.[id] ?? [],
		testId,
	);
}

/** Whether `watchForTestIds` has seen the element in the page's current document. */
async function wasSighted(page: Page, testId: string): Promise<boolean> {
	return (await textsSeenOf(page, testId)).length > 0;
}

/**
 * A tab beside `page`, in the same browser, opened on the chat and hydrated. `watch`
 * names the test ids it records from its first load (`watchForTestIds`). The caller
 * closes it.
 */
async function openChatInAnotherTab(
	page: Page,
	conversationId: string,
	watch: string[] = [],
): Promise<Page> {
	const tab = await page.context().newPage();
	try {
		if (watch.length > 0) await watchForTestIds(tab, watch);
		await tab.setViewportSize(DESKTOP);
		await tab.goto(`/chat/${conversationId}`, {
			waitUntil: "domcontentloaded",
		});
		await waitForHydration(tab);
		return tab;
	} catch (error) {
		await tab.close();
		throw error;
	}
}

/**
 * What every describe of this file runs on: the fake model, started once and reset
 * before each test, and the turn's own put-backs after each (the user's model and the
 * temporary provider, then the language). `putBackFirst` is a describe's own put-back:
 * it runs before those, and whatever it throws does not stop them.
 */
function useAskTurnHarness(putBackFirst?: (page: Page) => Promise<void>) {
	const fakeProvider = createOpenAICompatibleProviderHarness();
	let restoreTurn: (() => Promise<void>) | null = null;

	test.beforeAll(async () => {
		await fakeProvider.start();
	});
	test.afterAll(async () => {
		await fakeProvider.stop();
	});
	test.beforeEach(async () => {
		await fakeProvider.reset();
	});
	test.afterEach(async ({ page }) => {
		try {
			// First: a test that failed with one of the scripted model's replies held
			// (`AI_SMOKE_ASK_HOLD_*`) leaves a request waiting on the provider for a
			// release that will not come, and a put-back below that waits on that request
			// (`putBackFirst`, `restoreTurn`) would wait on it for ever. `reset()` lets
			// every hold go.
			await fakeProvider.reset();
			await putBackFirst?.(page);
		} finally {
			try {
				await restoreTurn?.();
			} finally {
				restoreTurn = null;
				await setLanguage("en");
			}
		}
	});

	return {
		fakeProvider,
		async startTurn(
			page: Page,
			mode: AskTurnMode,
			options: { viewport?: { width: number; height: number } } = {},
		) {
			const turn = await startAskTurn(
				page,
				fakeProvider.baseURL,
				mode,
				options,
			);
			restoreTurn = turn.restore;
			return turn;
		},
	};
}

test.describe("Alfy asks first, and the answer carries the reply on", () => {
	const { fakeProvider, startTurn } = useAskTurnHarness();

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
		await expect(card.getByRole("button", { name: "Other" })).toBeVisible();
		await expect(
			card.getByRole("button", { name: "Decide for me" }),
		).toBeVisible();
		await expect(
			card.getByRole("button", { name: "Close the question" }),
		).toBeVisible();
		await expect(page.getByTestId("message-input")).toBeDisabled();
		// Measure automatic arrival before the reader opens activity. A pointer
		// press deliberately releases MessageArea's held position.
		await expect(
			page.getByTestId("assistant-message").first().locator(".thinking-header"),
		).toHaveAttribute("aria-expanded", "false");
		// This card fits the window, so the thread rests at its bottom, as it always did:
		// the end of the thread is the top of the card only when the card does not fit
		// (the phone and Hungarian tests).
		await expect.poll(() => distanceFromBottom(page)).toBeLessThan(2);
		// Explicit inspection is a separate reader action, after the arrival oracle.
		await inspectAskActivity(page);

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
		await expect(
			segments.first().getByTestId("normal-chat-commentary"),
		).toContainText(AI_SMOKE_ASK_INTRO);
		await expect(
			segments.first().locator(".prose-container"),
		).not.toContainText(AI_SMOKE_ASK_INTRO);
		await expect(segments.first().getByTestId("ask-folded")).toBeVisible();
		await expectReplyEnded(page);

		// One Sources row for the whole reply, at its end (owner, 2026-11-05: the asking
		// segment's, between its folded line and the words that carry on, "read as the reply
		// ending"): none under the asking segment, one under the last.
		await expect(
			segments.last().getByRole("button", { name: /Sources/i }),
		).toHaveCount(1);
		await expect(
			segments.first().getByRole("button", { name: /Sources/i }),
		).toHaveCount(0);

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
		// gap between rows would have left 58). The last thing it draws is its folded line:
		// the reply's Sources row is under the last segment, not under this one (owner,
		// 2026-11-05). Both edges are read in one go, after the waits above, so that no
		// layout change can fall between the reads.
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
		expectResumeOfFirstAsk(resume);
	});

	// Ruling 42: while the question waits the message box is drawn at half strength, and
	// only what it holds. A tall card opens at its top, so its last rows sit under the
	// floating composer, and a surface at half strength showed them through it (text over
	// text). jsdom applies no component CSS, so only a real browser can say what is drawn.
	test("the composer waits at half strength while its surface stays opaque", async ({
		page,
	}) => {
		await startTurn(page, "one");
		await expectWaitingCard(page);

		const looks = await page.evaluate(() => {
			const box = document.querySelector('[data-testid="composer-box"]');
			const surface = box?.querySelector(".message-composer");
			const field = surface?.querySelector(".composer-field");
			const actions = surface?.querySelector(".composer-actions");
			const opacityOf = (element: Element | null | undefined) =>
				element ? getComputedStyle(element).opacity : null;
			return {
				box: opacityOf(box),
				surface: opacityOf(surface),
				field: opacityOf(field),
				actions: opacityOf(actions),
				// every face that is off, as it is drawn
				faces: [
					...(surface?.querySelectorAll(".composer-face:disabled") ?? []),
				].map((face) => getComputedStyle(face).opacity),
				background: surface ? getComputedStyle(surface).backgroundColor : "",
			};
		});

		// The box and the surface are drawn whole ...
		expect(looks.box).toBe("1");
		expect(looks.surface).toBe("1");
		// ... with a colour that has no alpha in it (an `rgb(...)` or `color(...)` without
		// a slash), so the card's rows beneath do not show through ...
		expect(looks.background).not.toBe("");
		expect(looks.background).not.toContain("/");
		expect(looks.background).not.toMatch(/^rgba\(/);
		// ... and what it holds is at half strength, once: a face that is off is not
		// halved twice.
		expect(looks.field).toBe("0.5");
		expect(looks.actions).toBe("0.5");
		for (const face of looks.faces) expect(face).toBe("1");
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
		// Opening the line moves nothing: it takes the row's box, and the card does not grow.
		// Its accent edge and ring are paint (a border of the same width, a shadow).
		const rowBefore = await settledBox(card.getByTestId("ask-own-row"));
		const cardBefore = await settledBox(card);

		await page.keyboard.type(words);

		const line = card.getByTestId("ask-own-input");
		await expect(line).toHaveValue(words);
		await expect(line).toBeFocused();
		expectSameBox(
			await settledBox(card.getByTestId("ask-own-field")),
			rowBefore,
			"the open line, against the row it opened from",
		);
		expectSameBox(await settledBox(card), cardBefore, "the card");
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

	test("Decide for me leaves the choice to Alfy", async ({ page }) => {
		await startTurn(page, "one");
		const card = askCard(page);
		await expect(card).toBeVisible({ timeout: 30_000 });
		await pressWhenAwake(card.getByRole("button", { name: "Decide for me" }));

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

	// Owner, 2026-11-05, after his first live test ("I only want 1 ask card at a time"): a card
	// holds one question. A question may still take several picks, and then the card needs Send.
	test("a question that takes several picks needs Send", async ({ page }) => {
		await startTurn(page, "many");
		const card = askCard(page);
		await expect(card).toBeVisible({ timeout: 30_000 });
		await expect(card.getByTestId("ask-question")).toHaveCount(1);
		await expect(card.getByText("Pick any")).toBeVisible();
		const send = card.getByTestId("ask-send");
		await expect(card.getByTestId("ask-up-to-you")).toBeEnabled();
		await expect(send).toBeDisabled();

		// This card has no send in its line (the footer's Send is the card's), and the line
		// still takes the row's box.
		const own = card.getByTestId("ask-own-row");
		const rowBefore = await settledBox(own);
		const cardBefore = await settledBox(card);
		await own.click();
		expectSameBox(
			await settledBox(card.getByTestId("ask-own-field")),
			rowBefore,
			"the open line, against the row it opened from",
		);
		expectSameBox(await settledBox(card), cardBefore, "the card");

		// The question takes any number of picks, and a pick replaces the line's words.
		await card.getByRole("checkbox", { name: "Adults" }).click();
		await card.getByRole("checkbox", { name: "Kids" }).click();
		await expect(card.getByRole("checkbox", { name: "Adults" })).toBeChecked();
		await expect(card.getByRole("checkbox", { name: "Kids" })).toBeChecked();
		await expect(send).toBeEnabled();
		await send.click();

		const folded = page.getByTestId("ask-folded");
		await expect(folded).toContainText("Who's coming?");
		await expect(folded).toContainText("Adults, Kids");
		await expect(card).toHaveCount(0);

		await expectCarriedOn(page, "Adults, Kids");
		await expectReplyEnded(page);
		await expect.poll(() => chatRequests(fakeProvider).length).toBe(2);
		expect(
			answerTo(chatRequests(fakeProvider)[1], AI_SMOKE_ASK_CALL_ID),
		).toMatchObject({
			status: "answered",
			answers: [{ question: "Who's coming?", picked: ["Adults", "Kids"] }],
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

		// The second paused segment retains its lead-in behind its own disclosure.
		const secondCard = askCard(page);
		await expect(
			secondCard.getByText("Inside or in the garden?", { exact: true }),
		).toBeVisible({
			timeout: 30_000,
		});
		await expect(page.getByTestId("ask-folded")).toHaveCount(1);
		await expect(secondCard).toHaveCount(1);
		const secondSegment = page
			.getByTestId("assistant-message")
			.filter({ has: secondCard });
		await expect(secondSegment).toHaveCount(1);
		await expect(
			secondSegment.getByTestId("normal-chat-commentary"),
		).toHaveCount(0);
		await inspectAskActivity(page, secondSegment, AI_SMOKE_ASK_SECOND_INTRO);
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
		expectResumeOfFirstAsk(afterFirst, "twice");
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
		const intro = await inspectAskActivity(page);
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
		const decideForMe = card.getByTestId("ask-up-to-you");
		await waitForStableBoundingBox(decideForMe);
		expect((await decideForMe.boundingBox())?.height).toBeGreaterThanOrEqual(
			44,
		);
		const closeBox = await closeX.boundingBox();
		expect(closeBox?.width).toBeGreaterThanOrEqual(44);
		expect(closeBox?.height).toBeGreaterThanOrEqual(44);

		// 16 px, or iOS zooms the page when the line takes the focus. And the line takes the
		// row's box: on a phone it holds a bigger send button, which used to make it taller.
		const ownBefore = await settledBox(own);
		const cardBefore = await settledBox(card);
		await own.click();
		await expect(card.getByTestId("ask-own-input")).toHaveCSS(
			"font-size",
			"16px",
		);
		expectSameBox(
			await settledBox(card.getByTestId("ask-own-field")),
			ownBefore,
			"the open line, against the row it opened from",
		);
		expectSameBox(await settledBox(card), cardBefore, "the card");
	});

	// Owner, 2026-11-05, after the real-model measurement: a question may have four answers
	// (it was two or three). Four rows are what a phone sees of it, so they are measured
	// there: each is a row of its own, as wide as the card's body, at least 44 px tall and
	// below the one before, in Alfy's order; the row for own words comes after the fourth.
	// The fourth answer then carries the reply on, which also shows the server takes a card
	// of four (the tool) and an answer that picks the fourth (the answer route).
	test("a question with four answers is four 44 px rows on a phone, and the fourth carries the reply on", async ({
		page,
	}) => {
		await startTurn(page, "four", { viewport: PHONE });
		const card = askCard(page);
		await expect(card).toBeVisible({ timeout: 30_000 });
		await expect(card.getByTestId("ask-up-to-you")).toBeEnabled();

		// The question and the X are in view, and not under the app header.
		const question = card.getByText("Where should we hold it?");
		const closeX = card.getByRole("button", { name: "Close the question" });
		await waitForStableBoundingBox(question);
		await waitForStableBoundingBox(closeX);
		await expectTopmost(question, {
			message: "the question is in view, not under the app header",
		});
		await expectTopmost(closeX, {
			message: "the X is in view, not under the app header",
		});

		// Alfy's order, and the mark on the third, where Alfy put it.
		const options = card.getByTestId("ask-option");
		await expect(options).toHaveCount(4);
		await expect(options).toContainText([
			"At home",
			"In the garden",
			"At a restaurant",
			"Somewhere by the lake",
		]);
		await expect(card.getByText("Recommended", { exact: true })).toHaveCount(1);
		await expect(options.nth(2).getByText("Recommended")).toBeVisible();

		// Each answer is a row of its own: as wide as the body of the card, at least 44 px
		// high, and under the one before it.
		const block = card.getByTestId("ask-question");
		await waitForStableBoundingBox(block);
		const bodyWidth = (await block.boundingBox())?.width ?? 0;
		expect(bodyWidth, "the card's body is laid out").toBeGreaterThan(0);
		let rowsEndAt = Number.NEGATIVE_INFINITY;
		for (const row of await options.all()) {
			const box = await settledBox(row);
			expect(box.height).toBeGreaterThanOrEqual(44);
			expect(
				Math.abs(box.width - bodyWidth),
				"px between an answer's width and the card body's inner width",
			).toBeLessThanOrEqual(1);
			expect(
				box.y,
				"px where an answer starts, against where the one before it ends",
			).toBeGreaterThanOrEqual(rowsEndAt - 0.5);
			rowsEndAt = box.y + box.height;
		}
		// The row for own words follows the fourth answer, and is a touch target too.
		const own = await settledBox(card.getByTestId("ask-own-row"));
		expect(own.height).toBeGreaterThanOrEqual(44);
		expect(own.y).toBeGreaterThanOrEqual(rowsEndAt - 0.5);

		// The fourth answer carries the same reply on, and the model is told which it was.
		await pressWhenAwake(
			card.getByRole("button", { name: "Somewhere by the lake" }),
		);
		const folded = page.getByTestId("ask-folded");
		await expect(folded).toContainText("Where should we hold it?");
		await expect(folded).toContainText("Somewhere by the lake");
		await expect(card).toHaveCount(0);
		await expectCarriedOn(page, "Somewhere by the lake");
		await expectReplyEnded(page);
		await expect.poll(() => chatRequests(fakeProvider).length).toBe(2);
		const [, resume] = chatRequests(fakeProvider);
		expect(answerTo(resume, AI_SMOKE_ASK_CALL_ID)).toMatchObject({
			status: "answered",
			answers: [
				{
					question: "Where should we hold it?",
					picked: ["Somewhere by the lake"],
				},
			],
		});
		expectResumeOfFirstAsk(resume, "four");
	});

	// Owner, 2026-11-05, after the real-model measurement: one refusal names every problem of a
	// card, so the model fixes the whole card in one retry. The scripted model's first card breaks
	// a count (five answers) and a mark (none Recommended), both on its one question.
	// The tool refuses it once, naming both, and the model asks again with both fixed: the person
	// sees one card and no refusal, after one extra model step; nothing was written for the card
	// that was refused. Before, the schema refused the count and the tool the mark on the next
	// try, so the second card would have been refused too.
	test("a card that breaks a count and a mark is refused once, naming both, and the fixed card is the one the person sees", async ({
		page,
	}) => {
		const { conversationId } = await startTurn(page, "refused");

		// The card the person gets is the fixed one: one question, four answers.
		const card = askCard(page);
		await expect(card).toBeVisible({ timeout: 30_000 });
		await expect(card.getByTestId("ask-question")).toHaveCount(1);
		await expect(card.getByText("Which way should we take it?")).toBeVisible();
		await inspectAskActivity(page);
		// ... and it is the only card there ever was, with nothing said of a refusal.
		await expect(page.getByTestId("ask-card")).toHaveCount(1);
		await expect(page.getByTestId("ask-error")).toHaveCount(0);

		// The model's second request carries the one refusal: both problems, a line each.
		await expect.poll(() => chatRequests(fakeProvider).length).toBe(2);
		const [, retry] = chatRequests(fakeProvider);
		expect(answerTo(retry, AI_SMOKE_ASK_BROKEN_CALL_ID)).toEqual({
			ok: false,
			errorCode: "invalid_questions",
			message: [
				"Question 1 needs 2 to 4 options.",
				"Question 1 takes one pick: mark exactly one of its options recommended.",
			].join("\n"),
		});

		// Only the card that was asked is a question: nothing was written for the refused one.
		const rows = await db
			.select()
			.from(askQuestions)
			.where(eq(askQuestions.conversationId, conversationId));
		expect(rows).toHaveLength(1);
		expect(JSON.parse(rows[0].questionsJson)).toEqual(AI_SMOKE_ASK_FIXED);
		expect(rows[0].toolCallId).toBe(AI_SMOKE_ASK_CALL_ID);

		// The fixed card carries the same reply on, as any card does.
		await pressWhenAwake(card.getByTestId("ask-up-to-you"));
		await expectCarriedOn(page, "left to me");
		await expectReplyEnded(page);
		await expect.poll(() => chatRequests(fakeProvider).length).toBe(3);
		// ... and the reply it carries on still holds what happened: the refusal, and the answer.
		const [, , resume] = chatRequests(fakeProvider);
		expect(answerTo(resume, AI_SMOKE_ASK_BROKEN_CALL_ID)).toMatchObject({
			ok: false,
			errorCode: "invalid_questions",
		});
		expect(answerTo(resume, AI_SMOKE_ASK_CALL_ID)).toMatchObject({
			status: "left_to_you",
		});
	});

	test("the card rises into place when Alfy asks: once, on transform and opacity only, and the thread still rests its top under the view's edge", async ({
		page,
	}) => {
		await watchCardAnimations(page);
		await startTurn(page, "one", { viewport: PHONE });
		const card = askCard(page);
		await expect(card).toBeVisible({ timeout: 30_000 });
		await expect(card.getByTestId("ask-up-to-you")).toBeEnabled();
		await waitForMotionToSettle(page);

		// Svelte holds the first frame with a zero-length animation, then plays the move.
		const moves = (await cardPlays(page)).filter((play) => play.duration > 0);
		expect(moves, "the moves the card made").toHaveLength(1);
		const [move] = moves;
		expect(move.properties, "what the entrance animates").toEqual([
			"opacity",
			"transform",
		]);
		expect(move.duration, "ms, the app's emphasis duration").toBe(250);
		// From 10 px below and transparent, to where it rests and solid.
		expect(move.first).toMatchObject({
			transform: "translate(0px, 10px)",
			opacity: "0",
		});
		expect(move.last).toMatchObject({
			transform: "translate(0px, 0px)",
			opacity: "1",
		});
		// Nothing is left on the card once it has landed.
		await expect(card).toHaveCSS("transform", "none");
		await expect(card).toHaveCSS("opacity", "1");

		// The thread aimed at the card's top while the card was still moving, and put that
		// top where it puts it for a card that does not move (8 px under the view's edge).
		// It rested 1 to 2 px above it before the aim read where the card rests: the aim was
		// taken at the first frame, with the card drawn 10 px low, and nothing aimed again.
		const underTheEdge = await card.evaluate((element) => {
			const view = element.closest(".scroll-container") as HTMLElement;
			return (
				element.getBoundingClientRect().top - view.getBoundingClientRect().top
			);
		});
		expect(
			Math.abs(underTheEdge - THREAD_END_CARD_INSET_PX),
			"px between the card's top and where the thread rests it",
		).toBeLessThanOrEqual(0.5);

		// A reload draws the card where it was and does not play it in: the server drew it,
		// so it is on screen from the first paint, and an entrance would hide it and bring
		// it back (it dropped to transparent 150 ms in and rose again: a blink).
		await reloadChat(page);
		await expect(card).toBeVisible({ timeout: 30_000 });
		await waitForMotionToSettle(page);
		expect(
			await cardPlays(page),
			"the card's animations after a reload",
		).toEqual([]);
	});

	test("a reader who asked for no motion sees the card appear without any", async ({
		page,
	}) => {
		await page.emulateMedia({ reducedMotion: "reduce" });
		await watchCardAnimations(page);
		await startTurn(page, "one", { viewport: PHONE });
		const card = askCard(page);
		await expect(card).toBeVisible({ timeout: 30_000 });
		await expect(card.getByTestId("ask-up-to-you")).toBeEnabled();
		await waitForMotionToSettle(page);

		expect(
			await cardPlays(page),
			"the card's animations under reduced motion",
		).toEqual([]);
		await expect(card).toHaveCSS("transform", "none");
		await expect(card).toHaveCSS("opacity", "1");
		// And the thread rests its top where it always did.
		const underTheEdge = await card.evaluate((element) => {
			const view = element.closest(".scroll-container") as HTMLElement;
			return (
				element.getBoundingClientRect().top - view.getBoundingClientRect().top
			);
		});
		expect(
			Math.abs(underTheEdge - THREAD_END_CARD_INSET_PX),
			"px between the card's top and where the thread rests it",
		).toBeLessThanOrEqual(0.5);
	});

	// The answers eased their hover and the other controls snapped. Every control now takes
	// the answers' own transition (compared as the browser computes it) and the answers'
	// own hover (the outline ones), and Send, which is filled, shifts its fill.
	for (const colorScheme of ["light", "dark"] as const) {
		test(`every control on the card hovers the way the answers do, in the ${colorScheme} theme`, async ({
			page,
		}) => {
			await page.emulateMedia({ colorScheme });
			await startTurn(page, "many");
			// The theme is the one asked for, and not whatever the page started with.
			if (colorScheme === "dark") {
				await expect(page.locator("html")).toHaveClass(/dark/);
			} else {
				await expect(page.locator("html")).not.toHaveClass(/dark/);
			}
			const controls = await answerCardControls(page);

			// At rest first, with the pointer nowhere near any of them.
			await page.mouse.move(0, 0);
			await waitForMotionToSettle(page);
			const resting: Record<string, Awaited<ReturnType<typeof lookOf>>> = {};
			for (const [name, control] of Object.entries(controls)) {
				resting[name] = await lookOf(control);
			}
			for (const [name, look] of Object.entries(resting)) {
				expect(
					look.transition,
					`${name}: its transition, against the answers'`,
				).toBe(resting["an answer"].transition);
			}
			// The same properties and the same timing: 150 ms, over four colours.
			expect(resting["an answer"].durations).toEqual([0.15, 0.15, 0.15, 0.15]);

			const hovered: Record<string, Awaited<ReturnType<typeof lookOf>>> = {};
			for (const [name, control] of Object.entries(controls)) {
				await noteTransitionsOf(control);
				await control.hover();
				await waitForMotionToSettle(page);
				hovered[name] = await lookOf(control);
				expect(
					hovered[name].background,
					`${name}: its fill on hover, against at rest`,
				).not.toBe(resting[name].background);
				// It eased: a transition began, and the hover did not snap.
				expect(
					await transitionsStartedOn(control),
					`${name}: the transitions that began on hover`,
				).toContain("background-color");
				await page.mouse.move(0, 0);
				await waitForMotionToSettle(page);
			}
			// The outline controls take the answers' own hover, not a copy of it.
			for (const name of ["the row for own words", "Decide for me", "the X"]) {
				expect(
					hovered[name].background,
					`${name}: its fill on hover, against the answers'`,
				).toBe(hovered["an answer"].background);
			}
		});
	}

	test("under reduced motion the controls still show their hover, but do not ease it", async ({
		page,
	}) => {
		await page.emulateMedia({ reducedMotion: "reduce" });
		await startTurn(page, "many");
		const controls = await answerCardControls(page);
		await page.mouse.move(0, 0);
		await waitForMotionToSettle(page);

		for (const [name, control] of Object.entries(controls)) {
			const before = await lookOf(control);
			// 0.01 ms, which the browser writes as 1e-05 s: no time to be seen in.
			for (const duration of before.durations) {
				expect(
					duration,
					`${name}: each transition's duration, in s`,
				).toBeLessThanOrEqual(0.001);
			}
			await control.hover();
			await waitForMotionToSettle(page);
			expect(
				(await lookOf(control)).background,
				`${name}: its fill on hover, against at rest`,
			).not.toBe(before.background);
			await page.mouse.move(0, 0);
		}
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
		await expect(card.getByTestId("ask-own-row")).toHaveText("Egyéb");
		await expect(card.getByTestId("ask-up-to-you")).toHaveText("Rád bízom");
		await expect(
			card.getByRole("button", { name: "Kérdés bezárása" }),
		).toBeVisible();
		await expect(card.getByText("Recommended")).toHaveCount(0);
		await expect(card.getByText("Decide for me")).toHaveCount(0);
		await expect(card.getByText("Other", { exact: true })).toHaveCount(0);

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
		// Three answers, the own-line row, Decide for me and the X: a test id that no longer
		// matches must not leave an empty list to pass.
		expect(measured.count, "the elements measured").toBe(6);
		expect(measured.unmeasured, "the elements with no width").toEqual([]);
		expect(measured.overflowing, "the elements wider than their box").toEqual(
			[],
		);
	});
});

/** The words a reader queues behind a reply that is still being written. */
const QUEUED_WORDS = "And please keep it under twenty euros a head";

/** A chat's row in the sidebar. */
function sidebarRow(page: Page, conversationId: string): Locator {
	return page.locator(
		`[data-testid="conversation-item"][data-conversation-id="${conversationId}"]`,
	);
}

/** The mark on a chat's sidebar row that says the chat waits for an answer. */
function waitingMark(page: Page, conversationId: string): Locator {
	return sidebarRow(page, conversationId).getByTestId(
		"conversation-waiting-mark",
	);
}

/** The draft the server holds for a chat, as its text (none: an empty string). */
async function savedDraftOf(
	page: Page,
	conversationId: string,
): Promise<string> {
	const response = await page.request.get(
		`/api/conversations/${conversationId}`,
	);
	expect(response.ok(), `chat detail -> ${response.status()}`).toBe(true);
	const detail = (await response.json()) as {
		draft?: { draftText?: string } | null;
	};
	return detail.draft?.draftText ?? "";
}

test.describe("The reply that asked holds across reloads, a second tab, Retry, a queue, the sidebar and an update", () => {
	// The drain belongs to the worker's server, which outlives this file: it is put back
	// first, before the model and the language, so that a test that failed with the server
	// draining cannot leave it so for the next file.
	const { fakeProvider, startTurn } = useAskTurnHarness((page) =>
		setDraining(page, false),
	);

	test("a reload while a question waits shows the same card, and a second tab that answers late gets the folded line", async ({
		page,
	}) => {
		const { conversationId } = await startTurn(page, "one");
		await expectWaitingCard(page);

		// A reload: the question is the server's, so the same card comes back. Nothing was
		// answered, so no error line comes with it.
		await reloadChat(page);
		const card = await expectWaitingCard(page);
		await expect(card.getByTestId("ask-error")).toHaveCount(0);

		// A second tab on the chat shows it too.
		const second = await openChatInAnotherTab(page, conversationId, [
			"ask-error",
			"ask-folded",
		]);
		try {
			const secondCard = await expectWaitingCard(second);

			// The first tab answers, and the reply carries on there.
			await pressWhenAwake(
				card.getByRole("button", { name: "A party at home, recommended" }),
			);
			await expectCarriedOn(page, "A party at home");
			await expectReplyEnded(page);

			// A tab that opens now meets the answer at its first load: an answer on one
			// device folds the question on the others at their next load. Never a card.
			const third = await openChatInAnotherTab(page, conversationId, [
				"ask-card",
				"ask-folded",
			]);
			try {
				await expect(third.getByTestId("ask-folded")).toContainText(
					"A party at home",
				);
				await expectCarriedOn(third, "A party at home");
				await expect(askCard(third)).toHaveCount(0);
				expect(
					await wasSighted(third, "ask-folded"),
					"the watch sees what the page draws",
				).toBe(true);
				expect(
					await wasSighted(third, "ask-card"),
					"a tab that loaded after the answer drew the card",
				).toBe(false);
			} finally {
				await third.close();
			}

			// The second tab was told nothing: its card is still up. It answers, late, and
			// differently.
			await expect(secondCard).toBeVisible();
			await pressWhenAwake(
				secondCard.getByRole("button", {
					name: "Dinner out, just close family",
				}),
			);

			// What the answer that lost gets is the answer that won, as the folded line,
			// and the reply that carried on: no card left, and no error line, not even
			// for a moment.
			const folded = second.getByTestId("ask-folded");
			await expect(folded).toContainText("A party at home");
			await expect(folded).not.toContainText("Dinner out");
			await expect(secondCard).toHaveCount(0);
			await expectCarriedOn(second, "A party at home");
			await expectReplyEnded(second);
			await expect(second.getByTestId("assistant-message")).toHaveCount(2);
			await expect(
				second.getByRole("button", { name: "Regenerate response" }),
			).toHaveCount(1);
			expect(
				await wasSighted(second, "ask-folded"),
				"the watch sees what the page draws",
			).toBe(true);
			expect(
				await wasSighted(second, "ask-error"),
				"the late answer showed an error line",
			).toBe(false);
		} finally {
			await second.close();
		}

		// One answer was taken and one resume ran, with the first tab's answer.
		await expect.poll(() => chatRequests(fakeProvider).length).toBe(2);
		expectResumeOfFirstAsk(chatRequests(fakeProvider)[1]);
		expect(
			answerTo(chatRequests(fakeProvider)[1], AI_SMOKE_ASK_CALL_ID),
		).toMatchObject({
			status: "answered",
			answers: [{ picked: ["A party at home"] }],
		});
	});

	test("a reload while the answer's reply streams shows the folded line and the reply joining under it", async ({
		page,
	}) => {
		await startTurn(page, "slowresume");
		const card = await expectWaitingCard(page);
		// From the reload on, the card must never be drawn again, not even for a frame.
		await watchForTestIds(page, ["ask-card", "ask-folded"]);

		await pressWhenAwake(
			card.getByRole("button", { name: "A party at home, recommended" }),
		);
		// The server has the answer, and the model has the resume's request and holds its
		// words until the test lets them go: the reload comes while the reply runs.
		await expect.poll(() => chatRequests(fakeProvider).length).toBe(2);
		await reloadChat(page);

		// With the reply still held, the line is folded and says what was answered, the
		// page is in the reply that runs (Stop is on), and none of the words is there.
		const folded = page.getByTestId("ask-folded");
		await expect(folded).toContainText("Which way should we take it?");
		await expect(folded).toContainText("A party at home");
		await expect(page.getByTestId("stop-button")).toBeVisible();
		await expect(page.getByText(AI_SMOKE_ASK_AFTER_PREFIX)).toHaveCount(0);

		// The words come, under the line.
		fakeProvider.release(AI_SMOKE_ASK_HOLD_RESUME);
		await expectCarriedOn(page, "A party at home");
		await expectReplyEnded(page);

		// One reply: the segment that asked, with its folded line, and the one under it.
		await expect(page.getByTestId("assistant-message")).toHaveCount(2);
		await expect(folded).toHaveCount(1);
		await expect(page.getByTestId("user-message")).toHaveCount(1);
		await expect(
			page.getByRole("button", { name: "Regenerate response" }),
		).toHaveCount(1);
		await expect(askCard(page)).toHaveCount(0);
		expect(
			await wasSighted(page, "ask-folded"),
			"the watch sees what the page draws",
		).toBe(true);
		expect(
			await wasSighted(page, "ask-card"),
			"the card was drawn again after the reload",
		).toBe(false);
		// The reload did not ask the model for anything: the question and the resume.
		expect(chatRequests(fakeProvider)).toHaveLength(2);
	});

	test("a second tab that answers while the first tab's reply is carried on is told it lost, and shows the winner's answer", async ({
		page,
	}) => {
		const { conversationId } = await startTurn(page, "slowresume");
		const card = await expectWaitingCard(page);

		const second = await openChatInAnotherTab(page, conversationId, [
			"ask-error",
			"ask-folded",
		]);
		try {
			const secondCard = await expectWaitingCard(second);

			// The first tab answers. The server begins the resume, and the model holds its
			// words until the test lets them go.
			await pressWhenAwake(
				card.getByRole("button", { name: "A party at home, recommended" }),
			);
			await expect.poll(() => chatRequests(fakeProvider).length).toBe(2);

			// The second tab answers differently, while that reply runs.
			await pressWhenAwake(
				secondCard.getByRole("button", {
					name: "Dinner out, just close family",
				}),
			);

			// It is told at once that it lost: with the reply still held, its card has
			// folded into the winner's answer, and it is in the reply that runs.
			const folded = second.getByTestId("ask-folded");
			await expect(folded).toContainText("A party at home");
			await expect(secondCard).toHaveCount(0);
			await expect(second.getByTestId("stop-button")).toBeVisible();
			await expect(second.getByText(AI_SMOKE_ASK_AFTER_PREFIX)).toHaveCount(0);

			// The words come, under the winner's line, in both tabs.
			fakeProvider.release(AI_SMOKE_ASK_HOLD_RESUME);
			await expectCarriedOn(second, "A party at home");
			await expectReplyEnded(second);
			await expect(second.getByTestId("assistant-message")).toHaveCount(2);
			await expect(folded).toHaveCount(1);
			await expect(folded).toContainText("A party at home");
			await expect(folded).not.toContainText("Dinner out");

			// At no moment did the second tab's line say its own, losing pick (a line that
			// lives only while the reply runs is a line seen), nor was there an error line.
			const lines = await textsSeenOf(second, "ask-folded");
			expect(lines.length, "the watch sees the folded line").toBeGreaterThan(0);
			for (const line of lines) {
				expect(line).toContain("A party at home");
				expect(line).not.toContain("Dinner out");
			}
			expect(
				await wasSighted(second, "ask-error"),
				"the late answer showed an error line",
			).toBe(false);
		} finally {
			await second.close();
		}

		// The first tab's reply is the one that ran: one resume, with the first answer.
		await expectCarriedOn(page, "A party at home");
		await expectReplyEnded(page);
		await expect(page.getByTestId("assistant-message")).toHaveCount(2);
		expect(chatRequests(fakeProvider)).toHaveLength(2);
		expectResumeOfFirstAsk(chatRequests(fakeProvider)[1]);
		expect(
			answerTo(chatRequests(fakeProvider)[1], AI_SMOKE_ASK_CALL_ID),
		).toMatchObject({
			status: "answered",
			answers: [{ picked: ["A party at home"] }],
		});
	});

	test("Retry on a reply that asked runs the whole reply again", async ({
		page,
	}) => {
		await startTurn(page, "one");
		const card = await expectWaitingCard(page);
		await pressWhenAwake(
			card.getByRole("button", { name: "A party at home, recommended" }),
		);
		await expectCarriedOn(page, "A party at home");
		await expectReplyEnded(page);
		await expect(page.getByTestId("ask-folded")).toHaveCount(1);

		// Retry is on the reply's last segment. It runs the reply from the person's
		// message, and Alfy asks again.
		await page.getByRole("button", { name: "Regenerate response" }).click();
		await expect(card).toBeVisible({ timeout: 30_000 });

		// The old line and the words that carried on are gone; the person's message is
		// still the one, and the reply is one segment, waiting.
		await expect(page.getByTestId("ask-folded")).toHaveCount(0);
		await expect(page.getByText(AI_SMOKE_ASK_AFTER_PREFIX)).toHaveCount(0);
		await expect(page.getByTestId("user-message")).toHaveCount(1);
		await expect(page.getByTestId("assistant-message")).toHaveCount(1);
		await expect(page.getByTestId("message-input")).toBeDisabled();

		// The model began again from the person's message: no ask call of the first run
		// and no answer to it in what it was sent.
		await expect.poll(() => chatRequests(fakeProvider).length).toBe(3);
		const messages = wireMessages(chatRequests(fakeProvider)[2]);
		expect(
			messages.filter((message) => message.role === "tool"),
			"tool messages in the Retry's request",
		).toEqual([]);
		expect(
			messages.filter((message) => (message.tool_calls?.length ?? 0) > 0),
			"assistant messages that made a call in the Retry's request",
		).toEqual([]);
		expect(messages.at(-1)?.role).toBe("user");
		expect(wireText(messages.at(-1)?.content)).toContain(askTurnMessage("one"));

		// And the new card is a question of its own: an answer to it carries this reply on.
		await pressWhenAwake(
			card.getByRole("button", { name: "Dinner out, just close family" }),
		);
		await expectCarriedOn(page, "Dinner out, just close family");
		await expectReplyEnded(page);
		await expect(page.getByTestId("ask-folded")).toHaveCount(1);
		await expect(page.getByTestId("ask-folded")).toContainText(
			"Dinner out, just close family",
		);
		await expect(page.getByTestId("assistant-message")).toHaveCount(2);
		await expect.poll(() => chatRequests(fakeProvider).length).toBe(4);
		expectResumeOfFirstAsk(chatRequests(fakeProvider)[3]);
	});

	test("a message queued before the pause waits in the composer's draft and is not sent", async ({
		page,
	}) => {
		// Everything this tab posts to the chat's routes (the message and the answer), to
		// see that the queued words are never in it: a send the server turned away would
		// not reach the model, and only this shows it.
		const postedToChat: string[] = [];
		page.on("request", (request) => {
			const { pathname } = new URL(request.url());
			if (
				request.method() === "POST" &&
				(pathname.startsWith("/api/chat/") || pathname.includes("/questions/"))
			) {
				postedToChat.push(request.postData() ?? "");
			}
		});
		const { conversationId } = await startTurn(page, "slow");
		const composer = page.getByTestId("message-input");

		// The model has the request and holds the first segment until the test lets it
		// go: the reply is being written, and the reader queues a message behind it.
		await expect.poll(() => chatRequests(fakeProvider).length).toBe(1);
		await expect(page.getByTestId("stop-button")).toBeVisible();
		await composer.fill(QUEUED_WORDS);
		await page.getByTestId("queue-button").click();
		await expect(page.getByTestId("queued-message-banner")).toContainText(
			QUEUED_WORDS,
		);

		// Alfy asks. The reply is not over, so what was queued does not go: its words are
		// back in the draft, the card is up, and the message box is off with them in it.
		fakeProvider.release(AI_SMOKE_ASK_HOLD_ASK);
		const card = await expectWaitingCard(page);
		await expect(page.getByTestId("queued-message-banner")).toHaveCount(0);
		await expect(composer).toBeDisabled();
		await expect(composer).toHaveValue(QUEUED_WORDS);
		expect(chatRequests(fakeProvider)).toHaveLength(1);

		// The draft is the server's too: once it has landed there, a reload brings it back.
		await expect
			.poll(() => savedDraftOf(page, conversationId))
			.toBe(QUEUED_WORDS);
		await reloadChat(page);
		await expectWaitingCard(page);
		await expect(composer).toBeDisabled();
		await expect(composer).toHaveValue(QUEUED_WORDS);

		// The answer: the reply carries on, and the box takes words again, with the same
		// words in it, unsent.
		await pressWhenAwake(
			card.getByRole("button", { name: "A party at home, recommended" }),
		);
		await expectCarriedOn(page, "A party at home");
		await expectReplyEnded(page);
		await expect(composer).toBeEnabled();
		await expect(composer).toHaveValue(QUEUED_WORDS);
		await expect(page.getByTestId("user-message")).toHaveCount(1);
		// The resume's finalize left the draft alone too: the server still holds the words
		// as the chat's draft.
		await expect
			.poll(() => savedDraftOf(page, conversationId))
			.toBe(QUEUED_WORDS);
		await expect.poll(() => chatRequests(fakeProvider).length).toBe(2);
		for (const request of chatRequests(fakeProvider)) {
			const personsWords = wireMessages(request)
				.filter((message) => message.role === "user")
				.map((message) => wireText(message.content))
				.join("\n");
			expect(personsWords).not.toContain(QUEUED_WORDS);
		}
		// Nor did the tab post them: the message and the answer are all it posted.
		expect(
			postedToChat.length,
			"posts to the chat's routes",
		).toBeGreaterThanOrEqual(2);
		expect(postedToChat.filter((body) => body.includes(QUEUED_WORDS))).toEqual(
			[],
		);
	});

	test("the sidebar marks the chat while its question waits, and drops the mark once it is answered", async ({
		page,
	}) => {
		const { conversationId } = await startTurn(page, "one");
		const card = await expectWaitingCard(page);
		await ensureSidebarExpanded(page);

		// The chat's row carries a question mark, named for a screen reader and with no
		// words on screen.
		const row = sidebarRow(page, conversationId);
		await expect(row).toBeVisible();
		const mark = waitingMark(page, conversationId);
		await expect(mark).toBeVisible();
		await expect(mark).toHaveAttribute("aria-label", "Waiting for your answer");
		await expect(mark).not.toHaveAttribute("title");
		await expect(row).not.toContainText("Waiting for your answer");

		// A page that has just loaded gets it from the server's list, not from anything
		// this tab did.
		const fresh = await page.context().newPage();
		try {
			await fresh.setViewportSize(DESKTOP);
			await fresh.goto("/", { waitUntil: "domcontentloaded" });
			await waitForHydration(fresh);
			await ensureSidebarExpanded(fresh);
			await expect(sidebarRow(fresh, conversationId)).toBeVisible();
			await expect(waitingMark(fresh, conversationId)).toBeVisible();
			await expect(waitingMark(fresh, conversationId)).toHaveAttribute(
				"aria-label",
				"Waiting for your answer",
			);

			// The answer is taken: the mark goes with the card.
			await pressWhenAwake(
				card.getByRole("button", { name: "A party at home, recommended" }),
			);
			await expectCarriedOn(page, "A party at home");
			await expectReplyEnded(page);
			await expect(row).toBeVisible();
			await expect(mark).toHaveCount(0);

			// And a page that loads now gets the chat's row without it.
			await fresh.reload({ waitUntil: "domcontentloaded" });
			await waitForHydration(fresh);
			await ensureSidebarExpanded(fresh);
			await expect(sidebarRow(fresh, conversationId)).toBeVisible();
			await expect(waitingMark(fresh, conversationId)).toHaveCount(0);
		} finally {
			await fresh.close();
		}
		// The mark is still gone on the page that answered.
		await expect(mark).toHaveCount(0);
	});

	test("an answer given while the server updates waits and goes once it is back", async ({
		page,
	}) => {
		await startTurn(page, "one");
		const card = await expectWaitingCard(page);
		await expect(card.getByTestId("ask-up-to-you")).toBeEnabled();

		// The update begins with the card up, and the reader answers.
		await setDraining(page, true);
		await pressWhenAwake(
			card.getByRole("button", { name: "A party at home, recommended" }),
		);

		// The server turns the answer away as it turns any new turn away. The page waits
		// and says so under the card; the card keeps the answer and takes no other.
		const updating = page.getByTestId("awaiting-update-status");
		await expect(updating).toHaveText(UPDATING_STATUS);
		await expect(card).toBeVisible();
		await expect(
			card.getByRole("button", {
				name: "A party at home, recommended",
				pressed: true,
			}),
		).toBeVisible();
		await expect(card.getByTestId("ask-option")).toHaveCount(3);
		for (const control of [
			...(await card.getByTestId("ask-option").all()),
			card.getByTestId("ask-own-row"),
			card.getByTestId("ask-up-to-you"),
			card.getByTestId("ask-close"),
		]) {
			await expect(control).toBeDisabled();
		}
		// An answer that waits has not failed.
		await expect(card.getByTestId("ask-error")).toHaveCount(0);
		await waitForStableBoundingBox(card);
		await waitForStableBoundingBox(updating);
		const cardBox = await card.boundingBox();
		const updatingBox = await updating.boundingBox();
		expect(cardBox && updatingBox, "both are laid out").toBeTruthy();
		expect(updatingBox?.y).toBeGreaterThanOrEqual(
			(cardBox?.y ?? 0) + (cardBox?.height ?? 0) - 1,
		);
		// The model has not been asked for the rest.
		expect(chatRequests(fakeProvider)).toHaveLength(1);

		// The update is over: the page sends the answer by itself, and the card folds into
		// the line and the reply carries on.
		await setDraining(page, false);
		await expect(page.getByTestId("ask-folded")).toContainText(
			"A party at home",
			{ timeout: 30_000 },
		);
		await expect(card).toHaveCount(0);
		await expectCarriedOn(page, "A party at home");
		await expectReplyEnded(page);
		await expect(updating).toHaveCount(0);
		await expect.poll(() => chatRequests(fakeProvider).length).toBe(2);
		expectResumeOfFirstAsk(chatRequests(fakeProvider)[1]);
	});

	test("a reply cut off by a restart brings the card back with the answer in it", async ({
		page,
	}) => {
		const { conversationId } = await startTurn(page, "one");
		await expectWaitingCard(page);

		// What a restart leaves: the question was claimed by an answer whose resume the
		// restart ended. The row says "answering" with the answer on it, and the server's
		// memory of the resumes it runs is empty, so no stream stands behind it.
		const claimed = db
			.update(askQuestions)
			.set({
				status: "answering",
				answerJson: JSON.stringify({
					kind: "answered",
					answers: [{ picked: [0], ownWords: null }],
				}),
				answeredAt: new Date(),
			})
			.where(eq(askQuestions.conversationId, conversationId))
			.run();
		expect(claimed.changes, "the chat's one question row").toBe(1);
		await reloadChat(page);

		// The card waits again with the answer that did not go through: the pick is back
		// in it, and one line says so.
		const card = await expectWaitingCard(page);
		await expect(
			card.getByRole("button", {
				name: "A party at home, recommended",
				pressed: true,
			}),
		).toBeVisible();
		await expect(
			card.getByRole("button", {
				name: "Dinner out, just close family",
				pressed: false,
			}),
		).toBeVisible();
		await expect(card.getByRole("alert")).toHaveText(
			"Couldn't send your answer. Try again.",
		);
		expect(chatRequests(fakeProvider)).toHaveLength(1);

		// A press carries the reply on, as for a card that never had an answer.
		await pressWhenAwake(
			card.getByRole("button", { name: "A party at home, recommended" }),
		);
		await expect(page.getByTestId("ask-folded")).toContainText(
			"A party at home",
		);
		await expect(card).toHaveCount(0);
		await expectCarriedOn(page, "A party at home");
		await expectReplyEnded(page);
		await expect.poll(() => chatRequests(fakeProvider).length).toBe(2);
		expectResumeOfFirstAsk(chatRequests(fakeProvider)[1]);
		expect(
			answerTo(chatRequests(fakeProvider)[1], AI_SMOKE_ASK_CALL_ID),
		).toMatchObject({
			status: "answered",
			answers: [{ picked: ["A party at home"] }],
		});
	});
});
