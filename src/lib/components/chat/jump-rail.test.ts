import { describe, expect, it } from "vitest";
import type { ChatMessage } from "$lib/server/services/messages-types";
import {
	buildJumpRailTurns,
	MAX_SNIPPET_LENGTH,
	railEntryText,
} from "./jump-rail";

/**
 * Minimal factory that only sets the fields the helper reads. Keeps the
 * tests focused on the pure turn-building logic (ADR-0043 Slice 17).
 */
function msg(
	id: string,
	role: "user" | "assistant",
	content: string,
	railSummary?: string,
): ChatMessage {
	return {
		id,
		renderKey: id,
		role,
		content,
		timestamp: 0,
		...(railSummary !== undefined ? { railSummary } : {}),
	};
}

describe("buildJumpRailTurns", () => {
	it("returns an empty array for an empty message list", () => {
		expect(buildJumpRailTurns([])).toEqual([]);
	});

	it("returns an empty array when there are fewer than 6 assistant messages", () => {
		const messages: ChatMessage[] = [
			msg("u1", "user", "Question one"),
			msg("a1", "assistant", "Answer one"),
			msg("u2", "user", "Question two"),
			msg("a2", "assistant", "Answer two"),
			msg("u3", "user", "Question three"),
			msg("a3", "assistant", "Answer three"),
			msg("u4", "user", "Question four"),
			msg("a4", "assistant", "Answer four"),
			msg("a5", "assistant", "Answer five"),
		];

		// 5 assistant messages — below the 6-message threshold.
		expect(buildJumpRailTurns(messages)).toEqual([]);
	});

	it("maps each assistant message to a turn once there are 6+ assistant messages", () => {
		const messages: ChatMessage[] = [
			msg("u1", "user", "Question one"),
			msg("a1", "assistant", "Answer one"),
			msg("u2", "user", "Question two"),
			msg("a2", "assistant", "Answer two"),
			msg("u3", "user", "Question three"),
			msg("a3", "assistant", "Answer three"),
			msg("u4", "user", "Question four"),
			msg("a4", "assistant", "Answer four"),
			msg("u5", "user", "Question five"),
			msg("a5", "assistant", "Answer five"),
			msg("u6", "user", "Question six"),
			msg("a6", "assistant", "Answer six"),
		];

		const turns = buildJumpRailTurns(messages);

		expect(turns).toHaveLength(6);
		expect(turns.map((t) => t.id)).toEqual([
			"a1",
			"a2",
			"a3",
			"a4",
			"a5",
			"a6",
		]);
	});

	it("uses the assistant content for the snippet, paired with the preceding user question as the eyebrow", () => {
		const messages: ChatMessage[] = [
			msg("u1", "user", "And the chart?"),
			msg("a1", "assistant", "Here's the segment breakdown chart."),
			// Pad to 6 assistant messages so the helper emits turns.
			msg("u2", "user", "q2"),
			msg("a2", "assistant", "a2"),
			msg("u3", "user", "q3"),
			msg("a3", "assistant", "a3"),
			msg("u4", "user", "q4"),
			msg("a4", "assistant", "a4"),
			msg("u5", "user", "q5"),
			msg("a5", "assistant", "a5"),
			msg("u6", "user", "q6"),
			msg("a6", "assistant", "a6"),
		];

		const [first] = buildJumpRailTurns(messages);

		expect(first.id).toBe("a1");
		expect(first.snippet).toBe("Here's the segment breakdown chart.");
		// Eyebrow is the preceding user question, quoted.
		expect(first.questionEyebrow).toBe('"And the chart?"');
		expect(first.contentLength).toBe(
			"Here's the segment breakdown chart.".length,
		);
	});

	it("quotes and truncates a long user question eyebrow", () => {
		const longQuestion = "x".repeat(200);
		const messages: ChatMessage[] = [
			msg("u1", "user", longQuestion),
			msg("a1", "assistant", "a1"),
			msg("a2", "assistant", "a2"),
			msg("a3", "assistant", "a3"),
			msg("a4", "assistant", "a4"),
			msg("a5", "assistant", "a5"),
			msg("a6", "assistant", "a6"),
		];

		const [first] = buildJumpRailTurns(messages);

		// Eyebrow is quoted and capped well under the full question length.
		expect(first.questionEyebrow).not.toBeNull();
		const eyebrow = first.questionEyebrow as string;
		expect(eyebrow.startsWith(`"`)).toBe(true);
		expect(eyebrow.endsWith(`"`)).toBe(true);
		expect(eyebrow.length).toBeLessThan(longQuestion.length);
		expect(eyebrow).toContain("…");
	});

	it("truncates the assistant snippet at the configured boundary with an ellipsis", () => {
		const longAnswer = "y".repeat(MAX_SNIPPET_LENGTH + 50);
		const messages: ChatMessage[] = [
			msg("u1", "user", "q1"),
			msg("a1", "assistant", longAnswer),
			msg("a2", "assistant", "a2"),
			msg("a3", "assistant", "a3"),
			msg("a4", "assistant", "a4"),
			msg("a5", "assistant", "a5"),
			msg("a6", "assistant", "a6"),
		];

		const [first] = buildJumpRailTurns(messages);

		expect(first.snippet.length).toBe(MAX_SNIPPET_LENGTH + 1); // content + ellipsis
		expect(first.snippet.endsWith("…")).toBe(true);
		// contentLength reflects the *full* content, not the truncated snippet.
		expect(first.contentLength).toBe(longAnswer.length);
	});

	it("leaves the snippet unterminated when it is exactly at the boundary", () => {
		const exact = "z".repeat(MAX_SNIPPET_LENGTH);
		const messages: ChatMessage[] = [
			msg("u1", "user", "q1"),
			msg("a1", "assistant", exact),
			msg("a2", "assistant", "a2"),
			msg("a3", "assistant", "a3"),
			msg("a4", "assistant", "a4"),
			msg("a5", "assistant", "a5"),
			msg("a6", "assistant", "a6"),
		];

		const [first] = buildJumpRailTurns(messages);

		expect(first.snippet).toBe(exact);
		expect(first.snippet.endsWith("…")).toBe(false);
	});

	it("omits the question eyebrow when an assistant turn has no preceding user message", () => {
		// First message is an assistant message (no preceding user question).
		const messages: ChatMessage[] = [
			msg("a1", "assistant", "Opening reply"),
			msg("a2", "assistant", "a2"),
			msg("a3", "assistant", "a3"),
			msg("a4", "assistant", "a4"),
			msg("a5", "assistant", "a5"),
			msg("a6", "assistant", "a6"),
		];

		const [first] = buildJumpRailTurns(messages);

		expect(first.questionEyebrow).toBeNull();
	});

	it("ignores non-user messages when looking for a preceding question (assistant-assistant pairing)", () => {
		const messages: ChatMessage[] = [
			msg("u1", "user", "real question"),
			msg("a1", "assistant", "a1"),
			// Second assistant turn is NOT preceded by a user message.
			msg("a2", "assistant", "a2"),
			msg("a3", "assistant", "a3"),
			msg("a4", "assistant", "a4"),
			msg("a5", "assistant", "a5"),
			msg("a6", "assistant", "a6"),
		];

		const turns = buildJumpRailTurns(messages);

		expect(turns[0].questionEyebrow).toBe('"real question"');
		// a2 immediately follows a1 (another assistant), so no eyebrow.
		expect(turns[1].questionEyebrow).toBeNull();
	});

	// A1 — the LLM-summarized rail entry (owner idea). When a durable
	// `railSummary` is present on the assistant message, the snippet is the
	// summary; otherwise it stays the verbatim truncated reply start (the
	// honest fallback while the summary is pending/failed).
	it("uses the persisted railSummary as the snippet when present", () => {
		const messages: ChatMessage[] = [
			msg("u1", "user", "q1", undefined),
			msg("a1", "assistant", "y".repeat(200), "Segment breakdown for Q3"),
			msg("a2", "assistant", "a2"),
			msg("a3", "assistant", "a3"),
			msg("a4", "assistant", "a4"),
			msg("a5", "assistant", "a5"),
			msg("a6", "assistant", "a6"),
		];

		const [first] = buildJumpRailTurns(messages);

		expect(first.snippet).toBe("Segment breakdown for Q3");
		// contentLength still reflects the full raw content, not the summary.
		expect(first.contentLength).toBe(200);
	});
});

describe("railEntryText", () => {
	it("returns the rail summary when present", () => {
		expect(
			railEntryText({
				railSummary: "A crisp headline",
				content: "y".repeat(200),
			}),
		).toBe("A crisp headline");
	});

	it("uses the summary verbatim even when the content is short", () => {
		expect(
			railEntryText({ railSummary: "Summary wins", content: "short" }),
		).toBe("Summary wins");
	});

	it("falls back to the truncated content when no summary is present", () => {
		const long = "y".repeat(MAX_SNIPPET_LENGTH + 50);
		expect(railEntryText({ content: long })).toBe(
			`${"y".repeat(MAX_SNIPPET_LENGTH)}…`,
		);
	});

	it("returns the full content untruncated when short and no summary", () => {
		expect(railEntryText({ content: "Just a short reply." })).toBe(
			"Just a short reply.",
		);
	});

	// Fix 3 (hardening) — the fallback must not depend on the read-model
	// projection guaranteeing `undefined` (never `""`) for an absent summary: a
	// blank/whitespace `railSummary` that slips through must still fall back to
	// the verbatim truncation, never surface as an empty rail snippet.
	it("falls back to truncation when railSummary is an empty string", () => {
		const long = "y".repeat(MAX_SNIPPET_LENGTH + 50);
		expect(railEntryText({ railSummary: "", content: long })).toBe(
			`${"y".repeat(MAX_SNIPPET_LENGTH)}…`,
		);
	});

	it("falls back to truncation when railSummary is only whitespace", () => {
		const long = "y".repeat(MAX_SNIPPET_LENGTH + 50);
		expect(railEntryText({ railSummary: "   \n\t ", content: long })).toBe(
			`${"y".repeat(MAX_SNIPPET_LENGTH)}…`,
		);
	});
});
