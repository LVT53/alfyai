import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
	assertClosingBinding,
	assertStageIdentity,
	createClosingGateway,
} from "./verify-closing-provider";

const stage = {
	cwd: "/home/alfydesign/apps/langflow-chat-dev/releases/abcdef123",
	databasePath: "/home/alfydesign/apps/langflow-chat-dev/shared/data/chat.db",
	origin: "https://ai.dev.alfydesign.com",
};
describe("closing proof execution guards", () => {
	it("refuses production identity and a stage-looking path resolving elsewhere", () => {
		expect(() => assertStageIdentity(stage)).not.toThrow();
		for (const input of [
			{ ...stage, origin: "https://ai.alfydesign.com" },
			{
				...stage,
				cwd: "/home/alfydesign/apps/langflow-chat/releases/abcdef123",
			},
			{
				...stage,
				databasePath: "/home/alfydesign/apps/langflow-chat/shared/data/chat.db",
			},
		])
			expect(() => assertStageIdentity(input)).toThrow();
	});
	it("bounds actual requests, preserves closing cap, rejects tools in closing and forbids redirects", async () => {
		const bodies: Record<string, unknown>[] = [];
		const transport = vi.fn<typeof fetch>(async (_url, init) => {
			expect(init?.redirect).toBe("error");
			bodies.push(JSON.parse(String(init?.body)));
			return new Response("ok");
		});
		const gate = createClosingGateway({
			caseName: "B",
			endpoint: "https://api.deepseek.com/chat/completions",
			fetch: transport,
		});
		gate.enter("working");
		await gate.fetch("https://api.deepseek.com/chat/completions", {
			method: "POST",
			body: JSON.stringify({
				model: "deepseek-flash",
				stream: true,
				max_tokens: 1024,
			}),
		});
		gate.enter("closing");
		await gate.fetch("https://api.deepseek.com/chat/completions", {
			method: "POST",
			body: JSON.stringify({
				model: "deepseek-flash",
				stream: true,
				max_tokens: 1024,
			}),
		});
		expect(bodies.map((b) => b.max_tokens)).toEqual([32, 1024]);
		await expect(
			gate.fetch("https://api.deepseek.com/chat/completions", {
				method: "POST",
				body: "{}",
			}),
		).rejects.toThrow();
		expect(transport).toHaveBeenCalledTimes(2);
	});
	it("does not dispatch wrong model, endpoint, unregistered phase, or closing tools", async () => {
		const transport = vi.fn<typeof fetch>(async () => new Response("ok"));
		const gate = createClosingGateway({
			caseName: "A",
			endpoint: "https://api.deepseek.com/chat/completions",
			fetch: transport,
		});
		const send = (
			model = "deepseek-flash",
			url = "https://api.deepseek.com/chat/completions",
			tools?: unknown[],
		) =>
			gate.fetch(url, {
				method: "POST",
				body: JSON.stringify({ model, stream: true, tools }),
			});
		await expect(send()).rejects.toThrow();
		gate.enter("working");
		await expect(send("deepseek-pro")).rejects.toThrow();
		await expect(
			send("deepseek-flash", "https://other.invalid"),
		).rejects.toThrow();
		expect(transport).not.toHaveBeenCalled();
		await send();
		gate.enter("closing");
		await expect(
			send("deepseek-flash", "https://api.deepseek.com/chat/completions", [{}]),
		).rejects.toThrow("closing_has_tools");
		expect(transport).toHaveBeenCalledTimes(1);
	});
	it("counts failed requests so a transport failure cannot buy another working attempt", async () => {
		const transport = vi.fn<typeof fetch>(async () => {
			throw new Error("synthetic network failure");
		});
		const gate = createClosingGateway({
			caseName: "A",
			endpoint: "https://api.deepseek.com/chat/completions",
			fetch: transport,
		});
		gate.enter("working");
		const send = () =>
			gate.fetch("https://api.deepseek.com/chat/completions", {
				method: "POST",
				body: JSON.stringify({ model: "deepseek-flash", stream: true }),
			});
		await expect(send()).rejects.toThrow();
		await expect(send()).rejects.toThrow();
		expect(transport).toHaveBeenCalledTimes(1);
	});
});

it.each([
	{ caseName: "A", missingPrice: false },
	{ caseName: "B", missingPrice: false },
	{ caseName: "B", missingPrice: true },
] as const)("case $caseName with missingPrice=$missingPrice audits real completion and finalization offline", async ({
	caseName,
	missingPrice,
}) => {
	const { accountingReadFixture } = await import(
		"../tests/integration/accounting-read-fixture"
	);
	const f = await accountingReadFixture();
	const originalFetch = globalThis.fetch;
	try {
		const { db } = await import("../src/lib/server/db");
		const { providerModels } = await import("../src/lib/server/db/schema");
		db.update(providerModels)
			.set({
				// The provider reports a model without a matching price row.
				name: missingPrice ? "unrelated-priced-model" : "deepseek-flash",
			})
			.run();
		if (caseName === "A") {
			execFileSync(
				process.execPath,
				[
					"--import",
					"tsx",
					"--input-type=module",
					"-e",
					`globalThis.fetch=async()=>{throw new Error("network forbidden")}; await Promise.all([import("./src/lib/server/services/chat-turn/finalize.ts"),import("./src/lib/server/services/normal-chat-model/index.ts")]); process.exit(0);`,
				],
				{ cwd: process.cwd(), env: process.env, stdio: "pipe" },
			);
		}
		const auxiliary = vi.fn(async () => {
			throw new Error("auxiliary call forbidden");
		});
		globalThis.fetch = (url, init) =>
			String(url).startsWith("data:") ? originalFetch(url, init) : auxiliary();
		const { runClosingCase } = await import("./verify-closing-provider");
		let calls = 0;
		const transport = vi.fn<typeof fetch>(async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			const first = calls++ === 0;
			const delta =
				first && caseName === "A"
					? {
							tool_calls: [
								{
									index: 0,
									id: "product-1",
									type: "function",
									function: { name: "lookup_product", arguments: "{}" },
								},
							],
						}
					: { content: first ? "1\n2\n" : "PRODUCT=391" };
			const frame = (d: unknown, finish_reason: string | null) =>
				`data: ${JSON.stringify({ id: "proof", object: "chat.completion.chunk", created: 1, model: "deepseek-flash", choices: [{ index: 0, delta: d, finish_reason }], ...(finish_reason ? { usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } } : {}) })}\n\n`;
			expect(body.max_tokens).toBe(
				caseName === "B" ? (first ? 32 : 1024) : 512,
			);
			return new Response(
				frame(delta, null) +
					frame(
						{},
						first ? (caseName === "A" ? "tool_calls" : "length") : "stop",
					) +
					"data: [DONE]\n\n",
				{ headers: { "content-type": "text/event-stream" } },
			);
		});
		const result = await runClosingCase({
			caseName,
			userId: "u",
			modelId: "provider:p:m",
			provider: {
				id: "p",
				name: "deepseek",
				displayName: "Synthetic",
				baseUrl: "https://api.deepseek.com",
				apiKey: "synthetic",
				modelName: "deepseek-flash",
				maxModelContext: 32000,
			},
			fetch: transport,
		});

		expect(result).toMatchObject({
			status: missingPrice ? "failed" : "passed",
			code: missingPrice ? "accounting_not_ready" : "ok",
			receiptMatches: true,
			toolExecutions: caseName === "A" ? 1 : 0,
		});
		expect(result.requests).toHaveLength(2);
		expect(result.attempts).toHaveLength(2);
		expect(transport).toHaveBeenCalledTimes(2);
		if (missingPrice)
			expect(result.attempts.every((a) => a.costUsdMicros === null)).toBe(true);
		expect(result.closingDeltas).toBeGreaterThan(0);
		expect(auxiliary).not.toHaveBeenCalled();
	} finally {
		globalThis.fetch = originalFetch;
		f.close();
	}
}, 20000);

describe("explicit closing provider matrix binding", () => {
	const binding = {
		family: "kimi",
		providerName: "fireworks-ai",
		modelName: "accounts/fireworks/models/kimi-k3",
		baseUrl: "https://api.fireworks.ai/inference/v1",
		expectedProviderName: "fireworks-ai",
		expectedModelName: "accounts/fireworks/models/kimi-k3",
		expectedOrigin: "https://api.fireworks.ai",
	};
	it("requires exact expected binding in addition to the allowed family", () => {
		expect(() => assertClosingBinding(binding)).not.toThrow();
		for (const patch of [
			{ providerName: "other" },
			{ modelName: "accounts/fireworks/models/kimi-other" },
			{ baseUrl: "https://elsewhere.invalid/v1" },
			{ family: "other" },
			{ expectedOrigin: "https://api.fireworks.ai/path" },
		])
			expect(() => assertClosingBinding({ ...binding, ...patch })).toThrow();
		expect(() =>
			assertClosingBinding({
				...binding,
				family: "qwen",
				providerName: "local",
				expectedProviderName: "local",
				modelName: "Qwen3.8-Flash-Next",
				expectedModelName: "Qwen3.8-Flash-Next",
				baseUrl: "http://127.0.0.1:9000/v1",
				expectedOrigin: "http://127.0.0.1:9000",
			}),
		).not.toThrow();
	});
	it("preserves the selected adapter's thinking format for a non-DeepSeek model", async () => {
		const transport = vi.fn<typeof fetch>(async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			expect(body).not.toHaveProperty("thinking");
			expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
			return new Response("ok");
		});
		const gate = createClosingGateway({
			caseName: "A",
			endpoint: "http://127.0.0.1:9000/v1/chat/completions",
			modelName: "Qwen3.8-Flash-Next",
			disableThinking: false,
			fetch: transport,
		});
		gate.enter("working");
		await gate.fetch("http://127.0.0.1:9000/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify({
				model: "Qwen3.8-Flash-Next",
				stream: true,
				chat_template_kwargs: { enable_thinking: false },
			}),
		});
		expect(transport).toHaveBeenCalledTimes(1);
	});
});
