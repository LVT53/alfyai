import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/task-state", () => ({
	getProjectReferenceContext: vi.fn(),
}));

const { artifactRows, deepResearchRows, messageRows, queryLimits } = vi.hoisted(() => ({
	artifactRows: [] as Array<Record<string, any>>,
	deepResearchRows: [] as Array<Record<string, any>>,
	messageRows: [] as Array<Record<string, any>>,
	queryLimits: [] as number[],
}));

type MockCondition =
	| { operator: "eq" | "inArray"; field: string; value: unknown }
	| MockCondition[]
	| null
	| undefined;

type MockOrder = { direction: "asc" | "desc"; field: string };

function matchesCondition(row: Record<string, any>, condition: MockCondition): boolean {
	if (!condition) return true;
	if (Array.isArray(condition)) {
		return condition.every((nested) => matchesCondition(row, nested));
	}
	const actual = row[condition.field];
	if (condition.operator === "eq") return actual === condition.value;
	if (condition.operator === "inArray") {
		return Array.isArray(condition.value) && condition.value.includes(actual);
	}
	return true;
}

function readComparable(value: unknown): string | number {
	if (value instanceof Date) return value.getTime();
	if (typeof value === "number") return value;
	if (typeof value === "string") return value;
	return String(value ?? "");
}

function mapSelectedRows(rows: Array<Record<string, any>>, shape?: Record<string, any>) {
	if (!shape) return rows;
	if (Object.values(shape).some((field) => field?.kind === "count")) {
		return [
			Object.fromEntries(
				Object.entries(shape).map(([alias, field]) => [
					alias,
					field?.kind === "count" ? rows.length : rows[0]?.[field?.name],
				]),
			),
		];
	}
	return rows.map((row) =>
		Object.fromEntries(
			Object.entries(shape).map(([alias, field]) => [
				alias,
				row[field?.name ?? alias],
			]),
		),
	);
}

function createQuery(rows: Array<Record<string, any>>, shape?: Record<string, any>) {
	let currentRows = [...rows];
	const chain = {
		from: () => chain,
		innerJoin: (table: { __name?: string }) => {
			if (table?.__name === "artifacts") {
				currentRows = currentRows.flatMap((row) =>
					artifactRows
						.filter((artifact) => artifact.artifactId === row.reportArtifactId)
						.map((artifact) => ({ ...row, ...artifact })),
				);
			}
			return chain;
		},
		where: (condition: MockCondition) => {
			currentRows = currentRows.filter((row) => matchesCondition(row, condition));
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
		limit: async (limit: number) => {
			queryLimits.push(limit);
			return mapSelectedRows(currentRows.slice(0, limit), shape);
		},
		then: (onFulfilled: (value: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
			Promise.resolve(mapSelectedRows(currentRows, shape)).then(onFulfilled, onRejected),
	};
	return chain;
}

vi.mock("$lib/server/db", () => ({
	db: {
		select: (shape?: Record<string, any>) => ({
			from: (table: { __name?: string }) => {
				if (table?.__name === "messages") {
					return createQuery(messageRows, shape);
				}
				if (table?.__name === "deepResearchJobs") {
					return createQuery(deepResearchRows, shape);
				}
				return createQuery([], shape);
			},
		}),
	},
}));

vi.mock("$lib/server/db/schema", () => ({
	artifacts: {
		__name: "artifacts",
		id: { name: "artifactId" },
		userId: { name: "artifactUserId" },
		name: { name: "reportTitle" },
		summary: { name: "reportSummary" },
		contentText: { name: "reportContent" },
	},
	deepResearchJobs: {
		__name: "deepResearchJobs",
		id: { name: "jobId" },
		userId: { name: "jobUserId" },
		conversationId: { name: "conversationId" },
		status: { name: "status" },
		title: { name: "title" },
		userRequest: { name: "userRequest" },
		depth: { name: "depth" },
		completedAt: { name: "completedAt" },
		updatedAt: { name: "updatedAt" },
		createdAt: { name: "createdAt" },
		reportArtifactId: { name: "reportArtifactId" },
	},
	messages: {
		__name: "messages",
		conversationId: { name: "conversationId" },
		role: { name: "role" },
		content: { name: "content" },
		createdAt: { name: "createdAt" },
	},
}));

vi.mock("drizzle-orm", () => ({
	and: vi.fn((...conditions: unknown[]) => conditions),
	count: vi.fn(() => ({ kind: "count" })),
	desc: vi.fn((field: { name: string }) => ({ direction: "desc", field: field.name })),
	eq: vi.fn((field: { name: string }, value: unknown) => ({
		operator: "eq",
		field: field.name,
		value,
	})),
	inArray: vi.fn((field: { name: string }, values: unknown[]) => ({
		operator: "inArray",
		field: field.name,
		value: values,
	})),
}));

import { getProjectReferenceContext } from "$lib/server/services/task-state";
import { getProjectContext } from "./project-context";

const mockGetProjectReferenceContext =
	getProjectReferenceContext as ReturnType<typeof vi.fn>;

describe("getProjectContext", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		artifactRows.splice(0, artifactRows.length);
		deepResearchRows.splice(0, deepResearchRows.length);
		messageRows.splice(0, messageRows.length);
		queryLimits.splice(0, queryLimits.length);
	});

	it("returns bounded project folder summary context without transcripts", async () => {
		mockGetProjectReferenceContext.mockResolvedValue({
			source: "project_folder",
			projectId: "project-1",
			projectName: "Launch Plan",
			omittedSiblingCount: 2,
			entries: [
				{
					conversationId: "conv-2",
					title: "Pricing",
					objective: "Compare pricing options",
					summary: "Stable pricing brief.",
				},
				{
					conversationId: "conv-3",
					title: "Messaging",
					objective: null,
					summary: "Positioning decisions.",
				},
			],
		});

		const result = await getProjectContext({
			userId: "user-1",
			conversationId: "conv-1",
			mode: "summary",
			maxSiblings: 1,
			includeEvidenceCandidates: true,
		});

		expect(result).toMatchObject({
			success: true,
			mode: "summary",
			hasProjectContext: true,
			source: "project_folder",
			project: {
				id: "project-1",
				name: "Launch Plan",
				authority: "project_folder",
			},
			omittedSiblingCount: 3,
			audit: {
				conversationId: "conv-1",
				requestedMaxSiblings: 1,
				appliedMaxSiblings: 1,
				scope: "conversation",
			},
		});
		expect(result.siblings).toEqual([
			{
				conversationId: "conv-2",
				title: "Pricing",
				objective: "Compare pricing options",
				summary: "Stable pricing brief.",
			},
		]);
		expect(result.evidenceCandidates).toEqual([
			{
				id: "conversation-summary:conv-2",
				title: "Pricing",
				snippet: "Stable pricing brief.",
				sourceType: "memory",
			},
		]);
		expect(JSON.stringify(result)).not.toContain("messages");
		expect(JSON.stringify(result)).not.toContain("transcript");
	});

	it("includes completed deep-research questions and report summaries in summary context", async () => {
		mockGetProjectReferenceContext.mockResolvedValue({
			source: "project_folder",
			projectId: "project-1",
			projectName: "Launch Plan",
			omittedSiblingCount: 0,
			entries: [
				{
					conversationId: "conv-2",
					title: "Regulatory research",
					objective: "Understand compliance risks",
					summary: "Research planning chat.",
				},
			],
		});
		deepResearchRows.push({
			conversationId: "conv-2",
			jobUserId: "user-1",
			status: "completed",
			jobId: "job-1",
			title: "AI copyright research",
			userRequest: "Compare EU and US AI copyright training data rules",
			depth: "standard",
			completedAt: new Date("2026-05-14T10:00:00.000Z"),
			updatedAt: new Date("2026-05-14T10:00:00.000Z"),
			createdAt: new Date("2026-05-14T09:00:00.000Z"),
			reportArtifactId: "artifact-1",
		});
		artifactRows.push({
			artifactId: "artifact-1",
			artifactUserId: "user-1",
			reportTitle: "AI copyright research.md",
			reportSummary: "Audited Research Report for AI copyright research",
			reportContent: "Full report body should only appear in detail mode.",
		});

		const result = await getProjectContext({
			userId: "user-1",
			conversationId: "conv-1",
			mode: "summary",
			includeEvidenceCandidates: true,
		});

		expect(result.siblings[0]?.deepResearchResults).toEqual([
			{
				jobId: "job-1",
				title: "AI copyright research",
				userRequest: "Compare EU and US AI copyright training data rules",
				depth: "standard",
				completedAt: new Date("2026-05-14T10:00:00.000Z").getTime(),
				reportArtifact: {
					id: "artifact-1",
					title: "AI copyright research.md",
					summary: "Audited Research Report for AI copyright research",
				},
			},
		]);
		expect(result.siblings[0]?.omittedDeepResearchResultCount).toBe(0);
		expect(result.evidenceCandidates).toEqual(
			expect.arrayContaining([
				{
					id: "deep-research-report:artifact-1",
					title: "AI copyright research.md",
					snippet:
						"Question: Compare EU and US AI copyright training data rules Audited Research Report for AI copyright research",
					sourceType: "document",
				},
			]),
		);
		expect(JSON.stringify(result)).not.toContain("Full report body should only");
	});

	it("returns an explicit non-error result when no folder or continuity exists", async () => {
		mockGetProjectReferenceContext.mockResolvedValue(null);

		const result = await getProjectContext({
			userId: "user-1",
			conversationId: "conv-empty",
			mode: "summary",
		});

		expect(result).toMatchObject({
			success: true,
			mode: "summary",
			hasProjectContext: false,
			source: "none",
			project: null,
			siblings: [],
			omittedSiblingCount: 0,
			evidenceCandidates: [],
			audit: {
				conversationId: "conv-empty",
				scope: "conversation",
				noProjectReason: "no_project_context",
			},
		});
	});

	it("rejects unsupported modes clearly", async () => {
		await expect(
			getProjectContext({
				userId: "user-1",
				conversationId: "conv-1",
				mode: "full",
			}),
		).rejects.toThrow(/Unsupported project_context mode/);
		expect(mockGetProjectReferenceContext).not.toHaveBeenCalled();
	});

	it("returns capped detail for an allowed project sibling without folder-wide transcripts", async () => {
		mockGetProjectReferenceContext.mockResolvedValue({
			source: "project_folder",
			projectId: "project-1",
			projectName: "Launch Plan",
			omittedSiblingCount: 0,
			entries: [
				{
					conversationId: "conv-2",
					title: "Pricing",
					objective: "Compare pricing options",
					summary: "Stable pricing brief.",
				},
			],
		});
		messageRows.push(
			{
				conversationId: "conv-2",
				role: "system",
				content: "hidden system prompt",
				createdAt: new Date("2026-05-14T09:00:00.000Z"),
			},
			{
				conversationId: "conv-2",
				role: "user",
				content: "Older user message",
				createdAt: new Date("2026-05-14T09:01:00.000Z"),
			},
			{
				conversationId: "conv-2",
				role: "assistant",
				content: "Older assistant message",
				createdAt: new Date("2026-05-14T09:02:00.000Z"),
			},
			{
				conversationId: "conv-2",
				role: "user",
				content: "Recent user message",
				createdAt: new Date("2026-05-14T09:03:00.000Z"),
			},
			{
				conversationId: "conv-2",
				role: "assistant",
				content: "Recent assistant message",
				createdAt: new Date("2026-05-14T09:04:00.000Z"),
			},
		);
		deepResearchRows.push({
			conversationId: "conv-2",
			jobUserId: "user-1",
			status: "completed",
			jobId: "job-1",
			title: "Pricing research",
			userRequest: "Find pricing model evidence",
			depth: "focused",
			completedAt: new Date("2026-05-14T09:05:00.000Z"),
			updatedAt: new Date("2026-05-14T09:05:00.000Z"),
			createdAt: new Date("2026-05-14T09:00:00.000Z"),
			reportArtifactId: "artifact-1",
		});
		artifactRows.push({
			artifactId: "artifact-1",
			artifactUserId: "user-1",
			reportTitle: "Pricing research.md",
			reportSummary: "Audited pricing research.",
			reportContent: "Detailed pricing report body.",
		});

		const result = await getProjectContext({
			userId: "user-1",
			conversationId: "conv-1",
			mode: "detail",
			siblingConversationId: "conv-2",
			maxMessages: 2,
		});

		expect(result).toMatchObject({
			success: true,
			mode: "detail",
			hasProjectContext: true,
			source: "project_folder",
			project: {
				id: "project-1",
				name: "Launch Plan",
				authority: "project_folder",
			},
			selectedSibling: {
				conversationId: "conv-2",
				title: "Pricing",
				objective: "Compare pricing options",
				summary: "Stable pricing brief.",
				omittedMessageCount: 2,
				messages: [
					{
						role: "user",
						content: "Recent user message",
						createdAt: new Date("2026-05-14T09:03:00.000Z").getTime(),
					},
					{
						role: "assistant",
						content: "Recent assistant message",
						createdAt: new Date("2026-05-14T09:04:00.000Z").getTime(),
					},
				],
				deepResearchResults: [
					{
						jobId: "job-1",
						title: "Pricing research",
						userRequest: "Find pricing model evidence",
						depth: "focused",
						completedAt: new Date("2026-05-14T09:05:00.000Z").getTime(),
						reportArtifact: {
							id: "artifact-1",
							title: "Pricing research.md",
							summary: "Audited pricing research.",
							content: "Detailed pricing report body.",
						},
					},
				],
			},
			audit: {
				conversationId: "conv-1",
				siblingConversationId: "conv-2",
				requestedMaxMessages: 2,
				appliedMaxMessages: 2,
			},
		});
		expect(result.evidenceCandidates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "project-context-detail:conv-2",
					title: "Pricing",
					sourceType: "memory",
				}),
				expect.objectContaining({
					id: "deep-research-report:artifact-1",
					title: "Pricing research.md",
					sourceType: "document",
				}),
			]),
		);
		expect(JSON.stringify(result)).not.toContain("hidden system prompt");
		expect(result.siblings).toEqual([]);
		expect(queryLimits).toEqual([2]);
	});

	it.each([
		["current conversation", "conv-1", /Current conversation is not a valid/],
		["other folder", "conv-other-folder", /outside project_context scope/],
		["other user", "conv-other-user", /outside project_context scope/],
	])("rejects out-of-scope detail for %s", async (_label, siblingConversationId, errorPattern) => {
		mockGetProjectReferenceContext.mockResolvedValue({
			source: "project_folder",
			projectId: "project-1",
			projectName: "Launch Plan",
			omittedSiblingCount: 0,
			entries: [
				{
					conversationId: "conv-2",
					title: "Pricing",
					objective: "Compare pricing options",
					summary: "Stable pricing brief.",
				},
			],
		});

		await expect(
			getProjectContext({
				userId: "user-1",
				conversationId: "conv-1",
				mode: "detail",
				siblingConversationId,
			}),
		).rejects.toThrow(errorPattern);
	});

	it("rejects detail for a sibling outside the allowed project continuity scope", async () => {
		mockGetProjectReferenceContext.mockResolvedValue({
			source: "project_continuity",
			projectId: "memory-project-1",
			projectName: "Inferred launch work",
			omittedSiblingCount: 0,
			entries: [
				{
					conversationId: "conv-2",
					title: "Pricing",
					objective: "Compare pricing options",
					summary: "Stable pricing brief.",
				},
			],
		});

		await expect(
			getProjectContext({
				userId: "user-1",
				conversationId: "conv-1",
				mode: "detail",
				siblingConversationId: "conv-other-inferred-project",
			}),
		).rejects.toThrow(/outside project_context scope/);
	});

	it("clamps detail messages to the hard cap", async () => {
		mockGetProjectReferenceContext.mockResolvedValue({
			source: "project_folder",
			projectId: "project-1",
			projectName: "Launch Plan",
			omittedSiblingCount: 0,
			entries: [
				{
					conversationId: "conv-2",
					title: "Pricing",
					objective: "Compare pricing options",
					summary: "Stable pricing brief.",
				},
			],
		});
		for (let index = 0; index < 12; index += 1) {
			messageRows.push({
				conversationId: "conv-2",
				role: index % 2 === 0 ? "user" : "assistant",
				content: `Message ${index}`,
				createdAt: new Date(2026, 4, 14, 9, index),
			});
		}

		const result = await getProjectContext({
			userId: "user-1",
			conversationId: "conv-1",
			mode: "detail",
			siblingConversationId: "conv-2",
			maxMessages: 999,
		});

		expect(result.audit.appliedMaxMessages).toBe(10);
		expect(result.selectedSibling?.messages).toHaveLength(10);
		expect(result.selectedSibling?.omittedMessageCount).toBe(2);
		expect(queryLimits).toEqual([10]);
	});

	it("returns an explicit detail no-context result when no project context exists", async () => {
		mockGetProjectReferenceContext.mockResolvedValue(null);

		const result = await getProjectContext({
			userId: "user-1",
			conversationId: "conv-empty",
			mode: "detail",
			siblingConversationId: "conv-2",
		});

		expect(result).toMatchObject({
			success: true,
			mode: "detail",
			hasProjectContext: false,
			source: "none",
			project: null,
			siblings: [],
			selectedSibling: null,
			evidenceCandidates: [],
			audit: {
				conversationId: "conv-empty",
				siblingConversationId: "conv-2",
				noProjectReason: "no_project_context",
			},
		});
	});
});
