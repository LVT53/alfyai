import { describe, expect, it } from "vitest";
import { normalizeAssistantOutputWithSkillControl } from "$lib/server/services/chat-turn/normalizer";
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
