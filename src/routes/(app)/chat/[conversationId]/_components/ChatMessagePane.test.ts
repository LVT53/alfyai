import { fireEvent, render } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import type {
	ChatMessage,
	DocumentWorkspaceItem,
	TaskSteeringPayload,
} from "$lib/types";
import ChatMessagePane from "./ChatMessagePane.svelte";

vi.mock("$lib/utils/markdown-loader", () => ({
	collectSourceReferenceCandidates: async () => [],
	prepareCodeHighlighting: async () => undefined,
	renderCodeBlock: async (content: string) =>
		`<pre><code>${content}</code></pre>`,
	renderHighlightedText: async (content: string) => content,
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
		const onPublishSkillDraft = vi.fn();
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
			contextDebug: null,
			canPublishSkillDrafts: true,
			onOpenDocument: vi.fn<(document: DocumentWorkspaceItem) => void>(),
			onRegenerate: vi.fn(),
			onEdit: vi.fn(),
			onSteer: vi.fn<(payload: TaskSteeringPayload) => void>(),
			onSaveSkillDraft,
			onDismissSkillDraft,
			onPublishSkillDraft,
		});

		await fireEvent.click(getByRole("button", { name: "Save private skill" }));
		await fireEvent.click(getByRole("button", { name: "Dismiss draft" }));
		await fireEvent.click(getByRole("button", { name: "Publish skill" }));

		expect(onSaveSkillDraft).toHaveBeenCalledWith({
			messageId: "assistant-1",
			draftId: "draft-1",
		});
		expect(onDismissSkillDraft).toHaveBeenCalledWith({
			messageId: "assistant-1",
			draftId: "draft-1",
		});
		expect(onPublishSkillDraft).toHaveBeenCalledWith({
			messageId: "assistant-1",
			draftId: "draft-1",
		});
	});
});
