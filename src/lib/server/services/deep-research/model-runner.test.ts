import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "$lib/server/config-store";

const mocks = vi.hoisted(() => ({
	getProviderById: vi.fn(),
	getProviderWithSecrets: vi.fn(),
	decryptApiKey: vi.fn(),
	buildResearchUsageRecord: vi.fn(),
	getResearchUsageForeignKeyDiagnostics: vi.fn(),
	saveResearchUsageRecord: vi.fn(),
	warn: vi.fn(),
}));

let runtimeConfig: RuntimeConfig;

vi.mock("$lib/server/config-store", () => ({
	getConfig: () => runtimeConfig,
	getProviderById: (id: string) => mocks.getProviderById(id),
}));

vi.mock("$lib/server/services/inference-providers", () => ({
	getProviderWithSecrets: (id: string) => mocks.getProviderWithSecrets(id),
	decryptApiKey: (encrypted: string, iv: string) =>
		mocks.decryptApiKey(encrypted, iv),
}));

vi.mock("./usage", () => ({
	buildResearchUsageRecord: (input: unknown) =>
		mocks.buildResearchUsageRecord(input),
	getResearchUsageForeignKeyDiagnostics: (record: unknown) =>
		mocks.getResearchUsageForeignKeyDiagnostics(record),
	saveResearchUsageRecord: (record: unknown) =>
		mocks.saveResearchUsageRecord(record),
}));

import { tryRunAndRecordDeepResearchModel } from "./model-runner";

function baseConfig(): RuntimeConfig {
	return {
		requestTimeoutMs: 30_000,
		model1: {
			baseUrl: "https://model-one.example/v1",
			apiKey: "",
			modelName: "model-one",
			displayName: "Model One",
			maxTokens: 4096,
		},
		model2: {
			baseUrl: "https://model-two.example/v1",
			apiKey: "",
			modelName: "model-two",
			displayName: "Model Two",
			maxTokens: 8192,
		},
		model2Enabled: true,
		model1MaxModelContext: 100_000,
		model1CompactionUiThreshold: 80_000,
		model1TargetConstructedContext: 60_000,
		model1MaxMessageLength: 12_000,
		model2MaxModelContext: 200_000,
		model2CompactionUiThreshold: 160_000,
		model2TargetConstructedContext: 120_000,
		model2MaxMessageLength: 24_000,
		maxModelContext: 50_000,
		compactionUiThreshold: 40_000,
		targetConstructedContext: 30_000,
		maxMessageLength: 10_000,
		deepResearchModels: {
			plan_generation: "model1",
			plan_revision: "model1",
			source_review: "model1",
			research_task: "model1",
			synthesis: "model1",
			citation_audit: "provider:openrouter",
			report_writing: "model1",
		},
	} as RuntimeConfig;
}

function providerConfig() {
	return {
		id: "openrouter",
		displayName: "OpenRouter Research",
		baseUrl: "https://openrouter.ai/api/v1",
		modelName: "anthropic/claude-sonnet-4",
		enabled: true,
		maxModelContext: 180_000,
		compactionUiThreshold: 144_000,
		targetConstructedContext: 108_000,
		maxMessageLength: 30_000,
		maxTokens: 12_000,
		rateLimitFallbackEnabled: true,
		rateLimitFallbackBaseUrl: "https://api.moonshot.ai/v1",
		rateLimitFallbackApiKeyEncrypted: "encrypted-fallback",
		rateLimitFallbackApiKeyIv: "fallback-iv",
		rateLimitFallbackModelName: "kimi-k2.6",
		rateLimitFallbackTimeoutMs: 12_000,
	};
}

describe("Deep Research model runner", () => {
	beforeEach(() => {
		runtimeConfig = baseConfig();
		mocks.getProviderById.mockReset();
		mocks.getProviderWithSecrets.mockReset();
		mocks.decryptApiKey.mockReset();
		mocks.buildResearchUsageRecord.mockReset();
		mocks.getResearchUsageForeignKeyDiagnostics.mockReset();
		mocks.saveResearchUsageRecord.mockReset();
		mocks.warn.mockReset();
		mocks.getProviderById.mockResolvedValue(providerConfig());
		mocks.getProviderWithSecrets.mockResolvedValue({
			...providerConfig(),
			apiKeyEncrypted: "encrypted-key",
			apiKeyIv: "iv",
		});
		mocks.decryptApiKey.mockReturnValue("provider-secret");
		mocks.buildResearchUsageRecord.mockImplementation((input) => ({
			id: "usage-record",
			...(input as object),
		}));
		mocks.getResearchUsageForeignKeyDiagnostics.mockResolvedValue({
			parentRows: {
				jobExists: true,
				conversationExists: true,
				userExists: true,
				taskExists: true,
			},
		});
		mocks.saveResearchUsageRecord.mockResolvedValue(undefined);
		vi.spyOn(console, "warn").mockImplementation(mocks.warn);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sends provider citation audit calls as valid OpenAI-compatible requests", async () => {
		let sentBody: Record<string, unknown> | null = null;
		const fetchImpl = vi.fn(
			async (_url: URL | RequestInfo, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body));
				sentBody = body;
				if ("chat_template_kwargs" in body || "extra_body" in body) {
					return new Response(JSON.stringify({ error: "unknown field" }), {
						status: 400,
						headers: { "Content-Type": "application/json" },
					});
				}
				return new Response(
					JSON.stringify({
						choices: [
							{
								message: {
									content:
										'{"claims":[{"claimId":"claim-1","status":"supported","reason":"Source supports it.","citationSourceIds":["source-1"]}]}',
								},
							},
						],
						usage: {
							prompt_tokens: 10,
							completion_tokens: 8,
							total_tokens: 18,
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			},
		);

		const result = await tryRunAndRecordDeepResearchModel({
			role: "citation_audit",
			jobId: "job-1",
			conversationId: "conversation-1",
			userId: "user-1",
			stage: "citation_audit",
			operation: "citation_audit",
			temperature: 0,
			maxTokens: 2600,
			messages: [
				{ role: "system", content: "Audit citations. Return only JSON." },
				{
					role: "user",
					content: JSON.stringify({
						report: { title: "Report", sections: [], limitations: [] },
						citedSources: [],
					}),
				},
			],
			fetchImpl,
		});

		expect(result?.content).toContain('"claimId":"claim-1"');
		expect(sentBody).toMatchObject({
			model: "anthropic/claude-sonnet-4",
			temperature: 0,
			max_tokens: 2600,
		});
		expect(sentBody).not.toHaveProperty("chat_template_kwargs");
		expect(sentBody).not.toHaveProperty("extra_body");
		expect(mocks.warn).not.toHaveBeenCalled();
		expect(mocks.saveResearchUsageRecord).toHaveBeenCalledOnce();
	});

	it("logs foreign-key diagnostics when usage attribution cannot be saved", async () => {
		const foreignKeyError = Object.assign(
			new Error("FOREIGN KEY constraint failed"),
			{ code: "SQLITE_CONSTRAINT_FOREIGNKEY" },
		);
		mocks.saveResearchUsageRecord.mockRejectedValueOnce(foreignKeyError);
		mocks.getResearchUsageForeignKeyDiagnostics.mockResolvedValueOnce({
			parentRows: {
				jobExists: true,
				conversationExists: true,
				userExists: true,
				taskExists: false,
			},
			usageForeignKeys: [{ table: "deep_research_tasks" }],
			usageForeignKeyViolations: [],
		});
		const fetchImpl = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					choices: [{ message: { content: '{"summary":"done"}' } }],
					usage: {
						prompt_tokens: 10,
						completion_tokens: 4,
						total_tokens: 14,
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const result = await tryRunAndRecordDeepResearchModel({
			role: "research_task",
			jobId: "job-1",
			taskId: "task-1",
			conversationId: "conversation-1",
			userId: "user-1",
			stage: "research_tasks",
			messages: [{ role: "user", content: "Do task" }],
			fetchImpl,
		});

		expect(result?.content).toBe('{"summary":"done"}');
		expect(mocks.getResearchUsageForeignKeyDiagnostics).toHaveBeenCalledWith(
			expect.objectContaining({
				jobId: "job-1",
				taskId: "task-1",
			}),
		);
		expect(mocks.warn).toHaveBeenCalledWith(
			"[DEEP_RESEARCH] Usage record save failed",
			expect.objectContaining({
				role: "research_task",
				jobId: "job-1",
				taskId: "task-1",
				error: "FOREIGN KEY constraint failed",
				foreignKeyDiagnosticsJson: expect.stringContaining(
					'"taskExists": false',
				),
			}),
		);
	});

	it("retries rate-limited provider citation audits with the provider fallback model", async () => {
		mocks.decryptApiKey.mockImplementation((encrypted) =>
			encrypted === "encrypted-fallback"
				? "fallback-secret"
				: "provider-secret",
		);
		const fetchImpl = vi.fn(async (url: URL | RequestInfo) => {
			const requestUrl = String(url);
			if (requestUrl.startsWith("https://openrouter.ai")) {
				return new Response(JSON.stringify({ error: "rate limited" }), {
					status: 429,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								content:
									'{"claims":[{"claimId":"claim-1","status":"supported","reason":"Fallback model audited it.","citationSourceIds":["source-1"]}]}',
							},
						},
					],
					usage: {
						prompt_tokens: 20,
						completion_tokens: 9,
						total_tokens: 29,
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const result = await tryRunAndRecordDeepResearchModel({
			role: "citation_audit",
			jobId: "job-1",
			conversationId: "conversation-1",
			userId: "user-1",
			stage: "citation_audit",
			operation: "citation_audit",
			messages: [
				{ role: "system", content: "Audit citations. Return only JSON." },
				{ role: "user", content: "{}" },
			],
			fetchImpl,
		});

		expect(result?.content).toContain("Fallback model audited it.");
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(fetchImpl.mock.calls[1]?.[0]).toBe(
			"https://api.moonshot.ai/v1/chat/completions",
		);
		const fallbackHeaders = fetchImpl.mock.calls[1]?.[1]?.headers as Record<
			string,
			string
		>;
		expect(fallbackHeaders.Authorization).toBe("Bearer fallback-secret");
		expect(
			JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body)),
		).toMatchObject({
			model: "kimi-k2.6",
			temperature: 0.2,
		});
		expect(mocks.warn).toHaveBeenCalledWith(
			"[DEEP_RESEARCH] LLM role switching to failover model",
			expect.objectContaining({
				role: "citation_audit",
				jobId: "job-1",
				from: "provider:openrouter:anthropic/claude-sonnet-4",
				to: "provider:openrouter:kimi-k2.6",
				reason: "rate_limit",
				status: 429,
			}),
		);
		expect(mocks.saveResearchUsageRecord).toHaveBeenCalledOnce();
	});

	it("uses the global failover model when provider rate-limit fallback is unavailable", async () => {
		runtimeConfig.modelTimeoutFailoverEnabled = true;
		runtimeConfig.modelTimeoutFailoverTargetModel = "model2";
		mocks.getProviderWithSecrets.mockResolvedValue({
			...providerConfig(),
			rateLimitFallbackEnabled: false,
			apiKeyEncrypted: "encrypted-key",
			apiKeyIv: "iv",
		});
		const fetchImpl = vi.fn(async (url: URL | RequestInfo) => {
			const requestUrl = String(url);
			if (requestUrl.startsWith("https://openrouter.ai")) {
				return new Response(JSON.stringify({ error: "rate limited" }), {
					status: 429,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								content:
									'{"claims":[{"claimId":"claim-1","status":"supported"}]}',
							},
						},
					],
					usage: {
						prompt_tokens: 12,
						completion_tokens: 4,
						total_tokens: 16,
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const result = await tryRunAndRecordDeepResearchModel({
			role: "citation_audit",
			jobId: "job-1",
			conversationId: "conversation-1",
			userId: "user-1",
			stage: "citation_audit",
			operation: "citation_audit",
			messages: [
				{ role: "system", content: "Audit citations. Return only JSON." },
				{ role: "user", content: "{}" },
			],
			fetchImpl,
		});

		expect(result).toMatchObject({
			modelId: "model2",
			modelDisplayName: "Model Two",
		});
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(fetchImpl.mock.calls[1]?.[0]).toBe(
			"https://model-two.example/v1/chat/completions",
		);
		expect(
			JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body)),
		).toMatchObject({
			model: "model-two",
		});
		expect(mocks.warn).toHaveBeenCalledWith(
			"[DEEP_RESEARCH] LLM role switching to failover model",
			expect.objectContaining({
				role: "citation_audit",
				jobId: "job-1",
				from: "provider:openrouter:anthropic/claude-sonnet-4",
				to: "model2",
				reason: "rate_limit",
				status: 429,
			}),
		);
	});

	it("keeps provider failures on the citation audit deterministic fallback boundary after failover is unavailable", async () => {
		mocks.getProviderWithSecrets.mockResolvedValueOnce({
			...providerConfig(),
			rateLimitFallbackEnabled: false,
			apiKeyEncrypted: "encrypted-key",
			apiKeyIv: "iv",
		});
		const fetchImpl = vi.fn(async () => {
			return new Response(JSON.stringify({ error: "provider unavailable" }), {
				status: 503,
				headers: { "Content-Type": "application/json" },
			});
		});

		const result = await tryRunAndRecordDeepResearchModel({
			role: "citation_audit",
			jobId: "job-1",
			conversationId: "conversation-1",
			userId: "user-1",
			stage: "citation_audit",
			operation: "citation_audit",
			messages: [
				{ role: "system", content: "Audit citations. Return only JSON." },
				{ role: "user", content: "{}" },
			],
			fetchImpl,
		});

		expect(result).toBeNull();
		expect(mocks.warn).toHaveBeenCalledWith(
			"[DEEP_RESEARCH] LLM role failed; using deterministic fallback",
			expect.objectContaining({
				role: "citation_audit",
				jobId: "job-1",
				error: "Deep Research model citation_audit failed: 503",
			}),
		);
		expect(mocks.saveResearchUsageRecord).not.toHaveBeenCalled();
	});
});
