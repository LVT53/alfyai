import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/task-state", () => ({
	findProjectFolderReferenceContextByQuery: vi.fn(),
	getProjectReferenceContext: vi.fn(),
}));

const { messageRows, queryLimits } = vi.hoisted(() => ({
	messageRows: [] as Array<Record<string, unknown>>,
	queryLimits: [] as number[],
}));

const { targetConstructedContext } = vi.hoisted(() => ({
	targetConstructedContext: { value: 250_000 },
}));

vi.mock("$lib/server/config-store", () => ({
	getTargetConstructedContext: vi.fn(() => targetConstructedContext.value),
}));

type MockCondition =
	| { operator: "eq" | "inArray"; field: string; value: unknown }
	| MockCondition[]
	| null
	| undefined;

type MockOrder = { direction: "asc" | "desc"; field: string };
type MockShapeField = { kind?: string; name?: string };

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

function mapSelectedRows(
	rows: Array<Record<string, unknown>>,
	shape?: Record<string, MockShapeField>,
) {
	if (!shape) return rows;
	if (Object.values(shape).some((field) => field?.kind === "count")) {
		return [
			Object.fromEntries(
				Object.entries(shape).map(([alias, field]) => [
					alias,
					field?.kind === "count"
						? rows.length
						: rows[0]?.[field?.name ?? alias],
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

function createQuery(
	rows: Array<Record<string, unknown>>,
	shape?: Record<string, MockShapeField>,
) {
	let currentRows = [...rows];
	const chain = {
		from: () => chain,
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
		limit: async (limit: number) => {
			queryLimits.push(limit);
			return mapSelectedRows(currentRows.slice(0, limit), shape);
		},
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
		select: (shape?: Record<string, MockShapeField>) => ({
			from: (table: { __name?: string }) => {
				if (table?.__name === "messages") {
					return createQuery(messageRows, shape);
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
		type: { name: "artifactType" },
		retrievalClass: { name: "retrievalClass" },
		name: { name: "artifactName" },
		mimeType: { name: "mimeType" },
		sizeBytes: { name: "sizeBytes" },
		conversationId: { name: "artifactConversationId" },
		summary: { name: "artifactSummary" },
		metadataJson: { name: "metadataJson" },
		createdAt: { name: "artifactCreatedAt" },
		updatedAt: { name: "artifactUpdatedAt" },
		binaryHash: { name: "binaryHash" },
		extension: { name: "extension" },
		storagePath: { name: "storagePath" },
		contentText: { name: "contentText" },
	},
	artifactLinks: {
		__name: "artifactLinks",
		id: { name: "artifactLinkId" },
		userId: { name: "artifactLinkUserId" },
		artifactId: { name: "artifactId" },
		relatedArtifactId: { name: "relatedArtifactId" },
		conversationId: { name: "artifactLinkConversationId" },
		messageId: { name: "artifactLinkMessageId" },
		linkType: { name: "artifactLinkType" },
		createdAt: { name: "artifactLinkCreatedAt" },
	},
	conversations: {
		__name: "conversations",
		id: { name: "conversationId" },
		userId: { name: "conversationUserId" },
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
	desc: vi.fn((field: { name: string }) => ({
		direction: "desc",
		field: field.name,
	})),
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

import {
	findProjectFolderReferenceContextByQuery,
	getProjectReferenceContext,
} from "$lib/server/services/task-state";
import { getProjectContext } from "./project";

const mockGetProjectReferenceContext = getProjectReferenceContext as ReturnType<
	typeof vi.fn
>;
const mockFindProjectFolderReferenceContextByQuery =
	findProjectFolderReferenceContextByQuery as ReturnType<typeof vi.fn>;

describe("getProjectContext", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFindProjectFolderReferenceContextByQuery.mockResolvedValue(null);
		messageRows.splice(0, messageRows.length);
		queryLimits.splice(0, queryLimits.length);
		targetConstructedContext.value = 250_000;
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

	it("returns an explicit non-error result when no folder or continuity exists", async () => {
		mockGetProjectReferenceContext.mockResolvedValue(null);
		mockFindProjectFolderReferenceContextByQuery.mockResolvedValue(null);

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
				noProjectReason: "no_memory_context",
			},
		});
	});

	it("finds a named project folder from the query when the active chat is unrelated", async () => {
		mockGetProjectReferenceContext.mockResolvedValue(null);
		mockFindProjectFolderReferenceContextByQuery.mockResolvedValue({
			source: "project_folder",
			projectId: "folder-almalinux",
			projectName: "AlmaLinux Server",
			omittedSiblingCount: 0,
			entries: [
				{
					conversationId: "conv-alma-1",
					title: "AlmaLinux hardening notes",
					objective: "Document AlmaLinux Server deployment",
					summary: "Configured SSH, Cockpit, storage, and update policy.",
				},
			],
		});

		const result = await getProjectContext({
			userId: "user-1",
			conversationId: "conv-unrelated",
			mode: "summary",
			query:
				"Generate a detailed PDF report with the content from AlmaLinux Server project folder",
			includeEvidenceCandidates: true,
		});

		expect(mockFindProjectFolderReferenceContextByQuery).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-unrelated",
			query:
				"Generate a detailed PDF report with the content from AlmaLinux Server project folder",
		});
		expect(result).toMatchObject({
			success: true,
			mode: "report",
			hasProjectContext: true,
			source: "project_folder",
			project: {
				id: "folder-almalinux",
				name: "AlmaLinux Server",
				authority: "project_folder",
			},
			siblings: [
				{
					conversationId: "conv-alma-1",
					title: "AlmaLinux hardening notes",
					objective: "Document AlmaLinux Server deployment",
					summary: "Configured SSH, Cockpit, storage, and update policy.",
				},
			],
		});
		expect(result.reportSiblings).toEqual([
			expect.objectContaining({
				conversationId: "conv-alma-1",
				title: "AlmaLinux hardening notes",
			}),
		]);
		expect(result.evidenceCandidates).toEqual([
			expect.objectContaining({
				id: "memory-context:project-detail:conv-alma-1",
				title: "AlmaLinux hardening notes",
				sourceType: "memory",
			}),
		]);
	});

	it("scales summary sibling limits above the old fixed cap for medium context windows", async () => {
		targetConstructedContext.value = 250_000;
		const entries = Array.from({ length: 12 }, (_, index) => ({
			conversationId: `conv-${index + 2}`,
			title: `Sibling ${index + 1}`,
			objective: `Objective ${index + 1}`,
			summary: `Summary ${index + 1}`,
		}));
		mockGetProjectReferenceContext.mockResolvedValue({
			source: "project_folder",
			projectId: "project-1",
			projectName: "Launch Plan",
			omittedSiblingCount: 4,
			entries,
		});

		const result = await getProjectContext({
			userId: "user-1",
			conversationId: "conv-1",
			mode: "summary",
			maxSiblings: 999,
		});

		expect(result.audit.appliedMaxSiblings).toBe(8);
		expect(result.siblings).toHaveLength(8);
		expect(result.omittedSiblingCount).toBe(8);
	});

	it.each([
		["small", 50_000, 5],
		["large", 1_000_000, 16],
	])("applies the %s-context summary sibling cap and reports omissions", async (_label, targetContext, expectedLimit) => {
		targetConstructedContext.value = targetContext;
		const entries = Array.from({ length: 40 }, (_, index) => ({
			conversationId: `conv-${index + 2}`,
			title: `Sibling ${index + 1}`,
			objective: `Objective ${index + 1}`,
			summary: `Summary ${index + 1}`,
		}));
		mockGetProjectReferenceContext.mockResolvedValue({
			source: "project_folder",
			projectId: "project-1",
			projectName: "Launch Plan",
			omittedSiblingCount: 3,
			entries,
		});

		const result = await getProjectContext({
			userId: "user-1",
			conversationId: "conv-1",
			mode: "summary",
			maxSiblings: 999,
		});

		expect(result.audit.appliedMaxSiblings).toBe(expectedLimit);
		expect(result.siblings).toHaveLength(expectedLimit);
		expect(result.omittedSiblingCount).toBe(3 + entries.length - expectedLimit);
	});

	it("returns folder-wide report context with recent messages for bounded siblings", async () => {
		targetConstructedContext.value = 1_000_000;
		mockGetProjectReferenceContext.mockResolvedValue({
			source: "project_folder",
			projectId: "project-1",
			projectName: "AlmaLinux Server",
			omittedSiblingCount: 1,
			entries: [
				{
					conversationId: "conv-2",
					title: "SSH hardening",
					objective: "Lock down SSH access",
					summary: "Discussed SSH port, keys, and firewall policy.",
				},
				{
					conversationId: "conv-3",
					title: "Cockpit and updates",
					objective: "Set up admin UI and updates",
					summary: "Discussed Cockpit, dnf-automatic, and storage.",
				},
			],
		});
		messageRows.push(
			{
				conversationId: "conv-2",
				role: "user",
				content: "Use key-only SSH and disable password login.",
				createdAt: new Date("2026-05-14T09:01:00.000Z"),
			},
			{
				conversationId: "conv-2",
				role: "assistant",
				content: "Set PasswordAuthentication no and restart sshd.",
				createdAt: new Date("2026-05-14T09:02:00.000Z"),
			},
			{
				conversationId: "conv-3",
				role: "user",
				content: "Enable Cockpit and unattended security updates.",
				createdAt: new Date("2026-05-14T09:03:00.000Z"),
			},
			{
				conversationId: "conv-3",
				role: "assistant",
				content: "Use systemctl enable --now cockpit.socket.",
				createdAt: new Date("2026-05-14T09:04:00.000Z"),
			},
		);

		const result = await getProjectContext({
			userId: "user-1",
			conversationId: "conv-1",
			mode: "report",
			maxSiblings: 16,
			maxMessages: 4,
			includeEvidenceCandidates: true,
		});

		expect(result).toMatchObject({
			success: true,
			mode: "report",
			hasProjectContext: true,
			project: {
				name: "AlmaLinux Server",
			},
			omittedSiblingCount: 1,
			audit: {
				appliedMaxSiblings: 16,
				appliedMaxMessages: 4,
				reportConversationCount: 2,
			},
		});
		expect(result.reportSiblings).toEqual([
			expect.objectContaining({
				conversationId: "conv-2",
				title: "SSH hardening",
				messages: [
					expect.objectContaining({
						content: "Use key-only SSH and disable password login.",
					}),
					expect.objectContaining({
						content: "Set PasswordAuthentication no and restart sshd.",
					}),
				],
			}),
			expect.objectContaining({
				conversationId: "conv-3",
				title: "Cockpit and updates",
				messages: [
					expect.objectContaining({
						content: "Enable Cockpit and unattended security updates.",
					}),
					expect.objectContaining({
						content: "Use systemctl enable --now cockpit.socket.",
					}),
				],
			}),
		]);
		expect(result.evidenceCandidates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "memory-context:project-detail:conv-2",
					snippet: expect.stringContaining("PasswordAuthentication no"),
				}),
				expect.objectContaining({
					id: "memory-context:project-detail:conv-3",
					snippet: expect.stringContaining("cockpit.socket"),
				}),
			]),
		);
		expect(queryLimits).toEqual([4, 4]);
	});

	it("rejects unsupported modes clearly", async () => {
		await expect(
			getProjectContext({
				userId: "user-1",
				conversationId: "conv-1",
				mode: "full",
			}),
		).rejects.toThrow(/Unsupported memory_context mode/);
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
					id: "memory-context:project-detail:conv-2",
					title: "Pricing",
					sourceType: "memory",
				}),
			]),
		);
		expect(JSON.stringify(result)).not.toContain("hidden system prompt");
		expect(result.siblings).toEqual([]);
		expect(queryLimits).toEqual([2]);
	});

	it.each([
		["current conversation", "conv-1", /Current conversation is not a valid/],
		["other folder", "conv-other-folder", /outside memory_context scope/],
		["other user", "conv-other-user", /outside memory_context scope/],
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
		).rejects.toThrow(/outside memory_context scope/);
	});

	it("clamps detail messages to the hard cap", async () => {
		targetConstructedContext.value = 50_000;
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

	it("scales detail message limits above the old fixed cap for medium context windows", async () => {
		targetConstructedContext.value = 250_000;
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
		for (let index = 0; index < 20; index += 1) {
			messageRows.push({
				conversationId: "conv-2",
				role: index % 2 === 0 ? "user" : "assistant",
				content: `Message ${index}`,
				createdAt: new Date(2026, 4, 14, 10, index),
			});
		}

		const result = await getProjectContext({
			userId: "user-1",
			conversationId: "conv-1",
			mode: "detail",
			siblingConversationId: "conv-2",
			maxMessages: 999,
		});

		expect(result.audit.appliedMaxMessages).toBe(16);
		expect(result.selectedSibling?.messages).toHaveLength(16);
		expect(result.selectedSibling?.omittedMessageCount).toBe(4);
		expect(queryLimits).toEqual([16]);
	});

	it("scales detail message limits for large context windows and reports omissions", async () => {
		targetConstructedContext.value = 1_000_000;
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
		for (let index = 0; index < 70; index += 1) {
			messageRows.push({
				conversationId: "conv-2",
				role: index % 2 === 0 ? "user" : "assistant",
				content: `Message ${index}`,
				createdAt: new Date(2026, 4, 14, 11, index),
			});
		}

		const result = await getProjectContext({
			userId: "user-1",
			conversationId: "conv-1",
			mode: "detail",
			siblingConversationId: "conv-2",
			maxMessages: 999,
		});

		expect(result.audit.appliedMaxMessages).toBe(63);
		expect(result.selectedSibling?.messages).toHaveLength(63);
		expect(result.selectedSibling?.omittedMessageCount).toBe(7);
		expect(queryLimits).toEqual([63]);
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
				noProjectReason: "no_memory_context",
			},
		});
	});
});
