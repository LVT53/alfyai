import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatTurnCheck } from "$lib/client/api/chat-turn";
import type { ModelId } from "$lib/model-types";
import type { AppShellData } from "$lib/server/services/app-shell";
import type { AtlasJobCard } from "$lib/server/services/atlas/public-types";
import type { ConversationDetail } from "$lib/server/services/conversation-detail/types";
import type { Conversation } from "$lib/server/services/conversations";
import type { FileProductionJob } from "$lib/server/services/file-production/types";
import type {
	ContextDebugEvidenceItem,
	ContextDebugState,
	ConversationContextStatus,
} from "$lib/server/services/knowledge/context-types";
import type { ChatMessage } from "$lib/server/services/messages-types";
import type {
	StreamCallbacks,
	StreamChatOptions,
} from "$lib/services/streaming";
import { FORKED_SOURCE_HISTORY_CONFIRMATION_REQUIRED_CODE } from "./lifecycle-guards";

const runtimeHarness = vi.hoisted(() => ({
	streamInvocations: [] as Array<{
		message: string;
		callbacks: StreamCallbacks;
		// "Answer now" (owner idea) — the reasoningDepth override and the
		// per-invocation stop() spy, so integration tests can assert both
		// "the current stream was interrupted" and "the retry carried the
		// quick override" without reaching into module internals.
		options?: StreamChatOptions;
		handle?: {
			stop: ReturnType<typeof vi.fn>;
			detach: ReturnType<typeof vi.fn>;
		};
	}>,
	atlasSubmissions: [] as Array<{
		message: string;
		profile: string;
		action: string;
		parentAtlasJobId: string | null | undefined;
	}>,
	/** When set, Atlas submissions fail with it. */
	atlasFailure: null as Error | null,
	/** The stream the server is still running for the chat, when a test says it is: what a page that lost its connection finds when it looks for the turn. */
	orphanedStreamId: null as string | null,
	/** When set, the page finds a stream the server is still running for this chat and reconnects to it. */
	orphanedStream: null as { streamId: string; userMessage: string } | null,
	/** What the page handed the runtime, for the tests that speak to the page the way the runtime does. */
	adapters: null as {
		restorePayloadToDraft: (payload: {
			message: string;
			attachmentIds: string[];
			attachments: unknown[];
			pendingAttachments: unknown[];
			conversationId?: string | null;
		}) => void;
		hydrateConversationDetail: () => void;
	} | null,
}));

// Issue 7.4 fix pass — the cloud-warning gate (check + modal) now lives at
// the page level (+page.svelte's ensureCloudWarningAcked), so the full
// check/modal/ack/cancel scenarios — including regenerate/edit/retry, which
// never touched MessageInput's now-removed local gate at all — are exercised
// here against the real page rather than in MessageInput.test.ts.
const fetchActiveCapabilitiesMock = vi.hoisted(() => vi.fn());
// The turn's gate, asked before an edit deletes anything: it takes the message
// unless a test says otherwise (reset after every test, below).
const checkChatTurnMock = vi.hoisted(() =>
	vi.fn(
		async (
			_request: import("$lib/client/api/chat-turn").ChatTurnCheckRequest,
		): Promise<import("$lib/client/api/chat-turn").ChatTurnCheck> => ({
			ok: true,
		}),
	),
);
const checkCloudWarningMock = vi.hoisted(() => vi.fn());
const ackCloudConnectorMock = vi.hoisted(() => vi.fn());
const setLocalDistillMock = vi.hoisted(() => vi.fn());

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
		promptTokens: 5_000,
		promptTokensSource: "estimated",
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
			profilePicture: null,
			titleLanguage: "auto",
			uiLanguage: "en",
		},
		conversations: Promise.resolve([]),
		projects: Promise.resolve([]),
		maxMessageLength: 12_000,
		maxFileUploadSize: 104_857_600,
		disabledFileTypeIds: [],
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
		taskState: null,
		contextDebug: null,
		draft: null,
		forkOrigin: null,
		bootstrap: false,
		generatedFiles: [],
		fileProductionJobs: [],
		atlasJobs: [],
		contextCompressionSnapshots: [],
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
	pushState: vi.fn(),
	replaceState: vi.fn(),
}));

vi.mock("$lib/client/api/admin", () => ({
	fetchPublicPersonalityProfiles: vi.fn(async () => []),
}));

vi.mock("$lib/client/api/conversations", () => ({
	createConversationFork: vi.fn(),
	deleteConversation: vi.fn(),
	deletePreparedConversation: vi.fn(async () => undefined),
	deleteConversationDraft: vi.fn(),
	deleteConversationMessages: vi.fn(),
	persistConversationDraft: vi.fn(async () => undefined),
	fetchConversationDetail: vi.fn(async () => conversationDetailFixture()),
	fetchMessageEvidence: vi.fn(),
	generateConversationTitle: vi.fn(),
	renameConversation: vi.fn(async () => ({})),
	runConversationContextCompression: vi.fn(),
}));

vi.mock("$lib/client/api/file-production", async (importOriginal) => ({
	// The real existence check (a ranged read through the test's own fetch),
	// the rest stubbed.
	chatFileStillExists: (
		await importOriginal<typeof import("$lib/client/api/file-production")>()
	).chatFileStillExists,
	cancelFileProductionJob: vi.fn(),
	regenerateFileProductionJob: vi.fn(),
	retryFileProductionJob: vi.fn(),
}));

vi.mock("$lib/client/api/knowledge", () => ({
	recordDocumentWorkspaceOpen: vi.fn(),
	uploadKnowledgeAttachment: vi.fn(),
	// The real page mounts the composer, whose poller defaults to the status
	// call. Empty status keeps a mounted composer from reaching a real fetch.
	fetchExtractionStatus: vi.fn(async () => ({ jobs: [], readiness: [] })),
}));

vi.mock("$lib/client/api/skills", () => ({
	dismissSkillDraft: vi.fn(),
	publishSkillDraft: vi.fn(),
	saveSkillDraft: vi.fn(),
}));

vi.mock("$lib/client/api/connection-writes", () => ({
	cancelWrite: vi.fn(),
	confirmWrite: vi.fn(),
	fetchConversationPendingWrites: vi.fn(async () => []),
}));

vi.mock("$lib/client/api/chat-turn", () => ({
	checkChatTurn: checkChatTurnMock,
}));

vi.mock("$lib/client/api/connections", () => ({
	fetchActiveCapabilities: fetchActiveCapabilitiesMock,
	checkCloudWarning: checkCloudWarningMock,
	ackCloudConnector: ackCloudConnectorMock,
	setLocalDistill: setLocalDistillMock,
}));

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

vi.mock("$lib/client/normal-chat-client-turn-runtime", async () => {
	type RuntimeModule =
		typeof import("$lib/client/normal-chat-client-turn-runtime");
	const actual = await vi.importActual<RuntimeModule>(
		"$lib/client/normal-chat-client-turn-runtime",
	);
	return {
		...actual,
		createBrowserNormalChatClientTurnRuntime: vi.fn((adapters) => {
			runtimeHarness.adapters = adapters;
			return actual.createNormalChatClientTurnRuntime({
				...adapters,
				streamChat: vi.fn((message, _conversationId, callbacks, options) => {
					const handle = { stop: vi.fn(), detach: vi.fn() };
					runtimeHarness.streamInvocations.push({
						message,
						callbacks,
						options,
						handle,
					});
					return handle;
				}),
				checkForOrphanedStream: vi.fn(
					async () =>
						runtimeHarness.orphanedStream?.streamId ??
						runtimeHarness.orphanedStreamId,
				),
				getStreamBufferInfo: vi.fn(async () =>
					runtimeHarness.orphanedStream
						? {
								userMessage: runtimeHarness.orphanedStream.userMessage,
								reasoningDepth: "thorough" as const,
								createdAt: Date.now(),
							}
						: null,
				),
				submitAtlasTurn: vi.fn(async (payload) => {
					runtimeHarness.atlasSubmissions.push({
						message: payload.message,
						profile: payload.profile,
						action: payload.action,
						parentAtlasJobId: payload.parentAtlasJobId,
					});
					if (runtimeHarness.atlasFailure) throw runtimeHarness.atlasFailure;
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
			});
		}),
	};
});

// A page that goes away with a turn running starts this, and every test ends by
// taking its page away: the real one would poll into the tests after it.
vi.mock("$lib/stores/conversations", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/stores/conversations")>()),
	watchConversationTitle: vi.fn(),
}));

import { goto } from "$app/navigation";
import { fetchConversationPendingWrites } from "$lib/client/api/connection-writes";
import {
	deleteConversationDraft,
	deleteConversationMessages,
	fetchConversationDetail,
	fetchMessageEvidence,
	generateConversationTitle,
	persistConversationDraft,
} from "$lib/client/api/conversations";
import { ApiError } from "$lib/client/api/http";
import {
	conversations as conversationsStore,
	renameConversation,
	watchConversationTitle,
} from "$lib/stores/conversations";
import Page from "./+page.svelte";

// Every test starts with a gate that takes the message, whatever the one before it said.
afterEach(() => {
	checkChatTurnMock.mockReset();
	runtimeHarness.orphanedStreamId = null;
});

/** The open panel's landmark is named for the item it shows ("Vienna trip plan, Document"; review 276-279), so it is found by that shape. */
const WORKSPACE_LANDMARK = /, (Document|App|Canvas|Slides|File)$/;

function pageData(overrides: Record<string, unknown> = {}) {
	return {
		...appShellDataFixture(),
		conversation: conversationFixture("conv-1"),
		messages: [],
		hasMoreMessages: false,
		contextStatus: null,
		totalCostUsdMicros: 0,
		totalTokens: 0,
		attachedArtifacts: [],
		activeWorkingSet: [],
		taskState: null,
		contextDebug: null,
		draft: null,
		forkOrigin: null,
		bootstrap: false,
		generatedFiles: [],
		fileProductionJobs: [],
		artifacts: [],
		imageCards: [],
		deletedArtifactIds: [] as string[],
		unreachableArtifactIds: [] as string[],
		pendingWrites: [],
		contextCompressionSnapshots: [],
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
		runtimeHarness.atlasFailure = null;
		runtimeHarness.orphanedStream = null;
		vi.restoreAllMocks();
	});

	beforeEach(() => {
		runtimeHarness.streamInvocations.length = 0;
		runtimeHarness.atlasSubmissions.length = 0;
		vi.mocked(fetchConversationDetail).mockResolvedValue(
			conversationDetailFixture(),
		);
		vi.mocked(fetchMessageEvidence).mockReset();
		fetchActiveCapabilitiesMock.mockReset().mockResolvedValue({
			served: [],
			defaultOn: [],
			accounts: [],
		});
		checkCloudWarningMock.mockReset();
		ackCloudConnectorMock.mockReset();
		setLocalDistillMock.mockReset();
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

	it("hides Stop after the finish part while keeping finalizing and queued follow-up behavior", async () => {
		renderPage();

		await fireEvent.input(screen.getByTestId("message-input"), {
			target: { value: "Summarize the report" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "Send message" }));

		expect(runtimeHarness.streamInvocations).toHaveLength(1);
		runtimeHarness.streamInvocations[0].callbacks.onToken("Draft answer");
		runtimeHarness.streamInvocations[0].callbacks.onFinishPart?.({
			type: "finish",
			finishReason: "stop",
		});

		await waitFor(() => {
			expect(screen.getByText("Finalizing response...")).toBeInTheDocument();
		});
		expect(
			screen.queryByRole("button", { name: "Stop" }),
		).not.toBeInTheDocument();

		await fireEvent.input(screen.getByTestId("message-input"), {
			target: { value: "Follow up while finalizing" },
		});
		await fireEvent.click(screen.getByTestId("queue-button"));

		expect(screen.getByTestId("queued-message-banner")).toHaveTextContent(
			"Follow up while finalizing",
		);

		runtimeHarness.streamInvocations[0].callbacks.onEnd("Draft answer", {
			assistantMessageId: "assistant-1",
		});

		await waitFor(() => {
			expect(runtimeHarness.streamInvocations).toHaveLength(2);
		});
		expect(runtimeHarness.streamInvocations[1].message).toBe(
			"Follow up while finalizing",
		);
	});

	// Owner idea — "Answer now" clicks the ThinkingBlock header's quick-answer
	// button while a turn is still reasoning: it must interrupt the CURRENT
	// stream first (the same stop() the Stop button uses), wait for that to
	// actually settle, and only then resend the same user message with
	// reasoningDepth "quick" for that one turn — never touching the user's
	// own depth toggle for later turns.
	it('"Answer now" stops the current stream, then regenerates in quick mode', async () => {
		renderPage();

		await fireEvent.input(screen.getByTestId("message-input"), {
			target: { value: "Explain the tradeoffs" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "Send message" }));

		expect(runtimeHarness.streamInvocations).toHaveLength(1);
		const firstInvocation = runtimeHarness.streamInvocations[0];
		// Live reasoning, no visible answer yet — the state the header's
		// "Answer now" button is scoped to.
		firstInvocation.callbacks.onThinking("Weighing a few different angles.");

		const answerNowButton = await screen.findByRole("button", {
			name: "Answer now",
		});
		await fireEvent.click(answerNowButton);

		// The current stream was interrupted the same way Stop would.
		expect(firstInvocation.handle?.stop).toHaveBeenCalledTimes(1);

		// Mirrors the real transport's abort handling (streaming.ts): once the
		// aborted fetch's reader settles, onEnd fires with wasStopped: true.
		firstInvocation.callbacks.onEnd("", { wasStopped: true });

		await waitFor(() => {
			expect(runtimeHarness.streamInvocations).toHaveLength(2);
		});
		const retryInvocation = runtimeHarness.streamInvocations[1];
		expect(retryInvocation.message).toBe("Explain the tradeoffs");
		expect(retryInvocation.options?.reasoningDepth).toBe("quick");
	});

	// The streaming assistant message is keyed by a CLIENT placeholder id
	// until the terminal frame arrives; a stopped turn is persisted server
	// side and its terminal frame carries the real assistantMessageId, which
	// finalizeStreamingMessageList swaps in. "Answer now" captured the
	// placeholder id at click time, so the regenerate has to re-resolve the
	// message after the stop settles or it silently finds nothing.
	it('"Answer now" still regenerates when the stopped turn reports its server message id', async () => {
		renderPage();

		await fireEvent.input(screen.getByTestId("message-input"), {
			target: { value: "Explain the tradeoffs" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "Send message" }));

		const firstInvocation = runtimeHarness.streamInvocations[0];
		firstInvocation.callbacks.onThinking("Weighing a few different angles.");

		await fireEvent.click(
			await screen.findByRole("button", { name: "Answer now" }),
		);
		expect(firstInvocation.handle?.stop).toHaveBeenCalledTimes(1);

		firstInvocation.callbacks.onEnd("", {
			wasStopped: true,
			assistantMessageId: "assistant-stopped-1",
			userMessageId: "user-1",
		});

		await waitFor(() => {
			expect(runtimeHarness.streamInvocations).toHaveLength(2);
		});
		const retryInvocation = runtimeHarness.streamInvocations[1];
		expect(retryInvocation.message).toBe("Explain the tradeoffs");
		expect(retryInvocation.options?.reasoningDepth).toBe("quick");
		expect(retryInvocation.options?.retryAssistantMessageId).toBe(
			"assistant-stopped-1",
		);
		expect(retryInvocation.options?.retryUserMessageId).toBe("user-1");
	});

	it('a second "Answer now" click while the stop is in flight does not double-send', async () => {
		renderPage();

		await fireEvent.input(screen.getByTestId("message-input"), {
			target: { value: "Explain the tradeoffs" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "Send message" }));

		const firstInvocation = runtimeHarness.streamInvocations[0];
		firstInvocation.callbacks.onThinking("Weighing a few different angles.");

		const answerNowButton = await screen.findByRole("button", {
			name: "Answer now",
		});
		await fireEvent.click(answerNowButton);
		await fireEvent.click(answerNowButton);

		firstInvocation.callbacks.onEnd("", { wasStopped: true });

		await waitFor(() => {
			expect(runtimeHarness.streamInvocations).toHaveLength(2);
		});
		// Give the second click's own idle wait time to resolve and (wrongly)
		// dispatch a third stream before asserting there is none.
		await new Promise((resolve) => setTimeout(resolve, 120));
		expect(runtimeHarness.streamInvocations).toHaveLength(2);
	});

	// Reviewer report — `/new` fired mid-turn navigated away with the stream
	// still running. It must interrupt the turn through the same stop path the
	// Stop button uses and only navigate once that abort has actually settled.
	it("/new stops an in-flight turn before navigating away", async () => {
		renderPage(pageData({ composerCommandRegistryEnabled: true }));
		const gotoMock = vi.mocked(goto);
		gotoMock.mockClear();

		const input = screen.getByTestId("message-input");
		await fireEvent.input(input, {
			target: { value: "Explain the tradeoffs" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "Send message" }));

		expect(runtimeHarness.streamInvocations).toHaveLength(1);
		const firstInvocation = runtimeHarness.streamInvocations[0];
		firstInvocation.callbacks.onThinking("Weighing a few different angles.");

		await fireEvent.input(input, { target: { value: "/new" } });
		await fireEvent.keyDown(input, { key: "Enter", shiftKey: false });

		expect(firstInvocation.handle?.stop).toHaveBeenCalledTimes(1);
		// Still streaming: the navigation waits for the stop to settle.
		expect(gotoMock).not.toHaveBeenCalled();

		firstInvocation.callbacks.onEnd("", { wasStopped: true });

		await waitFor(() => {
			expect(gotoMock).toHaveBeenCalledWith("/");
		});
	});

	// Owner idea (variant A) — clicking a follow-up chip on the latest
	// assistant message sends its text as the next user message through the
	// normal send path.
	it("clicking a follow-up chip sends its text as the next user message", async () => {
		renderPage();

		await fireEvent.input(screen.getByTestId("message-input"), {
			target: { value: "What is the plan?" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "Send message" }));

		expect(runtimeHarness.streamInvocations).toHaveLength(1);
		const firstInvocation = runtimeHarness.streamInvocations[0];
		firstInvocation.callbacks.onToken("Here is the plan.");
		firstInvocation.callbacks.onEnd("Here is the plan.", {
			assistantMessageId: "assistant-1",
			followUps: ["List the risks in a table", "Compare the two alternatives"],
		});

		// A chip is the user's next message: the button is named for what a tap
		// does, and the text that goes out is the chip's own.
		const chip = await screen.findByRole("button", {
			name: "Send: List the risks in a table",
		});
		await fireEvent.click(chip);

		await waitFor(() => {
			expect(runtimeHarness.streamInvocations).toHaveLength(2);
		});
		expect(runtimeHarness.streamInvocations[1].message).toBe(
			"List the risks in a table",
		);
	});

	// The server keeps nothing of a turn that fails (it saves the message with the
	// reply, at the end), so after one the page's list ends in a message the server
	// does not have. Retry sends that message again and touches nothing above it:
	// it used to take the last reply of the list, an earlier turn's, as its target.
	describe("Retry after a message that failed", () => {
		const earlierTurn = [
			{
				id: "user-1",
				role: "user" as const,
				content: "What is the plan?",
				timestamp: 1,
			},
			{
				id: "assistant-1",
				role: "assistant" as const,
				content: "The plan is to rest.",
				timestamp: 2,
			},
		];

		it("keeps the earlier reply and sends the message again with its file, and the bubble takes the server's id", async () => {
			const { uploadKnowledgeAttachment } = await import(
				"$lib/client/api/knowledge"
			);
			vi.mocked(uploadKnowledgeAttachment).mockResolvedValueOnce({
				artifact: {
					id: "artifact-retry-1",
					type: "source_document",
					retrievalClass: "durable",
					name: "notes.pdf",
					mimeType: "application/pdf",
					sizeBytes: 12,
					conversationId: "conv-1",
					summary: null,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
				normalizedArtifact: null,
				reusedExistingArtifact: false,
				promptReady: true,
				promptArtifactId: "normalized-retry-1",
				readinessError: null,
				extraction: {
					id: "extraction-retry-1",
					sourceArtifactId: "artifact-retry-1",
					normalizedArtifactId: "normalized-retry-1",
					status: "succeeded",
					intakeRoute: "mineru",
					fileName: "notes.pdf",
					attemptCount: 1,
					maxAttempts: 3,
					retryable: false,
					cancelable: false,
					error: null,
					createdAt: Date.now(),
					updatedAt: Date.now(),
					startedAt: Date.now(),
					legacy: false,
				},
			});
			renderPage(pageData({ messages: earlierTurn }));
			const composer = screen.getByTestId("message-input");
			await fireEvent.input(composer, {
				target: { value: "And what about tomorrow?" },
			});
			await fireEvent.change(
				document.querySelector('input[type="file"]') as HTMLInputElement,
				{
					target: {
						files: [new File(["x"], "notes.pdf", { type: "application/pdf" })],
					},
				},
			);
			await screen.findByTestId("composer-chip-attachment");
			await fireEvent.click(
				screen.getByRole("button", { name: "Send message" }),
			);
			await waitFor(() => {
				expect(runtimeHarness.streamInvocations).toHaveLength(1);
			});
			expect(
				runtimeHarness.streamInvocations[0].options?.attachmentIds,
			).toEqual(["artifact-retry-1"]);

			runtimeHarness.streamInvocations[0].callbacks.onError(new Error("boom"));
			// Words typed since the failure are the next message's: Retry leaves them.
			await fireEvent.input(composer, {
				target: { value: "a thought for later" },
			});
			await fireEvent.click(
				await screen.findByRole("button", { name: "Retry" }),
			);

			await waitFor(() => {
				expect(runtimeHarness.streamInvocations).toHaveLength(2);
			});
			const retried = runtimeHarness.streamInvocations[1];
			expect(retried.message).toBe("And what about tomorrow?");
			expect(retried.options?.attachmentIds).toEqual(["artifact-retry-1"]);
			// A message to the stream, not a regenerate of the turn before.
			expect(retried.options?.retryAssistantMessageId).toBeUndefined();
			expect(screen.getByText("The plan is to rest.")).toBeInTheDocument();
			expect(screen.getAllByTestId("user-message")).toHaveLength(2);
			expect(composer).toHaveValue("a thought for later");

			retried.callbacks.onToken("Tomorrow is free.");
			retried.callbacks.onEnd("Tomorrow is free.", {
				assistantMessageId: "assistant-2",
				userMessageId: "user-2",
			});
			// The bubble that was on screen, now under the server's id: one bubble,
			// and the pencil and later edits find the message the server has.
			await waitFor(() => {
				expect(
					document.querySelector('[data-message-id="user-2"]'),
				).not.toBeNull();
			});
			expect(screen.getAllByTestId("user-message")).toHaveLength(2);
			expect(await screen.findByText("Tomorrow is free.")).toBeInTheDocument();
			expect(screen.getByText("The plan is to rest.")).toBeInTheDocument();
			// Nothing was sent a third time, and the words typed since the failure
			// are still in the composer.
			expect(runtimeHarness.streamInvocations).toHaveLength(2);
			expect(composer).toHaveValue("a thought for later");
		});

		it("aims a failed regenerate's Retry at the reply it was regenerating", async () => {
			renderPage(
				pageData({
					messages: [
						...earlierTurn,
						{
							id: "user-2",
							role: "user" as const,
							content: "And tomorrow?",
							timestamp: 3,
						},
						{
							id: "assistant-2",
							role: "assistant" as const,
							content: "Tomorrow is busy.",
							timestamp: 4,
						},
					],
				}),
			);
			await fireEvent.click(
				screen.getAllByRole("button", { name: "Regenerate response" })[1],
			);
			await waitFor(() => {
				expect(runtimeHarness.streamInvocations).toHaveLength(1);
			});
			expect(runtimeHarness.streamInvocations[0].options).toMatchObject({
				retryAssistantMessageId: "assistant-2",
				retryUserMessageId: "user-2",
			});

			runtimeHarness.streamInvocations[0].callbacks.onError(new Error("boom"));
			await fireEvent.click(
				await screen.findByRole("button", { name: "Retry" }),
			);

			await waitFor(() => {
				expect(runtimeHarness.streamInvocations).toHaveLength(2);
			});
			expect(runtimeHarness.streamInvocations[1].message).toBe("And tomorrow?");
			expect(runtimeHarness.streamInvocations[1].options).toMatchObject({
				retryAssistantMessageId: "assistant-2",
				retryUserMessageId: "user-2",
				retryOrigin: "error_retry",
			});
			// The turn before keeps its reply.
			expect(screen.getByText("The plan is to rest.")).toBeInTheDocument();
			expect(screen.getAllByTestId("user-message")).toHaveLength(2);
		});

		const askedWords = "And what about tomorrow?";

		/** A send that failed in the page: the stream ended in an error, so the bubble stands with the error and a Retry. */
		async function failASend() {
			renderPage(pageData({ messages: earlierTurn }));
			const composer = screen.getByTestId("message-input");
			await fireEvent.input(composer, { target: { value: askedWords } });
			await fireEvent.click(
				screen.getByRole("button", { name: "Send message" }),
			);
			await waitFor(() => {
				expect(runtimeHarness.streamInvocations).toHaveLength(1);
			});
			runtimeHarness.streamInvocations[0].callbacks.onError(new Error("boom"));
			return await screen.findByRole("button", { name: "Retry" });
		}

		// A dropped connection does not end the turn: the server keeps running it and
		// can save the message and its reply while the page shows an error and a Retry.
		// Retry asks the server what it holds before it sends anything.
		describe("when the server may have finished the turn", () => {
			const serverUser = {
				id: "user-2",
				role: "user" as const,
				content: askedWords,
				timestamp: 3,
			};
			const serverReply = {
				id: "assistant-2",
				role: "assistant" as const,
				content: "Tomorrow is free.",
				timestamp: 4,
			};

			it("loads the turn and sends nothing when the server answered it", async () => {
				const retryButton = await failASend();
				vi.mocked(fetchConversationDetail).mockResolvedValue(
					conversationDetailFixture({
						messages: [...earlierTurn, serverUser, serverReply],
					}),
				);
				await fireEvent.click(retryButton);

				expect(
					await screen.findByText("Tomorrow is free."),
				).toBeInTheDocument();
				// Nothing was sent a second time, the error is gone, and nothing is left
				// to retry; every message is on the page once.
				expect(runtimeHarness.streamInvocations).toHaveLength(1);
				expect(screen.queryByRole("alert")).not.toBeInTheDocument();
				expect(
					screen.queryByRole("button", { name: "Retry" }),
				).not.toBeInTheDocument();
				expect(screen.getAllByTestId("user-message")).toHaveLength(2);
			});

			it("sends a message the server holds without a reply as a retry of it, not a second copy", async () => {
				const retryButton = await failASend();
				vi.mocked(fetchConversationDetail).mockResolvedValue(
					conversationDetailFixture({
						messages: [...earlierTurn, serverUser],
					}),
				);
				await fireEvent.click(retryButton);

				await waitFor(() => {
					expect(runtimeHarness.streamInvocations).toHaveLength(2);
				});
				const retried = runtimeHarness.streamInvocations[1];
				expect(retried.message).toBe(askedWords);
				// The retry route, naming the message the server holds; the reply it names
				// is the new placeholder's, which no reply of the chat has.
				expect(retried.options?.retryUserMessageId).toBe("user-2");
				expect(retried.options?.retryAssistantMessageId).toEqual(
					expect.any(String),
				);
				expect(retried.options?.retryAssistantMessageId).not.toBe(
					"assistant-1",
				);
				expect(retried.options?.retryOrigin).toBe("error_retry");
				// The turn before keeps its reply.
				expect(screen.getByText("The plan is to rest.")).toBeInTheDocument();
			});

			it("sends the message as it always did when the server cannot be read", async () => {
				const retryButton = await failASend();
				vi.mocked(fetchConversationDetail).mockRejectedValue(
					new Error("offline"),
				);
				await fireEvent.click(retryButton);

				await waitFor(() => {
					expect(runtimeHarness.streamInvocations).toHaveLength(2);
				});
				expect(runtimeHarness.streamInvocations[1].message).toBe(askedWords);
				expect(
					runtimeHarness.streamInvocations[1].options?.retryAssistantMessageId,
				).toBeUndefined();
			});

			it("sends once when Retry is pressed twice while the server is read", async () => {
				const retryButton = await failASend();
				let answer: (detail: ConversationDetail) => void = () => {};
				vi.mocked(fetchConversationDetail).mockReturnValueOnce(
					new Promise<ConversationDetail>((resolve) => {
						answer = resolve;
					}),
				);
				await fireEvent.click(retryButton);
				await fireEvent.click(retryButton);
				answer(conversationDetailFixture({ messages: earlierTurn }));

				await waitFor(() => {
					expect(runtimeHarness.streamInvocations).toHaveLength(2);
				});
				// Let a second send, if there were one, arrive.
				await new Promise((resolve) => setTimeout(resolve, 20));
				expect(runtimeHarness.streamInvocations).toHaveLength(2);
			});
		});

		// The server keeps nothing of a message that failed, so a reload would lose its
		// words. They are saved as the chat's draft on the server only: the composer
		// stays as it is, and the bubble with its Retry is the one copy on screen.
		describe("the words of a message that failed for good", () => {
			beforeEach(() => {
				vi.mocked(persistConversationDraft).mockClear();
				vi.mocked(deleteConversationDraft).mockClear();
			});

			const savedDraftOfTheWords = () => ({
				conversationId: "conv-1",
				draftText: askedWords,
				selectedAttachmentIds: [],
				selectedAttachments: [],
				selectedLinkedSources: [],
				pendingSkill: null,
				updatedAt: Date.now(),
			});

			async function untilTheReadHasBeenApplied() {
				for (let step = 0; step < 5; step += 1) await Promise.resolve();
				await new Promise((resolve) => setTimeout(resolve, 0));
			}

			it("are saved as the chat's draft, and the composer stays empty", async () => {
				await failASend();

				await waitFor(() => {
					expect(persistConversationDraft).toHaveBeenCalledWith(
						"conv-1",
						expect.objectContaining({
							draftText: askedWords,
							selectedAttachmentIds: [],
						}),
						expect.anything(),
					);
				});
				expect(screen.getByTestId("message-input")).toHaveValue("");
				expect(screen.getAllByTestId("user-message")).toHaveLength(2);
			});

			it("are not saved over words the composer holds", async () => {
				renderPage(pageData({ messages: earlierTurn }));
				const composer = screen.getByTestId("message-input");
				await fireEvent.input(composer, { target: { value: askedWords } });
				await fireEvent.click(
					screen.getByRole("button", { name: "Send message" }),
				);
				await waitFor(() => {
					expect(runtimeHarness.streamInvocations).toHaveLength(1);
				});
				// Words typed while the message was on its way are the next message's.
				await fireEvent.input(composer, {
					target: { value: "a thought for later" },
				});
				vi.mocked(persistConversationDraft).mockClear();

				runtimeHarness.streamInvocations[0].callbacks.onError(
					new Error("boom"),
				);
				await screen.findByRole("button", { name: "Retry" });
				await untilTheReadHasBeenApplied();

				expect(persistConversationDraft).not.toHaveBeenCalledWith(
					"conv-1",
					expect.objectContaining({ draftText: askedWords }),
					expect.anything(),
				);
				expect(composer).toHaveValue("a thought for later");
			});

			it("are not put into the composer by a read of the chat, whose draft is those words until the server clears it", async () => {
				const retryButton = await failASend();
				await waitFor(() => {
					expect(persistConversationDraft).toHaveBeenCalled();
				});
				const composer = screen.getByTestId("message-input");
				vi.mocked(fetchConversationDetail).mockResolvedValue(
					conversationDetailFixture({ draft: savedDraftOfTheWords() }),
				);
				await fireEvent.click(retryButton);
				await waitFor(() => {
					expect(runtimeHarness.streamInvocations).toHaveLength(2);
				});

				// The Retry lands; the stream ends before the server has cleared the draft
				// of the turn, and the read the end asks for still carries it.
				const retried = runtimeHarness.streamInvocations[1];
				vi.mocked(fetchConversationDetail).mockClear();
				retried.callbacks.onToken("Tomorrow is free.");
				retried.callbacks.onEnd("Tomorrow is free.", {
					assistantMessageId: "assistant-2",
					userMessageId: "user-2",
				});
				await waitFor(() => {
					expect(fetchConversationDetail).toHaveBeenCalled();
				});
				await untilTheReadHasBeenApplied();

				expect(composer).toHaveValue("");
			});

			it("are taken back from the server when Retry finds the turn the server had finished", async () => {
				const retryButton = await failASend();
				await waitFor(() => {
					expect(persistConversationDraft).toHaveBeenCalled();
				});
				vi.mocked(fetchConversationDetail).mockResolvedValue(
					conversationDetailFixture({
						messages: [
							...earlierTurn,
							{
								id: "user-2",
								role: "user" as const,
								content: askedWords,
								timestamp: 3,
							},
							{
								id: "assistant-2",
								role: "assistant" as const,
								content: "Tomorrow is free.",
								timestamp: 4,
							},
						],
					}),
				);
				vi.mocked(deleteConversationDraft).mockClear();

				await fireEvent.click(retryButton);

				// The server finished the turn before the page saw it fail, so it did not
				// clear the draft the page saved: a reload would put the answered message
				// back in the composer.
				await waitFor(() => {
					expect(deleteConversationDraft).toHaveBeenCalledWith(
						"conv-1",
						expect.any(Function),
					);
				});
				expect(runtimeHarness.streamInvocations).toHaveLength(1);
			});

			it("leave words typed since alone when Retry finds the turn the server had finished", async () => {
				const retryButton = await failASend();
				const composer = screen.getByTestId("message-input");
				await fireEvent.input(composer, {
					target: { value: "a thought for later" },
				});
				vi.mocked(fetchConversationDetail).mockResolvedValue(
					conversationDetailFixture({
						messages: [
							...earlierTurn,
							{
								id: "user-2",
								role: "user" as const,
								content: askedWords,
								timestamp: 3,
							},
							{
								id: "assistant-2",
								role: "assistant" as const,
								content: "Tomorrow is free.",
								timestamp: 4,
							},
						],
					}),
				);
				vi.mocked(deleteConversationDraft).mockClear();

				await fireEvent.click(retryButton);
				expect(
					await screen.findByText("Tomorrow is free."),
				).toBeInTheDocument();
				await untilTheReadHasBeenApplied();

				// The draft saved now is the person's own, which replaced the kept words.
				expect(deleteConversationDraft).not.toHaveBeenCalled();
				expect(composer).toHaveValue("a thought for later");
			});

			it("are let go of, with their saved copy, when another turn starts", async () => {
				await failASend();
				await waitFor(() => {
					expect(persistConversationDraft).toHaveBeenCalled();
				});
				vi.mocked(deleteConversationDraft).mockClear();

				// A regenerate sends other words and is not the composer's own send. The
				// failed message is a later turn of the reply it regenerates.
				vi.spyOn(window, "confirm").mockReturnValue(true);
				await fireEvent.click(
					screen.getByRole("button", { name: "Regenerate response" }),
				);

				await waitFor(() => {
					expect(deleteConversationDraft).toHaveBeenCalledWith(
						"conv-1",
						expect.any(Function),
					);
				});
			});
		});
	});

	// Only a send of what the composer holds clears its draft: the composer's own
	// send and the landing page's first message. A turn that starts from
	// anywhere else sends other words, and the draft the person is holding
	// stays on screen and stays saved.
	describe("the draft the composer is holding", () => {
		beforeEach(() => {
			vi.mocked(deleteConversationDraft).mockClear();
			vi.mocked(persistConversationDraft).mockClear();
		});

		/** Types into the composer and waits until the draft is saved, as it is a moment after a person stops typing. What happens to the draft from here is what the test looks at. */
		async function holdADraft(text: string) {
			const composer = screen.getByTestId("message-input");
			await fireEvent.input(composer, { target: { value: text } });
			await waitFor(() => {
				expect(persistConversationDraft).toHaveBeenCalledWith(
					"conv-1",
					expect.objectContaining({ draftText: text }),
					expect.anything(),
				);
			});
			vi.mocked(deleteConversationDraft).mockClear();
			return composer;
		}

		it("a regenerate leaves it alone", async () => {
			renderPage(
				pageData({
					messages: [
						{
							id: "user-1",
							role: "user" as const,
							content: "What is the plan?",
							timestamp: 1,
						},
						{
							id: "assistant-1",
							role: "assistant" as const,
							content: "Here is the plan.",
							timestamp: 2,
						},
					],
				}),
			);
			await screen.findByText("Here is the plan.");
			const composer = await holdADraft("half a thought");

			await fireEvent.click(
				screen.getByRole("button", { name: "Regenerate response" }),
			);

			await waitFor(() => {
				expect(runtimeHarness.streamInvocations).toHaveLength(1);
			});
			expect(runtimeHarness.streamInvocations[0].message).toBe(
				"What is the plan?",
			);
			expect(deleteConversationDraft).not.toHaveBeenCalled();
			expect(composer).toHaveValue("half a thought");
		});

		it("a follow-up chip leaves it alone", async () => {
			renderPage();
			await fireEvent.input(screen.getByTestId("message-input"), {
				target: { value: "What is the plan?" },
			});
			await fireEvent.click(
				screen.getByRole("button", { name: "Send message" }),
			);
			const firstInvocation = runtimeHarness.streamInvocations[0];
			firstInvocation.callbacks.onToken("Here is the plan.");
			firstInvocation.callbacks.onEnd("Here is the plan.", {
				assistantMessageId: "assistant-1",
				followUps: ["List the risks in a table"],
			});
			const chip = await screen.findByRole("button", {
				name: "Send: List the risks in a table",
			});
			const composer = await holdADraft("half a thought");

			await fireEvent.click(chip);

			await waitFor(() => {
				expect(runtimeHarness.streamInvocations).toHaveLength(2);
			});
			expect(runtimeHarness.streamInvocations[1].message).toBe(
				"List the risks in a table",
			);
			expect(deleteConversationDraft).not.toHaveBeenCalled();
			expect(composer).toHaveValue("half a thought");
		});

		it("an Atlas action leaves it alone", async () => {
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
			const composer = await holdADraft("half a thought");

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
				expect(runtimeHarness.atlasSubmissions).toHaveLength(1);
			});
			expect(deleteConversationDraft).not.toHaveBeenCalled();
			expect(composer).toHaveValue("half a thought");
		});

		it("a send of the composer's own text clears it", async () => {
			renderPage();
			await holdADraft("What is the plan?");

			await fireEvent.click(
				screen.getByRole("button", { name: "Send message" }),
			);

			await waitFor(() => {
				expect(runtimeHarness.streamInvocations).toHaveLength(1);
			});
			await waitFor(() => {
				expect(deleteConversationDraft).toHaveBeenCalledWith(
					"conv-1",
					expect.any(Function),
				);
			});
		});

		it("the landing page's first message clears it too", async () => {
			const { storePendingConversationMessage } = await import(
				"$lib/client/conversation-session"
			);
			storePendingConversationMessage("conv-1", {
				message: "First message ever",
				attachmentIds: [],
				attachments: [],
			});

			renderPage();

			await waitFor(() => {
				expect(runtimeHarness.streamInvocations).toHaveLength(1);
			});
			expect(runtimeHarness.streamInvocations[0].message).toBe(
				"First message ever",
			);
			await waitFor(() => {
				expect(deleteConversationDraft).toHaveBeenCalledWith(
					"conv-1",
					expect.any(Function),
				);
			});
		});
	});

	// While a job runs the page reads the chat every 2.5 s, and the answer to a
	// read holds the draft as the server had it when it was asked. A read that
	// was out when the draft changed says nothing about it.
	describe("a read of the chat that was out while the draft changed", () => {
		const SAVED_WORDS = "Words saved before the read was asked";

		/** The draft a read answers with: what the server held when it was asked. */
		function savedDraftOf(draftText: string): ConversationDetail["draft"] {
			return {
				conversationId: "conv-1",
				draftText,
				selectedAttachmentIds: [],
				selectedAttachments: [],
				selectedLinkedSources: [],
				pendingSkill: null,
				updatedAt: Date.now(),
			};
		}

		/**
		 * Sends a first turn and ends it, which asks the page to read the chat
		 * again. The read is held; `answer` is the server's reply to it, whenever
		 * the test wants it to arrive.
		 */
		async function endATurnWithAReadOut() {
			renderPage();
			const composer = screen.getByTestId("message-input");
			await fireEvent.input(composer, { target: { value: "First question" } });
			await fireEvent.click(
				screen.getByRole("button", { name: "Send message" }),
			);
			const turn = runtimeHarness.streamInvocations[0];
			let answer: (detail: ConversationDetail) => void = () => {};
			vi.mocked(fetchConversationDetail).mockClear();
			vi.mocked(fetchConversationDetail).mockReturnValueOnce(
				new Promise((resolve) => {
					answer = resolve;
				}),
			);
			turn.callbacks.onToken("A reply");
			turn.callbacks.onEnd("A reply", { assistantMessageId: "assistant-1" });
			await waitFor(() => {
				expect(fetchConversationDetail).toHaveBeenCalledTimes(1);
			});
			return { composer, answer };
		}

		/** The answer is applied in the microtasks and the flush after it. */
		async function untilTheAnswerHasBeenApplied() {
			for (let step = 0; step < 5; step += 1) await Promise.resolve();
			await new Promise((resolve) => setTimeout(resolve, 0));
		}

		it("does not bring back the words that were sent while it was out", async () => {
			const { composer, answer } = await endATurnWithAReadOut();
			await fireEvent.input(composer, { target: { value: SAVED_WORDS } });
			await fireEvent.click(
				screen.getByRole("button", { name: "Send message" }),
			);
			await waitFor(() => {
				expect(runtimeHarness.streamInvocations).toHaveLength(2);
			});
			expect(composer).toHaveValue("");

			answer(conversationDetailFixture({ draft: savedDraftOf(SAVED_WORDS) }));
			await untilTheAnswerHasBeenApplied();

			expect(composer).toHaveValue("");
		});

		it("does not refill a composer the person emptied while it was out", async () => {
			const { composer, answer } = await endATurnWithAReadOut();
			await fireEvent.input(composer, { target: { value: "half a thought" } });
			await fireEvent.input(composer, { target: { value: "" } });

			answer(conversationDetailFixture({ draft: savedDraftOf(SAVED_WORDS) }));
			await untilTheAnswerHasBeenApplied();

			expect(composer).toHaveValue("");
		});

		it("still brings the saved draft in when nothing changed while it was out", async () => {
			const { composer, answer } = await endATurnWithAReadOut();

			answer(conversationDetailFixture({ draft: savedDraftOf(SAVED_WORDS) }));

			await waitFor(() => {
				expect(composer).toHaveValue(SAVED_WORDS);
			});
		});
	});

	// A turn that stopped, failed or was taken back from the queue puts its words
	// back in the composer, and a restore never replaces the words the composer
	// holds by then: it adds to them, the held ones first.
	describe("a turn that puts its words back", () => {
		const JOINED = "C typed since\n\nB queued";
		const atlasMessage = {
			id: "assistant-atlas-1",
			role: "assistant" as const,
			content: "Atlas is complete.",
			timestamp: 1,
		};
		const finishedAtlasJob = () =>
			atlasJobFixture({
				status: "succeeded",
				completedAt: 121,
				progress: { percent: 100, stage: "audit", details: { queries: [] } },
			});

		beforeEach(() => {
			vi.mocked(persistConversationDraft).mockClear();
		});

		/** A turn is running, "B queued" waits behind it and "C typed since" is in the composer. */
		async function runningWithBQueuedAndCTyped(typedSince = "C typed since") {
			renderPage();
			const composer = screen.getByTestId("message-input");
			await fireEvent.input(composer, { target: { value: "A" } });
			await fireEvent.click(
				screen.getByRole("button", { name: "Send message" }),
			);
			await fireEvent.input(composer, { target: { value: "B queued" } });
			await fireEvent.click(screen.getByTestId("queue-button"));
			if (typedSince) {
				await fireEvent.input(composer, { target: { value: typedSince } });
			}
			return composer;
		}

		async function stopTheTurn() {
			await fireEvent.click(screen.getByTestId("stop-button"));
			runtimeHarness.streamInvocations[0].callbacks.onEnd("", {
				wasStopped: true,
			});
		}

		it("Stop puts the queued message behind the words typed since, saves both and sends both", async () => {
			const composer = await runningWithBQueuedAndCTyped();

			await stopTheTurn();

			await waitFor(() => {
				expect(composer).toHaveValue(JOINED);
			});
			expect(
				screen.queryByTestId("queued-message-banner"),
			).not.toBeInTheDocument();
			await waitFor(() => {
				expect(persistConversationDraft).toHaveBeenLastCalledWith(
					"conv-1",
					expect.objectContaining({ draftText: JOINED }),
					expect.anything(),
				);
			});

			await fireEvent.click(
				screen.getByRole("button", { name: "Send message" }),
			);
			await waitFor(() => {
				expect(runtimeHarness.streamInvocations).toHaveLength(2);
			});
			expect(runtimeHarness.streamInvocations[1].message).toBe(JOINED);
		});

		it("Edit on the queued banner does the same", async () => {
			const composer = await runningWithBQueuedAndCTyped();

			await fireEvent.click(screen.getByTestId("edit-queued-button"));

			await waitFor(() => {
				expect(composer).toHaveValue(JOINED);
			});
			expect(
				screen.queryByTestId("queued-message-banner"),
			).not.toBeInTheDocument();
		});

		it("a turn that fails does the same", async () => {
			const composer = await runningWithBQueuedAndCTyped();

			runtimeHarness.streamInvocations[0].callbacks.onError(
				new Error("The model is down"),
			);

			await waitFor(() => {
				expect(composer).toHaveValue(JOINED);
			});
			expect(
				screen.queryByTestId("queued-message-banner"),
			).not.toBeInTheDocument();
		});

		it("adds nothing to an empty composer", async () => {
			const composer = await runningWithBQueuedAndCTyped("");

			await stopTheTurn();

			await waitFor(() => {
				expect(composer).toHaveValue("B queued");
			});
		});

		it("joins nothing when the held words are the queued ones again", async () => {
			const composer = await runningWithBQueuedAndCTyped("B queued ");

			await stopTheTurn();

			await waitFor(() => {
				expect(
					screen.queryByTestId("queued-message-banner"),
				).not.toBeInTheDocument();
			});
			expect(composer).toHaveValue("B queued ");
		});

		it("a Continue Atlas that fails puts the panel's words behind the held ones, and the held draft's mode stays", async () => {
			runtimeHarness.atlasFailure = new Error("Atlas is busy");
			renderPage(
				pageData({
					messages: [atlasMessage],
					atlasJobs: [finishedAtlasJob()],
				}),
			);
			const composer = screen.getByTestId("message-input");
			await fireEvent.input(composer, { target: { value: "held words" } });

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
				expect(composer).toHaveValue(
					"held words\n\nExtend the report with deployment risks",
				);
			});
			// The held draft was not in Atlas mode, so the joined words are not either:
			// they go to the model, not to Atlas.
			await fireEvent.click(
				screen.getByRole("button", { name: "Send message" }),
			);
			await waitFor(() => {
				expect(runtimeHarness.streamInvocations).toHaveLength(1);
			});
			expect(runtimeHarness.atlasSubmissions).toHaveLength(1);
		});

		it("a Continue Atlas that fails brings its words back in Atlas mode when the composer is empty", async () => {
			runtimeHarness.atlasFailure = new Error("Atlas is busy");
			renderPage(
				pageData({
					messages: [atlasMessage],
					atlasJobs: [finishedAtlasJob()],
				}),
			);
			const composer = screen.getByTestId("message-input");

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
				expect(composer).toHaveValue("Extend the report with deployment risks");
			});
			runtimeHarness.atlasFailure = null;
			await fireEvent.click(
				screen.getByRole("button", { name: "Send message" }),
			);
			await waitFor(() => {
				expect(runtimeHarness.atlasSubmissions).toHaveLength(2);
			});
			expect(runtimeHarness.streamInvocations).toHaveLength(0);
		});

		it("never puts another chat's words into this chat's composer or saved draft", async () => {
			renderPage();
			const composer = screen.getByTestId("message-input");
			await fireEvent.input(composer, { target: { value: "held words" } });
			await waitFor(() => {
				expect(persistConversationDraft).toHaveBeenCalledWith(
					"conv-1",
					expect.objectContaining({ draftText: "held words" }),
					expect.anything(),
				);
			});
			vi.mocked(persistConversationDraft).mockClear();

			runtimeHarness.adapters?.restorePayloadToDraft({
				message: "words of another chat",
				attachmentIds: [],
				attachments: [],
				pendingAttachments: [],
				conversationId: "conv-2",
			});
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(composer).toHaveValue("held words");
			expect(persistConversationDraft).not.toHaveBeenCalled();
		});

		// What the composer holds is what it last said or was last told to show. A
		// load of the chat nulls the page's copy of the draft, and a read can set
		// one older than the typing that has not been saved yet: neither is what
		// the composer holds.
		describe("joins what the composer holds, not the page's copy of the draft", () => {
			it("after a reconnect that failed and loaded the chat again", async () => {
				runtimeHarness.orphanedStream = {
					streamId: "stream-1",
					userMessage: "The question the reply was for",
				};
				renderPage();
				const composer = screen.getByTestId("message-input");
				await waitFor(() => {
					expect(runtimeHarness.streamInvocations).toHaveLength(1);
				});
				await fireEvent.input(composer, { target: { value: "B queued" } });
				await fireEvent.click(screen.getByTestId("queue-button"));
				await fireEvent.input(composer, { target: { value: "C typed since" } });

				// The reconnect fails: the page loads the chat again, which empties its
				// copy of the draft.
				runtimeHarness.streamInvocations[0].callbacks.onError(
					new Error("The server restarted"),
				);
				await waitFor(() => {
					expect(fetchConversationDetail).toHaveBeenCalled();
				});
				await fireEvent.click(screen.getByTestId("edit-queued-button"));

				await waitFor(() => {
					expect(composer).toHaveValue("C typed since\n\nB queued");
				});
				expect(
					screen.queryByTestId("queued-message-banner"),
				).not.toBeInTheDocument();
			});

			it("when a read has set an older copy than the typing", async () => {
				renderPage();
				const composer = screen.getByTestId("message-input");
				await fireEvent.input(composer, {
					target: { value: "typed, not saved yet" },
				});
				// A read asked now answers with what the server has: older than the typing.
				vi.mocked(fetchConversationDetail).mockResolvedValueOnce(
					conversationDetailFixture({
						draft: {
							conversationId: "conv-1",
							draftText: "typed",
							selectedAttachmentIds: [],
							selectedAttachments: [],
							selectedLinkedSources: [],
							pendingSkill: null,
							updatedAt: Date.now() - 1000,
						},
					}),
				);
				runtimeHarness.adapters?.hydrateConversationDetail();
				for (let step = 0; step < 5; step += 1) await Promise.resolve();
				await new Promise((resolve) => setTimeout(resolve, 0));

				runtimeHarness.adapters?.restorePayloadToDraft({
					message: "B queued",
					attachmentIds: [],
					attachments: [],
					pendingAttachments: [],
				});

				await waitFor(() => {
					expect(composer).toHaveValue("typed, not saved yet\n\nB queued");
				});
			});

			it("when a draft the page was given on arrival is still untouched", async () => {
				runtimeHarness.atlasFailure = new Error("Atlas is busy");
				renderPage(
					pageData({
						messages: [atlasMessage],
						atlasJobs: [finishedAtlasJob()],
						draft: {
							conversationId: "conv-1",
							draftText: "a draft from before the reload",
							selectedAttachmentIds: [],
							selectedAttachments: [],
							selectedLinkedSources: [],
							pendingSkill: null,
							updatedAt: Date.now() - 5000,
						},
					}),
				);
				const composer = screen.getByTestId("message-input");
				await waitFor(() => {
					expect(composer).toHaveValue("a draft from before the reload");
				});

				await fireEvent.click(
					screen.getByRole("button", { name: "Continue Atlas" }),
				);
				const panel = screen.getByRole("region", { name: "Continue Atlas" });
				await fireEvent.input(within(panel).getByRole("textbox"), {
					target: { value: "Extend the report" },
				});
				await fireEvent.click(
					within(panel).getByRole("button", { name: "Continue Atlas" }),
				);

				await waitFor(() => {
					expect(composer).toHaveValue(
						"a draft from before the reload\n\nExtend the report",
					);
				});
			});

			it("after an earlier restore, which the composer took without saying so", async () => {
				runtimeHarness.atlasFailure = new Error("Atlas is busy");
				renderPage(
					pageData({
						messages: [atlasMessage],
						atlasJobs: [finishedAtlasJob()],
					}),
				);
				const composer = screen.getByTestId("message-input");
				await fireEvent.input(composer, { target: { value: "held words" } });
				runtimeHarness.adapters?.restorePayloadToDraft({
					message: "first restore",
					attachmentIds: [],
					attachments: [],
					pendingAttachments: [],
				});
				await waitFor(() => {
					expect(composer).toHaveValue("held words\n\nfirst restore");
				});

				runtimeHarness.adapters?.restorePayloadToDraft({
					message: "second restore",
					attachmentIds: [],
					attachments: [],
					pendingAttachments: [],
				});

				await waitFor(() => {
					expect(composer).toHaveValue(
						"held words\n\nfirst restore\n\nsecond restore",
					);
				});
			});

			it("and an emptied composer holds nothing, however old the page's copy", async () => {
				renderPage();
				const composer = screen.getByTestId("message-input");
				await fireEvent.input(composer, { target: { value: "sent words" } });
				await fireEvent.click(
					screen.getByRole("button", { name: "Send message" }),
				);
				await waitFor(() => {
					expect(runtimeHarness.streamInvocations).toHaveLength(1);
				});

				runtimeHarness.adapters?.restorePayloadToDraft({
					message: "words put back",
					attachmentIds: [],
					attachments: [],
					pendingAttachments: [],
				});

				await waitFor(() => {
					expect(composer).toHaveValue("words put back");
				});
			});
		});
	});

	// The page, and its composer, are reused when the person moves to another
	// chat. What was typed belongs to the chat it was typed in: it is saved there
	// first, then the composer empties and shows the next chat's own draft.
	describe("moving to another chat with words in the composer", () => {
		const turn = [
			{
				id: "user-1",
				role: "user" as const,
				content: "What's on my calendar?",
				timestamp: 1,
			},
			{
				id: "assistant-1",
				role: "assistant" as const,
				content: "You have a 2pm meeting.",
				timestamp: 2,
			},
		];

		function savedDraftOf(
			conversationId: string,
			draftText: string,
		): ConversationDetail["draft"] {
			return {
				conversationId,
				draftText,
				selectedAttachmentIds: [],
				selectedAttachments: [],
				selectedLinkedSources: [],
				pendingSkill: null,
				updatedAt: Date.now() - 1000,
			};
		}

		/** What the page is given for a chat: its own id, and its saved draft when it has one. */
		function chat(conversationId: string, draft?: string) {
			return {
				data: pageData({
					conversation: conversationFixture(conversationId, {
						title: conversationId,
						createdAt: conversationId === "conv-1" ? 1 : 2,
						updatedAt: conversationId === "conv-1" ? 1 : 2,
					}),
					messages: conversationId === "conv-1" ? turn : [],
					draft:
						draft === undefined ? null : savedDraftOf(conversationId, draft),
				}),
				params: { conversationId },
			};
		}

		beforeEach(() => {
			vi.mocked(persistConversationDraft).mockClear();
		});

		it("saves the words as the draft of the chat they were typed in, and shows the next chat's own draft", async () => {
			const view = renderPage(chat("conv-1").data);
			const composer = screen.getByTestId("message-input");
			await fireEvent.input(composer, { target: { value: "for A" } });

			await view.rerender(chat("conv-2", "B's own draft"));

			await waitFor(() => {
				expect(composer).toHaveValue("B's own draft");
			});
			expect(persistConversationDraft).toHaveBeenCalledWith(
				"conv-1",
				expect.objectContaining({ draftText: "for A" }),
				expect.anything(),
			);
			expect(persistConversationDraft).not.toHaveBeenCalledWith(
				"conv-2",
				expect.anything(),
				expect.anything(),
			);
		});

		it("leaves a chat with no draft with an empty composer", async () => {
			const view = renderPage(chat("conv-1").data);
			const composer = screen.getByTestId("message-input");
			await fireEvent.input(composer, { target: { value: "for A" } });

			await view.rerender(chat("conv-2"));

			await waitFor(() => {
				expect(composer).toHaveValue("");
			});
		});

		it("sends only the next chat's own words", async () => {
			const view = renderPage(chat("conv-1").data);
			await fireEvent.input(screen.getByTestId("message-input"), {
				target: { value: "for A" },
			});
			await view.rerender(chat("conv-2", "B's own draft"));
			await waitFor(() => {
				expect(screen.getByTestId("message-input")).toHaveValue(
					"B's own draft",
				);
			});

			await fireEvent.click(
				screen.getByRole("button", { name: "Send message" }),
			);

			await waitFor(() => {
				expect(runtimeHarness.streamInvocations).toHaveLength(1);
			});
			expect(runtimeHarness.streamInvocations[0].message).toBe("B's own draft");
		});

		it("gives the words back when the person returns to the chat", async () => {
			const view = renderPage(chat("conv-1").data);
			const composer = screen.getByTestId("message-input");
			await fireEvent.input(composer, { target: { value: "for A" } });
			await view.rerender(chat("conv-2"));
			await waitFor(() => {
				expect(composer).toHaveValue("");
			});
			await fireEvent.input(composer, { target: { value: "for B" } });

			// What a load of the chat finds: the draft the move saved.
			await view.rerender(chat("conv-1", "for A"));

			await waitFor(() => {
				expect(composer).toHaveValue("for A");
			});
			expect(persistConversationDraft).toHaveBeenCalledWith(
				"conv-2",
				expect.objectContaining({ draftText: "for B" }),
				expect.anything(),
			);
		});

		it("keeps the words typed while a reply was coming with their chat", async () => {
			const view = renderPage(chat("conv-1").data);
			const composer = screen.getByTestId("message-input");
			await fireEvent.input(composer, { target: { value: "A question" } });
			await fireEvent.click(
				screen.getByRole("button", { name: "Send message" }),
			);
			await fireEvent.input(composer, {
				target: { value: "an idea for later" },
			});

			await view.rerender(chat("conv-2"));

			await waitFor(() => {
				expect(composer).toHaveValue("");
			});
			expect(persistConversationDraft).toHaveBeenCalledWith(
				"conv-1",
				expect.objectContaining({ draftText: "an idea for later" }),
				expect.anything(),
			);
		});

		it("saves the draft set aside by an open edit, and never the edit", async () => {
			const view = renderPage(chat("conv-1").data);
			const composer = screen.getByTestId("message-input");
			await fireEvent.input(composer, { target: { value: "set aside" } });
			await fireEvent.click(
				screen.getByRole("button", { name: "Edit message" }),
			);
			await waitFor(() => {
				expect(composer).toHaveValue("What's on my calendar?");
			});
			await fireEvent.input(composer, { target: { value: "edited words" } });

			await view.rerender(chat("conv-2", "B's own draft"));

			await waitFor(() => {
				expect(composer).toHaveValue("B's own draft");
			});
			expect(
				screen.queryByTestId("composer-edit-strip"),
			).not.toBeInTheDocument();
			expect(persistConversationDraft).toHaveBeenCalledWith(
				"conv-1",
				expect.objectContaining({ draftText: "set aside" }),
				expect.anything(),
			);
			for (const call of vi.mocked(persistConversationDraft).mock.calls) {
				expect(JSON.stringify(call)).not.toContain("edited words");
			}
		});

		it("saves the words typed just before a fork with the chat they were typed in", async () => {
			const { createConversationFork } = await import(
				"$lib/client/api/conversations"
			);
			vi.mocked(createConversationFork).mockResolvedValue({
				conversation: conversationFixture("conv-fork", { title: "Fork" }),
			} as Awaited<ReturnType<typeof createConversationFork>>);
			renderPage(chat("conv-1").data);
			await fireEvent.input(screen.getByTestId("message-input"), {
				target: { value: "typed just before the fork" },
			});

			await fireEvent.click(
				screen.getByRole("button", { name: "Fork from here" }),
			);

			await waitFor(() => {
				expect(goto).toHaveBeenCalledWith("/chat/conv-fork");
			});
			expect(persistConversationDraft).toHaveBeenCalledWith(
				"conv-1",
				expect.objectContaining({ draftText: "typed just before the fork" }),
				expect.anything(),
			);
		});

		// A message queued behind a running reply is the person's words in that
		// chat. The queue is dropped with the chat, so they are saved in its draft
		// first, and nothing is sent.
		describe("a message queued behind a running reply", () => {
			/** A reply is running in the chat, B is waiting behind it and, when given, C is typed. */
			async function runningWithBQueued(typedSince?: string) {
				const view = renderPage(chat("conv-1").data);
				const composer = screen.getByTestId("message-input");
				await fireEvent.input(composer, { target: { value: "A question" } });
				await fireEvent.click(
					screen.getByRole("button", { name: "Send message" }),
				);
				await fireEvent.input(composer, { target: { value: "B queued" } });
				await fireEvent.click(screen.getByTestId("queue-button"));
				expect(screen.getByTestId("queued-message-banner")).toHaveTextContent(
					"B queued",
				);
				if (typedSince) {
					await fireEvent.input(composer, { target: { value: typedSince } });
				}
				return { view, composer };
			}

			it("is saved as the draft of the chat it was queued in when the person moves to another, and sent nowhere", async () => {
				const { view, composer } = await runningWithBQueued();

				await view.rerender(chat("conv-2", "B's own draft"));

				await waitFor(() => {
					expect(composer).toHaveValue("B's own draft");
				});
				expect(persistConversationDraft).toHaveBeenCalledWith(
					"conv-1",
					expect.objectContaining({ draftText: "B queued" }),
					expect.anything(),
				);
				expect(persistConversationDraft).not.toHaveBeenCalledWith(
					"conv-2",
					expect.anything(),
					expect.anything(),
				);
				expect(
					screen.queryByTestId("queued-message-banner"),
				).not.toBeInTheDocument();
				// The first reply ending finds nothing queued, here or anywhere.
				runtimeHarness.streamInvocations[0].callbacks.onEnd("Done", {
					assistantMessageId: "assistant-1",
				});
				await new Promise((resolve) => setTimeout(resolve, 0));
				expect(runtimeHarness.streamInvocations).toHaveLength(1);
			});

			it("joins the words typed since, which are saved with it in one save", async () => {
				const { view } = await runningWithBQueued("C typed since");

				await view.rerender(chat("conv-2"));

				const saves = vi
					.mocked(persistConversationDraft)
					.mock.calls.filter(([conversationId]) => conversationId === "conv-1");
				expect(saves.at(-1)?.[1]).toMatchObject({
					draftText: "C typed since\n\nB queued",
				});
			});

			it("comes back in the composer when the person returns to the chat", async () => {
				const { view, composer } = await runningWithBQueued();
				await view.rerender(chat("conv-2"));
				await waitFor(() => {
					expect(composer).toHaveValue("");
				});
				const saved = vi
					.mocked(persistConversationDraft)
					.mock.calls.findLast(
						([conversationId]) => conversationId === "conv-1",
					);

				// What a load of the chat finds: the draft the move saved.
				await view.rerender(chat("conv-1", saved?.[1].draftText));

				await waitFor(() => {
					expect(composer).toHaveValue("B queued");
				});
				expect(runtimeHarness.streamInvocations).toHaveLength(1);
			});

			it("is saved the same way when the person leaves the chat page", async () => {
				const { view } = await runningWithBQueued();

				view.unmount();

				expect(persistConversationDraft).toHaveBeenCalledWith(
					"conv-1",
					expect.objectContaining({ draftText: "B queued" }),
					expect.anything(),
				);
				expect(runtimeHarness.streamInvocations).toHaveLength(1);
			});

			it("joins the words typed since when the person leaves the chat page", async () => {
				const { view } = await runningWithBQueued("C typed since");

				view.unmount();

				const saves = vi
					.mocked(persistConversationDraft)
					.mock.calls.filter(([conversationId]) => conversationId === "conv-1");
				expect(saves.at(-1)?.[1]).toMatchObject({
					draftText: "C typed since\n\nB queued",
				});
			});
		});
	});

	it("hides Stop while polling after the stream closes for recovery", async () => {
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
			target: { value: "Start polling turn" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "Send message" }));

		expect(runtimeHarness.streamInvocations).toHaveLength(1);
		runtimeHarness.streamInvocations[0].callbacks.onWaiting?.();

		await waitFor(() => {
			expect(
				screen.queryByRole("button", { name: "Stop" }),
			).not.toBeInTheDocument();
		});

		await fireEvent.input(screen.getByTestId("message-input"), {
			target: { value: "Queue during recovery" },
		});

		expect(screen.getByTestId("queue-button")).toBeInTheDocument();
		resolveDetail(conversationDetailFixture());
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

	// The chat is one of the document workspace's three callers (with the
	// Knowledge page and the project Files modal). The panel is rebuilt in place
	// for the artifact family, so this pins what the chat relies on today: a
	// produced file opened from its row lands in the DOCKED shell with its
	// title, its AI provenance and its preview surface, and closing the shell
	// hands the chat back untouched.
	it("opens a produced file from its row into the docked workspace, and closing returns to the chat", async () => {
		// Opening a document with an artifact id records the open (best effort);
		// the file-wide mock has no resolved value for it.
		const { recordDocumentWorkspaceOpen } = await import(
			"$lib/client/api/knowledge"
		);
		vi.mocked(recordDocumentWorkspaceOpen).mockResolvedValue(undefined);
		renderPage(
			pageData({
				messages: [
					{
						id: "assistant-file-1",
						role: "assistant",
						content: "Here is the trip summary.",
						timestamp: 1,
					},
				],
				fileProductionJobs: [
					{
						id: "job-file-1",
						conversationId: "conv-1",
						assistantMessageId: "assistant-file-1",
						title: "Vienna trip summary",
						status: "succeeded",
						stage: null,
						createdAt: 1,
						updatedAt: 2,
						files: [
							{
								id: "chat-file-1",
								filename: "Vienna trip summary.pdf",
								mimeType: "application/pdf",
								sizeBytes: 2048,
								downloadUrl: "/api/chat/files/chat-file-1/download",
								previewUrl: "/api/chat/files/chat-file-1/preview",
								artifactId: "artifact-file-1",
							},
						],
						warnings: [],
						dismissed: false,
						error: null,
						sourceMode: null,
					},
				],
			}),
		);

		// A produced file is a pinned deliverable row; open its body if it is not
		// already open.
		const row = await screen.findByRole("button", {
			name: /Vienna trip summary\.pdf/,
		});
		if (row.getAttribute("aria-expanded") !== "true") {
			await fireEvent.click(row);
		}
		await fireEvent.click(
			await screen.findByRole("button", {
				name: "Preview Vienna trip summary.pdf",
			}),
		);

		const shell = await screen.findByRole("complementary", {
			name: WORKSPACE_LANDMARK,
		});
		expect(screen.getByTestId("workspace-main")).toHaveAttribute(
			"data-presentation",
			"docked",
		);
		expect(
			within(shell).getByText("Vienna trip summary.pdf"),
		).toBeInTheDocument();
		// The same header the panel's list opens for a File (F21): the title and the
		// kind in the standard header, not the older one with its provenance chip.
		expect(within(shell).getByTestId("artifact-panel-title")).toHaveTextContent(
			"Vienna trip summary.pdf",
		);
		expect(
			within(shell).queryByTestId("document-provenance"),
		).not.toBeInTheDocument();
		expect(
			within(shell).getByTestId("page-scroll-container"),
		).toBeInTheDocument();

		await fireEvent.click(
			within(shell).getByRole("button", { name: "Close document workspace" }),
		);
		await waitFor(() => {
			expect(screen.queryByTestId("workspace-main")).not.toBeInTheDocument();
		});
		expect(screen.getByText("Here is the trip summary.")).toBeInTheDocument();
	});

	// The header count button/list opens a produced file through
	// artifactToWorkspaceItem, which — for the common case where a real
	// availableWorkspaceDocuments item already matches the artifact id —
	// returns that matched item as-is. If it does not also carry the
	// summary's `kind` through, the panel's header (the kind label, `{#if
	// activeDocument.kind}`) silently never renders for the single most
	// common artifact-backed open: a File that already has a
	// chat_generated_files row. A File has no versions, so it says nothing of
	// a latest moment either (ruling 76).
	it("shows the kind label and no history when a File is opened through the header's list, not just a bare preview", async () => {
		const { recordDocumentWorkspaceOpen } = await import(
			"$lib/client/api/knowledge"
		);
		vi.mocked(recordDocumentWorkspaceOpen).mockResolvedValue(undefined);
		renderPage(
			pageData({
				generatedFiles: [
					{
						id: "chat-file-1",
						conversationId: "conv-1",
						assistantMessageId: "assistant-file-1",
						artifactId: "artifact-file-1",
						documentFamilyId: null,
						documentFamilyStatus: null,
						documentLabel: null,
						documentRole: null,
						versionNumber: 1,
						originConversationId: null,
						originAssistantMessageId: null,
						sourceChatFileId: null,
						filename: "Vienna trip summary.pdf",
						mimeType: "application/pdf",
						sizeBytes: 2048,
						createdAt: 1,
					},
				],
				artifacts: [
					{
						id: "artifact-file-1",
						kind: "file",
						title: "Vienna trip summary.pdf",
						conversationId: "conv-1",
						versionNumber: 1,
						commentCount: 0,
						updatedAt: Date.now(),
					},
				],
			}),
		);

		await fireEvent.click(await screen.findByTestId("artifact-count-button"));
		// Scoped to the desktop list: both the mobile and desktop shells exist
		// in jsdom at once (no media query), so an unscoped query would see two
		// rows for the same item. Each row is an ArtifactCard (chrome="row",
		// redesign §5.2): the whole row is the button, named after its title.
		const list = await screen.findByTestId("artifact-panel-list");
		await fireEvent.click(within(list).getByTestId("artifact-row"));

		const shell = await screen.findByRole("complementary", {
			name: WORKSPACE_LANDMARK,
		});
		await waitFor(() => {
			expect(within(shell).getByText("File")).toBeInTheDocument();
		});
		expect(
			within(shell).queryByTestId("artifact-version-pill"),
		).not.toBeInTheDocument();
	});

	// Wave 2.5 Step 4/redesign §7: the count button now toggles instead of
	// only ever opening — clicking it again while the panel is showing closes
	// it, mirroring the mockup's own count button. Regression coverage for the
	// `isArtifactPanelOpen` derived (mirrors DocumentWorkspace's own
	// `shouldShowWorkspaceShell` formula) that replaced a narrower
	// `artifactListOpen`-only check, which cleared `aria-pressed` as soon as
	// the list handed off to an open item.
	it("toggles the panel closed on a second click of the count button, clearing aria-pressed", async () => {
		// This test opens an item from the list, which best-effort records the
		// open the same way the neighboring "shows the type and version pill…"
		// test above does — unmocked, `recordDocumentWorkspaceOpen`'s default
		// return is not a Promise, so the `.catch` call site throws.
		const { recordDocumentWorkspaceOpen } = await import(
			"$lib/client/api/knowledge"
		);
		vi.mocked(recordDocumentWorkspaceOpen).mockResolvedValue(undefined);
		renderPage(
			pageData({
				generatedFiles: [
					{
						id: "chat-file-1",
						conversationId: "conv-1",
						assistantMessageId: "assistant-file-1",
						artifactId: "artifact-file-1",
						documentFamilyId: null,
						documentFamilyStatus: null,
						documentLabel: null,
						documentRole: null,
						versionNumber: 1,
						originConversationId: null,
						originAssistantMessageId: null,
						sourceChatFileId: null,
						filename: "Vienna trip summary.pdf",
						mimeType: "application/pdf",
						sizeBytes: 2048,
						createdAt: 1,
					},
				],
				artifacts: [
					{
						id: "artifact-file-1",
						kind: "file",
						title: "Vienna trip summary.pdf",
						conversationId: "conv-1",
						versionNumber: 1,
						commentCount: 0,
						updatedAt: Date.now(),
					},
				],
			}),
		);

		const countButton = await screen.findByTestId("artifact-count-button");
		expect(countButton).toHaveAttribute("aria-pressed", "false");

		await fireEvent.click(countButton);
		await screen.findByTestId("artifact-panel-list");
		expect(countButton).toHaveAttribute("aria-pressed", "true");

		await fireEvent.click(countButton);
		await waitFor(() => {
			expect(
				screen.queryByTestId("artifact-panel-list"),
			).not.toBeInTheDocument();
		});
		expect(countButton).toHaveAttribute("aria-pressed", "false");

		// The same toggle still closes the panel after navigating from the list
		// to an open item — the exact bug `isArtifactPanelOpen` fixed, since
		// `artifactListOpen` alone goes false on that transition even though
		// the panel is still showing.
		await fireEvent.click(countButton);
		const list = await screen.findByTestId("artifact-panel-list");
		await fireEvent.click(within(list).getByTestId("artifact-row"));
		await screen.findByRole("complementary", { name: WORKSPACE_LANDMARK });
		expect(countButton).toHaveAttribute("aria-pressed", "true");

		await fireEvent.click(countButton);
		await waitFor(() => {
			expect(screen.queryByTestId("workspace-main")).not.toBeInTheDocument();
		});
		expect(countButton).toHaveAttribute("aria-pressed", "false");
	});

	// The count button's dot follows the PERSISTED review state (the third
	// follow-up chip): the server's per-Document `pendingReviewCount`, read on
	// every load, is what lights it — never a live-only guess that a reload
	// throws away. These pin the page's own derivation; the walk through a real
	// Keep all and a real reload is `artifact-document.spec.ts`.
	describe("the count button's dot follows the persisted review state", () => {
		const documentSummary = (pendingReviewCount: number | undefined) => ({
			id: "doc-1",
			kind: "document" as const,
			title: "Trip plan",
			conversationId: "conv-1",
			versionNumber: 2,
			commentCount: 0,
			updatedAt: Date.now(),
			...(pendingReviewCount === undefined ? {} : { pendingReviewCount }),
		});

		it("lights the dot, and says so in the button's name, when a load reports changes waiting", async () => {
			renderPage(pageData({ artifacts: [documentSummary(2)] }));
			const countButton = await screen.findByTestId("artifact-count-button");
			expect(
				within(countButton).getByTestId("artifact-count-dot"),
			).toBeInTheDocument();
			expect(
				screen.getByTestId("artifact-count-dot-compact"),
			).toBeInTheDocument();
			expect(countButton).toHaveAccessibleName(
				"Open what this chat made (1) — a change is waiting",
			);
		});

		it("leaves the dot dark once a load reports everything reviewed (0), and for a Document never edited by Alfy", async () => {
			const { unmount } = renderPage(
				pageData({ artifacts: [documentSummary(0)] }),
			);
			await screen.findByTestId("artifact-count-button");
			expect(screen.queryByTestId("artifact-count-dot")).toBeNull();
			unmount();

			renderPage(pageData({ artifacts: [documentSummary(undefined)] }));
			await screen.findByTestId("artifact-count-button");
			expect(screen.queryByTestId("artifact-count-dot")).toBeNull();
		});

		it("lights it for ANY Document with changes waiting, not just the first row", async () => {
			renderPage(
				pageData({
					artifacts: [
						documentSummary(0),
						{ ...documentSummary(1), id: "doc-2", title: "Packing list" },
					],
				}),
			);
			await screen.findByTestId("artifact-count-button");
			expect(screen.getByTestId("artifact-count-dot")).toBeInTheDocument();
		});

		it("hides it while the panel is open (the panel is where the review happens) and lights it again when the panel closes", async () => {
			renderPage(pageData({ artifacts: [documentSummary(1)] }));
			const countButton = await screen.findByTestId("artifact-count-button");
			expect(screen.getByTestId("artifact-count-dot")).toBeInTheDocument();

			await fireEvent.click(countButton);
			await screen.findByTestId("artifact-panel-list");
			expect(screen.queryByTestId("artifact-count-dot")).toBeNull();

			await fireEvent.click(countButton);
			await waitFor(() => {
				expect(screen.queryByTestId("artifact-panel-list")).toBeNull();
			});
			expect(screen.getByTestId("artifact-count-dot")).toBeInTheDocument();
		});
	});

	// RV-3 I2: a turn can make Alfy change the artifact that is open beside the chat,
	// and a step of the reader's that is still inside the body's save delay would be
	// written over, or refused as stale, when Alfy's change lands. The open body's
	// pending step is saved first, and the message goes once that save has answered.
	it("saves the open artifact's pending step before a message is sent, and sends it once the save has answered", async () => {
		const { recordDocumentWorkspaceOpen } = await import(
			"$lib/client/api/knowledge"
		);
		vi.mocked(recordDocumentWorkspaceOpen).mockResolvedValue(undefined);
		const { ARTIFACT_BODIES } = await import(
			"$lib/components/artifacts/artifact-bodies"
		);
		const { fakeFlush } = await import(
			"$lib/components/document-workspace/__fixtures__/fake-flush"
		);
		let answerSave: () => void = () => {};
		fakeFlush.mockReset().mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					answerSave = resolve;
				}),
		);
		ARTIFACT_BODIES.document = () =>
			import(
				"$lib/components/document-workspace/__fixtures__/FakeFlushingArtifactBody.svelte"
			);
		try {
			renderPage(
				pageData({
					artifacts: [
						{
							id: "doc-1",
							kind: "document",
							title: "Vienna trip plan",
							conversationId: "conv-1",
							versionNumber: 1,
							commentCount: 0,
							updatedAt: Date.now(),
						},
					],
				}),
			);
			await fireEvent.click(await screen.findByTestId("artifact-count-button"));
			const list = await screen.findByTestId("artifact-panel-list");
			await fireEvent.click(within(list).getByTestId("artifact-row"));
			await screen.findByTestId("fake-flushing-artifact-body");

			await fireEvent.input(screen.getByTestId("message-input"), {
				target: { value: "Rearrange this" },
			});
			await fireEvent.click(
				screen.getByRole("button", { name: "Send message" }),
			);

			// The step is being saved, and the message is not on its way yet.
			await waitFor(() => {
				expect(fakeFlush).toHaveBeenCalledTimes(1);
			});
			expect(runtimeHarness.streamInvocations).toHaveLength(0);

			answerSave();
			await waitFor(() => {
				expect(runtimeHarness.streamInvocations).toHaveLength(1);
			});
		} finally {
			delete ARTIFACT_BODIES.document;
		}
	});

	// Wave 2.5 polish G1-B (owner: "the version numbers are all over the place"),
	// ruling 76 (the numbers are gone; what is left is when and who): the list
	// row and the header's history button used to keep what they were loaded or
	// opened with. Every version the server reports through the artifacts client
	// (a save, a restore, History) now reaches both, with its time and author.
	it("keeps the panel header's history button and the list row on the latest moment the server last reported", async () => {
		const { recordDocumentWorkspaceOpen } = await import(
			"$lib/client/api/knowledge"
		);
		vi.mocked(recordDocumentWorkspaceOpen).mockResolvedValue(undefined);
		const { ARTIFACT_BODIES } = await import(
			"$lib/components/artifacts/artifact-bodies"
		);
		const { saveArtifactBody } = await import("$lib/client/api/artifacts");
		ARTIFACT_BODIES.document = () =>
			import(
				"$lib/components/document-workspace/__fixtures__/FakeArtifactBody.svelte"
			);
		try {
			renderPage(
				pageData({
					artifacts: [
						{
							id: "doc-1",
							kind: "document",
							title: "Vienna trip plan",
							conversationId: "conv-1",
							versionNumber: 1,
							commentCount: 0,
							updatedAt: Date.now() - 10 * 60 * 1000,
							lastAuthor: "alfy",
							lastKind: "first_draft",
						},
					],
				}),
			);

			await fireEvent.click(await screen.findByTestId("artifact-count-button"));
			const list = await screen.findByTestId("artifact-panel-list");
			expect(within(list).getByTestId("artifact-row")).toHaveTextContent(
				"10 min ago",
			);
			await fireEvent.click(within(list).getByTestId("artifact-row"));

			const shell = await screen.findByRole("complementary", {
				name: WORKSPACE_LANDMARK,
			});
			await waitFor(() => {
				expect(
					within(shell).getByTestId("artifact-version-pill"),
				).toHaveTextContent("10 min ago");
			});

			// A save, somewhere in the panel, is answered with version 4.
			await saveArtifactBody(
				"doc-1",
				"New text.",
				1,
				"conv-1",
				vi.fn(
					async () =>
						new Response(JSON.stringify({ ok: true, version: 4 }), {
							headers: { "Content-Type": "application/json" },
						}),
				),
			);

			await waitFor(() => {
				expect(
					within(shell).getByTestId("artifact-version-pill"),
				).toHaveTextContent("just now");
			});
			// A late, older answer never pulls it back.
			await saveArtifactBody(
				"doc-1",
				"Older text.",
				1,
				"conv-1",
				vi.fn(
					async () =>
						new Response(JSON.stringify({ ok: true, version: 2 }), {
							headers: { "Content-Type": "application/json" },
						}),
				),
			);
			expect(
				within(shell).getByTestId("artifact-version-pill"),
			).toHaveTextContent("just now");

			// Back to the list: its row says the same time, and never a number.
			await fireEvent.click(
				within(shell).getByRole("button", {
					name: "Back to this chat's items",
				}),
			);
			const listAgain = await screen.findByTestId("artifact-panel-list");
			expect(within(listAgain).getByTestId("artifact-row")).toHaveTextContent(
				"just now",
			);
			expect(
				within(listAgain).getByTestId("artifact-row"),
			).not.toHaveTextContent(/\bv\d/);
		} finally {
			delete ARTIFACT_BODIES.document;
		}
	});

	// Polish G2-A (the artifact-chat-card e2e raced on it): an edit_artifact
	// call finishing mid-turn asks for a fresh conversation detail, and the
	// turn's final stream metadata then moves the freshness boundary. When the
	// answer lands after that it used to be dropped whole, so the list (and the
	// chat card built on it) kept the version from before the edit until a
	// reload. The stream metadata carries no artifact list, so the answer's
	// list is applied whichever side of the boundary it lands on.
	it("shows the change an edit made during the turn even when the turn's final metadata lands before the refresh answers", async () => {
		let answerDetail: (
			detail: Awaited<ReturnType<typeof fetchConversationDetail>>,
		) => void = () => {};
		vi.mocked(fetchConversationDetail).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					answerDetail = resolve;
				}),
		);
		const summary = {
			id: "doc-1",
			kind: "document" as const,
			title: "Trip plan",
			conversationId: "conv-1",
			versionNumber: 1,
			commentCount: 0,
			updatedAt: Date.now() - 10 * 60 * 1000,
		};
		renderPage(pageData({ artifacts: [summary] }));

		await fireEvent.input(screen.getByTestId("message-input"), {
			target: { value: "Tighten the plan" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "Send message" }));
		const { callbacks } = runtimeHarness.streamInvocations[0];

		// The edit finishes: the page asks for a fresh detail. It is not
		// answered yet.
		callbacks.onToolCall?.(
			"edit_artifact",
			{ artifactId: "doc-1", patches: [] },
			"done",
			{ callId: "call-1" },
		);
		await waitFor(() => {
			expect(fetchConversationDetail).toHaveBeenCalled();
		});

		// The turn ends first; its metadata moves the freshness boundary.
		callbacks.onToken("Applied.");
		callbacks.onEnd("Applied.", {
			userMessageId: "server-user-1",
			assistantMessageId: "assistant-1",
			totalTokens: 12,
		});

		// Now the refresh answers: the edit made version 2.
		answerDetail(
			conversationDetailFixture({
				artifacts: [{ ...summary, versionNumber: 2, updatedAt: Date.now() }],
			}),
		);

		await fireEvent.click(await screen.findByTestId("artifact-count-button"));
		const list = await screen.findByTestId("artifact-panel-list");
		await waitFor(() => {
			expect(within(list).getByTestId("artifact-row")).toHaveTextContent(
				"just now",
			);
		});
	});

	// The other side of applying that list whatever the boundary says: an answer
	// that was asked for before an item was deleted here still lists it, and
	// must not bring it back.
	it("keeps an item deleted here deleted when a refresh asked for before the delete answers after it", async () => {
		const { deleteArtifact } = await import("$lib/client/api/artifacts");
		let answerDetail: (
			detail: Awaited<ReturnType<typeof fetchConversationDetail>>,
		) => void = () => {};
		vi.mocked(fetchConversationDetail).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					answerDetail = resolve;
				}),
		);
		const summary = (id: string, title: string) => ({
			id,
			kind: "document" as const,
			title,
			conversationId: "conv-1",
			versionNumber: 1,
			commentCount: 0,
			updatedAt: Date.now(),
		});
		renderPage(pageData({ artifacts: [summary("doc-1", "Trip plan")] }));

		await fireEvent.input(screen.getByTestId("message-input"), {
			target: { value: "Tighten the plan" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "Send message" }));
		runtimeHarness.streamInvocations[0].callbacks.onToolCall?.(
			"create_artifact",
			{ artifactType: "document", title: "Packing list", body: "- socks" },
			"done",
			{ callId: "call-1" },
		);
		await waitFor(() => {
			expect(fetchConversationDetail).toHaveBeenCalled();
		});

		// Meanwhile the first item is deleted here.
		await deleteArtifact(
			"doc-1",
			"conv-1",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ ok: true }), {
						headers: { "Content-Type": "application/json" },
					}),
			),
		);
		await waitFor(() => {
			expect(screen.queryByTestId("artifact-count-button")).toBeNull();
		});

		// The answer was asked for before that: it still lists the deleted item,
		// and lists the new one the turn made.
		answerDetail(
			conversationDetailFixture({
				artifacts: [
					summary("doc-1", "Trip plan"),
					summary("doc-2", "Packing list"),
				],
				// The server's own answer at that time: nothing deleted yet.
				deletedArtifactIds: [],
			}),
		);

		await fireEvent.click(await screen.findByTestId("artifact-count-button"));
		const list = await screen.findByTestId("artifact-panel-list");
		const rows = within(list).getAllByTestId("artifact-row");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toHaveTextContent("Packing list");
	});

	// Polish G2-A: "edited 2 min ago" (the header's meta line) and the list
	// row's time were still the snapshot taken when the item was loaded or
	// opened. They follow the same announcements the version does.
	it("keeps the header's edit time and the list row's time on the last change the browser heard about", async () => {
		const { recordDocumentWorkspaceOpen } = await import(
			"$lib/client/api/knowledge"
		);
		vi.mocked(recordDocumentWorkspaceOpen).mockResolvedValue(undefined);
		const { ARTIFACT_BODIES } = await import(
			"$lib/components/artifacts/artifact-bodies"
		);
		const { saveArtifactBody } = await import("$lib/client/api/artifacts");
		ARTIFACT_BODIES.document = () =>
			import(
				"$lib/components/document-workspace/__fixtures__/FakeArtifactBody.svelte"
			);
		try {
			renderPage(
				pageData({
					artifacts: [
						{
							id: "doc-1",
							kind: "document",
							title: "Vienna trip plan",
							conversationId: "conv-1",
							versionNumber: 1,
							commentCount: 0,
							// Three hours ago.
							updatedAt: Date.now() - 3 * 60 * 60 * 1000,
						},
					],
				}),
			);

			await fireEvent.click(await screen.findByTestId("artifact-count-button"));
			const list = await screen.findByTestId("artifact-panel-list");
			expect(within(list).getByTestId("artifact-row")).toHaveTextContent(
				"3 h ago",
			);
			await fireEvent.click(within(list).getByTestId("artifact-row"));
			const shell = await screen.findByRole("complementary", {
				name: WORKSPACE_LANDMARK,
			});
			// An older server says nothing of who: the header says when.
			await waitFor(() => {
				expect(shell).toHaveTextContent("3 h ago");
			});

			// A save, somewhere in the panel, is acknowledged.
			await saveArtifactBody(
				"doc-1",
				"New text.",
				1,
				"conv-1",
				vi.fn(
					async () =>
						new Response(JSON.stringify({ ok: true, version: 2 }), {
							headers: { "Content-Type": "application/json" },
						}),
				),
			);
			await waitFor(() => {
				expect(shell).toHaveTextContent("just now");
			});

			await fireEvent.click(
				within(shell).getByRole("button", {
					name: "Back to this chat's items",
				}),
			);
			const listAgain = await screen.findByTestId("artifact-panel-list");
			expect(within(listAgain).getByTestId("artifact-row")).toHaveTextContent(
				"just now",
			);
		} finally {
			delete ARTIFACT_BODIES.document;
		}
	});

	// Polish G2-A: Delete for what is open in the panel. The page deletes; the
	// panel goes back to the list without the item, the count follows, and a
	// short toast says so. (What the chat cards do with the deletion is the
	// next test.)
	it("deletes the open item from the panel header, returns to the list without it and says so", async () => {
		const { recordDocumentWorkspaceOpen } = await import(
			"$lib/client/api/knowledge"
		);
		vi.mocked(recordDocumentWorkspaceOpen).mockResolvedValue(undefined);
		const { ARTIFACT_BODIES } = await import(
			"$lib/components/artifacts/artifact-bodies"
		);
		const { toasts, clearToasts } = await import("$lib/stores/toast");
		clearToasts();
		ARTIFACT_BODIES.document = () =>
			import(
				"$lib/components/document-workspace/__fixtures__/FakeArtifactBody.svelte"
			);
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				new Response(JSON.stringify({ ok: true }), {
					headers: { "Content-Type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			renderPage(
				pageData({
					artifacts: [
						{
							id: "doc-1",
							kind: "document",
							title: "Vienna trip plan",
							conversationId: "conv-1",
							versionNumber: 1,
							commentCount: 0,
							updatedAt: Date.now(),
						},
						{
							id: "doc-2",
							kind: "document",
							title: "Packing list",
							conversationId: "conv-1",
							versionNumber: 1,
							commentCount: 0,
							updatedAt: Date.now() - 1000,
						},
					],
				}),
			);

			const countButton = await screen.findByTestId("artifact-count-button");
			await fireEvent.click(countButton);
			const list = await screen.findByTestId("artifact-panel-list");
			// The newest row first: Vienna trip plan.
			await fireEvent.click(within(list).getAllByTestId("artifact-row")[0]);
			const shell = await screen.findByRole("complementary", {
				name: WORKSPACE_LANDMARK,
			});
			await fireEvent.click(
				await within(shell).findByRole("button", { name: "Delete document" }),
			);
			const dialog = await screen.findByRole("dialog", {
				name: "Delete this document?",
			});
			await fireEvent.click(
				within(dialog).getByRole("button", { name: "Delete" }),
			);

			await waitFor(() => {
				expect(fetchMock).toHaveBeenCalledWith(
					"/api/artifacts/doc-1?conversationId=conv-1",
					{ method: "DELETE" },
				);
			});
			const listAfter = await screen.findByTestId("artifact-panel-list");
			expect(
				within(listAfter).queryByText("Vienna trip plan"),
			).not.toBeInTheDocument();
			expect(within(listAfter).getByText("Packing list")).toBeInTheDocument();
			expect(countButton).toHaveAccessibleName(/\(1\)/);
			expect(get(toasts).map((toast) => toast.message)).toContain(
				"Document deleted",
			);
		} finally {
			vi.unstubAllGlobals();
			delete ARTIFACT_BODIES.document;
		}
	});

	it("closes the panel when the item just deleted was the only one", async () => {
		const { recordDocumentWorkspaceOpen } = await import(
			"$lib/client/api/knowledge"
		);
		vi.mocked(recordDocumentWorkspaceOpen).mockResolvedValue(undefined);
		const { ARTIFACT_BODIES } = await import(
			"$lib/components/artifacts/artifact-bodies"
		);
		ARTIFACT_BODIES.document = () =>
			import(
				"$lib/components/document-workspace/__fixtures__/FakeArtifactBody.svelte"
			);
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ ok: true }), {
						headers: { "Content-Type": "application/json" },
					}),
			),
		);
		try {
			renderPage(
				pageData({
					artifacts: [
						{
							id: "doc-1",
							kind: "document",
							title: "Vienna trip plan",
							conversationId: "conv-1",
							versionNumber: 1,
							commentCount: 0,
							updatedAt: Date.now(),
						},
					],
				}),
			);

			await fireEvent.click(await screen.findByTestId("artifact-count-button"));
			const list = await screen.findByTestId("artifact-panel-list");
			await fireEvent.click(within(list).getByTestId("artifact-row"));
			const shell = await screen.findByRole("complementary", {
				name: WORKSPACE_LANDMARK,
			});
			await fireEvent.click(
				await within(shell).findByRole("button", { name: "Delete document" }),
			);
			const dialog = await screen.findByRole("dialog", {
				name: "Delete this document?",
			});
			await fireEvent.click(
				within(dialog).getByRole("button", { name: "Delete" }),
			);

			await waitFor(() => {
				expect(screen.queryByTestId("workspace-main")).not.toBeInTheDocument();
			});
			expect(screen.queryByTestId("artifact-count-button")).toBeNull();
		} finally {
			vi.unstubAllGlobals();
			delete ARTIFACT_BODIES.document;
		}
	});

	// Polish G2-A: what a chat card does once its item is gone — from the server
	// (a reload), live (an Open that finds it gone), and Regenerate.
	describe("cards of deleted items", () => {
		function createDocumentMessage() {
			return {
				id: "assistant-art-1",
				role: "assistant" as const,
				content: "I made you a plan.",
				timestamp: 1,
				thinkingSegments: [
					{
						type: "tool_call" as const,
						callId: "call-1",
						name: "create_artifact",
						input: {
							artifactType: "document",
							title: "Vienna trip plan",
							body: "# Plan",
						},
						status: "done" as const,
						outputSummary: 'Created Document "Vienna trip plan"',
						metadata: {
							ok: true,
							artifactId: "doc-1",
							artifactKind: "document",
							artifactTitle: "Vienna trip plan",
						},
					},
				],
			};
		}

		const documentSummary = () => ({
			id: "doc-1",
			kind: "document" as const,
			title: "Vienna trip plan",
			conversationId: "conv-1",
			versionNumber: 1,
			commentCount: 0,
			updatedAt: Date.now(),
		});

		function jsonResponse(body: unknown, status = 200) {
			return new Response(JSON.stringify(body), {
				status,
				headers: { "Content-Type": "application/json" },
			});
		}

		it("shows a card the server says is deleted as deleted — muted, no Open, with Regenerate", async () => {
			renderPage(
				pageData({
					messages: [createDocumentMessage()],
					artifacts: [],
					deletedArtifactIds: ["doc-1"],
				}),
			);

			const card = await screen.findByTestId("artifact-card");
			expect(card).toHaveAttribute("data-state", "deleted");
			expect(card).toHaveTextContent("This document was deleted");
			expect(screen.queryByTestId("artifact-card-head")).toBeNull();
			expect(
				within(card).getByRole("button", {
					name: "Regenerate Vienna trip plan",
				}),
			).toBeInTheDocument();
		});

		it("flips a card to deleted when its Open finds the item gone, without opening the panel", async () => {
			const { toasts, clearToasts } = await import("$lib/stores/toast");
			clearToasts();
			const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
				String(input).startsWith("/api/artifacts/")
					? jsonResponse({ ok: false, reason: "not_found" }, 404)
					: jsonResponse({}),
			);
			vi.stubGlobal("fetch", fetchMock);
			try {
				renderPage(
					pageData({
						messages: [createDocumentMessage()],
						artifacts: [documentSummary()],
					}),
				);

				await fireEvent.click(await screen.findByTestId("artifact-card-head"));

				await waitFor(() => {
					expect(screen.getByTestId("artifact-card")).toHaveAttribute(
						"data-state",
						"deleted",
					);
				});
				expect(fetchMock).toHaveBeenCalledWith(
					"/api/artifacts/doc-1?conversationId=conv-1",
				);
				expect(screen.queryByTestId("workspace-main")).toBeNull();
				// The header's count follows: nothing is left to list.
				expect(screen.queryByTestId("artifact-count-button")).toBeNull();
				// A card that flips on its own is announced, not just repainted.
				expect(get(toasts).map((toast) => toast.message)).toContain(
					"This document was deleted",
				);
			} finally {
				vi.unstubAllGlobals();
			}
		});

		// The security review's M1: an item that EXISTS but sits out of this
		// chat's reach (the parent of a forked incognito chat) is not deleted —
		// the card says where it was made, and offers neither Open nor Regenerate.
		it("shows a card whose item exists out of this chat's reach as made in the original chat, not deleted", async () => {
			renderPage(
				pageData({
					messages: [createDocumentMessage()],
					artifacts: [],
					unreachableArtifactIds: ["doc-1"],
				}),
			);

			const card = await screen.findByTestId("artifact-card");
			expect(card).toHaveAttribute("data-state", "unreachable");
			expect(card).toHaveTextContent("Vienna trip plan");
			expect(card).toHaveTextContent("Made in the original chat");
			expect(card).not.toHaveTextContent("deleted");
			expect(screen.queryByTestId("artifact-card-head")).toBeNull();
			expect(
				within(card).queryByRole("button", { name: /Regenerate/ }),
			).toBeNull();
		});

		it("does not call an item deleted when its Open's 404 turns out to be 'out of reach' once the server is asked", async () => {
			const { toasts, clearToasts } = await import("$lib/stores/toast");
			clearToasts();
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: RequestInfo | URL) =>
					String(input).startsWith("/api/artifacts/")
						? jsonResponse({ ok: false, reason: "not_found" }, 404)
						: jsonResponse({}),
				),
			);
			// Its chat became incognito after this page loaded: the read misses, but
			// the item is still there.
			vi.mocked(fetchConversationDetail).mockResolvedValueOnce(
				conversationDetailFixture({
					messages: [createDocumentMessage()],
					artifacts: [],
					deletedArtifactIds: [],
					unreachableArtifactIds: ["doc-1"],
				}),
			);
			try {
				renderPage(
					pageData({
						messages: [createDocumentMessage()],
						artifacts: [documentSummary()],
					}),
				);

				await fireEvent.click(await screen.findByTestId("artifact-card-head"));

				await waitFor(() => {
					expect(screen.getByTestId("artifact-card")).toHaveAttribute(
						"data-state",
						"unreachable",
					);
				});
				expect(screen.queryByTestId("workspace-main")).toBeNull();
				expect(get(toasts).map((toast) => toast.message)).not.toContain(
					"This document was deleted",
				);
			} finally {
				vi.unstubAllGlobals();
			}
		});

		it("turns a deleted card into 'made in the original chat' when Regenerate is refused because the item still exists", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () =>
					jsonResponse({ ok: false, reason: "unreachable" }, 409),
				),
			);
			try {
				renderPage(
					pageData({
						messages: [createDocumentMessage()],
						artifacts: [],
						deletedArtifactIds: ["doc-1"],
					}),
				);

				await fireEvent.click(
					await screen.findByRole("button", {
						name: "Regenerate Vienna trip plan",
					}),
				);

				await waitFor(() => {
					expect(screen.getByTestId("artifact-card")).toHaveAttribute(
						"data-state",
						"unreachable",
					);
				});
				expect(screen.getByTestId("artifact-card")).toHaveTextContent(
					"Made in the original chat",
				);
				expect(
					screen.queryByRole("button", { name: /Regenerate Vienna trip plan/ }),
				).not.toBeInTheDocument();
			} finally {
				vi.unstubAllGlobals();
			}
		});

		it("still opens an item that exists", async () => {
			const { recordDocumentWorkspaceOpen } = await import(
				"$lib/client/api/knowledge"
			);
			vi.mocked(recordDocumentWorkspaceOpen).mockResolvedValue(undefined);
			const { ARTIFACT_BODIES } = await import(
				"$lib/components/artifacts/artifact-bodies"
			);
			ARTIFACT_BODIES.document = () =>
				import(
					"$lib/components/document-workspace/__fixtures__/FakeArtifactBody.svelte"
				);
			vi.stubGlobal(
				"fetch",
				vi.fn(async () =>
					jsonResponse({
						ok: true,
						artifact: { ...documentSummary(), body: "# Plan", bodyHash: "h" },
						versions: [],
						comments: [],
					}),
				),
			);
			try {
				renderPage(
					pageData({
						messages: [createDocumentMessage()],
						artifacts: [documentSummary()],
					}),
				);

				await fireEvent.click(await screen.findByTestId("artifact-card-head"));

				await screen.findByRole("complementary", {
					name: WORKSPACE_LANDMARK,
				});
				expect(screen.getByTestId("artifact-card")).not.toHaveAttribute(
					"data-state",
				);
			} finally {
				vi.unstubAllGlobals();
				delete ARTIFACT_BODIES.document;
			}
		});

		// The panel's list state wins over an open item, so an Open that only
		// added the item to the panel's tabs left the reader on the list: pressing
		// a card's Open with "what this chat made" showing did nothing.
		it("leaves the panel's list for the item when a card's Open is pressed while the list shows", async () => {
			const { recordDocumentWorkspaceOpen } = await import(
				"$lib/client/api/knowledge"
			);
			vi.mocked(recordDocumentWorkspaceOpen).mockResolvedValue(undefined);
			const { ARTIFACT_BODIES } = await import(
				"$lib/components/artifacts/artifact-bodies"
			);
			ARTIFACT_BODIES.document = () =>
				import(
					"$lib/components/document-workspace/__fixtures__/FakeArtifactBody.svelte"
				);
			vi.stubGlobal(
				"fetch",
				vi.fn(async () =>
					jsonResponse({
						ok: true,
						artifact: { ...documentSummary(), body: "# Plan", bodyHash: "h" },
						versions: [],
						comments: [],
					}),
				),
			);
			try {
				renderPage(
					pageData({
						messages: [createDocumentMessage()],
						artifacts: [documentSummary()],
					}),
				);

				await fireEvent.click(
					await screen.findByTestId("artifact-count-button"),
				);
				await screen.findByTestId("artifact-panel-list");
				expect(
					screen.queryByRole("complementary", { name: WORKSPACE_LANDMARK }),
				).toBeNull();

				await fireEvent.click(screen.getByTestId("artifact-card-head"));

				const panel = await screen.findByRole("complementary", {
					name: WORKSPACE_LANDMARK,
				});
				expect(
					within(panel).getByTestId("artifact-panel-title"),
				).toHaveTextContent("Vienna trip plan");
				expect(screen.queryByTestId("artifact-panel-list")).toBeNull();
				// The item is what the panel shows now, so its card says so.
				expect(screen.getByTestId("artifact-card-head")).toHaveTextContent(
					"Open in panel",
				);
			} finally {
				vi.unstubAllGlobals();
				delete ARTIFACT_BODIES.document;
			}
		});

		// The security review's L2: the panel's Delete confirm promises "you can
		// regenerate it from the chat" only for an item the chat can make again —
		// one the server says so of (`ArtifactCardSummary.regenerable`, read off the
		// messages it has persisted), or one the messages this page holds carry the
		// create call of (final polish D4: the turn that just ended, whose message
		// the last server read did not have yet).
		it.each([
			// [what the server said, whether the page's messages carry the create call, the promise made, the one not made]
			[true, false, "You can regenerate it from the chat.", "can't be undone"],
			[undefined, false, "This can't be undone.", "regenerate it"],
			[
				undefined,
				true,
				"You can regenerate it from the chat.",
				"can't be undone",
			],
		] as const)("tells a list row's delete confirm whether the chat can make it again (server: %s, create call in the page's messages: %s)", async (regenerable, callInMessages, promised, notPromised) => {
			renderPage(
				pageData({
					messages: [
						callInMessages
							? createDocumentMessage()
							: { ...createDocumentMessage(), thinkingSegments: [] },
					],
					artifacts: [{ ...documentSummary(), regenerable }],
				}),
			);

			await fireEvent.click(await screen.findByTestId("artifact-count-button"));
			const list = await screen.findByTestId("artifact-panel-list");
			await fireEvent.click(
				within(list).getByRole("button", {
					name: "More actions for Vienna trip plan",
				}),
			);
			await fireEvent.click(
				await screen.findByRole("menuitem", { name: "Delete document" }),
			);

			const dialog = await screen.findByRole("dialog", {
				name: "Delete this document?",
			});
			expect(dialog.textContent).toContain(promised);
			expect(dialog.textContent).not.toContain(notPromised);
		});

		// The security review's L1: a fork's card can name (and open) the parent's
		// Document, but Delete acts only on what this chat made — the panel does
		// not offer it, and the item says where it was made.
		describe("Delete on an item opened from a card", () => {
			async function openFromCard(madeIn: string, listed: boolean) {
				const { recordDocumentWorkspaceOpen } = await import(
					"$lib/client/api/knowledge"
				);
				vi.mocked(recordDocumentWorkspaceOpen).mockResolvedValue(undefined);
				const { ARTIFACT_BODIES } = await import(
					"$lib/components/artifacts/artifact-bodies"
				);
				ARTIFACT_BODIES.document = () =>
					import(
						"$lib/components/document-workspace/__fixtures__/FakeArtifactBody.svelte"
					);
				vi.stubGlobal(
					"fetch",
					vi.fn(async () =>
						jsonResponse({
							ok: true,
							artifact: {
								...documentSummary(),
								conversationId: madeIn,
								body: "# Plan",
								bodyHash: "h",
							},
							versions: [],
							comments: [],
						}),
					),
				);
				renderPage(
					pageData({
						messages: [createDocumentMessage()],
						artifacts: listed ? [documentSummary()] : [],
					}),
				);
				await fireEvent.click(await screen.findByTestId("artifact-card-head"));
				return screen.findByRole("complementary", {
					name: WORKSPACE_LANDMARK,
				});
			}

			it("offers none for the parent's Document, which another chat made", async () => {
				const { ARTIFACT_BODIES } = await import(
					"$lib/components/artifacts/artifact-bodies"
				);
				try {
					const shell = await openFromCard("conv-parent", false);

					await screen.findByTestId("fake-artifact-body");
					expect(
						within(shell).queryByRole("button", { name: "Delete document" }),
					).not.toBeInTheDocument();
				} finally {
					vi.unstubAllGlobals();
					delete ARTIFACT_BODIES.document;
				}
			});

			it("offers it for this chat's own Document", async () => {
				const { ARTIFACT_BODIES } = await import(
					"$lib/components/artifacts/artifact-bodies"
				);
				try {
					const shell = await openFromCard("conv-1", true);

					await screen.findByTestId("fake-artifact-body");
					expect(
						within(shell).getByRole("button", { name: "Delete document" }),
					).toBeInTheDocument();
				} finally {
					vi.unstubAllGlobals();
					delete ARTIFACT_BODIES.document;
				}
			});
		});

		it("makes it again on Regenerate, and the card is a card again", async () => {
			const { toasts, clearToasts } = await import("$lib/stores/toast");
			clearToasts();
			const fetchMock = vi.fn(async () =>
				jsonResponse({
					ok: true,
					created: true,
					artifactId: "doc-1",
					kind: "document",
					title: "Vienna trip plan",
				}),
			);
			vi.stubGlobal("fetch", fetchMock);
			vi.mocked(fetchConversationDetail).mockResolvedValueOnce(
				conversationDetailFixture({
					messages: [createDocumentMessage()],
					artifacts: [documentSummary()],
					deletedArtifactIds: [],
				}),
			);
			try {
				renderPage(
					pageData({
						messages: [createDocumentMessage()],
						artifacts: [],
						deletedArtifactIds: ["doc-1"],
					}),
				);

				await fireEvent.click(
					await screen.findByRole("button", {
						name: "Regenerate Vienna trip plan",
					}),
				);

				await waitFor(() => {
					expect(fetchMock).toHaveBeenCalledWith(
						"/api/conversations/conv-1/artifacts/doc-1/regenerate",
						expect.objectContaining({ method: "POST" }),
					);
				});
				await waitFor(() => {
					expect(screen.getByTestId("artifact-card")).not.toHaveAttribute(
						"data-state",
					);
				});
				expect(screen.getByTestId("artifact-card-head")).toBeInTheDocument();
				expect(screen.getByTestId("artifact-count-button")).toBeInTheDocument();
				expect(get(toasts).map((toast) => toast.message)).toContain(
					"Regenerated “Vienna trip plan”",
				);
			} finally {
				vi.unstubAllGlobals();
			}
		});

		it("says why when there is nothing to make it again from", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () =>
					jsonResponse({ ok: false, reason: "no_stored_input" }, 409),
				),
			);
			try {
				renderPage(
					pageData({
						messages: [createDocumentMessage()],
						artifacts: [],
						deletedArtifactIds: ["doc-1"],
					}),
				);

				await fireEvent.click(
					await screen.findByRole("button", {
						name: "Regenerate Vienna trip plan",
					}),
				);

				expect(
					await screen.findByText(
						"It can't be regenerated: the original request wasn't kept.",
					),
				).toBeInTheDocument();
				expect(
					screen.queryByRole("button", { name: /Regenerate Vienna trip plan/ }),
				).not.toBeInTheDocument();
			} finally {
				vi.unstubAllGlobals();
			}
		});

		it("keeps the card deleted, and offers Regenerate again, when making it fails", async () => {
			const { toasts, clearToasts } = await import("$lib/stores/toast");
			clearToasts();
			vi.stubGlobal(
				"fetch",
				vi.fn(async () =>
					jsonResponse({ ok: false, reason: "failed", detail: "Nope." }, 422),
				),
			);
			try {
				renderPage(
					pageData({
						messages: [createDocumentMessage()],
						artifacts: [],
						deletedArtifactIds: ["doc-1"],
					}),
				);

				await fireEvent.click(
					await screen.findByRole("button", {
						name: "Regenerate Vienna trip plan",
					}),
				);

				await waitFor(() => {
					expect(get(toasts).map((toast) => toast.message)).toContain(
						"Couldn't regenerate this. Try again.",
					);
				});
				expect(screen.getByTestId("artifact-card")).toHaveAttribute(
					"data-state",
					"deleted",
				);
				expect(
					screen.getByRole("button", { name: "Regenerate Vienna trip plan" }),
				).toBeEnabled();
			} finally {
				vi.unstubAllGlobals();
			}
		});
	});

	// Polish G2-A: a produced file deleted from the panel leaves its row in the
	// chat as a deleted file, and Regenerate queues the same job again.
	describe("produced files that were deleted", () => {
		const producedFile = {
			id: "chat-file-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-file-1",
			artifactId: "file-artifact-1",
			documentFamilyId: null,
			documentFamilyStatus: null,
			documentLabel: null,
			documentRole: null,
			versionNumber: 1,
			originConversationId: null,
			originAssistantMessageId: null,
			sourceChatFileId: null,
			filename: "Trip summary.pdf",
			mimeType: "application/pdf",
			sizeBytes: 2048,
			createdAt: 1,
		};
		const fileSummary = {
			id: "file-artifact-1",
			kind: "file" as const,
			title: "Trip summary.pdf",
			conversationId: "conv-1",
			versionNumber: 0,
			commentCount: 0,
			updatedAt: Date.now(),
		};
		const jobBase = {
			id: "job-file-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-file-1",
			title: "Trip summary",
			status: "succeeded" as const,
			stage: null,
			createdAt: 1,
			updatedAt: 2,
			warnings: [],
			dismissed: false,
			error: null,
			sourceMode: null,
		};
		const message = {
			id: "assistant-file-1",
			role: "assistant" as const,
			content: "Here is the trip summary.",
			timestamp: 1,
		};

		it("shows the file's row as deleted once the panel has deleted it, and Regenerate queues the same job", async () => {
			const { regenerateFileProductionJob } = await import(
				"$lib/client/api/file-production"
			);
			vi.mocked(regenerateFileProductionJob).mockResolvedValue({
				...jobBase,
				status: "queued",
				files: [],
			});
			vi.mocked(fetchConversationDetail).mockResolvedValueOnce(
				conversationDetailFixture({
					messages: [message],
					generatedFiles: [],
					artifacts: [],
					fileProductionJobs: [
						{
							...jobBase,
							files: [],
							filesDeleted: { canRegenerate: true },
						},
					],
				}),
			);
			const fetchMock = vi.fn(
				async (_input: RequestInfo | URL, _init?: RequestInit) =>
					new Response(JSON.stringify({ ok: true }), {
						headers: { "Content-Type": "application/json" },
					}),
			);
			vi.stubGlobal("fetch", fetchMock);
			try {
				renderPage(
					pageData({
						messages: [message],
						generatedFiles: [producedFile],
						artifacts: [fileSummary],
						fileProductionJobs: [
							{
								...jobBase,
								files: [
									{
										id: "chat-file-1",
										filename: "Trip summary.pdf",
										mimeType: "application/pdf",
										sizeBytes: 2048,
										downloadUrl: "/api/chat/files/chat-file-1/download",
										previewUrl: "/api/chat/files/chat-file-1/preview",
										artifactId: "file-artifact-1",
									},
								],
							},
						],
					}),
				);

				await fireEvent.click(
					await screen.findByTestId("artifact-count-button"),
				);
				const list = await screen.findByTestId("artifact-panel-list");
				await fireEvent.click(
					within(list).getByRole("button", {
						name: "More actions for Trip summary.pdf",
					}),
				);
				await fireEvent.click(
					await screen.findByRole("menuitem", { name: "Delete file" }),
				);
				const dialog = await screen.findByRole("dialog", {
					name: "Delete this file?",
				});
				await fireEvent.click(
					within(dialog).getByRole("button", { name: "Delete" }),
				);

				await waitFor(() => {
					expect(fetchMock).toHaveBeenCalledWith(
						"/api/artifacts/file-artifact-1?conversationId=conv-1",
						{ method: "DELETE" },
					);
				});
				const row = await screen.findByTestId("file-row-deleted");
				expect(row).toHaveTextContent("Trip summary");
				expect(row).toHaveTextContent("The file has been deleted");

				await fireEvent.click(
					within(row).getByRole("button", { name: "Regenerate Trip summary" }),
				);

				await waitFor(() => {
					expect(regenerateFileProductionJob).toHaveBeenCalledWith(
						"job-file-1",
					);
				});
				// The same job, queued again: the deleted row gives way to the work.
				await waitFor(() => {
					expect(screen.queryByTestId("file-row-deleted")).toBeNull();
				});
			} finally {
				vi.unstubAllGlobals();
			}
		});

		it("flips a file's row to deleted when its Open finds the file gone, without opening the panel", async () => {
			const { toasts, clearToasts } = await import("$lib/stores/toast");
			clearToasts();
			vi.mocked(fetchConversationDetail).mockResolvedValueOnce(
				conversationDetailFixture({
					messages: [message],
					generatedFiles: [],
					artifacts: [],
					fileProductionJobs: [
						{
							...jobBase,
							files: [],
							filesDeleted: { canRegenerate: true },
						},
					],
				}),
			);
			const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
				String(input).startsWith("/api/chat/files/")
					? new Response("{}", { status: 404 })
					: new Response("{}", {
							status: 200,
							headers: { "Content-Type": "application/json" },
						}),
			);
			vi.stubGlobal("fetch", fetchMock);
			try {
				renderPage(
					pageData({
						messages: [message],
						generatedFiles: [producedFile],
						artifacts: [fileSummary],
						fileProductionJobs: [
							{
								...jobBase,
								files: [
									{
										id: "chat-file-1",
										filename: "Trip summary.pdf",
										mimeType: "application/pdf",
										sizeBytes: 2048,
										downloadUrl: "/api/chat/files/chat-file-1/download",
										previewUrl: "/api/chat/files/chat-file-1/preview",
										artifactId: "file-artifact-1",
									},
								],
							},
						],
					}),
				);

				await fireEvent.click(
					await screen.findByRole("button", {
						name: "Preview Trip summary.pdf",
					}),
				);

				expect(await screen.findByTestId("file-row-deleted")).toHaveTextContent(
					"The file has been deleted",
				);
				expect(fetchMock).toHaveBeenCalledWith(
					"/api/chat/files/chat-file-1/preview",
					{ headers: { Range: "bytes=0-0" } },
				);
				expect(screen.queryByTestId("workspace-main")).toBeNull();
				expect(get(toasts).map((toast) => toast.message)).toContain(
					"The file has been deleted",
				);
			} finally {
				vi.unstubAllGlobals();
			}
		});

		it("shows a file that was deleted elsewhere as deleted straight from the server's answer", async () => {
			renderPage(
				pageData({
					messages: [message],
					generatedFiles: [],
					artifacts: [],
					fileProductionJobs: [
						{
							...jobBase,
							files: [],
							filesDeleted: { canRegenerate: false },
						},
					],
				}),
			);

			const row = await screen.findByTestId("file-row-deleted");
			expect(row).toHaveTextContent("The file has been deleted");
			expect(row).toHaveTextContent(
				"It can't be regenerated: the original request wasn't kept.",
			);
			expect(
				within(row).queryByRole("button", { name: /Regenerate/ }),
			).toBeNull();
		});

		it("asks once when Regenerate is pressed twice before the first answer comes back", async () => {
			const { regenerateFileProductionJob } = await import(
				"$lib/client/api/file-production"
			);
			vi.mocked(regenerateFileProductionJob).mockReset();
			let answer: (job: FileProductionJob) => void = () => {};
			vi.mocked(regenerateFileProductionJob).mockImplementation(
				() =>
					new Promise((resolve) => {
						answer = resolve;
					}),
			);
			renderPage(
				pageData({
					messages: [message],
					generatedFiles: [],
					artifacts: [],
					fileProductionJobs: [
						{
							...jobBase,
							files: [],
							filesDeleted: { canRegenerate: true },
						},
					],
				}),
			);

			const row = await screen.findByTestId("file-row-deleted");
			const regenerate = within(row).getByRole("button", {
				name: "Regenerate Trip summary",
			});
			await fireEvent.click(regenerate);
			await fireEvent.click(regenerate);

			// The second press must not become a second request: by then the job is
			// queued on the server, and it would be answered "nothing to regenerate".
			expect(regenerateFileProductionJob).toHaveBeenCalledTimes(1);

			answer({ ...jobBase, status: "queued", files: [] });
			await waitFor(() => {
				expect(screen.queryByTestId("file-row-deleted")).toBeNull();
			});
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
			screen.getByRole("button", { name: /Context window usage/i }),
		);

		expect(screen.getByText("$0.4200 · 42 tokens")).toBeInTheDocument();
		expect(screen.getByText("Sources included")).toBeInTheDocument();
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
					dismissed: false,
					sourceMode: null,
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

	// O1 — opening an already-populated conversation (the overwhelmingly
	// common case) must read+assemble the conversation detail exactly once.
	// The load (+page.ts) now requests the "full" view directly instead of a
	// cheap "first-render" payload the page always followed up with a full
	// client-side re-fetch, so `sidecarPending`/`bootstrap` are both `false`
	// on a normal open and the sidecar hydrate path below must not fire.
	it("does not fetch conversation detail again when mounting an already-populated, non-bootstrap conversation", async () => {
		// `fetchConversationDetail` is a module-scoped mock shared across this
		// file's tests, so its call history is cumulative — assert the delta
		// across this test's mount, the same idiom the stream-completion test
		// above uses, rather than an absolute zero.
		const callsBeforeMount = vi.mocked(fetchConversationDetail).mock.calls
			.length;
		renderPage(
			pageData({
				bootstrap: false,
				sidecarPending: false,
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

		// `resetState()` runs synchronously inside the mount `$effect`, so by
		// the time the DOM reflects the seeded message the
		// `bootstrapMode || sidecarPending` hydrate check has already run.
		// (An earlier version of this test additionally waited one real
		// `setTimeout(0)` tick here, which under a full-suite run raced
		// unrelated leftover timers from other tests in this file — e.g.
		// evidence-poll retries — that don't touch `fetchConversationDetail`
		// on their own schedule but could still tick during that window.)
		await waitFor(() => {
			expect(screen.getByText("Previous answer")).toBeInTheDocument();
		});

		expect(vi.mocked(fetchConversationDetail).mock.calls.length).toBe(
			callsBeforeMount,
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

	it("drops a files read-back for the chat the person left: the chat now shown keeps its own state", async () => {
		// A picture card's Another / Use this / Stop / Retry (and a board's
		// kept picture) read the chat's detail back through one function; its
		// answer for chat A must not land in chat B, opened meanwhile.
		const { announceChatFilesChanged } = await import(
			"$lib/client/api/artifacts"
		);
		const view = renderPage(pageData());
		let resolveDetail: (
			value: Awaited<ReturnType<typeof fetchConversationDetail>>,
		) => void = () => {};
		vi.mocked(fetchConversationDetail).mockReturnValueOnce(
			new Promise((resolve) => {
				resolveDetail = resolve;
			}),
		);
		announceChatFilesChanged("conv-1");
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
			}),
			params: { conversationId: "conv-2" },
		});
		resolveDetail({
			...conversationDetailFixture(),
			conversation: conversationFixture("conv-1"),
			artifacts: [
				{
					id: "artifact-a",
					kind: "image",
					title: "Chat A's picture",
					conversationId: "conv-1",
					versionNumber: 1,
					commentCount: 0,
					updatedAt: Date.now(),
				},
			],
			totalCostUsdMicros: 990_000,
			totalTokens: 99,
		});
		await Promise.resolve();
		await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(
			screen.queryByTestId("artifact-count-button"),
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
					dismissed: false,
					sourceMode: null,
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

		// The file row's card lazily imports FileProductionCard's body (Slice 0
		// Task S6); once it resolves, "report.pdf" legitimately appears twice —
		// once in the tool-activity row's own compact summary, once in the
		// card's file row. Forcing that import to settle here, instead of
		// guessing how many of the two have rendered by the time `waitFor`'s
		// polling happens to check, keeps this an exact assertion rather than
		// a "something rendered" one.
		await vi.dynamicImportSettled();
		await waitFor(() => {
			expect(screen.getAllByText("report.pdf")).toHaveLength(2);
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

		// The slow sidecar's empty generatedFiles/fileProductionJobs must not
		// overwrite the fresher stream-provided row (this test's own point), so
		// the same already-loaded card is still showing both occurrences.
		expect(screen.getAllByText("report.pdf")).toHaveLength(2);
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
			screen.getByRole("button", { name: /Context window usage/i }),
		);

		expect(screen.getByText("$0.4200 · 42 tokens")).toBeInTheDocument();
		expect(screen.getByText("Sources included")).toBeInTheDocument();
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
					screen.getByRole("button", { name: /^Sources$/i }),
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

	// Workspaces Slice E — the evidence answer carries two fields written
	// together by the server: the summary and the count of project files the
	// turn read. The summary drives the message's Sources panel and the count
	// drives the Info popover's "Project files" row; a poll that applied only
	// one of them left the row missing until a reload.
	it("applies the project-files count the evidence answer carries", async () => {
		vi.mocked(fetchMessageEvidence).mockResolvedValue({
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
								title: "Hotel Motto booking",
								sourceType: "document",
								status: "selected",
							},
						],
					},
				],
			},
			projectFilesRead: 2,
		});

		renderPage(
			pageData({
				messages: [
					{
						id: "assistant-project-evidence",
						role: "assistant",
						content: "Completed answer.",
						timestamp: 1,
						evidencePending: true,
					},
				],
			}),
		);

		await waitFor(() => {
			expect(
				screen.getByRole("button", { name: /Project files/ }),
			).toBeInTheDocument();
		});
	});

	// The Info popover's "Citation audit" row reads `citationAudit`, which a turn
	// persists when its message is created — before the terminal stream frame
	// (that frame carries no citation audit) and long before the evidence is
	// composed. The evidence poll is the live page's only channel for it, the
	// same way it is for the project-files count above.
	it("applies the citation audit the evidence answer carries", async () => {
		vi.mocked(fetchMessageEvidence).mockResolvedValue({
			status: "ready",
			evidenceSummary: {
				structuredWebSearch: false,
				groups: [
					{
						sourceType: "web",
						label: "Web Search",
						reranked: false,
						items: [
							{
								id: "evidence-1",
								title: "Hotel Motto stay details",
								sourceType: "web",
								status: "selected",
							},
						],
					},
				],
			},
			citationAudit: { cited: 2, verified: 1, repaired: 1, stripped: 0 },
		});

		renderPage(
			pageData({
				messages: [
					{
						id: "assistant-citation-evidence",
						role: "assistant",
						content: "Completed answer.",
						timestamp: 1,
						evidencePending: true,
					},
				],
			}),
		);

		await waitFor(() => {
			expect(screen.getByText("Citation audit")).toBeInTheDocument();
		});
		// A rewritten citation still counts as verified: after the repair pass
		// every surviving link is an exact source match or was rewritten to one.
		expect(screen.getByText("2 verified sources")).toBeInTheDocument();
	});

	// The branch question: a citation audit is NOT written with the evidence
	// summary — the turn persists it when its message is created, and the
	// summary is composed afterwards — so a turn whose evidence step finds
	// nothing (or fails) settles with an audit and no summary at all. The
	// answer then arrives with a citation audit and no summary field, which is
	// why the endpoint answers "ready" for it at all (a 204 would lose the row
	// until a reload) and why the page applies each field only when the answer
	// carries it: a citation-only answer must not invent a summary.
	it("applies a citation-only evidence answer without inventing a summary", async () => {
		vi.mocked(fetchMessageEvidence).mockResolvedValue({
			status: "ready",
			citationAudit: { cited: 1, verified: 1, repaired: 0, stripped: 0 },
		});

		renderPage(
			pageData({
				messages: [
					{
						id: "assistant-citation-only",
						role: "assistant",
						content: "Completed answer.",
						timestamp: 1,
						evidencePending: true,
					},
				],
			}),
		);

		await waitFor(() => {
			expect(screen.getByText("Citation audit")).toBeInTheDocument();
		});
		expect(screen.getByText("1 verified source")).toBeInTheDocument();
		// No summary on the message and none in the answer: the row is the
		// whole popover, and no "Sources" (evidence) direction appears.
		expect(
			screen.queryByRole("button", { name: /^Sources$/i }),
		).not.toBeInTheDocument();
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

// Issue 7.4 fix pass — the cloud-warning check + modal previously lived
// entirely inside MessageInput.svelte's local send() path, so regenerate,
// edit-then-resend, and retry (none of which touch that component) could
// dispatch to a cloud model with active connector capabilities without ever
// showing the warning. The gate now lives here, at the page
// (ensureCloudWarningAcked), and every fresh-send-to-model path is routed
// through it. These tests exercise that end to end against the real page.
describe("chat page cloud-connector warning gate (Issue 7.4 fix pass)", () => {
	afterEach(() => {
		clearAnimationFrameMockTimers();
		runtimeHarness.atlasFailure = null;
		runtimeHarness.orphanedStream = null;
		vi.restoreAllMocks();
	});

	beforeEach(() => {
		runtimeHarness.streamInvocations.length = 0;
		runtimeHarness.atlasSubmissions.length = 0;
		vi.mocked(fetchConversationDetail).mockResolvedValue(
			conversationDetailFixture(),
		);
		vi.mocked(fetchMessageEvidence).mockReset();
		fetchActiveCapabilitiesMock.mockReset().mockResolvedValue({
			served: ["calendar"],
			defaultOn: ["calendar"],
			accounts: [],
		});
		checkCloudWarningMock.mockReset();
		ackCloudConnectorMock.mockReset();
		setLocalDistillMock.mockReset();
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

	const CLOUD_MODEL_ID = "provider:abc:def" as ModelId;

	function cloudModelPageData(overrides: Record<string, unknown> = {}) {
		return pageData({
			userModel: CLOUD_MODEL_ID,
			availableModels: [
				{
					id: CLOUD_MODEL_ID,
					displayName: "Cloud Model",
					isThirdParty: true,
					iconAssetId: null,
					iconUrl: null,
				},
			],
			...overrides,
		});
	}

	function conversationTurnFixture() {
		return [
			{
				id: "user-1",
				role: "user" as const,
				content: "What's on my calendar?",
				timestamp: 1,
			},
			{
				id: "assistant-1",
				role: "assistant" as const,
				content: "You have a 2pm meeting.",
				timestamp: 2,
			},
		];
	}

	it("blocks a composer send behind the warning modal; Continue dispatches exactly once", async () => {
		checkCloudWarningMock.mockResolvedValue({ shouldWarn: true });
		ackCloudConnectorMock.mockResolvedValue(undefined);
		renderPage(cloudModelPageData());

		await waitFor(() => {
			expect(fetchActiveCapabilitiesMock).toHaveBeenCalled();
		});

		await fireEvent.input(screen.getByTestId("message-input"), {
			target: { value: "What's on my calendar?" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "Send message" }));

		await waitFor(() => {
			expect(checkCloudWarningMock).toHaveBeenCalledWith(CLOUD_MODEL_ID, [
				"calendar",
			]);
		});
		expect(
			await screen.findByTestId("cloud-connector-warning"),
		).toBeInTheDocument();
		expect(runtimeHarness.streamInvocations).toHaveLength(0);

		await fireEvent.click(screen.getByTestId("cloud-warning-send"));

		await waitFor(() => {
			expect(ackCloudConnectorMock).toHaveBeenCalled();
		});
		await waitFor(() => {
			expect(runtimeHarness.streamInvocations).toHaveLength(1);
		});
		expect(runtimeHarness.streamInvocations[0].message).toBe(
			"What's on my calendar?",
		);
	});

	it("does not bypass the warning on a double-send while the check is in flight", async () => {
		let resolveCheck: ((value: { shouldWarn: boolean }) => void) | undefined;
		checkCloudWarningMock.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveCheck = resolve;
				}),
		);
		renderPage(cloudModelPageData());

		await waitFor(() => {
			expect(fetchActiveCapabilitiesMock).toHaveBeenCalled();
		});

		const input = screen.getByTestId("message-input") as HTMLTextAreaElement;
		await fireEvent.input(input, { target: { value: "Race me" } });
		await fireEvent.click(screen.getByRole("button", { name: "Send message" }));

		await waitFor(() => {
			expect(checkCloudWarningMock).toHaveBeenCalledTimes(1);
		});

		// A second send via Enter while the first check is still unresolved
		// must be a no-op, not a second dispatch.
		await fireEvent.keyDown(input, { key: "Enter", shiftKey: false });

		expect(checkCloudWarningMock).toHaveBeenCalledTimes(1);
		expect(runtimeHarness.streamInvocations).toHaveLength(0);

		resolveCheck?.({ shouldWarn: false });

		await waitFor(() => {
			expect(runtimeHarness.streamInvocations).toHaveLength(1);
		});
	});

	it("routes a send queued behind an in-flight attachment upload through the warning gate", async () => {
		checkCloudWarningMock.mockResolvedValue({ shouldWarn: true });
		ackCloudConnectorMock.mockResolvedValue(undefined);
		const { uploadKnowledgeAttachment } = await import(
			"$lib/client/api/knowledge"
		);
		type KnowledgeUploadResponse = Awaited<
			ReturnType<typeof uploadKnowledgeAttachment>
		>;
		let resolveUpload: ((value: KnowledgeUploadResponse) => void) | undefined;
		vi.mocked(uploadKnowledgeAttachment).mockReturnValue(
			new Promise((resolve) => {
				resolveUpload = resolve;
			}),
		);
		renderPage(cloudModelPageData());

		await waitFor(() => {
			expect(fetchActiveCapabilitiesMock).toHaveBeenCalled();
		});

		const input = screen.getByTestId("message-input") as HTMLTextAreaElement;
		await fireEvent.input(input, {
			target: { value: "Cloud data while uploading" },
		});
		const fileInput = document.querySelector(
			'input[type="file"]',
		) as HTMLInputElement;
		await fireEvent.change(fileInput, {
			target: {
				files: [new File(["scan"], "notes.pdf", { type: "application/pdf" })],
			},
		});

		await waitFor(() => {
			expect(screen.getByText("Uploading file...")).toBeInTheDocument();
		});

		await fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });

		await waitFor(() => {
			expect(
				screen.getByText(
					"Message will send automatically when file processing finishes.",
				),
			).toBeInTheDocument();
		});
		expect(checkCloudWarningMock).not.toHaveBeenCalled();

		resolveUpload?.({
			artifact: {
				id: "artifact-queued-1",
				type: "source_document",
				retrievalClass: "durable",
				name: "notes.pdf",
				mimeType: "application/pdf",
				sizeBytes: 12,
				conversationId: "conv-1",
				summary: "OCR me",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			},
			normalizedArtifact: null,
			reusedExistingArtifact: false,
			promptReady: true,
			promptArtifactId: "normalized-queued-1",
			readinessError: null,
			// Phase 3: every upload response carries its ledger row. This one is
			// already `succeeded`, which is what releases the queued send — the
			// composer's readiness now reads the row, not `promptReady`.
			extraction: {
				id: "extraction-queued-1",
				sourceArtifactId: "artifact-queued-1",
				normalizedArtifactId: "normalized-queued-1",
				status: "succeeded",
				intakeRoute: "mineru",
				fileName: "notes.pdf",
				attemptCount: 1,
				maxAttempts: 3,
				retryable: false,
				cancelable: false,
				error: null,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				startedAt: Date.now(),
				legacy: false,
			},
		});

		await waitFor(() => {
			expect(checkCloudWarningMock).toHaveBeenCalledTimes(1);
		});
		expect(
			await screen.findByTestId("cloud-connector-warning"),
		).toBeInTheDocument();
		expect(runtimeHarness.streamInvocations).toHaveLength(0);

		await fireEvent.click(screen.getByTestId("cloud-warning-send"));

		await waitFor(() => {
			expect(runtimeHarness.streamInvocations).toHaveLength(1);
		});
		expect(runtimeHarness.streamInvocations[0].message).toBe(
			"Cloud data while uploading",
		);
	});

	it("gates Regenerate: shows the warning, leaves the transcript untouched until acknowledged, then dispatches once", async () => {
		checkCloudWarningMock.mockResolvedValue({ shouldWarn: true });
		ackCloudConnectorMock.mockResolvedValue(undefined);
		renderPage(cloudModelPageData({ messages: conversationTurnFixture() }));

		await waitFor(() => {
			expect(fetchActiveCapabilitiesMock).toHaveBeenCalled();
		});

		await fireEvent.click(
			screen.getByRole("button", { name: "Regenerate response" }),
		);

		await waitFor(() => {
			expect(checkCloudWarningMock).toHaveBeenCalledWith(CLOUD_MODEL_ID, [
				"calendar",
			]);
		});
		expect(
			await screen.findByTestId("cloud-connector-warning"),
		).toBeInTheDocument();
		// Not yet acknowledged — the original assistant response must still be
		// on screen (regenerate must not have mutated the transcript yet).
		expect(screen.getByText("You have a 2pm meeting.")).toBeInTheDocument();
		expect(runtimeHarness.streamInvocations).toHaveLength(0);

		await fireEvent.click(screen.getByTestId("cloud-warning-send"));

		await waitFor(() => {
			expect(runtimeHarness.streamInvocations).toHaveLength(1);
		});
		expect(runtimeHarness.streamInvocations[0].message).toBe(
			"What's on my calendar?",
		);
	});

	it("Regenerate: Cancel aborts and leaves the transcript untouched", async () => {
		checkCloudWarningMock.mockResolvedValue({ shouldWarn: true });
		renderPage(cloudModelPageData({ messages: conversationTurnFixture() }));

		await waitFor(() => {
			expect(fetchActiveCapabilitiesMock).toHaveBeenCalled();
		});

		await fireEvent.click(
			screen.getByRole("button", { name: "Regenerate response" }),
		);
		await screen.findByTestId("cloud-connector-warning");

		await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		expect(runtimeHarness.streamInvocations).toHaveLength(0);
		expect(screen.getByText("You have a 2pm meeting.")).toBeInTheDocument();
	});

	it("gates Edit-then-resend: shows the warning, deletes/resends only after acknowledgement", async () => {
		checkCloudWarningMock.mockResolvedValue({ shouldWarn: true });
		ackCloudConnectorMock.mockResolvedValue(undefined);
		const { deleteConversationMessages } = await import(
			"$lib/client/api/conversations"
		);
		vi.mocked(deleteConversationMessages).mockResolvedValue(2);
		renderPage(cloudModelPageData({ messages: conversationTurnFixture() }));

		await waitFor(() => {
			expect(fetchActiveCapabilitiesMock).toHaveBeenCalled();
		});

		const userMessage = screen.getByTestId("user-message");
		// The hover action row (Edit/timestamp) is a DOM sibling of the
		// data-testid="user-message" node, not a child of it — scope to their
		// shared ".group" wrapper. The edit itself happens in the composer.
		const userMessageGroup = userMessage.parentElement as HTMLElement;
		await fireEvent.click(
			within(userMessageGroup).getByRole("button", { name: "Edit message" }),
		);
		const composer = screen.getByTestId("message-input");
		await waitFor(() => {
			expect(composer).toHaveValue("What's on my calendar?");
		});
		await fireEvent.input(composer, {
			target: { value: "What's on my calendar tomorrow?" },
		});
		await fireEvent.click(screen.getByTestId("send-button"));

		await waitFor(() => {
			expect(checkCloudWarningMock).toHaveBeenCalledWith(CLOUD_MODEL_ID, [
				"calendar",
			]);
		});
		expect(
			await screen.findByTestId("cloud-connector-warning"),
		).toBeInTheDocument();
		// Not yet acknowledged — the edit must not have deleted anything yet.
		expect(deleteConversationMessages).not.toHaveBeenCalled();
		expect(runtimeHarness.streamInvocations).toHaveLength(0);

		await fireEvent.click(screen.getByTestId("cloud-warning-send"));

		await waitFor(() => {
			expect(deleteConversationMessages).toHaveBeenCalledWith(
				"conv-1",
				["user-1", "assistant-1"],
				expect.objectContaining({ confirmForkedSourceHistoryMutation: false }),
			);
		});
		await waitFor(() => {
			expect(runtimeHarness.streamInvocations).toHaveLength(1);
		});
		expect(runtimeHarness.streamInvocations[0].message).toBe(
			"What's on my calendar tomorrow?",
		);
	});

	it("Edit-then-resend: backing out of the warning leaves the edit open in the composer", async () => {
		checkCloudWarningMock.mockResolvedValue({ shouldWarn: true });
		const { deleteConversationMessages } = await import(
			"$lib/client/api/conversations"
		);
		vi.mocked(deleteConversationMessages).mockClear();
		renderPage(cloudModelPageData({ messages: conversationTurnFixture() }));
		await waitFor(() => {
			expect(fetchActiveCapabilitiesMock).toHaveBeenCalled();
		});

		await fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
		const composer = screen.getByTestId("message-input");
		await fireEvent.input(composer, {
			target: { value: "What's on my calendar tomorrow?" },
		});
		await fireEvent.click(screen.getByTestId("send-button"));
		await screen.findByTestId("cloud-connector-warning");
		await fireEvent.click(
			within(screen.getByRole("dialog")).getByRole("button", {
				name: "Cancel",
			}),
		);

		expect(deleteConversationMessages).not.toHaveBeenCalled();
		expect(screen.getByTestId("composer-edit-strip")).toBeInTheDocument();
		expect(screen.getByTestId("message-input")).toHaveValue(
			"What's on my calendar tomorrow?",
		);
		expect(screen.getByText("You have a 2pm meeting.")).toBeInTheDocument();
	});

	it("Edit-then-resend: the composer gives the earlier draft back once the edit goes out", async () => {
		checkCloudWarningMock.mockResolvedValue({ shouldWarn: true });
		ackCloudConnectorMock.mockResolvedValue(undefined);
		const { deleteConversationMessages } = await import(
			"$lib/client/api/conversations"
		);
		vi.mocked(deleteConversationMessages).mockResolvedValue(2);
		renderPage(cloudModelPageData({ messages: conversationTurnFixture() }));
		await waitFor(() => {
			expect(fetchActiveCapabilitiesMock).toHaveBeenCalled();
		});
		await fireEvent.input(screen.getByTestId("message-input"), {
			target: { value: "a half-written thought" },
		});

		await fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
		await waitFor(() => {
			expect(screen.getByTestId("message-input")).toHaveValue(
				"What's on my calendar?",
			);
		});
		await fireEvent.input(screen.getByTestId("message-input"), {
			target: { value: "What's on my calendar tomorrow?" },
		});
		await fireEvent.click(screen.getByTestId("send-button"));
		await screen.findByTestId("cloud-connector-warning");
		await fireEvent.click(screen.getByTestId("cloud-warning-send"));

		await waitFor(() => {
			expect(runtimeHarness.streamInvocations).toHaveLength(1);
		});
		expect(runtimeHarness.streamInvocations[0].message).toBe(
			"What's on my calendar tomorrow?",
		);
		await waitFor(() => {
			expect(
				screen.queryByTestId("composer-edit-strip"),
			).not.toBeInTheDocument();
			expect(screen.getByTestId("message-input")).toHaveValue(
				"a half-written thought",
			);
		});
	});

	describe("an edit that does not go through", () => {
		const editedText = "What's on my calendar tomorrow?";

		async function sendEditOfFirstMessage() {
			await waitFor(() => {
				expect(fetchActiveCapabilitiesMock).toHaveBeenCalled();
			});
			await fireEvent.click(
				screen.getAllByRole("button", { name: "Edit message" })[0],
			);
			const composer = screen.getByTestId("message-input");
			await waitFor(() => {
				expect(composer).toHaveValue("What's on my calendar?");
			});
			await fireEvent.input(composer, { target: { value: editedText } });
			await fireEvent.click(screen.getByTestId("send-button"));
		}

		function expectTheEditStillOpen() {
			expect(screen.getByTestId("composer-edit-strip")).toBeInTheDocument();
			expect(screen.getByTestId("message-input")).toHaveValue(editedText);
			expect(screen.getByText("You have a 2pm meeting.")).toBeInTheDocument();
			expect(runtimeHarness.streamInvocations).toHaveLength(0);
		}

		it("a failed delete changes nothing, and keeps what was typed", async () => {
			checkCloudWarningMock.mockResolvedValue({ shouldWarn: false });
			const { deleteConversationMessages } = await import(
				"$lib/client/api/conversations"
			);
			vi.mocked(deleteConversationMessages)
				.mockReset()
				.mockRejectedValue(new Error("Network down"));
			renderPage(cloudModelPageData({ messages: conversationTurnFixture() }));

			await sendEditOfFirstMessage();

			await waitFor(() => {
				expect(deleteConversationMessages).toHaveBeenCalledTimes(1);
			});
			await waitFor(() => {
				expect(screen.getByTestId("message-input")).toBeEnabled();
			});
			expectTheEditStillOpen();
			expect(screen.getByText("Network down")).toBeInTheDocument();
		});

		it("keeps the messages on screen until the server has deleted them", async () => {
			checkCloudWarningMock.mockResolvedValue({ shouldWarn: false });
			const { deleteConversationMessages } = await import(
				"$lib/client/api/conversations"
			);
			let finishDelete: (count: number) => void = () => {};
			vi.mocked(deleteConversationMessages)
				.mockReset()
				.mockReturnValue(
					new Promise((resolve) => {
						finishDelete = resolve;
					}),
				);
			renderPage(cloudModelPageData({ messages: conversationTurnFixture() }));

			await sendEditOfFirstMessage();
			await waitFor(() => {
				expect(deleteConversationMessages).toHaveBeenCalledTimes(1);
			});

			expectTheEditStillOpen();
			// Past the point of no return: Cancel must not pretend otherwise.
			await fireEvent.click(screen.getByTestId("composer-edit-cancel"));
			expectTheEditStillOpen();

			finishDelete(2);
			await waitFor(() => {
				expect(runtimeHarness.streamInvocations).toHaveLength(1);
			});
			expect(runtimeHarness.streamInvocations[0].message).toBe(editedText);
			expect(
				screen.queryByText("You have a 2pm meeting."),
			).not.toBeInTheDocument();
		});

		it("declining the server's fork question leaves the edit open", async () => {
			checkCloudWarningMock.mockResolvedValue({ shouldWarn: false });
			const { deleteConversationMessages } = await import(
				"$lib/client/api/conversations"
			);
			vi.mocked(deleteConversationMessages)
				.mockReset()
				.mockRejectedValue(
					Object.assign(new Error("Confirm"), {
						code: FORKED_SOURCE_HISTORY_CONFIRMATION_REQUIRED_CODE,
					}),
				);
			const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
			renderPage(cloudModelPageData({ messages: conversationTurnFixture() }));

			await sendEditOfFirstMessage();

			await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
			await waitFor(() => {
				expect(screen.getByTestId("message-input")).toBeEnabled();
			});
			expectTheEditStillOpen();
			confirm.mockRestore();
		});

		it("Cancel while the gate is still waiting stops the delete", async () => {
			let answerGate: (answer: { shouldWarn: boolean }) => void = () => {};
			checkCloudWarningMock.mockReturnValue(
				new Promise((resolve) => {
					answerGate = resolve;
				}),
			);
			const { deleteConversationMessages } = await import(
				"$lib/client/api/conversations"
			);
			vi.mocked(deleteConversationMessages).mockReset().mockResolvedValue(2);
			renderPage(cloudModelPageData({ messages: conversationTurnFixture() }));

			await sendEditOfFirstMessage();
			await waitFor(() => expect(checkCloudWarningMock).toHaveBeenCalled());
			await fireEvent.click(screen.getByTestId("composer-edit-cancel"));

			answerGate({ shouldWarn: false });
			await new Promise((resolve) => setTimeout(resolve, 30));

			expect(deleteConversationMessages).not.toHaveBeenCalled();
			expect(runtimeHarness.streamInvocations).toHaveLength(0);
			expect(screen.getByText("You have a 2pm meeting.")).toBeInTheDocument();
		});

		it("a Cancel and the same pencil again during the gate still stop the first send", async () => {
			let answerGate: (answer: { shouldWarn: boolean }) => void = () => {};
			checkCloudWarningMock.mockReturnValue(
				new Promise((resolve) => {
					answerGate = resolve;
				}),
			);
			const { deleteConversationMessages } = await import(
				"$lib/client/api/conversations"
			);
			vi.mocked(deleteConversationMessages).mockReset().mockResolvedValue(2);
			renderPage(cloudModelPageData({ messages: conversationTurnFixture() }));

			await sendEditOfFirstMessage();
			await waitFor(() => expect(checkCloudWarningMock).toHaveBeenCalled());
			await fireEvent.click(screen.getByTestId("composer-edit-cancel"));
			await fireEvent.click(
				await screen.findByRole("button", { name: "Edit message" }),
			);
			await screen.findByTestId("composer-edit-strip");

			answerGate({ shouldWarn: false });
			await new Promise((resolve) => setTimeout(resolve, 30));

			expect(deleteConversationMessages).not.toHaveBeenCalled();
			expect(runtimeHarness.streamInvocations).toHaveLength(0);
		});

		it("a send queued behind a file waits for the resend's turn, whichever is ready first", async () => {
			const { deleteConversationMessages } = await import(
				"$lib/client/api/conversations"
			);
			vi.mocked(deleteConversationMessages).mockReset().mockResolvedValue(2);
			const { uploadKnowledgeAttachment } = await import(
				"$lib/client/api/knowledge"
			);
			type KnowledgeUploadResponse = Awaited<
				ReturnType<typeof uploadKnowledgeAttachment>
			>;
			let finishUpload: (value: KnowledgeUploadResponse) => void = () => {};
			vi.mocked(uploadKnowledgeAttachment).mockReturnValue(
				new Promise((resolve) => {
					finishUpload = resolve;
				}),
			);
			// A local model: the gate answers at once, which is the tight case.
			renderPage(pageData({ messages: conversationTurnFixture() }));
			await waitFor(() => {
				expect(fetchActiveCapabilitiesMock).toHaveBeenCalled();
			});
			const composer = screen.getByTestId("message-input");
			await fireEvent.input(composer, { target: { value: "Summarise this" } });
			await fireEvent.change(
				document.querySelector('input[type="file"]') as HTMLInputElement,
				{
					target: {
						files: [
							new File(["scan"], "notes.pdf", { type: "application/pdf" }),
						],
					},
				},
			);
			await waitFor(() => {
				expect(screen.getByText("Uploading file...")).toBeInTheDocument();
			});
			await fireEvent.keyDown(composer, { key: "Enter", ctrlKey: true });
			await waitFor(() => {
				expect(
					screen.getByText(
						"Message will send automatically when file processing finishes.",
					),
				).toBeInTheDocument();
			});

			await fireEvent.click(
				screen.getAllByRole("button", { name: "Edit message" })[0],
			);
			await waitFor(() => {
				expect(composer).toHaveValue("What's on my calendar?");
			});
			finishUpload({
				artifact: {
					id: "artifact-queued-2",
					type: "source_document",
					retrievalClass: "durable",
					name: "notes.pdf",
					mimeType: "application/pdf",
					sizeBytes: 12,
					conversationId: "conv-1",
					summary: "OCR me",
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
				normalizedArtifact: null,
				reusedExistingArtifact: false,
				promptReady: true,
				promptArtifactId: "normalized-queued-2",
				readinessError: null,
				extraction: {
					id: "extraction-queued-2",
					sourceArtifactId: "artifact-queued-2",
					normalizedArtifactId: "normalized-queued-2",
					status: "succeeded",
					intakeRoute: "mineru",
					fileName: "notes.pdf",
					attemptCount: 1,
					maxAttempts: 3,
					retryable: false,
					cancelable: false,
					error: null,
					createdAt: Date.now(),
					updatedAt: Date.now(),
					startedAt: Date.now(),
					legacy: false,
				},
			});
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(runtimeHarness.streamInvocations).toHaveLength(0);

			await fireEvent.input(composer, { target: { value: editedText } });
			await fireEvent.click(screen.getByTestId("send-button"));

			await waitFor(() => {
				expect(runtimeHarness.streamInvocations.length).toBeGreaterThan(0);
			});
			expect(runtimeHarness.streamInvocations[0].message).toBe(editedText);

			runtimeHarness.streamInvocations[0].callbacks.onEnd("A new answer.", {
				assistantMessageId: "assistant-new",
			});

			await waitFor(() => {
				expect(runtimeHarness.streamInvocations).toHaveLength(2);
			});
			expect(runtimeHarness.streamInvocations[1].message).toBe(
				"Summarise this",
			);
		});

		it("sends nothing to the next chat when the person leaves during the delete, and keeps the text in the chat they left", async () => {
			checkCloudWarningMock.mockResolvedValue({ shouldWarn: false });
			const { deleteConversationMessages, persistConversationDraft } =
				await import("$lib/client/api/conversations");
			vi.mocked(persistConversationDraft).mockClear();
			let finishDelete: (count: number) => void = () => {};
			vi.mocked(deleteConversationMessages)
				.mockReset()
				.mockReturnValue(
					new Promise((resolve) => {
						finishDelete = resolve;
					}),
				);
			const first = cloudModelPageData({
				messages: conversationTurnFixture(),
			});
			const view = renderPage(first);
			await waitFor(() => {
				expect(screen.getByTestId("message-input")).toBeEnabled();
			});
			await fireEvent.input(screen.getByTestId("message-input"), {
				target: { value: "a draft set aside" },
			});
			await sendEditOfFirstMessage();
			await waitFor(() => {
				expect(deleteConversationMessages).toHaveBeenCalledTimes(1);
			});

			const next = cloudModelPageData({
				conversation: { ...first.conversation, id: "conversation-next" },
				messages: [],
			});
			await view.rerender({
				data: next,
				params: { conversationId: "conversation-next" },
			});
			finishDelete(2);
			await new Promise((resolve) => setTimeout(resolve, 30));

			expect(runtimeHarness.streamInvocations).toHaveLength(0);
			// Both texts are the person's, and this is the only place left for either.
			expect(persistConversationDraft).toHaveBeenCalledWith(
				first.conversation.id,
				expect.objectContaining({
					draftText: `a draft set aside\n\n${editedText}`,
				}),
			);
		});

		// The resend meets the turn's gate only after the delete, so a refusal there
		// (a photo the chosen model cannot see, a file deleted since) left the person
		// with neither the message nor a reply, and a reload showed it. The gate is
		// asked first, and a refusal is the same as a failed delete: the edit stays.
		describe("when the turn's gate would refuse the resend", () => {
			const photoRefusal = () =>
				new ApiError("Photo.png does not contain enough readable text.", {
					status: 422,
					code: "attachment_not_ready",
					attachmentReadiness: [
						{
							artifactId: "attachment-1",
							name: "Photo.png",
							reason: "not_text_readable",
						},
					],
				});
			const CHECK_FAILED =
				"Couldn't check this edit. Nothing has changed, try again.";

			async function withDeletesThatWork() {
				checkCloudWarningMock.mockResolvedValue({ shouldWarn: false });
				const { deleteConversationMessages } = await import(
					"$lib/client/api/conversations"
				);
				vi.mocked(deleteConversationMessages).mockReset().mockResolvedValue(2);
				return vi.mocked(deleteConversationMessages);
			}

			it("asks the gate before it deletes anything, about the resend it is going to send", async () => {
				const deleteMessages = await withDeletesThatWork();
				renderPage(cloudModelPageData({ messages: conversationTurnFixture() }));

				await sendEditOfFirstMessage();
				await waitFor(() => {
					expect(runtimeHarness.streamInvocations).toHaveLength(1);
				});

				expect(checkChatTurnMock).toHaveBeenCalledTimes(1);
				expect(checkChatTurnMock).toHaveBeenCalledWith(
					expect.objectContaining({
						conversationId: "conv-1",
						message: editedText,
						model: CLOUD_MODEL_ID,
						attachmentIds: [],
						isEditResend: true,
					}),
				);
				expect(checkChatTurnMock.mock.invocationCallOrder[0]).toBeLessThan(
					deleteMessages.mock.invocationCallOrder[0],
				);
			});

			it("changes nothing on a refusal: the edit stays open with what was typed, and the sentence is the one a refused send shows", async () => {
				const deleteMessages = await withDeletesThatWork();
				checkChatTurnMock.mockResolvedValue({
					ok: false,
					error: photoRefusal(),
				});
				renderPage(cloudModelPageData({ messages: conversationTurnFixture() }));

				await sendEditOfFirstMessage();

				expect(
					await screen.findByText(
						/Photo\.png: This attachment does not contain enough readable text to use in chat\./,
					),
				).toBeInTheDocument();
				expect(deleteMessages).not.toHaveBeenCalled();
				expectTheEditStillOpen();

				// Once it is put right the same edit goes out.
				checkChatTurnMock.mockResolvedValue({ ok: true });
				await fireEvent.click(screen.getByTestId("send-button"));
				await waitFor(() => {
					expect(runtimeHarness.streamInvocations).toHaveLength(1);
				});
				expect(deleteMessages).toHaveBeenCalledTimes(1);
				expect(runtimeHarness.streamInvocations[0].message).toBe(editedText);
				expect(
					screen.queryByText(/does not contain enough readable text/),
				).not.toBeInTheDocument();
			});

			it("says another reply is running when the server cannot take a turn, and deletes nothing", async () => {
				const deleteMessages = await withDeletesThatWork();
				checkChatTurnMock.mockResolvedValue({
					ok: false,
					busy: true,
					error: new ApiError("Server at capacity. Please try again later.", {
						status: 503,
						code: "CAPACITY_EXCEEDED",
					}),
				});
				renderPage(cloudModelPageData({ messages: conversationTurnFixture() }));

				await sendEditOfFirstMessage();

				// Not the model provider's error sentence, which is what a send makes of it.
				expect(
					await screen.findByText(
						"Another reply is still running. Wait for it, then send this edit again.",
					),
				).toBeInTheDocument();
				expect(deleteMessages).not.toHaveBeenCalled();
				expectTheEditStillOpen();
			});

			it("leaves the edit open and deletes nothing when the check fails", async () => {
				const deleteMessages = await withDeletesThatWork();
				checkChatTurnMock.mockRejectedValue(new Error("Network down"));
				renderPage(cloudModelPageData({ messages: conversationTurnFixture() }));

				await sendEditOfFirstMessage();

				expect(await screen.findByText(CHECK_FAILED)).toBeInTheDocument();
				expect(deleteMessages).not.toHaveBeenCalled();
				expectTheEditStillOpen();
			});

			it("leaves the edit open and deletes nothing when the check does not answer in ten seconds", async () => {
				const deleteMessages = await withDeletesThatWork();
				checkChatTurnMock.mockReturnValue(new Promise(() => undefined));
				renderPage(cloudModelPageData({ messages: conversationTurnFixture() }));
				vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
				try {
					await sendEditOfFirstMessage();
					await waitFor(() => {
						expect(checkChatTurnMock).toHaveBeenCalledTimes(1);
					});
					await vi.advanceTimersByTimeAsync(9_000);
					expect(screen.queryByText(CHECK_FAILED)).not.toBeInTheDocument();

					await vi.advanceTimersByTimeAsync(1_500);
					expect(await screen.findByText(CHECK_FAILED)).toBeInTheDocument();
				} finally {
					vi.useRealTimers();
				}
				expect(deleteMessages).not.toHaveBeenCalled();
				expectTheEditStillOpen();
			});

			it("lets Cancel through while the check is out: nothing was deleted and a late refusal is not shown", async () => {
				const deleteMessages = await withDeletesThatWork();
				let answer: (check: ChatTurnCheck) => void = () => {};
				checkChatTurnMock.mockReturnValue(
					new Promise((resolve) => {
						answer = resolve;
					}),
				);
				renderPage(cloudModelPageData({ messages: conversationTurnFixture() }));

				await sendEditOfFirstMessage();
				await waitFor(() => expect(checkChatTurnMock).toHaveBeenCalled());
				await fireEvent.click(screen.getByTestId("composer-edit-cancel"));
				expect(
					screen.queryByTestId("composer-edit-strip"),
				).not.toBeInTheDocument();

				answer({ ok: false, error: photoRefusal() });
				await new Promise((resolve) => setTimeout(resolve, 30));

				expect(deleteMessages).not.toHaveBeenCalled();
				expect(runtimeHarness.streamInvocations).toHaveLength(0);
				expect(screen.getByText("You have a 2pm meeting.")).toBeInTheDocument();
				expect(
					screen.queryByText(/does not contain enough readable text/),
				).not.toBeInTheDocument();
			});

			it("deletes nothing for a Cancel and the same pencil again during the check", async () => {
				const deleteMessages = await withDeletesThatWork();
				let answer: (check: ChatTurnCheck) => void = () => {};
				checkChatTurnMock.mockReturnValue(
					new Promise((resolve) => {
						answer = resolve;
					}),
				);
				renderPage(cloudModelPageData({ messages: conversationTurnFixture() }));

				await sendEditOfFirstMessage();
				await waitFor(() => expect(checkChatTurnMock).toHaveBeenCalled());
				await fireEvent.click(screen.getByTestId("composer-edit-cancel"));
				await fireEvent.click(
					await screen.findByRole("button", { name: "Edit message" }),
				);
				await screen.findByTestId("composer-edit-strip");

				answer({ ok: true });
				await new Promise((resolve) => setTimeout(resolve, 30));

				expect(deleteMessages).not.toHaveBeenCalled();
				expect(runtimeHarness.streamInvocations).toHaveLength(0);
			});

			it("sends one resend when send is pressed twice while the check is out", async () => {
				const deleteMessages = await withDeletesThatWork();
				let answer: (check: ChatTurnCheck) => void = () => {};
				checkChatTurnMock.mockReturnValue(
					new Promise((resolve) => {
						answer = resolve;
					}),
				);
				renderPage(cloudModelPageData({ messages: conversationTurnFixture() }));

				await sendEditOfFirstMessage();
				await waitFor(() => expect(checkChatTurnMock).toHaveBeenCalled());
				await fireEvent.click(screen.getByTestId("send-button"));
				answer({ ok: true });

				await waitFor(() => {
					expect(runtimeHarness.streamInvocations).toHaveLength(1);
				});
				await new Promise((resolve) => setTimeout(resolve, 30));
				expect(deleteMessages).toHaveBeenCalledTimes(1);
				expect(runtimeHarness.streamInvocations).toHaveLength(1);
			});

			// The connection drops in the middle of a reply, so no turn is running while
			// the page waits to look for it, and the person edits. Then the page finds the
			// turn the server is still running and reconnects to it: a turn is running
			// under the open edit. The resend would be refused (handleSend returns
			// silently), and the delete before it would have taken the words with it.
			describe("when a turn starts under the open edit", () => {
				/** A message whose connection dropped after words had come: the page will look for the turn in half a second. */
				async function dropAConnectionMidReply() {
					await fireEvent.input(screen.getByTestId("message-input"), {
						target: { value: "And tomorrow?" },
					});
					await fireEvent.click(
						screen.getByRole("button", { name: "Send message" }),
					);
					await waitFor(() => {
						expect(runtimeHarness.streamInvocations).toHaveLength(1);
					});
					runtimeHarness.streamInvocations[0].callbacks.onToken("Tomorrow");
					runtimeHarness.orphanedStreamId = "stream-still-running";
					runtimeHarness.streamInvocations[0].callbacks.onError(
						new Error("Network failed"),
					);
				}

				it("leaves the edit open and deletes nothing when a turn is running as the check answers", async () => {
					const deleteMessages = await withDeletesThatWork();
					let answer: (check: ChatTurnCheck) => void = () => {};
					checkChatTurnMock.mockReturnValue(
						new Promise((resolve) => {
							answer = resolve;
						}),
					);
					renderPage(
						cloudModelPageData({ messages: conversationTurnFixture() }),
					);
					await waitFor(() =>
						expect(fetchActiveCapabilitiesMock).toHaveBeenCalled(),
					);
					await dropAConnectionMidReply();

					await sendEditOfFirstMessage();
					await waitFor(() => expect(checkChatTurnMock).toHaveBeenCalled());
					// The page finds the turn and reconnects to it.
					await waitFor(() => {
						expect(runtimeHarness.streamInvocations).toHaveLength(2);
					});
					answer({ ok: true });

					expect(
						await screen.findByText(
							"Another reply is still running. Wait for it, then send this edit again.",
						),
					).toBeInTheDocument();
					expect(deleteMessages).not.toHaveBeenCalled();
					expect(screen.getByTestId("composer-edit-strip")).toBeInTheDocument();
					expect(screen.getByTestId("message-input")).toHaveValue(editedText);
					expect(
						screen.getByText("You have a 2pm meeting."),
					).toBeInTheDocument();
					expect(runtimeHarness.streamInvocations).toHaveLength(2);
				});

				it("puts the words back in the composer when a turn starts while the delete is out", async () => {
					const deleteMessages = await withDeletesThatWork();
					let finishDelete: (count: number) => void = () => {};
					deleteMessages.mockReturnValue(
						new Promise((resolve) => {
							finishDelete = resolve;
						}),
					);
					renderPage(
						cloudModelPageData({ messages: conversationTurnFixture() }),
					);
					await waitFor(() =>
						expect(fetchActiveCapabilitiesMock).toHaveBeenCalled(),
					);
					await dropAConnectionMidReply();

					await sendEditOfFirstMessage();
					await waitFor(() => expect(deleteMessages).toHaveBeenCalledTimes(1));
					await waitFor(() => {
						expect(runtimeHarness.streamInvocations).toHaveLength(2);
					});
					finishDelete(2);

					// The edit is over (its message went with the delete); handleSend refuses
					// while a turn runs, and the edited words are not lost with the message:
					// they wait in the composer.
					await waitFor(() => {
						expect(
							screen.queryByTestId("composer-edit-strip"),
						).not.toBeInTheDocument();
					});
					await new Promise((resolve) => setTimeout(resolve, 30));
					expect(screen.getByTestId("message-input")).toHaveValue(editedText);
					expect(runtimeHarness.streamInvocations).toHaveLength(2);
					expect(
						runtimeHarness.streamInvocations.some(
							(invocation) => invocation.message === editedText,
						),
					).toBe(false);
				});
			});

			// The check can wait for seconds with the page live, and the chat can change
			// under an open edit: a turn that finished while the tab was in the background
			// is read back when it returns. What the edit deletes is what is there when the
			// check has answered, not what was there when send was pressed.
			describe("when the chat changes while the check is out", () => {
				/** A message sent, its connection lost in the background: the page will read the chat back when it is seen again. */
				async function loseAConnectionInTheBackground() {
					await fireEvent.input(screen.getByTestId("message-input"), {
						target: { value: "And tomorrow?" },
					});
					await fireEvent.click(
						screen.getByRole("button", { name: "Send message" }),
					);
					await waitFor(() => {
						expect(runtimeHarness.streamInvocations).toHaveLength(1);
					});
					Object.defineProperty(document, "visibilityState", {
						configurable: true,
						value: "hidden",
					});
					runtimeHarness.streamInvocations[0].callbacks.onError(
						Object.assign(new Error("The operation was aborted."), {
							name: "AbortError",
						}),
					);
					Object.defineProperty(document, "visibilityState", {
						configurable: true,
						value: "visible",
					});
				}

				/** The tab is seen again: the page reads the chat back from the server. */
				function returnToTheTab(serverMessages: ChatMessage[]) {
					vi.mocked(fetchConversationDetail).mockResolvedValue(
						conversationDetailFixture({ messages: serverMessages }),
					);
					document.dispatchEvent(new Event("visibilitychange"));
				}

				const turnThatFinishedMeanwhile: ChatMessage[] = [
					...conversationTurnFixture(),
					{
						id: "user-2",
						role: "user",
						content: "And tomorrow?",
						timestamp: 3,
					},
					{
						id: "assistant-2",
						role: "assistant",
						content: "Tomorrow is busy.",
						timestamp: 4,
					},
				];

				it("deletes what has landed since, taking the ids from the list as it stands", async () => {
					const deleteMessages = await withDeletesThatWork();
					let answer: (check: ChatTurnCheck) => void = () => {};
					checkChatTurnMock.mockReturnValue(
						new Promise((resolve) => {
							answer = resolve;
						}),
					);
					renderPage(
						cloudModelPageData({ messages: conversationTurnFixture() }),
					);
					await waitFor(() =>
						expect(fetchActiveCapabilitiesMock).toHaveBeenCalled(),
					);
					await loseAConnectionInTheBackground();

					await sendEditOfFirstMessage();
					await waitFor(() => expect(checkChatTurnMock).toHaveBeenCalled());
					returnToTheTab(turnThatFinishedMeanwhile);
					expect(
						await screen.findByText("Tomorrow is busy."),
					).toBeInTheDocument();
					answer({ ok: true });

					await waitFor(() => {
						expect(deleteMessages).toHaveBeenCalledTimes(1);
					});
					// The message it began with, the reply, and the turn that landed after
					// them: the server's ids, not the bubble the page had drawn.
					expect(deleteMessages).toHaveBeenCalledWith(
						"conv-1",
						["user-1", "assistant-1", "user-2", "assistant-2"],
						expect.anything(),
					);
					await waitFor(() => {
						expect(runtimeHarness.streamInvocations).toHaveLength(2);
					});
					expect(
						screen.queryByText("Tomorrow is busy."),
					).not.toBeInTheDocument();
				});

				it("closes the edit and deletes nothing when the message has left the chat", async () => {
					const deleteMessages = await withDeletesThatWork();
					let answer: (check: ChatTurnCheck) => void = () => {};
					checkChatTurnMock.mockReturnValue(
						new Promise((resolve) => {
							answer = resolve;
						}),
					);
					renderPage(
						cloudModelPageData({ messages: conversationTurnFixture() }),
					);
					await waitFor(() =>
						expect(fetchActiveCapabilitiesMock).toHaveBeenCalled(),
					);
					await loseAConnectionInTheBackground();

					await sendEditOfFirstMessage();
					await waitFor(() => expect(checkChatTurnMock).toHaveBeenCalled());
					// The chat as the server has it now has no such message any more.
					returnToTheTab([
						{
							id: "user-9",
							role: "user",
							content: "Another question",
							timestamp: 1,
						},
						{
							id: "assistant-9",
							role: "assistant",
							content: "Another answer.",
							timestamp: 2,
						},
					]);
					expect(
						await screen.findByText("Another answer."),
					).toBeInTheDocument();
					answer({ ok: true });

					await waitFor(() => {
						expect(
							screen.queryByTestId("composer-edit-strip"),
						).not.toBeInTheDocument();
					});
					await new Promise((resolve) => setTimeout(resolve, 30));
					expect(deleteMessages).not.toHaveBeenCalled();
					expect(runtimeHarness.streamInvocations).toHaveLength(1);
					expect(screen.getByText("Another answer.")).toBeInTheDocument();
				});
			});
		});
	});

	describe("an edit's resend carries the pictures its message carried", () => {
		const question = "What colour is the roof in picture 1?";
		const editedText = "What colour is the door in picture 1?";
		const box = { letter: "A" as const, x: 0.1, y: 0.1, w: 0.4, h: 0.4 };
		const cottage = { imageFileId: "file-cottage", number: 1, name: "Cottage" };
		const marksOnCottage = {
			imageFileId: "file-cottage",
			markedFileId: "file-marked",
			letters: ["A" as const],
			boxes: [box],
		};

		function userMessage(pictures?: ChatMessage["pictures"]): ChatMessage {
			return {
				id: "user-1",
				role: "user",
				content: question,
				timestamp: 1,
				...(pictures ? { pictures } : {}),
			};
		}

		function turnWith(pictures?: ChatMessage["pictures"]) {
			return [
				userMessage(pictures),
				{
					id: "assistant-1",
					role: "assistant" as const,
					content: "The roof is red.",
					timestamp: 2,
				},
			];
		}

		/** Presses the pencil on the first message, rewords it and sends: what the stream was asked for. */
		async function editAndSend(sendsWithinMs = 1000) {
			vi.mocked(deleteConversationMessages).mockReset().mockResolvedValue(2);
			await waitFor(() => {
				expect(fetchActiveCapabilitiesMock).toHaveBeenCalled();
			});
			await fireEvent.click(
				screen.getAllByRole("button", { name: "Edit message" })[0],
			);
			const composer = screen.getByTestId("message-input");
			await waitFor(() => {
				expect(composer).toHaveValue(question);
			});
			await fireEvent.input(composer, { target: { value: editedText } });
			await fireEvent.click(screen.getByTestId("send-button"));
			await waitFor(
				() => {
					expect(runtimeHarness.streamInvocations).toHaveLength(1);
				},
				{ timeout: sendsWithinMs },
			);
			return runtimeHarness.streamInvocations[0].options;
		}

		it("sends the card pictures the message was sent with, under their numbers, and draws them on the new message", async () => {
			renderPage(
				pageData({
					messages: turnWith({ refs: [cottage], open: null, marks: null }),
				}),
			);

			const options = await editAndSend();

			expect(options?.pictureRefs).toEqual([
				{ imageFileId: "file-cottage", number: 1 },
			]);
			expect(options?.imageMarks).toBeNull();
			// The old message has left the list; the new one is drawn with its picture.
			expect(screen.getByTestId("user-message")).toHaveTextContent(editedText);
			expect(screen.getAllByTestId("message-picture-chip")).toHaveLength(1);
		});

		it("sends the marks the message was sent with, on the same picture", async () => {
			renderPage(
				pageData({
					messages: turnWith({
						refs: [cottage],
						open: null,
						marks: marksOnCottage,
					}),
				}),
			);

			const options = await editAndSend();

			expect(options?.pictureRefs).toEqual([
				{ imageFileId: "file-cottage", number: 1 },
			]);
			expect(options?.imageMarks).toEqual({
				imageFileId: "file-cottage",
				marks: [box],
			});
		});

		it("sends the resend of an edit that failed as an edit's resend again, with the same pictures, when Retry is pressed", async () => {
			renderPage(
				pageData({
					messages: turnWith({
						refs: [cottage],
						open: null,
						marks: marksOnCottage,
					}),
				}),
			);
			await editAndSend();
			runtimeHarness.streamInvocations[0].callbacks.onError(new Error("boom"));

			await fireEvent.click(
				await screen.findByRole("button", { name: "Retry" }),
			);

			await waitFor(() => {
				expect(runtimeHarness.streamInvocations).toHaveLength(2);
			});
			const retried = runtimeHarness.streamInvocations[1];
			expect(retried.message).toBe(editedText);
			expect(retried.options).toMatchObject({
				isEditResend: true,
				pictureRefs: [{ imageFileId: "file-cottage", number: 1 }],
				imageMarks: { imageFileId: "file-cottage", marks: [box] },
			});
			// The edited message is not on the server any more: there is no reply
			// of the turn before to regenerate, and the bubble is still one.
			expect(retried.options?.retryAssistantMessageId).toBeUndefined();
			expect(screen.getAllByTestId("user-message")).toHaveLength(1);
			expect(screen.getAllByTestId("message-picture-chip")).toHaveLength(1);
		});

		it("asks the turn's gate about the same pictures, before anything goes", async () => {
			renderPage(
				pageData({
					messages: turnWith({
						refs: [cottage],
						open: null,
						marks: marksOnCottage,
					}),
				}),
			);

			await editAndSend();

			expect(checkChatTurnMock).toHaveBeenCalledTimes(1);
			expect(checkChatTurnMock).toHaveBeenCalledWith(
				expect.objectContaining({
					conversationId: "conv-1",
					message: editedText,
					attachmentIds: [],
					pictureRefs: [{ imageFileId: "file-cottage", number: 1 }],
					imageMarks: { imageFileId: "file-cottage", marks: [box] },
					isEditResend: true,
				}),
			);
		});

		it("sends marks on an uploaded photo along with the photo the message carries", async () => {
			renderPage(
				pageData({
					messages: [
						{
							...userMessage({
								refs: [],
								uploads: [{ artifactId: "photo-1", number: 1 }],
								open: null,
								marks: {
									uploadArtifactId: "photo-1",
									markedFileId: "file-marked",
									letters: ["A" as const],
									boxes: [box],
								},
							}),
							attachments: [
								{
									id: "photo-1",
									artifactId: "photo-1",
									name: "room.png",
									type: "source_document" as const,
									mimeType: "image/png",
									sizeBytes: 10,
									conversationId: "conv-1",
									messageId: "user-1",
									createdAt: 1,
								},
							],
						},
						...turnWith().slice(1),
					],
				}),
			);

			const options = await editAndSend();

			expect(options?.attachmentIds).toEqual(["photo-1"]);
			expect(options?.imageMarks).toEqual({
				uploadArtifactId: "photo-1",
				marks: [box],
			});
			expect(options?.pictureRefs).toBeUndefined();
		});

		it("gives up marks on a picture that does not go along, as a regenerate does, and sends the rest", async () => {
			renderPage(
				pageData({
					messages: turnWith({
						refs: [cottage],
						open: { imageFileId: "file-old-open", name: "Old" },
						marks: { ...marksOnCottage, imageFileId: "file-old-open" },
					}),
				}),
			);

			const options = await editAndSend();

			expect(options?.pictureRefs).toEqual([
				{ imageFileId: "file-cottage", number: 1 },
			]);
			expect(options?.imageMarks).toBeNull();
		});

		it("sends no pictures for a message that carried none", async () => {
			renderPage(pageData({ messages: turnWith() }));

			const options = await editAndSend();

			expect(options?.pictureRefs).toBeUndefined();
			expect(options?.imageMarks).toBeNull();
			expect(screen.queryByTestId("message-picture-chip")).toBeNull();
		});

		it("reads the record even when the page's copy of the message has no pictures at all", async () => {
			// The landing page's first message, and a message a reconnect appended,
			// carry pictures on the server that the page's copy does not show.
			vi.mocked(fetchConversationDetail).mockResolvedValue(
				conversationDetailFixture({
					messages: [
						userMessage({
							refs: [cottage],
							open: null,
							marks: marksOnCottage,
						}),
					],
				}),
			);
			renderPage(pageData({ messages: turnWith() }));

			const options = await editAndSend();

			expect(options?.pictureRefs).toEqual([
				{ imageFileId: "file-cottage", number: 1 },
			]);
			expect(options?.imageMarks).toEqual({
				imageFileId: "file-cottage",
				marks: [box],
			});
		});

		it("takes the marks from what the server recorded when the page only holds the composer's copy of the message", async () => {
			// A message sent in this tab keeps the pictures the composer drew for its
			// bubble (refs and photos); the boxes are only in the server's record.
			vi.mocked(fetchConversationDetail).mockResolvedValue(
				conversationDetailFixture({
					messages: [
						userMessage({
							refs: [cottage],
							open: null,
							marks: marksOnCottage,
						}),
					],
				}),
			);
			renderPage(
				pageData({
					messages: turnWith({ refs: [cottage], open: null, marks: null }),
				}),
			);

			const options = await editAndSend();

			expect(options?.pictureRefs).toEqual([
				{ imageFileId: "file-cottage", number: 1 },
			]);
			expect(options?.imageMarks).toEqual({
				imageFileId: "file-cottage",
				marks: [box],
			});
		});

		it("does not wait for a record that never answers: the pictures the page holds go", async () => {
			vi.mocked(fetchConversationDetail).mockReturnValue(
				new Promise(() => undefined),
			);
			renderPage(
				pageData({
					messages: turnWith({ refs: [cottage], open: null, marks: null }),
				}),
			);

			const options = await editAndSend(4000);

			expect(options?.pictureRefs).toEqual([
				{ imageFileId: "file-cottage", number: 1 },
			]);
		}, 10_000);

		it("still sends the pictures the page holds when the server cannot be read", async () => {
			vi.mocked(fetchConversationDetail).mockRejectedValue(
				new Error("Network down"),
			);
			renderPage(
				pageData({
					messages: turnWith({ refs: [cottage], open: null, marks: null }),
				}),
			);

			const options = await editAndSend();

			expect(options?.pictureRefs).toEqual([
				{ imageFileId: "file-cottage", number: 1 },
			]);
		});

		it("leaves the marks waiting in the composer alone: the draft set aside gets them back", async () => {
			window.sessionStorage.setItem(
				"composer-marks:conv-1",
				JSON.stringify({
					imageFileId: "file-other",
					marks: [{ letter: "B", x: 0.5, y: 0.5, w: 0.3, h: 0.3 }],
					artifactId: "item-other",
					name: "Other picture",
					version: null,
				}),
			);
			renderPage(
				pageData({
					messages: turnWith({ refs: [cottage], open: null, marks: null }),
				}),
			);
			expect(
				await screen.findByTestId("composer-chip-marks"),
			).toBeInTheDocument();

			const options = await editAndSend();

			// The resend is the message's own: none of the composer's boxes in it...
			expect(options?.imageMarks).toBeNull();
			expect(options?.pictureRefs).toEqual([
				{ imageFileId: "file-cottage", number: 1 },
			]);
			// ...and once the edit is out they are waiting where they were.
			await waitFor(() => {
				expect(screen.queryByTestId("composer-edit-strip")).toBeNull();
				expect(screen.getByTestId("composer-chip-marks")).toBeInTheDocument();
			});
			expect(window.sessionStorage.getItem("composer-marks:conv-1")).toContain(
				"file-other",
			);
		});
	});

	it("offers no other way to start a turn while an edit is open", async () => {
		renderPage(
			cloudModelPageData({
				messages: [
					...conversationTurnFixture(),
					{
						id: "user-2",
						role: "user" as const,
						content: "And tomorrow?",
						timestamp: 3,
					},
					{
						id: "assistant-2",
						role: "assistant" as const,
						content: "Nothing yet.",
						timestamp: 4,
						followUps: ["Book a slot?"],
					},
				],
			}),
		);
		await waitFor(() => {
			expect(fetchActiveCapabilitiesMock).toHaveBeenCalled();
		});
		expect(
			screen.getAllByRole("button", { name: "Regenerate response" }),
		).toHaveLength(2);
		expect(screen.getByText("Book a slot?")).toBeInTheDocument();

		await fireEvent.click(
			screen.getAllByRole("button", { name: "Edit message" })[0],
		);
		await screen.findByTestId("composer-edit-strip");

		expect(
			screen.queryByRole("button", { name: "Regenerate response" }),
		).not.toBeInTheDocument();
		expect(screen.queryByText("Book a slot?")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Edit message" }),
		).not.toBeInTheDocument();
	});

	it("gates Retry: shows the warning, replays the last user message only after acknowledgement", async () => {
		checkCloudWarningMock.mockResolvedValue({ shouldWarn: true });
		ackCloudConnectorMock.mockResolvedValue(undefined);
		renderPage(cloudModelPageData());

		await waitFor(() => {
			expect(fetchActiveCapabilitiesMock).toHaveBeenCalled();
		});

		await fireEvent.input(screen.getByTestId("message-input"), {
			target: { value: "Trigger a failure" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "Send message" }));

		// First send needs its own ack before it even reaches the runtime.
		await screen.findByTestId("cloud-connector-warning");
		await fireEvent.click(screen.getByTestId("cloud-warning-send"));
		await waitFor(() => {
			expect(runtimeHarness.streamInvocations).toHaveLength(1);
		});

		runtimeHarness.streamInvocations[0].callbacks.onError(new Error("boom"));

		const retryButton = await screen.findByRole("button", { name: "Retry" });

		// A later send is already acknowledged for the rest of the session, so
		// Retry dispatches without a second modal.
		await fireEvent.click(retryButton);

		await waitFor(() => {
			expect(runtimeHarness.streamInvocations).toHaveLength(2);
		});
		expect(runtimeHarness.streamInvocations[1].message).toBe(
			"Trigger a failure",
		);
	});

	it("gates Retry with a fresh warning when not yet acknowledged, and Cancel aborts the retry", async () => {
		checkCloudWarningMock.mockResolvedValue({ shouldWarn: false });
		renderPage(cloudModelPageData());

		await waitFor(() => {
			expect(fetchActiveCapabilitiesMock).toHaveBeenCalled();
		});

		await fireEvent.input(screen.getByTestId("message-input"), {
			target: { value: "Trigger a failure" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "Send message" }));
		await waitFor(() => {
			expect(runtimeHarness.streamInvocations).toHaveLength(1);
		});

		runtimeHarness.streamInvocations[0].callbacks.onError(new Error("boom"));
		const retryButton = await screen.findByRole("button", { name: "Retry" });

		// Not acknowledged yet (the first send's check happened to report
		// shouldWarn:false, so no modal was shown and no ack was recorded) —
		// Retry must run its own check and hold until the user decides.
		checkCloudWarningMock.mockResolvedValue({ shouldWarn: true });
		await fireEvent.click(retryButton);

		expect(
			await screen.findByTestId("cloud-connector-warning"),
		).toBeInTheDocument();
		expect(runtimeHarness.streamInvocations).toHaveLength(1);

		await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		expect(runtimeHarness.streamInvocations).toHaveLength(1);
	});

	it("awaits the in-flight capability fetch before gating a brand-new conversation's first message (race fix)", async () => {
		// Simulate the exact race the fix report flagged: the landing-page
		// bootstrap send (`maybeSendPendingInitialMessage`) fires moments after
		// mount, while MessageInput's own on-mount `fetchActiveCapabilities()`
		// call is still unresolved. `ensureCloudWarningAcked` must await it
		// rather than reading the still-empty `composerActiveCapabilities` and
		// concluding "no connectors, no warning".
		let resolveCapabilities:
			| ((value: {
					served: string[];
					defaultOn: string[];
					accounts: never[];
			  }) => void)
			| undefined;
		fetchActiveCapabilitiesMock.mockReset().mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveCapabilities = resolve;
				}),
		);
		checkCloudWarningMock.mockResolvedValue({ shouldWarn: true });
		ackCloudConnectorMock.mockResolvedValue(undefined);

		const { storePendingConversationMessage } = await import(
			"$lib/client/conversation-session"
		);
		storePendingConversationMessage("conv-1", {
			message: "First message ever",
			attachmentIds: [],
			attachments: [],
		});

		renderPage(cloudModelPageData());

		// The composer has mounted and kicked off its capability fetch, but we
		// deliberately haven't resolved it yet.
		await waitFor(() => {
			expect(fetchActiveCapabilitiesMock).toHaveBeenCalled();
		});

		// Let the bootstrap send's requestAnimationFrame fire (real 16ms mock
		// timer, see installAnimationFrameMock) and its async gate call start
		// running. It should now be blocked awaiting the still-pending
		// capability fetch — NOT reading an empty capability set and
		// dispatching unwarned.
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(checkCloudWarningMock).not.toHaveBeenCalled();
		expect(runtimeHarness.streamInvocations).toHaveLength(0);

		// Now let the capability fetch resolve with active connector
		// capabilities — only now can the gate decide.
		resolveCapabilities?.({
			served: ["calendar"],
			defaultOn: ["calendar"],
			accounts: [],
		});

		await waitFor(() => {
			expect(checkCloudWarningMock).toHaveBeenCalledWith(CLOUD_MODEL_ID, [
				"calendar",
			]);
		});
		expect(
			await screen.findByTestId("cloud-connector-warning"),
		).toBeInTheDocument();
		expect(runtimeHarness.streamInvocations).toHaveLength(0);

		await fireEvent.click(screen.getByTestId("cloud-warning-send"));

		await waitFor(() => {
			expect(runtimeHarness.streamInvocations).toHaveLength(1);
		});
		expect(runtimeHarness.streamInvocations[0].message).toBe(
			"First message ever",
		);
	});

	// ADR 0044 Decision 1 — the composer's single Connections master toggle
	// maps to the same `enabledConnectionCapabilities` payload the old
	// per-capability toggles fed: off sends [], which the gate reads as "no
	// active capabilities" and skips the warning entirely, without ever
	// calling checkCloudWarning.
	it("master-off Connections toggle sends no capabilities and skips the warning", async () => {
		checkCloudWarningMock.mockResolvedValue({ shouldWarn: true });
		renderPage(cloudModelPageData());

		await waitFor(() => {
			expect(fetchActiveCapabilitiesMock).toHaveBeenCalled();
		});

		// Connections redesign — the plug opens the account list; the master
		// switch inside it is what silences connections for this message.
		await fireEvent.click(screen.getByTestId("connections-toggle"));
		await fireEvent.click(
			within(screen.getByTestId("connections-popover")).getByRole("switch"),
		);

		await fireEvent.input(screen.getByTestId("message-input"), {
			target: { value: "What's on my calendar?" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "Send message" }));

		await waitFor(() => {
			expect(runtimeHarness.streamInvocations).toHaveLength(1);
		});
		expect(checkCloudWarningMock).not.toHaveBeenCalled();
		expect(runtimeHarness.streamInvocations[0].message).toBe(
			"What's on my calendar?",
		);
	});
});

// The "gates Regenerate" tests above (cloud-connector warning gate describe)
// use a single-turn fixture where the assistant is last, so they never
// exercise the B1 later-turns confirm — regeneratreDropsLaterTurns()/
// laterTurnCount() are covered by pure-helper unit tests in
// lifecycle-guards.test.ts, but the actual wiring (window.confirm + the
// single-prompt interaction with the fork warning) had no end-to-end
// coverage. This describe block renders the real page with a MULTI-turn
// conversation so the non-latest-assistant branch actually runs.
describe("chat page regenerate — later-turns confirm integration (B1)", () => {
	afterEach(() => {
		clearAnimationFrameMockTimers();
		runtimeHarness.atlasFailure = null;
		runtimeHarness.orphanedStream = null;
		vi.restoreAllMocks();
	});

	beforeEach(() => {
		runtimeHarness.streamInvocations.length = 0;
		runtimeHarness.atlasSubmissions.length = 0;
		vi.mocked(fetchConversationDetail).mockResolvedValue(
			conversationDetailFixture(),
		);
		vi.mocked(fetchMessageEvidence).mockReset();
		fetchActiveCapabilitiesMock.mockReset().mockResolvedValue({
			served: [],
			defaultOn: [],
			accounts: [],
		});
		checkCloudWarningMock.mockReset();
		ackCloudConnectorMock.mockReset();
		setLocalDistillMock.mockReset();
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

	// Two full Q&A exchanges — regenerating assistant-1 (non-latest) should
	// warn that it drops the 2 later messages (user-2, assistant-2).
	function multiTurnConversationFixture() {
		return [
			{
				id: "user-1",
				role: "user" as const,
				content: "First question",
				timestamp: 1,
			},
			{
				id: "assistant-1",
				role: "assistant" as const,
				content: "First answer",
				timestamp: 2,
			},
			{
				id: "user-2",
				role: "user" as const,
				content: "Follow-up question",
				timestamp: 3,
			},
			{
				id: "assistant-2",
				role: "assistant" as const,
				content: "Second answer",
				timestamp: 4,
			},
		];
	}

	// The Regenerate button's aria-label ("Regenerate response") is identical
	// on every non-user message, so scope to the Nth rendered assistant bubble
	// rather than relying on uniqueness across the whole page. The hover
	// action row (Regenerate/Fork/etc.) is a DOM sibling of the
	// data-testid="assistant-message" node, not a child of it — same
	// structure as the "gates Edit-then-resend" test's userMessageGroup —
	// so scope to their shared ".group" wrapper.
	function regenerateButtonForAssistant(index: number) {
		const assistantMessages = screen.getAllByTestId("assistant-message");
		const group = assistantMessages[index].parentElement as HTMLElement;
		return within(group).getByRole("button", {
			name: "Regenerate response",
		});
	}

	it("(a) calls window.confirm with the later-turns warning when regenerating a non-latest assistant message", async () => {
		const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
		renderPage(pageData({ messages: multiTurnConversationFixture() }));
		// Markdown content renders through an async pipeline — wait for it so
		// the click below lands on a fully-settled page.
		await screen.findByText("First answer");

		await fireEvent.click(regenerateButtonForAssistant(0));

		await waitFor(() => {
			expect(confirmSpy).toHaveBeenCalledWith(
				"This removes 2 later messages in this conversation. Continue?",
			);
		});
	});

	it("(b) leaves the message list unchanged (no truncation) when the later-turns confirm is declined", async () => {
		vi.spyOn(window, "confirm").mockReturnValue(false);
		renderPage(pageData({ messages: multiTurnConversationFixture() }));
		await screen.findByText("First answer");

		await fireEvent.click(regenerateButtonForAssistant(0));
		await waitFor(() => {
			expect(window.confirm).toHaveBeenCalled();
		});

		expect(screen.getByText("First answer")).toBeInTheDocument();
		expect(screen.getByText("Follow-up question")).toBeInTheDocument();
		expect(screen.getByText("Second answer")).toBeInTheDocument();
		expect(runtimeHarness.streamInvocations).toHaveLength(0);
	});

	it("(c) proceeds with the regenerate, dropping later turns, once the confirm is accepted", async () => {
		vi.spyOn(window, "confirm").mockReturnValue(true);
		renderPage(pageData({ messages: multiTurnConversationFixture() }));
		await screen.findByText("First answer");

		await fireEvent.click(regenerateButtonForAssistant(0));

		await waitFor(() => {
			expect(runtimeHarness.streamInvocations).toHaveLength(1);
		});
		expect(runtimeHarness.streamInvocations[0].message).toBe("First question");
		// The regenerated assistant turn AND everything after it are gone —
		// this is the destructive slice the confirm was warning about.
		expect(screen.queryByText("First answer")).not.toBeInTheDocument();
		expect(screen.queryByText("Follow-up question")).not.toBeInTheDocument();
		expect(screen.queryByText("Second answer")).not.toBeInTheDocument();
	});

	it("(d) prompts exactly once — the fork warning, not also the later-turns warning — when a forked assistant is in range", async () => {
		const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
		// assistant-2 (a later turn, not the message being regenerated) carries
		// the fork — hasForkedAssistantInRange looks at the whole slice from
		// assistantIdx onward, not just the target message.
		const forkedMessages = multiTurnConversationFixture().map((message) =>
			message.id === "assistant-2"
				? {
						...message,
						sourceForks: {
							count: 1,
							forks: [
								{
									conversationId: "fork-1",
									title: "First question (fork 1)",
									forkSequence: 1,
									createdAt: 5,
								},
							],
						},
					}
				: message,
		);
		renderPage(pageData({ messages: forkedMessages }));
		await screen.findByText("First answer");

		await fireEvent.click(regenerateButtonForAssistant(0));

		await waitFor(() => {
			expect(runtimeHarness.streamInvocations).toHaveLength(1);
		});
		expect(confirmSpy).toHaveBeenCalledTimes(1);
		expect(confirmSpy).toHaveBeenCalledWith(
			"Regenerating this response will replace source history that already has forks. Existing forks stay unchanged. Continue?",
		);
	});

	describe("pending write cards", () => {
		function proposedWrite(assistantMessageId: string | null) {
			return {
				id: "pw-1",
				conversationId: "conv-1",
				assistantMessageId,
				status: "pending" as const,
				provider: "google",
				createdAt: Date.now(),
				preview: {
					title: 'Create "Dentist" on your Google Calendar',
					detail: "calendar.create_event — Dentist",
					reversible: true,
					destructive: false,
					withinAllowlist: null,
					warnings: [],
				},
			};
		}

		// A read started mid-turn answers with the row as it was then, before the
		// turn knew its message. Laid over the turn's own read, it took the card
		// off its message, and only a reload brought it back.
		it("keeps a card on its message when an older read answers last", async () => {
			let finishOlderRead: (writes: never[]) => void = () => {};
			vi.mocked(fetchConversationPendingWrites)
				.mockReset()
				.mockReturnValueOnce(
					new Promise((resolve) => {
						finishOlderRead = resolve;
					}),
				)
				.mockResolvedValue([proposedWrite("assistant-1")]);
			renderPage();
			await fireEvent.input(screen.getByTestId("message-input"), {
				target: { value: "Put the dentist in my calendar" },
			});
			await fireEvent.click(
				screen.getByRole("button", { name: "Send message" }),
			);
			const { callbacks } = runtimeHarness.streamInvocations[0];

			callbacks.onToolCall?.("calendar", { action: "create_event" }, "done", {
				callId: "call-1",
			});
			await waitFor(() => {
				expect(fetchConversationPendingWrites).toHaveBeenCalledTimes(1);
			});
			callbacks.onEnd("It is ready for you.", {
				assistantMessageId: "assistant-1",
			});
			expect(await screen.findByTestId("message-pending-writes")).toBeVisible();

			finishOlderRead([proposedWrite(null)] as never[]);
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(screen.getByTestId("message-pending-writes")).toBeVisible();
			vi.mocked(fetchConversationPendingWrites).mockReset();
			vi.mocked(fetchConversationPendingWrites).mockResolvedValue([]);
		});
	});

	describe("conversation title", () => {
		const titleBar = () =>
			document.querySelector(".chat-title-bar .chat-title-main");

		beforeEach(() => {
			conversationsStore.set([]);
			vi.mocked(generateConversationTitle).mockReset();
			vi.mocked(watchConversationTitle).mockClear();
		});

		async function startFirstTurn() {
			await fireEvent.input(screen.getByTestId("message-input"), {
				target: { value: "How does tidal energy work?" },
			});
			await fireEvent.click(
				screen.getByRole("button", { name: "Send message" }),
			);
			expect(runtimeHarness.streamInvocations).toHaveLength(1);
		}

		// The turn goes on without the page, and the server names the chat when
		// it ends. Only the sidebar is left to hear of it.
		it("leaves the title to the sidebar when the person moves to another chat mid-turn", async () => {
			const view = renderPage(
				pageData({
					conversation: conversationFixture("conv-1", {
						title: "New Conversation",
					}),
				}),
			);
			await startFirstTurn();

			await view.rerender({
				data: pageData({
					conversation: conversationFixture("conv-2", {
						title: "Second chat",
						createdAt: 2,
						updatedAt: 2,
					}),
				}),
				params: { conversationId: "conv-2" },
			});

			await waitFor(() => {
				expect(watchConversationTitle).toHaveBeenCalledWith("conv-1");
			});
			expect(watchConversationTitle).toHaveBeenCalledTimes(1);
		});

		it("leaves the title to the sidebar when the page goes away mid-turn", async () => {
			const view = renderPage(
				pageData({
					conversation: conversationFixture("conv-1", {
						title: "New Conversation",
					}),
				}),
			);
			await startFirstTurn();

			view.unmount();

			expect(watchConversationTitle).toHaveBeenCalledWith("conv-1");
		});

		it("watches nothing when the page leaves after the turn has ended", async () => {
			vi.mocked(generateConversationTitle).mockResolvedValue(null);
			const view = renderPage(
				pageData({
					conversation: conversationFixture("conv-1", {
						title: "New Conversation",
					}),
				}),
			);
			await finishFirstTurn();

			view.unmount();

			expect(watchConversationTitle).not.toHaveBeenCalled();
		});

		async function finishFirstTurn() {
			await fireEvent.input(screen.getByTestId("message-input"), {
				target: { value: "How does tidal energy work?" },
			});
			await fireEvent.click(
				screen.getByRole("button", { name: "Send message" }),
			);
			expect(runtimeHarness.streamInvocations).toHaveLength(1);
			runtimeHarness.streamInvocations[0].callbacks.onToken("Tides turn.");
			runtimeHarness.streamInvocations[0].callbacks.onEnd("Tides turn.", {
				assistantMessageId: "assistant-1",
			});
			await waitFor(() => {
				expect(generateConversationTitle).toHaveBeenCalledTimes(1);
			});
		}

		it("shows a generated title in the title bar and document title", async () => {
			vi.mocked(generateConversationTitle).mockResolvedValue(
				"Tidal Energy Basics",
			);
			renderPage(
				pageData({
					conversation: conversationFixture("conv-1", {
						title: "New Conversation",
					}),
				}),
			);

			await finishFirstTurn();

			await waitFor(() => {
				expect(titleBar()).toHaveTextContent("Tidal Energy Basics");
			});
			expect(document.title).toBe("Tidal Energy Basics");
		});

		it("replaces a stale sidebar title with the loaded detail on arrival, but not on a same-conversation reload", async () => {
			conversationsStore.set([
				{
					...conversationFixture("conv-1", { title: "Old sidebar title" }),
				},
			]);
			const view = renderPage(
				pageData({
					conversation: conversationFixture("conv-1", {
						title: "New Conversation",
					}),
				}),
			);
			await waitFor(() => {
				expect(titleBar()).toHaveTextContent("New Conversation");
			});

			// A generated title lands, then a reload of the same conversation
			// that left before the title was saved arrives.
			await renameConversation("conv-1", "Tidal Energy Basics");
			await view.rerender({
				data: pageData({
					conversation: conversationFixture("conv-1", {
						title: "New Conversation",
						updatedAt: 5,
					}),
				}),
				params: { conversationId: "conv-1" },
			});
			await new Promise((resolve) => setTimeout(resolve, 0));

			// The title types itself in (ConversationTitleText), so wait it out.
			await waitFor(() => {
				expect(titleBar()).toHaveTextContent("Tidal Energy Basics");
			});
			expect(
				get(conversationsStore).find((item) => item.id === "conv-1")?.title,
			).toBe("Tidal Energy Basics");
		});

		it("shows a sidebar rename of the open conversation", async () => {
			renderPage(
				pageData({
					conversation: conversationFixture("conv-1", { title: "Chat" }),
				}),
			);
			await waitFor(() => {
				expect(titleBar()).toHaveTextContent("Chat");
			});

			await renameConversation("conv-1", "Renamed chat");

			await waitFor(() => {
				expect(titleBar()).toHaveTextContent("Renamed chat");
			});
			expect(document.title).toBe("Renamed chat");
		});

		it("keeps a late generated title on its own conversation after navigating to another", async () => {
			let resolveTitle: (title: string | null) => void = () => {};
			vi.mocked(generateConversationTitle).mockReturnValue(
				new Promise((resolve) => {
					resolveTitle = resolve;
				}),
			);
			const view = renderPage(
				pageData({
					conversation: conversationFixture("conv-1", {
						title: "New Conversation",
					}),
				}),
			);
			await finishFirstTurn();

			await view.rerender({
				data: pageData({
					conversation: conversationFixture("conv-2", {
						title: "Second chat",
						createdAt: 2,
						updatedAt: 2,
					}),
				}),
				params: { conversationId: "conv-2" },
			});
			resolveTitle("Tidal Energy Basics");
			await new Promise((resolve) => setTimeout(resolve, 0));

			await waitFor(() => {
				expect(titleBar()).toHaveTextContent("Second chat");
			});
			expect(document.title).toBe("Second chat");
			expect(
				get(conversationsStore).find((item) => item.id === "conv-1")?.title,
			).toBe("Tidal Energy Basics");
		});
	});
});
