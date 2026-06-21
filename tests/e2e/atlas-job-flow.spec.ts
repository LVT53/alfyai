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
	type Locator,
	type Page,
	test,
} from "@playwright/test";
import { TEST_EMAIL, TEST_PASSWORD } from "./helpers";

const GENERATED_TITLE = "Generated Enterprise RAG Strategy";
const ATLAS_E2E_MODEL = "alfyai-atlas-e2e-model";
const ATLAS_E2E_API_KEY = "fake-atlas-e2e-key";
const BASIS_RATIONALE = "Accepted source states revenue increased by 12%.";
const ATLAS_ADMIN_CONFIG_KEYS = [
	"ATLAS_WORKER_ENABLED",
	"ATLAS_GLOBAL_ACTIVE_LIMIT",
	"ATLAS_SEARCH_CONCURRENCY",
	"ATLAS_SEARCH_BATCH_DELAY_MS",
	"ATLAS_SYNTHESIS_MODEL",
	"ATLAS_AUDIT_MODEL",
	"SEARXNG_BASE_URL",
	"WEB_RESEARCH_EXTRACTOR_MODE",
] as const;

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
			searchOrigin: searchServer.origin,
			coverageDelayMs: 10_000,
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
				ATLAS_SEARCH_CONCURRENCY: "1",
				ATLAS_SEARCH_BATCH_DELAY_MS: "0",
				ATLAS_SYNTHESIS_MODEL: providerModel.selectedModel,
				ATLAS_AUDIT_MODEL: providerModel.selectedModel,
				SEARXNG_BASE_URL: searchServer.origin,
				WEB_RESEARCH_EXTRACTOR_MODE: "direct",
			});

			const conversationId = await createConversation(request);
			const atlasJob = await startAtlasJob(request, conversationId);
			expect(atlasJob.id, "Atlas kickoff returned no job id").toBeTruthy();

			await page.goto(`/chat/${conversationId}`, {
				waitUntil: "domcontentloaded",
			});
			const card = page.getByTestId("atlas-card");
			await expect(card).toContainText("Checking evidence coverage", {
				timeout: 30_000,
			});

			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(page.getByTestId("atlas-card")).toContainText(
				"Checking evidence coverage",
				{ timeout: 15_000 },
			);

			const restoredCard = page.getByTestId("atlas-card");
			await expect(
				restoredCard.getByTestId("atlas-completion-icon"),
			).toBeVisible({ timeout: 90_000 });
			const openButton = restoredCard.getByRole("button", {
				name: "Open",
				exact: true,
			});
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
			await expect(
				report.getByRole("heading", { name: "Executive Summary" }),
			).toBeVisible();

			await expect(
				report.getByRole("heading", { name: "Sources" }),
			).toHaveCount(1);
			await expect(
				report.getByRole("link", { name: "Vendor docs", exact: true }),
			).toHaveAttribute("href", `${searchServer.origin}/source/vendor`);
			await expect(
				report.getByRole("link", { name: "Benchmark report", exact: true }),
			).toBeVisible();

			const bodyText = await report.locator("body").innerText();
			expect(countOccurrences(bodyText, GENERATED_TITLE)).toBe(1);
			expect(
				await report.locator("body").evaluate((body, generatedTitle) => {
					const contentNodes = Array.from(
						body.querySelectorAll("h1, h2, h3, h4, p, li"),
					);
					let pastCanonicalTitle = false;
					for (const node of contentNodes) {
						const text = node.textContent?.replace(/\s+/g, " ").trim() ?? "";
						if (!pastCanonicalTitle) {
							if (node.tagName === "H1" && text === generatedTitle) {
								pastCanonicalTitle = true;
							}
							continue;
						}
						if (/^Executive Summary$/i.test(text)) return false;
						if (text.includes(generatedTitle)) return true;
					}
					return false;
				}, GENERATED_TITLE),
			).toBe(false);
			expect(bodyText).not.toMatch(/Honesty Markers/i);

			const marker = report.getByRole("button", {
				name: `Supported claim: ${BASIS_RATIONALE}`,
			});
			await expect(marker).toBeVisible();

			await marker.hover();
			await expectBasisPanel(marker);
			await marker.focus();
			await expect(marker).toBeFocused();
			await expectBasisPanel(marker);
			await marker.tap();
			await expectBasisPanel(marker);
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

async function expectBasisPanel(marker: Locator): Promise<void> {
	const tooltip = marker.getByRole("tooltip");
	await expect(tooltip).toBeVisible();
	await expect(tooltip.locator("strong").first()).toHaveText("Supported claim");
	await expect(tooltip).toContainText(BASIS_RATIONALE);
}

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

async function startFakeAtlasSearchServer(): Promise<{
	origin: string;
	stop: () => Promise<void>;
}> {
	const server = createServer(
		async (request: IncomingMessage, response: ServerResponse) => {
			const origin = serverOrigin(server);
			const url = new URL(request.url ?? "/", origin);
			if (request.method === "GET" && url.pathname === "/search") {
				await writeJson(response, {
					results: [
						{
							title: "Vendor docs",
							url: `${origin}/source/vendor`,
							content:
								"Vendor docs say revenue increased by 12% after teams adopted retrieval review and source governance.",
						},
						{
							title: "Benchmark report",
							url: `${origin}/source/benchmark`,
							content:
								"Benchmark report compares enterprise RAG adoption patterns and highlights retrieval quality controls.",
						},
					],
				});
				return;
			}
			if (request.method === "GET" && url.pathname === "/source/vendor") {
				await writeHtml(
					response,
					[
						"<h1>Vendor docs</h1>",
						"<p>Revenue increased by 12% after enterprise teams adopted retrieval review, source governance, and rollout controls.</p>",
						"<p>The vendor evidence is useful but representative rather than exhaustive across every business unit.</p>",
					].join(""),
				);
				return;
			}
			if (request.method === "GET" && url.pathname === "/source/benchmark") {
				await writeHtml(
					response,
					[
						"<h1>Benchmark report</h1>",
						"<p>Enterprise RAG adoption patterns differ by retrieval quality, reviewer workflow, and governance maturity.</p>",
						"<p>The benchmark report supports comparing adoption patterns without claiming universal rollout success.</p>",
					].join(""),
				);
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
	searchOrigin: string;
	coverageDelayMs: number;
}): Promise<{
	baseURL: string;
	requests: () => CapturedModelRequest[];
	stop: () => Promise<void>;
}> {
	const requests: CapturedModelRequest[] = [];
	let coverageReviewCalls = 0;
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
				const stage = detectAtlasStage(body);
				if (stage === "coverage-review") {
					coverageReviewCalls += 1;
					if (coverageReviewCalls === 1) {
						await delay(input.coverageDelayMs);
					}
				}
				await writeJson(
					response,
					chatCompletion(modelTextForStage(stage, input)),
				);
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

type AtlasFakeStage =
	| "decompose"
	| "curate"
	| "coverage-review"
	| "synthesize"
	| "integrate"
	| "assemble"
	| "audit"
	| "unknown";

function detectAtlasStage(body: unknown): AtlasFakeStage {
	const serialized = JSON.stringify(body);
	for (const stage of [
		"decompose",
		"curate",
		"coverage-review",
		"synthesize",
		"integrate",
		"assemble",
	] as const) {
		if (serialized.includes(`Atlas stage: ${stage}.`)) return stage;
	}
	if (serialized.includes("Audit the Atlas report")) return "audit";
	if (serialized.includes("Generate Atlas Claim Basis audit data"))
		return "audit";
	return "unknown";
}

function modelTextForStage(
	stage: AtlasFakeStage,
	input: { searchOrigin: string },
): string {
	switch (stage) {
		case "decompose":
			return [
				"- enterprise RAG adoption revenue source governance",
				"- enterprise RAG benchmark retrieval quality controls",
			].join("\n");
		case "curate":
			return [
				"Curated fact: Vendor docs report revenue increased by 12% after retrieval review and source governance.",
				"Curated fact: Benchmark report compares adoption patterns across retrieval quality controls.",
			].join("\n");
		case "coverage-review":
			return JSON.stringify({ sufficient: true, proposals: [] });
		case "synthesize":
			return "Enterprise RAG programs benefit from retrieval review, source governance, and staged rollout because accepted web evidence shows adoption varies by team maturity.";
		case "integrate":
			return "Executive Summary; Findings on adoption and retrieval quality; Limitations for representative evidence.";
		case "assemble":
			return JSON.stringify({
				generatedTitle: GENERATED_TITLE,
				bodyMarkdown: [
					"## Executive Summary",
					"Revenue increased by 12% while adoption evidence remains directional because the accepted sources show uneven rollout across teams.",
					"",
					"## Findings",
					"Enterprise RAG programs benefit from a retrieval layer, citation review, and controlled rollout when source quality varies by business unit.",
					"",
					"## Limitations",
					"Accepted web evidence is representative rather than exhaustive, so the report should avoid universal rollout claims.",
					"",
					"## Sources",
					"- Model-authored duplicate source appendix that should be replaced by deterministic source chips.",
				].join("\n"),
				sectionBriefs: [
					{
						sectionTitle: "Executive Summary",
						brief: "Revenue and adoption claim grounded in Vendor docs.",
						evidencePackIds: [],
						sourceAssociations: [
							{
								sourceId: "vendor-docs",
								sourceKind: "web",
								sourceTitle: "Vendor docs",
								url: `${input.searchOrigin}/source/vendor`,
								evidencePackId: null,
								relevance: "Supports the revenue claim.",
							},
						],
						limitations: [],
					},
				],
				limitations: [],
			});
		case "audit":
			return JSON.stringify({
				retryRequested: false,
				claimBasis: [
					{
						locator: {
							sectionTitle: "Executive Summary",
							paragraphIndex: 0,
							claimIndex: 0,
							claimText: "Revenue increased by 12%",
							quote: "Revenue increased by 12%",
							startOffset: null,
							endOffset: null,
						},
						supportLevel: "supported",
						evidencePackIds: [],
						sourceRefs: [
							{
								id: "vendor-docs",
								kind: "web",
								title: "Vendor docs",
								url: `${input.searchOrigin}/source/vendor`,
								authority: "accepted_web",
							},
						],
						supportRationale: BASIS_RATIONALE,
						auditConcernCode: null,
					},
				],
				limitations: [],
				diagnostics: [],
			});
		default:
			return "Atlas deterministic fake model fallback.";
	}
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

async function writeHtml(
	response: ServerResponse,
	body: string,
	status = 200,
): Promise<void> {
	response.writeHead(status, {
		"Content-Type": "text/html; charset=utf-8",
	});
	response.end(`<!doctype html><html><body>${body}</body></html>`);
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
