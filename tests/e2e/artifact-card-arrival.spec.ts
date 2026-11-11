import { expect, type Locator, type Page, test } from "@playwright/test";
import { db } from "../../src/lib/server/db";
import { messages } from "../../src/lib/server/db/schema";
import {
	AI_SMOKE_LATE_CARD_FINAL_ANSWER,
	AI_SMOKE_LATE_CARD_HELD_MARKER,
	AI_SMOKE_LATE_CARD_HOLD,
	AI_SMOKE_LATE_CARD_INTRO,
	AI_SMOKE_LATE_CARD_OUTLINE,
	AI_SMOKE_LATE_CARD_TITLE,
} from "../fixtures/ai/late-card-scenario";
import { createOpenAICompatibleProviderHarness } from "../mocks/ai-provider/openai-compatible-provider";
import {
	createTemporaryFakeProviderModel,
	deleteTemporaryProvider,
	expectTerminalActivityGone,
	snapshotUserModelPreference,
	updateUserModelPreference,
} from "./artifact-live-edit.helpers";
import {
	createEmptyConversation,
	login,
	sendMessage,
	waitForMotionToSettle,
} from "./helpers";
import { holdThinkingCardDelivery } from "./thinking-display-barrier";

// F16 (friction audit, ruling 77): an artifact card must not drop in late and
// push the text the reader is reading down. The scripted model says a few
// sentences, spends a moment writing the document, then calls
// `create_artifact`; the card, and the tool row that goes with it, arrive
// 2.5 s after the sentences did. Driven the way a reader does (type, press
// Send); the only code that is not input is observation: every frame, the
// position of the sentences on screen and what has arrived.

type Frame = { t: number; top: number | null; cards: number; rows: number };

async function recordFrames(page: Page) {
	await page.evaluate(() => {
		const frames: Frame[] = [];
		(window as unknown as { __frames: Frame[] }).__frames = frames;
		const tick = () => {
			let top: number | null = null;
			const header = [
				...document.querySelectorAll(
					'[data-testid="assistant-message"] .thinking-header',
				),
			].at(-1);
			top = header?.getBoundingClientRect().top ?? null;
			frames.push({
				t: performance.now(),
				top,
				cards: document.querySelectorAll('[data-testid="artifact-card"]')
					.length,
				rows: document.querySelectorAll('[data-testid="tool-activity-row"]')
					.length,
			});
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	});
}

async function readFrames(page: Page): Promise<Frame[]> {
	return page.evaluate(
		() => (window as unknown as { __frames: Frame[] }).__frames,
	);
}

/** `lower` starts below the bottom edge of `upper`. */
async function expectBelow(lower: Locator, upper: Locator) {
	const lowerBox = await lower.boundingBox();
	const upperBox = await upper.boundingBox();
	expect(lowerBox && upperBox, "both are laid out").toBeTruthy();
	expect(
		(lowerBox?.y ?? 0) >= (upperBox?.y ?? 0) + (upperBox?.height ?? 0) - 1,
		`the card (top ${lowerBox?.y}) starts below the sentences (bottom ${(upperBox?.y ?? 0) + (upperBox?.height ?? 0)})`,
	).toBe(true);
}

/**
 * Earlier turns, as rows (the services run a statement better-sqlite3 refuses
 * inside the runner), so the thread is taller than the window and scrolls.
 */
async function seedEarlierTurns(conversationId: string, pairs: number) {
	const now = new Date();
	const answer =
		"Ez egy hosszabb korábbi válasz, amely több sort foglal el a beszélgetésben. ".repeat(
			6,
		);
	const rows = [];
	for (let index = 0; index < pairs; index += 1) {
		rows.push(
			{
				id: `${conversationId}-q${index}`,
				conversationId,
				messageSequence: index * 2 + 1,
				role: "user" as const,
				content: `Korábbi kérdés ${index + 1}`,
				createdAt: now,
			},
			{
				id: `${conversationId}-a${index}`,
				conversationId,
				messageSequence: index * 2 + 2,
				role: "assistant" as const,
				content: answer,
				createdAt: now,
			},
		);
	}
	await db.insert(messages).values(rows);
}

test.describe("an artifact card that arrives late", () => {
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

	/** Sends the scripted turn, lets it run, and says how far the sentences moved once the card was there. */
	async function runLateCardTurn(
		page: Page,
		options: { earlierTurns: number },
	) {
		await login(page);
		const previousModelPreference = await snapshotUserModelPreference(page);
		let providerId: string | null = null;
		try {
			const conversationId = await createEmptyConversation(page);
			if (options.earlierTurns > 0) {
				await seedEarlierTurns(conversationId, options.earlierTurns);
			}
			const provider = await createTemporaryFakeProviderModel(
				page,
				fakeProvider.baseURL,
			);
			providerId = provider.providerId;
			await updateUserModelPreference(page, provider.selectedModel);
			await page.goto(`/chat/${conversationId}`, { waitUntil: "networkidle" });
			// A thread that scrolls opens at its end; let it settle there.
			await waitForMotionToSettle(page);
			await recordFrames(page);

			const delivery = await holdThinkingCardDelivery(page);
			await sendMessage(page, AI_SMOKE_LATE_CARD_HELD_MARKER);
			await delivery.wait();
			await delivery.release();
			await expect(page.getByTestId("artifact-card")).toBeVisible({
				timeout: 30_000,
			});
			// Final synthesis is held: measure the existing live status, not working prose.
			await expect
				.poll(
					() =>
						fakeProvider
							.requests()
							.filter((r) => r.path === "/v1/chat/completions").length,
				)
				.toBe(2);
			const requests = fakeProvider
				.requests()
				.filter((r) => r.path === "/v1/chat/completions");
			const continuation = (
				requests[1].body as {
					messages: { role: string; content: string; tool_call_id?: string }[];
				}
			).messages;
			expect(
				continuation
					.filter((m) => m.role === "assistant")
					.map((m) => m.content)
					.join(""),
			).toContain(AI_SMOKE_LATE_CARD_INTRO.join(""));
			const results = continuation.filter((m) => m.role === "tool");
			expect(results).toHaveLength(1);
			expect(results[0].tool_call_id).toBe("call_fake_create_artifact_1");
			expect(JSON.parse(results[0].content)).toMatchObject({
				success: true,
				artifactId: expect.any(String),
				artifactType: "document",
				title: AI_SMOKE_LATE_CARD_TITLE,
			});
			const liveSentences = page
				.locator('[data-testid="assistant-message"] .thinking-header')
				.last();
			await expect(liveSentences).toBeVisible();
			await expect(page.getByTestId("stop-button")).toBeVisible();
			await waitForMotionToSettle(page);
			await expectBelow(page.getByTestId("artifact-card"), liveSentences);

			const frames = (await readFrames(page)).filter(
				(frame) => frame.top !== null,
			);
			const arrival = frames.findIndex(
				(frame) => frame.cards > 0 || frame.rows > 0,
			);
			expect(arrival, "the card or its row arrived").toBeGreaterThan(0);

			// Card arrival must not move the existing live status. The canonical
			// answer and its card ordering are checked after releasing synthesis.
			expect(
				frames.length - arrival,
				"post-arrival status samples",
			).toBeGreaterThan(0);
			const before = frames[arrival - 1].top as number;
			const moved = frames
				.slice(arrival)
				.map((frame) => (frame.top as number) - before);
			expect(
				Math.max(...moved.map(Math.abs)),
				"how far live status moved after the card arrived, in px",
			).toBeLessThanOrEqual(1);

			fakeProvider.release(AI_SMOKE_LATE_CARD_HOLD);
			// Identify this reply by its unique canonical outline, then pin its durable
			// message identity so seeded older answers and reload cannot change the target.
			const outlinedReply = page.getByTestId("assistant-message").filter({
				has: page
					.locator(".prose-container")
					.getByText(AI_SMOKE_LATE_CARD_OUTLINE, { exact: true }),
			});
			await expect(outlinedReply).toHaveCount(1);
			await expectTerminalActivityGone(page);
			const messageId = await outlinedReply.getAttribute("data-message-id");
			expect(messageId).toBeTruthy();
			const reply = page.locator(
				`[data-testid="assistant-message"][data-message-id=${JSON.stringify(messageId)}]`,
			);
			await expect(reply).toHaveCount(1);
			const answer = reply.locator(".prose-container");
			await expect(answer).toHaveText(AI_SMOKE_LATE_CARD_FINAL_ANSWER);
			// Useful partial answers survive synthesis and reload; working narration fades.
			const sentences = answer.getByText(AI_SMOKE_LATE_CARD_OUTLINE, {
				exact: true,
			});
			await expect(sentences).toBeVisible();
			expect(
				fakeProvider
					.requests()
					.filter((r) => r.path === "/v1/chat/completions"),
			).toHaveLength(2);
			const card = reply.getByTestId("artifact-card");
			await expect(card).toHaveCount(1);
			await expectBelow(card, sentences);
			return { page, answer, sentences, card };
		} finally {
			fakeProvider.release(AI_SMOKE_LATE_CARD_HOLD);
			await updateUserModelPreference(page, previousModelPreference);
			if (providerId) await deleteTemporaryProvider(page, providerId);
		}
	}

	// Renderer-only F16 oracle: an explicitly committed answer precedes a late
	// card. These synthetic client phases do not assert ModelRun can call tools
	// after entering its closing phase, or change any production role rules.
	test("keeps already committed answer prose fixed when a late card arrives", async ({
		page,
	}) => {
		await login(page);
		const conversationId = await createEmptyConversation(page);
		await page.goto(`/chat/${conversationId}`, { waitUntil: "networkidle" });
		await page.evaluate(() => {
			const original = window.fetch.bind(window);
			window.fetch = async (...args) => {
				const url = String(args[0] instanceof Request ? args[0].url : args[0]);
				if (!url.endsWith("/api/chat/stream")) return original(...args);
				const encoder = new TextEncoder();
				const scope = {
					version: 1,
					turnId: "display-turn",
					segmentId: "display-segment",
					attemptId: "display-attempt",
					stepId: "closing",
					phase: "closing",
				};
				const body = new ReadableStream<Uint8Array>({
					start(controller) {
						const write = (part: unknown) =>
							controller.enqueue(
								encoder.encode(`data: ${JSON.stringify(part)}\n\n`),
							);
						const output = (event: object) =>
							write({
								type: "data-normal-chat-output",
								data: { ...scope, ...event },
							});
						output({
							sequence: 0,
							type: "block_start",
							blockId: "answer",
							nativeId: "answer",
							kind: "text",
							role: "answer",
						});
						output({
							sequence: 1,
							type: "block_delta",
							blockId: "answer",
							text: "A committed answer stays here.",
						});
						Object.assign(window, {
							__deliverSyntheticCard: () => {
								// The client settles done onto an existing running segment.
								write({
									type: "data-tool-call",
									data: {
										name: "create_artifact",
										callId: "display-card",
										status: "running",
										input: {
											artifactType: "document",
											title: "Late display card",
										},
									},
								});
								write({
									type: "data-tool-call",
									data: {
										name: "create_artifact",
										callId: "display-card",
										status: "done",
										input: {
											artifactType: "document",
											title: "Late display card",
										},
										metadata: {
											ok: true,
											artifactId: "display-document",
											artifactKind: "document",
											artifactTitle: "Late display card",
										},
									},
								});
							},
							__finishSyntheticCard: () => {
								output({ sequence: 2, type: "block_end", blockId: "answer" });
								output({
									sequence: 3,
									type: "completion",
									completion: {
										version: 1,
										turnId: "display-turn",
										segmentId: "display-segment",
										phase: "closing",
										outcome: "answered",
										stopCause: "natural_stop",
										workingStopCause: "natural_stop",
										closingAttempted: true,
									},
								});
								write({ type: "finish", finishReason: "stop" });
								controller.enqueue(encoder.encode("data: [DONE]\n\n"));
								controller.close();
							},
						});
					},
				});
				return new Response(body, {
					headers: {
						"content-type": "text/event-stream",
						"x-vercel-ai-ui-message-stream": "v1",
					},
				});
			};
		});
		await sendMessage(page, "Synthetic late-card rendering check");
		const reply = page.getByTestId("assistant-message").last();
		const answer = reply
			.locator(".prose-container")
			.getByText("A committed answer stays here.", { exact: true });
		await expect(answer).toBeVisible();
		await waitForMotionToSettle(page);
		await page.evaluate(() => {
			const frames: { offset: number; card: boolean }[] = [];
			Object.assign(window, { __committedFrames: frames });
			const tick = () => {
				const reply = [
					...document.querySelectorAll('[data-testid="assistant-message"]'),
				].at(-1);
				const prose = reply?.querySelector(".prose-container p");
				const user = [
					...document.querySelectorAll('[data-testid="user-message"]'),
				].at(-1);
				if (prose && user)
					frames.push({
						offset:
							prose.getBoundingClientRect().top -
							user.getBoundingClientRect().top,
						card: !!reply?.querySelector('[data-testid="artifact-card"]'),
					});
				requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
		});
		try {
			await expect
				.poll(() =>
					page.evaluate(
						() =>
							(window as unknown as { __committedFrames: unknown[] })
								.__committedFrames.length,
					),
				)
				.toBeGreaterThanOrEqual(2);
			await page.evaluate(() =>
				(
					window as unknown as { __deliverSyntheticCard: () => void }
				).__deliverSyntheticCard(),
			);
			const card = reply.getByTestId("artifact-card");
			await expect(card).toBeVisible();
			await expectBelow(card, answer);
			await waitForMotionToSettle(page);
			const frames = await page.evaluate(
				() =>
					(
						window as unknown as {
							__committedFrames: { offset: number; card: boolean }[];
						}
					).__committedFrames,
			);
			const arrival = frames.findIndex((frame) => frame.card);
			expect(arrival, "committed prose baseline before card").toBeGreaterThan(
				0,
			);
			expect(
				frames.length - arrival,
				"committed prose samples after card",
			).toBeGreaterThan(0);
			const baseline = frames[arrival - 1].offset;
			expect(
				Math.max(
					...frames
						.slice(arrival)
						.map((frame) => Math.abs(frame.offset - baseline)),
				),
				"committed answer displacement in px",
			).toBeLessThanOrEqual(1);
			await expect(answer).toHaveText("A committed answer stays here.");
		} finally {
			await page.evaluate(() =>
				(
					window as unknown as { __finishSyntheticCard: () => void }
				).__finishSyntheticCard(),
			);
		}
	});

	test("does not push the sentences above it down, and sits below them, in a turn and after a reload", async ({
		page,
	}) => {
		test.setTimeout(120_000);
		const { answer, sentences, card } = await runLateCardTurn(page, {
			earlierTurns: 0,
		});
		await page.reload({ waitUntil: "networkidle" });
		await expect(card).toBeVisible();
		await expect(sentences).toBeVisible();
		await expect(answer).toHaveCount(1);
		await expect(answer).toHaveText(AI_SMOKE_LATE_CARD_FINAL_ANSWER);
		await expectTerminalActivityGone(page);
		await expectBelow(card, sentences);
	});

	test("keeps them where they are in a long chat too, where the card used to push them out of the window", async ({
		page,
	}) => {
		test.setTimeout(120_000);
		await runLateCardTurn(page, { earlierTurns: 10 });
	});
});
