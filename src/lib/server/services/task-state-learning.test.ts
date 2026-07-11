import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact } from "$lib/types";

const {
	mockRecordMemoryEvent,
	mockListLatestMemoryEventsBySubject,
	mockListMemoryEvents,
	mockCanUseContextSummarizer,
	mockRequestStructuredControlModel,
	mockRerankItems,
	mockCanUseTeiReranker,
	insertedEvidenceRows,
	taskStateRows,
	conversationRows,
	checkpointRows,
} = vi.hoisted(() => {
	return {
		mockRecordMemoryEvent: vi.fn(async () => undefined),
		mockListLatestMemoryEventsBySubject: vi.fn(async () => new Map()),
		mockListMemoryEvents: vi.fn(async () => []),
		mockCanUseContextSummarizer: vi.fn(() => false),
		mockRequestStructuredControlModel: vi.fn(),
		mockRerankItems: vi.fn(
			async () =>
				null as {
					items: Array<{ item: Artifact; index: number; score: number }>;
					confidence: number;
				} | null,
		),
		mockCanUseTeiReranker: vi.fn(() => false),
		insertedEvidenceRows: [] as Array<Record<string, unknown>>,
		taskStateRows: [] as Array<Record<string, unknown>>,
		conversationRows: [] as Array<Record<string, unknown>>,
		checkpointRows: [] as Array<Record<string, unknown>>,
	};
});

type SelectChain = unknown[] & {
	from: (...args: unknown[]) => SelectChain;
	leftJoin: (...args: unknown[]) => SelectChain;
	innerJoin: (...args: unknown[]) => SelectChain;
	where: (...args: unknown[]) => SelectChain;
	orderBy: (...args: unknown[]) => SelectChain;
	limit: (count?: number) => Promise<unknown[]>;
};

function makeArtifact(params: {
	id: string;
	type: Artifact["type"];
	conversationId: string | null;
	name: string;
	summary: string | null;
	metadata?: Artifact["metadata"];
	updatedAt?: number;
	userId?: string;
	retrievalClass?: Artifact["retrievalClass"];
	mimeType?: string;
	sizeBytes?: number;
	contentText?: string | null;
	extension?: string | null;
	storagePath?: string | null;
}): Artifact {
	const timestamp = params.updatedAt ?? Date.now();
	return {
		id: params.id,
		userId: params.userId ?? "user-1",
		type: params.type,
		retrievalClass: params.retrievalClass ?? "durable",
		name: params.name,
		mimeType: params.mimeType ?? "text/plain",
		sizeBytes: params.sizeBytes ?? 1024,
		conversationId: params.conversationId,
		summary: params.summary,
		metadata: params.metadata ?? null,
		contentText: params.contentText ?? null,
		extension: params.extension ?? "txt",
		storagePath: params.storagePath ?? null,
		createdAt: timestamp,
		updatedAt: timestamp,
	};
}

function createSelectChain(rows: unknown[]) {
	const chain = [...rows] as SelectChain;
	chain.from = vi.fn(() => chain);
	chain.leftJoin = vi.fn(() => chain);
	chain.innerJoin = vi.fn(() => chain);
	chain.where = vi.fn(() => chain);
	chain.orderBy = vi.fn(() => chain);
	chain.limit = vi.fn(async (count?: number) =>
		typeof count === "number" ? rows.slice(0, count) : rows,
	);
	return chain;
}

vi.mock("$lib/server/db", () => ({
	db: {
		select: () => ({
			from: (table: { __name?: string }) => {
				if (table?.__name === "task_checkpoints") {
					return createSelectChain(checkpointRows);
				}
				if (table?.__name === "conversation_task_states") {
					return createSelectChain(taskStateRows);
				}
				if (table?.__name === "artifact_links") {
					return createSelectChain([]);
				}
				if (table?.__name === "conversations") {
					return createSelectChain(conversationRows);
				}
				if (table?.__name === "projects") {
					return createSelectChain([]);
				}
				return createSelectChain([]);
			},
		}),
		insert: (table: { __name?: string }) => ({
			values: (values: Record<string, unknown>) => {
				if (table?.__name === "task_state_evidence_links") {
					const rows = Array.isArray(values) ? values : [values];
					insertedEvidenceRows.push(...rows.map((row) => ({ ...row })));
				}
				return {
					onConflictDoUpdate: vi.fn(async () => undefined),
					onConflictDoNothing: vi.fn(async () => undefined),
				};
			},
		}),
		update: () => ({
			set: vi.fn(() => ({
				where: vi.fn(async () => undefined),
			})),
		}),
		delete: () => ({
			where: vi.fn(async () => undefined),
		}),
	},
}));

vi.mock("$lib/server/db/schema", () => ({
	conversations: {
		__name: "conversations",
		id: { name: "id" },
		userId: { name: "userId" },
		title: { name: "title" },
		projectId: { name: "projectId" },
		updatedAt: { name: "updatedAt" },
		conversationId: { name: "conversationId" },
		artifactId: { name: "artifactId" },
	},
	conversationTaskStates: {
		__name: "conversation_task_states",
		taskId: { name: "taskId" },
		userId: { name: "userId" },
		conversationId: { name: "conversationId" },
		updatedAt: { name: "updatedAt" },
		activeArtifactIdsJson: { name: "activeArtifactIdsJson" },
		objective: { name: "objective" },
		status: { name: "status" },
		locked: { name: "locked" },
		lastCheckpointAt: { name: "lastCheckpointAt" },
		nextSteps: { name: "nextSteps" },
		factsToPreserve: { name: "factsToPreserve" },
		decisions: { name: "decisions" },
		openQuestions: { name: "openQuestions" },
		confidence: { name: "confidence" },
		constraints: { name: "constraints" },
	},
	projects: {
		__name: "projects",
		id: { name: "id" },
		userId: { name: "userId" },
		name: { name: "name" },
		updatedAt: { name: "updatedAt" },
	},
	taskCheckpoints: {
		__name: "task_checkpoints",
		taskId: { name: "taskId" },
		taskIdName: "taskId",
		content: { name: "content" },
		checkpointType: { name: "checkpointType" },
		userId: { name: "userId" },
		updatedAt: { name: "updatedAt" },
	},
	taskStateEvidenceLinks: {
		__name: "task_state_evidence_links",
		userId: { name: "userId" },
		taskId: { name: "taskId" },
		role: { name: "role" },
		origin: { name: "origin" },
		updatedAt: { name: "updatedAt" },
	},
	artifactLinks: {
		__name: "artifact_links",
		artifactId: { name: "artifactId" },
		relatedArtifactId: { name: "relatedArtifactId" },
		userId: { name: "userId" },
		linkType: { name: "linkType" },
	},
	artifacts: { id: Symbol("id") },

	memoryEvents: {},
}));

vi.mock("drizzle-orm", () => ({
	and: vi.fn((...conditions: unknown[]) => conditions),
	desc: vi.fn(() => "desc"),
	eq: vi.fn((field: { name: string }, value: unknown) => ({
		field: field.name,
		value,
	})),
	inArray: vi.fn((field: { name: string }, values: unknown[]) => ({
		field: field.name,
		value: values,
	})),
}));

vi.mock("$lib/server/utils/json", () => ({
	parseJsonRecord: vi.fn((value: string | null) =>
		value ? JSON.parse(value) : null,
	),
	parseJsonStringArray: vi.fn(() => []),
}));

vi.mock("$lib/server/utils/text", () => ({
	clipNullableText: vi.fn((value: string | null | undefined) => value ?? null),
	normalizeWhitespace: vi.fn((value: string) => value.trim()),
	clipText: vi.fn((value: string, maxLength: number) =>
		value.slice(0, maxLength),
	),
}));

vi.mock("$lib/server/services/memory-events", () => ({
	recordMemoryEvent: mockRecordMemoryEvent,
	listLatestMemoryEventsBySubject: mockListLatestMemoryEventsBySubject,
	listMemoryEvents: mockListMemoryEvents,
}));

vi.mock("$lib/server/services/control-model", () => ({
	canUseContextSummarizer: mockCanUseContextSummarizer,
	requestStructuredControlModel: mockRequestStructuredControlModel,
}));

type TimestampLike = { getTime?: () => number };
type MockTaskRow = Record<string, unknown> & {
	lastCheckpointAt?: TimestampLike | null;
	updatedAt?: TimestampLike | null;
};

vi.mock("$lib/server/services/mappers", () => ({
	mapTaskCheckpoint: vi.fn((row: MockTaskRow) => ({
		taskId: typeof row.taskId === "string" ? row.taskId : "",
		content: typeof row.content === "string" ? row.content : "",
		checkpointType:
			typeof row.checkpointType === "string" ? row.checkpointType : "stable",
		updatedAt: row.updatedAt?.getTime?.() ?? Date.now(),
	})),
	mapTaskState: vi.fn((row: MockTaskRow) => ({
		taskId: typeof row.taskId === "string" ? row.taskId : "",
		conversationId:
			typeof row.conversationId === "string" ? row.conversationId : "",
		objective: typeof row.objective === "string" ? row.objective : "",
		status: typeof row.status === "string" ? row.status : "candidate",
		locked: Boolean(row.locked ?? false),
		confidence: typeof row.confidence === "number" ? row.confidence : 40,
		updatedAt: row.updatedAt?.getTime?.() ?? Date.now(),
		lastCheckpointAt: row.lastCheckpointAt?.getTime?.() ?? null,
		nextSteps: [],
		factsToPreserve: [],
		decisions: [],
		openQuestions: [],
		activeArtifactIds: [],
		constraints: [],
	})),
}));

vi.mock("$lib/server/services/working-set", () => ({
	scoreMatch: vi.fn(() => 0),
}));

vi.mock("$lib/server/services/tei-reranker", () => ({
	canUseTeiReranker: mockCanUseTeiReranker,
	rerankItems: mockRerankItems,
}));

vi.mock("$lib/server/config-store", () => ({
	getConfig: () => ({ contextDiagnosticsDebug: false }),
	getTargetConstructedContext: () => 30_000,
}));

describe("task-state learning - task continuity gate", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.resetModules();
		insertedEvidenceRows.splice(0, insertedEvidenceRows.length);
		mockRecordMemoryEvent.mockReset();
		mockRecordMemoryEvent.mockResolvedValue(undefined);
		mockListLatestMemoryEventsBySubject.mockResolvedValue(new Map());
	});

	it("marks output-control prompts as non-continuity for task-state gate and avoids creation", async () => {
		const { prepareTaskContext, shouldTrackTaskContinuityFromTurn } =
			await import("./task-state");

		expect(
			shouldTrackTaskContinuityFromTurn({
				message:
					"What is my codeword? Reply with only the codeword. I want to verify continuity.",
			}),
		).toBe(false);
		expect(
			shouldTrackTaskContinuityFromTurn({
				message:
					"Please remember this as a durable Memory Profile fact: my memory regression matrix codeword is codex-regression-1234.",
			}),
		).toBe(false);
		expect(
			shouldTrackTaskContinuityFromTurn({
				message: "What is my project status for the quarterly budget review?",
			}),
		).toBe(true);
		expect(
			shouldTrackTaskContinuityFromTurn({
				message:
					"What is the quarterly budget review status? Reply with only bullet points.",
				taskState: {
					taskId: "task-quarterly-budget",
					userId: "user-1",
					conversationId: "conv-1",
					status: "active",
					objective: "Finish the quarterly budget review",
					confidence: 80,
					locked: false,
					lastConfirmedTurnMessageId: null,
					constraints: [],
					factsToPreserve: [],
					decisions: [],
					openQuestions: [],
					activeArtifactIds: [],
					nextSteps: [],
					lastCheckpointAt: null,
					createdAt: 1,
					updatedAt: 1,
				},
			}),
		).toBe(true);
		expect(
			shouldTrackTaskContinuityFromTurn({
				message: "What is my codeword? Reply with only the codeword.",
				taskState: {
					taskId: "task-quarterly-budget",
					userId: "user-1",
					conversationId: "conv-1",
					status: "active",
					objective: "Finish the quarterly budget review",
					confidence: 80,
					locked: false,
					lastConfirmedTurnMessageId: null,
					constraints: [],
					factsToPreserve: [],
					decisions: [],
					openQuestions: [],
					activeArtifactIds: [],
					nextSteps: [],
					lastCheckpointAt: null,
					createdAt: 1,
					updatedAt: 1,
				},
			}),
		).toBe(false);

		const prepared = await prepareTaskContext({
			userId: "user-1",
			conversationId: "conv-1",
			message:
				"What is my codeword? Reply with only the codeword. I want to verify continuity.",
			currentAttachments: [],
			workingSetArtifacts: [],
			relevantArtifacts: [],
		});

		expect(prepared.taskState).toBeNull();

		const preparedMemorySave = await prepareTaskContext({
			userId: "user-1",
			conversationId: "conv-1",
			message:
				"Please remember this as a durable Memory Profile fact: my memory regression matrix codeword is codex-regression-1234.",
			currentAttachments: [],
			workingSetArtifacts: [],
			relevantArtifacts: [],
		});

		expect(preparedMemorySave.taskState).toBeNull();
	});
});

describe("task-state selected evidence policy", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.resetModules();
		taskStateRows.splice(0, taskStateRows.length);
		insertedEvidenceRows.splice(0, insertedEvidenceRows.length);
		mockCanUseTeiReranker.mockReturnValue(false);
		mockRerankItems.mockResolvedValue(null);
	});

	it("scales selected evidence from budget instead of the old small fixed caps", async () => {
		const { deriveBudgetedSelectedEvidenceLimit } = await import(
			"./task-state"
		);
		const candidates = Array.from({ length: 20 }, (_, index) => ({
			name: `Document ${index + 1}`,
			summary: "Concise relevant source summary.",
			contentText: "Short relevant evidence.",
		}));

		expect(
			deriveBudgetedSelectedEvidenceLimit({
				candidates,
				targetConstructedContext: 30_000,
			}),
		).toBe(20);
	});

	it("keeps selected evidence bounded by the performance safeguard", async () => {
		const { deriveBudgetedSelectedEvidenceLimit } = await import(
			"./task-state"
		);
		const candidates = Array.from({ length: 100 }, (_, index) => ({
			name: `Document ${index + 1}`,
			summary: "Relevant source summary.",
			contentText: "Evidence ".repeat(400),
		}));

		expect(
			deriveBudgetedSelectedEvidenceLimit({
				candidates,
				targetConstructedContext: 1_000_000,
			}),
		).toBe(64);
	});

	it("keeps one-turn relevant library documents selected even when lexical scoring is weak", async () => {
		const now = Date.now();
		taskStateRows.push({
			taskId: "task-1",
			userId: "user-1",
			conversationId: "conv-1",
			status: "active",
			objective: "Answer the current question",
			confidence: 80,
			locked: 1,
			constraintsJson: "[]",
			factsToPreserveJson: "[]",
			decisionsJson: "[]",
			openQuestionsJson: "[]",
			activeArtifactIdsJson: "[]",
			nextStepsJson: "[]",
			lastCheckpointAt: null,
			createdAt: new Date(now),
			updatedAt: new Date(now),
		});
		const semanticDocument = makeArtifact({
			id: "doc-semantic",
			type: "normalized_document",
			conversationId: "conv-2",
			name: "Operations handbook",
			summary: "Internal support procedures",
			contentText: "Escalation policy and support team operating procedures",
			updatedAt: now,
		});

		const { prepareTaskContext } = await import("./task-state");
		const prepared = await prepareTaskContext({
			userId: "user-1",
			conversationId: "conv-1",
			message: "refund risk predictors",
			currentAttachments: [],
			workingSetArtifacts: [],
			relevantArtifacts: [semanticDocument],
		});

		expect(prepared.selectedArtifacts.map((artifact) => artifact.id)).toContain(
			"doc-semantic",
		);
	});

	it("does not persist one-turn cross-conversation semantic documents as durable selected evidence", async () => {
		const now = Date.now();
		taskStateRows.push({
			taskId: "task-1",
			userId: "user-1",
			conversationId: "conv-1",
			status: "active",
			objective: "Answer the current question",
			confidence: 80,
			locked: 1,
			constraintsJson: "[]",
			factsToPreserveJson: "[]",
			decisionsJson: "[]",
			openQuestionsJson: "[]",
			activeArtifactIdsJson: "[]",
			nextStepsJson: "[]",
			lastCheckpointAt: null,
			createdAt: new Date(now),
			updatedAt: new Date(now),
		});
		const semanticDocument = makeArtifact({
			id: "doc-semantic",
			type: "normalized_document",
			conversationId: "conv-2",
			name: "Operations handbook",
			summary: "Internal support procedures",
			contentText: "Escalation policy and support team operating procedures",
			updatedAt: now,
		});

		const { prepareTaskContext } = await import("./task-state");
		const prepared = await prepareTaskContext({
			userId: "user-1",
			conversationId: "conv-1",
			message: "refund risk predictors",
			currentAttachments: [],
			workingSetArtifacts: [],
			relevantArtifacts: [semanticDocument],
		});

		expect(prepared.selectedArtifacts.map((artifact) => artifact.id)).toContain(
			"doc-semantic",
		);
		expect(insertedEvidenceRows.map((row) => row.artifactId)).not.toContain(
			"doc-semantic",
		);
	});

	it("keeps the current generated working document selected when evidence reranking prefers other sources", async () => {
		const now = Date.now();
		taskStateRows.push({
			taskId: "task-1",
			userId: "user-1",
			conversationId: "conv-1",
			status: "active",
			objective: "Revise the current report",
			confidence: 80,
			locked: 1,
			constraintsJson: "[]",
			factsToPreserveJson: "[]",
			decisionsJson: "[]",
			openQuestionsJson: "[]",
			activeArtifactIdsJson: "[]",
			nextStepsJson: "[]",
			lastCheckpointAt: null,
			createdAt: new Date(now),
			updatedAt: new Date(now),
		});
		const currentGeneratedDocument = makeArtifact({
			id: "generated-current",
			type: "generated_output",
			conversationId: "conv-1",
			name: "current-report.pdf",
			summary: "Current generated report.",
			metadata: {
				documentFamilyId: "family-report",
				documentLabel: "Current report",
				versionNumber: 1,
			},
			contentText: "Current generated report draft.",
			extension: "pdf",
			mimeType: "application/pdf",
			updatedAt: now,
		});
		const relevantDocuments = Array.from({ length: 3 }, (_, index) =>
			makeArtifact({
				id: `semantic-${index + 1}`,
				type: "normalized_document",
				conversationId: "conv-1",
				name: `Reference ${index + 1}`,
				summary: "Reference source.",
				contentText: "Supporting source material.",
				updatedAt: now - index - 1,
			}),
		);
		mockCanUseTeiReranker.mockReturnValue(true);
		mockRerankItems.mockResolvedValue({
			confidence: 92,
			items: relevantDocuments.map((item, index) => ({
				item,
				index,
				score: 0.9,
			})),
		});

		const { prepareTaskContext } = await import("./task-state");
		const prepared = await prepareTaskContext({
			userId: "user-1",
			conversationId: "conv-1",
			message: "Please summarize this document.",
			currentAttachments: [],
			workingSetArtifacts: [currentGeneratedDocument],
			relevantArtifacts: relevantDocuments,
		});

		expect(prepared.routingStage).toBe("evidence_rerank");
		expect(prepared.selectedArtifacts.map((artifact) => artifact.id)).toContain(
			"generated-current",
		);
		expect(insertedEvidenceRows.map((row) => row.artifactId)).toContain(
			"generated-current",
		);
	});

	it("keeps a WDS-protected correction target through generated-document family collapse", async () => {
		const now = Date.now();
		taskStateRows.push({
			taskId: "task-1",
			userId: "user-1",
			conversationId: "conv-1",
			status: "active",
			objective: "Revise the selected brief",
			confidence: 80,
			locked: 1,
			constraintsJson: "[]",
			factsToPreserveJson: "[]",
			decisionsJson: "[]",
			openQuestionsJson: "[]",
			activeArtifactIdsJson: "[]",
			nextStepsJson: "[]",
			lastCheckpointAt: null,
			createdAt: new Date(now),
			updatedAt: new Date(now),
		});
		const selectedOlderDraft = makeArtifact({
			id: "brief-v1",
			type: "generated_output",
			conversationId: "conv-1",
			name: "brief-v1.pdf",
			summary: "Older brief draft.",
			metadata: {
				documentFamilyId: "family-brief",
				documentLabel: "Project brief",
				versionNumber: 1,
			},
			contentText: "Older brief draft.",
			extension: "pdf",
			mimeType: "application/pdf",
			updatedAt: now - 10,
		});
		const newerSiblingDraft = makeArtifact({
			id: "brief-v2",
			type: "generated_output",
			conversationId: "conv-1",
			name: "brief-v2.pdf",
			summary: "Newer brief draft.",
			metadata: {
				documentFamilyId: "family-brief",
				documentLabel: "Project brief",
				versionNumber: 2,
				supersedesArtifactId: "brief-v1",
			},
			contentText: "Newer brief draft.",
			extension: "pdf",
			mimeType: "application/pdf",
			updatedAt: now,
		});

		const { prepareTaskContext } = await import("./task-state");
		const prepared = await prepareTaskContext({
			userId: "user-1",
			conversationId: "conv-1",
			message: "Actually, refine this document.",
			activeDocumentArtifactId: "brief-v1",
			currentAttachments: [],
			workingSetArtifacts: [selectedOlderDraft, newerSiblingDraft],
			relevantArtifacts: [],
		});

		expect(prepared.selectedArtifacts.map((artifact) => artifact.id)).toContain(
			"brief-v1",
		);
		expect(insertedEvidenceRows.map((row) => row.artifactId)).toContain(
			"brief-v1",
		);
	});
});

// Note: selectTaskStateForTurn and listTaskMemoryItems
// require complex DB mocking with specific data formats (nested vs flat row structures).
// Most coverage here stays on exported policy helpers and narrow prepareTaskContext paths.
