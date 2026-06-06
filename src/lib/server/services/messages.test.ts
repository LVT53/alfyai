import { beforeEach, describe, expect, it, vi } from "vitest";

type MessageRow = {
	id: string;
	conversationId: string;
	messageSequence?: number | null;
	role: "user" | "assistant";
	content: string;
	thinking: string | null;
	toolCalls: string | null;
	metadataJson: string | null;
	createdAt: Date;
};

type UsageRow = {
	messageId: string;
	modelId?: string | null;
	modelDisplayName?: string | null;
	generationTimeMs?: number | null;
	costUsdMicros?: number | null;
	completionTokens?: number | null;
	reasoningTokens?: number | null;
	totalTokens?: number | null;
};

const {
	mockRows,
	mockUsageRows,
	mockSelect,
	mockInsert,
	mockUpdate,
	mockDelete,
	mockTransaction,
} = vi.hoisted(() => {
	const mockRows: MessageRow[] = [];
	const mockUsageRows: UsageRow[] = [];

	const applySelection = (selection: Record<string, unknown>) => {
		if (Object.keys(selection).length === 1 && "value" in selection) {
			return [
				{
					value:
						Math.max(0, ...mockRows.map((row) => row.messageSequence ?? 0)) + 1,
				},
			];
		}
		if ("message" in selection) {
			return mockRows.map((row) => {
				const usage = mockUsageRows.find(
					(candidate) => candidate.messageId === row.id,
				);
				const usageAliases: Record<string, keyof UsageRow> = {
					model: "modelId",
				};
				return Object.fromEntries(
					Object.keys(selection).map((key) => {
						if (key === "message") return [key, row];
						const usageKey = usageAliases[key] ?? (key as keyof UsageRow);
						return [key, usage?.[usageKey] ?? null];
					}),
				);
			});
		}
		return mockRows.map((row) =>
			Object.fromEntries(
				Object.keys(selection).map((key) => [
					key,
					row[key as keyof MessageRow],
				]),
			),
		);
	};

	const mockSelect = vi.fn((selection: Record<string, unknown>) => {
		const builder = {
			from: vi.fn(() => builder),
			leftJoin: vi.fn(() => builder),
			where: vi.fn(() => builder),
			all: vi.fn(() => applySelection(selection)),
			orderBy: vi.fn(() => Promise.resolve(applySelection(selection))),
			limit: vi.fn((count: number) =>
				Promise.resolve(applySelection(selection).slice(0, count)),
			),
			get: vi.fn(() => applySelection(selection)[0]),
		};

		return builder;
	});

	const mockInsert = vi.fn(() => ({
		values: vi.fn((values: Omit<MessageRow, "createdAt">) => ({
			returning: vi.fn(() => {
				const row = {
					...values,
					createdAt: new Date("2026-03-29T12:00:00.000Z"),
				};
				mockRows.push(row);
				return {
					get: vi.fn(() => row),
					all: vi.fn(() => [row]),
				};
			}),
		})),
	}));

	const mockUpdate = vi.fn(() => {
		const builder = {
			set: vi.fn((values: { metadataJson: string | null }) => {
				const chain = {
					where: vi.fn(async () => {
						if (mockRows[0]) {
							mockRows[0].metadataJson = values.metadataJson;
						}
					}),
				};
				return chain;
			}),
		};

		return builder;
	});

	const mockDelete = vi.fn(() => {
		const run = vi.fn(() => undefined);
		const builder = {
			where: vi.fn(() => ({
				run,
			})),
		};

		return builder;
	});

	const mockTransaction = vi.fn((callback: (tx: unknown) => unknown) =>
		callback({
			select: mockSelect,
			insert: mockInsert,
			update: mockUpdate,
			delete: mockDelete,
			run: vi.fn(),
		}),
	);

	return {
		mockRows,
		mockUsageRows,
		mockSelect,
		mockInsert,
		mockUpdate,
		mockDelete,
		mockTransaction,
	};
});

vi.mock("$lib/server/db", () => ({
	db: {
		select: mockSelect,
		insert: mockInsert,
		update: mockUpdate,
		delete: mockDelete,
		transaction: mockTransaction,
	},
}));

vi.mock("$lib/server/db/schema", () => ({
	conversations: { id: "id", userId: "userId" },
	contextCompressionSnapshots: {
		conversationId: "conversationId",
		sourceEndMessageSequence: "sourceEndMessageSequence",
	},
	messages: {
		id: "id",
		conversationId: "conversationId",
		role: "role",
		content: "content",
		thinking: "thinking",
		toolCalls: "toolCalls",
		metadataJson: "metadataJson",
		messageSequence: "messageSequence",
		createdAt: "createdAt",
	},
	messageAnalytics: {
		model: "model",
		messageId: "messageId",
	},
	usageEvents: {
		messageId: "messageId",
		modelId: "modelId",
		modelDisplayName: "modelDisplayName",
		generationTimeMs: "generationTimeMs",
		costUsdMicros: "costUsdMicros",
		completionTokens: "completionTokens",
		reasoningTokens: "reasoningTokens",
		totalTokens: "totalTokens",
	},
}));

vi.mock("$lib/server/config-store", () => ({
	getConfig: () => ({
		model1: { displayName: "Model 1" },
		model2: { displayName: "Model 2" },
	}),
}));

vi.mock("./knowledge", () => ({
	listMessageAttachments: vi.fn(async () => new Map()),
}));

describe("messages Honcho metadata", () => {
	beforeEach(() => {
		mockRows.length = 0;
		mockUsageRows.length = 0;
		vi.clearAllMocks();
	});

	it("deletes message rows without deleting immutable usage events", async () => {
		const { deleteMessages } = await import("./messages");
		const { messages, usageEvents } = await import("$lib/server/db/schema");

		await deleteMessages(["assistant-1", "assistant-2"]);

		expect(mockDelete).toHaveBeenCalledTimes(1);
		expect(mockDelete).toHaveBeenCalledWith(messages);
		expect(mockDelete).not.toHaveBeenCalledWith(usageEvents);
	});

	it("hydrates assistant response token counts from usage events when listing messages", async () => {
		mockRows.push({
			id: "assistant-usage-1",
			conversationId: "conv-1",
			role: "assistant",
			content: "Stored answer",
			thinking: null,
			toolCalls: null,
			createdAt: new Date("2026-03-29T12:00:00.000Z"),
			metadataJson: null,
		});
		mockUsageRows.push({
			messageId: "assistant-usage-1",
			modelId: "provider:local:model-a",
			modelDisplayName: "Provider Model A",
			generationTimeMs: 1250,
			costUsdMicros: 42,
			completionTokens: 321,
			reasoningTokens: 17,
			totalTokens: 700,
		});

		const { listMessages } = await import("./messages");

		await expect(listMessages("conv-1")).resolves.toEqual([
			expect.objectContaining({
				id: "assistant-usage-1",
				modelId: "provider:local:model-a",
				modelDisplayName: "Provider Model A",
				generationDurationMs: 1250,
				costUsd: 0.000042,
				responseTokenCount: 321,
				thinkingTokenCount: 17,
				totalTokenCount: 700,
			}),
		]);
	});

	it("preserves Honcho metadata when evidence metadata is updated", async () => {
		mockRows.push({
			id: "assistant-1",
			conversationId: "conv-1",
			role: "assistant",
			content: "Stored answer",
			thinking: null,
			toolCalls: null,
			createdAt: new Date("2026-03-29T12:00:00.000Z"),
			metadataJson: JSON.stringify({
				honchoContext: {
					source: "live",
					waitedMs: 42,
					queuePendingWorkUnits: 0,
					queueInProgressWorkUnits: 0,
					fallbackReason: null,
					snapshotCreatedAt: 111,
				},
				honchoSnapshot: {
					createdAt: 111,
					summary: "Stored summary",
					messages: [
						{
							role: "assistant",
							content: "Stored answer",
							createdAt: Date.parse("2026-03-29T12:00:00.000Z"),
						},
					],
				},
			}),
		});

		const { updateMessageEvidence } = await import("./messages");

		await updateMessageEvidence("assistant-1", {
			evidenceStatus: "ready",
			evidenceSummary: {
				groups: [
					{
						label: "Memory",
						items: [],
					},
				],
			},
		});

		const metadata = JSON.parse(String(mockRows[0]?.metadataJson));
		expect(metadata.honchoContext).toMatchObject({ source: "live" });
		expect(metadata.honchoSnapshot).toMatchObject({
			summary: "Stored summary",
		});
		expect(metadata.evidenceStatus).toBe("ready");
		expect(metadata.evidenceSummary.groups).toHaveLength(1);
	});

	it("preserves evidence metadata when Honcho metadata is updated", async () => {
		mockRows.push({
			id: "assistant-1",
			conversationId: "conv-1",
			role: "assistant",
			content: "Stored answer",
			thinking: null,
			toolCalls: null,
			createdAt: new Date("2026-03-29T12:00:00.000Z"),
			metadataJson: JSON.stringify({
				evidenceStatus: "ready",
				evidenceSummary: {
					groups: [
						{
							label: "Memory",
							items: [],
						},
					],
				},
			}),
		});

		const { updateMessageHonchoMetadata } = await import("./messages");

		await updateMessageHonchoMetadata("assistant-1", {
			honchoContext: {
				source: "snapshot",
				waitedMs: 100,
				queuePendingWorkUnits: 1,
				queueInProgressWorkUnits: 0,
				fallbackReason: "timeout",
				snapshotCreatedAt: 222,
			},
			honchoSnapshot: {
				createdAt: 222,
				summary: "Snapshot summary",
				messages: [
					{
						role: "user",
						content: "Snapshot question",
						createdAt: Date.parse("2026-03-29T12:00:00.000Z"),
					},
				],
			},
		});

		const metadata = JSON.parse(String(mockRows[0]?.metadataJson));
		expect(metadata.evidenceStatus).toBe("ready");
		expect(metadata.evidenceSummary.groups).toHaveLength(1);
		expect(metadata.honchoContext).toMatchObject({
			source: "snapshot",
			fallbackReason: "timeout",
		});
		expect(metadata.honchoSnapshot).toMatchObject({
			summary: "Snapshot summary",
		});
	});

	it("preserves existing metadata when web citation audit is updated", async () => {
		mockRows.push({
			id: "assistant-1",
			conversationId: "conv-1",
			role: "assistant",
			content: "Stored answer",
			thinking: null,
			toolCalls: null,
			createdAt: new Date("2026-03-29T12:00:00.000Z"),
			metadataJson: JSON.stringify({
				evidenceStatus: "ready",
				evidenceSummary: {
					groups: [
						{
							label: "Web Search",
							items: [],
						},
					],
				},
				honchoContext: {
					source: "live",
					waitedMs: 42,
					queuePendingWorkUnits: 0,
					queueInProgressWorkUnits: 0,
					fallbackReason: null,
					snapshotCreatedAt: 111,
				},
			}),
		});

		const { updateMessageWebCitationAudit } = await import("./messages");

		await updateMessageWebCitationAudit("assistant-1", {
			status: "unsupported_citations",
			retrievedSourceCount: 1,
			citedUrlCount: 1,
			supportedCitationCount: 0,
			unsupportedCitationCount: 1,
			citations: [
				{
					url: "https://example.com/other",
					canonicalUrl: "https://example.com/other",
					supported: false,
					matchType: "host",
					matchedSourceId: "src-1",
					matchedSourceTitle: "Official source",
					matchedSourceUrl: "https://example.com/source",
				},
			],
		});

		const metadata = JSON.parse(String(mockRows[0]?.metadataJson));
		expect(metadata.evidenceStatus).toBe("ready");
		expect(metadata.evidenceSummary.groups).toHaveLength(1);
		expect(metadata.honchoContext).toMatchObject({ source: "live" });
		expect(metadata.webCitationAudit).toMatchObject({
			status: "unsupported_citations",
			unsupportedCitationCount: 1,
		});
	});

	it("returns the newest available Honcho context and snapshot across assistant messages", async () => {
		mockRows.push(
			{
				id: "assistant-newest",
				conversationId: "conv-1",
				role: "assistant",
				content: "Newest answer",
				thinking: null,
				toolCalls: null,
				createdAt: new Date("2026-03-29T12:01:00.000Z"),
				metadataJson: JSON.stringify({
					honchoContext: {
						source: "live",
						waitedMs: 75,
						queuePendingWorkUnits: 0,
						queueInProgressWorkUnits: 0,
						fallbackReason: null,
						snapshotCreatedAt: 333,
					},
				}),
			},
			{
				id: "assistant-older",
				conversationId: "conv-1",
				role: "assistant",
				content: "Older answer",
				thinking: null,
				toolCalls: null,
				createdAt: new Date("2026-03-29T12:00:00.000Z"),
				metadataJson: JSON.stringify({
					honchoSnapshot: {
						createdAt: 222,
						summary: "Older snapshot",
						messages: [
							{
								role: "assistant",
								content: "Older answer",
								createdAt: Date.parse("2026-03-29T12:00:00.000Z"),
							},
						],
					},
				}),
			},
		);

		const { getLatestHonchoMetadata } = await import("./messages");

		const metadata = await getLatestHonchoMetadata("conv-1");

		expect(metadata.honchoContext).toMatchObject({
			source: "live",
			waitedMs: 75,
		});
		expect(metadata.honchoSnapshot).toMatchObject({
			summary: "Older snapshot",
		});
	});

	it("ignores Honcho metadata inherited on copied fork messages", async () => {
		mockRows.push({
			id: "assistant-copied",
			conversationId: "fork-conv-1",
			role: "assistant",
			content: "Copied source answer",
			thinking: null,
			toolCalls: null,
			createdAt: new Date("2026-03-29T12:00:00.000Z"),
			metadataJson: JSON.stringify({
				forkCopy: {
					sourceMessageId: "source-assistant-1",
					sourceConversationId: "source-conv-1",
					sourceRole: "assistant",
					sourceCreatedAt: "2026-03-29T11:00:00.000Z",
				},
				honchoContext: {
					source: "snapshot",
					waitedMs: 100,
					queuePendingWorkUnits: 1,
					queueInProgressWorkUnits: 0,
					fallbackReason: "timeout",
					snapshotCreatedAt: 222,
				},
				honchoSnapshot: {
					createdAt: 222,
					summary: "Source conversation snapshot",
					messages: [
						{
							role: "assistant",
							content: "Source-only memory",
							createdAt: Date.parse("2026-03-29T11:00:00.000Z"),
						},
					],
				},
			}),
		});

		const { getLatestHonchoMetadata } = await import("./messages");

		await expect(getLatestHonchoMetadata("fork-conv-1")).resolves.toEqual({
			honchoContext: null,
			honchoSnapshot: null,
		});
	});

	it("identifies assistant messages copied into forks", async () => {
		mockRows.push({
			id: "assistant-copied",
			conversationId: "fork-conv-1",
			role: "assistant",
			content: "Copied source answer",
			thinking: null,
			toolCalls: null,
			createdAt: new Date("2026-03-29T12:00:00.000Z"),
			metadataJson: JSON.stringify({
				forkCopy: {
					sourceMessageId: "source-assistant-1",
					sourceConversationId: "source-conv-1",
					sourceRole: "assistant",
					sourceCreatedAt: "2026-03-29T11:00:00.000Z",
				},
			}),
		});

		const { isAssistantMessageForkCopy } = await import("./messages");

		await expect(
			isAssistantMessageForkCopy({
				conversationId: "fork-conv-1",
				messageId: "assistant-copied",
			}),
		).resolves.toBe(true);
	});

	it("persists and returns Skill Question metadata on assistant messages", async () => {
		const { createMessage } = await import("./messages");

		const message = await createMessage(
			"conv-1",
			"assistant",
			"Which deadline should I use?",
			undefined,
			undefined,
			{
				skillQuestion: true,
				pendingSkillNoteIntents: [
					{
						operationId: "note-1",
						kind: "note_intent",
						action: "create",
						title: "Draft note",
						body: "Capture later.",
					},
				],
				skillControl: {
					envelopeVersion: 1,
					malformedEnvelopeCount: 0,
					operations: [
						{
							operationId: "question-1",
							kind: "session_transition",
							transition: "awaiting_user",
						},
					],
				},
			},
		);

		expect(message).toMatchObject({
			content: "Which deadline should I use?",
			skillQuestion: true,
			pendingSkillNoteIntents: [
				expect.objectContaining({ operationId: "note-1" }),
			],
			skillControl: expect.objectContaining({
				envelopeVersion: 1,
				operations: [expect.objectContaining({ operationId: "question-1" })],
			}),
		});
		expect(JSON.parse(mockRows.at(-1)?.metadataJson ?? "{}")).toMatchObject({
			skillQuestion: true,
		});
	});

	it("persists and returns compact Depth Metadata on assistant messages", async () => {
		const { createMessage } = await import("./messages");

		const created = await createMessage(
			"conv-1",
			"assistant",
			"Depth-aware answer",
			undefined,
			undefined,
			{
				depthMetadata: {
					requested: "max",
					appliedProfile: "maximum",
					fallback: false,
					modelId: "provider:local:model-a",
					modelDisplayName: "Provider Model A",
					providerDisplayName: "Local Provider",
				},
			},
		);

		expect(created.depthMetadata).toEqual({
			requested: "max",
			appliedProfile: "maximum",
			fallback: false,
			modelId: "provider:local:model-a",
			modelDisplayName: "Provider Model A",
			providerDisplayName: "Local Provider",
		});
		expect(JSON.parse(mockRows.at(-1)?.metadataJson ?? "{}")).toMatchObject({
			depthMetadata: {
				requested: "max",
				appliedProfile: "maximum",
				fallback: false,
			},
		});
	});

	it("hydrates Extended Depth Metadata from persisted assistant messages", async () => {
		const { createMessage } = await import("./messages");

		const created = await createMessage("conv-1", "assistant", "Extended-depth answer", undefined, undefined, {
			depthMetadata: {
				requested: "auto",
				appliedProfile: "extended",
				fallback: false,
				classifierSource: "control_model",
			},
		});

		expect(created.depthMetadata).toEqual({
			requested: "auto",
			appliedProfile: "extended",
			fallback: false,
			classifierSource: "control_model",
		});
	});

	it("compacts Skill Note operation bodies before persisting assistant metadata", async () => {
		const { createMessage } = await import("./messages");

		const message = await createMessage(
			"conv-1",
			"assistant",
			"I captured that.",
			undefined,
			undefined,
			{
				pendingSkillNoteIntents: [
					{
						operationId: "note-secret-1",
						kind: "note_intent",
						action: "create",
						title: "Private decision",
						body: "SECRET_NOTE_BODY should not be exposed through message metadata.",
					},
				],
				skillControl: {
					envelopeVersion: 1,
					malformedEnvelopeCount: 0,
					operations: [
						{
							operationId: "note-secret-1",
							kind: "note_intent",
							action: "create",
							title: "Private decision",
							body: "SECRET_NOTE_BODY should not be exposed through message metadata.",
						},
					],
				},
			},
		);

		const metadataJson = mockRows.at(-1)?.metadataJson ?? "";
		expect(metadataJson).not.toContain("SECRET_NOTE_BODY");
		expect(message.pendingSkillNoteIntents).toEqual([
			expect.objectContaining({
				operationId: "note-secret-1",
				action: "create",
				bodyLength: 64,
			}),
		]);
		expect(message.skillControl?.operations).toEqual([
			expect.objectContaining({
				operationId: "note-secret-1",
				action: "create",
				bodyLength: 64,
			}),
		]);
	});

	it("preserves Skill Draft metadata and updates draft status on assistant messages", async () => {
		const { createMessage, updateAssistantMessageSkillDraftStatus } =
			await import("./messages");

		const message = await createMessage(
			"conv-1",
			"assistant",
			"I can turn that into a reusable skill.",
			undefined,
			undefined,
			{
				skillDrafts: [
					{
						id: "draft-1",
						status: "proposed",
						displayName: "Meeting critic",
						description: "Review meeting notes for weak follow-ups.",
						instructions:
							"Find missing owners, vague deadlines, and risky assumptions.",
						activationExamples: ["review these meeting notes"],
						durationPolicy: "next_message",
						questionPolicy: "none",
						notesPolicy: "none",
						sourceScope: "selected_sources_only",
					},
				],
			},
		);

		expect(message.skillDrafts).toEqual([
			expect.objectContaining({
				id: "draft-1",
				status: "proposed",
				displayName: "Meeting critic",
			}),
		]);

		const updatedDraft = await updateAssistantMessageSkillDraftStatus({
			conversationId: "conv-1",
			messageId: message.id,
			draftId: "draft-1",
			status: "dismissed",
		});

		expect(updatedDraft).toMatchObject({
			id: "draft-1",
			status: "dismissed",
		});
		expect(JSON.parse(mockRows.at(-1)?.metadataJson ?? "{}")).toMatchObject({
			skillDrafts: [
				{
					id: "draft-1",
					status: "dismissed",
				},
			],
		});
	});

	it("guards Skill Draft status transitions and treats repeated saves as idempotent", async () => {
		const { createMessage, updateAssistantMessageSkillDraftStatus } =
			await import("./messages");

		const message = await createMessage(
			"conv-1",
			"assistant",
			"I can turn that into a reusable skill.",
			undefined,
			undefined,
			{
				skillDrafts: [
					{
						id: "draft-1",
						status: "proposed",
						displayName: "Meeting critic",
						description: "Review meeting notes for weak follow-ups.",
						instructions:
							"Find missing owners, vague deadlines, and risky assumptions.",
						activationExamples: ["review these meeting notes"],
						durationPolicy: "next_message",
						questionPolicy: "none",
						notesPolicy: "none",
						sourceScope: "selected_sources_only",
					},
				],
			},
		);

		const saved = await updateAssistantMessageSkillDraftStatus({
			conversationId: "conv-1",
			messageId: message.id,
			draftId: "draft-1",
			status: "saved",
			savedSkillId: "skill-1",
		});
		expect(saved).toMatchObject({
			id: "draft-1",
			status: "saved",
			savedSkillId: "skill-1",
		});

		const repeated = await updateAssistantMessageSkillDraftStatus({
			conversationId: "conv-1",
			messageId: message.id,
			draftId: "draft-1",
			status: "saved",
			savedSkillId: "skill-2",
		});
		expect(repeated).toMatchObject({
			id: "draft-1",
			status: "saved",
			savedSkillId: "skill-1",
		});

		await expect(
			updateAssistantMessageSkillDraftStatus({
				conversationId: "conv-1",
				messageId: message.id,
				draftId: "draft-1",
				status: "dismissed",
			}),
		).rejects.toMatchObject({
			code: "skill_draft_transition_conflict",
			status: 409,
		});
	});
});
