import { describe, expect, it } from "vitest";
import { replayMiMoReasoningContentInRequestBody } from "./mimo-reasoning-replay";

describe("MiMo reasoning content replay", () => {
	it("injects captured reasoning_content into assistant tool-call messages", () => {
		const body = {
			messages: [
				{ role: "user", content: "Look up the weather." },
				{
					role: "assistant",
					content: "",
					tool_calls: [
						{
							id: "call_weather",
							type: "function",
							function: { name: "get_weather", arguments: "{}" },
						},
					],
				},
				{ role: "tool", tool_call_id: "call_weather", content: "Sunny" },
			],
		};

		const replayed = replayMiMoReasoningContentInRequestBody(body, {
			reasoningByToolCallId: new Map([
				[
					"call_weather",
					"The user needs weather, so I should call the weather tool.",
				],
			]),
		});

		expect(replayed).not.toBe(body);
		expect(replayed).toMatchObject({
			messages: expect.arrayContaining([
				expect.objectContaining({
					role: "assistant",
					reasoning_content:
						"The user needs weather, so I should call the weather tool.",
				}),
			]),
		});
	});

	it("does not inject when no captured reasoning matches the tool call", () => {
		const body = {
			messages: [
				{
					role: "assistant",
					tool_calls: [{ id: "call_weather" }],
				},
			],
		};

		expect(
			replayMiMoReasoningContentInRequestBody(body, {
				reasoningByToolCallId: new Map([["other_call", "Reasoning"]]),
			}),
		).toBe(body);
	});

	it("does not overwrite existing reasoning_content", () => {
		const body = {
			messages: [
				{
					role: "assistant",
					reasoning_content: "Existing reasoning",
					tool_calls: [{ id: "call_weather" }],
				},
			],
		};

		expect(
			replayMiMoReasoningContentInRequestBody(body, {
				reasoningByToolCallId: new Map([["call_weather", "New reasoning"]]),
			}),
		).toBe(body);
	});
});
