import { once } from "node:events";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
	type APIRequestContext,
	expect,
	type Page,
	test,
} from "@playwright/test";
import { TEST_EMAIL, TEST_PASSWORD } from "./helpers";

// Atlas runs pipeline v3 exclusively (ADR 0063, Phase B of the v3-only
// consolidation). This flow drives a real v3 job end to end against a fake
// OpenAI-compatible model server and a fake Parallel API: kickoff through
// /api/chat/send, the worker's ask → research → outline → answer → write →
// critic → verify → render phases, the activity row's live stage line across
// a reload, and the rendered HTML report in the document workspace.

const GENERATED_TITLE = "Generated Enterprise RAG Strategy";
const ATLAS_E2E_MODEL = "alfyai-atlas-e2e-model";
const ATLAS_E2E_API_KEY = "fake-atlas-e2e-key";
const ATLAS_ADMIN_CONFIG_KEYS = [
	"ATLAS_WORKER_ENABLED",
	"ATLAS_GLOBAL_ACTIVE_LIMIT",
	"ATLAS_SYNTHESIS_MODEL",
	"ATLAS_AUDIT_MODEL",
	"PARALLEL_API_KEY",
	"PARALLEL_BASE_URL",
] as const;

const FAKE_PARALLEL_API_KEY = "fake-atlas-e2e-parallel-key";

type AtlasAdminConfigKey = (typeof ATLAS_ADMIN_CONFIG_KEYS)[number];

type TemporaryProviderModel = {
	providerId: string;
	modelId: string;
	selectedModel: `provider:${string}:${string}`;
};

type AdminConfigSnapshot = Record<AtlasAdminConfigKey, string>;

type CapturedModelRequest = {
	path: string;
	body: unknown;
};

test.use({ hasTouch: true });

test.describe("Atlas job app flow", () => {
	test.setTimeout(120_000);

	test("restores progress after reload and previews the completed HTML report", async ({
		page,
		request,
	}) => {
		const searchServer = await startFakeAtlasSearchServer();
		const modelServer = await startFakeAtlasModelServer({
			outlineDelayMs: 10_000,
		});
		let providerModel: TemporaryProviderModel | null = null;
		let configSnapshot: AdminConfigSnapshot | null = null;

		try {
			await loginViaApi(request);
			await applyApiCookiesToPage(request, page);

			providerModel = await createTemporaryProviderModel(
				request,
				modelServer.baseURL,
			);
			configSnapshot = await snapshotAdminConfig(request);
			await updateAdminConfig(request, {
				ATLAS_WORKER_ENABLED: "true",
				ATLAS_GLOBAL_ACTIVE_LIMIT: "1",
				ATLAS_SYNTHESIS_MODEL: providerModel.selectedModel,
				ATLAS_AUDIT_MODEL: providerModel.selectedModel,
				// Point the Parallel client at the local fake so the Atlas worker
				// gathers sources from POST /v1/search + POST /v1/extract. The worker
				// reads getConfig().parallelApiKey/parallelBaseUrl, both refreshed from
				// admin_config after this PUT, so interception is fully in-process.
				PARALLEL_API_KEY: FAKE_PARALLEL_API_KEY,
				PARALLEL_BASE_URL: searchServer.origin,
			});

			const conversationId = await createConversation(request);
			const atlasJob = await startAtlasJob(request, conversationId);
			expect(atlasJob.id, "Atlas kickoff returned no job id").toBeTruthy();

			await page.goto(`/chat/${conversationId}`, {
				waitUntil: "domcontentloaded",
			});
			// The Atlas job renders as a unified activity row: while it runs the row
			// is pinned open and its body carries the stage line. The fake model
			// holds the first outline call, so the v3 "outline" phase is on screen
			// long enough to survive a reload.
			const row = page.getByTestId("atlas-activity-row");
			await expect(row.getByTestId("atlas-stage-line")).toContainText(
				"Outlining",
				{ timeout: 30_000 },
			);

			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(
				page.getByTestId("atlas-activity-row").getByTestId("atlas-stage-line"),
			).toContainText("Outlining", { timeout: 15_000 });

			const restoredRow = page.getByTestId("atlas-activity-row");
			// Settled: the row's own status flips to done and the body opens on the
			// Report tab with the document row's Open button.
			await expect(
				restoredRow.getByTestId("tool-activity-row"),
			).toHaveAttribute("data-status", "done", { timeout: 90_000 });
			const openButton = restoredRow.getByTestId("atlas-open-report");
			await expect(openButton).toBeEnabled({ timeout: 15_000 });
			await openButton.click();

			await expect(page.getByTestId("workspace-main")).toBeVisible({
				timeout: 15_000,
			});
			const report = page.frameLocator(
				`iframe[title="${GENERATED_TITLE}.html preview"]`,
			);
			await expect(
				report.getByRole("heading", { level: 1, name: GENERATED_TITLE }),
			).toBeVisible({ timeout: 15_000 });
			await expect(
				report.getByRole("heading", { name: GENERATED_TITLE }),
			).toHaveCount(1);
			// v3 opens on the verdict: the answer before any section.
			await expect(
				report.getByRole("heading", { name: "Verdict" }),
			).toBeVisible();
			await expect(
				report.getByRole("heading", { name: "Sources" }),
			).toHaveCount(1);
			await expect(
				report.getByRole("link", { name: /Vendor docs/ }).first(),
			).toHaveAttribute("href", VENDOR_URL);
			await expect(
				report.getByRole("link", { name: /Benchmark report/ }).first(),
			).toBeVisible();

			const bodyText = await report.locator("body").innerText();
			expect(countOccurrences(bodyText, GENERATED_TITLE)).toBe(1);
			// A written section and a real verdict, not an abstention report.
			expect(bodyText).toContain("retrieval review");
			expect(bodyText).not.toContain("does not answer the question");
			// Citation tokens are rendered, never leaked as raw markup.
			expect(bodyText).not.toContain("[[cite:");
			expect(
				modelServer
					.requests()
					.some((entry) =>
						JSON.stringify(entry.body).includes("Atlas stage: v3:ask."),
					),
				"the worker never ran the v3 ask stage",
			).toBe(true);
		} finally {
			if (configSnapshot) {
				await restoreAdminConfig(request, configSnapshot);
			}
			if (providerModel) {
				await deleteTemporaryProvider(request, providerModel.providerId);
			}
			await Promise.all([modelServer.stop(), searchServer.stop()]);
		}
	});
});

function countOccurrences(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

async function loginViaApi(request: APIRequestContext): Promise<void> {
	const response = await request.post("/api/auth/login", {
		data: {
			email: process.env.E2E_EMAIL ?? TEST_EMAIL,
			password: process.env.E2E_PASSWORD ?? TEST_PASSWORD,
		},
	});
	expect(
		response.ok(),
		`API login failed with status ${response.status()}: ${await response.text()}`,
	).toBe(true);
}

async function applyApiCookiesToPage(
	request: APIRequestContext,
	page: Page,
): Promise<void> {
	const state = await request.storageState();
	await page.context().addCookies(state.cookies);
}

async function createConversation(request: APIRequestContext): Promise<string> {
	const response = await request.post("/api/conversations", {
		data: { title: "Atlas E2E job flow", projectId: null },
	});
	expect(
		response.ok(),
		`conversation create failed with ${response.status()}: ${await response.text()}`,
	).toBe(true);
	const body = (await response.json()) as { id?: string };
	if (!body.id) {
		throw new Error("Conversation create returned no id.");
	}
	return body.id;
}

async function startAtlasJob(
	request: APIRequestContext,
	conversationId: string,
): Promise<{ id?: string }> {
	const response = await request.post("/api/chat/send", {
		data: {
			conversationId,
			message:
				"Create an Atlas report comparing enterprise RAG adoption patterns using current web evidence.",
			attachmentIds: [],
			linkedSources: [],
			atlasMode: true,
			atlasProfile: "in-depth",
			atlasAction: "create",
			parentAtlasId: null,
			clientAtlasTurnId: `atlas-e2e-${Date.now()}`,
		},
	});
	expect(
		response.ok(),
		`Atlas kickoff failed with ${response.status()}: ${await response.text()}`,
	).toBe(true);
	const body = (await response.json()) as { atlasJob?: { id?: string } };
	return body.atlasJob ?? {};
}

async function snapshotAdminConfig(
	request: APIRequestContext,
): Promise<AdminConfigSnapshot> {
	const response = await request.get("/api/admin/config");
	expect(
		response.ok(),
		`admin config snapshot failed with ${response.status()}: ${await response.text()}`,
	).toBe(true);
	const body = (await response.json()) as {
		overrides?: Record<string, string>;
	};
	return Object.fromEntries(
		ATLAS_ADMIN_CONFIG_KEYS.map((key) => [key, body.overrides?.[key] ?? ""]),
	) as AdminConfigSnapshot;
}

async function updateAdminConfig(
	request: APIRequestContext,
	config: Partial<Record<AtlasAdminConfigKey, string>>,
): Promise<void> {
	const response = await request.put("/api/admin/config", { data: config });
	expect(
		response.ok(),
		`admin config update failed with ${response.status()}: ${await response.text()}`,
	).toBe(true);
}

async function restoreAdminConfig(
	request: APIRequestContext,
	snapshot: AdminConfigSnapshot,
): Promise<void> {
	await updateAdminConfig(request, snapshot);
}

async function createTemporaryProviderModel(
	request: APIRequestContext,
	baseUrl: string,
): Promise<TemporaryProviderModel> {
	const unique = Date.now();
	const providerResponse = await request.post("/api/admin/providers", {
		data: {
			name: `atlas_e2e_provider_${unique}`,
			displayName: `Atlas E2E Provider ${unique}`,
			baseUrl,
			apiKey: ATLAS_E2E_API_KEY,
		},
	});
	expect(
		providerResponse.ok(),
		`provider create failed with ${providerResponse.status()}: ${await providerResponse.text()}`,
	).toBe(true);
	const providerBody = (await providerResponse.json()) as {
		provider?: { id?: string };
	};
	const providerId = providerBody.provider?.id;
	if (!providerId) {
		throw new Error("Provider create returned no id.");
	}

	const modelResponse = await request.post(
		`/api/admin/providers/${providerId}/models/batch`,
		{
			data: {
				models: [
					{
						name: ATLAS_E2E_MODEL,
						displayName: "Atlas E2E Model",
						contextLength: 8192,
						supportsChat: true,
						supportsTools: false,
					},
				],
			},
		},
	);
	expect(
		modelResponse.ok(),
		`provider model create failed with ${modelResponse.status()}: ${await modelResponse.text()}`,
	).toBe(true);
	const modelBody = (await modelResponse.json()) as {
		models?: Array<{ id?: string }>;
	};
	const modelId = modelBody.models?.[0]?.id;
	if (!modelId) {
		throw new Error("Provider model create returned no id.");
	}
	return {
		providerId,
		modelId,
		selectedModel: `provider:${providerId}:${modelId}`,
	};
}

async function deleteTemporaryProvider(
	request: APIRequestContext,
	providerId: string,
): Promise<void> {
	await request.delete(`/api/admin/providers/${providerId}`);
}

// Canned Parallel-shaped results, keyed by the page URL the Atlas worker will
// discover via /v1/search and then enrich via /v1/extract. The two pages sit on
// two different publishers and state the same figure, so v3's corroboration
// rule (two independent publishers) is met and the report answers rather than
// abstains. Their URLs are never fetched: /v1/extract serves them by URL.
const VENDOR_URL = "https://vendor.example/docs/rag-adoption";
const BENCHMARK_URL = "https://benchmark.example/reports/enterprise-rag";

function fakeParallelPages(): Array<{
	url: string;
	title: string;
	publish_date: string | null;
	excerpts: string[];
	full_content: string;
}> {
	return [
		{
			url: VENDOR_URL,
			title: "Vendor docs",
			publish_date: null,
			excerpts: [
				"Vendor docs say revenue increased by 12% after teams adopted retrieval review and source governance.",
			],
			full_content:
				"Revenue increased by 12% after enterprise teams adopted retrieval review, source governance, and rollout controls. The vendor evidence is useful but representative rather than exhaustive across every business unit.",
		},
		{
			url: BENCHMARK_URL,
			title: "Benchmark report",
			publish_date: null,
			excerpts: [
				"Benchmark report finds revenue increased by 12% where enterprise teams adopted retrieval review.",
			],
			full_content:
				"Across the benchmark cohort, revenue increased by 12% where enterprise teams adopted retrieval review and reviewer workflows. Adoption patterns otherwise differ by governance maturity.",
		},
	];
}

// Fake Parallel API. Serves POST /v1/search (source discovery) and
// POST /v1/extract (per-URL page content) in the JSON shape the Parallel client
// parses. The Atlas worker reaches this server because PARALLEL_BASE_URL is set
// to its origin via admin config.
async function startFakeAtlasSearchServer(): Promise<{
	origin: string;
	stop: () => Promise<void>;
}> {
	const server = createServer(
		async (request: IncomingMessage, response: ServerResponse) => {
			const origin = serverOrigin(server);
			const url = new URL(request.url ?? "/", origin);
			const pages = fakeParallelPages();

			if (request.method === "POST" && url.pathname === "/v1/search") {
				// Drain the request body (objective/search_queries) though the fake
				// returns the same deterministic sources regardless of the query.
				await readRequestBody(request);
				await writeJson(response, {
					search_id: "atlas-e2e-search",
					session_id: "atlas-e2e-session",
					results: pages.map(({ url, title, publish_date, excerpts }) => ({
						url,
						title,
						publish_date,
						excerpts,
					})),
				});
				return;
			}

			if (request.method === "POST" && url.pathname === "/v1/extract") {
				const body = parseJson(await readRequestBody(request)) as {
					urls?: unknown;
				} | null;
				const requestedUrls = Array.isArray(body?.urls)
					? (body?.urls.filter((u): u is string => typeof u === "string") ?? [])
					: [];
				const results =
					requestedUrls.length > 0
						? requestedUrls
								.map((requested) =>
									pages.find((page) => page.url === requested),
								)
								.filter((page): page is (typeof pages)[number] => Boolean(page))
						: pages;
				await writeJson(response, {
					extract_id: "atlas-e2e-extract",
					results,
					errors: [],
					warnings: [],
					usage: {},
				});
				return;
			}

			await writeJson(response, { error: "Not found" }, 404);
		},
	);
	await listen(server);
	return {
		origin: serverOrigin(server),
		stop: () => closeServer(server),
	};
}

async function startFakeAtlasModelServer(input: {
	outlineDelayMs: number;
}): Promise<{
	baseURL: string;
	requests: () => CapturedModelRequest[];
	stop: () => Promise<void>;
}> {
	const requests: CapturedModelRequest[] = [];
	let outlineCalls = 0;
	const server = createServer(
		async (request: IncomingMessage, response: ServerResponse) => {
			const url = new URL(request.url ?? "/", serverOrigin(server));
			if (request.method === "OPTIONS") {
				await writeJson(response, {});
				return;
			}
			if (request.method === "GET" && url.pathname === "/v1/models") {
				await writeJson(response, {
					object: "list",
					data: [{ id: ATLAS_E2E_MODEL, object: "model" }],
				});
				return;
			}
			if (
				request.method === "POST" &&
				url.pathname === "/v1/chat/completions"
			) {
				const body = parseJson(await readRequestBody(request));
				requests.push({ path: url.pathname, body });
				const { stage, prompt } = readAtlasV3Call(body);
				if (stage === "v3:outline") {
					outlineCalls += 1;
					if (outlineCalls === 1) await delay(input.outlineDelayMs);
				}
				const content = modelTextForV3Stage(stage, prompt);
				if (isStreamingChatCompletion(body)) {
					await writeChatCompletionStream(response, content);
				} else {
					await writeJson(response, chatCompletion(content));
				}
				return;
			}
			await writeJson(response, { error: "Not found" }, 404);
		},
	);
	await listen(server);
	return {
		baseURL: serverOrigin(server),
		requests: () => requests.slice(),
		stop: () => closeServer(server),
	};
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) =>
				part && typeof part === "object" && "text" in part
					? String((part as { text: unknown }).text)
					: "",
			)
			.join("");
	}
	return "";
}

/**
 * Every v3 model call ends its system prompt with `Atlas stage: v3:<name>…`
 * (atlas/model-stage.ts) and sends a JSON user prompt. The stage is reduced
 * to its family (`v3:read:s2` → `v3:read`); the prompt is parsed so the fake
 * can answer with ids the pipeline actually minted.
 */
function readAtlasV3Call(body: unknown): {
	stage: string;
	prompt: Record<string, unknown>;
} {
	const messages =
		body && typeof body === "object" && "messages" in body
			? ((body as { messages?: unknown }).messages as Array<{
					role?: string;
					content?: unknown;
				}>)
			: [];
	const system = messages
		.filter((message) => message.role === "system")
		.map((message) => messageText(message.content))
		.join("\n");
	const user = messages
		.filter((message) => message.role === "user")
		.map((message) => messageText(message.content))
		.join("\n");
	const match = system.match(/Atlas stage: (v3:[a-z]+)/);
	const parsed = parseJson(user);
	return {
		stage: match?.[1] ?? "unknown",
		prompt:
			parsed && typeof parsed === "object"
				? (parsed as Record<string, unknown>)
				: {},
	};
}

function idsIn(value: unknown, pattern: RegExp): string[] {
	return [...new Set(JSON.stringify(value ?? null).match(pattern) ?? [])].map(
		(id) => id.replaceAll('"', ""),
	);
}

function evidenceIds(prompt: Record<string, unknown>): string[] {
	const evidence = Array.isArray(prompt.evidence) ? prompt.evidence : [];
	return evidence
		.map((entry) =>
			entry && typeof entry === "object"
				? String((entry as { id?: unknown }).id ?? "")
				: "",
		)
		.filter(Boolean);
}

function modelTextForV3Stage(
	stage: string,
	prompt: Record<string, unknown>,
): string {
	switch (stage) {
		case "v3:ask":
			return JSON.stringify({
				decision: "How to roll out enterprise RAG safely",
				coreQuestion:
					"How do enterprise RAG adoption patterns compare, and what drives them?",
				title: GENERATED_TITLE,
				shape: "explanation",
				implicitRequirements: [],
				perspectives: ["platform teams"],
				subQuestions: [
					"Enterprise RAG adoption revenue outcomes",
					"Enterprise RAG retrieval quality controls",
				],
			});
		case "v3:searchplan":
			return JSON.stringify({ queries: ["enterprise RAG adoption"] });
		case "v3:read": {
			// Quote the page verbatim, as a real reader would: the sentence that
			// carries the figure.
			const page = typeof prompt.page === "string" ? prompt.page : "";
			const sentences = page.split(/(?<=\.)\s+/);
			const quote = (
				sentences.find((sentence) => /12%/.test(sentence)) ??
				sentences[0] ??
				""
			).trim();
			return JSON.stringify({
				quotes: [{ text: quote }],
				claims: /12%/.test(quote)
					? [
							{
								entity: "Enterprise teams",
								metric: "revenue increase after retrieval review",
								value: "12",
								unit: "%",
								quoteIndexes: [0],
							},
						]
					: [],
				useless: false,
			});
		}
		case "v3:note":
			return JSON.stringify({ summary: "Found the adoption evidence." });
		case "v3:memo":
			return JSON.stringify({
				answerSoFar:
					"Adoption depends on retrieval review and governance maturity.",
				claimIds: idsIn(prompt.claims, /"c\d+"/g),
			});
		case "v3:outline": {
			const claims = idsIn(prompt.claims, /"c\d+"/g);
			return JSON.stringify({
				nodes: claims.map((claimId, index) => ({
					id: `n${index + 1}`,
					title:
						index === 0
							? "Retrieval review pays off"
							: "Governance maturity shapes adoption",
					claim:
						index === 0
							? "Teams that adopt retrieval review see gains."
							: "Adoption patterns follow governance maturity.",
					needs: [],
					claimIds: [claimId],
				})),
				cut: [],
			});
		}
		case "v3:trial":
			return JSON.stringify({
				lead: "Revenue rose 12% where teams adopted retrieval review.",
				supportable: true,
			});
		case "v3:write": {
			const ids = evidenceIds(prompt);
			return JSON.stringify({
				paragraphs: [
					{
						sentences: [
							{
								text: "Enterprise teams that adopted retrieval review and source governance saw revenue increase by 12%.",
								evidenceIds: ids.slice(0, 1),
								kind: "claim",
								calcId: null,
							},
						],
					},
				],
				showAnswerTable: false,
			});
		}
		case "v3:verdict":
			return JSON.stringify({
				sentences: [
					{
						text: "Enterprise RAG adoption lifted revenue by 12% where teams paired it with retrieval review.",
						evidenceIds: evidenceIds(prompt).slice(0, 2),
						kind: "synthesis",
						calcId: null,
					},
				],
			});
		case "v3:critic":
			return JSON.stringify({ findings: [] });
		default:
			// Unscripted stages (the answer table) answer `{}`, which every v3
			// parser treats as unusable and falls back from.
			return "{}";
	}
}

function isStreamingChatCompletion(body: unknown): boolean {
	return (
		Boolean(body) &&
		typeof body === "object" &&
		(body as { stream?: unknown }).stream === true
	);
}

async function writeChatCompletionStream(
	response: ServerResponse,
	content: string,
): Promise<void> {
	response.writeHead(200, {
		"Access-Control-Allow-Headers": "authorization, content-type",
		"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
		"Access-Control-Allow-Origin": "*",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
		"Content-Type": "text/event-stream; charset=utf-8",
	});
	const chunkBase = {
		id: "chatcmpl_atlas_e2e",
		object: "chat.completion.chunk",
		created: 1_700_000_000,
		model: ATLAS_E2E_MODEL,
	};
	const writeChunk = (chunk: unknown): void => {
		response.write(`data: ${JSON.stringify(chunk)}\n\n`);
	};
	writeChunk({
		...chunkBase,
		choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
	});
	writeChunk({
		...chunkBase,
		choices: [{ index: 0, delta: { content }, finish_reason: null }],
	});
	writeChunk({
		...chunkBase,
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		usage: {
			prompt_tokens: 100,
			completion_tokens: 50,
			total_tokens: 150,
		},
	});
	response.write("data: [DONE]\n\n");
	response.end();
}

function chatCompletion(content: string): unknown {
	return {
		id: "chatcmpl_atlas_e2e",
		object: "chat.completion",
		created: 1_700_000_000,
		model: ATLAS_E2E_MODEL,
		choices: [
			{
				index: 0,
				message: { role: "assistant", content },
				finish_reason: "stop",
			},
		],
		usage: {
			prompt_tokens: 100,
			completion_tokens: 50,
			total_tokens: 150,
		},
	};
}

function parseJson(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString("utf8");
}

async function writeJson(
	response: ServerResponse,
	body: unknown,
	status = 200,
): Promise<void> {
	response.writeHead(status, {
		"Access-Control-Allow-Headers": "authorization, content-type",
		"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
		"Access-Control-Allow-Origin": "*",
		"Content-Type": "application/json; charset=utf-8",
	});
	response.end(JSON.stringify(body));
}

async function listen(server: Server): Promise<void> {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
}

function serverOrigin(server: Server): string {
	const address = server.address() as AddressInfo | null;
	if (!address) {
		throw new Error("Server is not listening.");
	}
	return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
	if (!server.listening) return;
	await new Promise<void>((resolve, reject) => {
		server.close((error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
