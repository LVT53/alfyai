import { describe, expect, it } from "vitest";
import { normalizeAssistantOutputWithSkillControl } from "$lib/server/services/chat-turn/normalizer";
import { getLeakedToolDiagnosticPrefixLength } from "$lib/services/stream-protocol";
import {
	createNormalChatOutputAccumulator,
	type NormalChatOutputEvent,
	sanitizeNormalChatAnswer,
} from "./normal-chat-output";

const scope = {
	version: 1 as const,
	turnId: "t",
	segmentId: "s",
	attemptId: "a",
	stepId: "a:0",
	phase: "closing" as const,
};
const answerOf = (text: string) => {
	const a = createNormalChatOutputAccumulator();
	a.apply({
		...scope,
		sequence: 1,
		type: "block_start",
		blockId: "b",
		nativeId: "0",
		kind: "text",
		role: "answer",
	} as NormalChatOutputEvent);
	a.apply({
		...scope,
		sequence: 2,
		type: "block_delta",
		blockId: "b",
		text,
	} as NormalChatOutputEvent);
	return a.getProjection().answer;
};

describe("review D: explicit-markup sanitizer applied to a whole legitimate answer", () => {
	const legit = [
		[
			"JSON example with query/mode keys, then explanation",
			'```json\n{\n  "query": "SELECT * FROM users",\n  "mode": "read"\n}\n```\nThis request reads all users. Use mode "write" to modify rows.',
		],
		[
			"config sample with language/text keys, then explanation",
			'```json\n{"language": "en", "text": "Hello"}\n```\nThe `language` field selects the locale and `text` holds the string to translate.',
		],
		[
			"plain fence (no info string) with content/markdown keys",
			'```\n{"content": "# Title", "markdown": true}\n```\nThat is the payload shape.',
		],
		[
			"a JSON-first answer with a name key",
			'{"name": "Alice", "arguments": {"age": 30}}',
		],
		[
			"the Hermes tag named in prose",
			"Qwen models wrap each call in a <tool_call> tag and close it with </tool_call>.",
		],
		[
			"a complete Hermes-style block shown in a code fence",
			'Qwen writes a call like this:\n```xml\n<tool_call>\n{"name": "research_web", "arguments": {"query": "height"}}\n</tool_call>\n```\nThe server turns it into a structured call.',
		],
		[
			"a complete Hermes-style block shown in a tilde fence",
			'~~~\n<tool_call>{"name": "f", "arguments": {}}</tool_call>\n~~~\nThat is the whole format.',
		],
		[
			"DeepSeek's token quoted in a code fence",
			"Its calls start with this line:\n```\n<｜｜DSML｜｜ calls>\n```\nand every call sits inside it.",
		],
	];
	it.each(legit)("S1: %s keeps its prose", (_name, text) => {
		const sanitized = sanitizeNormalChatAnswer(text);
		expect(sanitized).toBe(text);
		expect(answerOf(text)).toBe(text);
		expect(
			normalizeAssistantOutputWithSkillControl(text, { structuredOutput: true })
				.visibleText,
		).toBe(text);
	});
});

describe("structural answers containing file payload examples", () => {
	const samples = [
		'{"version":1,"blocks":[{"type":"paragraph","text":"Hello"}]}',
		'{"documentSource":{"blocks":[{"type":"paragraph","text":"Hello"}]}}',
		'{"documentSource":{"template":"report"}}',
		'{"program":{"language":"python","sourceCode":"print(1)"}}',
	];
	it.each(samples)("preserves JSON payload %s, bare and fenced", (json) => {
		for (const text of [
			json,
			`\x60\x60\x60json\n${json}\n\x60\x60\x60\nThis is a sample document payload.`,
		]) {
			expect(sanitizeNormalChatAnswer(text)).toBe(text);
			expect(
				normalizeAssistantOutputWithSkillControl(text, {
					structuredOutput: true,
				}).visibleText,
			).toBe(text);
		}
	});
	it.each([
		'{"documentSource":',
		'{"program":',
		'{"version":1,"blocks"',
		'{"version":1,"template"',
	])("does not buffer a structural JSON prefix %s as a tool diagnostic", (text) => {
		expect(getLeakedToolDiagnosticPrefixLength(text, { leading: false })).toBe(
			0,
		);
	});
	it("continues removing explicit private/control syntax", () => {
		expect(
			normalizeAssistantOutputWithSkillControl("<think>private</think>Answer", {
				structuredOutput: true,
			}).visibleText,
		).toBe("Answer");
		expect(
			normalizeAssistantOutputWithSkillControl("<｜｜DSML｜｜ calls>control", {
				structuredOutput: true,
			}).visibleText,
		).toBe("");
	});
	it("blanks a complete Hermes-style tool call after a visible preface, as it does DeepSeek's markup", () => {
		const text =
			'Let me look that up.\n<tool_call>\n{"name": "research_web", "arguments": {"query": "height"}}\n</tool_call>';
		expect(sanitizeNormalChatAnswer(text)).toBe("");
		expect(answerOf(text)).toBe("");
		expect(
			normalizeAssistantOutputWithSkillControl(text, { structuredOutput: true })
				.visibleText,
		).toBe("");
	});
});
