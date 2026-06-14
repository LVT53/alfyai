import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeepResearchJob } from "$lib/types";

const runtimeHarness = vi.hoisted(() => ({
	streamInvocations: [] as Array<{
		message: string;
		callbacks: {
			onWaiting?: () => void;
			onError: (error: Error) => void;
		};
	}>,
}));

vi.mock("$app/environment", () => ({
	browser: true,
	building: false,
	dev: false,
	version: "test",
}));

vi.mock("$app/state", () => ({
	page: {
		url: new URL("http://localhost/chat/conv-1"),
		state: {},
	},
}));

vi.mock("$app/navigation", () => ({
	goto: vi.fn(),
	invalidate: vi.fn(),
	invalidateAll: vi.fn(),
	replaceState: vi.fn(),
}));

vi.mock("$lib/client/api/admin", () => ({
	fetchPublicPersonalityProfiles: vi.fn(async () => []),
}));

vi.mock("$lib/client/api/conversations", () => ({
	applyTaskSteering: vi.fn(),
	createConversationFork: vi.fn(),
	deleteConversation: vi.fn(),
	deleteConversationDraft: vi.fn(),
	deleteConversationMessages: vi.fn(),
	endConversationSkillSession: vi.fn(),
	fetchConversationDetail: vi.fn(async () => ({
		conversation: { id: "conv-1", title: "Chat", status: "open" },
		messages: [],
	})),
	fetchMessageEvidence: vi.fn(),
	generateConversationTitle: vi.fn(),
	runConversationContextCompression: vi.fn(),
	startConversationSkillSession: vi.fn(),
}));

vi.mock("$lib/client/api/deep-research", () => ({
	advanceDeepResearchWorkflow: vi.fn(),
	approveDeepResearchPlan: vi.fn(),
	cancelDeepResearchJob: vi.fn(),
	discussDeepResearchReport: vi.fn(),
	editDeepResearchPlan: vi.fn(),
	researchFurtherFromDeepResearchReport: vi.fn(),
	startDeepResearchChatJob: vi.fn(
		async (): Promise<DeepResearchJob> =>
			new Promise(() => {
				// Keep the handoff in-flight so the composer remains in generating mode.
			}),
	),
}));

vi.mock("$lib/client/api/file-production", () => ({
	cancelFileProductionJob: vi.fn(),
	retryFileProductionJob: vi.fn(),
}));

vi.mock("$lib/client/api/knowledge", () => ({
	recordDocumentWorkspaceOpen: vi.fn(),
	uploadKnowledgeAttachment: vi.fn(),
}));

vi.mock("$lib/client/api/skills", () => ({
	dismissSkillDraft: vi.fn(),
	publishSkillDraft: vi.fn(),
	saveSkillDraft: vi.fn(),
}));

vi.mock("$lib/utils/markdown-loader", () => ({
	collectSourceReferenceCandidates: async () => [],
	prepareCodeHighlighting: async () => undefined,
	renderCodeBlock: async (content: string) =>
		`<pre><code>${content}</code></pre>`,
	renderHighlightedText: async (content: string) => content,
	renderMarkdown: async (content: string) =>
		content.replace(/\*\*(.*?)\*\*/g, "$1"),
}));

vi.mock("$lib/client/normal-chat-client-turn-runtime", async () => {
	type RuntimeModule =
		typeof import("$lib/client/normal-chat-client-turn-runtime");
	const actual = await vi.importActual<RuntimeModule>(
		"$lib/client/normal-chat-client-turn-runtime",
	);
	return {
		...actual,
		createBrowserNormalChatClientTurnRuntime: vi.fn((adapters) =>
			actual.createNormalChatClientTurnRuntime({
				...adapters,
				streamChat: vi.fn((message, _conversationId, callbacks) => {
					runtimeHarness.streamInvocations.push({ message, callbacks });
					return {
						stop: vi.fn(),
						detach: vi.fn(),
					};
				}),
				checkForOrphanedStream: vi.fn(async () => null),
				getStreamBufferInfo: vi.fn(async () => null),
			}),
		),
	};
});

import { fetchConversationDetail } from "$lib/client/api/conversations";
import Page from "./+page.svelte";

function pageData() {
	return {
		conversation: {
			id: "conv-1",
			title: "Chat",
			projectId: null,
			status: "open" as const,
			createdAt: 1,
			updatedAt: 1,
		},
		messages: [],
		contextStatus: null,
		totalCostUsdMicros: 0,
		totalTokens: 0,
		attachedArtifacts: [],
		activeWorkingSet: [],
		taskState: null,
		contextDebug: null,
		contextSources: null,
		draft: null,
		forkOrigin: null,
		bootstrap: false,
		generatedFiles: [],
		fileProductionJobs: [],
		deepResearchJobs: [],
		contextCompressionSnapshots: [],
		activeSkillSession: null,
		userPersonality: null,
		userModel: "model1" as const,
		availableModels: [{ id: "model1", name: "Model 1", iconUrl: null }],
		maxMessageLength: 12000,
		deepResearchEnabled: true,
		composerCommandRegistryEnabled: false,
	};
}

describe("chat page runtime integration", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	beforeEach(() => {
		runtimeHarness.streamInvocations.length = 0;
		vi.mocked(fetchConversationDetail).mockResolvedValue({
			conversation: { id: "conv-1", title: "Chat", status: "open" },
			messages: [],
		});
		window.sessionStorage.clear();
		Object.defineProperty(window, "matchMedia", {
			writable: true,
			value: vi.fn().mockImplementation((query: string) => ({
				matches: false,
				media: query,
				onchange: null,
				addListener: vi.fn(),
				removeListener: vi.fn(),
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
				dispatchEvent: vi.fn(),
			})),
		});
		vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
			callback(0);
			return 0;
		});
		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			value: "visible",
		});
	});

	it("keeps Deep Research handoff sends visible to the runtime queue adapter", async () => {
		render(Page, { data: pageData() });

		await fireEvent.click(
			screen.getByRole("button", { name: "Deep Research" }),
		);
		await fireEvent.click(
			screen.getByRole("button", { name: "Focused Deep Research" }),
		);
		await fireEvent.input(screen.getByTestId("message-input"), {
			target: { value: "Research battery recycling policy" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "Send message" }));

		await fireEvent.input(screen.getByTestId("message-input"), {
			target: { value: "Follow up after the plan" },
		});
		await fireEvent.click(screen.getByTestId("queue-button"));

		expect(screen.getByTestId("queued-message-banner")).toHaveTextContent(
			"Follow up after the plan",
		);
	});

	it("drains a queued follow-up after polling reconciles a waiting stream completion", async () => {
		let resolveDetail: (
			value: Awaited<ReturnType<typeof fetchConversationDetail>>,
		) => void = () => {};
		vi.mocked(fetchConversationDetail).mockReturnValueOnce(
			new Promise((resolve) => {
				resolveDetail = resolve;
			}),
		);
		render(Page, { data: pageData() });

		await fireEvent.input(screen.getByTestId("message-input"), {
			target: { value: "First turn" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "Send message" }));

		expect(runtimeHarness.streamInvocations).toHaveLength(1);
		runtimeHarness.streamInvocations[0].callbacks.onWaiting?.();

		await fireEvent.input(screen.getByTestId("message-input"), {
			target: { value: "Queued after waiting" },
		});
		await fireEvent.click(screen.getByTestId("queue-button"));

		resolveDetail({
			conversation: { id: "conv-1", title: "Chat", status: "open" },
			messages: [
				{
					id: "server-user-1",
					role: "user",
					content: "First turn",
					timestamp: 1,
				},
				{
					id: "server-assistant-1",
					role: "assistant",
					content: "Done",
					timestamp: 2,
				},
			],
			contextStatus: null,
			contextSources: null,
			activeWorkingSet: [],
			taskState: null,
			generatedFiles: [],
			fileProductionJobs: [],
			deepResearchJobs: [],
		});

		await waitFor(() => {
			expect(runtimeHarness.streamInvocations).toHaveLength(2);
		});
		expect(runtimeHarness.streamInvocations[1].message).toBe(
			"Queued after waiting",
		);
	});

	it("preserves a restored queued draft when background recovery falls back to persisted detail", async () => {
		vi.mocked(fetchConversationDetail).mockResolvedValue({
			conversation: { id: "conv-1", title: "Chat", status: "open" },
			messages: [
				{
					id: "server-user-1",
					role: "user",
					content: "First turn",
					timestamp: 1,
				},
				{
					id: "server-assistant-1",
					role: "assistant",
					content: "Finished while hidden",
					timestamp: 2,
				},
			],
		});
		render(Page, { data: pageData() });

		await fireEvent.input(screen.getByTestId("message-input"), {
			target: { value: "First turn" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "Send message" }));
		await fireEvent.input(screen.getByTestId("message-input"), {
			target: { value: "Queued while hidden" },
		});
		await fireEvent.click(screen.getByTestId("queue-button"));

		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			value: "hidden",
		});
		const abortError = new Error("backgrounded");
		abortError.name = "AbortError";
		runtimeHarness.streamInvocations[0].callbacks.onError(abortError);

		await waitFor(() => {
			expect(screen.getByTestId("message-input")).toHaveValue(
				"Queued while hidden",
			);
		});

		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			value: "visible",
		});
		document.dispatchEvent(new Event("visibilitychange"));

		await waitFor(() => {
			expect(fetchConversationDetail).toHaveBeenCalledWith("conv-1");
		});
		expect(screen.getByTestId("message-input")).toHaveValue(
			"Queued while hidden",
		);
	});

	it("recovers a backgrounded stream on mobile pageshow without requiring reload", async () => {
		vi.mocked(fetchConversationDetail).mockResolvedValue({
			conversation: { id: "conv-1", title: "Chat", status: "open" },
			messages: [
				{
					id: "server-user-1",
					role: "user",
					content: "Mobile leave",
					timestamp: 1,
				},
				{
					id: "server-assistant-1",
					role: "assistant",
					content: "Finished while mobile was away",
					timestamp: 2,
				},
			],
		});
		render(Page, { data: pageData() });

		await fireEvent.input(screen.getByTestId("message-input"), {
			target: { value: "Mobile leave" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "Send message" }));

		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			value: "hidden",
		});
		const abortError = new Error("backgrounded");
		abortError.name = "AbortError";
		runtimeHarness.streamInvocations[0].callbacks.onError(abortError);

		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			value: "visible",
		});
		window.dispatchEvent(
			new PageTransitionEvent("pageshow", { persisted: true }),
		);

		await waitFor(() => {
			expect(fetchConversationDetail).toHaveBeenCalledWith("conv-1");
		});
		await waitFor(() => {
			expect(
				screen.getByText("Finished while mobile was away"),
			).toBeInTheDocument();
		});
	});
});
