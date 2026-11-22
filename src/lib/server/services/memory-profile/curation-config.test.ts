import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bootEngine, type EngineHarness } from "../jobs/testing/harness";

let h: EngineHarness;
beforeEach(async () => {
	h = await bootEngine("curation-config");
});
afterEach(() => {
	vi.restoreAllMocks();
	h.cleanup();
});
it("leaves curation unavailable unless explicitly configured and applies admin override", async () => {
	const cfg = await import("$lib/server/config-store");
	expect(cfg.getConfig().hindsightCurationModel).toBe(null);
	const { createCurationModel } = await import("./curation");
	await expect(
		createCurationModel(new AbortController().signal)("test", {}, {}),
	).rejects.toThrow("memory_curation_model_unconfigured");
	const { db } = await import("$lib/server/db");
	const { adminConfig } = await import("$lib/server/db/schema");
	db.insert(adminConfig)
		.values({
			key: "HINDSIGHT_CURATION_MODEL",
			value: "provider:local:model",
			updatedBy: h.userId,
		})
		.run();
	await cfg.refreshConfig();
	expect(cfg.getConfig().hindsightCurationModel).toBe("provider:local:model");
	expect(cfg.getResolvedAdminConfigValues().HINDSIGHT_CURATION_MODEL).toBe(
		"provider:local:model",
	);
});

it("uses the private inference binding without a selectable chat model", async () => {
	const cfg = await import("$lib/server/config-store");
	const model = await import("../normal-chat-model");
	const resolve = vi.spyOn(model, "resolveNormalChatModelRunProvider");
	const { getAvailableModelProviderGroups } = await import(
		"../available-models"
	);
	const originalConfig = cfg.getConfig();
	const binding = {
		...originalConfig,
		hindsightCurationGatewayModel: "qwen3-6-27b",
		hindsightInferenceKey: "",
	};
	vi.spyOn(cfg, "getConfig").mockReturnValue(binding);
	const endpoints = await import("./private-endpoint");
	const transport = vi
		.spyOn(endpoints, "fetchPrivateMemory")
		.mockImplementation(async (_url, _init, _fetcher, beforeDispatch) => {
			await beforeDispatch?.();
			return Response.json({
				id: "synthetic",
				model: "qwen3-6-27b",
				choices: [
					{
						index: 0,
						message: { role: "assistant", content: '{"ok":true}' },
						finish_reason: "stop",
					},
				],
			});
		});
	const { createCurationModel } = await import("./curation");
	const assertCurrent = vi.fn();
	const call = createCurationModel(new AbortController().signal);
	const schema = {
		type: "object",
		properties: { ok: { type: "boolean" } },
		required: ["ok"],
	};
	await expect(call("Return JSON", {}, schema)).rejects.toThrow(
		"memory_curation_model_unconfigured",
	);
	expect(transport).not.toHaveBeenCalled();
	binding.hindsightInferenceKey = "private-gateway-key";
	await expect(
		call("Return JSON", {}, schema, "on", assertCurrent),
	).resolves.toEqual({
		ok: true,
	});
	expect(resolve).not.toHaveBeenCalled();
	expect(assertCurrent).toHaveBeenCalledOnce();
	expect(transport).toHaveBeenCalledOnce();
	const [url, init] = transport.mock.calls[0];
	expect(String(url)).toBe(
		"http://127.0.0.1:8888/ext/alfyai/inference/v1/chat/completions",
	);
	expect(new Headers(init?.headers).get("authorization")).toBe(
		"Bearer private-gateway-key",
	);
	expect(JSON.parse(String(init?.body))).toMatchObject({
		model: "qwen3-6-27b",
		enable_thinking: true,
		chat_template_kwargs: { enable_thinking: true },
		top_k: 20,
		top_p: 0.95,
		temperature: 0,
		max_tokens: 8192,
		response_format: {
			type: "json_schema",
			json_schema: { name: "memory_edit", strict: true },
		},
	});
	expect(cfg.getResolvedAdminConfigValues(binding)).not.toHaveProperty(
		"HINDSIGHT_API_HTTP_INFERENCE_KEY",
	);
	expect(await getAvailableModelProviderGroups(binding)).toEqual(
		await getAvailableModelProviderGroups(originalConfig),
	);
	binding.hindsightCurationModel = "provider:legacy:model";
	resolve.mockRejectedValueOnce(Error("configured alias selected"));
	await expect(call("Return JSON", {}, schema)).rejects.toThrow(
		"configured alias selected",
	);
	expect(resolve).toHaveBeenCalledOnce();
	expect(transport).toHaveBeenCalledOnce();
});

it.each([undefined, "on"] as const)(
	"uses only the resolved local admission gateway, with thinking mode %s",
	async (thinkingMode) => {
		const cfg = await import("$lib/server/config-store");
		const model = await import("../normal-chat-model");
		const config = {
			...cfg.getConfig(),
			hindsightCurationModel: "provider:synthetic:qwen3-6-27b" as const,
			hindsightUrl: "http://127.0.0.1:8888",
		};
		vi.spyOn(cfg, "getConfig").mockReturnValue(config);
		const provider = {
			id: "synthetic",
			name: "synthetic",
			displayName: "Synthetic",
			baseUrl: "http://127.0.0.1:8888/ext/alfyai/inference/v1",
			modelName: "qwen3-6-27b",
			apiKey: "synthetic",
		};
		const resolve = vi
			.spyOn(model, "resolveNormalChatModelRunProvider")
			.mockResolvedValue(provider);
		const endpoints = await import("./private-endpoint");
		const transport = vi
			.spyOn(endpoints, "fetchPrivateMemory")
			.mockResolvedValue(
				new Response(
					JSON.stringify({
						id: "synthetic",
						model: "synthetic",
						created: 1,
						choices: [
							{
								index: 0,
								message: { role: "assistant", content: '{"ok":true}' },
								finish_reason: "stop",
							},
						],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					}),
					{ headers: { "Content-Type": "application/json" } },
				),
			);
		const { createCurationModel } = await import("./curation");
		const call = (assertCurrent?: () => void) =>
			createCurationModel(new AbortController().signal)(
				"Return JSON",
				{ private: "memory" },
				{
					type: "object",
					properties: { ok: { type: "boolean" } },
					required: ["ok"],
				},
				thinkingMode,
				assertCurrent,
			);
		await expect(call()).resolves.toEqual({ ok: true });
		expect(transport).toHaveBeenCalledTimes(1);
		expect(String(transport.mock.calls[0][0])).toBe(
			`${provider.baseUrl}/chat/completions`,
		);
		expect(JSON.parse(String(transport.mock.calls[0][1]?.body))).toMatchObject({
			enable_thinking: thinkingMode === "on",
			chat_template_kwargs: { enable_thinking: thinkingMode === "on" },
			max_tokens: 8192,
		});
		transport.mockClear();
		if (thinkingMode === "on") {
			transport.mockResolvedValueOnce(
				Response.json({
					id: "exhausted",
					model: provider.modelName,
					created: 1,
					choices: [
						{
							index: 0,
							message: { role: "assistant", content: '{"ok":true}' },
							finish_reason: "length",
						},
					],
				}),
			);
			await expect(call()).rejects.toThrow("memory_curation_incomplete");
			expect(transport).toHaveBeenCalledTimes(1);
			transport.mockClear();
			transport.mockResolvedValueOnce(
				Response.json(
					{ error: { message: "response_format json_schema is unsupported" } },
					{ status: 400 },
				),
			);
			await expect(call()).rejects.toThrow(/response_format/);
			expect(transport).toHaveBeenCalledTimes(1);
			transport.mockClear();
			const send = vi.fn();
			transport.mockImplementationOnce(
				async (_url, _init, _fetch, beforeDispatch) => {
					await beforeDispatch?.();
					send();
					return Response.json({});
				},
			);
			await expect(
				call(() => {
					throw Error("revoked at dispatch");
				}),
			).rejects.toThrow("revoked at dispatch");
			expect(send).not.toHaveBeenCalled();
			transport.mockClear();
		}
		resolve.mockResolvedValue({
			...provider,
			baseUrl: "https://cloud.example/v1",
		});
		await expect(call()).rejects.toThrow("memory_curation_model_not_local");
		expect(transport).not.toHaveBeenCalled();
		resolve.mockResolvedValue({
			...provider,
			baseUrl: "http://127.0.0.1:9000/v1",
		});
		await expect(call()).rejects.toThrow("memory_curation_admission_required");
		expect(transport).not.toHaveBeenCalled();
		// A provider edited between preflight and the generic sender's second resolution
		// cannot bypass the actual request guard, even if it remains a private host.
		resolve
			.mockResolvedValueOnce(provider)
			.mockResolvedValue({ ...provider, baseUrl: "http://127.0.0.1:9000/v1" });
		await expect(call()).rejects.toThrow();
		expect(transport).not.toHaveBeenCalled();
	},
);
