import { expect, type Page, test } from "@playwright/test";
import {
	COMPLETION_ANSWER,
	COMPLETION_ARTIFACT_TITLE,
	COMPLETION_CALL_ID,
	COMPLETION_EVIDENCE_TAIL,
	COMPLETION_HOLD,
	COMPLETION_PARTIAL,
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

	async function start(page: Page, mode: CompletionMode, priced = false) {
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
			{ data: { maxModelContext: 131_072, maxTokens: 4_096 } },
		);
		expect(configured.ok()).toBe(true);
		expect(await configured.json()).toMatchObject({
			model: { maxModelContext: 131_072, maxTokens: 4_096 },
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

	for (const reducedMotion of ["no-preference", "reduce"] as const) {
		test(`working commentary stays activity; final Markdown survives reload, Copy and export (${reducedMotion})`, async ({
			page,
			context,
		}) => {
			await page.emulateMedia({ reducedMotion });
			await context.grantPermissions(["clipboard-read", "clipboard-write"]);
			const id = await start(page, "tool");
			await expect.poll(() => requests().length).toBe(2);
			await expect(
				page.getByText(COMPLETION_WORKING, { exact: true }),
			).toBeVisible();
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
				.toBe(COMPLETION_ANSWER.trim());
			await exportedAnswer(page, id);
			expect(requests()).toHaveLength(2);
		});
	}

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
			// Assert a user-visible failure/incomplete state, not a guessed private outcome key.
			await expect(
				page
					.getByText(
						/incomplete|interrupted|could not complete|failed|something went wrong/i,
					)
					.first(),
			).toBeVisible();
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
		expect(requests()).toHaveLength(2);
	});

	test("stop while a tool result is available prevents closing and retains activity separately", async ({
		page,
	}) => {
		const id = await start(page, "tool");
		await expect.poll(() => requests().length).toBe(2);
		await expect(
			page.getByText(COMPLETION_WORKING, { exact: true }),
		).toBeVisible();
		await page.getByTestId("stop-button").click();
		provider.release(COMPLETION_HOLD);
		await ended(page);
		await page.reload();
		await waitForHydration(page);
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
		const id = await start(page, "tool");
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
			expect(requests()).toHaveLength(2);
		} finally {
			await observer.close();
		}
	});
});
