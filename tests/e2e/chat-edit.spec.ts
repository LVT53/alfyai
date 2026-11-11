import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import {
	fileProductionJobs,
	messages,
	users,
} from "../../src/lib/server/db/schema";
import type { NormalChatOutputEvent } from "../../src/lib/shared/normal-chat-output";
import {
	AI_SMOKE_API_KEY,
	AI_SMOKE_MODEL_ID,
	AI_SMOKE_REFUSE_SLOWLY_MARKER,
} from "../fixtures/ai/openai-compatible-scenarios";
import { createOpenAICompatibleProviderHarness } from "../mocks/ai-provider/openai-compatible-provider";
import {
	completionToolsOff,
	completionWireMessages,
	currentScenarioUserText,
} from "../mocks/ai-provider/turn-completion-scripts";
import {
	createEmptyConversation,
	ensureSidebarExpanded,
	login,
	waitForHydration,
} from "./helpers";

// Editing a sent message happens in the real composer (the approved refresh):
// the pencil puts the message's text there, the bubble dims, the draft the
// person had is set aside and comes back afterwards, and when later replies
// would be deleted the strip says so in one line.

async function seedTurns(page: Page, turns: number, title = "Edit") {
	const conversationId = await createEmptyConversation(page, title);
	// All of it in the past: a turn sent into the chat afterwards comes after it.
	const base = Date.now() - (turns + 1) * 120_000;
	const userIds: string[] = [];
	const rows = [];
	for (let i = 1; i <= turns; i += 1) {
		const userId = randomUUID();
		userIds.push(userId);
		rows.push(
			{
				id: userId,
				conversationId,
				messageSequence: i * 2 - 1,
				role: "user" as const,
				content: `Question number ${i} about the lake`,
				createdAt: new Date(base + i * 120_000),
			},
			{
				id: randomUUID(),
				conversationId,
				messageSequence: i * 2,
				role: "assistant" as const,
				content: `Answer number ${i} about the lake.`,
				createdAt: new Date(base + i * 120_000 + 30_000),
			},
		);
	}
	await db.insert(messages).values(rows);
	return { conversationId, userIds };
}

async function open(page: Page, conversationId: string) {
	await page.goto(`/chat/${conversationId}`, { waitUntil: "domcontentloaded" });
	await expect(page.getByTestId("assistant-message").first()).toBeVisible();
	// A press before the page is hydrated lands on inert markup.
	await waitForHydration(page);
}

async function pressPencil(page: Page, userMessageId: string) {
	await page.locator(`[data-message-id="${userMessageId}"]`).hover();
	await page.locator(`#edit-button-${userMessageId}`).click();
}

/** What the server holds as this chat's draft: what a reload would find. */
async function savedDraft(page: Page, conversationId: string) {
	return page.evaluate(async (id) => {
		const response = await fetch(`/api/conversations/${id}`);
		const detail = (await response.json()) as {
			draft?: { draftText: string } | null;
		};
		return detail.draft?.draftText ?? null;
	}, conversationId);
}

/** The files the server holds in this chat's draft. */
async function savedDraftFileIds(page: Page, conversationId: string) {
	return page.evaluate(async (id) => {
		const response = await fetch(`/api/conversations/${id}`);
		const detail = (await response.json()) as {
			draft?: { selectedAttachmentIds: string[] } | null;
		};
		return detail.draft?.selectedAttachmentIds ?? [];
	}, conversationId);
}

async function saveDraft(page: Page, conversationId: string, text: string) {
	await page.evaluate(
		async ({ id, draftText }) => {
			await fetch(`/api/conversations/${id}/draft`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ draftText, selectedAttachmentIds: [] }),
			});
		},
		{ id: conversationId, draftText: text },
	);
}

/** Each e2e file keeps its own copy of the fake provider's setup, as the others do. */
async function pointTheUserAtFakeModel(page: Page, baseUrl: string) {
	return page.evaluate(
		async ({ apiKey, base, modelName }) => {
			const providerResponse = await fetch("/api/admin/providers", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: `fake_edit_provider_${Date.now()}`,
					displayName: "Fake Edit Provider",
					baseUrl: base,
					apiKey,
				}),
			});
			const { provider } = (await providerResponse.json()) as {
				provider?: { id: string };
			};
			if (!providerResponse.ok || !provider?.id) {
				throw new Error(`provider creation ${providerResponse.status}`);
			}
			try {
				const modelResponse = await fetch(
					`/api/admin/providers/${provider.id}/models/batch`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							models: [
								{
									name: modelName,
									displayName: "Fake Edit Model",
									contextLength: 131_072,
									supportsChat: true,
									supportsTools: true,
								},
							],
						}),
					},
				);
				const { models } = (await modelResponse.json()) as {
					models?: Array<{ id: string }>;
				};
				const modelId = models?.[0]?.id;
				if (!modelResponse.ok || !modelId) {
					throw new Error(`model creation ${modelResponse.status}`);
				}
				// Batch import sets context; the model PUT schema owns the output cap.
				const configured = await fetch(
					`/api/admin/providers/${provider.id}/models/${modelId}`,
					{
						method: "PUT",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							maxModelContext: 131_072,
							maxTokens: 4_096,
						}),
					},
				);
				const configuredBody = (await configured.json()) as {
					model?: { maxModelContext?: number; maxTokens?: number };
				};
				if (
					!configured.ok ||
					configuredBody.model?.maxModelContext !== 131_072 ||
					configuredBody.model?.maxTokens !== 4_096
				) {
					throw new Error(
						`Fake edit model capacity configuration failed (${configured.status})`,
					);
				}
				const preference = await fetch("/api/settings/preferences", {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						preferredModel: `provider:${provider.id}:${modelId}`,
					}),
				});
				if (!preference.ok) throw new Error(`model ${preference.status}`);
				return provider.id;
			} catch (error) {
				try {
					const cleanup = await fetch(`/api/admin/providers/${provider.id}`, {
						method: "DELETE",
					});
					if (!cleanup.ok)
						throw new Error(`provider cleanup ${cleanup.status}`);
				} catch (cleanupError) {
					throw new AggregateError(
						[error, cleanupError],
						"Fake edit model setup and provider cleanup failed",
					);
				}
				throw error;
			}
		},
		{ apiKey: AI_SMOKE_API_KEY, base: baseUrl, modelName: AI_SMOKE_MODEL_ID },
	);
}

async function restoreTheUsersModel(page: Page, providerId: string) {
	await page.evaluate(async (id) => {
		await fetch("/api/settings/preferences", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ preferredModel: null }),
		});
		await fetch(`/api/admin/providers/${id}`, { method: "DELETE" });
	}, providerId);
}

/** Where the provider's model is asked: an address nothing listens on is a model that is down, the fake provider's own is a model that is back. */
async function setProviderBaseUrl(
	page: Page,
	providerId: string,
	baseUrl: string,
) {
	const response = await page.request.put(
		`/api/admin/providers/${providerId}`,
		{ data: { baseUrl } },
	);
	expect(response.ok(), `provider update -> ${response.status()}`).toBe(true);
}

/** A chat with nothing said in it yet, open and ready for its first message. */
async function openEmptyChat(page: Page, conversationId: string) {
	await page.goto(`/chat/${conversationId}`, { waitUntil: "domcontentloaded" });
	await expect(page.getByTestId("message-input")).toBeEnabled();
	await waitForHydration(page);
}

/**
 * Holds the next turn the page sends, at the browser, until `release` is called:
 * a reply that is still coming, with the composer free to type into. Release it
 * before the test ends.
 */
async function holdTheNextTurn(page: Page) {
	let release: () => void = () => undefined;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/api/chat/stream", async (route) => {
		await held;
		// A turn the page stopped while it was held has been dealt with already.
		await route.continue().catch(() => undefined);
	});
	return release;
}

/**
 * True once the server has finished the turn's own work after the reply. The
 * reply is on screen before that: the stream ends first, then the server writes
 * the turn's state (where a landed turn deals with the draft) and only then its
 * evidence, so a settled evidence status says a draft was left on purpose.
 */
async function turnHasSettled(conversationId: string) {
	const [reply] = await db
		.select({ metadataJson: messages.metadataJson })
		.from(messages)
		.where(
			and(
				eq(messages.conversationId, conversationId),
				eq(messages.role, "assistant"),
			),
		);
	const status = reply?.metadataJson
		? (JSON.parse(reply.metadataJson) as { evidenceStatus?: string })
				.evidenceStatus
		: undefined;
	return status === "ready" || status === "none" || status === "failed";
}

/**
 * A text file picked in the composer and uploaded through the real routes: the
 * library item's id, once its chip is up and no longer busy. Text is read in the
 * server's own process, so the e2e build (which has no document service) can
 * send it.
 */
async function attachTextFile(
	page: Page,
	name: string,
	text: string,
): Promise<string> {
	const fileInput = page.locator('input[type="file"]').first();
	// The composer is rendered on the server with its input disabled until it
	// hydrates; a disabled input takes no files.
	await expect(fileInput).toBeEnabled({ timeout: 20_000 });
	const uploaded = page.waitForResponse(
		(response) =>
			response.request().method() === "POST" &&
			response.url().endsWith("/api/knowledge/upload/raw"),
	);
	await fileInput.setInputFiles({
		name,
		mimeType: "text/plain",
		buffer: Buffer.from(text),
	});
	const response = await uploaded;
	expect(response.ok(), `upload -> ${response.status()}`).toBe(true);
	const { artifact } = (await response.json()) as { artifact: { id: string } };
	const chip = page
		.getByTestId("composer-chip-attachment")
		.filter({ hasText: name });
	await expect(chip).toBeVisible();
	await expect(chip).not.toHaveAttribute("aria-busy", "true", {
		timeout: 15_000,
	});
	return artifact.id;
}

type SavedMessage = {
	id: string;
	role: string;
	content: string;
	attachments?: Array<{ artifactId: string; name: string }>;
	normalChatOutput?: { version: 1; events: NormalChatOutputEvent[] };
};

type MeasuredEditRect = { top: number; bottom: number; height: number };
type FastEditGeometrySample = {
	time: number;
	frame: number;
	reason: string;
	user: MeasuredEditRect | null;
	body: MeasuredEditRect | null;
	wholeFrame: MeasuredEditRect | null;
	status: MeasuredEditRect | null;
	statusText?: string;
	actions: Array<{ label: string | null; bounds: MeasuredEditRect | null }>;
	composer: MeasuredEditRect | null;
	scroller: MeasuredEditRect | null;
	scrollTop?: number;
	scrollHeight?: number;
	clientHeight?: number;
};
type FastEditGeometryProbe = {
	armed: boolean;
	sse: string;
	headers: Record<string, string>;
	status: number;
	userInserted: number | null;
	delivered: number | null;
	terminalDOM: number | null;
	firstAlignmentWrite: number | null;
	browserBody: Record<string, unknown> | null;
	samples: FastEditGeometrySample[];
	stable: number;
	geometryKey: string;
	frame: number;
	snapshot: (reason: string) => FastEditGeometrySample;
	resolveResponse?: (response: Response) => void;
};

/** What the server holds of the chat, in order: what a reload would show. */
async function savedMessages(
	page: Page,
	conversationId: string,
): Promise<SavedMessage[]> {
	return page.evaluate(async (id) => {
		const response = await fetch(`/api/conversations/${id}`);
		const detail = (await response.json()) as { messages?: SavedMessage[] };
		return detail.messages ?? [];
	}, conversationId);
}

/** Every request the page makes to the chat routes and the message delete, in order, as "METHOD /path". */
function watchChatRequests(page: Page): string[] {
	const seen: string[] = [];
	page.on("request", (request) => {
		const { pathname } = new URL(request.url());
		if (
			pathname.startsWith("/api/chat/") ||
			/^\/api\/conversations\/[^/]+\/messages$/.test(pathname)
		) {
			seen.push(`${request.method()} ${pathname}`);
		}
	});
	return seen;
}

test.describe("Editing a message in the composer", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("the pencil moves the message into the composer; sending deletes the later turns and the earlier draft comes back", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		const { conversationId, userIds } = await seedTurns(page, 4);
		await open(page, conversationId);
		const composer = page.getByTestId("message-input");
		await composer.fill("a half-written thought");

		await pressPencil(page, userIds[1]);

		// The composer holds the message, the strip says what is going on, and the
		// message itself steps back.
		await expect(composer).toHaveValue("Question number 2 about the lake");
		const strip = page.getByTestId("composer-edit-strip");
		await expect(strip).toBeVisible();
		await expect(page.getByTestId("composer-edit-label")).toHaveText(
			"2 later replies will be deleted.",
		);
		await expect(page.locator(`[data-message-id="${userIds[1]}"]`)).toHaveClass(
			/being-edited/,
		);
		await expect(page.locator(`#edit-button-${userIds[1]}`)).toHaveCount(0);
		await expect(page.getByTestId("composer-edit-strip")).toBeVisible();
		// The faces that would add to the edit are off.
		await expect(page.getByTestId("attach-toggle")).toBeDisabled();
		await expect(page.getByTestId("composer-tools-trigger")).toBeDisabled();

		await composer.fill("Question number 2, asked again");
		await page.getByTestId("send-button").click();

		// Everything from the edited message on is gone; the new question is there.
		await expect(page.getByText("Answer number 3 about the lake.")).toHaveCount(
			0,
		);
		await expect(page.getByText("Answer number 4 about the lake.")).toHaveCount(
			0,
		);
		await expect(
			page.getByText("Question number 4 about the lake"),
		).toHaveCount(0);
		await expect(
			page.getByText("Question number 2, asked again"),
		).toBeVisible();
		await expect(
			page.getByText("Answer number 1 about the lake."),
		).toBeVisible();
		// The composer is the person's again, with the draft they had.
		await expect(page.getByTestId("composer-edit-strip")).toHaveCount(0);
		await expect(composer).toHaveValue("a half-written thought");
	});

	test("cancel keeps every message and the draft, by the button and by Esc", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		const { conversationId, userIds } = await seedTurns(page, 3);
		await open(page, conversationId);
		const composer = page.getByTestId("message-input");
		await composer.fill("keep me");

		await pressPencil(page, userIds[0]);
		await expect(page.getByTestId("composer-edit-strip")).toBeVisible();
		await page.getByTestId("composer-edit-cancel").click();

		await expect(page.getByTestId("composer-edit-strip")).toHaveCount(0);
		await expect(composer).toHaveValue("keep me");
		await expect(page.getByTestId("user-message")).toHaveCount(3);
		await expect(page.getByTestId("assistant-message")).toHaveCount(3);
		await expect(
			page.locator(`[data-message-id="${userIds[0]}"]`),
		).not.toHaveClass(/being-edited/);

		await pressPencil(page, userIds[2]);
		await expect(page.getByTestId("composer-edit-label")).toHaveText(
			"Edit message",
		);
		await composer.press("Escape");

		await expect(page.getByTestId("composer-edit-strip")).toHaveCount(0);
		await expect(composer).toHaveValue("keep me");
		await expect(page.getByTestId("user-message")).toHaveCount(3);
	});

	test("a reload keeps the saved draft, in the middle of an edit too", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		const { conversationId, userIds } = await seedTurns(page, 2);
		await open(page, conversationId);
		const composer = page.getByTestId("message-input");
		await composer.fill("a half-written thought");
		await expect
			.poll(() => savedDraft(page, conversationId))
			.toBe("a half-written thought");

		await page.reload();
		await expect(composer).toHaveValue("a half-written thought");

		await waitForHydration(page);
		await pressPencil(page, userIds[0]);
		await composer.fill("words that were never sent");
		await page.reload();

		// The edit is gone with the page, and it never became the draft.
		await expect(composer).toHaveValue("a half-written thought");
		await expect(page.getByTestId("composer-edit-strip")).toHaveCount(0);
		// Past the page's draft debounce, so anything wrongly emitted has landed.
		await page.waitForTimeout(600);
		expect(await savedDraft(page, conversationId)).toBe(
			"a half-written thought",
		);
	});

	for (const setAside of ["", "a draft of chat one"]) {
		test(`moving to another chat keeps both chats' drafts (${setAside ? "a draft set aside" : "nothing set aside"})`, async ({
			page,
		}) => {
			await page.setViewportSize({ width: 1280, height: 900 });
			const chatOne = await seedTurns(page, 2, "Chat one");
			const chatTwo = await seedTurns(page, 1, "Chat two");
			await saveDraft(page, chatTwo.conversationId, "a draft of chat two");
			await open(page, chatOne.conversationId);
			const composer = page.getByTestId("message-input");
			if (setAside) {
				await composer.fill(setAside);
				await expect
					.poll(() => savedDraft(page, chatOne.conversationId))
					.toBe(setAside);
			}
			await ensureSidebarExpanded(page);
			await pressPencil(page, chatOne.userIds[0]);
			await expect(page.getByTestId("composer-edit-strip")).toBeVisible();

			await page
				.locator(
					`[data-testid="conversation-item"][data-conversation-id="${chatTwo.conversationId}"]`,
				)
				.click();

			await expect(page).toHaveURL(new RegExp(chatTwo.conversationId));
			await expect(composer).toHaveValue("a draft of chat two");
			await expect(page.getByTestId("composer-edit-strip")).toHaveCount(0);
			// Past the page's draft debounce, so anything wrongly emitted has landed.
			await page.waitForTimeout(600);
			expect(await savedDraft(page, chatTwo.conversationId)).toBe(
				"a draft of chat two",
			);
			expect(await savedDraft(page, chatOne.conversationId)).toBe(
				setAside || null,
			);
		});
	}

	test("sending an edit takes the reader to the new turn, wherever they had scrolled", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1280, height: 720 });
		const { conversationId, userIds } = await seedTurns(page, 10);
		const provider = createOpenAICompatibleProviderHarness();
		let providerId: string | null = null;
		let releaseResponse = () => {};
		const responseGate = new Promise<void>((resolve) => {
			releaseResponse = resolve;
		});
		let noteRequestStarted = () => {};
		const requestStarted = new Promise<void>((resolve) => {
			noteRequestStarted = resolve;
		});
		let inFlight: Promise<void> | undefined;
		const streamUrl = "**/api/chat/stream";
		try {
			await provider.start();
			providerId = await pointTheUserAtFakeModel(page, provider.baseURL);
			await open(page, conversationId);
			await pressPencil(page, userIds[8]);
			await page.getByTestId("message-input").fill("Question 9, asked again");

			await page.evaluate(() => {
				const scroller =
					document.querySelector<HTMLElement>(".scroll-container");
				if (scroller) scroller.scrollTop = 0;
			});
			await expect(
				page.locator(`[data-message-id="${userIds[0]}"]`),
			).toBeInViewport();
			await page.route(streamUrl, async (route) => {
				if (route.request().method() !== "POST") {
					await route.continue();
					return;
				}
				inFlight = (async () => {
					const response = await route.fetch();
					// Observe the initial edit reveal before delivering the actual reply.
					// The separate immediate-terminal case protects fast live-end geometry.
					await responseGate;
					await route.fulfill({ response });
				})();
				noteRequestStarted();
				await inFlight;
			});
			await page.getByTestId("send-button").click();

			await expect(page.getByText("Question 9, asked again")).toBeInViewport({
				timeout: 10_000,
			});
			releaseResponse();
			await requestStarted;
			await inFlight;
			await expect(
				page
					.getByTestId("assistant-message")
					.last()
					.locator(".prose-container")
					.getByText(/fake provider response/i),
			).toBeVisible();
			await expect(page.getByTestId("stop-button")).toHaveCount(0);
			await expect(page.getByTestId("send-button")).toBeVisible();
		} finally {
			// Also release and drain the real request if the reveal assertion fails.
			releaseResponse();
			try {
				await inFlight?.catch(() => undefined);
				await page.unroute(streamUrl);
				if (providerId) await restoreTheUsersModel(page, providerId);
			} finally {
				await provider.stop();
			}
		}
	});

	test.describe("immediate edit response delivery", () => {
		const fastFailureProvider = createOpenAICompatibleProviderHarness();
		test.beforeAll(async () => {
			await fastFailureProvider.start();
		});
		test.afterAll(async () => {
			await fastFailureProvider.stop();
		});

		test("an immediate failed edit reveals its terminal status and actions above the composer", async ({
			page,
		}, info) => {
			await page.setViewportSize({ width: 1280, height: 720 });
			const { conversationId, userIds } = await seedTurns(page, 10);
			// A real provider failure, not invented terminal wire. It completes once
			// on the server before its exact saved SSE is delivered to the browser.
			const editedText = `${AI_SMOKE_REFUSE_SLOWLY_MARKER} Question 9, asked again`;
			const providerId = await pointTheUserAtFakeModel(
				page,
				fastFailureProvider.baseURL,
			);
			const key = "__fastTerminalEditGeometry";
			await page.addInitScript(
				({ key }) => {
					const nativeRAF = window.requestAnimationFrame.bind(window);
					const originalFetch = window.fetch.bind(window);
					const probe: FastEditGeometryProbe = {
						armed: false,
						sse: "",
						headers: {},
						status: 200,
						userInserted: null,
						delivered: null,
						terminalDOM: null,
						firstAlignmentWrite: null,
						browserBody: null,
						samples: [],
						stable: 0,
						geometryKey: "",
						frame: 0,
						snapshot: () => {
							throw new Error("Probe not initialized");
						},
					};
					Reflect.set(window, key, probe);
					const rect = (
						element: Element | null | undefined,
					): MeasuredEditRect | null => {
						if (!element) return null;
						const { top, bottom, height } = element.getBoundingClientRect();
						return { top, bottom, height };
					};
					probe.snapshot = (reason) => {
						const scroller =
							document.querySelector<HTMLElement>(".scroll-container");
						const user = [
							...document.querySelectorAll('[data-testid="user-message"]'),
						].find((element) =>
							element.textContent?.includes("Question 9, asked again"),
						);
						const body = [
							...document.querySelectorAll('[data-testid="assistant-message"]'),
						].at(-1);
						const frame = body?.parentElement;
						const status = frame?.querySelector(
							'[data-testid="normal-chat-output-status"]',
						);
						const actions = [
							...(frame?.querySelectorAll(".copy-action-row button") ?? []),
						]
							.filter((button) => button.getBoundingClientRect().height > 0)
							.map((button) => ({
								label: button.getAttribute("aria-label"),
								bounds: rect(button),
							}));
						const sample = {
							time: performance.now(),
							frame: probe.frame,
							reason,
							user: rect(user),
							body: rect(body),
							wholeFrame: rect(frame),
							status: rect(status),
							statusText: status?.textContent?.trim(),
							actions,
							composer: rect(document.querySelector(".composer-layer")),
							scroller: rect(scroller),
							scrollTop: scroller?.scrollTop,
							scrollHeight: scroller?.scrollHeight,
							clientHeight: scroller?.clientHeight,
						};
						if (probe.armed && probe.samples.length < 600)
							probe.samples.push(sample);
						return sample;
					};
					const descriptor = Object.getOwnPropertyDescriptor(
						Element.prototype,
						"scrollTop",
					);
					if (!descriptor?.set)
						throw new Error("Missing native scrollTop setter");
					const setScrollTop = descriptor.set;
					// Observe native writes; never change their value, scheduling or target.
					Object.defineProperty(Element.prototype, "scrollTop", {
						...descriptor,
						set(this: Element, value: number) {
							setScrollTop.call(this, value);
							if (probe.armed && this.classList.contains("scroll-container")) {
								const sample = probe.snapshot("native-alignment-write");
								if (sample.user && probe.firstAlignmentWrite === null)
									probe.firstAlignmentWrite = sample.time;
							}
						},
					});
					const deliver = () => {
						if (!probe.armed) return;
						const sample = probe.snapshot("dom-mutation");
						if (sample.user && probe.userInserted === null)
							probe.userInserted = sample.time;
						if (
							sample.statusText === "Reply failed" &&
							probe.terminalDOM === null
						) {
							probe.terminalDOM = sample.time;
							// Only postterminal native frames can establish settled geometry.
							probe.stable = 0;
							probe.geometryKey = "";
						}
						if (
							sample.user &&
							probe.resolveResponse &&
							probe.delivered === null
						) {
							probe.delivered = performance.now();
							const resolve = probe.resolveResponse;
							delete probe.resolveResponse;
							resolve(
								new Response(probe.sse, {
									status: probe.status,
									headers: probe.headers,
								}),
							);
						}
					};
					new MutationObserver(deliver).observe(document, {
						subtree: true,
						childList: true,
						attributes: true,
					});
					window.fetch = (input, init) => {
						const url =
							typeof input === "string"
								? input
								: input instanceof URL
									? input.href
									: input.url;
						if (
							probe.armed &&
							new URL(url, location.href).pathname === "/api/chat/stream" &&
							init?.method === "POST"
						) {
							probe.browserBody = JSON.parse(String(init.body));
							return new Promise<Response>((resolve) => {
								probe.resolveResponse = resolve;
								deliver();
							});
						}
						return originalFetch(input, init);
					};
					const observeFrame = () => {
						probe.frame += 1;
						if (probe.armed) {
							const sample = probe.snapshot("native-frame");
							const geometry = JSON.stringify([
								sample.user,
								sample.wholeFrame,
								sample.status,
								sample.actions,
								sample.composer,
								sample.scroller,
								sample.scrollTop,
								sample.scrollHeight,
							]);
							probe.stable =
								geometry === probe.geometryKey ? probe.stable + 1 : 0;
							probe.geometryKey = geometry;
						}
						nativeRAF(observeFrame);
					};
					nativeRAF(observeFrame);
				},
				{ key },
			);
			let checked: Record<string, unknown> | undefined;
			page.on("request", (request) => {
				if (
					request.method() === "POST" &&
					new URL(request.url()).pathname === "/api/chat/turn-check"
				)
					checked = request.postDataJSON();
			});
			let upstreamPayload: Record<string, unknown> | undefined;
			const deleteUrl = `**/api/conversations/${conversationId}/messages`;
			try {
				await open(page, conversationId);
				await pressPencil(page, userIds[8]);
				await page.getByTestId("message-input").fill(editedText);
				await page.evaluate(() => {
					const scroller =
						document.querySelector<HTMLElement>(".scroll-container");
					if (scroller) scroller.scrollTop = 0;
				});
				await expect(
					page.locator(`[data-message-id="${userIds[0]}"]`),
				).toBeInViewport();
				await page.route(deleteUrl, async (route) => {
					if (route.request().method() !== "DELETE") {
						await route.continue();
						return;
					}
					const deleted = await route.fetch();
					expect(deleted.ok()).toBe(true);
					if (!checked) throw new Error("Missing real edit preflight");
					upstreamPayload = {
						message: editedText,
						conversationId,
						streamId: randomUUID(),
						model: checked.model,
						skipPersistUserMessage: false,
						attachmentIds: [],
						linkedSources: [],
						pendingSkill: null,
						reasoningDepth: "thorough",
						personalityProfileId: null,
						isEditResend: true,
					};
					const response = await page.request.post("/api/chat/stream", {
						data: upstreamPayload,
					});
					const sse = await response.text();
					expect(sse).toContain('"outcome":"failed"');
					const attempts = fastFailureProvider
						.requests()
						.filter(
							(request) => currentScenarioUserText(request.body) === editedText,
						);
					expect(attempts).toHaveLength(2);
					expect(
						attempts.map((request) => completionToolsOff(request.body)),
					).toEqual([false, false]);
					expect(completionWireMessages(attempts[1].body)).toEqual(
						completionWireMessages(attempts[0].body),
					);
					await page.evaluate(
						({ key, sse, status, headers }) => {
							const probe = Reflect.get(window, key) as FastEditGeometryProbe;
							Object.assign(probe, { sse, status, headers, armed: true });
						},
						{
							key,
							sse,
							status: response.status(),
							headers: response.headers(),
						},
					);
					await route.fulfill({ response: deleted });
				});
				await page.getByTestId("send-button").click();
				await page.waitForFunction(
					(key) => {
						const probe = Reflect.get(window, key) as FastEditGeometryProbe;
						return probe.terminalDOM !== null && probe.stable >= 8;
					},
					key,
					{ polling: 25 },
				);
				const observation = await page.evaluate((key) => {
					const p = Reflect.get(window, key) as FastEditGeometryProbe;
					return {
						userInserted: p.userInserted,
						delivered: p.delivered,
						terminalDOM: p.terminalDOM,
						firstAlignmentWrite: p.firstAlignmentWrite,
						browserBody: p.browserBody,
						settled: p.snapshot("settled"),
						samples: p.samples,
					};
				}, key);
				await info.attach("immediate-terminal-geometry", {
					body: JSON.stringify({ upstreamPayload, ...observation }),
					contentType: "application/json",
				});
				if (!observation.browserBody || !upstreamPayload)
					throw new Error("Missing captured transport bodies");
				// The sole real turn is prefetched under its own streamId. Exact saved
				// SSE/row IDs and all other request fields match. This proves layout,
				// not native transport timing, cancellation, reconnect or execution identity.
				const { streamId: browserStreamId, ...browserBody } =
					observation.browserBody;
				const { streamId: upstreamStreamId, ...upstreamBody } = upstreamPayload;
				expect(typeof browserStreamId).toBe("string");
				expect(typeof upstreamStreamId).toBe("string");
				expect(browserBody).toEqual(upstreamBody);
				if (
					observation.userInserted === null ||
					observation.delivered === null ||
					observation.terminalDOM === null ||
					observation.firstAlignmentWrite === null
				)
					throw new Error("Missing required ordering observation");
				expect(observation.userInserted).toBeLessThanOrEqual(
					observation.delivered,
				);
				expect(observation.delivered).toBeLessThan(
					observation.firstAlignmentWrite,
				);
				expect(observation.terminalDOM).toBeLessThan(
					observation.firstAlignmentWrite,
				);
				const s = observation.settled;
				if (!s.scroller || !s.composer)
					throw new Error("Missing effective viewport");
				const top = s.scroller.top;
				const bottom = Math.min(s.scroller.bottom, s.composer.top);
				const readable = (r: MeasuredEditRect | null) =>
					Boolean(r && r.top >= top && r.bottom <= bottom);
				expect(s.statusText).toBe("Reply failed");
				expect(
					readable(s.status),
					"terminal failure status above composer",
				).toBe(true);
				expect(s.actions.map((action) => action.label)).toEqual(
					expect.arrayContaining([
						"Info",
						"Regenerate response",
						"Copy message",
					]),
				);
				for (const action of s.actions)
					expect(
						readable(action.bounds),
						`${action.label} lies inside scroller above composer`,
					).toBe(true);
			} finally {
				await page.unroute(deleteUrl);
				await restoreTheUsersModel(page, providerId);
			}
		});
	});

	test("a delete that fails keeps the edit, what was typed and the messages; sending again works", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		const { conversationId, userIds } = await seedTurns(page, 3);
		await open(page, conversationId);
		await pressPencil(page, userIds[0]);
		const composer = page.getByTestId("message-input");
		await composer.fill("Question number 1, asked again");
		const deleteRoute = `**/api/conversations/${conversationId}/messages`;
		await page.route(deleteRoute, (route) =>
			route.request().method() === "DELETE"
				? route.fulfill({ status: 500, json: { error: "Delete failed" } })
				: route.fallback(),
		);

		await page.getByTestId("send-button").click();

		await expect(page.getByText("Delete failed")).toBeVisible();
		await expect(page.getByTestId("composer-edit-strip")).toBeVisible();
		await expect(composer).toHaveValue("Question number 1, asked again");
		await expect(
			page.getByText("Answer number 3 about the lake."),
		).toBeVisible();

		await page.unroute(deleteRoute);
		await page.getByTestId("send-button").click();

		await expect(page.getByText("Answer number 3 about the lake.")).toHaveCount(
			0,
		);
		await expect(page.getByTestId("composer-edit-strip")).toHaveCount(0);
	});

	test("while an edit is open the replies offer no way to start another turn", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		const { conversationId, userIds } = await seedTurns(page, 2);
		await open(page, conversationId);
		const regenerate = page.getByRole("button", { name: "Regenerate" });
		const pencils = page.getByRole("button", { name: "Edit message" });
		await expect(regenerate).toHaveCount(2);

		await pressPencil(page, userIds[0]);
		await expect(page.getByTestId("composer-edit-strip")).toBeVisible();

		await expect(regenerate).toHaveCount(0);
		await expect(pencils).toHaveCount(0);

		await page.getByTestId("composer-edit-cancel").click();

		await expect(regenerate).toHaveCount(2);
		await expect(pencils).toHaveCount(2);
	});

	test.describe("with a model that answers", () => {
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

		test("the draft set aside outlives the resend's turn and a reload", async ({
			page,
		}) => {
			await page.setViewportSize({ width: 1280, height: 900 });
			const { conversationId, userIds } = await seedTurns(page, 2);
			const providerId = await pointTheUserAtFakeModel(
				page,
				fakeProvider.baseURL,
			);
			try {
				await open(page, conversationId);
				const composer = page.getByTestId("message-input");
				await composer.fill("a half-written thought");
				await expect
					.poll(() => savedDraft(page, conversationId))
					.toBe("a half-written thought");

				await pressPencil(page, userIds[0]);
				await composer.fill("Question number 1, asked again");
				await page.getByTestId("send-button").click();

				// The turn has landed: its reply is there and carries its actions.
				await expect(
					page
						.getByTestId("assistant-message")
						.locator(".prose-container")
						.getByText(/fake provider response/i),
				).toBeVisible({
					timeout: 30_000,
				});
				await expect(
					page.getByRole("button", { name: "Regenerate" }),
				).toHaveCount(1, { timeout: 30_000 });
				await expect(composer).toHaveValue("a half-written thought");
				await expect
					.poll(() => savedDraft(page, conversationId))
					.toBe("a half-written thought");

				await page.reload();
				await expect(composer).toHaveValue("a half-written thought");
				await expect(
					page.getByText("Question number 1, asked again"),
				).toBeVisible();
				await expect(
					page.getByText("Answer number 2 about the lake."),
				).toHaveCount(0);
			} finally {
				await restoreTheUsersModel(page, providerId);
			}
		});

		// The server keeps nothing of a turn that fails, so after one the page's list
		// ends in a message the server does not have. Retry sends that message again,
		// with its file, and leaves every reply above it where it is: it used to take
		// the last reply of the list, the turn before's, regenerate it and remove it.
		test("Retry after a failed turn keeps the earlier reply and sends the message again with its file", async ({
			page,
		}) => {
			await page.setViewportSize({ width: 1280, height: 900 });
			const { conversationId } = await seedTurns(page, 1);
			const providerId = await pointTheUserAtFakeModel(
				page,
				fakeProvider.baseURL,
			);
			const requests = watchChatRequests(page);
			const question = "And what is the lake called?";
			const lakeName = `Lake-${randomUUID().slice(0, 8)}`;
			try {
				await open(page, conversationId);
				const fileId = await attachTextFile(
					page,
					`notes-${lakeName}.txt`,
					`The lake in these notes is called ${lakeName}.`,
				);

				// The first try fails before it reaches the model: the server keeps
				// nothing of it, as of a turn that failed in the model.
				await page.route("**/api/chat/stream", (route) =>
					route.fulfill({
						status: 500,
						json: { error: "The model provider failed." },
					}),
				);
				await page.getByTestId("message-input").fill(question);
				await page.getByTestId("send-button").click();
				const retry = page.getByRole("button", { name: "Retry" });
				await expect(retry).toBeVisible();
				await page.unroute("**/api/chat/stream");

				// The message is on screen, the turn before still has its reply.
				await expect(page.getByTestId("user-message")).toHaveCount(2);
				await expect(
					page.getByText("Answer number 1 about the lake."),
				).toBeVisible();

				const retried = page.waitForRequest(
					(request) =>
						request.method() === "POST" &&
						new URL(request.url()).pathname === "/api/chat/stream",
					{ timeout: 10_000 },
				);
				await retry.click();

				// It is the same message with the file it went with, to the stream.
				expect((await retried).postDataJSON()).toMatchObject({
					message: question,
					conversationId,
					attachmentIds: [fileId],
				});
				await expect(
					page
						.getByTestId("assistant-message")
						.locator(".prose-container")
						.getByText(/fake provider response/i),
				).toBeVisible({
					timeout: 30_000,
				});
				await expect(
					page.getByText("Answer number 1 about the lake."),
				).toBeVisible();
				await expect(page.getByTestId("user-message")).toHaveCount(2);
				await expect(page.getByTestId("assistant-message")).toHaveCount(2);
				expect(requests).not.toContain("POST /api/chat/retry");
				expect(
					requests.filter((r) => r === "POST /api/chat/stream"),
				).toHaveLength(2);

				// The file reached the model, and the server saved one message with it
				// (the file is linked to its message a moment after the reply).
				await expect
					.poll(() =>
						fakeProvider
							.requests()
							.some((request) =>
								(JSON.stringify(request.body) ?? "").includes(lakeName),
							),
					)
					.toBe(true);
				await expect
					.poll(async () =>
						(await savedMessages(page, conversationId))
							.at(2)
							?.attachments?.map((attachment) => attachment.artifactId),
					)
					.toEqual([fileId]);
				const saved = await savedMessages(page, conversationId);
				expect(saved.map((message) => message.role)).toEqual([
					"user",
					"assistant",
					"user",
					"assistant",
				]);
				const sentMessage = saved[2];
				expect(sentMessage.content).toBe(question);
				// The bubble that was on screen is the one the server has: under its id,
				// with its pencil (a client id would leave edits nothing to find).
				const bubble = page.locator(`[data-message-id="${sentMessage.id}"]`);
				await expect(bubble).toBeVisible();
				await bubble.hover();
				await expect(
					page.locator(`#edit-button-${sentMessage.id}`),
				).toBeVisible();
			} finally {
				await page.unroute("**/api/chat/stream").catch(() => undefined);
				await restoreTheUsersModel(page, providerId);
			}
		});

		// The resend of an edit meets the turn's gate only after the delete. A file
		// deleted since (a page that is not up to date, or a model that cannot see the
		// photo) is refused there, and a reload showed the message and every reply
		// after it gone. The gate is asked first, and a refusal leaves the edit open.
		test("an edit the turn's gate refuses deletes nothing, keeps the edit and what was typed open, and a reload finds every message", async ({
			page,
		}) => {
			await page.setViewportSize({ width: 1280, height: 900 });
			const conversationId = await createEmptyConversation(
				page,
				"A refused edit",
			);
			const providerId = await pointTheUserAtFakeModel(
				page,
				fakeProvider.baseURL,
			);
			const requests = watchChatRequests(page);
			const question = "What does this file say about the lake?";
			try {
				await openEmptyChat(page, conversationId);
				const fileId = await attachTextFile(
					page,
					"lake-notes.txt",
					"The lake is deep and cold.",
				);
				await page.getByTestId("message-input").fill(question);
				await page.getByTestId("send-button").click();
				await expect(
					page
						.getByTestId("assistant-message")
						.locator(".prose-container")
						.getByText(/fake provider response/i),
				).toBeVisible({
					timeout: 30_000,
				});
				await expect.poll(() => turnHasSettled(conversationId)).toBe(true);
				const before = await savedMessages(page, conversationId);
				expect(before.map((message) => message.role)).toEqual([
					"user",
					"assistant",
				]);
				const userMessageId = before[0].id;

				// The file is deleted while this page still shows it with the message.
				const removed = await page.request.delete(`/api/knowledge/${fileId}`);
				expect(removed.ok(), `file delete -> ${removed.status()}`).toBe(true);

				await pressPencil(page, userMessageId);
				const composer = page.getByTestId("message-input");
				await expect(composer).toHaveValue(question);
				const reworded = "What does this file say about the river?";
				await composer.fill(reworded);
				const deletesBefore = requests.filter((r) => r.startsWith("DELETE"));
				await page.getByTestId("send-button").click();

				// The gate's own sentence for it, on a page that has lost nothing.
				await expect(
					page.getByText("Attached file is no longer available."),
				).toBeVisible();
				await expect(page.getByTestId("composer-edit-strip")).toBeVisible();
				await expect(composer).toHaveValue(reworded);
				await expect(page.getByText(question)).toBeVisible();
				await expect(
					page
						.getByTestId("assistant-message")
						.locator(".prose-container")
						.getByText(/fake provider response/i),
				).toBeVisible();
				expect(requests.filter((r) => r.startsWith("DELETE"))).toEqual(
					deletesBefore,
				);
				expect(requests).toContain("POST /api/chat/turn-check");
				expect(
					requests.filter((r) => r === "POST /api/chat/stream"),
				).toHaveLength(1);
				expect(await savedMessages(page, conversationId)).toHaveLength(2);

				// A reload finds the message and its reply, as they were.
				await page.reload();
				await expect(page.getByTestId("assistant-message")).toHaveCount(1);
				await expect(page.getByText(question)).toBeVisible();
				await expect(
					page
						.getByTestId("assistant-message")
						.locator(".prose-container")
						.getByText(/fake provider response/i),
				).toBeVisible();
				const after = await savedMessages(page, conversationId);
				expect(after.map((message) => message.id)).toEqual(
					before.map((message) => message.id),
				);
			} finally {
				await restoreTheUsersModel(page, providerId);
			}
		});

		// The stream route turns a turn away before it admits it while this person's
		// reply is still running in another chat (one at a time by default). The edit's
		// resend meets that after the delete, so the check meets it first: the edit
		// stays open and nothing is deleted; once the other reply is over it goes.
		test("an edit while a reply runs in another chat is turned away before anything is deleted, and goes once it is over", async ({
			page,
		}) => {
			test.setTimeout(120_000);
			await page.setViewportSize({ width: 1280, height: 900 });
			const editing = await seedTurns(page, 2, "Chat with the edit");
			const running = await createEmptyConversation(page, "Chat with a reply");
			const providerId = await pointTheUserAtFakeModel(
				page,
				fakeProvider.baseURL,
			);
			const other = await page.context().newPage();
			await other.setViewportSize({ width: 1280, height: 900 });
			const requests = watchChatRequests(other);
			const marked = `${AI_SMOKE_REFUSE_SLOWLY_MARKER} Hello`;
			try {
				await open(other, editing.conversationId);
				await pressPencil(other, editing.userIds[1]);
				const composer = other.getByTestId("message-input");
				await composer.fill("Question number 2, asked again");
				const before = await savedMessages(other, editing.conversationId);

				// A reply in the other chat: the provider holds its refusal for 1.5 s, so
				// the server has it running while the edit is sent.
				await openEmptyChat(page, running);
				await page.getByTestId("message-input").fill(marked);
				await page.getByTestId("send-button").click();
				await expect
					.poll(() =>
						fakeProvider
							.requests()
							.some(
								(request) => currentScenarioUserText(request.body) === marked,
							),
					)
					.toBe(true);

				await other.getByTestId("send-button").click();
				await expect(
					other.getByText(
						"Another reply is still running. Wait for it, then send this edit again.",
					),
				).toBeVisible();
				await expect(other.getByTestId("composer-edit-strip")).toBeVisible();
				await expect(composer).toHaveValue("Question number 2, asked again");
				await expect(
					other.getByText("Answer number 2 about the lake."),
				).toBeVisible();
				expect(requests).toContain("POST /api/chat/turn-check");
				expect(requests.filter((r) => r.startsWith("DELETE"))).toEqual([]);
				expect(requests.filter((r) => r === "POST /api/chat/stream")).toEqual(
					[],
				);
				expect(
					(await savedMessages(other, editing.conversationId)).map(
						(message) => message.id,
					),
				).toEqual(before.map((message) => message.id));

				// The other reply ends (the model refused it): the same edit goes.
				await expect(page.getByRole("button", { name: "Retry" })).toBeVisible({
					timeout: 30_000,
				});
				await other.getByTestId("send-button").click();
				await expect(
					other
						.getByTestId("assistant-message")
						.locator(".prose-container")
						.getByText(/fake provider response/i),
				).toBeVisible({
					timeout: 30_000,
				});
				await expect(other.getByTestId("composer-edit-strip")).toHaveCount(0);
				await expect(
					other.getByText("Answer number 2 about the lake."),
				).toHaveCount(0);
			} finally {
				await other.close();
				await restoreTheUsersModel(page, providerId);
			}
		});

		// A failed regenerate persists an inspectable failed completion. Retry is a
		// fresh request made only by the person's press, replacing that failed reply.
		test("Retry after a regenerate that failed gets the reply, and a reload finds every message once", async ({
			page,
		}) => {
			await page.setViewportSize({ width: 1280, height: 900 });
			const { conversationId } = await seedTurns(page, 2);
			const providerId = await pointTheUserAtFakeModel(
				page,
				fakeProvider.baseURL,
			);
			const retryBodies: Array<Record<string, unknown>> = [];
			page.on("request", (request) => {
				if (
					request.method() === "POST" &&
					new URL(request.url()).pathname === "/api/chat/retry"
				) {
					retryBodies.push(request.postDataJSON());
				}
			});
			try {
				await open(page, conversationId);
				const before = await savedMessages(page, conversationId);
				expect(before.map((message) => message.role)).toEqual([
					"user",
					"assistant",
					"user",
					"assistant",
				]);
				const [firstQuestion, firstReply, secondQuestion, secondReply] = before;

				// The model is down: its address is one nothing listens on.
				await setProviderBaseUrl(page, providerId, "http://127.0.0.1:1/v1");
				await page.getByRole("button", { name: "Regenerate" }).last().click();
				await expect(page.getByRole("button", { name: "Retry" })).toBeVisible({
					timeout: 30_000,
				});

				const failedRows = await savedMessages(page, conversationId);
				expect(failedRows.slice(0, 3).map((message) => message.id)).toEqual([
					firstQuestion.id,
					firstReply.id,
					secondQuestion.id,
				]);
				expect(failedRows).toHaveLength(4);
				const failedReply = failedRows[3];
				expect(failedReply.role).toBe("assistant");
				expect(failedReply.id).not.toBe(secondReply.id);
				expect(
					failedReply.normalChatOutput?.events.findLast(
						(event) => event.type === "completion",
					),
				).toMatchObject({
					type: "completion",
					completion: { outcome: "failed", stopCause: "transport_error" },
				});
				const failedBubble = page.locator(
					`[data-testid="assistant-message"][data-message-id="${failedReply.id}"]`,
				);
				await expect(failedBubble).toHaveAttribute(
					"data-message-id",
					failedReply.id,
				);
				await expect(
					failedBubble.locator("..").getByTestId("normal-chat-output-status"),
				).toHaveText("Reply failed");
				await expect(page.getByTestId("assistant-message")).toHaveCount(2);
				await expect(page.getByTestId("user-message")).toHaveCount(2);
				expect(retryBodies).toHaveLength(1);

				// No retry runs before this explicit press; the failed row remains saved.
				await setProviderBaseUrl(page, providerId, fakeProvider.baseURL);
				const answered = page.waitForResponse(
					(response) =>
						response.request().method() === "POST" &&
						new URL(response.url()).pathname === "/api/chat/retry" &&
						response.request().postDataJSON()?.retryOrigin === "error_retry",
					{ timeout: 10_000 },
				);
				await page.getByRole("button", { name: "Retry" }).click();
				expect((await answered).status()).toBe(200);
				await expect(
					page
						.getByTestId("assistant-message")
						.locator(".prose-container")
						.getByText(/fake provider response/i),
				).toBeVisible({
					timeout: 30_000,
				});
				await expect(page.getByTestId("assistant-message")).toHaveCount(2);
				await expect(page.getByTestId("user-message")).toHaveCount(2);
				expect(retryBodies).toHaveLength(2);
				expect(retryBodies[1]).toMatchObject({
					conversationId,
					assistantMessageId: failedReply.id,
					userMessageId: secondQuestion.id,
					retryOrigin: "error_retry",
				});

				// The first question and its reply were never touched, the second
				// question is there once, and the new reply follows it: after a reload too.
				await expect
					.poll(async () => (await savedMessages(page, conversationId)).length)
					.toBe(4);
				await page.reload();
				await expect(page.getByTestId("assistant-message")).toHaveCount(2);
				await expect(page.getByTestId("user-message")).toHaveCount(2);
				const after = await savedMessages(page, conversationId);
				expect(after.map((message) => message.role)).toEqual([
					"user",
					"assistant",
					"user",
					"assistant",
				]);
				expect(after.slice(0, 3).map((message) => message.id)).toEqual([
					firstQuestion.id,
					firstReply.id,
					secondQuestion.id,
				]);
				expect(after[3].content).toMatch(/fake provider response/i);
				expect(after[3].id).not.toBe(failedReply.id);
				expect(
					after.filter((message) => message.content === secondQuestion.content),
				).toHaveLength(1);
			} finally {
				await setProviderBaseUrl(page, providerId, fakeProvider.baseURL).catch(
					() => undefined,
				);
				await restoreTheUsersModel(page, providerId);
			}
		});

		// A dropped connection does not end a turn: the server keeps running it and
		// saves the message with its reply while the page shows an error and a Retry.
		// Retry sent the message again, and the chat held the turn twice. Retry now asks
		// the server first; here the turn is finished when the connection drops.
		test("Retry after a connection that dropped over a turn the server finished sends nothing, and a reload finds the turn once", async ({
			page,
		}) => {
			await page.setViewportSize({ width: 1280, height: 900 });
			const { conversationId } = await seedTurns(page, 1);
			const providerId = await pointTheUserAtFakeModel(
				page,
				fakeProvider.baseURL,
			);
			const requests = watchChatRequests(page);
			const question = "And what is the lake called?";
			try {
				await open(page, conversationId);

				// The server runs the turn to its end; the page's connection drops before
				// it has read a word of it.
				await page.route("**/api/chat/stream", async (route) => {
					await route.fetch();
					await route.abort("connectionreset");
				});
				await page.getByTestId("message-input").fill(question);
				await page.getByTestId("send-button").click();
				const retry = page.getByRole("button", { name: "Retry" });
				await expect(retry).toBeVisible({ timeout: 30_000 });
				await page.unroute("**/api/chat/stream");
				await expect(page.getByTestId("assistant-message")).toHaveCount(1);

				// The server has the whole turn, which the page has not.
				await expect
					.poll(async () =>
						(await savedMessages(page, conversationId)).map(
							(message) => message.role,
						),
					)
					.toEqual(["user", "assistant", "user", "assistant"]);

				await retry.click();

				// The page shows what the server holds: the reply, no error, no Retry.
				await expect(
					page
						.getByTestId("assistant-message")
						.locator(".prose-container")
						.getByText(/fake provider response/i),
				).toBeVisible({
					timeout: 30_000,
				});
				await expect(retry).toHaveCount(0);
				await expect(page.locator(".error-toast")).toHaveCount(0);
				await expect(page.getByTestId("user-message")).toHaveCount(2);
				await expect(page.getByTestId("assistant-message")).toHaveCount(2);
				expect(
					requests.filter((request) => request === "POST /api/chat/stream"),
				).toHaveLength(1);
				expect(requests).not.toContain("POST /api/chat/retry");

				// A reload finds the turn once.
				await page.reload();
				await expect(page.getByTestId("assistant-message")).toHaveCount(2);
				const saved = await savedMessages(page, conversationId);
				expect(saved.map((message) => message.role)).toEqual([
					"user",
					"assistant",
					"user",
					"assistant",
				]);
				expect(
					saved.filter((message) => message.content === question),
				).toHaveLength(1);
			} finally {
				await page.unroute("**/api/chat/stream").catch(() => undefined);
				await restoreTheUsersModel(page, providerId);
			}
		});

		// The server saves a turn's message when the turn ends, so while it still runs a
		// turn whose connection dropped, the chat does not hold the message. A resend was
		// turned away for the person's one reply at a time, and the capacity backoff
		// posted it again for a few seconds without asking; a turn that ended in that
		// window ran a second time. Retry now finds the stream the server is still
		// running and joins it. The fake model refuses the turn after a pause, so the
		// turn is still running when Retry is pressed and fails when it is over.
		test("Retry while the server is still running the turn whose connection dropped joins it and runs it once", async ({
			page,
		}) => {
			await page.setViewportSize({ width: 1280, height: 900 });
			const { conversationId } = await seedTurns(page, 1);
			const providerId = await pointTheUserAtFakeModel(
				page,
				fakeProvider.baseURL,
			);
			const requests = watchChatRequests(page);
			const streamBodies: Array<Record<string, unknown>> = [];
			page.on("request", (request) => {
				if (
					request.method() === "POST" &&
					new URL(request.url()).pathname === "/api/chat/stream"
				) {
					streamBodies.push(request.postDataJSON());
				}
			});
			const question = `${AI_SMOKE_REFUSE_SLOWLY_MARKER} And the lake?`;
			/** How many times the model was asked for this turn. */
			const modelRequests = () =>
				fakeProvider
					.requests()
					.filter(
						(request) => currentScenarioUserText(request.body) === question,
					);
			try {
				await open(page, conversationId);

				// The server gets the request and runs the turn; the page's connection
				// drops a moment later, with the turn still running.
				await page.route("**/api/chat/stream", async (route) => {
					void route.fetch().catch(() => undefined);
					await page.waitForTimeout(300);
					await route.abort("connectionreset");
				});
				await page.getByTestId("message-input").fill(question);
				await page.getByTestId("send-button").click();
				const retry = page.getByRole("button", { name: "Retry" });
				await expect(retry).toBeVisible({ timeout: 30_000 });
				await page.unroute("**/api/chat/stream");

				await retry.click();

				// The page joined the turn: a second request to the stream route that
				// reconnects to it, and no request that sends the message again.
				await expect.poll(() => streamBodies.length).toBe(2);
				expect(streamBodies[1]).toMatchObject({
					reconnectToStreamId: expect.any(String),
				});
				expect(requests).not.toContain("POST /api/chat/retry");

				// The turn fails, the joined connection ends with the failure and the
				// message is back with its error and a Retry. The model was asked for
				// the one turn only: no later request of it, and no later post of the
				// message, as the backoff made, while the first turn ran and after it.
				await expect(retry).toHaveCount(0);
				await expect(retry).toBeVisible({ timeout: 30_000 });
				await expect.poll(() => modelRequests().length).toBe(2);
				// One working attempt and its bounded pre-output working retry belong
				// to the original request. Reconnect must not generate either again.
				expect(
					modelRequests().map((request) => completionToolsOff(request.body)),
				).toEqual([false, false]);
				expect(completionWireMessages(modelRequests()[1].body)).toEqual(
					completionWireMessages(modelRequests()[0].body),
				);
				await page.waitForTimeout(3_000);
				expect(modelRequests()).toHaveLength(2);
				expect(streamBodies).toHaveLength(2);
				expect(
					(await savedMessages(page, conversationId)).map(
						(message) => message.role,
					),
				).toEqual(["user", "assistant", "user", "assistant"]);
			} finally {
				await page.unroute("**/api/chat/stream").catch(() => undefined);
				await restoreTheUsersModel(page, providerId);
			}
		});

		test("words typed while a reply is coming are still there after it lands and after a reload", async ({
			page,
		}) => {
			await page.setViewportSize({ width: 1280, height: 900 });
			const conversationId = await createEmptyConversation(
				page,
				"A draft during a reply",
			);
			const providerId = await pointTheUserAtFakeModel(
				page,
				fakeProvider.baseURL,
			);
			const releaseTheReply = await holdTheNextTurn(page);
			try {
				await openEmptyChat(page, conversationId);
				const composer = page.getByTestId("message-input");
				await composer.fill("What is the plan for the weekend?");
				await page.getByTestId("send-button").click();

				// The reply is on its way and the composer is the person's again: what
				// goes into it is saved as the chat's draft.
				await composer.fill("an idea for after the reply");
				await expect
					.poll(() => savedDraft(page, conversationId))
					.toBe("an idea for after the reply");

				releaseTheReply();
				await expect(
					page
						.getByTestId("assistant-message")
						.locator(".prose-container")
						.getByText(/fake provider response/i),
				).toBeVisible({
					timeout: 30_000,
				});
				await expect.poll(() => turnHasSettled(conversationId)).toBe(true);

				await expect(composer).toHaveValue("an idea for after the reply");
				expect(await savedDraft(page, conversationId)).toBe(
					"an idea for after the reply",
				);
				await page.reload();
				await expect(composer).toHaveValue("an idea for after the reply");
			} finally {
				releaseTheReply();
				await page.unroute("**/api/chat/stream");
				await restoreTheUsersModel(page, providerId);
			}
		});

		for (const lateSave of [false, true]) {
			test(`a message sent from the composer leaves no draft behind${lateSave ? ", even when a save of it lands after the send" : ""}`, async ({
				page,
			}) => {
				await page.setViewportSize({ width: 1280, height: 900 });
				const conversationId = await createEmptyConversation(
					page,
					"A sent draft",
				);
				const providerId = await pointTheUserAtFakeModel(
					page,
					fakeProvider.baseURL,
				);
				const releaseTheReply = await holdTheNextTurn(page);
				const sent = "What is the plan for the weekend?";
				try {
					await openEmptyChat(page, conversationId);
					const composer = page.getByTestId("message-input");
					await composer.fill(sent);
					await expect.poll(() => savedDraft(page, conversationId)).toBe(sent);

					await page.getByTestId("send-button").click();
					// The composer deletes its draft as it sends.
					await expect.poll(() => savedDraft(page, conversationId)).toBeNull();
					if (lateSave) {
						// A save that was on its way when the send went out lands after that
						// delete: only the turn that sent these words clears it.
						await saveDraft(page, conversationId, sent);
						await expect
							.poll(() => savedDraft(page, conversationId))
							.toBe(sent);
					}

					releaseTheReply();
					await expect(
						page
							.getByTestId("assistant-message")
							.locator(".prose-container")
							.getByText(/fake provider response/i),
					).toBeVisible({
						timeout: 30_000,
					});
					await expect.poll(() => turnHasSettled(conversationId)).toBe(true);
					expect(await savedDraft(page, conversationId)).toBeNull();

					await page.reload();
					await expect(composer).toHaveValue("");
					expect(await savedDraft(page, conversationId)).toBeNull();
				} finally {
					releaseTheReply();
					await page.unroute("**/api/chat/stream");
					await restoreTheUsersModel(page, providerId);
				}
			});
		}

		test("a first message sent from the landing page while a save of it is on its way does not come back in the composer", async ({
			page,
		}) => {
			await page.setViewportSize({ width: 1280, height: 900 });
			const providerId = await pointTheUserAtFakeModel(
				page,
				fakeProvider.baseURL,
			);
			// Held in the page and not with page.route, which would slow the delete
			// that has to reach the server ahead of the chat page's own read.
			await page.addInitScript(() => {
				const real = window.fetch;
				const holding = window as unknown as {
					holdDraftSaves?: boolean;
					draftSavesHeld?: number;
				};
				window.fetch = (input, init) => {
					const isSave =
						init?.method === "PUT" && String(input).endsWith("/draft");
					if (!isSave || !holding.holdDraftSaves) return real(input, init);
					holding.draftSavesHeld = (holding.draftSavesHeld ?? 0) + 1;
					return new Promise(() => undefined);
				};
			});
			try {
				await page.goto("/", { waitUntil: "domcontentloaded" });
				await waitForHydration(page);
				const composer = page.getByTestId("message-input");
				const firstSave = page.waitForResponse(
					(response) =>
						response.url().endsWith("/draft") &&
						response.request().method() === "PUT",
				);
				await composer.fill("What is the plan");
				await firstSave;

				await page.evaluate(() => {
					(window as unknown as { holdDraftSaves: boolean }).holdDraftSaves =
						true;
				});
				await composer.fill("What is the plan for the weekend?");
				await page.waitForFunction(
					() =>
						((window as unknown as { draftSavesHeld?: number })
							.draftSavesHeld ?? 0) > 0,
				);
				await page.getByTestId("send-button").click();

				await expect(
					page
						.getByTestId("assistant-message")
						.locator(".prose-container")
						.getByText(/fake provider response/i),
				).toBeVisible({
					timeout: 30_000,
				});
				await expect(composer).toHaveValue("");
				await page.reload();
				await expect(composer).toHaveValue("");
			} finally {
				await restoreTheUsersModel(page, providerId);
			}
		});

		test("a first message sent from the landing page stays out of the new chat's composer when the landing page's delete of its draft never reaches the server", async ({
			page,
		}) => {
			await page.setViewportSize({ width: 1280, height: 900 });
			const providerId = await pointTheUserAtFakeModel(
				page,
				fakeProvider.baseURL,
			);
			const sent = "What is the plan for the weekend?";
			// The landing page deletes its saved draft as it sends and loads the chat in
			// the same breath, and the browser can drop that request with the page
			// before it leaves (production, 2026-11-07: no delete reached the server and
			// the new chat opened with the message in its composer). Lost here on
			// purpose: the first delete after Send is the landing's, since the chat's own
			// waits for its send, held below until the chat has read itself.
			let sendPressed = false;
			let landingDeleteLost = false;
			await page.route("**/api/conversations/*/draft", async (route) => {
				if (
					sendPressed &&
					!landingDeleteLost &&
					route.request().method() === "DELETE"
				) {
					landingDeleteLost = true;
					await route.abort();
					return;
				}
				await route.fallback();
			});
			let releaseCapabilities: () => void = () => undefined;
			const capabilitiesHeld = new Promise<void>((resolve) => {
				releaseCapabilities = resolve;
			});
			try {
				await page.goto("/", { waitUntil: "domcontentloaded" });
				await waitForHydration(page);
				const composer = page.getByTestId("message-input");
				const save = page.waitForResponse(
					(response) =>
						response.url().endsWith("/draft") &&
						response.request().method() === "PUT",
				);
				await composer.fill(sent);
				const conversationId = new URL((await save).url()).pathname.split(
					"/",
				)[3];
				expect(await savedDraft(page, conversationId)).toBe(sent);

				// The chat reads itself once on arrival, and that read must come back
				// before the message goes: the send waits for the composer's connections,
				// held until then.
				const firstRead = page.waitForResponse(
					(response) =>
						response.request().method() === "GET" &&
						new URL(response.url()).pathname ===
							`/api/conversations/${conversationId}`,
				);
				await page.route(
					"**/api/connections/active-capabilities",
					async (route) => {
						await capabilitiesHeld;
						await route.fallback();
					},
				);
				sendPressed = true;
				await page.getByTestId("send-button").click();
				await firstRead;
				releaseCapabilities();

				await expect(
					page
						.getByTestId("assistant-message")
						.locator(".prose-container")
						.getByText(/fake provider response/i),
				).toBeVisible({
					timeout: 30_000,
				});
				expect(landingDeleteLost).toBe(true);
				await expect(composer).toHaveValue("");
				// The chat's own send deleted the landing's copy.
				await expect.poll(() => savedDraft(page, conversationId)).toBeNull();
				await page.reload();
				await expect(composer).toHaveValue("");
			} finally {
				releaseCapabilities();
				await page.unroute("**/api/connections/active-capabilities");
				await page.unroute("**/api/conversations/*/draft");
				await restoreTheUsersModel(page, providerId);
			}
		});
	});

	test.describe("a 360 px phone", () => {
		test.use({
			viewport: { width: 360, height: 740 },
			hasTouch: true,
			isMobile: true,
		});

		for (const language of ["en", "hu"] as const) {
			test(`the strip stays on one line (${language}), even for a long count`, async ({
				page,
			}) => {
				await db
					.update(users)
					.set({ uiLanguage: language })
					.where(eq(users.email, "admin@local"));
				try {
					const { conversationId, userIds } = await seedTurns(page, 14);
					await open(page, conversationId);

					await pressPencil(page, userIds[0]);

					const label = page.getByTestId("composer-edit-label");
					await expect(label).toContainText(/13/);
					const fit = await label.evaluate((node) => {
						const box = node.getBoundingClientRect();
						const style = getComputedStyle(node);
						return {
							// Nothing is cut off by the ellipsis...
							clipped: node.scrollWidth > node.clientWidth,
							// ...and it is one line of text, not two.
							lines: Math.round(
								box.height / Number.parseFloat(style.lineHeight || "16"),
							),
						};
					});
					expect(fit.clipped, "the label must not be cut off").toBe(false);
					expect(fit.lines).toBe(1);
					const strip = await page
						.getByTestId("composer-edit-strip")
						.boundingBox();
					expect(strip?.height ?? 999).toBeLessThan(44);
					await expect(page.getByTestId("composer-edit-cancel")).toBeVisible();
				} finally {
					await db
						.update(users)
						.set({ uiLanguage: "en" })
						.where(eq(users.email, "admin@local"));
				}
			});
		}
	});
});

// The chat page, and its composer, are reused when the person moves to another
// chat, and the page reads the chat again while a job runs. What the composer
// holds is the person's, and stays with the chat it was typed in.
test.describe("The words in the composer stay with their chat", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("moving to another chat at once: it shows its own draft, the words wait in the chat they were typed in, nothing is sent", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		const chatA = await seedTurns(page, 1, "Chat A");
		const chatB = await seedTurns(page, 1, "Chat B");
		await saveDraft(page, chatB.conversationId, "a draft of chat B");
		await open(page, chatA.conversationId);
		await ensureSidebarExpanded(page);
		const composer = page.getByTestId("message-input");
		const sidebarItem = (conversationId: string) =>
			page.locator(
				`[data-testid="conversation-item"][data-conversation-id="${conversationId}"]`,
			);

		// Typed and left within the page's draft debounce.
		await composer.fill("for A");
		await sidebarItem(chatB.conversationId).click();

		await expect(page).toHaveURL(new RegExp(chatB.conversationId));
		await expect(composer).toHaveValue("a draft of chat B");
		await expect
			.poll(() => savedDraft(page, chatA.conversationId))
			.toBe("for A");

		await sidebarItem(chatA.conversationId).click();

		await expect(page).toHaveURL(new RegExp(chatA.conversationId));
		await expect(composer).toHaveValue("for A");
		// Past the page's draft debounce, so anything wrongly emitted has landed.
		await page.waitForTimeout(600);
		expect(await savedDraft(page, chatB.conversationId)).toBe(
			"a draft of chat B",
		);
		expect(await savedDraft(page, chatA.conversationId)).toBe("for A");

		await page.reload();
		await expect(composer).toHaveValue("for A");
		// Nothing was sent: each chat still holds its one seeded turn.
		const stored = await db
			.select({ id: messages.id })
			.from(messages)
			.where(
				inArray(messages.conversationId, [
					chatA.conversationId,
					chatB.conversationId,
				]),
			);
		expect(stored).toHaveLength(4);
	});

	test("a draft that holds a file and no words keeps its chip through a reload and through Back, and the next keystroke saves it with the file", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		const chatA = await seedTurns(page, 1, "Chat A");
		const chatB = await seedTurns(page, 1, "Chat B");
		await open(page, chatA.conversationId);
		await ensureSidebarExpanded(page);
		const composer = page.getByTestId("message-input");
		const chip = page
			.getByTestId("composer-chip-attachment")
			.filter({ hasText: "notes.txt" });
		const fileId = await attachTextFile(
			page,
			"notes.txt",
			"A few lines the draft keeps.",
		);
		await expect
			.poll(() => savedDraftFileIds(page, chatA.conversationId))
			.toEqual([fileId]);

		await page.reload();
		await expect(composer).toBeEnabled();
		await waitForHydration(page);
		await expect(chip).toBeVisible();
		await expect(composer).toHaveValue("");

		// Away to the other chat and Back: the shell names the open chat after the
		// page has given the composer its draft.
		await page
			.locator(
				`[data-testid="conversation-item"][data-conversation-id="${chatB.conversationId}"]`,
			)
			.click();
		await expect(page).toHaveURL(new RegExp(chatB.conversationId));
		await expect(chip).toHaveCount(0);
		await page.goBack();
		await expect(page).toHaveURL(new RegExp(chatA.conversationId));
		await expect(chip).toBeVisible();

		await composer.fill("x");
		await page.waitForTimeout(600);
		expect(await savedDraftFileIds(page, chatA.conversationId)).toEqual([
			fileId,
		]);
		await expect(chip).toBeVisible();
	});

	test.describe("with a model that answers", () => {
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

		// A message queued behind a running reply lives only in the page's queue.
		for (const destination of ["another chat", "Settings"] as const) {
			test(`a queued message stays with its chat when the person goes to ${destination} and back: it is in the composer, nothing was sent, and a reload keeps it`, async ({
				page,
			}) => {
				await page.setViewportSize({ width: 1280, height: 900 });
				const chatA = await seedTurns(page, 1, "Chat A");
				const chatB = await seedTurns(page, 1, "Chat B");
				const providerId = await pointTheUserAtFakeModel(
					page,
					fakeProvider.baseURL,
				);
				const releaseTheReply = await holdTheNextTurn(page);
				const sidebarItem = (conversationId: string) =>
					page.locator(
						`[data-testid="conversation-item"][data-conversation-id="${conversationId}"]`,
					);
				const queued = "B: queued behind the reply";
				try {
					await open(page, chatA.conversationId);
					await ensureSidebarExpanded(page);
					const composer = page.getByTestId("message-input");
					await composer.fill("A: the next question");
					await page.getByTestId("send-button").click();
					// The reply is on its way, and B waits behind it.
					await composer.fill(queued);
					await page.getByTestId("queue-button").click();
					await expect(page.getByTestId("queued-message-banner")).toContainText(
						queued,
					);

					if (destination === "another chat") {
						await sidebarItem(chatB.conversationId).click();
						await expect(page).toHaveURL(new RegExp(chatB.conversationId));
						await expect(composer).toHaveValue("");
						await sidebarItem(chatA.conversationId).click();
					} else {
						await page.getByRole("button", { name: "Open settings" }).click();
						await expect(page).toHaveURL(/\/settings/);
						await page.goBack();
					}

					await expect(page).toHaveURL(new RegExp(chatA.conversationId));
					await expect(page.getByTestId("message-input")).toHaveValue(queued);
					await expect(page.getByTestId("queued-message-banner")).toHaveCount(
						0,
					);
					await expect
						.poll(() => savedDraft(page, chatA.conversationId))
						.toBe(queued);

					await page.reload();
					await expect(page.getByTestId("message-input")).toHaveValue(queued);
					// Nothing was sent: the model heard nothing, and each chat still holds
					// its one seeded turn.
					expect(
						fakeProvider
							.requests()
							.filter((request) => request.method === "POST"),
					).toHaveLength(0);
					const stored = await db
						.select({ id: messages.id })
						.from(messages)
						.where(
							inArray(messages.conversationId, [
								chatA.conversationId,
								chatB.conversationId,
							]),
						);
					expect(stored).toHaveLength(4);
				} finally {
					releaseTheReply();
					await page.unroute("**/api/chat/stream");
					await restoreTheUsersModel(page, providerId);
				}
			});
		}

		test("a turn that is stopped puts its queued message behind the words typed since: the composer, a reload and the send hold both", async ({
			page,
		}) => {
			await page.setViewportSize({ width: 1280, height: 900 });
			const conversationId = await createEmptyConversation(
				page,
				"A restore that joins",
			);
			const providerId = await pointTheUserAtFakeModel(
				page,
				fakeProvider.baseURL,
			);
			const releaseTheReply = await holdTheNextTurn(page);
			const both = "C: typed since\n\nB: queued behind the reply";
			try {
				await openEmptyChat(page, conversationId);
				const composer = page.getByTestId("message-input");
				await composer.fill("A: the first question");
				await page.getByTestId("send-button").click();

				// The reply is on its way: B waits behind it and C is typed.
				await composer.fill("B: queued behind the reply");
				await page.getByTestId("queue-button").click();
				await expect(page.getByTestId("queued-message-banner")).toContainText(
					"B: queued behind the reply",
				);
				await composer.fill("C: typed since");

				await page.getByTestId("stop-button").click();

				await expect(composer).toHaveValue(both);
				await expect(page.getByTestId("queued-message-banner")).toHaveCount(0);
				await expect.poll(() => savedDraft(page, conversationId)).toBe(both);

				await page.reload();
				await expect(composer).toHaveValue(both);

				releaseTheReply();
				await page.getByTestId("send-button").click();
				const sent = page.getByTestId("user-message").last();
				await expect(sent).toContainText("C: typed since");
				await expect(sent).toContainText("B: queued behind the reply");
				await expect(
					page
						.getByTestId("assistant-message")
						.locator(".prose-container")
						.getByText(/fake provider response/i),
				).toBeVisible({
					timeout: 30_000,
				});
				await expect(composer).toHaveValue("");
			} finally {
				releaseTheReply();
				await page.unroute("**/api/chat/stream");
				await restoreTheUsersModel(page, providerId);
			}
		});

		test("a read of the chat that was out across a send does not bring the sent words back", async ({
			page,
		}) => {
			await page.setViewportSize({ width: 1280, height: 900 });
			const conversationId = await createEmptyConversation(
				page,
				"A read in flight",
			);
			const [admin] = await db
				.select({ id: users.id })
				.from(users)
				.where(eq(users.email, "admin@local"));
			// A file that is still being made: while it is, the page reads the chat
			// every 2.5 s.
			const jobId = randomUUID();
			const now = new Date();
			await db.insert(fileProductionJobs).values({
				id: jobId,
				conversationId,
				assistantMessageId: null,
				userId: admin.id,
				title: "A file that is still being made",
				status: "running",
				startedAt: now,
				createdAt: now,
				updatedAt: now,
			});
			const sent = "What is the plan for the weekend?";
			await saveDraft(page, conversationId, sent);
			const providerId = await pointTheUserAtFakeModel(
				page,
				fakeProvider.baseURL,
			);
			// The answer to the first read made once the test arms it is held in the
			// page: the server answers at once, with the draft as it stands, and the
			// page is handed that answer later. Held in the page and not with
			// page.route, which would hold the request itself and so the draft it
			// finds, which would be the one after the send.
			await page.addInitScript(() => {
				const real = window.fetch;
				const holding = window as unknown as {
					holdTheNextRead?: boolean;
					readsHeld?: number;
					releaseTheRead?: () => void;
				};
				window.fetch = (input, init) => {
					const answer = real(input, init);
					const path = new URL(
						input instanceof Request ? input.url : String(input),
						location.href,
					).pathname;
					const isTheChatRead =
						(init?.method ?? "GET") === "GET" &&
						/^\/api\/conversations\/[^/]+$/.test(path);
					if (!isTheChatRead || !holding.holdTheNextRead) return answer;
					holding.holdTheNextRead = false;
					holding.readsHeld = (holding.readsHeld ?? 0) + 1;
					return new Promise((resolve, reject) => {
						holding.releaseTheRead = () => {
							answer.then(resolve, reject);
						};
					});
				};
			});
			try {
				await openEmptyChat(page, conversationId);
				const composer = page.getByTestId("message-input");
				await expect(composer).toHaveValue(sent);

				await page.evaluate(() => {
					(window as unknown as { holdTheNextRead: boolean }).holdTheNextRead =
						true;
				});
				await page.waitForFunction(
					() =>
						((window as unknown as { readsHeld?: number }).readsHeld ?? 0) > 0,
					null,
					{ timeout: 15_000 },
				);
				await page.getByTestId("send-button").click();
				await expect(
					page
						.getByTestId("assistant-message")
						.locator(".prose-container")
						.getByText(/fake provider response/i),
				).toBeVisible({
					timeout: 30_000,
				});
				await expect.poll(() => turnHasSettled(conversationId)).toBe(true);
				await expect(composer).toHaveValue("");

				// The read is answered now, with the draft from before the send. Its
				// follow-up request says the page has finished with the answer.
				const finishedWithTheRead = page.waitForRequest((request) =>
					request
						.url()
						.endsWith(`/api/conversations/${conversationId}/pending-writes`),
				);
				await page.evaluate(() => {
					(
						window as unknown as { releaseTheRead: () => void }
					).releaseTheRead();
				});
				await finishedWithTheRead;

				await expect(composer).toHaveValue("");
				expect(await savedDraft(page, conversationId)).toBeNull();
			} finally {
				await db
					.delete(fileProductionJobs)
					.where(eq(fileProductionJobs.id, jobId));
				await restoreTheUsersModel(page, providerId);
			}
		});
	});
});
