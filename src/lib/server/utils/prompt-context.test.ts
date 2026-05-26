import { describe, expect, it } from "vitest";
import { estimateTokenCount } from "$lib/utils/tokens";
import {
	compactContextSections,
	selectPromptSessionTurns,
	serializeBudgetedRoleTurns,
	serializeBudgetedAttachments,
	serializeWorkingSetArtifacts,
} from "./prompt-context";
import type { Artifact } from "$lib/types";

function makeAttachment(overrides: Partial<Artifact> = {}): Artifact {
	return {
		id: "attachment-1",
		userId: "user-1",
		type: "source_document",
		retrievalClass: "durable",
		name: "invoice.txt",
		mimeType: "text/plain",
		sizeBytes: 1024,
		conversationId: "conv-1",
		summary: null,
		createdAt: 1,
		updatedAt: 1,
		extension: "txt",
		storagePath: null,
		contentText: null,
		metadata: null,
		...overrides,
	};
}

describe("compactContextSections", () => {
	it("keeps protected core context intact even when it exceeds the target budget", () => {
		const compacted = compactContextSections({
			intro: "Context bundle:",
			message: "What should I do next?",
			targetTokens: 80,
			sections: [
				{
					title: "Task State",
					body: "Important task state. ".repeat(400),
					layer: "task_state",
					protected: true,
				},
			],
		});

		expect(compacted.inputValue).toContain("## Task State");
		expect(compacted.inputValue).toContain("Important task state. ".repeat(20));
		expect(compacted.inputValue).not.toContain("[truncated]");
		expect(compacted.compactionApplied).toBe(false);
		expect(compacted.compactionMode).toBe("none");
		expect(compacted.estimatedTokens).toBeGreaterThan(80);
		expect(estimateTokenCount(compacted.inputValue)).toBe(
			compacted.estimatedTokens,
		);
		expect(compacted.sectionSelections).toEqual([
			expect.objectContaining({
				title: "Task State",
				protected: true,
				trimmed: false,
				inclusionLevel: "full",
			}),
		]);
	});

	it("preserves the current user message separately from protected context", () => {
		const compacted = compactContextSections({
			intro: "Context bundle:",
			message: "Keep this exact user question.",
			targetTokens: 8,
			sections: [
				{
					title: "Task State",
					body: "Important task state. ".repeat(400),
					layer: "task_state",
					protected: true,
				},
			],
		});

		expect(compacted.inputValue).toContain(
			"## Current User Message\nKeep this exact user question.",
		);
		expect(compacted.inputValue).toContain("## Task State");
		expect(compacted.inputValue).toContain("Important task state.");
		expect(compacted.sectionSelections).toEqual([
			expect.objectContaining({
				title: "Task State",
				protected: true,
				trimmed: false,
				inclusionLevel: "full",
			}),
		]);
	});
});

describe("serializeBudgetedAttachments", () => {
	it("uses excerpt context for a targeted question over a large attachment", () => {
		const serialized = serializeBudgetedAttachments({
			artifacts: [
				makeAttachment({
					contentText: [
						"Invoice total is 42 USD.",
						"UNRELATED_TRAILING_BODY ".repeat(4_000),
					].join("\n"),
				}),
			],
			snippets: new Map([["attachment-1", "Invoice total is 42 USD."]]),
			message: "What is the invoice total?",
			totalBudget: 600,
		});

		expect(serialized.body).toContain("Context mode: Excerpt Context");
		expect(serialized.body).toContain("Invoice total is 42 USD.");
		expect(serialized.body).not.toContain("UNRELATED_TRAILING_BODY");
		expect(serialized.estimatedTokens).toBeLessThanOrEqual(600);
		expect(serialized.items).toEqual([
			expect.objectContaining({
				id: "attachment-1",
				title: "invoice.txt",
				inclusionLevel: "excerpt",
				trimmed: false,
			}),
		]);
	});

	it("promotes a direct document task to budgeted task context", () => {
		const serialized = serializeBudgetedAttachments({
			artifacts: [
				makeAttachment({
					contentText: "Project brief section. ".repeat(1_000),
				}),
			],
			message: "Summarize this attached document.",
			totalBudget: 700,
		});

		expect(serialized.body).toContain("Context mode: Task Context");
		expect(serialized.body).toContain("[truncated]");
		expect(serialized.estimatedTokens).toBeLessThanOrEqual(700);
		expect(serialized.items).toEqual([
			expect.objectContaining({
				id: "attachment-1",
				inclusionLevel: "task",
				trimmed: true,
			}),
		]);
	});

	it("preserves breadth across multiple attached files", () => {
		const serialized = serializeBudgetedAttachments({
			artifacts: [
				makeAttachment({
					id: "attachment-1",
					name: "alpha.txt",
					contentText: "Alpha details. ".repeat(1_000),
				}),
				makeAttachment({
					id: "attachment-2",
					name: "beta.txt",
					contentText: "Beta details. ".repeat(1_000),
				}),
				makeAttachment({
					id: "attachment-3",
					name: "gamma.txt",
					contentText: "Gamma details. ".repeat(1_000),
				}),
			],
			message: "Which one mentions beta?",
			totalBudget: 900,
		});

		expect(serialized.body).toContain("Attachment: alpha.txt");
		expect(serialized.body).toContain("Attachment: beta.txt");
		expect(serialized.body).toContain("Attachment: gamma.txt");
		expect(serialized.estimatedTokens).toBeLessThanOrEqual(900);
		expect(serialized.items.map((item) => item.id)).toEqual([
			"attachment-1",
			"attachment-2",
			"attachment-3",
		]);
		for (const item of serialized.items) {
			expect(item.inclusionLevel).toBe("excerpt");
			expect(item.estimatedTokens).toBeLessThanOrEqual(300);
		}
	});
});

describe("selectPromptSessionTurns", () => {
	it("keeps older unrelated turns so LLM compression, not deterministic relevance, handles overflow", () => {
		const turns = [
			{
				messages: [
					{ role: "user" as const, content: "First unrelated request" },
					{ role: "assistant" as const, content: "FIRST_TURN_MARKER" },
				],
			},
			{
				messages: [
					{ role: "user" as const, content: "Second unrelated request" },
					{ role: "assistant" as const, content: "SECOND_TURN_MARKER" },
				],
			},
			{
				messages: [
					{ role: "user" as const, content: "Current adjacent request" },
					{ role: "assistant" as const, content: "RECENT_TURN_MARKER" },
				],
			},
		];

		const selected = selectPromptSessionTurns({
			turns,
			message: "Different topic.",
			resolveContent: (turn) =>
				turn.messages.map((message) => message.content).join(" "),
			scoreTurn: () => 0,
			recentTurnCount: 1,
		});

		expect(selected).toEqual(turns);
	});

	it("keeps large recent turns so final context budgeting decides what fits", () => {
		const turns = [
			{
				messages: [
					{ role: "user" as const, content: "Previous unrelated request" },
					{
						role: "assistant" as const,
						content: "UNRELATED_LARGE_TURN ".repeat(3_000),
					},
				],
			},
		];

		const selected = selectPromptSessionTurns({
			turns,
			message: "What is the capital of France?",
			resolveContent: (turn) =>
				turn.messages.map((message) => message.content).join(" "),
			scoreTurn: () => 0,
			recentTurnCount: 3,
		});

		expect(selected).toEqual(turns);
	});

	it("keeps a large recent turn when it matches the current question", () => {
		const turns = [
			{
				messages: [
					{ role: "user" as const, content: "Draft the launch plan" },
					{
						role: "assistant" as const,
						content: "Launch plan details. ".repeat(3_000),
					},
				],
			},
		];

		const selected = selectPromptSessionTurns({
			turns,
			message: "Continue the launch plan.",
			resolveContent: (turn) =>
				turn.messages.map((message) => message.content).join(" "),
			scoreTurn: () => 2,
			recentTurnCount: 3,
		});

		expect(selected).toEqual(turns);
	});
});

describe("serializeBudgetedRoleTurns", () => {
	const role = (message: { role: "user" | "assistant" }) => message.role;
	const content = (message: { content: string }) => message.content;

	it("serializes every session turn even when the estimate exceeds the budget", () => {
		const turns = [
			{
				messages: [
					{ role: "user" as const, content: "Old setup question." },
					{ role: "assistant" as const, content: "Old setup answer." },
				],
			},
			{
				messages: [
					{ role: "user" as const, content: "Middle design question." },
					{ role: "assistant" as const, content: "Middle design answer." },
				],
			},
			{
				messages: [
					{ role: "user" as const, content: "Latest implementation question." },
					{ role: "assistant" as const, content: "Latest implementation answer." },
				],
			},
		];
		const middleAndLatestBudget = estimateTokenCount(
			[
				"USER: Middle design question.\n\nASSISTANT: Middle design answer.",
				"USER: Latest implementation question.\n\nASSISTANT: Latest implementation answer.",
			].join("\n\n"),
		);

		const serialized = serializeBudgetedRoleTurns({
			turns,
			resolveRole: role,
			resolveContent: content,
			maxTokens: middleAndLatestBudget,
		});

		expect(serialized.body).toContain("Old setup question");
		expect(serialized.body).toContain("Middle design question");
		expect(serialized.body).toContain("Latest implementation question");
		expect(serialized.includedTurnCount).toBe(3);
		expect(serialized.omittedTurnCount).toBe(0);
		expect(serialized.trimmed).toBe(false);
		expect(serialized.estimatedTokens).toBeGreaterThan(middleAndLatestBudget);
	});

	it("keeps an oversized latest turn intact so overflow is handled by compression", () => {
		const serialized = serializeBudgetedRoleTurns({
			turns: [
				{
					messages: [
						{ role: "user" as const, content: "Latest web research request." },
						{
							role: "assistant" as const,
							content: "Detailed search result. ".repeat(1_000),
						},
					],
				},
			],
			resolveRole: role,
			resolveContent: content,
			maxTokens: 80,
		});

		expect(serialized.body).toContain("Latest web research request");
		expect(serialized.body).toContain("Detailed search result.");
		expect(serialized.body).not.toContain("[truncated]");
		expect(serialized.includedTurnCount).toBe(1);
		expect(serialized.omittedTurnCount).toBe(0);
		expect(serialized.trimmed).toBe(false);
		expect(serialized.estimatedTokens).toBeGreaterThan(80);
	});
});

describe("serializeWorkingSetArtifacts", () => {
	it("preserves breadth across multiple selected evidence items within budget", () => {
		const serialized = serializeWorkingSetArtifacts({
			artifacts: [
				makeAttachment({
					id: "pin-1",
					name: "alpha.md",
					contentText: "Alpha evidence. ".repeat(1_000),
				}),
				makeAttachment({
					id: "pin-2",
					name: "beta.md",
					contentText: "Beta evidence. ".repeat(1_000),
				}),
				makeAttachment({
					id: "pin-3",
					name: "gamma.md",
					contentText: "Gamma evidence. ".repeat(1_000),
				}),
			],
			totalBudget: 360,
			documentBudget: 360,
			outputBudget: 360,
		});

		expect(serialized).toContain("Document: alpha.md");
		expect(serialized).toContain("Document: beta.md");
		expect(serialized).toContain("Document: gamma.md");
		expect(estimateTokenCount(serialized)).toBeLessThanOrEqual(360);
	});

	it("keeps many selected evidence items within the total budget while preserving header breadth", () => {
		const artifacts = Array.from({ length: 24 }, (_, index) =>
			makeAttachment({
				id: `pin-${index + 1}`,
				name: `source-${String(index + 1).padStart(2, "0")}.md`,
				contentText: `Evidence ${index + 1}. `.repeat(1_000),
			}),
		);
		const totalBudget = 120;
		const serialized = serializeWorkingSetArtifacts({
			artifacts,
			totalBudget,
			documentBudget: 120,
			outputBudget: 120,
		});

		const emittedHeaders = artifacts.filter((artifact) =>
			serialized.includes(`Document: ${artifact.name}`),
		);
		const expectedHeaderCount = artifacts.reduce(
			(state, artifact) => {
				const candidateHeaders = [...state.headers, `Document: ${artifact.name}`];
				if (estimateTokenCount(candidateHeaders.join("\n\n")) <= totalBudget) {
					state.headers = candidateHeaders;
				}
				return state;
			},
			{ headers: [] as string[] },
		).headers.length;

		expect(estimateTokenCount(serialized)).toBeLessThanOrEqual(totalBudget);
		expect(emittedHeaders).toHaveLength(expectedHeaderCount);
		expect(emittedHeaders.length).toBeGreaterThan(1);
		expect(emittedHeaders.length).toBeLessThan(artifacts.length);
	});
});
