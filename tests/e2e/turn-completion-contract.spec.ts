import { expect, type Page, test } from "@playwright/test";
import type { ChatMessage } from "../../src/lib/server/services/messages-types";
import { decodeAiSdkUiStreamPayloads } from "../../src/lib/services/ai-sdk-ui-stream-contract";
import { projectNormalChatOutput } from "../../src/lib/shared/normal-chat-output";
import {
	COMPLETION_ANSWER,
	COMPLETION_ARTIFACT_TITLE,
	COMPLETION_CALL_ID,
	COMPLETION_CHUNK_HOLD,
	COMPLETION_EVIDENCE_TAIL,
	COMPLETION_HOLD,
	COMPLETION_PARTIAL,
	COMPLETION_STEP_HOLD,
	COMPLETION_SYNTHESIS,
	COMPLETION_USEFUL_WORKING,
	COMPLETION_WORKING,
	type CompletionMode,
	completionMessage,
} from "../fixtures/ai/turn-completion-scenarios";
import { createOpenAICompatibleProviderHarness } from "../mocks/ai-provider/openai-compatible-provider";
import {
	completionMode,
	completionToolsOff,
	completionWireMessages,
} from "../mocks/ai-provider/turn-completion-scripts";
import {
	createTemporaryFakeProviderModel,
	deleteTemporaryProvider,
	snapshotUserModelPreference,
	updateUserModelPreference,
} from "./artifact-live-edit.helpers";
import {
	createEmptyConversation,
	login,
	sendMessage,
	waitForHydration,
} from "./helpers";

// Early contract tests: production build execution waits for Tasks 1–3 integration.
// Only the provider is fake: requests, tools, saved messages and the UI are real.
const provider = createOpenAICompatibleProviderHarness();
const requests = () =>
	provider
		.requests()
		.filter(
			(r) =>
				r.path === "/v1/chat/completions" &&
				(r.body as { stream?: boolean } | undefined)?.stream === true &&
				completionMode(r.body) &&
				(!completionToolsOff(r.body) ||
					completionWireMessages(r.body).some((m) => m.role === "assistant")),
		);
const closingRequests = () =>
	requests().filter(
		(r) =>
			completionToolsOff(r.body) &&
			completionWireMessages(r.body).some((m) => m.role === "assistant"),
	);
const prose = (page: Page) =>
	page.getByTestId("assistant-message").locator(".prose-container");

async function inspectLiveWorkingPhase(page: Page) {
	const segment = page.getByTestId("assistant-message");
	await expect(segment).toHaveCount(1);
	const disclosure = segment.locator(".thinking-header");
	const liveTool = segment
		.getByTestId("tool-activity-stack")
		.getByRole("button", {
			name: "Read completion-evidence.txt",
			exact: true,
		});
	await expect(disclosure).toBeVisible();
	await expect(disclosure).toHaveAttribute("aria-expanded", "false");
	await expect(liveTool).toBeVisible();
	await expect(segment.getByTestId("normal-chat-commentary")).toHaveCount(0);
	await expect(segment).not.toContainText(COMPLETION_WORKING);
	await disclosure.click();
	await expect(disclosure).toHaveAttribute("aria-expanded", "true");
	await expect(liveTool).toBeVisible();
	await expect(segment.getByTestId("normal-chat-commentary")).toHaveCount(0);
	await expect(segment).not.toContainText(COMPLETION_WORKING);
	await expect(page.getByTestId("stop-button")).toBeVisible();
}

async function savedOutput(page: Page, conversationId: string) {
	const response = await page.request.get(
		`/api/conversations/${conversationId}`,
	);
	expect(response.ok()).toBe(true);
	const detail: { messages: ChatMessage[] } = await response.json();
	const assistants = detail.messages.filter(
		(message) => message.role === "assistant",
	);
	expect(assistants).toHaveLength(1);
	const output = assistants[0].normalChatOutput;
	expect(output?.version).toBe(1);
	expect(output?.events.length).toBeGreaterThan(0);
	const projection = projectNormalChatOutput(output?.events ?? []);
	expect(projection.activity.map((block) => block.text)).toContain(
		COMPLETION_WORKING,
	);
	return projection;
}

async function ended(page: Page) {
	await expect(page.getByTestId("stop-button")).toHaveCount(0, {
		timeout: 30_000,
	});
	await expect(page.getByTestId("message-input")).toBeEnabled();
}
async function finalAnswer(page: Page) {
	await expect(
		prose(page).last().getByRole("heading", { name: "Result", exact: true }),
	).toBeVisible();
	await expect(prose(page).last()).toContainText("The checked result is 42.");
	await expect(
		prose(page).getByText(COMPLETION_WORKING, { exact: false }),
	).toHaveCount(0);
	await expect(prose(page).last().getByRole("listitem")).toHaveText(
		"Evidence retained",
	);
}
async function exportedAnswer(page: Page, conversationId: string) {
	const response = await page.request.get(
		`/api/conversations/${conversationId}/export.md`,
	);
	expect(response.ok()).toBe(true);
	const markdown = await response.text();
	expect(markdown).toContain(COMPLETION_ANSWER.trim());
	// The user's own prompt does not contain this prose.
	expect(markdown).not.toContain(COMPLETION_WORKING);
	return markdown;
}

// Each test has its own provider/model, preference restoration and conversation cleanup.
// reset() releases pending holds before deleting app data, including on assertion failure.
test.describe("turn completion contract", () => {
	let restore: (() => Promise<void>) | undefined;
	test.beforeAll(async () => {
		await provider.start();
	});
	test.afterAll(async () => {
		await provider.stop();
	});
	test.beforeEach(async () => {
		await provider.reset();
	});
	test.afterEach(async () => {
		await provider.reset();
		await restore?.();
		restore = undefined;
	});

	async function start(
		page: Page,
		mode: CompletionMode,
		priced = false,
		maxModelContext = 131_072,
	) {
		await login(page);
		const previous = await snapshotUserModelPreference(page);
		const fake = await createTemporaryFakeProviderModel(page, provider.baseURL);
		let id: string | undefined;
		restore = async () => {
			try {
				if (id)
					expect(
						(await page.request.delete(`/api/conversations/${id}`)).ok(),
					).toBe(true);
			} finally {
				try {
					await updateUserModelPreference(page, previous);
				} finally {
					await deleteTemporaryProvider(page, fake.providerId);
				}
			}
		};
		// Advertise a realistic synthetic model: room for the complete app prompt,
		// plus an explicit output reserve. Missing-reserve product policy is tested separately.
		const configured = await page.request.put(
			`/api/admin/providers/${fake.providerId}/models/${fake.modelId}`,
			{
				data: {
					maxModelContext,
					maxTokens: maxModelContext === 8_192 ? 1_024 : 4_096,
				},
			},
		);
		expect(configured.ok()).toBe(true);
		expect(await configured.json()).toMatchObject({
			model: {
				maxModelContext,
				maxTokens: maxModelContext === 8_192 ? 1_024 : 4_096,
			},
		});
		if (priced) {
			const response = await page.request.put(
				`/api/admin/providers/${fake.providerId}/models/${fake.modelId}`,
				{
					data: {
						inputUsdMicrosPer1m: 1_000_000_000,
						outputUsdMicrosPer1m: 1_000_000_000,
					},
				},
			);
			expect(response.ok()).toBe(true);
		}
		await updateUserModelPreference(page, fake.selectedModel);
		id = await createEmptyConversation(page);
		await page.goto(`/chat/${id}`);
		await waitForHydration(page);
		await sendMessage(page, completionMessage(mode));
		return id;
	}

	test("8192 context refuses the full catalogue before dispatch and preserves its receipt", async ({
		page,
	}) => {
		// The strict serialized-request probe found 14355 tokens including output:
		// the full catalogue cannot fit. Reject it instead of truncating capabilities.
		const id = await start(page, "tool", false, 8_192);
		await ended(page);
		await expect(page.getByTestId("normal-chat-output-status")).toHaveText(
			"Answer incomplete",
		);
		const readReceipt = async () => {
			const response = await page.request.get(`/api/conversations/${id}`);
			expect(response.ok()).toBe(true);
			const detail: { messages: ChatMessage[] } = await response.json();
			const assistants = detail.messages.filter(
				(message) => message.role === "assistant",
			);
			expect(assistants).toHaveLength(1);
			expect(assistants[0].content).toBe("");
			expect(assistants[0].normalChatOutput?.completion).toMatchObject({
				outcome: "incomplete",
				stopCause: "context_capacity",
				workingStopCause: "context_capacity",
				phase: "working",
				closingAttempted: false,
			});
			return assistants[0];
		};
		const before = await readReceipt();
		expect(
			provider
				.requests()
				.filter((request) => request.path === "/v1/chat/completions"),
		).toHaveLength(0);
		await page.reload();
		await waitForHydration(page);
		await expect(page.getByTestId("stop-button")).toHaveCount(0);
		await expect(page.getByTestId("normal-chat-output-status")).toHaveText(
			"Answer incomplete",
		);
		const after = await readReceipt();
		expect(after.id).toBe(before.id);
		expect(after.normalChatOutput).toEqual(before.normalChatOutput);
		expect(
			provider
				.requests()
				.filter((request) => request.path === "/v1/chat/completions"),
		).toHaveLength(0);
	});

	for (const reducedMotion of ["no-preference", "reduce"] as const) {
		test(`working commentary stays activity; final Markdown survives reload, Copy and export (${reducedMotion})`, async ({
			page,
			context,
		}) => {
			await page.emulateMedia({ reducedMotion });
			await context.grantPermissions(["clipboard-read", "clipboard-write"]);
			const id = await start(page, "tool");
			await expect.poll(() => requests().length).toBe(2);
			await inspectLiveWorkingPhase(page);
			const liveHeadline = page
				.getByTestId("assistant-message")
				.locator(".thinking-label.is-active .thinking-label-text");
			await expect(liveHeadline).toBeVisible();
			const animation = await liveHeadline.evaluate(
				(node) => getComputedStyle(node).animationName,
			);
			if (reducedMotion === "reduce") expect(animation).toBe("none");
			else expect(animation).toContain("thinking-sweep");
			await expect(
				prose(page).getByText("Let me check.", { exact: false }),
			).toHaveCount(0);
			await expect(
				prose(page).getByRole("heading", { name: "Result" }),
			).toHaveCount(0);
			const result = completionWireMessages(requests()[1].body).filter(
				(m) => m.role === "tool" && m.tool_call_id === COMPLETION_CALL_ID,
			);
			expect(result).toHaveLength(1);
			expect(result[0].content).toBeTruthy();
			provider.release(COMPLETION_HOLD);
			await ended(page);
			await finalAnswer(page);
			expect((await savedOutput(page, id)).answer).toBe(COMPLETION_ANSWER);
			await expect(
				page.getByText(COMPLETION_WORKING, { exact: true }),
			).not.toBeVisible();
			await exportedAnswer(page, id);
			await page.reload();
			await waitForHydration(page);
			await finalAnswer(page);
			await page.getByTestId("assistant-message").last().hover();
			await page
				.getByRole("button", { name: "Copy message", exact: true })
				.last()
				.click();
			await expect
				.poll(() => page.evaluate(() => navigator.clipboard.readText()))
				.toBe(COMPLETION_ANSWER);
			await exportedAnswer(page, id);
			expect(requests()).toHaveLength(2);
		});
	}

	test("natural answer chunks are visible before the provider finishes", async ({
		page,
	}) => {
		await start(page, "live-natural");
		await expect.poll(() => requests().length).toBe(1);
		await expect(
			prose(page).getByRole("heading", { name: "Result", exact: true }),
		).toBeVisible();
		await expect(prose(page)).not.toContainText("The checked result is");
		await expect(page.getByTestId("stop-button")).toBeVisible();
		provider.release(COMPLETION_CHUNK_HOLD);
		await finalAnswer(page);
		await expect(page.getByTestId("stop-button")).toBeVisible();
		await expect(page.getByTestId("normal-chat-commentary")).toHaveCount(0);
		provider.release(COMPLETION_STEP_HOLD);
		await ended(page);
		await finalAnswer(page);
		expect(requests()).toHaveLength(1);
	});

	test("live prose is withdrawn when its step calls a tool and never reaches saved answer actions", async ({
		page,
		context,
	}) => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		const id = await start(page, "live-tool");
		await expect(prose(page)).toContainText("Hello.");
		await expect(prose(page)).not.toContainText("Let me check.");
		provider.release(COMPLETION_CHUNK_HOLD);
		await expect(prose(page)).toContainText(COMPLETION_WORKING);
		await expect(page.getByTestId("stop-button")).toBeVisible();
		await expect(page.getByTestId("normal-chat-commentary")).toHaveCount(0);
		provider.release(COMPLETION_STEP_HOLD);
		await expect.poll(() => requests().length).toBe(2);
		await expect(prose(page)).not.toContainText(COMPLETION_WORKING);
		await inspectLiveWorkingPhase(page);
		provider.release(COMPLETION_HOLD);
		await ended(page);
		await finalAnswer(page);
		expect((await savedOutput(page, id)).answer).toBe(COMPLETION_ANSWER);
		await exportedAnswer(page, id);
		await page.reload();
		await waitForHydration(page);
		await finalAnswer(page);
		await page.getByTestId("assistant-message").hover();
		await page
			.getByTestId("assistant-message")
			.locator("..")
			.getByRole("button", { name: "Copy message", exact: true })
			.click();
		await expect
			.poll(() => page.evaluate(() => navigator.clipboard.readText()))
			.toBe(COMPLETION_ANSWER);
		expect(requests()).toHaveLength(2);
	});

	test("a natural terminal answer needs no extra closing generation", async ({
		page,
	}) => {
		await start(page, "natural");
		await expect.poll(() => requests().length).toBe(1);
		provider.release(COMPLETION_HOLD);
		await ended(page);
		await finalAnswer(page);
		expect(requests()).toHaveLength(1);
	});

	for (const mode of [
		"reasoning-only",
		"length",
		"stagnation",
		"budget",
	] as const) {
		test(`${mode} reserves one tools-disabled closing with original context`, async ({
			page,
		}) => {
			const id = await start(page, mode);
			await expect
				.poll(() => closingRequests().length, { timeout: 30_000 })
				.toBe(1);
			const closing = closingRequests()[0].body;
			expect(JSON.stringify(closing)).toContain(completionMessage(mode));
			if (mode === "budget" || mode === "stagnation") {
				const messages = completionWireMessages(closing);
				expect(
					messages.filter(
						(m) => m.role === "tool" && m.tool_call_id === COMPLETION_CALL_ID,
					),
				).toHaveLength(1);
				expect(JSON.stringify(messages)).toContain("completion-evidence");
			}
			provider.release(COMPLETION_HOLD);
			await ended(page);
			await finalAnswer(page);
			await exportedAnswer(page, id);
			expect(closingRequests()).toHaveLength(1);
		});
	}

	for (const mode of [
		"closing-error",
		"closing-empty",
		"closing-truncated",
	] as const) {
		test(`${mode} terminates explicitly without recursive closing or tool replay`, async ({
			page,
		}) => {
			const id = await start(page, mode);
			await expect.poll(() => closingRequests().length).toBe(1);
			provider.release(COMPLETION_HOLD);
			await ended(page);
			const outcome = mode === "closing-error" ? "failed" : "incomplete";
			const label = outcome === "failed" ? "Reply failed" : "Answer incomplete";
			await expect(page.getByTestId("normal-chat-output-status")).toHaveText(
				label,
			);
			expect((await savedOutput(page, id)).completion).toMatchObject({
				outcome,
				phase: "closing",
				closingAttempted: true,
			});
			await expect(
				prose(page).getByText(COMPLETION_WORKING, { exact: false }),
			).toHaveCount(0);
			if (mode === "closing-truncated") {
				await expect(prose(page)).toContainText("The checked result is");
				const exported = await page.request.get(
					`/api/conversations/${id}/export.md`,
				);
				expect(exported.ok()).toBe(true);
				expect(await exported.text()).toContain(COMPLETION_PARTIAL);
			}
			await page.reload();
			await waitForHydration(page);
			await expect(page.getByTestId("stop-button")).toHaveCount(0);
			await expect(page.getByTestId("normal-chat-output-status")).toHaveText(
				label,
			);
			expect(closingRequests()).toHaveLength(1);
			expect(
				requests().filter((r) => !completionToolsOff(r.body)),
			).toHaveLength(2);
		});
	}

	test("working and closing usage are charged once, including after reload", async ({
		page,
	}) => {
		const id = await start(page, "length", true);
		await expect.poll(() => closingRequests().length).toBe(1);
		provider.release(COMPLETION_HOLD);
		await ended(page);
		await finalAnswer(page);
		const messageId = await page
			.getByTestId("assistant-message")
			.last()
			.getAttribute("data-message-id");
		expect(messageId).toBeTruthy();
		const usage = async () => {
			const response = await page.request.get(
				`/api/conversations/${id}/messages/${messageId}/usage`,
			);
			expect([200, 202]).toContain(response.status());
			return response.json();
		};
		// Two provider calls, each 31 input + 13 output tokens at $0.001/token.
		await expect.poll(usage).toMatchObject({
			status: "ready",
			costUsd: 0.088,
			totalCostUsdMicros: 88_000,
		});
		await page.reload();
		await waitForHydration(page);
		await finalAnswer(page);
		expect(await usage()).toMatchObject({
			status: "ready",
			costUsd: 0.088,
			totalCostUsdMicros: 88_000,
		});
		// The standalone usage endpoint can be correct while the normal reload
		// projection loses its values. Check the saved reply and the real UI too.
		const detailResponse = await page.request.get(`/api/conversations/${id}`);
		expect(detailResponse.ok()).toBe(true);
		const detail = await detailResponse.json();
		expect(
			detail.messages.find(
				(message: { id: string }) => message.id === messageId,
			),
		).toMatchObject({
			id: messageId,
			costUsd: 0.088,
			responseTokenCount: 26,
			totalTokenCount: 88,
		});
		await expect(page.getByTestId("assistant-message").last()).toHaveAttribute(
			"data-message-id",
			messageId as string,
		);
		await page.getByTestId("context-usage-ring").click();
		const costPopover = page.getByTestId("context-usage-popover");
		await expect(costPopover).toBeVisible();
		await expect(costPopover.locator(".popover-cost-secondary")).toHaveText(
			"$0.0880",
		);
		expect(requests()).toHaveLength(2);
	});

	test("stop while a tool result is available prevents closing and retains activity separately", async ({
		page,
	}) => {
		const id = await start(page, "tool");
		await expect.poll(() => requests().length).toBe(2);
		await inspectLiveWorkingPhase(page);
		await page.getByTestId("stop-button").click();
		provider.release(COMPLETION_HOLD);
		await ended(page);
		const output = await savedOutput(page, id);
		expect(output.answer).toBe("");
		expect(output.completion).toMatchObject({
			outcome: "stopped",
			closingAttempted: false,
		});
		const segment = page.getByTestId("assistant-message");
		const disclosure = segment.locator(".thinking-header");
		// Expanding while live did not authorize the newly stopped segment.
		await expect(disclosure).toHaveAttribute("aria-expanded", "true");
		await expect(segment.getByTestId("normal-chat-commentary")).toHaveCount(0);
		await disclosure.click();
		await expect(disclosure).toHaveAttribute("aria-expanded", "false");
		await disclosure.click();
		await expect(segment.getByTestId("normal-chat-commentary")).toHaveText(
			COMPLETION_WORKING,
		);
		await page.reload();
		await waitForHydration(page);
		await expect(segment.getByTestId("normal-chat-commentary")).toHaveCount(0);
		await disclosure.click();
		await expect(segment.getByTestId("normal-chat-commentary")).toHaveText(
			COMPLETION_WORKING,
		);
		expect((await savedOutput(page, id)).answer).toBe("");
		await expect(
			prose(page).getByText(COMPLETION_WORKING, { exact: false }),
		).toHaveCount(0);
		const exported = await page.request.get(
			`/api/conversations/${id}/export.md`,
		);
		expect(exported.ok()).toBe(true);
		expect(await exported.text()).not.toContain(COMPLETION_WORKING);
		expect(closingRequests()).toHaveLength(0);
		expect(requests()).toHaveLength(2);
	});

	test("pause survives reload and resumes with the answer to the original ask", async ({
		page,
	}) => {
		await start(page, "pause");
		await expect(page.getByTestId("ask-card")).toBeVisible({ timeout: 30_000 });
		expect(requests()).toHaveLength(1);
		expect(closingRequests()).toHaveLength(0);
		await page.reload();
		await waitForHydration(page);
		await page
			.getByRole("button", { name: "The checked result, recommended" })
			.click();
		await expect.poll(() => requests().length).toBe(2);
		const answer = completionWireMessages(requests()[1].body).find(
			(m) => m.role === "tool" && m.tool_call_id === "call_completion_ask",
		);
		expect(JSON.stringify(answer?.content)).toContain("The checked result");
		provider.release(COMPLETION_HOLD);
		await ended(page);
		await finalAnswer(page);
		expect(requests()).toHaveLength(2);
	});

	test("closing and reload do not repeat an already executed artifact write", async ({
		page,
	}) => {
		const id = await start(page, "side-effect");
		await expect.poll(() => closingRequests().length).toBe(1);
		const closing = completionWireMessages(closingRequests()[0].body);
		expect(
			closing.filter(
				(m) => m.role === "tool" && m.tool_call_id === "call_completion_create",
			),
		).toHaveLength(1);
		expect(
			closing.filter(
				(m) =>
					m.role === "tool" &&
					m.tool_call_id === "call_completion_read_created",
			),
		).toHaveLength(1);
		provider.release(COMPLETION_HOLD);
		await ended(page);
		await finalAnswer(page);
		await page.reload();
		await waitForHydration(page);
		await finalAnswer(page);
		const listed = await page.request.get(
			`/api/artifacts?conversationId=${id}`,
		);
		expect(listed.ok()).toBe(true);
		const body = await listed.json();
		expect(
			body.artifacts.filter(
				(a: { title: string }) => a.title === COMPLETION_ARTIFACT_TITLE,
			),
		).toHaveLength(1);
		expect(requests()).toHaveLength(4);
		expect(closingRequests()).toHaveLength(1);
	});

	test("closing synthesizes a useful partial with the complete later tool evidence", async ({
		page,
	}) => {
		const id = await start(page, "useful-partial");
		await expect.poll(() => closingRequests().length).toBe(1);
		const messages = completionWireMessages(closingRequests()[0].body);
		const readResult = messages.find(
			(m) =>
				m.role === "tool" && m.tool_call_id === "call_completion_read_created",
		);
		expect(JSON.stringify(readResult?.content)).toContain(
			COMPLETION_EVIDENCE_TAIL,
		);
		expect(
			JSON.stringify(messages.filter((m) => m.role === "assistant")),
		).toContain(COMPLETION_USEFUL_WORKING);
		provider.release(COMPLETION_HOLD);
		await ended(page);
		await expect(
			prose(page).last().getByRole("heading", { name: "Result", exact: true }),
		).toBeVisible();
		await expect(prose(page).last()).toContainText(
			"6 × 7 = 42. Archive key: ORCHID-73. Dispatch is Tuesday.",
		);
		await expect(
			prose(page).getByText(COMPLETION_USEFUL_WORKING, { exact: false }),
		).toHaveCount(0);
		await page.reload();
		await waitForHydration(page);
		await expect(prose(page).last()).toContainText(
			"6 × 7 = 42. Archive key: ORCHID-73. Dispatch is Tuesday.",
		);
		const exported = await page.request.get(
			`/api/conversations/${id}/export.md`,
		);
		expect(exported.ok()).toBe(true);
		const markdown = await exported.text();
		expect(markdown).toContain(COMPLETION_SYNTHESIS);
		expect(markdown).not.toContain(COMPLETION_USEFUL_WORKING);
		expect(requests()).toHaveLength(4);
	});

	test("reload attaches while running; another observer after completion cannot start tools again", async ({
		page,
		context,
	}) => {
		const started = page.waitForRequest(
			(request) =>
				request.method() === "POST" &&
				new URL(request.url()).pathname === "/api/chat/stream",
		);
		const id = await start(page, "tool");
		const original = (await started).postDataJSON() as { streamId: string };
		expect(original.streamId).toBeTruthy();
		await expect.poll(() => requests().length).toBe(2);
		await page.reload();
		await waitForHydration(page);
		await expect(page.getByTestId("stop-button")).toBeVisible();
		provider.release(COMPLETION_HOLD);
		await ended(page);
		await finalAnswer(page);
		const observer = await context.newPage();
		try {
			await observer.goto(`/chat/${id}`);
			await waitForHydration(observer);
			await finalAnswer(observer);
			await exportedAnswer(observer, id);
			const observed = await observer.request.post("/api/chat/stream", {
				headers: { Origin: new URL(observer.url()).origin },
				data: {
					message: "",
					conversationId: id,
					streamId: original.streamId,
					reconnectToStreamId: original.streamId,
				},
			});
			expect(observed.ok()).toBe(true);
			const payloads = decodeAiSdkUiStreamPayloads(await observed.text());
			expect(
				payloads.some((part) => part !== "[DONE]" && part.type === "finish"),
			).toBe(true);
			expect(
				payloads.some((part) => {
					if (part === "[DONE]") return false;
					const data = part.data as
						| {
								type?: string;
								completion?: { outcome?: string };
								observation?: {
									state?: string;
									completion?: { outcome?: string };
								};
						  }
						| undefined;
					return (
						(part.type === "data-normal-chat-output" &&
							data?.type === "completion" &&
							data.completion?.outcome === "answered") ||
						(part.type === "data-stream-metadata" &&
							data?.observation?.state === "terminal" &&
							data.observation.completion?.outcome === "answered")
					);
				}),
			).toBe(true);
			expect(requests()).toHaveLength(2);
		} finally {
			await observer.close();
		}
	});
});
