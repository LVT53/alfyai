import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockFindRelevantArtifactsByTypesDetailed,
	mockGetArtifactsForUser,
	mockGetArtifactOwnershipScope,
	mockIsArtifactCanonicallyOwned,
	mockIsGeneratedDocumentPromptEligible,
	mockMapArtifact,
	mockMapArtifactSummary,
	mockResolveCurrentGeneratedDocumentSelection,
	mockResolveRelevantGeneratedDocumentSelection,
	mockResolveWorkingDocumentSelection,
	mockDbInsert,
	mockDbInsertValues,
	mockDbSelect,
	mockDbSelectQueue,
	mockDbUpdate,
	mockDbUpdateSet,
} = vi.hoisted(() => {
	type RankedArtifactMatchStub = {
		artifact: Record<string, unknown>;
		lexicalScore: number;
		semanticScore: number;
		rerankScore: number;
		finalScore: number;
	};
	const mockFindRelevantArtifactsByTypesDetailed = vi.fn(
		async (_params: {
			userId: string;
			query: string;
			types: string[];
			limit: number;
			excludeConversationId?: string;
			queryEmbedding?: number[];
		}): Promise<RankedArtifactMatchStub[]> => [],
	);
	const mockGetArtifactsForUser = vi.fn(
		async (_userId: string, _artifactIds: string[]): Promise<unknown[]> => [],
	);
	const mockGetArtifactOwnershipScope = vi.fn(async (_userId: string) => ({}));
	const mockIsArtifactCanonicallyOwned = vi.fn(
		(_params: {
			userId: string;
			ownershipScope: { conversationIds: Set<string> };
			artifact: {
				userId: string;
				type: string;
				conversationId?: string | null;
			};
		}) => true,
	);
	const mockIsGeneratedDocumentPromptEligible = vi.fn(
		(_params: { reasonCodes: string[] }) => true,
	);
	const mockMapArtifact = vi.fn((artifact) => artifact);
	const mockMapArtifactSummary = vi.fn((artifact) => artifact);
	const mockResolveCurrentGeneratedDocumentSelection = vi.fn(() => ({
		primaryArtifactId: null,
		latestArtifactIds: [],
		latestArtifacts: [],
		primaryReasonCodes: [],
	}));
	const mockResolveRelevantGeneratedDocumentSelection = vi.fn(() => ({
		orderedArtifacts: [],
		diagnostics: [],
	}));
	const mockResolveWorkingDocumentSelection = vi.fn();
	const mockDbSelectQueue: Array<{
		final: "where" | "orderBy" | "limit";
		rows: unknown[];
	}> = [];
	const mockDbInsertValues = vi.fn(() => ({
		onConflictDoUpdate: vi.fn(() => ({
			returning: vi.fn(async () => []),
		})),
	}));
	const mockDbInsert = vi.fn(() => ({
		values: mockDbInsertValues,
	}));
	const mockDbUpdateSet = vi.fn(() => ({
		where: vi.fn(async () => []),
	}));
	const mockDbUpdate = vi.fn(() => ({
		set: mockDbUpdateSet,
	}));
	const createSelectChain = () => {
		const queued = mockDbSelectQueue.shift() ?? { final: "where", rows: [] };
		const consumeRows = () => Promise.resolve(queued.rows);
		const chain = {
			from: vi.fn(() => chain),
			innerJoin: vi.fn(() => chain),
			where: vi.fn(() => (queued.final === "where" ? consumeRows() : chain)),
			orderBy: vi.fn(() =>
				queued.final === "orderBy" ? consumeRows() : chain,
			),
			limit: vi.fn(() => consumeRows()),
		};
		return chain;
	};
	const mockDbSelect = vi.fn(() => createSelectChain());

	return {
		mockFindRelevantArtifactsByTypesDetailed,
		mockGetArtifactsForUser,
		mockGetArtifactOwnershipScope,
		mockIsArtifactCanonicallyOwned,
		mockIsGeneratedDocumentPromptEligible,
		mockMapArtifact,
		mockMapArtifactSummary,
		mockResolveCurrentGeneratedDocumentSelection,
		mockResolveRelevantGeneratedDocumentSelection,
		mockResolveWorkingDocumentSelection,
		mockDbInsert,
		mockDbInsertValues,
		mockDbSelect,
		mockDbSelectQueue,
		mockDbUpdate,
		mockDbUpdateSet,
	};
});

vi.mock("$lib/server/db", () => ({
	db: {
		select: mockDbSelect,
		insert: mockDbInsert,
		update: mockDbUpdate,
	},
}));

vi.mock("./store", () => ({
	findRelevantArtifactsByTypesDetailed:
		mockFindRelevantArtifactsByTypesDetailed,
	getArtifactsForUser: mockGetArtifactsForUser,
	getArtifactOwnershipScope: mockGetArtifactOwnershipScope,
	isArtifactCanonicallyOwned: mockIsArtifactCanonicallyOwned,
	listConversationSourceArtifactIds: vi.fn(async () => []),
	mapArtifact: mockMapArtifact,
	mapArtifactSummary: mockMapArtifactSummary,
	parseWorkingDocumentMetadata: vi.fn(() => ({})),
	getCompactionUiThreshold: vi.fn(() => 80_000),
	getMaxModelContext: vi.fn(() => 100_000),
	getTargetConstructedContext: vi.fn(() => 60_000),
}));

vi.mock("../memory-behavior-log", () => ({
	countRecentMemoryBehaviorEventsBySubject: vi.fn(async () => new Map()),
}));

vi.mock("../document-resolution", () => ({
	getGeneratedDocumentBehaviorKey: vi.fn(
		(artifact: { id: string }) => artifact.id,
	),
	isGeneratedDocumentPromptEligible: mockIsGeneratedDocumentPromptEligible,
	resolveCurrentGeneratedDocumentSelection:
		mockResolveCurrentGeneratedDocumentSelection,
	resolveRelevantGeneratedDocumentSelection:
		mockResolveRelevantGeneratedDocumentSelection,
}));

vi.mock("../working-document-selection", () => ({
	resolveWorkingDocumentSelection: mockResolveWorkingDocumentSelection,
}));

function artifact(overrides: Record<string, unknown> = {}) {
	return {
		id: "artifact-1",
		userId: "user-1",
		type: "generated_output",
		retrievalClass: "durable",
		name: "Project brief.pdf",
		mimeType: "application/pdf",
		sizeBytes: 1024,
		conversationId: "conv-1",
		summary: "Project brief",
		metadata: {
			documentFamilyId: "family-brief",
			documentLabel: "Project brief",
			versionNumber: 1,
		},
		contentText: "Project brief text",
		extension: "pdf",
		storagePath: null,
		createdAt: Date.parse("2026-04-01T10:00:00Z"),
		updatedAt: Date.parse("2026-04-01T10:00:00Z"),
		...overrides,
	};
}

function workingSetItem(overrides: Record<string, unknown> = {}) {
	return {
		id: "item-1",
		userId: "user-1",
		conversationId: "conv-1",
		artifactId: "artifact-1",
		artifactType: "generated_output",
		score: 10,
		state: "active",
		reasonCodesJson: JSON.stringify(["latest_generated_output"]),
		lastActivatedAt: null,
		lastUsedAt: null,
		createdAt: new Date("2026-04-01T10:00:00Z"),
		updatedAt: new Date("2026-04-01T10:00:00Z"),
		...overrides,
	};
}

function workingDocumentSelection(overrides: Record<string, unknown> = {}) {
	return {
		documentFocused: false,
		currentDocument: null,
		latestGeneratedDocumentIds: [],
		activeFocus: { artifactIds: [] },
		correction: { hasSignal: false, targetArtifactIds: [] },
		recentRefinement: { familyId: null, artifactIds: [] },
		reset: { hasSignal: false, suppressCarryover: false },
		currentTurnReasonCodesByArtifactId: new Map(),
		prompt: { reasonCodesByArtifactId: new Map() },
		workingSet: {
			candidateArtifactIds: [],
			candidateSignalsByArtifactId: new Map(),
		},
		retrieval: {
			preferredArtifactId: null,
			preferredGeneratedFamilyId: null,
			suppressGeneratedCarryover: false,
			hasExplicitResetSignal: false,
		},
		taskEvidence: {
			protectedArtifactIds: [],
			workingDocumentProtectedArtifactIds: [],
		},
		...overrides,
	};
}

describe("knowledge context retrieval", () => {
	beforeEach(() => {
		mockFindRelevantArtifactsByTypesDetailed.mockClear();
		mockFindRelevantArtifactsByTypesDetailed.mockResolvedValue([]);
		mockGetArtifactsForUser.mockClear();
		mockGetArtifactsForUser.mockResolvedValue([]);
		mockGetArtifactOwnershipScope.mockClear();
		mockGetArtifactOwnershipScope.mockResolvedValue({});
		mockIsArtifactCanonicallyOwned.mockClear();
		mockIsArtifactCanonicallyOwned.mockReturnValue(true);
		mockIsGeneratedDocumentPromptEligible.mockClear();
		mockIsGeneratedDocumentPromptEligible.mockReturnValue(true);
		mockMapArtifact.mockClear();
		mockMapArtifact.mockImplementation((value) => value);
		mockMapArtifactSummary.mockClear();
		mockMapArtifactSummary.mockImplementation((value) => value);
		mockDbInsert.mockClear();
		mockDbInsertValues.mockClear();
		mockDbUpdate.mockClear();
		mockDbUpdateSet.mockClear();
		mockDbSelectQueue.length = 0;
		mockResolveCurrentGeneratedDocumentSelection.mockClear();
		mockResolveCurrentGeneratedDocumentSelection.mockReturnValue({
			primaryArtifactId: null,
			latestArtifactIds: [],
			latestArtifacts: [],
			primaryReasonCodes: [],
		});
		mockResolveRelevantGeneratedDocumentSelection.mockClear();
		mockResolveRelevantGeneratedDocumentSelection.mockReturnValue({
			orderedArtifacts: [],
			diagnostics: [],
		});
		mockResolveWorkingDocumentSelection.mockClear();
		mockResolveWorkingDocumentSelection.mockReturnValue(
			workingDocumentSelection(),
		);
	});

	it("uses the WDS prompt view for current-turn generated-document reason codes", async () => {
		const generated = artifact({ id: "brief-v1" });
		mockDbSelectQueue.push({
			final: "where",
			rows: [
				{
					item: workingSetItem({
						artifactId: "brief-v1",
						reasonCodesJson: JSON.stringify(["latest_generated_output"]),
					}),
					artifact: generated,
				},
			],
		});
		mockResolveWorkingDocumentSelection.mockReturnValueOnce(
			workingDocumentSelection({
				documentFocused: true,
				currentDocument: {
					artifactId: "brief-v1",
					familyId: "family-brief",
					reasonCodes: ["recent_user_correction"],
					source: "generated_document",
				},
				latestGeneratedDocumentIds: ["brief-v1"],
				activeFocus: { artifactIds: [] },
				correction: { hasSignal: true, targetArtifactIds: ["brief-v1"] },
				recentRefinement: { familyId: null, artifactIds: [] },
				reset: { hasSignal: false, suppressCarryover: false },
				currentTurnReasonCodesByArtifactId: new Map([
					["brief-v1", ["recent_user_correction"]],
				]),
				prompt: {
					reasonCodesByArtifactId: new Map([
						["brief-v1", ["recent_user_correction"]],
					]),
				},
				workingSet: {
					candidateArtifactIds: ["brief-v1"],
					candidateSignalsByArtifactId: new Map(),
				},
				retrieval: {
					preferredArtifactId: "brief-v1",
					preferredGeneratedFamilyId: "family-brief",
					suppressGeneratedCarryover: false,
					hasExplicitResetSignal: false,
				},
				taskEvidence: {
					protectedArtifactIds: ["brief-v1"],
					workingDocumentProtectedArtifactIds: ["brief-v1"],
				},
			}),
		);
		mockIsGeneratedDocumentPromptEligible.mockImplementation(
			({ reasonCodes }: { reasonCodes: string[] }) =>
				reasonCodes.includes("recent_user_correction"),
		);

		const { selectWorkingSetArtifactsForPrompt } = await import("./context");
		const selected = await selectWorkingSetArtifactsForPrompt(
			"user-1",
			"conv-1",
			"Please refine it.",
		);

		expect(selected.map((entry) => entry.id)).toEqual(["brief-v1"]);
		expect(mockResolveWorkingDocumentSelection).toHaveBeenCalledWith(
			expect.objectContaining({
				artifacts: [generated],
				message: "Please refine it.",
				attachmentIds: [],
				currentConversationId: "conv-1",
				reasonCodesByArtifactId: expect.any(Map),
			}),
		);
		expect(mockIsGeneratedDocumentPromptEligible).toHaveBeenCalledWith(
			expect.objectContaining({
				artifact: generated,
				reasonCodes: ["recent_user_correction"],
			}),
		);
	});

	it("suppresses stale generated working-set prompt evidence for new file creation requests", async () => {
		const staleGenerated = artifact({
			id: "brief-v1",
			name: "legacy-brief.pdf",
			summary: "Legacy project brief",
		});
		mockDbSelectQueue.push({
			final: "where",
			rows: [
				{
					item: workingSetItem({
						artifactId: "brief-v1",
						reasonCodesJson: JSON.stringify(["latest_generated_output"]),
					}),
					artifact: staleGenerated,
				},
			],
		});
		mockResolveWorkingDocumentSelection.mockReturnValueOnce(
			workingDocumentSelection({
				retrieval: {
					preferredArtifactId: null,
					preferredGeneratedFamilyId: null,
					suppressGeneratedCarryover: true,
					hasExplicitResetSignal: false,
				},
				prompt: {
					reasonCodesByArtifactId: new Map([["brief-v1", []]]),
				},
			}),
		);
		mockIsGeneratedDocumentPromptEligible.mockReturnValue(true);

		const { selectWorkingSetArtifactsForPrompt } = await import("./context");
		const selected = await selectWorkingSetArtifactsForPrompt(
			"user-1",
			"conv-1",
			"Create a new one-page PDF file called context-sweep-summary.pdf",
		);

		expect(selected).toEqual([]);
		expect(mockResolveWorkingDocumentSelection).toHaveBeenCalledWith(
			expect.objectContaining({
				message:
					"Create a new one-page PDF file called context-sweep-summary.pdf",
				artifacts: [staleGenerated],
				currentConversationId: "conv-1",
			}),
		);
	});

	it("uses the WDS working-set view for generated-document candidates and flags", async () => {
		const infoSpy = vi
			.spyOn(console, "info")
			.mockImplementation(() => undefined);
		const generated = artifact({
			id: "brief-v2",
			updatedAt: Date.now(),
		});
		mockDbSelectQueue.push(
			{ final: "orderBy", rows: [] },
			{ final: "limit", rows: [] },
			{
				final: "orderBy",
				rows: [
					{
						item: workingSetItem({
							artifactId: "brief-v2",
							reasonCodesJson: JSON.stringify(["current_generated_document"]),
							state: "active",
						}),
						artifact: generated,
					},
				],
			},
		);
		mockGetArtifactsForUser.mockImplementation(
			async (_userId: string, artifactIds: string[]) =>
				artifactIds.includes("brief-v2") ? [generated] : [],
		);
		mockResolveWorkingDocumentSelection.mockReturnValueOnce(
			workingDocumentSelection({
				documentFocused: true,
				currentDocument: {
					artifactId: "brief-v2",
					familyId: "family-brief",
					reasonCodes: ["current_generated_document"],
					source: "generated_document",
				},
				latestGeneratedDocumentIds: ["brief-v2"],
				activeFocus: { artifactIds: [] },
				correction: { hasSignal: false, targetArtifactIds: [] },
				recentRefinement: { familyId: null, artifactIds: [] },
				reset: { hasSignal: false, suppressCarryover: false },
				currentTurnReasonCodesByArtifactId: new Map([
					["brief-v2", ["current_generated_document"]],
				]),
				prompt: {
					reasonCodesByArtifactId: new Map([
						["brief-v2", ["current_generated_document"]],
					]),
				},
				workingSet: {
					candidateArtifactIds: ["brief-v2"],
					candidateSignalsByArtifactId: new Map([
						[
							"brief-v2",
							{
								isAttachedThisTurn: false,
								isActiveDocumentFocus: false,
								isRecentUserCorrection: false,
								isRecentlyRefinedDocumentFamily: false,
								isCurrentGeneratedDocument: true,
								isSelectedCurrentGeneratedDocument: true,
							},
						],
					]),
				},
				retrieval: {
					preferredArtifactId: "brief-v2",
					preferredGeneratedFamilyId: "family-brief",
					suppressGeneratedCarryover: false,
					hasExplicitResetSignal: false,
				},
				taskEvidence: {
					protectedArtifactIds: ["brief-v2"],
					workingDocumentProtectedArtifactIds: ["brief-v2"],
				},
			}),
		);

		const { refreshConversationWorkingSet } = await import("./context");
		let refreshed: Array<{ id: string }> = [];
		try {
			refreshed = await refreshConversationWorkingSet({
				userId: "user-1",
				conversationId: "conv-1",
				message: "Please continue with it.",
			});
			expect(infoSpy).toHaveBeenCalledWith(
				"[CONTEXT] Working document selection",
				expect.objectContaining({
					phase: "working_set",
					currentDocument: expect.objectContaining({ artifactId: "brief-v2" }),
					latestGeneratedDocumentIds: ["brief-v2"],
					selectedArtifacts: [
						expect.objectContaining({
							artifactId: "brief-v2",
							reasonCodes: ["current_generated_document"],
						}),
					],
				}),
			);
		} finally {
			infoSpy.mockRestore();
		}

		expect(mockGetArtifactsForUser).toHaveBeenCalledWith(
			"user-1",
			expect.arrayContaining(["brief-v2"]),
		);
		expect(mockDbInsertValues).toHaveBeenCalledWith(
			expect.objectContaining({
				artifactId: "brief-v2",
				artifactType: "generated_output",
				state: "active",
				reasonCodesJson: JSON.stringify(["current_generated_document"]),
			}),
		);
		expect(refreshed.map((entry) => entry.id)).toEqual(["brief-v2"]);
	});

	it("suppresses stale generated working-set rows during new file creation refreshes", async () => {
		const staleGenerated = artifact({
			id: "brief-v1",
			name: "legacy-brief.pdf",
			summary: "Legacy project brief",
			updatedAt: Date.now(),
		});
		const staleItem = workingSetItem({
			artifactId: "brief-v1",
			artifactType: "generated_output",
			state: "active",
			reasonCodesJson: JSON.stringify(["latest_generated_output"]),
		});
		mockDbSelectQueue.push(
			{ final: "orderBy", rows: [staleItem] },
			{ final: "limit", rows: [] },
			{
				final: "orderBy",
				rows: [
					{
						item: staleItem,
						artifact: staleGenerated,
					},
				],
			},
		);
		mockGetArtifactsForUser.mockImplementation(
			async (_userId: string, artifactIds: string[]) =>
				artifactIds.includes("brief-v1") ? [staleGenerated] : [],
		);
		mockResolveWorkingDocumentSelection.mockReturnValueOnce(
			workingDocumentSelection({
				retrieval: {
					preferredArtifactId: null,
					preferredGeneratedFamilyId: null,
					suppressGeneratedCarryover: true,
					hasExplicitResetSignal: false,
				},
				prompt: {
					reasonCodesByArtifactId: new Map([["brief-v1", []]]),
				},
				workingSet: {
					candidateArtifactIds: ["brief-v1"],
					candidateSignalsByArtifactId: new Map([
						[
							"brief-v1",
							{
								isAttachedThisTurn: false,
								isActiveDocumentFocus: false,
								isRecentUserCorrection: false,
								isRecentlyRefinedDocumentFamily: false,
								isCurrentGeneratedDocument: true,
								isSelectedCurrentGeneratedDocument: true,
							},
						],
					]),
				},
			}),
		);

		const { refreshConversationWorkingSet } = await import("./context");
		const refreshed = await refreshConversationWorkingSet({
			userId: "user-1",
			conversationId: "conv-1",
			message: "Create a PDF file called legacy-brief.pdf",
		});

		expect(refreshed).toEqual([]);
		expect(mockDbUpdateSet).toHaveBeenCalledWith(
			expect.objectContaining({
				artifactType: "generated_output",
				state: "cooling",
				reasonCodesJson: JSON.stringify([]),
			}),
		);
	});

	it("does not include Skill Notes in default broad relevance retrieval", async () => {
		const { findRelevantKnowledgeArtifacts } = await import("./context");

		const results = await findRelevantKnowledgeArtifacts({
			userId: "user-1",
			currentConversationId: "conv-1",
			query: "research notes",
			limit: 4,
		});

		expect(results).toEqual([]);
		expect(mockFindRelevantArtifactsByTypesDetailed).toHaveBeenCalledTimes(2);
		expect(
			mockFindRelevantArtifactsByTypesDetailed.mock.calls.map(
				([params]) => params.types,
			),
		).toEqual([["normalized_document"], ["generated_output"]]);
	});

	it("promotes a strong semantic library document match for one-turn prompt retrieval without carrying it forward", async () => {
		const semanticDocument = {
			id: "doc-semantic",
			userId: "user-1",
			type: "normalized_document",
			retrievalClass: "durable",
			name: "Operations handbook",
			mimeType: "text/plain",
			sizeBytes: 1024,
			conversationId: "conv-2",
			summary: "Internal support procedures",
			metadata: null,
			contentText: "Escalation policy and support team operating procedures",
			extension: "txt",
			storagePath: null,
			createdAt: Date.parse("2026-04-01T10:00:00Z"),
			updatedAt: Date.parse("2026-04-01T10:00:00Z"),
		};
		mockFindRelevantArtifactsByTypesDetailed
			.mockResolvedValueOnce([
				{
					artifact: semanticDocument,
					lexicalScore: 0,
					semanticScore: 0.91,
					rerankScore: 0.86,
					finalScore: 35,
				},
			])
			.mockResolvedValueOnce([]);

		const { findRelevantKnowledgeArtifacts } = await import("./context");
		const results = await findRelevantKnowledgeArtifacts({
			userId: "user-1",
			currentConversationId: "conv-1",
			query: "refund risk predictors",
			limit: 4,
		});

		expect(results.map((artifact) => artifact.id)).toEqual(["doc-semantic"]);
		expect(mockDbInsert).not.toHaveBeenCalled();
	});
});
