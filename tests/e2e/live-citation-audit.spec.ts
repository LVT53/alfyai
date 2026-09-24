import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, type Page, test } from "@playwright/test";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import { messages } from "../../src/lib/server/db/schema";
import { login, sendMessage, waitForHydration } from "./helpers";

/**
 * The citation auto-repair summary (`citationAudit`) is persisted when the
 * assistant message is created — while the terminal stream frame is built later
 * and does NOT carry it, and before the evidence summary is composed. So on a
 * live page the Info popover's "Citation audit" row can only arrive through the
 * post-completion evidence poll; a normal turn skips the conversation-detail
 * hydration because its terminal frame already carries its own projection
 * fields.
 *
 * This spec defends the reader-visible half of that contract: after a
 * web-grounded turn, WITHOUT reloading the page,
 *   - the Info popover shows the "Citation audit" row and its counted sources,
 *   - and a reload still shows exactly one such row.
 *
 * It runs against a spec-local fake provider and a spec-local fake Parallel
 * Search server (both on loopback), so no live model or search API is needed.
 */

const MOCK_API_KEY = "fake-citation-audit-key";
const MOCK_MODEL_ID = "citation-audit-model";
const SOURCE_URL = "https://example.com/hotel-motto-stay";
const RESEARCH_ANSWER = `The booking covers two nights, 12-14 October, reference HM-88421. [Hotel Motto stay details](${SOURCE_URL})`;

type MockUpstream = {
	readonly origin: string;
	readonly baseURL: string;
	readonly chatRequests: number;
	start(): Promise<void>;
	stop(): Promise<void>;
	reset(): void;
};

/**
 * One loopback server serving both halves of the turn: the OpenAI-compatible
 * chat endpoint the app calls to generate the answer, and the Parallel Search
 * endpoint the `research_web` tool calls. The model answers only after it has
 * seen the tool result, so the two requests are distinguishable by whether the
 * conversation already carries a tool message.
 */
function createMockUpstream(): MockUpstream {
	let server: ReturnType<typeof createServer> | null = null;
	let origin = "";
	let chatRequests = 0;

	const chunkBase = {
		object: "chat.completion.chunk",
		created: 1_700_000_000,
		model: MOCK_MODEL_ID,
	};

	const stream = (frames: unknown[]): Response =>
		new Response(
			`${frames
				.map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
				.join("")}data: [DONE]\n\n`,
			{
				status: 200,
				headers: {
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
					"Content-Type": "text/event-stream; charset=utf-8",
				},
			},
		);

	const chatResponse = (body: unknown): Response => {
		const chatId = `chatcmpl_${randomUUID().slice(0, 8)}`;
		const alreadyRanResearch =
			Array.isArray((body as { messages?: unknown[] })?.messages) &&
			(body as { messages: Array<{ role?: string }> }).messages.some(
				(message) => message?.role === "tool",
			);

		if (alreadyRanResearch) {
			return stream([
				{
					...chunkBase,
					id: chatId,
					choices: [
						{ index: 0, delta: { role: "assistant" }, finish_reason: null },
					],
				},
				{
					...chunkBase,
					id: chatId,
					choices: [
						{
							index: 0,
							delta: { content: RESEARCH_ANSWER },
							finish_reason: null,
						},
					],
				},
				{
					...chunkBase,
					id: chatId,
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: {
						prompt_tokens: 120,
						completion_tokens: 24,
						total_tokens: 144,
					},
				},
			]);
		}

		return stream([
			{
				...chunkBase,
				id: chatId,
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_research_web_1",
									type: "function",
									function: {
										name: "research_web",
										arguments: JSON.stringify({
											query: "Hotel Motto Vienna booking stay",
										}),
									},
								},
							],
						},
						finish_reason: null,
					},
				],
			},
			{
				...chunkBase,
				id: chatId,
				choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
				usage: { prompt_tokens: 80, completion_tokens: 12, total_tokens: 92 },
			},
		]);
	};

	const searchResponse = (): Response =>
		new Response(
			JSON.stringify({
				search_id: "search_fake_1",
				results: [
					{
						url: SOURCE_URL,
						title: "Hotel Motto stay details",
						publish_date: null,
						excerpts: [
							"Two nights, 12-14 October, booking reference HM-88421.",
						],
					},
				],
			}),
			{
				status: 200,
				headers: { "Content-Type": "application/json; charset=utf-8" },
			},
		);

	async function handle(pathname: string, body: unknown): Promise<Response> {
		if (pathname === "/v1/search") return searchResponse();
		if (pathname === "/v1/chat/completions") {
			chatRequests += 1;
			return chatResponse(body);
		}
		if (pathname === "/v1/models") {
			return new Response(
				JSON.stringify({
					object: "list",
					data: [{ id: MOCK_MODEL_ID, object: "model" }],
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json; charset=utf-8" },
				},
			);
		}
		return new Response(JSON.stringify({ error: "Not found" }), {
			status: 404,
			headers: { "Content-Type": "application/json; charset=utf-8" },
		});
	}

	function write(serverResponse: ServerResponse, response: Response) {
		serverResponse.writeHead(
			response.status,
			Object.fromEntries(response.headers.entries()),
		);
		void response.text().then((text) => {
			serverResponse.end(text);
		});
	}

	return {
		get origin() {
			if (!origin) throw new Error("mock upstream is not running");
			return origin;
		},
		get baseURL() {
			if (!origin) throw new Error("mock upstream is not running");
			return `${origin}/v1`;
		},
		get chatRequests() {
			return chatRequests;
		},
		async start() {
			if (server) return;
			server = createServer((request, serverResponse) => {
				const chunks: Buffer[] = [];
				request.on("data", (chunk) => {
					chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
				});
				request.on("end", () => {
					const raw = Buffer.concat(chunks).toString("utf8");
					let body: unknown;
					try {
						body = raw ? JSON.parse(raw) : undefined;
					} catch {
						body = undefined;
					}
					const pathname = new URL(request.url ?? "/", "http://127.0.0.1")
						.pathname;
					void handle(pathname, body).then((response) =>
						write(serverResponse, response),
					);
				});
			});
			await new Promise<void>((resolve, reject) => {
				server?.once("error", reject);
				server?.listen(0, "127.0.0.1", () => {
					const address = server?.address();
					if (!address || typeof address === "string") {
						reject(new Error("mock upstream failed to resolve a port"));
						return;
					}
					origin = `http://127.0.0.1:${(address as AddressInfo).port}`;
					resolve();
				});
			});
		},
		async stop() {
			if (!server) return;
			await new Promise<void>((resolve) => {
				server?.close(() => resolve());
			});
			server = null;
			origin = "";
		},
		reset() {
			chatRequests = 0;
		},
	};
}

const mock = createMockUpstream();

test.describe("live citation audit", () => {
	test.beforeAll(async () => {
		await mock.start();
	});

	test.afterAll(async () => {
		await mock.stop();
	});

	test.beforeEach(async ({ page }) => {
		mock.reset();
		await page.setViewportSize({ width: 1440, height: 1000 });
		await login(page);
	});

	test("shows the Citation audit row without a reload", async ({ page }) => {
		const evidenceAnswers: string[] = [];
		page.on("response", (response) => {
			if (response.url().includes("/evidence")) {
				evidenceAnswers.push(String(response.status()));
			}
		});

		const turn = await runGroundedTurn(page);
		const popover = page.locator(".info-popover").last();

		// The row reads `citationAudit`, which no live frame carries: it is
		// persisted at message creation and read back by the evidence poll.
		await expect(
			popover.locator(".audit-row", { hasText: "Citation audit" }),
			"the Info popover's Citation audit row must be there without a reload",
		).toHaveCount(1, { timeout: 25000 });
		await expect(
			popover.locator(".audit-row", { hasText: "Citation audit" }),
		).toContainText("1 verified source");

		console.log(
			`[citation-live] conversation ${turn.conversationId.slice(0, 8)} · chat requests: ${mock.chatRequests} · evidence answers: ${
				evidenceAnswers.join(", ") || "(none seen)"
			}`,
		);
	});

	test("still shows one Citation audit row after a reload", async ({
		page,
	}) => {
		await runGroundedTurn(page);

		await page.reload({ waitUntil: "domcontentloaded" });
		const bubble = page.getByTestId("assistant-message").last();
		await expect(bubble).toContainText(/\S/, { timeout: 30000 });
		await waitForHydration(page);

		// One turn, one row: a reload (or a second hydration) must not
		// double-apply the persisted audit.
		await expect(
			page.locator(".info-popover").last().locator(".audit-row", {
				hasText: "Citation audit",
			}),
			"the reloaded page must still show exactly one Citation audit row",
		).toHaveCount(1, { timeout: 25000 });
	});
});

type GroundedTurn = { conversationId: string };

/** What the server actually holds for this turn, read from the row itself. */
async function persistedCitationAudit(conversationId: string) {
	const [row] = await db
		.select({ metadataJson: messages.metadataJson })
		.from(messages)
		.where(
			and(
				eq(messages.conversationId, conversationId),
				eq(messages.role, "assistant"),
			),
		);
	const metadata = row?.metadataJson
		? (JSON.parse(row.metadataJson) as Record<string, unknown>)
		: null;
	return metadata?.citationAudit;
}

/**
 * One grounded turn: a fake provider whose model calls `research_web` first
 * and only then cites the source the fake Parallel Search returned.
 */
async function runGroundedTurn(page: Page): Promise<GroundedTurn> {
	await setAdminConfig(page, {
		PARALLEL_API_KEY: MOCK_API_KEY,
		PARALLEL_BASE_URL: mock.origin,
	});
	await installFakeProvider(page);

	await page.goto("/", { waitUntil: "domcontentloaded" });
	await waitForHydration(page);
	await sendMessage(
		page,
		"What does the Hotel Motto booking say about the stay?",
	);
	await expect(page).toHaveURL(/\/chat\//, { timeout: 20000 });
	const conversationId = page.url().split("/chat/")[1]?.split(/[/?#]/)[0] ?? "";

	const bubble = page.getByTestId("assistant-message").last();
	await expect(bubble).toContainText(/\S/, { timeout: 30000 });

	// The server writes the audit as the message is created, so this only
	// proves the turn was grounded; whether the live page learns about it is
	// what the assertions above are for.
	await expect
		.poll(() => persistedCitationAudit(conversationId), {
			message: "the server must persist a citation audit for this turn",
			timeout: 25000,
		})
		.toMatchObject({ cited: 1, verified: 1 });

	return { conversationId };
}

async function setAdminConfig(page: Page, values: Record<string, string>) {
	const response = await page.evaluate(async (payload) => {
		const result = await fetch("/api/admin/config", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
		return { ok: result.ok, status: result.status };
	}, values);
	expect(response.ok, `admin config PUT -> ${response.status}`).toBe(true);
}

/** A deterministic fake provider, so the chat screen needs no real model. */
async function installFakeProvider(page: Page): Promise<string> {
	const result = await page.evaluate(
		async ({ apiKey, baseUrl, modelName }) => {
			const unique = Date.now();
			const providerResponse = await fetch("/api/admin/providers", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: `citation_live_${unique}`,
					displayName: `Citation live ${unique}`,
					baseUrl,
					apiKey,
				}),
			});
			const providerBody = (await providerResponse.json()) as {
				provider?: { id: string };
			};
			if (!providerResponse.ok || !providerBody.provider?.id) return null;

			const modelResponse = await fetch(
				`/api/admin/providers/${providerBody.provider.id}/models/batch`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						models: [
							{
								name: modelName,
								displayName: "Citation live model",
								contextLength: 8192,
								supportsChat: true,
								supportsTools: true,
							},
						],
					}),
				},
			);
			const modelBody = (await modelResponse.json()) as {
				models?: Array<{ id: string }>;
			};
			const modelId = modelBody.models?.[0]?.id;
			if (!modelResponse.ok || !modelId) return null;
			return `provider:${providerBody.provider.id}:${modelId}`;
		},
		{
			apiKey: MOCK_API_KEY,
			baseUrl: mock.baseURL,
			modelName: MOCK_MODEL_ID,
		},
	);
	expect(result, "the fake provider must register").toBeTruthy();
	if (!result) throw new Error("no fake provider model");
	await page.evaluate(async (preferredModel) => {
		await fetch("/api/settings/preferences", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ preferredModel }),
		});
		localStorage.setItem("selectedModel", preferredModel);
	}, result);
	return result;
}
