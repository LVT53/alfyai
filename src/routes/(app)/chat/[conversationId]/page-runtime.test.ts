import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppShellData } from "$lib/server/services/app-shell";
import type { StreamMetadata } from "$lib/services/streaming";
import type {
	AtlasJobCard,
	ContextDebugEvidenceItem,
	ContextDebugState,
	Conversation,
	ConversationContextStatus,
	ConversationDetail,
	ModelId,
} from "$lib/types";

const runtimeHarness = vi.hoisted(() => ({
	streamInvocations: [] as Array<{
		message: string;
		callbacks: {
			onToken: (chunk: string) => void;
			onWaiting?: () => void;
			onEnd: (fullText: string, metadata?: StreamMetadata) => void;
			onError: (error: Error) => void;
		};
	}>,
	atlasSubmissions: [] as Array<{
		message: string;
		profile: string;
		action: string;
		parentAtlasJobId: string | null | undefined;
	}>,
}));

function conversationFixture(
	id: string,
	overrides: Partial<Conversation> = {},
): Conversation {
	return {
		id,
		title: "Chat",
		projectId: null,
		status: "open",
		sidebarPinned: false,
		sidebarSortOrder: null,
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function conversationContextStatusFixture(
	overrides: Partial<ConversationContextStatus> = {},
): ConversationContextStatus {
	return {
		conversationId: "conv-1",
		userId: "user-1",
		estimatedTokens: 5_000,
		maxContextTokens: 10_000,
		thresholdTokens: 12_000,
		targetTokens: 10_000,
		compactionApplied: false,
		compactionMode: "none",
		routingStage: "deterministic",
		routingConfidence: 100,
		verificationStatus: "skipped",
		layersUsed: [],
		workingSetCount: 0,
		workingSetArtifactIds: [],
		workingSetApplied: false,
		taskStateApplied: false,
		promptArtifactCount: 0,
		recentTurnCount: 0,
		summary: null,
		updatedAt: 1,
		...overrides,
	};
}

function contextDebugEvidenceFixture(
	overrides: Partial<ContextDebugEvidenceItem> = {},
): ContextDebugEvidenceItem {
	return {
		artifactId: "artifact-1",
		name: "Recovered evidence",
		artifactType: "source_document",
		sourceType: "document",
		role: "selected",
		origin: "system",
		confidence: 0.9,
		reason: "polling recovery",
		...overrides,
	};
}

function contextDebugFixture(
	overrides: Partial<ContextDebugState> = {},
): ContextDebugState {
	return {
		activeTaskId: null,
		activeTaskObjective: null,
		taskLocked: false,
		routingStage: "deterministic",
		routingConfidence: 100,
		verificationStatus: "skipped",
		selectedEvidence: [contextDebugEvidenceFixture()],
		selectedEvidenceBySource: [],
		pinnedEvidence: [],
		excludedEvidence: [],
		...overrides,
	};
}

function atlasJobFixture(overrides: Partial<AtlasJobCard> = {}): AtlasJobCard {
	return {
		id: "atlas-job-1",
		conversationId: "conv-1",
		assistantMessageId: "assistant-atlas-1",
		action: "create",
		parentAtlasJobId: null,
		profile: "in-depth",
		title: "Atlas research",
		status: "running",
		stage: "search",
		progress: { percent: 30, stage: "search", details: { queries: [] } },
		sourceCounts: { local: 0, web: 4, accepted: 2, rejected: 1 },
		usage: {
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
			costUsdMicros: 0,
		},
		outputs: {
			fileProductionJobId: null,
			htmlChatGeneratedFileId: "html-file-1",
			pdfChatGeneratedFileId: "pdf-file-1",
			markdownChatGeneratedFileId: "md-file-1",
		},
		error: null,
		createdAt: 1,
		updatedAt: 1,
		completedAt: null,
		...overrides,
	};
}

function appShellDataFixture(
	overrides: Partial<AppShellData> = {},
): AppShellData {
	return {
		user: {
			id: "user-1",
			email: "user@example.com",
			displayName: "User",
			role: "admin",
			avatarId: null,
			profilePicture: null,
			titleLanguage: "auto",
			uiLanguage: "en",
		},
		conversations: Promise.resolve([]),
		projects: Promise.resolve([]),
		maxMessageLength: 12_000,
		composerCommandRegistryEnabled: false,
		atlasAvailability: {
			enabled: true,
			configured: true,
			reasonCode: null,
			reason: null,
		},
		userTheme: "system",
		userModel: "model1",
		systemDefaultModel: "model1",
		userModelPreference: "model1",
		userTitleLanguage: "auto",
		userUiLanguage: "en",
		userPersonality: null,
		userAvatarId: null,
		userSidebarProjectsExpanded: true,
		userSidebarChatsExpanded: true,
		modelNames: { model1: "Model 1" },
		availableModels: [
			{
				id: "model1" as ModelId,
				displayName: "Model 1",
				isThirdParty: false,
				iconAssetId: null,
				iconUrl: null,
			},
		],
		appVersion: Promise.resolve({ compact: "test", full: "test" }),
		...overrides,
	};
}

function conversationDetailFixture(
	overrides: Partial<ConversationDetail> = {},
): ConversationDetail {
	return {
		conversation: conversationFixture("conv-1"),
		messages: [],
		attachedArtifacts: [],
		activeWorkingSet: [],
		contextStatus: null,
		contextSources: null,
		taskState: null,
		contextDebug: null,
		draft: null,
		forkOrigin: null,
		bootstrap: false,
		generatedFiles: [],
		fileProductionJobs: [],
		atlasJobs: [],
		contextCompressionSnapshots: [],
		activeSkillSession: null,
		totalCostUsdMicros: 0,
		totalTokens: 0,
		sidecarPending: false,
		...overrides,
	};
}

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
	deletePreparedConversation: vi.fn(async () => undefined),
	deleteConversationDraft: vi.fn(),
	deleteConversationMessages: vi.fn(),
	endConversationSkillSession: vi.fn(),
	fetchConversationDetail: vi.fn(async () => conversationDetailFixture()),
	fetchMessageEvidence: vi.fn(),
	generateConversationTitle: vi.fn(),
	runConversationContextCompression: vi.fn(),
	startConversationSkillSession: vi.fn(),
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
				submitAtlasTurn: vi.fn(async (payload) => {
					runtimeHarness.atlasSubmissions.push({
						message: payload.message,
						profile: payload.profile,
						action: payload.action,
						parentAtlasJobId: payload.parentAtlasJobId,
					});
					return {
						message: "Atlas is queued.",
						atlasJob: atlasJobFixture({
							id: "atlas-child-1",
							assistantMessageId: "assistant-atlas-child-1",
							action: payload.action,
							parentAtlasJobId: payload.parentAtlasJobId ?? null,
							profile: payload.profile,
							status: "queued",
						}),
					};
				}),
			}),
		),
	};
});

import {
	fetchConversationDetail,
	fetchMessageEvidence,
} from "$lib/client/api/conversations";
import Page from "./+page.svelte";

function pageData(overrides: Record<string, unknown> = {}) {
	return {
		...appShellDataFixture(),
		conversation: conversationFixture("conv-1"),
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
		contextCompressionSnapshots: [],
		activeSkillSession: null,
		atlasJobs: [],
		atlasAvailability: { enabled: true, configured: true, reason: null },
		sidecarPending: false,
		userPersonality: null,
		userModel: "model1" as const,
		availableModels: [
			{
				id: "model1" as ModelId,
				displayName: "Model 1",
				isThirdParty: false,
				iconAssetId: null,
				iconUrl: null,
			},
		],
		maxMessageLength: 12000,
		composerCommandRegistryEnabled: false,
		...overrides,
	};
}

function renderPage(data = pageData()) {
	return render(Page, {
		data,
		params: { conversationId: data.conversation.id },
	});
}

type AnimationFrameTimer = number;

let animationFrameId = 0;
const animationFrameTimers = new Map<number, AnimationFrameTimer>();

function installAnimationFrameMock() {
	animationFrameTimers.clear();
	vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
		const frameId = ++animationFrameId;
		const timerId = window.setTimeout(() => {
			animationFrameTimers.delete(frameId);
			callback(window.performance.now());
		}, 16);
		animationFrameTimers.set(frameId, timerId);
		return frameId;
	});
	vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frameId) => {
		const timerId = animationFrameTimers.get(frameId);
		if (timerId === undefined) return;
		window.clearTimeout(timerId);
		animationFrameTimers.delete(frameId);
	});
}

function clearAnimationFrameMockTimers() {
	for (const timerId of animationFrameTimers.values()) {
		window.clearTimeout(timerId);
	}
	animationFrameTimers.clear();
}

describe("chat page runtime integration", () => {
	afterEach(() => {
		clearAnimationFrameMockTimers();
		vi.restoreAllMocks();
	});

	beforeEach(() => {
		runtimeHarness.streamInvocations.length = 0;
		runtimeHarness.atlasSubmissions.length = 0;
		vi.mocked(fetchConversationDetail).mockResolvedValue(
			conversationDetailFixture(),
		);
		vi.mocked(fetchMessageEvidence).mockReset();
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
		installAnimationFrameMock();
		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			value: "visible",
		});
	});

	it("renders while layout model metadata is still resolving", async () => {
		renderPage(
			pageData({
				availableModels: Promise.resolve([
					{
						id: "model1" as ModelId,
						displayName: "Model 1",
						iconUrl: "/api/campaign-assets/model-1-icon/content",
					},
				]),
			}),
		);

		expect(screen.getByTestId("message-input")).toBeInTheDocument();
	});

	it("keeps normal in-flight sends visible to the runtime queue adapter", async () => {
		renderPage();

		await fireEvent.input(screen.getByTestId("message-input"), {
			target: { value: "Summarize battery recycling policy" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "Send message" }));

		await fireEvent.input(screen.getByTestId("message-input"), {
			target: { value: "Follow up after the summary" },
		});
		await fireEvent.click(screen.getByTestId("queue-button"));

		expect(screen.getByTestId("queued-message-banner")).toHaveTextContent(
			"Follow up after the summary",
		);
	});

	it("polls conversation detail while Atlas jobs are queued or running", async () => {
		vi.useFakeTimers();
		try {
			renderPage(
				pageData({
					messages: [
						{
							id: "assistant-atlas-1",
							role: "assistant",
							content: "Atlas is queued.",
							timestamp: 1,
						},
					],
					atlasJobs: [atlasJobFixture({ status: "running" })],
				}),
			);

			await vi.advanceTimersByTimeAsync(2500);

			expect(fetchConversationDetail).toHaveBeenCalledWith("conv-1");
		} finally {
			vi.useRealTimers();
		}
	});

	it("routes Atlas lifecycle panel submissions through the Atlas send adapter", async () => {
		renderPage(
			pageData({
				messages: [
					{
						id: "assistant-atlas-1",
						role: "assistant",
						content: "Atlas is complete.",
						timestamp: 1,
					},
				],
				atlasJobs: [
					atlasJobFixture({
						status: "succeeded",
						completedAt: 121,
						progress: {
							percent: 100,
							stage: "audit",
							details: { queries: [] },
						},
					}),
				],
			}),
		);

		await fireEvent.click(
			screen.getByRole("button", { name: "Continue Atlas" }),
		);
		const panel = screen.getByRole("region", { name: "Continue Atlas" });
		await fireEvent.input(within(panel).getByRole("textbox"), {
			target: { value: "Extend the report with deployment risks" },
		});
		await fireEvent.click(
			within(panel).getByRole("button", { name: "Continue Atlas" }),
		);

		await waitFor(() => {
			expect(runtimeHarness.atlasSubmissions).toContainEqual({
				message: "Extend the report with deployment risks",
				profile: "in-depth",
				action: "continue",
				parentAtlasJobId: "atlas-job-1",
			});
		});
		expect(runtimeHarness.streamInvocations).toHaveLength(0);
	});

	it("opens completed Atlas HTML reports in expanded document workspace presentation", async () => {
		renderPage(
			pageData({
				messages: [
					{
						id: "assistant-atlas-1",
						role: "assistant",
						content: "Atlas is complete.",
						timestamp: 1,
					},
				],
				atlasJobs: [
					atlasJobFixture({
						status: "succeeded",
						completedAt: 121,
						progress: {
							percent: 100,
							stage: "audit",
							details: { queries: [] },
						},
					}),
				],
			}),
		);

		await fireEvent.click(screen.getByRole("button", { name: "Open" }));

		await waitFor(() => {
			expect(screen.getByTestId("workspace-main")).toHaveAttribute(
				"data-presentation",
				"expanded",
			);
		});
	});

	it("closes an expanded Atlas HTML report instead of leaving it docked in the workspace", async () => {
		renderPage(
			pageData({
				messages: [
					{
						id: "assistant-atlas-1",
						role: "assistant",
						content: "Atlas is complete.",
						timestamp: 1,
					},
				],
				atlasJobs: [
					atlasJobFixture({
						status: "succeeded",
						completedAt: 121,
						progress: {
							percent: 100,
							stage: "audit",
							details: { queries: [] },
						},
					}),
				],
			}),
		);

		await fireEvent.click(screen.getByRole("button", { name: "Open" }));
		await waitFor(() => {
			expect(screen.getByTestId("workspace-main")).toHaveAttribute(
				"data-presentation",
				"expanded",
			);
		});

		await fireEvent.click(
			screen
				.getAllByRole("button", { name: "Close document workspace" })
				.at(-1) ??
				screen.getByRole("button", { name: "Close document workspace" }),
		);

		await waitFor(() => {
			expect(screen.queryByTestId("workspace-main")).not.toBeInTheDocument();
		});
	});

	it("drains a queued follow-up after polling reconciles a waiting stream completion", async () => {
		let resolveDetail: (
			value:
				| Awaited<ReturnType<typeof fetchConversationDetail>>
				| PromiseLike<Awaited<ReturnType<typeof fetchConversationDetail>>>,
		) => void = () => {};
		vi.mocked(fetchConversationDetail).mockReturnValueOnce(
			new Promise((resolve) => {
				resolveDetail = resolve;
			}),
		);
		renderPage();

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
			...conversationDetailFixture(),
			conversation: conversationFixture("conv-1"),
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
		});

		await waitFor(() => {
			expect(runtimeHarness.streamInvocations).toHaveLength(2);
		});
		expect(runtimeHarness.streamInvocations[1].message).toBe(
			"Queued after waiting",
		);
	});

	it("applies full detail metadata when polling recovers a completed stream", async () => {
		let resolveDetail: (
			value:
				| Awaited<ReturnType<typeof fetchConversationDetail>>
				| PromiseLike<Awaited<ReturnType<typeof fetchConversationDetail>>>,
		) => void = () => {};
		vi.mocked(fetchConversationDetail).mockReturnValueOnce(
			new Promise((resolve) => {
				resolveDetail = resolve;
			}),
		);
		renderPage(
			pageData({
				messages: [
					{
						id: "assistant-previous",
						role: "assistant",
						content: "Earlier answer",
						timestamp: 1,
					},
				],
			}),
		);

		await fireEvent.input(screen.getByTestId("message-input"), {
			target: { value: "First turn" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "Send message" }));

		expect(runtimeHarness.streamInvocations).toHaveLength(1);
		runtimeHarness.streamInvocations[0].callbacks.onWaiting?.();

		resolveDetail({
			...conversationDetailFixture(),
			conversation: conversationFixture("conv-1"),
			messages: [
				{
					id: "assistant-previous",
					role: "assistant",
					content: "Earlier answer",
					timestamp: 1,
				},
				{
					id: "server-user-1",
					role: "user",
					content: "First turn",
					timestamp: 2,
				},
				{
					id: "server-assistant-1",
					role: "assistant",
					content: "Done",
					timestamp: 3,
				},
			],
			contextStatus: conversationContextStatusFixture({ recentTurnCount: 2 }),
			contextDebug: contextDebugFixture(),
			contextCompressionSnapshots: [
				{
					id: "snapshot-1",
					trigger: "automatic",
					status: "valid",
					sourceEndMessageId: "assistant-previous",
					createdAt: 1,
					updatedAt: 1,
				},
			],
			totalCostUsdMicros: 420_000,
			totalTokens: 42,
		});

		await waitFor(() => {
			expect(screen.getByText("Done")).toBeInTheDocument();
		});
		await fireEvent.click(
			screen.getByRole("button", { name: /Prompt budget usage/i }),
		);

		expect(screen.getByText("$0.4200 · 42 tokens")).toBeInTheDocument();
		expect(screen.getByText("Selected evidence")).toBeInTheDocument();
		expect(
			screen.getByTestId("context-compression-marker-snapshot-1"),
		).toBeInTheDocument();
	});

	it("applies normal stream completion deltas without hydrating conversation detail", async () => {
		renderPage();

		await fireEvent.input(screen.getByTestId("message-input"), {
			target: { value: "Make a report" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "Send message" }));

		expect(runtimeHarness.streamInvocations).toHaveLength(1);
		runtimeHarness.streamInvocations[0].callbacks.onToken("Created");
		const detailCallsBeforeCompletion = vi.mocked(fetchConversationDetail).mock
			.calls.length;
		runtimeHarness.streamInvocations[0].callbacks.onEnd("Created", {
			userMessageId: "server-user-1",
			assistantMessageId: "assistant-1",
			generatedFiles: [
				{
					id: "file-1",
					conversationId: "conv-1",
					assistantMessageId: "assistant-1",
					artifactId: "artifact-1",
					documentFamilyId: null,
					documentFamilyStatus: null,
					documentLabel: null,
					documentRole: null,
					versionNumber: null,
					originConversationId: null,
					originAssistantMessageId: null,
					sourceChatFileId: null,
					filename: "report.pdf",
					mimeType: "application/pdf",
					sizeBytes: 123,
					createdAt: 1,
				},
			],
			fileProductionJobs: [
				{
					id: "job-1",
					conversationId: "conv-1",
					assistantMessageId: "assistant-1",
					title: "Report",
					status: "succeeded",
					createdAt: 1,
					updatedAt: 2,
					files: [
						{
							id: "file-1",
							filename: "report.pdf",
							mimeType: "application/pdf",
							sizeBytes: 123,
							downloadUrl: "/api/chat/files/file-1/download",
							previewUrl: "/api/chat/files/file-1/preview",
						},
					],
					warnings: [],
				},
			],
			generationDurationMs: 250,
			totalTokenCount: 42,
			totalCostUsdMicros: 420_000,
			totalTokens: 42,
		});

		await waitFor(() => {
			expect(screen.getByText("Created")).toBeInTheDocument();
		});
		await fireEvent.click(
			screen.getByRole("button", { name: "No context yet" }),
		);
		expect(screen.getByText("$0.4200 · 42 tokens")).toBeInTheDocument();
		expect(fetchConversationDetail).toHaveBeenCalledTimes(
			detailCallsBeforeCompletion,
		);
	});

	it("ignores stale first-render sidecar detail after navigating to another conversation", async () => {
		let resolveFirstDetail: (
			value:
				| Awaited<ReturnType<typeof fetchConversationDetail>>
				| PromiseLike<Awaited<ReturnType<typeof fetchConversationDetail>>>,
		) => void = () => {};
		vi.mocked(fetchConversationDetail).mockReturnValueOnce(
			new Promise((resolve) => {
				resolveFirstDetail = resolve;
			}),
		);
		const view = renderPage(pageData({ sidecarPending: true }));
		await waitFor(() => {
			expect(fetchConversationDetail).toHaveBeenCalledWith("conv-1");
		});

		await view.rerender({
			data: pageData({
				conversation: conversationFixture("conv-2", {
					title: "Second chat",
					createdAt: 2,
					updatedAt: 2,
				}),
				sidecarPending: false,
			}),
			params: { conversationId: "conv-2" },
		});
		resolveFirstDetail({
			...conversationDetailFixture(),
			conversation: conversationFixture("conv-1"),
			messages: [
				{
					id: "wrong-assistant",
					role: "assistant",
					content: "Wrong conversation sidecar",
					timestamp: 1,
				},
			],
			totalCostUsdMicros: 990_000,
			totalTokens: 99,
		});

		await Promise.resolve();
		await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(
			screen.queryByText("Wrong conversation sidecar"),
		).not.toBeInTheDocument();
	});

	it("updates cost and token totals from first-render sidecar detail", async () => {
		vi.mocked(fetchConversationDetail).mockResolvedValueOnce({
			...conversationDetailFixture(),
			conversation: conversationFixture("conv-1"),
			messages: [],
			totalCostUsdMicros: 420_000,
			totalTokens: 42,
		});
		renderPage(
			pageData({
				sidecarPending: true,
				totalCostUsdMicros: 0,
				totalTokens: 0,
			}),
		);

		await waitFor(() => {
			expect(fetchConversationDetail).toHaveBeenCalledWith("conv-1");
		});
		await fireEvent.click(
			screen.getByRole("button", { name: "No context yet" }),
		);

		await waitFor(() => {
			expect(screen.getByText("$0.4200 · 42 tokens")).toBeInTheDocument();
		});
	});

	it("does not let a slow same-conversation sidecar overwrite newer stream metadata", async () => {
		let resolveSidecarDetail: (
			value:
				| Awaited<ReturnType<typeof fetchConversationDetail>>
				| PromiseLike<Awaited<ReturnType<typeof fetchConversationDetail>>>,
		) => void = () => {};
		vi.mocked(fetchConversationDetail).mockReturnValueOnce(
			new Promise((resolve) => {
				resolveSidecarDetail = resolve;
			}),
		);
		renderPage(
			pageData({
				sidecarPending: true,
				messages: [
					{
						id: "assistant-1",
						role: "assistant",
						content: "Previous answer",
						timestamp: 1,
					},
				],
			}),
		);
		await waitFor(() => {
			expect(fetchConversationDetail).toHaveBeenCalledWith("conv-1");
		});

		await fireEvent.input(screen.getByTestId("message-input"), {
			target: { value: "Make a report" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "Send message" }));

		expect(runtimeHarness.streamInvocations).toHaveLength(1);
		runtimeHarness.streamInvocations[0].callbacks.onEnd("Created", {
			userMessageId: "server-user-1",
			assistantMessageId: "assistant-2",
			generatedFiles: [
				{
					id: "file-1",
					conversationId: "conv-1",
					assistantMessageId: "assistant-2",
					artifactId: "artifact-1",
					documentFamilyId: null,
					documentFamilyStatus: null,
					documentLabel: null,
					documentRole: null,
					versionNumber: null,
					originConversationId: null,
					originAssistantMessageId: null,
					sourceChatFileId: null,
					filename: "report.pdf",
					mimeType: "application/pdf",
					sizeBytes: 123,
					createdAt: 1,
				},
			],
			fileProductionJobs: [
				{
					id: "job-1",
					conversationId: "conv-1",
					assistantMessageId: "assistant-2",
					title: "Report",
					status: "succeeded",
					createdAt: 1,
					updatedAt: 2,
					files: [
						{
							id: "file-1",
							filename: "report.pdf",
							mimeType: "application/pdf",
							sizeBytes: 123,
							downloadUrl: "/api/chat/files/file-1/download",
							previewUrl: "/api/chat/files/file-1/preview",
						},
					],
					warnings: [],
				},
			],
			contextCompressionSnapshots: [
				{
					id: "snapshot-1",
					trigger: "manual",
					status: "valid",
					sourceEndMessageId: "assistant-1",
					createdAt: 1,
					updatedAt: 1,
				},
			],
			totalCostUsdMicros: 420_000,
			totalTokens: 42,
		});

		await waitFor(() => {
			expect(screen.getByText("report.pdf")).toBeInTheDocument();
		});
		await fireEvent.click(
			screen.getByRole("button", { name: "No context yet" }),
		);
		expect(screen.getByText("$0.4200 · 42 tokens")).toBeInTheDocument();
		expect(
			screen.getByTestId("context-compression-marker-snapshot-1"),
		).toBeInTheDocument();

		resolveSidecarDetail({
			...conversationDetailFixture(),
			conversation: conversationFixture("conv-1"),
			messages: [
				{
					id: "assistant-1",
					role: "assistant",
					content: "Previous answer",
					timestamp: 1,
				},
			],
			generatedFiles: [],
			fileProductionJobs: [],
			contextCompressionSnapshots: [],
			totalCostUsdMicros: 10_000,
			totalTokens: 1,
		});
		await Promise.resolve();
		await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(screen.getByText("report.pdf")).toBeInTheDocument();
		expect(screen.getByText("$0.4200 · 42 tokens")).toBeInTheDocument();
		expect(
			screen.getByTestId("context-compression-marker-snapshot-1"),
		).toBeInTheDocument();
	});

	it("preserves a restored queued draft when background recovery falls back to persisted detail", async () => {
		vi.mocked(fetchConversationDetail).mockResolvedValue({
			...conversationDetailFixture(),
			conversation: conversationFixture("conv-1"),
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
		renderPage();

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

	it("applies full detail metadata when persisted recovery loads a completed stream", async () => {
		vi.mocked(fetchConversationDetail).mockResolvedValue({
			...conversationDetailFixture(),
			conversation: conversationFixture("conv-1"),
			messages: [
				{
					id: "assistant-previous",
					role: "assistant",
					content: "Earlier answer",
					timestamp: 1,
				},
				{
					id: "server-user-1",
					role: "user",
					content: "Background turn",
					timestamp: 2,
				},
				{
					id: "server-assistant-1",
					role: "assistant",
					content: "Finished while hidden",
					timestamp: 3,
				},
			],
			contextStatus: conversationContextStatusFixture({ recentTurnCount: 2 }),
			contextDebug: contextDebugFixture({
				selectedEvidence: [
					contextDebugEvidenceFixture({ reason: "persisted recovery" }),
				],
			}),
			contextCompressionSnapshots: [
				{
					id: "snapshot-1",
					trigger: "automatic",
					status: "valid",
					sourceEndMessageId: "assistant-previous",
					createdAt: 1,
					updatedAt: 1,
				},
			],
			totalCostUsdMicros: 420_000,
			totalTokens: 42,
		});
		renderPage(
			pageData({
				messages: [
					{
						id: "assistant-previous",
						role: "assistant",
						content: "Earlier answer",
						timestamp: 1,
					},
				],
			}),
		);

		await fireEvent.input(screen.getByTestId("message-input"), {
			target: { value: "Background turn" },
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
		document.dispatchEvent(new Event("visibilitychange"));

		await waitFor(() => {
			expect(screen.getByText("Finished while hidden")).toBeInTheDocument();
		});
		await fireEvent.click(
			screen.getByRole("button", { name: /Prompt budget usage/i }),
		);

		expect(screen.getByText("$0.4200 · 42 tokens")).toBeInTheDocument();
		expect(screen.getByText("Selected evidence")).toBeInTheDocument();
		expect(
			screen.getByTestId("context-compression-marker-snapshot-1"),
		).toBeInTheDocument();
	});

	it("keeps polling pending assistant evidence until it becomes ready", async () => {
		vi.useFakeTimers();
		try {
			vi.mocked(fetchMessageEvidence)
				.mockResolvedValueOnce({ status: "pending" })
				.mockResolvedValueOnce({ status: "pending" })
				.mockResolvedValueOnce({ status: "pending" })
				.mockResolvedValueOnce({ status: "pending" })
				.mockResolvedValueOnce({ status: "pending" })
				.mockResolvedValueOnce({ status: "pending" })
				.mockResolvedValueOnce({ status: "pending" })
				.mockResolvedValueOnce({ status: "pending" })
				.mockResolvedValueOnce({ status: "pending" })
				.mockResolvedValueOnce({ status: "pending" })
				.mockResolvedValueOnce({ status: "pending" })
				.mockResolvedValueOnce({ status: "pending" })
				.mockResolvedValueOnce({
					status: "ready",
					evidenceSummary: {
						structuredWebSearch: false,
						groups: [
							{
								sourceType: "document",
								label: "Documents",
								reranked: false,
								items: [
									{
										id: "evidence-1",
										title: "Recovered evidence",
										sourceType: "document",
										status: "selected",
									},
								],
							},
						],
					},
				});

			renderPage(
				pageData({
					messages: [
						{
							id: "assistant-evidence-pending",
							role: "assistant",
							content: "Completed answer.",
							timestamp: 1,
							evidencePending: true,
						},
					],
				}),
			);

			expect(screen.getByText("Evidence is loading…")).toBeInTheDocument();

			await vi.advanceTimersByTimeAsync(5_250);
			await Promise.resolve();

			expect(fetchMessageEvidence).toHaveBeenCalledTimes(12);
			expect(screen.getByText("Evidence is loading…")).toBeInTheDocument();

			await vi.advanceTimersByTimeAsync(1_000);

			await waitFor(() => {
				expect(
					screen.getByRole("button", { name: /Evidence/i }),
				).toBeInTheDocument();
			});
			expect(
				screen.queryByText("Evidence is loading…"),
			).not.toBeInTheDocument();
			expect(fetchMessageEvidence).toHaveBeenCalledTimes(13);
		} finally {
			vi.useRealTimers();
		}
	});

	it("recovers a backgrounded stream on mobile pageshow without requiring reload", async () => {
		vi.mocked(fetchConversationDetail).mockResolvedValue({
			...conversationDetailFixture(),
			conversation: conversationFixture("conv-1"),
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
		renderPage();

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
