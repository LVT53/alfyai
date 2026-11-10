import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getClipboardText, joinReplyText } from "./reply-text";

describe("getClipboardText", () => {
	it("takes the words of a row without its thinking text", () => {
		expect(
			getClipboardText("<thinking>Inline hidden thought.</thinking>Visible."),
		).toBe("Visible.");
		expect(getClipboardText("  <thinking>Open")).toBe("Open");
		expect(getClipboardText("Plain words.")).toBe("Plain words.");
	});
});

describe("joinReplyText", () => {
	it("is a row's words alone for a reply of one row", () => {
		expect(joinReplyText(["  A plan for Saturday.\n"])).toBe(
			"A plan for Saturday.",
		);
	});

	it("joins the rows' words by a blank line, in order", () => {
		expect(joinReplyText(["First words.", "Second words.", "Last."])).toBe(
			"First words.\n\nSecond words.\n\nLast.",
		);
	});

	it("leaves out a row with no words, and strips the thinking of each", () => {
		expect(
			joinReplyText([
				"<thinking>Plan.</thinking>First words.",
				"   ",
				"<thinking>Nothing to say.</thinking>",
				"Last words.",
			]),
		).toBe("First words.\n\nLast words.");
	});

	it("has no words for a reply with none, or no rows", () => {
		expect(joinReplyText(["", " \n"])).toBe("");
		expect(joinReplyText([])).toBe("");
	});
});

describe("module hygiene", () => {
	it("depends only on the pure shared finalization owner", () => {
		const here = path.dirname(fileURLToPath(import.meta.url));
		const source = readFileSync(path.join(here, "reply-text.ts"), "utf8");
		const imports = [
			...source.matchAll(/^import(?! type\s)[\s\S]*?from ["']([^"']+)["'];/gm),
		].map((match) => match[1]);
		expect(imports).toEqual(["./normal-chat-completion"]);
	});
});

describe("status-aware outward replies", () => {
	const row = (
		outcome: "answered" | "incomplete" | "stopped" | "failed",
		content: string,
	) => ({ content, normalChatOutputView: { completion: { outcome } } });
	it.each([
		"incomplete",
		"stopped",
		"failed",
	] as const)("labels %s canonical answer without changing its bytes", (outcome) => {
		const content = "  The checked result is 42\n";
		expect(joinReplyText([row(outcome, content)])).toBe(
			`_Incomplete answer._\n\n${content}`,
		);
	});
	it("keeps completed canonical bytes, legacy compatibility and empty activity separate", () => {
		expect(joinReplyText([row("answered", "  Exact\n")])).toBe("  Exact\n");
		expect(joinReplyText([{ content: "  Legacy words.\n" }])).toBe(
			"Legacy words.",
		);
		expect(joinReplyText([row("failed", "")])).toBe("");
	});
	it("joins earlier committed answers once and labels the incomplete segment only", () => {
		expect(
			joinReplyText([
				row("answered", "Earlier"),
				row("failed", ""),
				row("incomplete", "Partial"),
			]),
		).toBe("Earlier\n\n_Incomplete answer._\n\nPartial");
	});
});

describe("durable finalization outward status", () => {
	it.each([
		false,
		true,
	])("Copy and markdown preserve canonical bytes with stopped=%s", (wasStopped) => {
		const scope = {
			version: 1,
			turnId: "t",
			segmentId: "s",
			attemptId: "a",
			stepId: "c",
			phase: "closing",
		} as const;
		const row = {
			content: "  Canonical answer\n",
			normalChatFinalization: {
				version: 1,
				status: "failed",
				cause: "file_association_failed",
				wasStopped,
			} as const,
			normalChatOutput: {
				version: 1,
				events: [
					{
						...scope,
						sequence: 1,
						type: "completion",
						completion: {
							version: 1,
							turnId: "t",
							segmentId: "s",
							phase: "closing",
							outcome: wasStopped ? "stopped" : "answered",
							stopCause: wasStopped ? "user_stop" : "natural_stop",
							workingStopCause: "tool_budget",
							closingAttempted: true,
						},
					},
				],
			},
		} as const;
		expect(getClipboardText(row)).toBe(
			"_Incomplete answer._\n\n  Canonical answer\n",
		);
		expect(joinReplyText([row], { legacy: "markdown" })).toBe(
			getClipboardText(row),
		);
	});
});

it.each([
	false,
	true,
])("marker-only outward failure preserves canonical bytes without model IDs, stopped=%s", (wasStopped) => {
	const row = {
		content: "  Canonical untracked answer\n",
		normalChatFinalization: {
			version: 1,
			status: "failed",
			cause: "file_association_failed",
			wasStopped,
		},
	} as const;
	expect(getClipboardText(row)).toBe(
		"_Incomplete answer._\n\n  Canonical untracked answer\n",
	);
	expect(joinReplyText([row], { legacy: "markdown" })).toBe(
		getClipboardText(row),
	);
	expect(
		getClipboardText({
			content: "Stopped",
			normalChatOutputView: { completion: { outcome: "stopped" } },
		}),
	).toBe("_Incomplete answer._\n\nStopped");
});

it.each(
	[false, true].flatMap((wasStopped) =>
		["", " \n\t"].map((content) => ({ wasStopped, content })),
	),
)("retains marker-only failure for empty outward content: $wasStopped/$content", ({
	wasStopped,
	content,
}) => {
	const row = {
		content,
		normalChatFinalization: {
			version: 1,
			status: "failed",
			cause: "file_association_failed",
			wasStopped,
		},
	} as const;
	const expected = `_Incomplete answer._\n\n${content}`;
	expect(getClipboardText(row)).toBe(expected);
	expect(joinReplyText([row], { legacy: "markdown" })).toBe(expected);
	expect(row.content).toBe(content);
	expect(getClipboardText({ content })).toBe("");
	expect(joinReplyText([{ content }], { legacy: "markdown" })).toBe("");
});
