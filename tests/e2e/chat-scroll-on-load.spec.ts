import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import { users } from "../../src/lib/server/db/schema";
import { createConversation as createServerConversation } from "../../src/lib/server/services/conversations";
import { createMessage } from "../../src/lib/server/services/messages";
import type { InstructionSuggestion } from "../../src/lib/shared/instructions";
import {
	buildAiSdkUiStreamBody,
	ensureSidebarExpanded,
	login,
	openConversationComposer,
	sendMessage,
	TEST_EMAIL,
	waitForHydration,
} from "./helpers";

/**
 * Where the conversation stands when it opens, and who moves it afterwards.
 *
 * A conversation that is taller than the window has to open on its latest
 * message: the end of the last reply (and anything drawn under it, such as an
 * instruction offer) above the composer, not hidden beneath it. That has to
 * hold however the page was reached — a link inside the app, a full load, a
 * reload, a switch in the sidebar — on a desktop window and on a phone. It
 * also has to survive what arrives after the first paint: every assistant
 * reply renders its markdown asynchronously, and images and fonts land later
 * still. And a reader who has scrolled up to read history must be left where
 * they are, by late content and by a streaming reply alike.
 *
 * Conversations are seeded rather than sent: what is under test is where the
 * thread sits, not how its replies came to be.
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const VIEWPORTS = [
	{ name: "desktop 1440x900", ...DESKTOP },
	{ name: "phone 390x844", ...PHONE },
] as const;

const LATE_IMAGE_PATH = "/e2e-scroll-late-image.svg";
const LATE_IMAGE_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900"><rect width="1200" height="900" fill="#b8945f"/></svg>';

function finalLineFor(label: string): string {
	return `Last line of the long answer about ${label}.`;
}

/**
 * A reply long enough to overflow both windows several times over, with a
 * fenced code block so the asynchronous highlighter is part of the render.
 */
function longReply(label: string, options: { lateImage?: boolean } = {}) {
	const parts = [`## A long answer about ${label}`, ""];
	for (let index = 1; index <= 24; index += 1) {
		parts.push(
			`Paragraph ${index} keeps the answer going with enough words that it wraps onto a couple of lines on a desktop window and onto several on a phone.`,
			"",
		);
		if (index === 12) {
			parts.push(
				"```ts",
				"export function double(value: number): number {",
				"\treturn value * 2;",
				"}",
				"```",
				"",
			);
		}
	}
	if (options.lateImage) {
		parts.push(`![A chart that loads late](${LATE_IMAGE_PATH})`, "");
	}
	parts.push(finalLineFor(label));
	return parts.join("\n");
}

async function adminUserId(): Promise<string> {
	const [row] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, TEST_EMAIL))
		.limit(1);
	if (!row) throw new Error(`Seeded user ${TEST_EMAIL} not found`);
	return row.id;
}

/**
 * Three turns; the last reply is the long one and carries an instruction
 * offer, so a row is drawn under it — the reply's own bottom is not the
 * bottom of the thread.
 */
async function seedLongConversation(
	label: string,
	options: { lateImage?: boolean; turns?: number } = {},
): Promise<string> {
	const conversation = await createServerConversation(
		await adminUserId(),
		`Scroll on load: ${label}`,
	);
	const turns = options.turns ?? 3;
	for (let turn = 1; turn <= turns; turn += 1) {
		const isLast = turn === turns;
		await createMessage(conversation.id, "user", `Question ${turn} about ${label}?`);
		const suggestion: InstructionSuggestion = {
			id: randomUUID(),
			status: "pending",
			text: "Always start with a one-line summary.",
			scope: { kind: "personal" },
			createdAt: Date.now(),
		};
		await createMessage(
			conversation.id,
			"assistant",
			isLast ? longReply(label, options) : `A short answer to question ${turn}.`,
			undefined,
			undefined,
			isLast ? { instructionSuggestions: [suggestion] } : undefined,
		);
	}
	return conversation.id;
}

type ThreadView = {
	scrollTop: number;
	maxScrollTop: number;
	viewportTop: number;
	composerTop: number;
	/** Bottom edge of the latest reply block, or of a row drawn under it. */
	latestBottom: number;
};

async function readThreadView(page: Page): Promise<ThreadView> {
	return page.evaluate(() => {
		const scroller = document.querySelector<HTMLElement>(".scroll-container");
		const composer = document.querySelector<HTMLElement>(".composer-shell");
		if (!scroller || !composer) throw new Error("The chat surface is not mounted.");
		const replies = scroller.querySelectorAll<HTMLElement>(
			'[data-testid="assistant-message"]',
		);
		const latestReply = replies[replies.length - 1];
		if (!latestReply) throw new Error("No assistant reply is rendered.");
		// The reply's whole block — text, action row, padding — not just the
		// text box inside it.
		const replyBlock = latestReply.parentElement ?? latestReply;
		let latestBottom = replyBlock.getBoundingClientRect().bottom;
		for (const row of scroller.querySelectorAll<HTMLElement>(
			'[data-testid="instruction-suggestion"]',
		)) {
			latestBottom = Math.max(latestBottom, row.getBoundingClientRect().bottom);
		}
		return {
			scrollTop: scroller.scrollTop,
			maxScrollTop: scroller.scrollHeight - scroller.clientHeight,
			viewportTop: scroller.getBoundingClientRect().top,
			composerTop: composer.getBoundingClientRect().top,
			latestBottom,
		};
	});
}

/** Resolves once the thread's scroll position has held still for a few frames. */
async function waitForScrollToSettle(page: Page) {
	await page.evaluate(
		() =>
			new Promise<void>((resolve) => {
				const scroller = document.querySelector<HTMLElement>(".scroll-container");
				if (!scroller) {
					resolve();
					return;
				}
				let last = scroller.scrollTop;
				let stillFrames = 0;
				let frames = 0;
				const step = () => {
					frames += 1;
					const current = scroller.scrollTop;
					stillFrames = current === last ? stillFrames + 1 : 0;
					last = current;
					if (stillFrames >= 5 || frames > 180) {
						resolve();
						return;
					}
					requestAnimationFrame(step);
				};
				requestAnimationFrame(step);
			}),
	);
}

/**
 * The reply has finished rendering: its markdown (the last line), and the
 * web fonts it is set in.
 */
async function waitForThreadRendered(page: Page, label: string) {
	await expect(page.getByText(finalLineFor(label))).toBeAttached({
		timeout: 15000,
	});
	await page.evaluate(() => document.fonts.ready.then(() => undefined));
	await waitForScrollToSettle(page);
}

/** The latest reply, and the row under it, end above the composer. */
async function expectLatestMessageInView(page: Page) {
	await expect
		.poll(
			async () => {
				const view = await readThreadView(page);
				return view.composerTop - view.latestBottom;
			},
			{
				message:
					"the bottom of the latest reply must sit above the composer (composerTop - latestBottom >= 0)",
				timeout: 5000,
			},
		)
		.toBeGreaterThanOrEqual(0);
	const view = await readThreadView(page);
	expect(
		view.latestBottom,
		"the bottom of the latest reply must be inside the thread's viewport, not scrolled past",
	).toBeGreaterThan(view.viewportTop);
}

/** Wheel over the middle of the thread, well clear of the composer. */
async function wheelThread(page: Page, deltaY: number) {
	const box = await page.locator(".scroll-container").boundingBox();
	if (!box) throw new Error("The thread is not measurable.");
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
	await page.mouse.wheel(0, deltaY);
	await waitForScrollToSettle(page);
}

/**
 * Holds the late image's response until `release()` is called, so it can be
 * made to land after the rest of the thread has settled.
 */
async function holdLateImage(page: Page) {
	let release: () => void = () => {};
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	let requested: () => void = () => {};
	const wasRequested = new Promise<void>((resolve) => {
		requested = resolve;
	});
	await page.route(`**${LATE_IMAGE_PATH}`, async (route) => {
		requested();
		await released;
		await route
			.fulfill({
				status: 200,
				contentType: "image/svg+xml",
				body: LATE_IMAGE_SVG,
			})
			.catch(() => {});
	});
	return { release: () => release(), wasRequested };
}

test.describe("chat scroll — opening a conversation", () => {
	for (const viewport of VIEWPORTS) {
		test(`a link inside the app opens a long conversation at its latest message (${viewport.name})`, async ({
			page,
		}) => {
			const label = `client navigation ${viewport.width}`;
			await page.setViewportSize(viewport);
			await login(page);
			const conversationId = await seedLongConversation(label);

			// The landing page lists the seeded conversation; following that link
			// is a client-side navigation, not a document load.
			await page.goto("/", { waitUntil: "domcontentloaded" });
			await waitForHydration(page);
			const link = page.locator(`a[href="/chat/${conversationId}"]`).first();
			await expect(link).toBeVisible({ timeout: 15000 });
			await link.click();
			await page.waitForURL(`**/chat/${conversationId}`);

			await waitForThreadRendered(page, label);
			await expectLatestMessageInView(page);
		});

		test(`a full load and a reload open a long conversation at its latest message (${viewport.name})`, async ({
			page,
		}) => {
			const label = `full load ${viewport.width}`;
			await page.setViewportSize(viewport);
			await login(page);
			const conversationId = await seedLongConversation(label);

			await page.goto(`/chat/${conversationId}`, {
				waitUntil: "domcontentloaded",
			});
			await waitForHydration(page);
			await waitForThreadRendered(page, label);
			await expectLatestMessageInView(page);

			// Reloaded from the latest message, it comes back to the latest
			// message — the thread re-renders from nothing behind the reload.
			await page.reload({ waitUntil: "domcontentloaded" });
			await waitForHydration(page);
			await waitForThreadRendered(page, label);
			await expectLatestMessageInView(page);
		});

		test(`switching conversations in the sidebar opens the next one at its latest message (${viewport.name})`, async ({
			page,
		}) => {
			const firstLabel = `sidebar switch from ${viewport.width}`;
			const secondLabel = `sidebar switch to ${viewport.width}`;
			await page.setViewportSize(viewport);
			await login(page);
			const firstId = await seedLongConversation(firstLabel, { turns: 4 });
			// Fewer messages than the conversation it is switched from: the
			// message count alone never announces the switch.
			const secondId = await seedLongConversation(secondLabel, { turns: 2 });

			await page.goto(`/chat/${firstId}`, { waitUntil: "domcontentloaded" });
			await waitForHydration(page);
			await waitForThreadRendered(page, firstLabel);

			if (viewport.width < 1024) {
				await page.locator(".mobile-sidebar-toggle").click();
			} else {
				await ensureSidebarExpanded(page);
			}
			await page
				.locator(
					`[data-testid="conversation-item"][data-conversation-id="${secondId}"]`,
				)
				.click();
			await page.waitForURL(`**/chat/${secondId}`);

			await waitForThreadRendered(page, secondLabel);
			await expectLatestMessageInView(page);
		});
	}

	test("a link to one message opens on that message, not the latest one", async ({
		page,
	}) => {
		// Search results and "jump to source" open a conversation on a given
		// message (`?focus_message=`); holding the latest message in view must
		// not fight that.
		const label = "focus a message";
		await page.setViewportSize(DESKTOP);
		await login(page);
		const conversation = await createServerConversation(
			await adminUserId(),
			`Scroll on load: ${label}`,
		);
		await createMessage(conversation.id, "user", "The first question?");
		const focused = await createMessage(
			conversation.id,
			"assistant",
			longReply("the first question"),
		);
		await createMessage(conversation.id, "user", "The second question?");
		await createMessage(conversation.id, "assistant", longReply(label));

		await page.goto(`/chat/${conversation.id}?focus_message=${focused.id}`, {
			waitUntil: "domcontentloaded",
		});
		await waitForHydration(page);
		await waitForThreadRendered(page, label);

		await expect(page.locator(`#message-${focused.id}`)).toBeInViewport();
		await expect(page.getByText(finalLineFor(label))).not.toBeInViewport();
	});

	test("a reload made while reading history comes back to that place, not the top", async ({
		page,
	}) => {
		const label = "reload while reading history";
		await page.setViewportSize(DESKTOP);
		await login(page);
		const conversationId = await seedLongConversation(label);
		await page.goto(`/chat/${conversationId}`, {
			waitUntil: "domcontentloaded",
		});
		await waitForHydration(page);
		await waitForThreadRendered(page, label);

		// Scroll up to the code block in the middle of the long reply.
		const code = page.locator(".scroll-container pre").first();
		await code.evaluate((node) => node.scrollIntoView({ block: "center" }));
		await waitForScrollToSettle(page);
		const readingPosition = (await readThreadView(page)).scrollTop;
		expect(readingPosition).toBeGreaterThan(0);

		await page.reload({ waitUntil: "domcontentloaded" });
		await waitForHydration(page);
		await waitForThreadRendered(page, label);

		await expect
			.poll(
				async () =>
					Math.abs((await readThreadView(page)).scrollTop - readingPosition),
				{
					message: "the reload must restore the reading position",
					timeout: 5000,
				},
			)
			.toBeLessThanOrEqual(2);
		await expect(code).toBeInViewport();
	});
});

test.describe("chat scroll — content that arrives late", () => {
	for (const viewport of VIEWPORTS) {
		test(`an image that lands after the thread settled keeps an unscrolled reader at the latest message (${viewport.name})`, async ({
			page,
		}) => {
			const label = `late image ${viewport.width}`;
			await page.setViewportSize(viewport);
			await login(page);
			const image = await holdLateImage(page);
			const conversationId = await seedLongConversation(label, {
				lateImage: true,
			});

			await page.goto(`/chat/${conversationId}`, {
				waitUntil: "domcontentloaded",
			});
			await waitForHydration(page);
			await waitForThreadRendered(page, label);
			await expectLatestMessageInView(page);

			await image.wasRequested;
			const before = await readThreadView(page);
			image.release();
			await expect(
				page.locator(".markdown-image-frame--loaded"),
			).toBeAttached({ timeout: 10000 });
			await waitForScrollToSettle(page);

			// The image really did make the thread taller...
			const after = await readThreadView(page);
			expect(after.maxScrollTop).toBeGreaterThan(before.maxScrollTop + 100);
			// ...and the reader who had not scrolled still sees its end.
			await expectLatestMessageInView(page);
		});

		test(`a reader who scrolled up is not pulled down when late content lands (${viewport.name})`, async ({
			page,
		}) => {
			const label = `scrolled up ${viewport.width}`;
			await page.setViewportSize(viewport);
			await login(page);
			const image = await holdLateImage(page);
			const conversationId = await seedLongConversation(label, {
				lateImage: true,
			});

			await page.goto(`/chat/${conversationId}`, {
				waitUntil: "domcontentloaded",
			});
			await waitForHydration(page);
			await waitForThreadRendered(page, label);
			// Wherever the thread opened, the reader goes to its end first and
			// then scrolls back up to read — so the late image is pending while
			// they read.
			await wheelThread(page, 20000);
			await image.wasRequested;
			await wheelThread(page, -700);
			const reading = await readThreadView(page);
			expect(reading.maxScrollTop - reading.scrollTop).toBeGreaterThan(300);

			image.release();
			await expect(
				page.locator(".markdown-image-frame--loaded"),
			).toBeAttached({ timeout: 10000 });
			await waitForScrollToSettle(page);

			const after = await readThreadView(page);
			expect(after.maxScrollTop).toBeGreaterThan(reading.maxScrollTop + 100);
			expect(
				Math.abs(after.scrollTop - reading.scrollTop),
				"the reader must stay where they scrolled to",
			).toBeLessThanOrEqual(1);
			await expect(page.getByTestId("jump-to-latest-button")).toBeVisible();
		});
	}
});

/**
 * A stand-in for `/api/chat/stream` that the test feeds one part at a time,
 * so the reply can be made to grow while the test scrolls. Installed before
 * the app loads; only the stream request is intercepted.
 */
async function installControllableChatStream(page: Page) {
	await page.addInitScript(() => {
		const nativeFetch = window.fetch.bind(window);
		const encoder = new TextEncoder();
		let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
		const harness = {
			isOpen: () => controller !== null,
			push(part: unknown) {
				controller?.enqueue(encoder.encode(`data: ${JSON.stringify(part)}\n\n`));
			},
			finish() {
				controller?.enqueue(encoder.encode("data: [DONE]\n\n"));
				controller?.close();
				controller = null;
			},
		};
		(window as unknown as { __chatStream: typeof harness }).__chatStream =
			harness;
		window.fetch = (input, init) => {
			const href =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.href
						: input.url;
			const method = (
				init?.method ?? (input instanceof Request ? input.method : "GET")
			).toUpperCase();
			if (
				new URL(href, window.location.href).pathname === "/api/chat/stream" &&
				method === "POST"
			) {
				const body = new ReadableStream<Uint8Array>({
					start(nextController) {
						controller = nextController;
					},
				});
				return Promise.resolve(
					new Response(body, {
						status: 200,
						headers: { "Content-Type": "text/event-stream" },
					}),
				);
			}
			return nativeFetch(input, init);
		};
	});
}

async function pushStreamParts(page: Page, parts: unknown[]) {
	await page.evaluate((nextParts) => {
		const harness = (
			window as unknown as { __chatStream: { push(part: unknown): void } }
		).__chatStream;
		for (const part of nextParts) harness.push(part);
	}, parts);
}

/**
 * Streams `count` sentences into the reply, one at a time, each waited for
 * until it is on the page. A sentence is at most a line of text: a real
 * stream arrives a few tokens at a time, and the follow is measured against
 * growth of that size, not a paragraph landing at once.
 */
async function streamSentences(page: Page, from: number, count: number) {
	for (let index = from; index < from + count; index += 1) {
		const sentence = `Streamed sentence ${index} goes on for a little while longer than before. `;
		await pushStreamParts(page, [
			{ type: "text-delta", id: "answer", delta: sentence },
		]);
		await expect(
			page.getByTestId("assistant-message").last(),
		).toContainText(sentence.trim(), { timeout: 10000 });
	}
}

test.describe("chat scroll — streaming", () => {
	test("a streamed reply follows the bottom while the reader stays there, and leaves a reader who scrolled up alone", async ({
		page,
	}) => {
		const label = "streaming follow";
		await page.setViewportSize(DESKTOP);
		await installControllableChatStream(page);
		await login(page);
		const conversationId = await seedLongConversation(label);
		await page.goto(`/chat/${conversationId}`, {
			waitUntil: "domcontentloaded",
		});
		await waitForHydration(page);
		await waitForThreadRendered(page, label);

		await sendMessage(page, "And one more thing?");
		await expect
			.poll(() =>
				page.evaluate(() =>
					(
						window as unknown as { __chatStream: { isOpen(): boolean } }
					).__chatStream.isOpen(),
				),
			)
			.toBe(true);

		// A reasoning model thinks first; the thread follows while it does.
		await pushStreamParts(page, [
			{ type: "reasoning-start", id: "reasoning" },
			{ type: "reasoning-delta", id: "reasoning", delta: "Working it out." },
			{ type: "reasoning-end", id: "reasoning" },
			{ type: "text-start", id: "answer" },
		]);
		await streamSentences(page, 1, 1);
		await waitForScrollToSettle(page);
		const startOfReply = await readThreadView(page);
		await streamSentences(page, 2, 40);
		await waitForScrollToSettle(page);
		const following = await readThreadView(page);
		expect(
			following.scrollTop,
			"the thread must have followed the reply down",
		).toBeGreaterThan(startOfReply.scrollTop + 400);

		// The reader scrolls up to read; the reply keeps growing below them.
		await wheelThread(page, -800);
		const reading = await readThreadView(page);
		expect(reading.maxScrollTop - reading.scrollTop).toBeGreaterThan(300);
		await streamSentences(page, 42, 15);
		await waitForScrollToSettle(page);
		const afterMore = await readThreadView(page);
		expect(afterMore.maxScrollTop).toBeGreaterThan(reading.maxScrollTop);
		expect(
			Math.abs(afterMore.scrollTop - reading.scrollTop),
			"streaming must not pull a reader who scrolled up back down",
		).toBeLessThanOrEqual(1);

		await pushStreamParts(page, [
			{ type: "text-end", id: "answer" },
			{ type: "finish", finishReason: "stop" },
		]);
		await page.evaluate(() =>
			(
				window as unknown as { __chatStream: { finish(): void } }
			).__chatStream.finish(),
		);
	});
});

test.describe("chat scroll — the landing page hand-off", () => {
	for (const viewport of VIEWPORTS) {
		test(`the first message sent from the landing page shows its reply above the composer (${viewport.name})`, async ({
			page,
		}) => {
			const reply =
				"Here is a short first answer, a few lines long, which has to be read in full above the composer.";
			await page.setViewportSize(viewport);
			await login(page);
			await page.route("**/api/chat/stream", async (route) => {
				await route.fulfill({
					status: 200,
					headers: {
						"Content-Type": "text/event-stream",
						"Cache-Control": "no-cache",
					},
					body: buildAiSdkUiStreamBody(reply),
				});
			});

			await openConversationComposer(page);
			await sendMessage(page, "Start a new conversation, please.");
			await page.waitForURL(/\/chat\//, { timeout: 15000 });
			await expect(page.getByTestId("assistant-message").first()).toContainText(
				reply,
				{ timeout: 20000 },
			);
			await waitForScrollToSettle(page);

			await expectLatestMessageInView(page);
			await expect(page.getByTestId("user-message").first()).toBeInViewport();
		});
	}
});
