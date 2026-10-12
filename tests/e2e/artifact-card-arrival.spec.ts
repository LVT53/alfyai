import { expect, type Locator, type Page, test } from "@playwright/test";
import { db } from "../../src/lib/server/db";
import { messages } from "../../src/lib/server/db/schema";
import {
	AI_SMOKE_LATE_CARD_FINAL_TEXT,
	AI_SMOKE_LATE_CARD_INTRO,
	AI_SMOKE_LATE_CARD_MARKER,
} from "../fixtures/ai/late-card-scenario";
import { createOpenAICompatibleProviderHarness } from "../mocks/ai-provider/openai-compatible-provider";
import {
	createTemporaryFakeProviderModel,
	deleteTemporaryProvider,
	snapshotUserModelPreference,
	updateUserModelPreference,
} from "./artifact-live-edit.helpers";
import { createEmptyConversation, login, sendMessage } from "./helpers";

// F16 (friction audit, ruling 77): an artifact card must not drop in late and
// push the text the reader is reading down. The scripted model says a few
// sentences, spends a moment writing the document, then calls
// `create_artifact`; the card, and the tool row that goes with it, arrive
// 2.5 s after the sentences did. Driven the way a reader does (type, press
// Send); the only code that is not input is observation: every frame, the
// position of the sentences on screen and what has arrived.

const INTRO_START = AI_SMOKE_LATE_CARD_INTRO[0].slice(0, 20);

type Frame = { t: number; top: number | null; cards: number; rows: number };

async function recordFrames(page: Page) {
	await page.evaluate((introStart) => {
		const frames: Frame[] = [];
		(window as unknown as { __frames: Frame[] }).__frames = frames;
		const tick = () => {
			let top: number | null = null;
			for (const paragraph of document.querySelectorAll(
				'[data-testid="assistant-message"] p',
			)) {
				if (paragraph.textContent?.startsWith(introStart)) {
					top = paragraph.getBoundingClientRect().top;
					break;
				}
			}
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
	}, INTRO_START);
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
			await page.waitForTimeout(800);
			await recordFrames(page);

			await sendMessage(page, AI_SMOKE_LATE_CARD_MARKER);
			await expect(page.getByTestId("artifact-card")).toBeVisible({
				timeout: 30_000,
			});
			await expect(page.getByText(AI_SMOKE_LATE_CARD_FINAL_TEXT)).toBeVisible({
				timeout: 30_000,
			});
			await page.waitForTimeout(800);

			const frames = (await readFrames(page)).filter(
				(frame) => frame.top !== null,
			);
			const arrival = frames.findIndex(
				(frame) => frame.cards > 0 || frame.rows > 0,
			);
			expect(arrival, "the card or its row arrived").toBeGreaterThan(0);

			// The sentences stay exactly where the reader was reading them, from
			// the frame before the card came to the end of the turn (the closing
			// sentence, the tool row settling, the thinking block folding).
			const before = frames[arrival - 1].top as number;
			const moved = frames
				.slice(arrival)
				.map((frame) => (frame.top as number) - before);
			expect(
				Math.max(...moved.map(Math.abs)),
				"how far the sentences moved after the card arrived, in px",
			).toBeLessThanOrEqual(1);

			// What the turn made comes after what it said.
			const sentences = page
				.getByTestId("assistant-message")
				.getByText(INTRO_START);
			const card = page.getByTestId("artifact-card");
			await expectBelow(card, sentences);
			return { page, sentences, card };
		} finally {
			await updateUserModelPreference(page, previousModelPreference);
			if (providerId) await deleteTemporaryProvider(page, providerId);
		}
	}

	test("does not push the sentences above it down, and sits below them, in a turn and after a reload", async ({
		page,
	}) => {
		test.setTimeout(120_000);
		const { sentences, card } = await runLateCardTurn(page, {
			earlierTurns: 0,
		});
		await page.reload({ waitUntil: "networkidle" });
		await expect(card).toBeVisible();
		await expectBelow(card, sentences);
	});

	test("keeps them where they are in a long chat too, where the card used to push them out of the window", async ({
		page,
	}) => {
		test.setTimeout(120_000);
		await runLateCardTurn(page, { earlierTurns: 10 });
	});
});
