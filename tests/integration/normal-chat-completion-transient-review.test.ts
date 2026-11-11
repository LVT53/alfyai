// Reviewer-added probe (review F): what happens after a transient transport error BEFORE any output,
// when no fallback model is configured? (Baseline: orchestrator re-ran the turn non-streaming WITH tools.)
import { tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	type NormalChatOutputEvent,
	projectNormalChatOutput,
} from "$lib/shared/normal-chat-output";

vi.mock("$lib/server/services/providers", () => ({
	getProviderByName: async () => null,
	getProviderWithSecrets: async () => null,
	decryptApiKey: () => "synthetic",
}));
vi.mock("$lib/server/services/provider-models", () => ({
	listEnabledProviderModels: async () => [],
	getProviderModel: async () => null,
}));

import {
	runPlainNormalChatModelRun,
	runStreamingNormalChatModelRun,
} from "$lib/server/services/normal-chat-model";

const provider = {
	id: "p",
	name: "openai",
	displayName: "Test",
	baseUrl: "https://completion.invalid/v1",
	modelName: "test",
	apiKey: "synthetic",
	requestTimeoutMs: 300000,
	maxOutputTokens: 1000,
	maxModelContext: 32000,
};
const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
	`data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 1, model: "actual-test", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const okStream = () =>
	new Response(
		[
			chunk({ content: "closed answer" }),
			`data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 1, model: "actual-test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\ndata: [DONE]\n\n`,
		].join(""),
		{ headers: { "content-type": "text/event-stream" } },
	);

function policy(output: NormalChatOutputEvent[]) {
	return {
		turnId: "t",
		segmentId: "s",
		deadlineAt: Date.now() + 300000,
		totalTimeoutMs: 300000,
		onOutputEvent: (e: NormalChatOutputEvent) => output.push(e),
		forAttempt: () => ({ classifyExecution: () => "succeeded" as const }),
	};
}

describe("review F probe: transient error before any output, no fallback model", () => {
	it("streaming", async () => {
		const output: NormalChatOutputEvent[] = [];
		const bodies: Array<Record<string, unknown>> = [];
		let requests = 0;
		let executions = 0;
		for await (const _e of runStreamingNormalChatModelRun({
			provider,
			messages: [{ role: "user" as const, content: "Search for X" }],
			completionPolicy: policy(output),
			tools: {
				lookup: tool({
					inputSchema: z.object({}),
					execute: async () => {
						executions++;
						return "evidence";
					},
				}),
			},
			fetch: async (_u: unknown, init?: { body?: unknown }) => {
				requests++;
				bodies.push(JSON.parse(String(init?.body)));
				if (requests === 1)
					throw Object.assign(new Error("fetch failed"), {
						cause: { code: "ECONNRESET" },
					});
				return okStream();
			},
		}))
			void _e;
		const completion = output.find((e) => e.type === "completion");
		console.info("[review-F] transient streaming", {
			requests,
			executions,
			secondHasTools:
				Array.isArray(bodies[1]?.tools) &&
				(bodies[1]?.tools as unknown[]).length > 0,
			firstHasTools:
				Array.isArray(bodies[0]?.tools) &&
				(bodies[0]?.tools as unknown[]).length > 0,
			lastUser: JSON.stringify(
				(bodies[1]?.messages as Array<{ role: string; content: unknown }>)?.at(
					-1,
				)?.content,
			).slice(0, 120),
			completion: (completion as { completion?: unknown } | undefined)
				?.completion,
			answer: projectNormalChatOutput(output).answer,
		});
		expect(requests).toBeGreaterThanOrEqual(1);
		expect(requests).toBe(2);
		expect(bodies[1]?.tools).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "function" })]),
		);
		expect(output.find((event) => event.type === "completion")).toMatchObject({
			completion: {
				phase: "working",
				outcome: "answered",
				closingAttempted: false,
			},
		});
	});
	it("plain", async () => {
		const output: NormalChatOutputEvent[] = [];
		const bodies: Array<Record<string, unknown>> = [];
		let requests = 0;
		const result = await runPlainNormalChatModelRun({
			provider,
			messages: [{ role: "user" as const, content: "Search for X" }],
			completionPolicy: policy(output),
			tools: {
				lookup: tool({
					inputSchema: z.object({}),
					execute: async () => "evidence",
				}),
			},
			fetch: async (_u: unknown, init?: { body?: unknown }) => {
				requests++;
				bodies.push(JSON.parse(String(init?.body)));
				if (requests === 1)
					throw Object.assign(new Error("fetch failed"), {
						cause: { code: "ECONNRESET" },
					});
				return new Response(
					JSON.stringify({
						id: "r",
						object: "chat.completion",
						created: 1,
						model: "actual-test",
						choices: [
							{
								index: 0,
								message: { role: "assistant", content: "closed answer" },
								finish_reason: "stop",
							},
						],
						usage: {
							prompt_tokens: 10,
							completion_tokens: 3,
							total_tokens: 13,
						},
					}),
					{ headers: { "content-type": "application/json" } },
				);
			},
		});
		console.info("[review-F] transient plain", {
			requests,
			secondHasTools:
				Array.isArray(bodies[1]?.tools) &&
				(bodies[1]?.tools as unknown[]).length > 0,
			firstHasTools:
				Array.isArray(bodies[0]?.tools) &&
				(bodies[0]?.tools as unknown[]).length > 0,
			lastUser: JSON.stringify(
				(bodies[1]?.messages as Array<{ role: string; content: unknown }>)?.at(
					-1,
				)?.content,
			).slice(0, 120),
			completion: result.completion,
			text: result.text,
		});
		expect(requests).toBeGreaterThanOrEqual(1);
		expect(requests).toBe(2);
		expect(bodies[1]?.tools).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "function" })]),
		);
		expect(output.find((event) => event.type === "completion")).toMatchObject({
			completion: {
				phase: "working",
				outcome: "answered",
				closingAttempted: false,
			},
		});
	});
});

it.each([
	"plain",
	"streaming",
])("bounds repeated pre-output failure to two tools-on requests (%s)", async (transport) => {
	const output: NormalChatOutputEvent[] = [];
	const bodies: Array<Record<string, unknown>> = [];
	const args = {
		provider,
		messages: [{ role: "user" as const, content: "Search" }],
		completionPolicy: policy(output),
		tools: {
			lookup: tool({
				inputSchema: z.object({}),
				execute: async () => "evidence",
			}),
		},
		fetch: async (
			_url: unknown,
			init?: { body?: unknown },
		): Promise<Response> => {
			bodies.push(JSON.parse(String(init?.body)));
			throw new Error("fetch failed");
		},
	};
	if (transport === "plain") await runPlainNormalChatModelRun(args);
	else
		for await (const event of runStreamingNormalChatModelRun(args)) void event;
	expect(bodies).toHaveLength(2);
	for (const body of bodies)
		expect(body.tools).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "function" })]),
		);
	expect(output.find((event) => event.type === "completion")).toMatchObject({
		completion: {
			phase: "working",
			outcome: "failed",
			closingAttempted: false,
		},
	});
});

it.each([
	"content",
	"reasoning_content",
])("never retries tools-on after upstream %s", async (field) => {
	const output: NormalChatOutputEvent[] = [];
	const bodies: Array<Record<string, unknown>> = [];
	let wire: ReadableStreamDefaultController<Uint8Array>;
	for await (const event of runStreamingNormalChatModelRun({
		provider,
		messages: [{ role: "user", content: "Search" }],
		completionPolicy: {
			...policy(output),
			onOutputEvent: (event) => {
				output.push(event);
				if (bodies.length === 1 && event.type === "block_delta")
					setTimeout(() => wire.error(new Error("lost transport")));
			},
		},
		tools: {
			lookup: tool({
				inputSchema: z.object({}),
				execute: async () => "evidence",
			}),
		},
		fetch: async (_url, init) => {
			bodies.push(JSON.parse(String(init?.body)));
			if (bodies.length === 1)
				return new Response(
					new ReadableStream({
						start(controller) {
							wire = controller;
							controller.enqueue(
								new TextEncoder().encode(chunk({ [field]: "partial" })),
							);
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				);
			return okStream();
		},
	}))
		void event;
	expect(bodies).toHaveLength(2);
	expect(bodies[1].tools).toBeUndefined();
	expect(output.find((event) => event.type === "completion")).toMatchObject({
		completion: { phase: "closing", closingAttempted: true },
	});
});
