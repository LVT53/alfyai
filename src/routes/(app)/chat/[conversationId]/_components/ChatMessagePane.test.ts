import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import type { DocumentWorkspaceItem } from "$lib/server/services/knowledge/types";
import type { ChatMessage } from "$lib/server/services/messages-types";
import type { AskQuestionDto } from "$lib/shared/ask-user";
import ChatMessagePane from "./ChatMessagePane.svelte";

vi.mock("$lib/utils/markdown-loader", () => ({
	collectSourceReferenceCandidates: async () => [],
	prepareCodeHighlighting: async () => undefined,
	parseMarkdownBlocks: async (content: string) =>
		content.trim() ? [{ kind: "html", raw: content }] : [],
	renderCodeBlock: async (content: string) =>
		`<pre><code>${content}</code></pre>`,
	renderHighlightedText: async (content: string) => content,
	renderInlineMarkdown: async (content: string) => content,
	renderMarkdown: async (content: string) =>
		content.replace(/\*\*(.*?)\*\*/g, "$1"),
}));

Object.defineProperty(window, "matchMedia", {
	writable: true,
	value: (query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener: () => undefined,
		removeListener: () => undefined,
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
		dispatchEvent: () => false,
	}),
});

describe("ChatMessagePane", () => {
	it("forwards assistant Skill Draft card actions to the chat page callbacks", async () => {
		const onSaveSkillDraft = vi.fn();
		const onDismissSkillDraft = vi.fn();
		const messages: ChatMessage[] = [
			{
				id: "assistant-1",
				role: "assistant",
				content: "I can make this reusable.",
				timestamp: Date.now(),
				skillDrafts: [
					{
						id: "draft-1",
						status: "proposed",
						displayName: "Meeting critic",
						description: "Review meeting notes.",
						instructions: "Find missing owners.",
						activationExamples: [],
						durationPolicy: "next_message",
						questionPolicy: "none",
						notesPolicy: "none",
						sourceScope: "selected_sources_only",
					},
				],
			},
		];

		const { getByRole } = render(ChatMessagePane, {
			messages,
			conversationId: "conv-1",
			isThinkingActive: false,
			onOpenDocument: vi.fn<(document: DocumentWorkspaceItem) => void>(),
			onRegenerate: vi.fn(),
			onStartEdit: vi.fn(),
			onSaveSkillDraft,
			onDismissSkillDraft,
		});

		await fireEvent.click(getByRole("button", { name: "Save private skill" }));
		await fireEvent.click(getByRole("button", { name: "Dismiss draft" }));

		expect(onSaveSkillDraft).toHaveBeenCalledWith({
			messageId: "assistant-1",
			draftId: "draft-1",
		});
		expect(onDismissSkillDraft).toHaveBeenCalledWith({
			messageId: "assistant-1",
			draftId: "draft-1",
		});
	});

	// "Ask me first": the pane hands MessageArea its props one by one, so a prop it
	// forgets is a card that is drawn and never answers.
	describe("a question Alfy asked", () => {
		const messages: ChatMessage[] = [
			{ id: "user-1", role: "user", content: "Plan dad's 60th", timestamp: 1 },
			{
				id: "assistant-1",
				role: "assistant",
				content: "Let's settle the shape of the day first.",
				timestamp: 2,
			},
		];
		const question: AskQuestionDto = {
			id: "q-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			toolCallId: "call-ask-1",
			questions: [
				{
					question: "Which way should we take it?",
					options: [{ label: "A party at home" }, { label: "Dinner out" }],
				},
			],
			status: "waiting",
			answer: null,
			createdAt: 1_000,
		};
		const paneProps = {
			messages,
			conversationId: "conv-1",
			isThinkingActive: false,
			onOpenDocument: vi.fn<(document: DocumentWorkspaceItem) => void>(),
			onRegenerate: vi.fn(),
			onStartEdit: vi.fn(),
		};

		it("draws the card and hands the answer to the chat page", async () => {
			const onAnswerQuestion = vi.fn();
			const { getByTestId, getByRole } = render(ChatMessagePane, {
				...paneProps,
				questions: [question],
				askActionState: {},
				onAnswerQuestion,
			});

			expect(getByTestId("ask-card")).toBeInTheDocument();
			// The card wakes after its read-before-answer lock.
			await waitFor(() =>
				expect(getByRole("button", { name: "Dinner out" })).toBeEnabled(),
			);
			await fireEvent.click(getByRole("button", { name: "Dinner out" }));

			expect(onAnswerQuestion).toHaveBeenCalledOnce();
			expect(onAnswerQuestion).toHaveBeenCalledWith("q-1", {
				kind: "answered",
				answers: [{ picked: [1], ownWords: null }],
			});
		});

		it("hands the card the page's state for its question", async () => {
			const { getByRole, rerender } = render(ChatMessagePane, {
				...paneProps,
				questions: [question],
				askActionState: {},
				onAnswerQuestion: vi.fn(),
			});
			// The card is on once its lock has passed...
			await waitFor(() =>
				expect(getByRole("button", { name: "Dinner out" })).toBeEnabled(),
			);

			// ...and off while an answer is out.
			await rerender({ askActionState: { "q-1": { busy: true } } });
			expect(getByRole("button", { name: "Dinner out" })).toBeDisabled();
		});
	});
});
