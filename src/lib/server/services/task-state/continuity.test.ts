import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockRecordMemoryEvent,
	mockListLatestMemoryEventsBySubject,
	mockListMemoryEvents,
	mockCanUseContextSummarizer,
	insertedProjects,
	projectRows,
	projectFolderRows,
	linkRows,
	conversationRows,
	conversationSummaryRows,
	messageRows,
	taskStateRows,
	checkpointRows,
} = vi.hoisted(() => ({
	mockRecordMemoryEvent: vi.fn(async () => undefined),
	mockListLatestMemoryEventsBySubject: vi.fn(async () => new Map()),
	mockListMemoryEvents: vi.fn(async () => []),
	mockCanUseContextSummarizer: vi.fn(() => false),
	insertedProjects: [] as Array<Record<string, unknown>>,
	projectRows: [] as Array<Record<string, unknown>>,
	projectFolderRows: [] as Array<Record<string, unknown>>,
	linkRows: [] as Array<Record<string, unknown>>,
	conversationRows: [] as Array<Record<string, unknown>>,
	conversationSummaryRows: [] as Array<Record<string, unknown>>,
	messageRows: [] as Array<Record<string, unknown>>,
	taskStateRows: [] as Array<Record<string, unknown>>,
	checkpointRows: [] as Array<Record<string, unknown>>,
}));

type MockCondition =
	| { operator: "eq" | "ne" | "inArray"; field: string; value: unknown }
	| MockCondition[]
	| null
	| undefined;

type MockOrder = { direction: "asc" | "desc"; field: string };

function readComparable(value: unknown): string | number {
	if (value instanceof Date) return value.getTime();
	if (typeof value === "number") return value;
	if (typeof value === "string") return value;
	return String(value ?? "");
}

function matchesCondition(
	row: Record<string, unknown>,
	condition: MockCondition,
): boolean {
	if (!condition) return true;
	if (Array.isArray(condition)) {
		return condition.every((nested) => matchesCondition(row, nested));
	}
	const actual = row[condition.field];
	if (condition.operator === "eq") return actual === condition.value;
	if (condition.operator === "ne") return actual !== condition.value;
	if (condition.operator === "inArray") {
		return Array.isArray(condition.value) && condition.value.includes(actual);
	}
	return true;
}

function mapSelectedRows(
	rows: Array<Record<string, unknown>>,
	shape?: Record<string, unknown>,
) {
	if (!shape) return rows;
	const entries = Object.entries(shape);
	if (entries.some(([, field]) => field?.kind === "count")) {
		return [
			Object.fromEntries(
				entries.map(([alias, field]) => [
					alias,
					field?.kind === "count" ? rows.length : rows[0]?.[field?.name],
				]),
			),
		];
	}
	return rows.map((row) =>
		Object.fromEntries(
			entries.map(([alias, field]) => [alias, row[field?.name ?? alias]]),
		),
	);
}

function createQuery(
	rows: Array<Record<string, unknown>>,
	shape?: Record<string, unknown>,
) {
	let currentRows = [...rows];
	const chain = {
		from: () => chain,
		leftJoin: () => chain,
		innerJoin: () => chain,
		where: (condition: MockCondition) => {
			currentRows = currentRows.filter((row) =>
				matchesCondition(row, condition),
			);
			return chain;
		},
		orderBy: (...orders: MockOrder[]) => {
			currentRows = currentRows.slice().sort((left, right) => {
				for (const order of orders) {
					const leftValue = readComparable(left[order.field]);
					const rightValue = readComparable(right[order.field]);
					if (leftValue < rightValue) return order.direction === "asc" ? -1 : 1;
					if (leftValue > rightValue) return order.direction === "asc" ? 1 : -1;
				}
				return 0;
			});
			return chain;
		},
		limit: async (limit: number) =>
			mapSelectedRows(currentRows.slice(0, limit), shape),
		// biome-ignore lint/suspicious/noThenProperty: This mock intentionally behaves like Drizzle's awaitable query builder.
		then: (
			onFulfilled: (value: unknown[]) => unknown,
			onRejected?: (reason: unknown) => unknown,
		) =>
			Promise.resolve(mapSelectedRows(currentRows, shape)).then(
				onFulfilled,
				onRejected,
			),
	};
	return chain;
}

vi.mock("$lib/server/db", () => ({
	db: {
		select: (shape?: Record<string, unknown>) => ({
			from: (table: { __name?: string }) => {
				if (table?.__name === "memory_project_task_links") {
					return createQuery(linkRows as Array<Record<string, unknown>>, shape);
				}
				if (table?.__name === "task_checkpoints") {
					return createQuery(checkpointRows, shape);
				}
				if (table?.__name === "memory_projects") {
					return createQuery(projectRows, shape);
				}
				if (table?.__name === "projects") {
					return createQuery(projectFolderRows, shape);
				}
				if (table?.__name === "conversations") {
					return createQuery(conversationRows, shape);
				}
				if (table?.__name === "conversation_summaries") {
					return createQuery(conversationSummaryRows, shape);
				}
				if (table?.__name === "messages") {
					return createQuery(messageRows, shape);
				}
				if (table?.__name === "conversation_task_states") {
					return createQuery(taskStateRows, shape);
				}
				return createQuery([], shape);
			},
		}),
		insert: (table: { __name?: string }) => ({
			values: (values: Record<string, unknown>) => {
				if (table?.__name === "memory_projects") {
					insertedProjects.push(values);
				}
				if (table?.__name === "memory_project_task_links") {
					linkRows.splice(0, linkRows.length, values);
				}
				return {
					onConflictDoUpdate: vi.fn(async () => undefined),
				};
			},
		}),
		update: () => ({
			set: () => ({
				where: vi.fn(async () => undefined),
			}),
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
	},
	conversationSummaries: {
		__name: "conversation_summaries",
		conversationId: { name: "conversationId" },
		userId: { name: "userId" },
		summary: { name: "summary" },
		updatedAt: { name: "updatedAt" },
	},
	messages: {
		__name: "messages",
		id: { name: "id" },
		conversationId: { name: "conversationId" },
		role: { name: "role" },
		content: { name: "content" },
		createdAt: { name: "createdAt" },
	},
	conversationTaskStates: {
		__name: "conversation_task_states",
		taskId: { name: "taskId" },
		userId: { name: "userId" },
		conversationId: { name: "conversationId" },
		objective: { name: "objective" },
		updatedAt: { name: "updatedAt" },
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
}));

vi.mock("drizzle-orm", () => ({
	and: vi.fn((...conditions: unknown[]) => conditions),
	asc: vi.fn((field: { name: string }) => ({
		direction: "asc",
		field: field.name,
	})),
	count: vi.fn(() => ({ kind: "count" })),
	desc: vi.fn((field: { name: string }) => ({
		direction: "desc",
		field: field.name,
	})),
	eq: vi.fn((field: { name: string }, value: unknown) => ({
		operator: "eq",
		field: field.name,
		value,
	})),
	ne: vi.fn((field: { name: string }, value: unknown) => ({
		operator: "ne",
		field: field.name,
		value,
	})),
	inArray: vi.fn((field: { name: string }, values: unknown[]) => ({
		operator: "inArray",
		field: field.name,
		value: values,
	})),
}));

vi.mock("$lib/server/services/memory-events", () => ({
	recordMemoryEvent: mockRecordMemoryEvent,
	listLatestMemoryEventsBySubject: mockListLatestMemoryEventsBySubject,
	listMemoryEvents: mockListMemoryEvents,
}));

vi.mock("./control-model", () => ({
	canUseContextSummarizer: mockCanUseContextSummarizer,
	requestStructuredControlModel: vi.fn(async () => null),
}));

vi.mock("./mappers", () => ({
	mapTaskCheckpoint: vi.fn(),
	mapTaskState: vi.fn((value: unknown) => value),
}));

vi.mock("$lib/server/utils/json", () => ({
	parseJsonStringArray: vi.fn(() => []),
}));

vi.mock("$lib/server/utils/text", () => ({
	clipNullableText: vi.fn((value: string | null | undefined) => value ?? null),
	normalizeWhitespace: vi.fn((value: string) => value.trim()),
}));

vi.mock("$lib/server/services/working-set", () => ({
	scoreMatch: vi.fn(() => 0),
}));

describe("task continuity memory events", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockListLatestMemoryEventsBySubject.mockResolvedValue(new Map());
		mockListMemoryEvents.mockResolvedValue([]);
		insertedProjects.splice(0, insertedProjects.length);
		projectRows.splice(0, projectRows.length);
		projectFolderRows.splice(0, projectFolderRows.length);
		linkRows.splice(0, linkRows.length);
		conversationRows.splice(0, conversationRows.length);
		conversationSummaryRows.splice(0, conversationSummaryRows.length);
		messageRows.splice(0, messageRows.length);
		taskStateRows.splice(0, taskStateRows.length);
		checkpointRows.splice(0, checkpointRows.length);
	});

	it("promotes the same-folder sibling that strongly matches the current query", async () => {
		projectFolderRows.push({
			id: "folder-1",
			userId: "user-1",
			name: "Brand refresh",
			updatedAt: new Date("2026-05-14T09:00:00.000Z"),
		});
		conversationRows.push(
			{
				id: "conv-current",
				userId: "user-1",
				title: "Current conversation",
				projectId: "folder-1",
				updatedAt: new Date("2026-05-14T09:20:00.000Z"),
			},
			{
				id: "conv-fonts",
				userId: "user-1",
				title: "Font options for the brand refresh",
				projectId: "folder-1",
				updatedAt: new Date("2026-05-14T09:10:00.000Z"),
			},
			{
				id: "conv-colors",
				userId: "user-1",
				title: "Color palette notes",
				projectId: "folder-1",
				updatedAt: new Date("2026-05-14T09:15:00.000Z"),
			},
			{
				id: "conv-other-folder",
				userId: "user-1",
				title: "Font options from a different folder",
				projectId: "folder-2",
				updatedAt: new Date("2026-05-14T09:30:00.000Z"),
			},
		);
		taskStateRows.push(
			{
				taskId: "task-fonts",
				userId: "user-1",
				conversationId: "conv-fonts",
				objective: "Compare font options for headings and body copy",
				updatedAt: new Date("2026-05-14T09:11:00.000Z"),
			},
			{
				taskId: "task-colors",
				userId: "user-1",
				conversationId: "conv-colors",
				objective: "Choose color palette options",
				updatedAt: new Date("2026-05-14T09:16:00.000Z"),
			},
		);
		checkpointRows.push({
			taskId: "task-fonts",
			userId: "user-1",
			content:
				"Discussed Inter, Source Sans, and a serif accent as font options.",
			checkpointType: "stable",
			updatedAt: new Date("2026-05-14T09:12:00.000Z"),
		});
		messageRows.push(
			{
				id: "msg-1",
				conversationId: "conv-fonts",
				role: "user",
				content: "What font options should we consider?",
				createdAt: new Date("2026-05-14T09:12:00.000Z"),
			},
			{
				id: "msg-2",
				conversationId: "conv-fonts",
				role: "assistant",
				content:
					"Inter, Source Sans, and a restrained serif accent fit the brief.",
				createdAt: new Date("2026-05-14T09:13:00.000Z"),
			},
			{
				id: "msg-3",
				conversationId: "conv-fonts",
				role: "assistant",
				content: "Older font note should be omitted by the message cap.",
				createdAt: new Date("2026-05-14T09:11:00.000Z"),
			},
		);

		const { selectProjectFolderSiblingPromotion } = await import(
			"./continuity"
		);

		const promotion = await selectProjectFolderSiblingPromotion({
			userId: "user-1",
			conversationId: "conv-current",
			query: "what font options did we discuss in this project?",
			messageLimit: 2,
		});

		expect(promotion).toEqual({
			projectId: "folder-1",
			projectName: "Brand refresh",
			conversationId: "conv-fonts",
			title: "Font options for the brand refresh",
			objective: "Compare font options for headings and body copy",
			summary:
				"Discussed Inter, Source Sans, and a serif accent as font options.",
			score: expect.any(Number),
			matchedTerms: expect.arrayContaining(["font", "options"]),
			messages: [
				{
					role: "user",
					content: "What font options should we consider?",
					createdAt: new Date("2026-05-14T09:12:00.000Z").getTime(),
				},
				{
					role: "assistant",
					content:
						"Inter, Source Sans, and a restrained serif accent fit the brief.",
					createdAt: new Date("2026-05-14T09:13:00.000Z").getTime(),
				},
			],
			omittedMessageCount: 1,
		});
		expect(promotion?.score).toBeGreaterThanOrEqual(8);
	});

	it("does not promote a sibling for generic folder references without a strong query match", async () => {
		conversationRows.push(
			{
				id: "conv-current",
				userId: "user-1",
				title: "Current conversation",
				projectId: "folder-1",
				updatedAt: new Date("2026-05-14T09:20:00.000Z"),
			},
			{
				id: "conv-colors",
				userId: "user-1",
				title: "Color palette options",
				projectId: "folder-1",
				updatedAt: new Date("2026-05-14T09:15:00.000Z"),
			},
		);
		taskStateRows.push({
			taskId: "task-colors",
			userId: "user-1",
			conversationId: "conv-colors",
			objective: "Choose color palette options",
			updatedAt: new Date("2026-05-14T09:16:00.000Z"),
		});

		const { selectProjectFolderSiblingPromotion } = await import(
			"./continuity"
		);

		await expect(
			selectProjectFolderSiblingPromotion({
				userId: "user-1",
				conversationId: "conv-current",
				query: "what font options did we discuss in this project?",
			}),
		).resolves.toBeNull();
	});

	it("returns no Project Folder Awareness when the conversation is not in a folder", async () => {
		conversationRows.push({
			id: "conv-current",
			userId: "user-1",
			title: "Current conversation",
			projectId: null,
			updatedAt: new Date("2026-05-14T09:00:00.000Z"),
		});

		const { getProjectFolderReferenceContext } = await import("./continuity");

		await expect(
			getProjectFolderReferenceContext({
				userId: "user-1",
				conversationId: "conv-current",
			}),
		).resolves.toBeNull();
	});

	it("finds a named project folder by query for explicit memory_context lookup", async () => {
		projectFolderRows.push(
			{
				id: "folder-almalinux",
				userId: "user-1",
				name: "AlmaLinux Server",
				updatedAt: new Date("2026-05-14T09:10:00.000Z"),
			},
			{
				id: "folder-other",
				userId: "user-1",
				name: "Other Server",
				updatedAt: new Date("2026-05-14T09:11:00.000Z"),
			},
		);
		conversationRows.push(
			{
				id: "conv-current",
				userId: "user-1",
				title: "Unrelated active chat",
				projectId: null,
				updatedAt: new Date("2026-05-14T09:00:00.000Z"),
			},
			{
				id: "conv-alma-1",
				userId: "user-1",
				title: "AlmaLinux hardening notes",
				projectId: "folder-almalinux",
				updatedAt: new Date("2026-05-14T09:08:00.000Z"),
			},
			{
				id: "conv-alma-2",
				userId: "user-1",
				title: "AlmaLinux backup plan",
				projectId: "folder-almalinux",
				updatedAt: new Date("2026-05-14T09:07:00.000Z"),
			},
			{
				id: "conv-other",
				userId: "user-1",
				title: "Other server notes",
				projectId: "folder-other",
				updatedAt: new Date("2026-05-14T09:09:00.000Z"),
			},
		);
		conversationSummaryRows.push({
			conversationId: "conv-alma-1",
			userId: "user-1",
			summary: "Configured SSH, Cockpit, storage, and update policy.",
			updatedAt: new Date("2026-05-14T09:09:00.000Z"),
		});

		const { findProjectFolderReferenceContextByQuery } = await import(
			"./continuity"
		);

		const context = await findProjectFolderReferenceContextByQuery({
			userId: "user-1",
			conversationId: "conv-current",
			query:
				"Generate a detailed PDF report with the content from AlmaLinux Server project folder",
		});

		expect(context).toEqual({
			source: "project_folder",
			projectId: "folder-almalinux",
			projectName: "AlmaLinux Server",
			entries: [
				{
					conversationId: "conv-alma-1",
					title: "AlmaLinux hardening notes",
					objective: null,
					summary: "Configured SSH, Cockpit, storage, and update policy.",
				},
				{
					conversationId: "conv-alma-2",
					title: "AlmaLinux backup plan",
					objective: null,
					summary: null,
				},
			],
			omittedSiblingCount: 0,
		});
	});

	it("returns bounded Project Continuity Awareness for an unorganized conversation linked to memory project work", async () => {
		projectRows.push({
			projectId: "memory-project-1",
			userId: "user-1",
			name: "Launch continuity",
			summary: "Inferred long-term launch work.",
			status: "active",
			lastActiveAt: new Date("2026-05-14T08:00:00.000Z"),
			updatedAt: new Date("2026-05-14T08:00:00.000Z"),
		});
		conversationRows.push(
			{
				id: "conv-current",
				userId: "user-1",
				title: "Current unorganized conversation",
				projectId: null,
				updatedAt: new Date("2026-05-14T09:00:00.000Z"),
			},
			{
				id: "conv-linked-1",
				userId: "user-1",
				title: "Linked launch brief",
				projectId: null,
				updatedAt: new Date("2026-05-14T09:05:00.000Z"),
			},
			{
				id: "conv-linked-2",
				userId: "user-1",
				title: "Linked rollout notes",
				projectId: null,
				updatedAt: new Date("2026-05-14T09:04:00.000Z"),
			},
			{
				id: "conv-global",
				userId: "user-1",
				title: "Unrelated global conversation",
				projectId: null,
				updatedAt: new Date("2026-05-14T09:06:00.000Z"),
			},
		);
		taskStateRows.push(
			{
				taskId: "task-current",
				userId: "user-1",
				conversationId: "conv-current",
				objective: "Continue the launch project",
				updatedAt: new Date("2026-05-14T09:01:00.000Z"),
			},
			{
				taskId: "task-linked-1",
				userId: "user-1",
				conversationId: "conv-linked-1",
				objective: "Prepare the launch brief",
				updatedAt: new Date("2026-05-14T09:05:00.000Z"),
			},
			{
				taskId: "task-linked-2",
				userId: "user-1",
				conversationId: "conv-linked-2",
				objective: "Plan launch rollout sequencing",
				updatedAt: new Date("2026-05-14T09:04:00.000Z"),
			},
			{
				taskId: "task-global",
				userId: "user-1",
				conversationId: "conv-global",
				objective: "Unrelated global work",
				updatedAt: new Date("2026-05-14T09:06:00.000Z"),
			},
		);
		linkRows.push(
			{
				projectId: "memory-project-1",
				userId: "user-1",
				taskId: "task-current",
				conversationId: "conv-current",
				updatedAt: new Date("2026-05-14T09:01:00.000Z"),
			},
			{
				projectId: "memory-project-1",
				userId: "user-1",
				taskId: "task-linked-1",
				conversationId: "conv-linked-1",
				updatedAt: new Date("2026-05-14T09:05:00.000Z"),
			},
			{
				projectId: "memory-project-1",
				userId: "user-1",
				taskId: "task-linked-2",
				conversationId: "conv-linked-2",
				updatedAt: new Date("2026-05-14T09:04:00.000Z"),
			},
			{
				projectId: "other-memory-project",
				userId: "user-1",
				taskId: "task-global",
				conversationId: "conv-global",
				updatedAt: new Date("2026-05-14T09:06:00.000Z"),
			},
		);
		checkpointRows.push({
			taskId: "task-linked-1",
			userId: "user-1",
			content: "Stable linked launch checkpoint.",
			checkpointType: "stable",
			updatedAt: new Date("2026-05-14T09:05:30.000Z"),
		});

		const { getProjectReferenceContext } = await import("./continuity");

		const context = await getProjectReferenceContext({
			userId: "user-1",
			conversationId: "conv-current",
		});

		expect(context).toEqual({
			source: "project_continuity",
			projectId: "memory-project-1",
			projectName: "Launch continuity",
			entries: [
				{
					conversationId: "conv-linked-1",
					title: "Linked launch brief",
					objective: "Prepare the launch brief",
					summary: "Stable linked launch checkpoint.",
				},
				{
					conversationId: "conv-linked-2",
					title: "Linked rollout notes",
					objective: "Plan launch rollout sequencing",
					summary: "Plan launch rollout sequencing",
				},
			],
			omittedSiblingCount: 0,
		});
	});

	it("prefers durable conversation summaries in Project Continuity Awareness", async () => {
		projectRows.push({
			projectId: "memory-project-1",
			userId: "user-1",
			name: "Launch continuity",
			summary: "Inferred long-term launch work.",
			status: "active",
			lastActiveAt: new Date("2026-05-14T08:00:00.000Z"),
			updatedAt: new Date("2026-05-14T08:00:00.000Z"),
		});
		conversationRows.push(
			{
				id: "conv-current",
				userId: "user-1",
				title: "Current unorganized conversation",
				projectId: null,
				updatedAt: new Date("2026-05-14T09:00:00.000Z"),
			},
			{
				id: "conv-linked",
				userId: "user-1",
				title: "Linked launch brief",
				projectId: null,
				updatedAt: new Date("2026-05-14T09:05:00.000Z"),
			},
		);
		taskStateRows.push({
			taskId: "task-linked",
			userId: "user-1",
			conversationId: "conv-linked",
			objective: "Older continuity objective fallback",
			updatedAt: new Date("2026-05-14T09:05:00.000Z"),
		});
		linkRows.push(
			{
				projectId: "memory-project-1",
				userId: "user-1",
				taskId: "task-current",
				conversationId: "conv-current",
				updatedAt: new Date("2026-05-14T09:01:00.000Z"),
			},
			{
				projectId: "memory-project-1",
				userId: "user-1",
				taskId: "task-linked",
				conversationId: "conv-linked",
				updatedAt: new Date("2026-05-14T09:05:00.000Z"),
			},
		);
		checkpointRows.push({
			taskId: "task-linked",
			userId: "user-1",
			content: "Older continuity checkpoint fallback.",
			checkpointType: "stable",
			updatedAt: new Date("2026-05-14T09:05:30.000Z"),
		});
		conversationSummaryRows.push({
			conversationId: "conv-linked",
			userId: "user-1",
			summary: "Durable continuity summary wins for awareness.",
			updatedAt: new Date("2026-05-14T09:06:00.000Z"),
		});

		const { getProjectReferenceContext } = await import("./continuity");

		const context = await getProjectReferenceContext({
			userId: "user-1",
			conversationId: "conv-current",
		});

		expect(context).toMatchObject({
			source: "project_continuity",
			entries: [
				{
					conversationId: "conv-linked",
					title: "Linked launch brief",
					objective: "Older continuity objective fallback",
					summary: "Durable continuity summary wins for awareness.",
				},
			],
		});
	});

	it("keeps Project Folder Awareness canonical when a folder conversation also has inferred continuity links", async () => {
		projectFolderRows.push({
			id: "folder-1",
			userId: "user-1",
			name: "Explicit folder",
			updatedAt: new Date("2026-05-14T09:00:00.000Z"),
		});
		projectRows.push({
			projectId: "memory-project-1",
			userId: "user-1",
			name: "Inferred continuity",
			summary: "Lower-authority inferred work.",
			status: "active",
			lastActiveAt: new Date("2026-05-14T08:00:00.000Z"),
			updatedAt: new Date("2026-05-14T08:00:00.000Z"),
		});
		conversationRows.push(
			{
				id: "conv-current",
				userId: "user-1",
				title: "Current folder conversation",
				projectId: "folder-1",
				updatedAt: new Date("2026-05-14T09:00:00.000Z"),
			},
			{
				id: "conv-folder-sibling",
				userId: "user-1",
				title: "Folder sibling",
				projectId: "folder-1",
				updatedAt: new Date("2026-05-14T09:05:00.000Z"),
			},
			{
				id: "conv-continuity-sibling",
				userId: "user-1",
				title: "Continuity sibling",
				projectId: null,
				updatedAt: new Date("2026-05-14T09:06:00.000Z"),
			},
		);
		linkRows.push(
			{
				projectId: "memory-project-1",
				userId: "user-1",
				taskId: "task-current",
				conversationId: "conv-current",
				updatedAt: new Date("2026-05-14T09:01:00.000Z"),
			},
			{
				projectId: "memory-project-1",
				userId: "user-1",
				taskId: "task-continuity-sibling",
				conversationId: "conv-continuity-sibling",
				updatedAt: new Date("2026-05-14T09:06:00.000Z"),
			},
		);

		const { getProjectReferenceContext } = await import("./continuity");

		const context = await getProjectReferenceContext({
			userId: "user-1",
			conversationId: "conv-current",
		});

		expect(context).toMatchObject({
			source: "project_folder",
			projectId: "folder-1",
			projectName: "Explicit folder",
			entries: [
				expect.objectContaining({
					conversationId: "conv-folder-sibling",
					title: "Folder sibling",
				}),
			],
		});
		expect(context?.entries.map((entry) => entry.conversationId)).not.toContain(
			"conv-continuity-sibling",
		);
	});

	it("includes only same-user same-folder siblings and excludes the current conversation", async () => {
		projectFolderRows.push({
			id: "folder-1",
			userId: "user-1",
			name: "Launch folder",
			updatedAt: new Date("2026-05-14T09:00:00.000Z"),
		});
		conversationRows.push(
			{
				id: "conv-current",
				userId: "user-1",
				title: "Current conversation",
				projectId: "folder-1",
				updatedAt: new Date("2026-05-14T09:00:00.000Z"),
			},
			{
				id: "conv-sibling",
				userId: "user-1",
				title: "Sibling brief",
				projectId: "folder-1",
				updatedAt: new Date("2026-05-14T09:05:00.000Z"),
			},
			{
				id: "conv-other-folder",
				userId: "user-1",
				title: "Other folder",
				projectId: "folder-2",
				updatedAt: new Date("2026-05-14T09:06:00.000Z"),
			},
			{
				id: "conv-other-user",
				userId: "user-2",
				title: "Other user sibling",
				projectId: "folder-1",
				updatedAt: new Date("2026-05-14T09:07:00.000Z"),
			},
		);

		const { getProjectFolderReferenceContext } = await import("./continuity");

		const context = await getProjectFolderReferenceContext({
			userId: "user-1",
			conversationId: "conv-current",
		});

		expect(context).toEqual({
			projectId: "folder-1",
			projectName: "Launch folder",
			entries: [
				{
					conversationId: "conv-sibling",
					title: "Sibling brief",
					objective: null,
					summary: null,
				},
			],
			omittedSiblingCount: 0,
		});
	});

	it("prefers stable checkpoints and falls back to the latest meaningful objective", async () => {
		conversationRows.push(
			{
				id: "conv-current",
				userId: "user-1",
				title: "Current conversation",
				projectId: "folder-1",
				updatedAt: new Date("2026-05-14T09:00:00.000Z"),
			},
			{
				id: "conv-stable",
				userId: "user-1",
				title: "Stable sibling",
				projectId: "folder-1",
				updatedAt: new Date("2026-05-14T09:06:00.000Z"),
			},
			{
				id: "conv-objective",
				userId: "user-1",
				title: "Objective sibling",
				projectId: "folder-1",
				updatedAt: new Date("2026-05-14T09:05:00.000Z"),
			},
		);
		taskStateRows.push(
			{
				taskId: "task-stable-old-placeholder",
				userId: "user-1",
				conversationId: "conv-stable",
				objective: "New task",
				updatedAt: new Date("2026-05-14T09:04:00.000Z"),
			},
			{
				taskId: "task-stable",
				userId: "user-1",
				conversationId: "conv-stable",
				objective: "Prepare the stable folder brief",
				updatedAt: new Date("2026-05-14T09:03:00.000Z"),
			},
			{
				taskId: "task-objective",
				userId: "user-1",
				conversationId: "conv-objective",
				objective: "Define the launch metrics",
				updatedAt: new Date("2026-05-14T09:02:00.000Z"),
			},
		);
		checkpointRows.push(
			{
				taskId: "task-stable",
				userId: "user-1",
				content: "Latest volatile checkpoint should not win.",
				checkpointType: "transient",
				updatedAt: new Date("2026-05-14T09:08:00.000Z"),
			},
			{
				taskId: "task-stable",
				userId: "user-1",
				content: "Stable checkpoint summary wins.",
				checkpointType: "stable",
				updatedAt: new Date("2026-05-14T09:07:00.000Z"),
			},
		);

		const { getProjectFolderReferenceContext } = await import("./continuity");

		const context = await getProjectFolderReferenceContext({
			userId: "user-1",
			conversationId: "conv-current",
		});

		expect(context?.entries).toEqual([
			{
				conversationId: "conv-stable",
				title: "Stable sibling",
				objective: "Prepare the stable folder brief",
				summary: "Stable checkpoint summary wins.",
			},
			{
				conversationId: "conv-objective",
				title: "Objective sibling",
				objective: "Define the launch metrics",
				summary: "Define the launch metrics",
			},
		]);
	});

	it("prefers durable conversation summaries in Project Folder Awareness", async () => {
		conversationRows.push(
			{
				id: "conv-current",
				userId: "user-1",
				title: "Current conversation",
				projectId: "folder-1",
				updatedAt: new Date("2026-05-14T09:00:00.000Z"),
			},
			{
				id: "conv-sibling",
				userId: "user-1",
				title: "Sibling with durable summary",
				projectId: "folder-1",
				updatedAt: new Date("2026-05-14T09:06:00.000Z"),
			},
		);
		taskStateRows.push({
			taskId: "task-sibling",
			userId: "user-1",
			conversationId: "conv-sibling",
			objective: "Older task objective fallback",
			updatedAt: new Date("2026-05-14T09:03:00.000Z"),
		});
		checkpointRows.push({
			taskId: "task-sibling",
			userId: "user-1",
			content: "Older checkpoint fallback.",
			checkpointType: "stable",
			updatedAt: new Date("2026-05-14T09:04:00.000Z"),
		});
		conversationSummaryRows.push({
			conversationId: "conv-sibling",
			userId: "user-1",
			summary: "Durable sibling summary wins for awareness.",
			updatedAt: new Date("2026-05-14T09:05:00.000Z"),
		});

		const { getProjectFolderReferenceContext } = await import("./continuity");

		const context = await getProjectFolderReferenceContext({
			userId: "user-1",
			conversationId: "conv-current",
		});

		expect(context?.entries).toEqual([
			{
				conversationId: "conv-sibling",
				title: "Sibling with durable summary",
				objective: "Older task objective fallback",
				summary: "Durable sibling summary wins for awareness.",
			},
		]);
	});

	it("caps folder awareness deterministically and reports omitted siblings", async () => {
		conversationRows.push({
			id: "conv-current",
			userId: "user-1",
			title: "Current conversation",
			projectId: "folder-1",
			updatedAt: new Date("2026-05-14T09:10:00.000Z"),
		});
		for (const [id, minute] of [
			["conv-1", "01"],
			["conv-2", "02"],
			["conv-3", "03"],
			["conv-4", "04"],
			["conv-b", "05"],
			["conv-a", "05"],
			["conv-0", "00"],
		]) {
			conversationRows.push({
				id,
				userId: "user-1",
				title: `Sibling ${id}`,
				projectId: "folder-1",
				updatedAt: new Date(`2026-05-14T09:${minute}:00.000Z`),
			});
		}

		const { getProjectFolderReferenceContext } = await import("./continuity");

		const context = await getProjectFolderReferenceContext({
			userId: "user-1",
			conversationId: "conv-current",
		});

		expect(context?.entries.map((entry) => entry.conversationId)).toEqual([
			"conv-a",
			"conv-b",
			"conv-4",
			"conv-3",
			"conv-2",
		]);
		expect(context?.omittedSiblingCount).toBe(2);
	});

	it("resolves paused project events as dormant even when the stored row still says active", async () => {
		const { resolveProjectContinuityStatus } = await import("./continuity");

		expect(
			resolveProjectContinuityStatus({
				storedStatus: "active",
				lastActiveAt: Date.now(),
				latestEventType: "project_paused",
			}),
		).toBe("dormant");
	});

	it("records a project_started event when creating a new continuity bucket", async () => {
		const { syncTaskContinuityFromTaskState } = await import("./continuity");

		await syncTaskContinuityFromTaskState({
			userId: "user-1",
			taskState: {
				taskId: "task-1",
				userId: "user-1",
				conversationId: "conv-1",
				status: "active",
				objective: "Draft the new launch brief",
				confidence: 88,
				locked: false,
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
		});

		expect(insertedProjects).toHaveLength(1);
		expect(mockRecordMemoryEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				domain: "task",
				eventType: "project_started",
				relatedId: "task-1",
			}),
		);
	});

	it("records a project_paused event when project status falls out of active", async () => {
		projectRows.push({
			projectId: "project-1",
			userId: "user-1",
			name: "Launch brief",
			status: "active",
			lastActiveAt: new Date(Date.now() - 20 * 86_400_000),
			updatedAt: new Date(Date.now() - 20 * 86_400_000),
		});

		const { updateProjectMemoryStatuses } = await import("./continuity");

		await updateProjectMemoryStatuses("user-1");

		expect(mockRecordMemoryEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				domain: "task",
				eventType: "project_paused",
				subjectId: "project-1",
			}),
		);
	});

	it("records an explicit pause signal from the user message and updates continuity state", async () => {
		linkRows.push({
			projectId: "project-2",
			userId: "user-1",
			taskId: "task-2",
			status: "active",
			lastActiveAt: new Date(),
		});

		const {
			applyProjectContinuitySignalFromMessage,
			detectProjectContinuitySignal,
		} = await import("./continuity");

		expect(detectProjectContinuitySignal("Pause this project for now.")).toBe(
			"project_paused",
		);

		await applyProjectContinuitySignalFromMessage({
			userId: "user-1",
			taskState: {
				taskId: "task-2",
				userId: "user-1",
				conversationId: "conv-2",
				status: "active",
				objective: "Launch brief",
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
				subjectId: "project-2",
				relatedId: "task-2",
			}),
		);
	});
});
