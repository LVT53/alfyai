import { describe, expect, it, vi } from "vitest";
import { CREATE_ARTIFACT_CANVAS_BODY_EXAMPLE } from "$lib/server/services/normal-chat-tools/artifact-tools/kind-prose";
import { EVAL_ARTIFACTS_SAMPLING } from "./config";
import {
	buildToolPathRequestBody,
	decodeToolPathResponse,
	encodeToolPathResponse,
	loadToolCatalogue,
	sendThroughTools,
	type ToolPathRequestSpec,
} from "./tool-path";

const SPEC: ToolPathRequestSpec = {
	system: "You are a test assistant.",
	user: "Make a deck.",
	language: "en",
	toolChoice: "auto",
	thinking: "off",
};

function toolNamed(tools: unknown[], name: string) {
	return (
		tools as Array<{
			function: {
				name: string;
				description: string;
				parameters: {
					properties: Record<string, { description?: string; enum?: string[] }>;
				};
			};
		}>
	).find((tool) => tool.function.name === name);
}

describe("the tool catalogue a live run sends (ruling 62)", () => {
	it.each([
		"en",
		"hu",
	] as const)("is the frozen snapshot of what a chat turn sends, in %s", (language) => {
		const tools = loadToolCatalogue(language);
		expect(tools.length).toBeGreaterThan(10);
		const create = toolNamed(tools, "create_artifact");
		expect(create).toBeDefined();
		expect(create?.function.parameters.properties.artifactType.enum).toContain(
			"canvas",
		);
	});

	it("carries the create_artifact description and the board contract as the app advertises them today", () => {
		const create = toolNamed(loadToolCatalogue("en"), "create_artifact");
		// The body field's own text, with the one worked example (ruling 62). A
		// stale snapshot fails here.
		expect(create?.function.parameters.properties.body.description).toContain(
			JSON.stringify(CREATE_ARTIFACT_CANVAS_BODY_EXAMPLE),
		);
		expect(create?.function.description).toContain("canvas for");
	});

	it("names every tool in the catalogue, so routing between tools is measured against the real set", () => {
		const names = loadToolCatalogue("en").map(
			(tool) => (tool as { function: { name: string } }).function.name,
		);
		expect(names).toEqual(
			expect.arrayContaining([
				"create_artifact",
				"produce_file",
				"edit_artifact",
			]),
		);
	});
});

describe("buildToolPathRequestBody", () => {
	it("sends a system and a user message, the whole catalogue, and the harness's sampling", () => {
		const body = buildToolPathRequestBody("qwen3-6-27b", SPEC);
		expect(body.model).toBe("qwen3-6-27b");
		expect(body.messages).toEqual([
			{ role: "system", content: SPEC.system },
			{ role: "user", content: SPEC.user },
		]);
		expect(body.tools).toEqual(loadToolCatalogue("en"));
		expect(body.tool_choice).toBe("auto");
		expect(body.temperature).toBe(EVAL_ARTIFACTS_SAMPLING.temperature);
		expect(body.top_p).toBe(EVAL_ARTIFACTS_SAMPLING.topP);
		expect(body.top_k).toBe(EVAL_ARTIFACTS_SAMPLING.topK);
		expect(body.max_tokens).toBe(EVAL_ARTIFACTS_SAMPLING.maxTokens);
	});

	it("switches thinking off the way the app does for a qwen model, and leaves it alone when on", () => {
		expect(buildToolPathRequestBody("m", SPEC).chat_template_kwargs).toEqual({
			enable_thinking: false,
		});
		expect(
			buildToolPathRequestBody("m", { ...SPEC, thinking: "on" })
				.chat_template_kwargs,
		).toBeUndefined();
	});

	it("can withhold named tools, the way a real turn withholds the ones a conversation does not have", () => {
		const names = (body: Record<string, unknown>) =>
			(body.tools as Array<{ function: { name: string } }>).map(
				(tool) => tool.function.name,
			);
		const full = names(buildToolPathRequestBody("m", SPEC));
		expect(full).toContain("memory_context");

		const withheld = names(
			buildToolPathRequestBody("m", {
				...SPEC,
				withoutTools: ["memory_context", "use_skill"],
			}),
		);
		expect(withheld).not.toContain("memory_context");
		expect(withheld).not.toContain("use_skill");
		expect(withheld).toEqual(
			full.filter((name) => name !== "memory_context" && name !== "use_skill"),
		);
	});

	it("can force one tool, and picks the catalogue's locale from the turn's language", () => {
		const forced = buildToolPathRequestBody("m", {
			...SPEC,
			toolChoice: { name: "create_artifact" },
			language: "hu",
		});
		expect(forced.tool_choice).toEqual({
			type: "function",
			function: { name: "create_artifact" },
		});
		expect(forced.tools).toEqual(loadToolCatalogue("hu"));
		expect(forced.tools).not.toEqual(loadToolCatalogue("en"));
	});
});

describe("the recorded tool-call envelope", () => {
	it("round-trips tool calls, text and the finish reason", () => {
		const envelope = {
			toolCalls: [
				{
					name: "create_artifact",
					arguments: { artifactType: "slides", title: "T", body: "{}" },
				},
			],
			content: "Here you go.",
			finishReason: "tool_calls",
		};
		expect(decodeToolPathResponse(encodeToolPathResponse(envelope))).toEqual(
			envelope,
		);
	});

	it("reads anything that is not an envelope as null instead of throwing", () => {
		for (const text of ["", "plain text", "[]", "null", '{"toolCalls": 3}']) {
			expect(decodeToolPathResponse(text), text).toBeNull();
		}
	});
});

describe("sendThroughTools", () => {
	const config = { baseUrl: "http://127.0.0.1:1/v1/", model: "qwen3-6-27b" };

	function respond(message: Record<string, unknown>, extra = {}) {
		return vi.fn(async () =>
			Response.json({
				choices: [{ message, finish_reason: "tool_calls" }],
				usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
				...extra,
			}),
		);
	}

	it("posts the request to /chat/completions and reads the tool call back as an envelope", async () => {
		const fetchImpl = respond({
			content: null,
			tool_calls: [
				{
					id: "call_1",
					type: "function",
					function: {
						name: "create_artifact",
						arguments: JSON.stringify({
							artifactType: "slides",
							title: "T",
							body: "{}",
						}),
					},
				},
			],
		});
		const result = await sendThroughTools(config, SPEC, {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toBe("http://127.0.0.1:1/v1/chat/completions");
		expect(JSON.parse(String(init.body)).tools).toEqual(
			loadToolCatalogue("en"),
		);

		expect(decodeToolPathResponse(result.text)).toEqual({
			toolCalls: [
				{
					id: "call_1",
					name: "create_artifact",
					arguments: { artifactType: "slides", title: "T", body: "{}" },
				},
			],
			content: "",
			finishReason: "tool_calls",
		});
		expect(result.usage).toEqual({
			promptTokens: 100,
			completionTokens: 20,
			totalTokens: 120,
		});
	});

	it("keeps arguments that are not JSON as the raw text, so the scorer can say so", async () => {
		const fetchImpl = respond({
			content: "",
			tool_calls: [
				{
					id: "c",
					type: "function",
					function: { name: "create_artifact", arguments: "{not json" },
				},
			],
		});
		const result = await sendThroughTools(config, SPEC, {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(decodeToolPathResponse(result.text)?.toolCalls[0].arguments).toBe(
			"{not json",
		);
	});

	it("records an answer with no tool call as text alone", async () => {
		const fetchImpl = respond({ content: "I would rather write it in chat." });
		const result = await sendThroughTools(config, SPEC, {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(decodeToolPathResponse(result.text)).toMatchObject({
			toolCalls: [],
			content: "I would rather write it in chat.",
		});
	});

	it("sends a key only when it was given one, and never returns it", async () => {
		const fetchImpl = respond({ content: "ok" });
		const withKey = await sendThroughTools(
			{ ...config, apiKey: "secret-value-1" },
			SPEC,
			{ fetchImpl: fetchImpl as unknown as typeof fetch },
		);
		const [, init] = fetchImpl.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect((init.headers as Record<string, string>).Authorization).toBe(
			"Bearer secret-value-1",
		);
		expect(JSON.stringify(withKey)).not.toContain("secret-value-1");

		const fetchNoKey = respond({ content: "ok" });
		await sendThroughTools(config, SPEC, {
			fetchImpl: fetchNoKey as unknown as typeof fetch,
		});
		const [, bare] = fetchNoKey.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(
			(bare.headers as Record<string, string>).Authorization,
		).toBeUndefined();
	});

	it("throws an error carrying the HTTP status, so the harness's retry and circuit breaker can read it", async () => {
		const fetchImpl = vi.fn(async () => new Response("busy", { status: 503 }));
		await expect(
			sendThroughTools(config, SPEC, {
				fetchImpl: fetchImpl as unknown as typeof fetch,
			}),
		).rejects.toMatchObject({ status: 503 });
	});
});

describe("sendThroughTools with a follow-up: a lookup is answered and the model goes on", () => {
	const config = { baseUrl: "http://127.0.0.1:1/v1", model: "qwen3-6-27b" };

	function turn(
		toolCalls: Array<{ id: string; name: string; args: unknown }>,
		content = "",
		usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
	) {
		return {
			choices: [
				{
					message: {
						content,
						tool_calls: toolCalls.map((call) => ({
							id: call.id,
							type: "function",
							function: {
								name: call.name,
								arguments: JSON.stringify(call.args),
							},
						})),
					},
					finish_reason: "tool_calls",
				},
			],
			usage,
		};
	}

	function sequence(...responses: unknown[]) {
		const queue = [...responses];
		return vi.fn(async () => {
			const next = queue.shift();
			if (next === undefined) throw new Error("no more scripted responses");
			return Response.json(next);
		});
	}

	const followUp = {
		maxSteps: 3,
		answer: (name: string) =>
			name === "image_search" ? "No images were found." : null,
	};

	it("answers a lookup with the suite's stub and asks again, with the whole exchange in the messages", async () => {
		const fetchImpl = sequence(
			turn(
				[{ id: "call_a", name: "image_search", args: { query: "Vienna" } }],
				"Let me look.",
			),
			turn([
				{
					id: "call_b",
					name: "create_artifact",
					args: { artifactType: "slides", title: "T", body: "{}" },
				},
			]),
		);
		const result = await sendThroughTools(
			config,
			{ ...SPEC, followUp },
			{
				fetchImpl: fetchImpl as unknown as typeof fetch,
			},
		);

		expect(fetchImpl).toHaveBeenCalledTimes(2);
		const secondBody = JSON.parse(
			String(
				(fetchImpl.mock.calls[1] as unknown as [string, RequestInit])[1].body,
			),
		);
		expect(secondBody.messages.slice(2)).toEqual([
			{
				role: "assistant",
				content: "Let me look.",
				tool_calls: [
					{
						id: "call_a",
						type: "function",
						function: { name: "image_search", arguments: '{"query":"Vienna"}' },
					},
				],
			},
			{
				role: "tool",
				tool_call_id: "call_a",
				content: "No images were found.",
			},
		]);

		const envelope = decodeToolPathResponse(result.text);
		expect(envelope?.toolCalls.map((call) => call.name)).toEqual([
			"create_artifact",
		]);
		expect(envelope?.priorSteps).toEqual([
			{
				toolCalls: [
					{
						id: "call_a",
						name: "image_search",
						arguments: { query: "Vienna" },
					},
				],
				content: "Let me look.",
				results: ["No images were found."],
			},
		]);
		// Tokens are the whole exchange's.
		expect(result.usage).toEqual({
			promptTokens: 200,
			completionTokens: 20,
			totalTokens: 220,
		});
	});

	it("stops at the first step that made the deck, even if it also called a lookup", async () => {
		const fetchImpl = sequence(
			turn([
				{ id: "1", name: "image_search", args: {} },
				{
					id: "2",
					name: "create_artifact",
					args: { artifactType: "slides", title: "T", body: "{}" },
				},
			]),
		);
		const result = await sendThroughTools(
			config,
			{ ...SPEC, followUp },
			{
				fetchImpl: fetchImpl as unknown as typeof fetch,
			},
		);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(decodeToolPathResponse(result.text)?.priorSteps).toBeUndefined();
	});

	it("stops when the step called a tool the suite does not answer, and hands that step back", async () => {
		const fetchImpl = sequence(turn([{ id: "1", name: "email", args: {} }]));
		const result = await sendThroughTools(
			config,
			{ ...SPEC, followUp },
			{
				fetchImpl: fetchImpl as unknown as typeof fetch,
			},
		);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(decodeToolPathResponse(result.text)?.toolCalls[0].name).toBe(
			"email",
		);
	});

	it("stops when the step called no tool, and at the step limit", async () => {
		const noTool = sequence({
			choices: [
				{ message: { content: "Here is text." }, finish_reason: "stop" },
			],
		});
		await sendThroughTools(
			config,
			{ ...SPEC, followUp },
			{ fetchImpl: noTool as unknown as typeof fetch },
		);
		expect(noTool).toHaveBeenCalledTimes(1);

		const endless = sequence(
			turn([{ id: "1", name: "image_search", args: {} }]),
			turn([{ id: "2", name: "image_search", args: {} }]),
			turn([{ id: "3", name: "image_search", args: {} }]),
			turn([{ id: "4", name: "image_search", args: {} }]),
		);
		const result = await sendThroughTools(
			config,
			{ ...SPEC, followUp: { ...followUp, maxSteps: 3 } },
			{
				fetchImpl: endless as unknown as typeof fetch,
			},
		);
		expect(endless).toHaveBeenCalledTimes(3);
		expect(decodeToolPathResponse(result.text)?.priorSteps).toHaveLength(2);
	});

	it("does one request and records no steps when there is no follow-up", async () => {
		const fetchImpl = sequence(
			turn([{ id: "1", name: "image_search", args: {} }]),
		);
		const result = await sendThroughTools(config, SPEC, {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(decodeToolPathResponse(result.text)?.priorSteps).toBeUndefined();
	});
});
