import { beforeEach, describe, expect, it, vi } from "vitest";

const stage = vi.hoisted(() => ({ text: "" }));

vi.mock("$lib/server/db", () => ({ db: {} }));
vi.mock("../atlas/model-stage", () => ({
	runAtlasModelStage: vi.fn(async () => ({
		text: stage.text,
		finishReason: "stop",
		usage: { inputTokens: 1, outputTokens: 1 },
	})),
}));

import { buildAtlasV3ModelCalls } from "./worker-bindings";

async function reply(text: string): Promise<string> {
	stage.text = text;
	const { calls } = buildAtlasV3ModelCalls({
		profile: "standard" as never,
		synthesisModel: "model1" as never,
		auditModel: "model2" as never,
	});
	const call = await calls.writer({
		stage: "v3:write:n1",
		system: "system",
		prompt: "prompt",
		maxOutputTokens: 100,
	});
	return call.text;
}

describe("the Atlas v3 model-call seam", () => {
	beforeEach(() => {
		stage.text = "";
	});

	it("drops a fence marker the model echoed", async () => {
		expect(
			await reply(
				'{"quotes":["<source-1a2b3c4d>Revenue rose 4%.</source-1A2B3C4D>"]}',
			),
		).toBe('{"quotes":["Revenue rose 4%."]}');
	});

	it("never cuts across the JSON of a legitimate reply that mentions a <source element", async () => {
		// A report about web video: the first sentence names the HTML element,
		// the next one states a bitrate. Stripping marker-lookalikes from the
		// raw reply spliced the two into one sentence carrying e2's citation.
		const text = JSON.stringify({
			paragraphs: [
				{
					sentences: [
						{
							text: "The <source element lists one file per format",
							evidenceIds: ["e1"],
							kind: "claim",
						},
						{
							text: "Streams above 5 Mbps need a > 10 Mbps link",
							evidenceIds: ["e2"],
							kind: "claim",
						},
					],
				},
			],
		});
		expect(await reply(text)).toBe(text);
	});
});
