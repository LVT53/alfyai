import { fireEvent, render, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AtlasJobCard, ChatMessage, FileProductionJob } from "$lib/types";
import MessageArea from "./MessageArea.svelte";

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

Object.defineProperty(HTMLElement.prototype, "animate", {
	writable: true,
	value: () => ({
		finished: Promise.resolve(),
		cancel: () => undefined,
		finish: () => undefined,
	}),
});

describe("MessageArea", () => {
	beforeEach(() => {
		vi.spyOn(window, "requestAnimationFrame").mockImplementation(
			(callback: FrameRequestCallback) => {
				callback(0);
				return 1;
			},
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function makeFileProductionJob(
		assistantMessageId: string | null,
		overrides: Partial<FileProductionJob> = {},
	): FileProductionJob {
		const now = Date.now();
		return {
			id: overrides.id ?? `job-${assistantMessageId}`,
			conversationId: "conv-1",
			assistantMessageId,
			title: overrides.title ?? "Report",
			status: overrides.status ?? "succeeded",
			stage: overrides.stage ?? null,
			createdAt: overrides.createdAt ?? now,
			updatedAt: overrides.updatedAt ?? now,
			warnings: overrides.warnings ?? [],
			error: overrides.error ?? null,
			files: overrides.files ?? [
				{
					id: "file-1",
					filename: "report.pdf",
					mimeType: "application/pdf",
					sizeBytes: 2048,
					downloadUrl: "/api/chat/files/file-1/download",
					previewUrl: "/api/chat/files/file-1/preview",
				},
			],
		};
	}

	function makeAtlasJob(
		assistantMessageId: string | null,
		overrides: Partial<AtlasJobCard> = {},
	): AtlasJobCard {
		const now = Date.now();
		return {
			id: overrides.id ?? `atlas-${assistantMessageId ?? "unassigned"}`,
			conversationId: "conv-1",
			assistantMessageId,
			action: overrides.action ?? "create",
			parentAtlasJobId: overrides.parentAtlasJobId ?? null,
			profile: overrides.profile ?? "overview",
			title: overrides.title ?? "Atlas report",
			status: overrides.status ?? "running",
			stage: overrides.stage ?? "search",
			progress: overrides.progress ?? { percent: 30, stage: "search" },
			sourceCounts: overrides.sourceCounts ?? {
				local: 0,
				web: 4,
				accepted: 2,
				rejected: 1,
			},
			usage: overrides.usage ?? {
				inputTokens: 0,
				outputTokens: 0,
				totalTokens: 0,
				costUsdMicros: 0,
			},
			outputs: overrides.outputs ?? {
				fileProductionJobId: null,
				htmlChatGeneratedFileId: null,
				pdfChatGeneratedFileId: null,
				markdownChatGeneratedFileId: null,
			},
			error: overrides.error ?? null,
			createdAt: overrides.createdAt ?? now,
			updatedAt: overrides.updatedAt ?? now,
			completedAt: overrides.completedAt ?? null,
		};
	}

	it("preserves the expanded thinking block when a streaming placeholder id is replaced", async () => {
		const initialMessage: ChatMessage = {
			id: "temp-assistant-id",
			renderKey: "temp-assistant-id",
			role: "assistant",
			content: "Final answer",
			timestamp: Date.now(),
			thinking: "step one\nstep two",
			thinkingSegments: [{ type: "text", content: "step one\nstep two" }],
			isStreaming: true,
			isThinkingStreaming: false,
		};

		const { getByRole, getByText, rerender } = render(MessageArea, {
			messages: [initialMessage],
			conversationId: "conv-1",
			isThinkingActive: false,
			contextDebug: null,
		});

		await fireEvent.click(getByRole("button", { name: /Thought for 0s?/ }));
		expect(getByText(/step one\s+step two/)).toBeTruthy();

		await rerender({
			messages: [
				{
					...initialMessage,
					id: "persisted-assistant-id",
					renderKey: "temp-assistant-id",
					isStreaming: false,
				},
			],
			conversationId: "conv-1",
			isThinkingActive: false,
			contextDebug: null,
		});

		expect(getByText(/step one\s+step two/)).toBeTruthy();
	});

	it("shows a ready state for empty conversations", () => {
		const { getByText } = render(MessageArea, {
			messages: [],
			conversationId: "conv-1",
			isThinkingActive: false,
			contextDebug: null,
		});

		expect(getByText("Conversation Ready")).toBeInTheDocument();
		expect(
			getByText("Your messages and generated files will appear here."),
		).toBeInTheDocument();
	});

	it("adds the measured active skill session height to scroll clearance", () => {
		const message: ChatMessage = {
			id: "assistant-1",
			role: "assistant",
			content: "Ready.",
			timestamp: Date.now(),
		};

		const { container } = render(MessageArea, {
			messages: [message],
			conversationId: "conv-1",
			isThinkingActive: false,
			contextDebug: null,
			hasActiveSkillSession: true,
			activeSkillSessionHeight: 84,
		});

		const clearance = container.querySelector(".scroll-clearance");
		expect(clearance).toHaveClass("scroll-clearance-active-skill");
		expect(clearance).toHaveStyle({
			"--active-skill-session-height": "84px",
		});
	});

	it("forwards assistant Skill Draft card actions with message and draft ids", async () => {
		const onSaveSkillDraft = vi.fn();
		const onDismissSkillDraft = vi.fn();
		const onPublishSkillDraft = vi.fn();
		const message: ChatMessage = {
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
		};

		const { getByRole } = render(MessageArea, {
			messages: [message],
			conversationId: "conv-1",
			isThinkingActive: false,
			contextDebug: null,
			canPublishSkillDrafts: true,
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

	it("renders an import boundary marker between imported and new messages", () => {
		const messages: ChatMessage[] = [
			{
				id: "imported-user-1",
				role: "user",
				content: "Imported question",
				timestamp: Date.now(),
				importSource: "chatgpt",
			},
			{
				id: "imported-assistant-1",
				role: "assistant",
				content: "Imported answer",
				timestamp: Date.now(),
				importSource: "chatgpt",
			},
			{
				id: "new-user-1",
				role: "user",
				content: "New question",
				timestamp: Date.now(),
			},
			{
				id: "new-assistant-1",
				role: "assistant",
				content: "New answer",
				timestamp: Date.now(),
			},
		];

		const { getByLabelText, getByTestId, getByText, queryAllByTestId } = render(
			MessageArea,
			{
				messages,
				conversationId: "conv-1",
				isThinkingActive: false,
				contextDebug: null,
			},
		);

		expect(getByTestId("import-boundary-marker")).toBe(
			getByLabelText("Imported conversation boundary"),
		);
		expect(getByText("Imported from ChatGPT")).toBeInTheDocument();
		expect(queryAllByTestId("import-boundary-marker")).toHaveLength(1);
	});

	it("does not render an import boundary marker for non-imported conversations", () => {
		const messages: ChatMessage[] = [
			{
				id: "user-1",
				role: "user",
				content: "Question",
				timestamp: Date.now(),
			},
			{
				id: "assistant-1",
				role: "assistant",
				content: "Answer",
				timestamp: Date.now(),
			},
		];

		const { queryByTestId } = render(MessageArea, {
			messages,
			conversationId: "conv-1",
			isThinkingActive: false,
			contextDebug: null,
		});

		expect(queryByTestId("import-boundary-marker")).not.toBeInTheDocument();
	});

	it("renders a fork boundary marker after the copied fork point message", () => {
		const messages: ChatMessage[] = [
			{
				id: "fork-user-1",
				role: "user",
				content: "Original question",
				timestamp: Date.now(),
			},
			{
				id: "fork-assistant-1",
				role: "assistant",
				content: "Copied answer",
				timestamp: Date.now(),
			},
		];

		const { getByLabelText, getByRole, getByTestId, getByText } = render(
			MessageArea,
			{
				messages,
				conversationId: "fork-conv",
				isThinkingActive: false,
				contextDebug: null,
				forkOrigin: {
					forkConversationId: "fork-conv",
					sourceConversationId: "source-conv",
					sourceAssistantMessageId: "source-assistant-1",
					sourceConversationIdAvailable: true,
					sourceAssistantMessageIdAvailable: true,
					copiedForkPointMessageId: "fork-assistant-1",
					sourceTitle: "Source title",
					forkSequence: 1,
					createdAt: Date.now(),
				},
			},
		);

		expect(getByTestId("fork-boundary-marker")).toBe(
			getByLabelText("Conversation fork boundary"),
		);
		expect(getByText("Fork starts here")).toBeInTheDocument();
		const sourceLink = getByRole("link", {
			name: "Open source conversation Source title",
		});
		expect(sourceLink).toHaveTextContent("Copied from Source title");
		expect(sourceLink).toHaveAttribute(
			"href",
			"/chat/source-conv#message-source-assistant-1",
		);
	});

	it("aligns the fork boundary to the top of the chat viewport on initial fork open", async () => {
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
			function (this: HTMLElement) {
				const element = this as HTMLElement;
				if (element.classList.contains("scroll-container")) {
					return {
						top: 25,
						left: 0,
						bottom: 625,
						right: 760,
						width: 760,
						height: 600,
						x: 0,
						y: 25,
						toJSON: () => ({}),
					};
				}
				if (element.getAttribute("data-testid") === "fork-boundary-marker") {
					return {
						top: 225,
						left: 0,
						bottom: 255,
						right: 760,
						width: 760,
						height: 30,
						x: 0,
						y: 225,
						toJSON: () => ({}),
					};
				}
				return {
					top: 0,
					left: 0,
					bottom: 0,
					right: 0,
					width: 0,
					height: 0,
					x: 0,
					y: 0,
					toJSON: () => ({}),
				};
			},
		);
		const messages: ChatMessage[] = [
			{
				id: "fork-user-1",
				role: "user",
				content: "Original question",
				timestamp: Date.now(),
			},
			{
				id: "fork-assistant-1",
				role: "assistant",
				content: "Copied answer",
				timestamp: Date.now(),
			},
			{
				id: "fork-user-2",
				role: "user",
				content: "Fork-local follow-up",
				timestamp: Date.now(),
			},
		];

		const { container } = render(MessageArea, {
			messages,
			conversationId: "fork-conv",
			isThinkingActive: false,
			contextDebug: null,
			forkOrigin: {
				forkConversationId: "fork-conv",
				sourceConversationId: "source-conv",
				sourceAssistantMessageId: "source-assistant-1",
				sourceConversationIdAvailable: true,
				sourceAssistantMessageIdAvailable: true,
				copiedForkPointMessageId: "fork-assistant-1",
				sourceTitle: "Source title",
				forkSequence: 1,
				createdAt: Date.now(),
			},
		});

		const scrollContainer = container.querySelector(
			".scroll-container",
		) as HTMLDivElement;
		await waitFor(() => expect(scrollContainer.scrollTop).toBe(200));
	});

	it("renders a degraded fork boundary source when the source conversation is unavailable", () => {
		const messages: ChatMessage[] = [
			{
				id: "fork-assistant-1",
				role: "assistant",
				content: "Copied answer",
				timestamp: Date.now(),
			},
		];

		const { getByText, queryByRole } = render(MessageArea, {
			messages,
			conversationId: "fork-conv",
			isThinkingActive: false,
			contextDebug: null,
			forkOrigin: {
				forkConversationId: "fork-conv",
				sourceConversationId: "source-conv",
				sourceAssistantMessageId: "source-assistant-1",
				sourceConversationIdAvailable: false,
				sourceAssistantMessageIdAvailable: false,
				copiedForkPointMessageId: "fork-assistant-1",
				sourceTitle: "Deleted source title",
				forkSequence: 1,
				createdAt: Date.now(),
			},
		});

		expect(getByText("Copied from Deleted source title")).toBeInTheDocument();
		expect(getByText("Source conversation unavailable")).toBeInTheDocument();
		expect(
			queryByRole("link", { name: /Deleted source title/ }),
		).not.toBeInTheDocument();
	});

	it("renders fork boundary and origin markers with the same lineage row treatment", () => {
		const messages: ChatMessage[] = [
			{
				id: "fork-assistant-1",
				role: "assistant",
				content: "Copied answer",
				timestamp: Date.now(),
				sourceForks: {
					count: 1,
					forks: [
						{
							conversationId: "child-fork-1",
							title: "Child fork",
							forkSequence: 1,
							createdAt: Date.now(),
						},
					],
				},
			},
		];

		const { getByTestId } = render(MessageArea, {
			messages,
			conversationId: "fork-conv",
			isThinkingActive: false,
			contextDebug: null,
			forkOrigin: {
				forkConversationId: "fork-conv",
				sourceConversationId: "source-conv",
				sourceAssistantMessageId: "source-assistant-1",
				sourceConversationIdAvailable: true,
				sourceAssistantMessageIdAvailable: true,
				copiedForkPointMessageId: "fork-assistant-1",
				sourceTitle: "Source title",
				forkSequence: 1,
				createdAt: Date.now(),
			},
		});

		const boundaryMarker = getByTestId("fork-boundary-marker");
		const originMarker = getByTestId("fork-origin-marker");
		expect(boundaryMarker).toHaveClass("fork-boundary-marker");
		expect(originMarker).toHaveClass("fork-origin-marker");
		expect(
			boundaryMarker.querySelector(".fork-boundary-icon-chip"),
		).toBeTruthy();
		expect(originMarker.querySelector(".fork-origin-icon-chip")).toBeTruthy();
	});

	it("renders context compression markers as compact timeline events", () => {
		const messages: ChatMessage[] = [
			{
				id: "message-1",
				role: "assistant",
				content: "Earlier answer",
				timestamp: Date.now(),
			},
		];

		const { getByLabelText, getByTestId, getByText } = render(MessageArea, {
			messages,
			conversationId: "conv-1",
			contextCompressionMarkers: [
				{
					id: "snapshot-1",
					trigger: "manual",
					status: "valid",
					sourceEndMessageId: "message-1",
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
			],
		});

		expect(getByTestId("context-compression-marker-snapshot-1")).toBe(
			getByLabelText("Compacted context"),
		);
		expect(getByText("Compacted context")).toBeInTheDocument();
		expect(
			getByTestId("context-compression-marker-snapshot-1").querySelector(
				".context-compression-line",
			),
		).not.toBeInTheDocument();
	});

	it("scrolls to reveal file-production cards when they appear at the end of the chat", async () => {
		const initialMessage: ChatMessage = {
			id: "assistant-1",
			renderKey: "assistant-1",
			role: "assistant",
			content: "Here is the report.",
			timestamp: Date.now(),
			isStreaming: false,
			isThinkingStreaming: false,
		};
		const job = makeFileProductionJob("assistant-1", { title: "Report" });

		const { container, getByText, rerender } = render(MessageArea, {
			messages: [initialMessage],
			conversationId: "conv-1",
			isThinkingActive: false,
			contextDebug: null,
			fileProductionJobs: [],
		});

		const scrollContainer = container.querySelector(
			'[aria-live="polite"]',
		) as HTMLDivElement;
		expect(scrollContainer).toBeTruthy();

		let scrollHeight = 640;
		Object.defineProperty(scrollContainer, "clientHeight", {
			configurable: true,
			value: 640,
		});
		Object.defineProperty(scrollContainer, "scrollHeight", {
			configurable: true,
			get: () => scrollHeight,
		});

		scrollContainer.scrollTop = 0;
		await fireEvent.scroll(scrollContainer);

		scrollHeight = 960;
		await rerender({
			messages: [initialMessage],
			conversationId: "conv-1",
			isThinkingActive: false,
			contextDebug: null,
			fileProductionJobs: [job],
		});

		await waitFor(() => {
			expect(getByText("report.pdf")).toBeInTheDocument();
			expect(scrollContainer.scrollTop).toBe(960);
		});
	});

	it("renders a running file-production card instead of a temporary generated-file row", async () => {
		const runningJob = makeFileProductionJob("assistant-1", {
			id: "job-running",
			title: "Draft report",
			status: "running",
			files: [],
		});

		const { container, queryByText } = render(MessageArea, {
			messages: [
				{
					id: "assistant-1",
					renderKey: "assistant-1",
					role: "assistant",
					content: "I am generating the file now.",
					timestamp: Date.now(),
					isStreaming: true,
					isThinkingStreaming: false,
				},
			],
			conversationId: "conv-1",
			isThinkingActive: false,
			contextDebug: null,
			fileProductionJobs: [runningJob],
		});

		expect(
			container.querySelector('[data-testid="file-production-card"]'),
		).toBeInTheDocument();
		expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument();
		expect(queryByText("Draft report")).toBeNull();
		expect(queryByText("In-progress")).toBeNull();
		expect(queryByText("Generating...")).toBeNull();
	});

	it("attaches an unassigned active file-production job to the latest streaming assistant response", () => {
		const runningJob = makeFileProductionJob(null, {
			id: "job-unassigned-running",
			title: "Immediate report",
			status: "running",
			files: [],
		});

		const { container } = render(MessageArea, {
			messages: [
				{
					id: "assistant-earlier",
					renderKey: "assistant-earlier",
					role: "assistant",
					content: "Earlier response",
					timestamp: Date.now(),
					isStreaming: false,
					isThinkingStreaming: false,
				},
				{
					id: "assistant-streaming",
					renderKey: "assistant-streaming",
					role: "assistant",
					content: "I am generating the file now.",
					timestamp: Date.now() + 1,
					isStreaming: true,
					isThinkingStreaming: false,
				},
			],
			conversationId: "conv-1",
			isThinkingActive: false,
			contextDebug: null,
			fileProductionJobs: [runningJob],
		});

		const assistantMessages = container.querySelectorAll(
			'[data-testid="assistant-message"]',
		);
		const card = container.querySelector(
			'[data-testid="file-production-card"]',
		);

		expect(card).toBeInTheDocument();
		expect(assistantMessages[0].contains(card)).toBe(false);
		expect(assistantMessages[1].contains(card)).toBe(true);
	});

	it("renders file-production cards above the evidence toggle inside the latest assistant response", () => {
		const messageTimestamp = Date.now();
		const evidenceItem = {
			id: "evidence-1",
			title: "Research note",
			sourceType: "document" as const,
			status: "selected" as const,
		};
		const job = makeFileProductionJob("assistant-inline-1", {
			id: "job-inline-1",
			title: "Summary",
			files: [
				{
					id: "file-inline-1",
					filename: "summary.txt",
					mimeType: "text/plain",
					sizeBytes: 128,
					downloadUrl: "/api/chat/files/file-inline-1/download",
					previewUrl: "/api/chat/files/file-inline-1/preview",
				},
			],
		});

		const { getByText, getByRole } = render(MessageArea, {
			messages: [
				{
					id: "assistant-inline-1",
					renderKey: "assistant-inline-1",
					role: "assistant",
					content: "Here is the finished file.",
					timestamp: messageTimestamp,
					isStreaming: false,
					isThinkingStreaming: false,
					evidenceSummary: {
						structuredWebSearch: false,
						groups: [
							{
								sourceType: "document",
								label: "Documents",
								reranked: false,
								items: [evidenceItem],
							},
						],
					},
				},
			],
			conversationId: "conv-1",
			isThinkingActive: false,
			contextDebug: null,
			fileProductionJobs: [job],
		});

		const producedFileName = getByText("summary.txt");
		const evidenceToggle = getByRole("button", { name: /Evidence/i });
		expect(
			producedFileName.compareDocumentPosition(evidenceToggle) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("keeps file-production cards attached to the assistant response that created them", () => {
		const firstAssistantId = "assistant-created-file";
		const secondAssistantId = "assistant-follow-up";
		const job = makeFileProductionJob(firstAssistantId, {
			id: "job-scoped-1",
			title: "Scoped file",
			files: [
				{
					id: "file-scoped-1",
					filename: "scope.txt",
					mimeType: "text/plain",
					sizeBytes: 32,
					downloadUrl: "/api/chat/files/file-scoped-1/download",
					previewUrl: "/api/chat/files/file-scoped-1/preview",
				},
			],
		});

		const { container, getByText, rerender } = render(MessageArea, {
			messages: [
				{
					id: firstAssistantId,
					renderKey: firstAssistantId,
					role: "assistant",
					content: "First response",
					timestamp: Date.now(),
					isStreaming: false,
					isThinkingStreaming: false,
				},
				{
					id: secondAssistantId,
					renderKey: secondAssistantId,
					role: "assistant",
					content: "Second response",
					timestamp: Date.now() + 1,
					isStreaming: false,
					isThinkingStreaming: false,
				},
			],
			conversationId: "conv-1",
			isThinkingActive: false,
			contextDebug: null,
			fileProductionJobs: [job],
		});

		const assistantMessages = container.querySelectorAll(
			'[data-testid="assistant-message"]',
		);
		expect(getByText("scope.txt")).toBeInTheDocument();
		expect(assistantMessages[0]).toHaveTextContent("scope.txt");
		expect(assistantMessages[1]).not.toHaveTextContent("scope.txt");

		void rerender({
			messages: [
				{
					id: firstAssistantId,
					renderKey: firstAssistantId,
					role: "assistant",
					content: "First response",
					timestamp: Date.now(),
					isStreaming: false,
					isThinkingStreaming: false,
				},
				{
					id: secondAssistantId,
					renderKey: secondAssistantId,
					role: "assistant",
					content: "Second response",
					timestamp: Date.now() + 1,
					isStreaming: false,
					isThinkingStreaming: false,
				},
			],
			conversationId: "conv-1",
			isThinkingActive: false,
			contextDebug: null,
			fileProductionJobs: [job],
		});

		expect(getByText("scope.txt")).toBeInTheDocument();
		expect(assistantMessages[0]).toHaveTextContent("scope.txt");
		expect(assistantMessages[1]).not.toHaveTextContent("scope.txt");
	});

	it("renders file-production jobs as grouped cards for the assistant response", () => {
		const messageTimestamp = Date.now();
		const fileProductionJob: FileProductionJob = {
			id: "job-grouped-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-job-1",
			title: "Quarterly report package",
			status: "succeeded",
			stage: null,
			createdAt: messageTimestamp,
			updatedAt: messageTimestamp,
			warnings: [],
			error: null,
			files: [
				{
					id: "file-pdf",
					filename: "quarterly-report.pdf",
					mimeType: "application/pdf",
					sizeBytes: 2048,
					downloadUrl: "/api/chat/files/file-pdf/download",
					previewUrl: "/api/chat/files/file-pdf/preview",
				},
				{
					id: "file-html",
					filename: "quarterly-report.html",
					mimeType: "text/html",
					sizeBytes: 4096,
					downloadUrl: "/api/chat/files/file-html/download",
					previewUrl: "/api/chat/files/file-html/preview",
				},
			],
		};

		const { container, getByText } = render(MessageArea, {
			messages: [
				{
					id: "assistant-job-1",
					renderKey: "assistant-job-1",
					role: "assistant",
					content: "I created the report package.",
					timestamp: messageTimestamp,
					isStreaming: false,
					isThinkingStreaming: false,
				},
			],
			conversationId: "conv-1",
			isThinkingActive: false,
			contextDebug: null,
			fileProductionJobs: [fileProductionJob],
		});

		expect(
			container.querySelectorAll('[data-testid="file-production-card"]'),
		).toHaveLength(1);
		expect(getByText("Quarterly report package")).toBeInTheDocument();
		expect(getByText("quarterly-report.pdf")).toBeInTheDocument();
		expect(getByText("quarterly-report.html")).toBeInTheDocument();
		expect(getByText("2 files")).toBeInTheDocument();
	});

	it("renders Atlas jobs inside the assistant response they belong to", async () => {
		const onAtlasLifecycleAction = vi.fn();
		const messageTimestamp = Date.now();
		const atlasJob = makeAtlasJob("assistant-atlas-1", {
			status: "succeeded",
			profile: "in-depth",
			completedAt: messageTimestamp + 90_000,
			outputs: {
				fileProductionJobId: "file-job-1",
				htmlChatGeneratedFileId: "html-file-1",
				pdfChatGeneratedFileId: "pdf-file-1",
				markdownChatGeneratedFileId: "md-file-1",
			},
		});

		const { container, getByRole, getByTestId } = render(MessageArea, {
			messages: [
				{
					id: "assistant-atlas-1",
					renderKey: "assistant-atlas-1",
					role: "assistant",
					content: "Atlas is ready.",
					timestamp: messageTimestamp,
					isStreaming: false,
					isThinkingStreaming: false,
				},
			],
			conversationId: "conv-1",
			isThinkingActive: false,
			contextDebug: null,
			atlasJobs: [atlasJob],
			onAtlasLifecycleAction,
		});

		const assistantMessage = container.querySelector(
			'[data-testid="assistant-message"]',
		);
		const card = getByTestId("atlas-card");
		expect(assistantMessage?.contains(card)).toBe(true);
		expect(card).toHaveTextContent("ATLAS");
		expect(card).toHaveTextContent("In-Depth");

		await fireEvent.click(getByRole("button", { name: "Continue Atlas" }));
		const panel = getByRole("region", { name: "Continue Atlas" });
		await fireEvent.input(within(panel).getByRole("textbox"), {
			target: { value: "Add one more section" },
		});
		await fireEvent.click(
			within(panel).getByRole("button", { name: "Continue Atlas" }),
		);

		expect(onAtlasLifecycleAction).toHaveBeenCalledWith(
			expect.objectContaining({
				jobId: atlasJob.id,
				action: "continue",
				message: "Add one more section",
			}),
		);
	});

	it("emits retry and cancel actions from file-production cards", async () => {
		const onRetryFileProductionJob = vi.fn();
		const onCancelFileProductionJob = vi.fn();
		const messageTimestamp = Date.now();
		const failedJob: FileProductionJob = {
			id: "job-failed",
			conversationId: "conv-1",
			assistantMessageId: "assistant-job-actions",
			title: "Failed report",
			status: "failed",
			stage: null,
			createdAt: messageTimestamp,
			updatedAt: messageTimestamp,
			warnings: [],
			error: {
				code: "renderer_timeout",
				message: "Renderer timed out.",
				retryable: true,
			},
			files: [],
		};
		const runningJob: FileProductionJob = {
			...failedJob,
			id: "job-running",
			title: "Running report",
			status: "running",
			error: null,
		};

		const { getByRole } = render(MessageArea, {
			messages: [
				{
					id: "assistant-job-actions",
					renderKey: "assistant-job-actions",
					role: "assistant",
					content: "Working on files.",
					timestamp: messageTimestamp,
					isStreaming: false,
					isThinkingStreaming: false,
				},
			],
			conversationId: "conv-1",
			isThinkingActive: false,
			contextDebug: null,
			fileProductionJobs: [failedJob, runningJob],
			onRetryFileProductionJob,
			onCancelFileProductionJob,
		});

		await fireEvent.click(
			getByRole("button", { name: "Retry file production" }),
		);
		await fireEvent.click(
			getByRole("button", { name: "Cancel file production" }),
		);

		expect(onRetryFileProductionJob).toHaveBeenCalledWith("job-failed");
		expect(onCancelFileProductionJob).toHaveBeenCalledWith("job-running");
	});
});
