import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockRecordMemoryEvent,
	mockListLatestMemoryEventsBySubject,
	mockListMemoryEvents,
	mockCanUseContextSummarizer,
	mockRequestStructuredControlModel,
	mockRerankItems,
	mockCanUseTeiReranker,
	insertedProjectRows,
	insertedLinkRows,
	insertedEvidenceRows,
	projectRows,
	linkRows,
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
		mockRerankItems: vi.fn(async () => null),
		mockCanUseTeiReranker: vi.fn(() => false),
		insertedProjectRows: [] as Array<Record<string, unknown>>,
		insertedLinkRows: [] as Array<Record<string, unknown>>,
		insertedEvidenceRows: [] as Array<Record<string, unknown>>,
		projectRows: [] as Array<Record<string, unknown>>,
		linkRows: [] as Array<Record<string, unknown>>,
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
				if (table?.__name === "memory_project_task_links") {
					return createSelectChain(linkRows);
				}
				if (table?.__name === "task_checkpoints") {
					return createSelectChain(checkpointRows);
				}
				if (table?.__name === "memory_projects") {
					return createSelectChain(projectRows);
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
				if (table?.__name === "memory_projects") {
					insertedProjectRows.push({ ...values });
					projectRows.push({ ...values });
				}
				if (table?.__name === "memory_project_task_links") {
					insertedLinkRows.push({ ...values });
					linkRows.push({ ...values });
				}
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
	memoryProjects: {
		__name: "memory_projects",
		projectId: { name: "projectId" },
		userId: { name: "userId" },
		status: { name: "status" },
		updatedAt: { name: "updatedAt" },
		lastActiveAt: { name: "lastActiveAt" },
		name: { name: "name" },
		summary: { name: "summary" },
	},
	memoryProjectTaskLinks: {
		__name: "memory_project_task_links",
		projectId: { name: "projectId" },
		taskId: { name: "taskId" },
		userId: { name: "userId" },
		conversationId: { name: "conversationId" },
		updatedAt: { name: "updatedAt" },
		id: { name: "id" },
	},
	projects: {
		__name: "projects",
		id: { name: "id" },
		userId: { name: "userId" },
		name: { name: "name" },
		canonicalMemoryProjectId: { name: "canonicalMemoryProjectId" },
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
	getTargetConstructedContext: () => 30_000,
}));

describe("task-state learning - project continuity signals", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.resetModules();
		insertedProjectRows.splice(0, insertedProjectRows.length);
		insertedLinkRows.splice(0, insertedLinkRows.length);
		insertedEvidenceRows.splice(0, insertedEvidenceRows.length);
		projectRows.splice(0, projectRows.length);
		linkRows.splice(0, linkRows.length);
		mockRecordMemoryEvent.mockReset();
		mockRecordMemoryEvent.mockResolvedValue(undefined);
		mockListLatestMemoryEventsBySubject.mockResolvedValue(new Map());
	});

	it("detects pause signal from user message", async () => {
		const { detectProjectContinuitySignal } = await import(
			"./task-state/continuity"
		);

		expect(detectProjectContinuitySignal("Pause this project for now.")).toBe(
			"project_paused",
		);
		expect(detectProjectContinuitySignal("Let us put this on hold.")).toBe(
			"project_paused",
		);
		expect(detectProjectContinuitySignal("Hold off on this for a while.")).toBe(
			"project_paused",
		);
		expect(detectProjectContinuitySignal("Please park this task.")).toBe(
			"project_paused",
		);
	});

	it("detects resume signal from user message", async () => {
		const { detectProjectContinuitySignal } = await import(
			"./task-state/continuity"
		);

		expect(detectProjectContinuitySignal("Let us resume the project.")).toBe(
			"project_resumed",
		);
		expect(detectProjectContinuitySignal("Continue working on this.")).toBe(
			"project_resumed",
		);
		expect(detectProjectContinuitySignal("Pick it back up.")).toBe(
			"project_resumed",
		);
	});

	it("returns null for unrelated messages", async () => {
		const { detectProjectContinuitySignal } = await import(
			"./task-state/continuity"
		);

		expect(
			detectProjectContinuitySignal("What is the weather today?"),
		).toBeNull();
		expect(detectProjectContinuitySignal("Help me write an email.")).toBeNull();
	});

	it("resolves paused project events as dormant even when stored row says active", async () => {
		const { resolveProjectContinuityStatus } = await import(
			"./task-state/continuity"
		);

		const status = resolveProjectContinuityStatus({
			storedStatus: "active",
			lastActiveAt: Date.now(),
			latestEventType: "project_paused",
		});

		expect(status).toBe("dormant");
	});

	it("maintains active status for recently active projects", async () => {
		const { resolveProjectContinuityStatus } = await import(
			"./task-state/continuity"
		);

		const status = resolveProjectContinuityStatus({
			storedStatus: "active",
			lastActiveAt: Date.now(),
			latestEventType: "project_started",
		});

		expect(status).toBe("active");
	});

	it("archives projects not active for over 45 days", async () => {
		const { resolveProjectContinuityStatus } = await import(
			"./task-state/continuity"
		);

		const status = resolveProjectContinuityStatus({
			storedStatus: "active",
			lastActiveAt: Date.now() - 50 * 24 * 60 * 60 * 1000, // 50 days ago
			latestEventType: null,
		});

		expect(status).toBe("archived");
	});

	it("records project_started event when creating new continuity bucket", async () => {
		const { syncTaskContinuityFromTaskState } = await import(
			"./task-state/continuity"
		);

		await syncTaskContinuityFromTaskState({
			userId: "user-1",
			taskState: {
				taskId: "task-new-project",
				userId: "user-1",
				conversationId: "conv-1",
				status: "active",
				objective: "Create the quarterly report",
				confidence: 85,
				locked: false,
				constraints: [],
				factsToPreserve: [],
				decisions: [],
				openQuestions: [],
				activeArtifactIds: [],
				nextSteps: ["Gather data", "Write analysis"],
				lastCheckpointAt: null,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			},
		});

		expect(mockRecordMemoryEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				domain: "task",
				eventType: "project_started",
				relatedId: "task-new-project",
			}),
		);

		expect(insertedProjectRows.length).toBe(1);
	});

	it("applies explicit pause signal from user message", async () => {
		linkRows.push({
			id: "link-1",
			projectId: "project-to-pause",
			status: "active",
			lastActiveAt: new Date(),
		});

		projectRows.push({
			projectId: "project-to-pause",
			userId: "user-1",
			name: "Project to pause",
			status: "active",
			lastActiveAt: new Date(),
			updatedAt: new Date(),
		});

		const { applyProjectContinuitySignalFromMessage } = await import(
			"./task-state/continuity"
		);

		await applyProjectContinuitySignalFromMessage({
			userId: "user-1",
			taskState: {
				taskId: "task-pause-test",
				userId: "user-1",
				conversationId: "conv-1",
				status: "active",
				objective: "Test task",
				confidence: 75,
				locked: false,
				lastConfirmedTurnMessageId: null,
				constraints: [],
				factsToPreserve: [],
				decisions: [],
				openQuestions: [],
				activeArtifactIds: [],
				nextSteps: [],
				lastCheckpointAt: null,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			},
			message: "Pause this project for now.",
		});

		expect(mockRecordMemoryEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				domain: "task",
				eventType: "project_paused",
				subjectId: "project-to-pause",
			}),
		);
	});

	it("handles projects that are explicitly paused as dormant", async () => {
		const { resolveProjectContinuityStatus } = await import(
			"./task-state/continuity"
		);

		// Even with recent lastActiveAt, explicit pause makes it dormant
		const status = resolveProjectContinuityStatus({
			storedStatus: "active",
			lastActiveAt: Date.now() - 3 * 24 * 60 * 60 * 1000, // 3 days ago (should be active)
			latestEventType: "project_paused",
		});

		expect(status).toBe("dormant");
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
			createdAt: now,
			updatedAt: now,
		};

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
			createdAt: now,
			updatedAt: now,
		};

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
		const currentGeneratedDocument = {
			id: "generated-current",
			userId: "user-1",
			type: "generated_output",
			retrievalClass: "durable",
			name: "current-report.pdf",
			mimeType: "application/pdf",
			sizeBytes: 1024,
			conversationId: "conv-1",
			summary: "Current generated report.",
			metadata: {
				documentFamilyId: "family-report",
				documentLabel: "Current report",
				versionNumber: 1,
			},
			contentText: "Current generated report draft.",
			extension: "pdf",
			storagePath: null,
			createdAt: now,
			updatedAt: now,
		};
		const relevantDocuments = Array.from({ length: 3 }, (_, index) => ({
			id: `semantic-${index + 1}`,
			userId: "user-1",
			type: "normalized_document",
			retrievalClass: "durable",
			name: `Reference ${index + 1}`,
			mimeType: "text/plain",
			sizeBytes: 1024,
			conversationId: "conv-1",
			summary: "Reference source.",
			metadata: null,
			contentText: "Supporting source material.",
			extension: "txt",
			storagePath: null,
			createdAt: now,
			updatedAt: now - index - 1,
		}));
		mockCanUseTeiReranker.mockReturnValue(true);
		mockRerankItems.mockResolvedValue({
			confidence: 92,
			items: relevantDocuments.map((item) => ({ item, score: 0.9 })),
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
		const selectedOlderDraft = {
			id: "brief-v1",
			userId: "user-1",
			type: "generated_output",
			retrievalClass: "durable",
			name: "brief-v1.pdf",
			mimeType: "application/pdf",
			sizeBytes: 1024,
			conversationId: "conv-1",
			summary: "Older brief draft.",
			metadata: {
				documentFamilyId: "family-brief",
				documentLabel: "Project brief",
				versionNumber: 1,
			},
			contentText: "Older brief draft.",
			extension: "pdf",
			storagePath: null,
			createdAt: now - 10,
			updatedAt: now - 10,
		};
		const newerSiblingDraft = {
			id: "brief-v2",
			userId: "user-1",
			type: "generated_output",
			retrievalClass: "durable",
			name: "brief-v2.pdf",
			mimeType: "application/pdf",
			sizeBytes: 1024,
			conversationId: "conv-1",
			summary: "Newer brief draft.",
			metadata: {
				documentFamilyId: "family-brief",
				documentLabel: "Project brief",
				versionNumber: 2,
				supersedesArtifactId: "brief-v1",
			},
			contentText: "Newer brief draft.",
			extension: "pdf",
			storagePath: null,
			createdAt: now,
			updatedAt: now,
		};

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

// Note: selectTaskStateForTurn, listFocusContinuityItems, and listTaskMemoryItems
// require complex DB mocking with specific data formats (nested vs flat row structures).
// Most coverage here stays on exported policy helpers and narrow prepareTaskContext paths.
