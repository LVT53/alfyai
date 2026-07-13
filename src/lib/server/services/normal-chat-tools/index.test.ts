import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordParallelUsage } from "$lib/server/services/analytics";
import {
	hasLocalDistillEnabled,
	isCloudModel,
} from "$lib/server/services/connections/locality";
import { resolveContacts } from "$lib/server/services/connections/providers/contacts";
import { githubListRepos } from "$lib/server/services/connections/providers/github";
import {
	googleFreeBusy,
	googleListEvents,
} from "$lib/server/services/connections/providers/google-calendar";
import { immichSmartSearch } from "$lib/server/services/connections/providers/immich";
import {
	nextcloudReadFile,
	nextcloudSearch,
} from "$lib/server/services/connections/providers/nextcloud-files";
import {
	needsDisambiguation,
	resolveConnectionsForCapability,
} from "$lib/server/services/connections/resolve";
import type { ConnectionPublic } from "$lib/server/services/connections/store";
import { getConnectionSecret } from "$lib/server/services/connections/store";
import { submitFileProductionIntake } from "$lib/server/services/file-production";
import { searchImages } from "$lib/server/services/image-search";
import { getMemoryContext } from "$lib/server/services/memory-context";
import { fetchUrlViaParallel } from "$lib/server/services/parallel-search/fetch-url";
import { researchWebViaParallel } from "$lib/server/services/parallel-search/research";
import type { FileProductionJob } from "$lib/types";
import {
	createNormalChatTools,
	isProduceFileRequest,
	shouldForceProduceFileTool,
} from "./index";

vi.mock("$lib/server/services/file-production", () => ({
	submitFileProductionIntake: vi.fn(),
}));
vi.mock("$lib/server/services/analytics", () => ({
	recordParallelUsage: vi.fn(),
}));
vi.mock("$lib/server/services/parallel-search/research", () => ({
	researchWebViaParallel: vi.fn(),
}));
vi.mock("$lib/server/services/parallel-search/fetch-url", () => ({
	fetchUrlViaParallel: vi.fn(),
}));
vi.mock("$lib/server/services/memory-context", () => ({
	getMemoryContext: vi.fn(),
}));
vi.mock("$lib/server/services/image-search", () => ({
	searchImages: vi.fn(),
}));
vi.mock("$lib/server/config-store", () => ({
	getConfig: vi.fn(() => ({
		parallelApiKey: "parallel-key",
		parallelBaseUrl: "https://api.parallel.ai",
	})),
}));
vi.mock("$lib/server/services/connections/resolve", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/server/services/connections/resolve")
	>("$lib/server/services/connections/resolve");
	return {
		...actual,
		resolveConnectionsForCapability: vi.fn(),
		needsDisambiguation: vi.fn(),
	};
});
vi.mock("$lib/server/services/connections/store", () => ({
	getConnectionSecret: vi.fn(),
}));
vi.mock("$lib/server/services/connections/locality", () => ({
	hasLocalDistillEnabled: vi.fn(),
	isCloudModel: vi.fn(),
	distillConnectorPayload: vi.fn(),
}));
vi.mock("$lib/server/services/connections/providers/contacts", () => ({
	resolveContacts: vi.fn(),
}));
vi.mock("$lib/server/services/connections/providers/github", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/server/services/connections/providers/github")
	>("$lib/server/services/connections/providers/github");
	return {
		...actual,
		githubListRepos: vi.fn(),
	};
});
vi.mock(
	"$lib/server/services/connections/providers/nextcloud-files",
	async () => {
		const actual = await vi.importActual<
			typeof import("$lib/server/services/connections/providers/nextcloud-files")
		>("$lib/server/services/connections/providers/nextcloud-files");
		return {
			...actual,
			nextcloudSearch: vi.fn(),
			nextcloudReadFile: vi.fn(),
		};
	},
);
vi.mock(
	"$lib/server/services/connections/providers/google-calendar",
	async () => {
		const actual = await vi.importActual<
			typeof import("$lib/server/services/connections/providers/google-calendar")
		>("$lib/server/services/connections/providers/google-calendar");
		return {
			...actual,
			googleListEvents: vi.fn(),
			googleFreeBusy: vi.fn(),
		};
	},
);
vi.mock("$lib/server/services/connections/providers/immich", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/server/services/connections/providers/immich")
	>("$lib/server/services/connections/providers/immich");
	return {
		...actual,
		immichSmartSearch: vi.fn(),
	};
});

const submitFileProductionIntakeMock = vi.mocked(submitFileProductionIntake);
const recordParallelUsageMock = vi.mocked(recordParallelUsage);
const researchWebViaParallelMock = vi.mocked(researchWebViaParallel);
const fetchUrlViaParallelMock = vi.mocked(fetchUrlViaParallel);
const getMemoryContextMock = vi.mocked(getMemoryContext);
const searchImagesMock = vi.mocked(searchImages);
const resolveConnectionsForCapabilityMock = vi.mocked(
	resolveConnectionsForCapability,
);
const needsDisambiguationMock = vi.mocked(needsDisambiguation);
const getConnectionSecretMock = vi.mocked(getConnectionSecret);
const nextcloudSearchMock = vi.mocked(nextcloudSearch);
const nextcloudReadFileMock = vi.mocked(nextcloudReadFile);
const googleListEventsMock = vi.mocked(googleListEvents);
const googleFreeBusyMock = vi.mocked(googleFreeBusy);
const immichSmartSearchMock = vi.mocked(immichSmartSearch);
const hasLocalDistillEnabledMock = vi.mocked(hasLocalDistillEnabled);
const isCloudModelMock = vi.mocked(isCloudModel);
const resolveContactsMock = vi.mocked(resolveContacts);
const githubListReposMock = vi.mocked(githubListRepos);

function makeNextcloudConnection(
	overrides: Partial<ConnectionPublic> = {},
): ConnectionPublic {
	return {
		id: "conn-1",
		userId: "user-1",
		provider: "nextcloud",
		label: "Nextcloud",
		accountIdentifier: "alice",
		status: "connected",
		statusDetail: null,
		defaultOn: false,
		allowWrites: false,
		writeAllowlist: [],
		capabilities: ["files"],
		config: { serverUrl: "https://cloud.example.com", loginName: "alice" },
		oauthScopes: [],
		tokenExpiresAt: null,
		hasSecret: true,
		hasWriteSecret: false,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

function hasInstructions(
	result:
		| { instructions: string }
		| { success: false; error: string }
		| AsyncIterable<
				{ instructions: string } | { success: false; error: string }
		  >,
): result is { instructions: string } {
	return (
		typeof result === "object" && result !== null && "instructions" in result
	);
}

function makeFileProductionJob(
	overrides: Partial<FileProductionJob>,
): FileProductionJob {
	return {
		id: "job-1",
		conversationId: "conversation-1",
		assistantMessageId: null,
		title: "Generated file",
		status: "queued",
		createdAt: 1,
		updatedAt: 1,
		files: [],
		warnings: [],
		dismissed: false,
		error: null,
		...overrides,
	};
}

describe("createNormalChatTools", () => {
	type SubmitIntakeBodyShape = {
		body: {
			idempotencyKey?: string;
		};
	};

	beforeEach(() => {
		submitFileProductionIntakeMock.mockReset();
		recordParallelUsageMock.mockReset();
		recordParallelUsageMock.mockResolvedValue(undefined);
		researchWebViaParallelMock.mockReset();
		fetchUrlViaParallelMock.mockReset();
		getMemoryContextMock.mockReset();
		searchImagesMock.mockReset();
		resolveConnectionsForCapabilityMock.mockReset();
		needsDisambiguationMock.mockReset();
		getConnectionSecretMock.mockReset();
		nextcloudSearchMock.mockReset();
		nextcloudReadFileMock.mockReset();
		googleListEventsMock.mockReset();
		googleFreeBusyMock.mockReset();
		immichSmartSearchMock.mockReset();
		githubListReposMock.mockReset();
		hasLocalDistillEnabledMock.mockReset();
		isCloudModelMock.mockReset();
		needsDisambiguationMock.mockReturnValue(false);
		// Default: Option A off — the calendar/files distill gate short-circuits
		// via hasLocalDistillEnabled before touching the real DB.
		hasLocalDistillEnabledMock.mockResolvedValue(false);
		isCloudModelMock.mockResolvedValue(false);
	});

	it("submits produce_file intake with server-owned user, conversation, and turn idempotency scope", async () => {
		submitFileProductionIntakeMock.mockResolvedValue({
			ok: true,
			status: 202,
			reused: false,
			job: makeFileProductionJob({
				id: "job-123",
				title: "Quarterly CSV",
				status: "queued",
			}),
		});

		const { tools } = createNormalChatTools({
			userId: "user-1",
			conversationId: "conversation-1",
			turnId: "turn-1",
		});

		await tools.produce_file.execute(
			{
				idempotencyKey: "quarterly-csv",
				requestTitle: "Quarterly CSV",
				requestedOutputs: [{ type: "csv" }],
				sourceMode: "program",
				documentIntent: "data export",
				program: {
					language: "python",
					sourceCode:
						"from pathlib import Path\nPath('/output/report.csv').write_text('a,b')",
					filename: "report.csv",
				},
			},
			{
				toolCallId: "tool-call-123",
				messages: [],
			},
		);

		expect(submitFileProductionIntakeMock).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				signal: expect.any(AbortSignal),
				body: expect.objectContaining({
					conversationId: "conversation-1",
					idempotencyKey: expect.stringMatching(
						/^turn-1:produce_file:quarterly-csv:[a-f0-9]{12}$/,
					),
					requestTitle: "Quarterly CSV",
					requestedOutputs: [{ type: "csv" }],
					sourceMode: "program",
					documentIntent: "data export",
					program: {
						language: "python",
						sourceCode:
							"from pathlib import Path\nPath('/output/report.csv').write_text('a,b')",
						filename: "report.csv",
					},
				}),
			}),
		);
		const intakeCall = submitFileProductionIntakeMock.mock
			.calls[0] as unknown as SubmitIntakeBodyShape | undefined;
		const intakeBody = intakeCall?.body;
		expect(String(intakeBody?.idempotencyKey).length).toBeLessThanOrEqual(160);
	});

	it("normalizes document_source tool calls with the required source envelope", async () => {
		submitFileProductionIntakeMock.mockResolvedValue({
			ok: true,
			status: 202,
			reused: false,
			job: makeFileProductionJob({
				id: "job-doc",
				title: "Smoke PDF",
				status: "queued",
			}),
		});

		const { tools } = createNormalChatTools({
			userId: "user-1",
			conversationId: "conversation-1",
			turnId: "turn-1",
		});

		await tools.produce_file.execute(
			{
				requestTitle: "Smoke PDF",
				requestedOutputs: [{ type: "pdf" }],
				sourceMode: "document_source",
				documentSource: {
					blocks: [{ type: "paragraph", text: "Source body." }],
				},
			},
			{
				toolCallId: "tool-call-doc",
				messages: [],
			},
		);

		expect(submitFileProductionIntakeMock).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				body: expect.objectContaining({
					conversationId: "conversation-1",
					requestTitle: "Smoke PDF",
					sourceMode: "document_source",
					documentSource: {
						version: 1,
						template: "alfyai_standard_report",
						title: "Smoke PDF",
						blocks: [{ type: "paragraph", text: "Source body." }],
					},
				}),
			}),
		);
	});

	it("accepts simple markdown content without requiring program or documentSource", async () => {
		submitFileProductionIntakeMock.mockResolvedValue({
			ok: true,
			status: 202,
			reused: false,
			job: makeFileProductionJob({
				id: "job-markdown",
				title: "Hungarian Parliament News",
				status: "queued",
			}),
		});

		const { tools } = createNormalChatTools({
			userId: "user-1",
			conversationId: "conversation-1",
			turnId: "turn-1",
		});

		await tools.produce_file.execute(
			{
				requestTitle: "Hungarian Parliament News",
				filename: "hungarian-parliament-news.md",
				markdown:
					"# Latest News\n\n- Parliament passed new legislation on digital services with cross-party support.\n- Key provisions include data protection updates and cybersecurity requirements.\n- Sources cited at [example.com](https://example.com).",
			},
			{
				toolCallId: "tool-call-simple-md",
				messages: [],
			},
		);

		expect(submitFileProductionIntakeMock).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				body: expect.objectContaining({
					conversationId: "conversation-1",
					requestTitle: "Hungarian Parliament News",
					requestedOutputs: [{ type: "md" }],
					sourceMode: "program",
					documentIntent: "data export",
					program: expect.objectContaining({
						language: "python",
						filename: "hungarian-parliament-news.md",
						sourceCode: expect.stringContaining("Latest News"),
					}),
				}),
			}),
		);
	});

	it("rejects empty document_source tool calls instead of queuing placeholder reports", async () => {
		const { tools, getToolCalls } = createNormalChatTools({
			userId: "user-1",
			conversationId: "conversation-1",
			turnId: "turn-1",
		});

		const result = await tools.produce_file.execute(
			{
				requestTitle: "AlmaLinux Server report",
				requestedOutputs: [{ type: "pdf" }],
				sourceMode: "document_source",
				documentIntent:
					"Detailed long report from AlmaLinux Server project folder.",
				documentSource: {},
			},
			{
				toolCallId: "tool-call-empty-doc",
				messages: [],
			},
		);

		expect(submitFileProductionIntakeMock).not.toHaveBeenCalled();
		expect(result).toEqual({
			ok: false,
			status: 422,
			code: "invalid_tool_input",
			error:
				"documentSource must contain substantive content when sourceMode is document_source",
		});
		expect(getToolCalls()).toEqual([
			expect.objectContaining({
				callId: "tool-call-empty-doc",
				name: "produce_file",
				outputSummary: expect.stringContaining(
					"documentSource must contain substantive content",
				),
				metadata: expect.objectContaining({
					ok: false,
					evidenceReady: false,
					intakeStatus: 422,
					code: "invalid_tool_input",
				}),
			}),
		]);
	});

	it("returns a compact model payload after intake queues the job", async () => {
		submitFileProductionIntakeMock.mockResolvedValue({
			ok: true,
			status: 202,
			reused: true,
			job: makeFileProductionJob({
				id: "job-compact",
				title: "Compact payload",
				status: "running",
			}),
		});

		const { tools } = createNormalChatTools({
			userId: "user-1",
			conversationId: "conversation-1",
			turnId: "turn-1",
		});

		const result = await tools.produce_file.execute(
			{
				idempotencyKey: "compact",
				requestTitle: "Compact payload",
				requestedOutputs: [{ type: "txt" }],
				sourceMode: "program",
				program: {
					language: "python",
					sourceCode: "secret large source",
					filename: "compact.txt",
				},
			},
			{} as never,
		);

		expect(result).toEqual({
			ok: true,
			status: 202,
			jobId: "job-compact",
			jobStatus: "running",
			reused: true,
		});
		expect(JSON.stringify(result)).not.toContain("secret large source");
		expect(JSON.stringify(result)).not.toContain("requestJson");
	});

	it("deduplicates repeated same-turn produce_file calls for the same requested artifact", async () => {
		submitFileProductionIntakeMock.mockResolvedValue({
			ok: true,
			status: 202,
			reused: false,
			job: makeFileProductionJob({
				id: "job-deduped",
				title: "Forced Tool Smoke",
				status: "queued",
			}),
		});

		const { tools, getToolCalls } = createNormalChatTools({
			userId: "user-1",
			conversationId: "conversation-1",
			turnId: "turn-1",
		});
		const first = await tools.produce_file.execute(
			{
				requestTitle: "Forced Tool Smoke",
				requestedOutputs: [{ type: "pdf" }],
				sourceMode: "document_source",
				documentIntent: "report",
				documentSource: {
					blocks: [{ type: "paragraph", text: "First draft." }],
				},
			},
			{
				toolCallId: "call-first",
				messages: [],
			},
		);
		const second = await tools.produce_file.execute(
			{
				requestTitle: "Forced Tool Smoke",
				requestedOutputs: [{ type: "pdf" }],
				sourceMode: "document_source",
				documentIntent: "report",
				documentSource: {
					blocks: [{ type: "paragraph", text: "Second duplicate draft." }],
				},
			},
			{
				toolCallId: "call-second",
				messages: [],
			},
		);

		expect(submitFileProductionIntakeMock).toHaveBeenCalledTimes(1);
		expect(first).toEqual({
			ok: true,
			status: 202,
			jobId: "job-deduped",
			jobStatus: "queued",
			reused: false,
		});
		expect(second).toEqual({
			ok: true,
			status: 202,
			jobId: "job-deduped",
			jobStatus: "queued",
			reused: true,
		});
		expect(getToolCalls()).toEqual([
			expect.objectContaining({
				callId: "call-first",
				name: "produce_file",
				metadata: expect.objectContaining({
					jobId: "job-deduped",
					reused: false,
				}),
			}),
			expect.objectContaining({
				callId: "call-second",
				name: "produce_file",
				metadata: expect.objectContaining({
					jobId: "job-deduped",
					reused: true,
					dedupedSameTurn: true,
				}),
			}),
		]);
	});

	it("records a downstream-compatible ToolCallEntry for produce_file", async () => {
		submitFileProductionIntakeMock.mockResolvedValue({
			ok: true,
			status: 202,
			reused: false,
			job: makeFileProductionJob({
				id: "job-entry",
				title: "Entry payload",
				status: "queued",
			}),
		});
		const input = {
			idempotencyKey: "entry",
			requestTitle: "Entry payload",
			requestedOutputs: [{ type: "txt" }],
			sourceMode: "program" as const,
			documentIntent: "downloadable text",
			program: {
				language: "python" as const,
				sourceCode:
					"from pathlib import Path\nPath('/output/entry.txt').write_text('entry')",
				filename: "entry.txt",
			},
		};

		const { tools, getToolCalls } = createNormalChatTools({
			userId: "user-1",
			conversationId: "conversation-1",
			turnId: "turn-1",
		});

		await tools.produce_file.execute(input, {
			toolCallId: "call-entry",
			messages: [],
		});

		expect(getToolCalls()).toEqual([
			{
				callId: "call-entry",
				name: "produce_file",
				input: {
					idempotencyKey: "entry",
					requestTitle: "Entry payload",
					requestedOutputs: [{ type: "txt" }],
					sourceMode: "program",
					documentIntent: "downloadable text",
					program: {
						language: "python",
						filename: "entry.txt",
						sourceCodeHash: expect.stringMatching(/^[a-f0-9]{12}$/),
						sourceCodeLength: input.program.sourceCode.length,
					},
				},
				status: "done",
				outputSummary:
					"File production job job-entry queued with status queued.",
				sourceType: "tool",
				metadata: {
					ok: true,
					intakeStatus: 202,
					jobId: "job-entry",
					jobStatus: "queued",
					reused: false,
				},
			},
		]);
	});

	it("records failed intake responses as completed tool entries with failure metadata", async () => {
		submitFileProductionIntakeMock.mockResolvedValue({
			ok: false,
			status: 422,
			code: "missing_program_source",
			error: "program.sourceCode is required",
			job: makeFileProductionJob({
				id: "job-failed",
				title: "Failed payload",
				status: "failed",
				error: {
					code: "missing_program_source",
					message: "program.sourceCode is required",
					retryable: false,
				},
			}),
		});

		const { tools, getToolCalls } = createNormalChatTools({
			userId: "user-1",
			conversationId: "conversation-1",
			turnId: "turn-1",
		});

		const result = await tools.produce_file.execute(
			{
				idempotencyKey: "failed",
				requestTitle: "Failed payload",
				requestedOutputs: [{ type: "txt" }],
				sourceMode: "program",
				program: {
					language: "python",
					sourceCode: "will be rejected by mocked intake",
				},
			},
			{
				toolCallId: "call-failed",
				messages: [],
			},
		);

		expect(result).toEqual({
			ok: false,
			status: 422,
			code: "missing_program_source",
			error: "program.sourceCode is required",
			jobId: "job-failed",
			jobStatus: "failed",
		});
		expect(getToolCalls()[0]).toMatchObject({
			callId: "call-failed",
			name: "produce_file",
			status: "done",
			outputSummary:
				"File production intake failed for job job-failed: program.sourceCode is required",
			metadata: {
				ok: false,
				intakeStatus: 422,
				code: "missing_program_source",
				jobId: "job-failed",
				jobStatus: "failed",
			},
		});
	});

	it("does not record program source or document source in successful or failed tool calls", async () => {
		submitFileProductionIntakeMock
			.mockResolvedValueOnce({
				ok: true,
				status: 202,
				reused: false,
				job: makeFileProductionJob({
					id: "job-safe",
					title: "Safe payload",
					status: "queued",
				}),
			})
			.mockRejectedValueOnce(new Error("intake unavailable"));
		const { tools, getToolCalls } = createNormalChatTools({
			userId: "user-1",
			conversationId: "conversation-1",
			turnId: "turn-1",
		});

		await tools.produce_file.execute(
			{
				requestTitle: "Program payload",
				requestedOutputs: [{ type: "txt" }],
				sourceMode: "program",
				program: {
					language: "python",
					sourceCode: "SECRET_SOURCE = 'do not persist'",
					filename: "safe.txt",
				},
			},
			{
				toolCallId: "call-safe-program",
				messages: [],
			},
		);
		await tools.produce_file.execute(
			{
				requestTitle: "Document payload",
				requestedOutputs: [{ type: "pdf" }],
				sourceMode: "document_source",
				documentSource: {
					secret: "DO_NOT_PERSIST_DOCUMENT_SOURCE",
					sections: [{ body: "confidential" }],
				},
			},
			{
				toolCallId: "call-safe-document",
				messages: [],
			},
		);

		const serializedEntries = JSON.stringify(getToolCalls());
		expect(serializedEntries).not.toContain("SECRET_SOURCE");
		expect(serializedEntries).not.toContain("DO_NOT_PERSIST_DOCUMENT_SOURCE");
		expect(getToolCalls()[0]?.input).toMatchObject({
			requestTitle: "Program payload",
			sourceMode: "program",
			program: {
				language: "python",
				filename: "safe.txt",
				sourceCodeHash: expect.stringMatching(/^[a-f0-9]{12}$/),
				sourceCodeLength: "SECRET_SOURCE = 'do not persist'".length,
			},
		});
		expect(getToolCalls()[1]?.input).toMatchObject({
			requestTitle: "Document payload",
			sourceMode: "document_source",
			documentSource: {
				contentHash: expect.stringMatching(/^[a-f0-9]{12}$/),
				topLevelKeyCount: 6,
			},
		});
		expect(getToolCalls()[1]?.metadata).toMatchObject({
			ok: false,
			evidenceReady: false,
		});
	});

	it("research_web calls Parallel-backed web research and records compact web candidates", async () => {
		researchWebViaParallelMock.mockResolvedValue({
			query: "latest Vercel AI SDK tool API",
			queries: [{ query: "latest Vercel AI SDK tool API" }],
			sources: [
				{
					id: "p0",
					provider: "parallel",
					title: "AI SDK Tools",
					url: "https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling",
					snippet: "Tools are functions that can be called by the model.",
					highlights: ["Use inputSchema and execute."],
					providerRank: 0,
					publishedAt: null,
					updatedAt: null,
					authorityClass: "standard",
					authorityScore: 50,
				},
			],
			evidence: [
				{
					id: "p0e0",
					sourceId: "p0",
					title: "AI SDK Tools",
					url: "https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling",
					provider: "parallel",
					quote: "Use inputSchema and execute.",
					score: 1,
				},
			],
			answerBrief: {
				markdown: "Research brief with compact citation guidance.",
				instructions: ["Answer only from these sources."],
			},
			diagnostics: {
				mode: "turbo",
				freshness: "auto",
				sourcePolicy: "general",
				plannedQueryCount: 1,
				directUrlCount: 0,
				fetchedSourceCount: 1,
				fusedSourceCount: 1,
				selectedSourceCount: 1,
				openedPageCount: 0,
				pageExtraction: {
					attemptedCount: 0,
					succeededCount: 0,
					cacheHitCount: 0,
					lowQualityCount: 0,
					blockedCount: 0,
					failedCount: 0,
					totalLatencyMs: 0,
				},
				evidenceCandidateCount: 1,
				exactEvidenceCandidateCount: 0,
				reranked: false,
				sourceReranked: false,
				fallbackReasons: [],
			},
		});

		const { tools, getToolCalls } = createNormalChatTools({
			userId: "user-1",
			conversationId: "conversation-1",
			turnId: "turn-1",
		});

		const result = await tools.research_web.execute(
			{
				query: "latest Vercel AI SDK tool API",
			},
			{
				toolCallId: "call-research",
				messages: [],
			},
		);

		expect(researchWebViaParallelMock).toHaveBeenCalledWith(
			{
				query: "latest Vercel AI SDK tool API",
			},
			{
				fetch: expect.any(Function),
				config: {
					parallelApiKey: expect.any(String),
					parallelBaseUrl: expect.any(String),
				},
				signal: expect.any(AbortSignal),
			},
		);
		expect(result).toMatchObject({
			success: true,
			name: "research_web",
			sourceType: "web",
			query: "latest Vercel AI SDK tool API",
			answerBrief: {
				sourceCount: 1,
				evidenceCount: 1,
			},
			sources: [
				{
					id: "p0",
					title: "AI SDK Tools",
					url: "https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling",
				},
			],
			evidence: [
				{
					id: "p0e0",
					sourceId: "p0",
					quote: "Use inputSchema and execute.",
				},
			],
		});
		expect(getToolCalls()).toEqual([
			{
				callId: "call-research",
				name: "research_web",
				input: {
					query: "latest Vercel AI SDK tool API",
				},
				status: "done",
				outputSummary: "Web research returned 1 source and 1 evidence snippet.",
				sourceType: "web",
				candidates: [
					{
						id: "p0",
						title: "AI SDK Tools",
						url: "https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling",
						snippet: "Tools are functions that can be called by the model.",
						sourceType: "web",
						material: true,
						metadata: {
							provider: "parallel",
							authorityClass: "standard",
							authorityScore: 50,
							providerRank: 0,
						},
					},
				],
				metadata: {
					ok: true,
					evidenceReady: true,
					sourceCount: 1,
					evidenceCount: 1,
					mode: "turbo",
					freshness: "auto",
					sourcePolicy: "general",
					selectedSourceCount: 1,
					openedPageCount: 0,
					reranked: false,
					sourceReranked: false,
				},
			},
		]);
	});

	it("research_web reports empty Parallel results as not evidence-ready", async () => {
		const pastedUrl = "https://shop.example.com/products/widget-pro";
		researchWebViaParallelMock.mockResolvedValue({
			query: `What price is shown on ${pastedUrl}?`,
			queries: [{ query: `What price is shown on ${pastedUrl}?` }],
			sources: [],
			evidence: [],
			answerBrief: {
				markdown: "",
				instructions: ["Answer only from these sources."],
			},
			diagnostics: {
				mode: "turbo",
				freshness: "auto",
				sourcePolicy: "general",
				plannedQueryCount: 1,
				directUrlCount: 1,
				fetchedSourceCount: 0,
				fusedSourceCount: 0,
				selectedSourceCount: 0,
				openedPageCount: 0,
				pageExtraction: {
					attemptedCount: 0,
					succeededCount: 0,
					cacheHitCount: 0,
					lowQualityCount: 0,
					blockedCount: 0,
					failedCount: 0,
					totalLatencyMs: 0,
				},
				evidenceCandidateCount: 0,
				exactEvidenceCandidateCount: 0,
				reranked: false,
				sourceReranked: false,
				fallbackReasons: ["page_open_failed", "direct_url_open_failed"],
			},
		});

		const { tools, getToolCalls } = createNormalChatTools({
			userId: "user-1",
			conversationId: "conversation-1",
			turnId: "turn-1",
		});

		const result = await tools.research_web.execute(
			{
				query: `What price is shown on ${pastedUrl}?`,
			},
			{
				toolCallId: "call-research",
				messages: [],
			},
		);

		expect(result).toMatchObject({
			success: false,
			name: "research_web",
			sourceType: "web",
			answerBrief: {
				sourceCount: 0,
				evidenceCount: 0,
			},
			diagnostics: {
				directUrlCount: 1,
				openedPageCount: 0,
				fallbackReasons: ["page_open_failed", "direct_url_open_failed"],
			},
		});
		if (hasInstructions(result)) {
			expect(result.instructions).toContain(
				"No citation-ready evidence was returned",
			);
		}
		expect(getToolCalls()).toEqual([
			expect.objectContaining({
				callId: "call-research",
				name: "research_web",
				status: "done",
				sourceType: "web",
				candidates: [],
				metadata: expect.objectContaining({
					ok: true,
					evidenceReady: false,
					sourceCount: 0,
					evidenceCount: 0,
					selectedSourceCount: 0,
					openedPageCount: 0,
				}),
			}),
		]);
	});

	describe("Parallel API usage tracking", () => {
		function emptyGroundedWebResult(query: string) {
			return {
				query,
				queries: [{ query }],
				sources: [],
				evidence: [],
				answerBrief: {
					markdown: "",
					instructions: ["Answer only from these sources."],
				},
				diagnostics: {
					mode: "turbo" as const,
					freshness: "auto" as const,
					sourcePolicy: "general" as const,
					plannedQueryCount: 1,
					directUrlCount: 0,
					fetchedSourceCount: 0,
					fusedSourceCount: 0,
					selectedSourceCount: 0,
					openedPageCount: 0,
					pageExtraction: {
						attemptedCount: 0,
						succeededCount: 0,
						cacheHitCount: 0,
						lowQualityCount: 0,
						blockedCount: 0,
						failedCount: 0,
						totalLatencyMs: 0,
					},
					evidenceCandidateCount: 0,
					exactEvidenceCandidateCount: 0,
					reranked: false,
					sourceReranked: false,
					fallbackReasons: [],
				},
			};
		}

		it("records a Parallel Turbo usage event after a successful research_web call", async () => {
			researchWebViaParallelMock.mockResolvedValue(
				emptyGroundedWebResult("current docs"),
			);

			const { tools } = createNormalChatTools({
				userId: "user-1",
				conversationId: "conversation-1",
				turnId: "turn-1",
			});

			await tools.research_web.execute(
				{ query: "current docs" },
				{ toolCallId: "call-research-usage", messages: [] },
			);

			expect(recordParallelUsageMock).toHaveBeenCalledWith({
				userId: "user-1",
				conversationId: "conversation-1",
				tool: "research_web",
			});
		});

		it("records a Parallel Extract usage event after a successful fetch_url call", async () => {
			fetchUrlViaParallelMock.mockResolvedValue(
				emptyGroundedWebResult("https://example.com"),
			);

			const { tools } = createNormalChatTools({
				userId: "user-1",
				conversationId: "conversation-1",
				turnId: "turn-1",
			});

			await tools.fetch_url.execute(
				{ urls: ["https://example.com"] },
				{ toolCallId: "call-fetch-usage", messages: [] },
			);

			expect(recordParallelUsageMock).toHaveBeenCalledWith({
				userId: "user-1",
				conversationId: "conversation-1",
				tool: "fetch_url",
			});
		});

		it("does not record Parallel usage when the underlying call fails", async () => {
			researchWebViaParallelMock.mockRejectedValueOnce(
				new Error("research unavailable"),
			);

			const { tools } = createNormalChatTools({
				userId: "user-1",
				conversationId: "conversation-1",
				turnId: "turn-1",
			});

			await tools.research_web.execute(
				{ query: "current docs" },
				{ toolCallId: "call-research-usage-failed", messages: [] },
			);

			expect(recordParallelUsageMock).not.toHaveBeenCalled();
		});
	});

	it("exposes fetch_url unconditionally, without any enabled connection capabilities", () => {
		const { tools } = createNormalChatTools({
			userId: "user-1",
			conversationId: "conversation-1",
			turnId: "turn-1",
		});

		expect(tools).toHaveProperty("fetch_url");
	});

	it("fetch_url calls Parallel-backed page fetch and records compact web candidates", async () => {
		fetchUrlViaParallelMock.mockResolvedValue({
			query: "https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling",
			queries: [
				{ query: "https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling" },
			],
			sources: [
				{
					id: "p0",
					provider: "parallel",
					title: "AI SDK Tools",
					url: "https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling",
					snippet: "Tools are functions that can be called by the model.",
					highlights: ["Use inputSchema and execute."],
					providerRank: 0,
					publishedAt: null,
					updatedAt: null,
					authorityClass: "standard",
					authorityScore: 50,
				},
			],
			evidence: [
				{
					id: "p0e0",
					sourceId: "p0",
					title: "AI SDK Tools",
					url: "https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling",
					provider: "parallel",
					quote: "Use inputSchema and execute.",
					score: 1,
				},
			],
			answerBrief: {
				markdown: "Fetched page brief with compact citation guidance.",
				instructions: ["Answer only from these sources."],
			},
			diagnostics: {
				mode: "turbo",
				freshness: "auto",
				sourcePolicy: "general",
				plannedQueryCount: 1,
				directUrlCount: 1,
				fetchedSourceCount: 1,
				fusedSourceCount: 1,
				selectedSourceCount: 1,
				openedPageCount: 1,
				pageExtraction: {
					attemptedCount: 1,
					succeededCount: 1,
					cacheHitCount: 0,
					lowQualityCount: 0,
					blockedCount: 0,
					failedCount: 0,
					totalLatencyMs: 0,
				},
				evidenceCandidateCount: 1,
				exactEvidenceCandidateCount: 0,
				reranked: false,
				sourceReranked: false,
				fallbackReasons: [],
			},
		});

		const { tools, getToolCalls } = createNormalChatTools({
			userId: "user-1",
			conversationId: "conversation-1",
			turnId: "turn-1",
		});

		const result = await tools.fetch_url.execute(
			{
				urls: ["https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling"],
			},
			{
				toolCallId: "call-fetch",
				messages: [],
			},
		);

		expect(fetchUrlViaParallelMock).toHaveBeenCalledWith(
			{
				urls: ["https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling"],
			},
			{
				fetch: expect.any(Function),
				config: {
					parallelApiKey: expect.any(String),
					parallelBaseUrl: expect.any(String),
				},
				signal: expect.any(AbortSignal),
			},
		);
		// Reuses the shared grounded-web model payload builder, so the compact
		// payload carries the web-grounding envelope (name "research_web") while
		// the recorded tool-call entry below is the fetch_url-specific one.
		expect(result).toMatchObject({
			success: true,
			sourceType: "web",
			sources: [
				{
					id: "p0",
					title: "AI SDK Tools",
					url: "https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling",
				},
			],
			evidence: [
				{
					id: "p0e0",
					sourceId: "p0",
					quote: "Use inputSchema and execute.",
				},
			],
		});
		expect(getToolCalls()).toEqual([
			expect.objectContaining({
				callId: "call-fetch",
				name: "fetch_url",
				input: {
					urls: ["https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling"],
				},
				status: "done",
				sourceType: "web",
				candidates: [
					expect.objectContaining({
						id: "p0",
						title: "AI SDK Tools",
						url: "https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling",
						sourceType: "web",
					}),
				],
				metadata: expect.objectContaining({
					ok: true,
					evidenceReady: true,
					sourceCount: 1,
					evidenceCount: 1,
				}),
			}),
		]);
	});

	it("records fetch_url service failures without evidence-ready candidates", async () => {
		fetchUrlViaParallelMock.mockRejectedValueOnce(
			new Error("fetch unavailable"),
		);

		const { tools, getToolCalls } = createNormalChatTools({
			userId: "user-1",
			conversationId: "conversation-1",
			turnId: "turn-1",
		});

		await expect(
			tools.fetch_url.execute(
				{ urls: ["https://x.com"] },
				{ toolCallId: "call-fetch-failed", messages: [] },
			),
		).resolves.toEqual({
			success: false,
			error: "fetch unavailable",
		});

		expect(getToolCalls()).toEqual([
			expect.objectContaining({
				callId: "call-fetch-failed",
				name: "fetch_url",
				sourceType: "web",
				candidates: [],
				metadata: {
					ok: false,
					evidenceReady: false,
					error: "fetch unavailable",
				},
			}),
		]);
	});

	it("records aborted fetch_url executions without calling the downstream service", async () => {
		const abortController = new AbortController();
		abortController.abort(new Error("user cancelled"));
		const { tools, getToolCalls } = createNormalChatTools({
			userId: "user-1",
			conversationId: "conversation-1",
			turnId: "turn-1",
		});

		await expect(
			tools.fetch_url.execute(
				{ urls: ["https://x.com"] },
				{
					toolCallId: "call-fetch-aborted",
					messages: [],
					abortSignal: abortController.signal,
				},
			),
		).resolves.toEqual({
			success: false,
			error: "fetch_url aborted: user cancelled",
		});

		expect(fetchUrlViaParallelMock).not.toHaveBeenCalled();
		expect(getToolCalls()).toEqual([
			expect.objectContaining({
				callId: "call-fetch-aborted",
				name: "fetch_url",
				sourceType: "web",
				candidates: [],
				metadata: {
					ok: false,
					evidenceReady: false,
					error: "fetch_url aborted: user cancelled",
				},
			}),
		]);
	});

	it("memory_context calls memory service with server-owned scope and records bounded memory candidates", async () => {
		getMemoryContextMock.mockResolvedValue({
			success: true,
			mode: "project",
			projectMode: "summary",
			hasProjectContext: true,
			source: "project_folder",
			project: {
				id: "project-1",
				name: "Launch Folder",
				authority: "project_folder",
			},
			siblings: [
				{
					conversationId: "sibling-1",
					title: "Prior launch chat",
					objective: "Plan launch notes",
					summary: "Discussed launch constraints.",
				},
			],
			omittedSiblingCount: 2,
			selectedSibling: null,
			evidenceCandidates: [
				{
					id: "memory:sibling-1",
					title: "Prior launch chat",
					snippet: "Discussed launch constraints.",
					sourceType: "memory",
					material: true,
				},
				{
					id: "memory:sibling-2",
					title: "Older launch chat",
					snippet: "SHOULD BE OMITTED BY MAX SIBLINGS",
					sourceType: "memory",
				},
			],
			audit: {
				conversationId: "conversation-1",
				scope: "conversation",
				requestedMaxSiblings: 1,
				appliedMaxSiblings: 1,
				siblingConversationId: null,
				includeEvidenceCandidates: true,
			},
		});

		const { tools, getToolCalls } = createNormalChatTools({
			userId: "user-1",
			conversationId: "conversation-1",
			turnId: "turn-1",
		});

		const result = await tools.memory_context.execute(
			{
				mode: "project",
				query: "launch constraints",
				maxSiblings: 1,
				includeEvidenceCandidates: true,
			},
			{
				toolCallId: "call-memory",
				messages: [],
			},
		);

		expect(getMemoryContextMock).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conversation-1",
			mode: "project",
			query: "launch constraints",
			maxSiblings: 1,
			includeEvidenceCandidates: true,
		});
		expect(result).toMatchObject({
			success: true,
			name: "memory_context",
			sourceType: "memory",
			mode: "project",
			hasProjectContext: true,
			project: {
				id: "project-1",
				name: "Launch Folder",
			},
			omittedSiblingCount: 2,
			evidenceCandidates: [
				{
					id: "memory:sibling-1",
					title: "Prior launch chat",
					sourceType: "memory",
				},
			],
		});
		expect(JSON.stringify(result)).not.toContain(
			"SHOULD BE OMITTED BY MAX SIBLINGS",
		);
		expect(getToolCalls()).toEqual([
			{
				callId: "call-memory",
				name: "memory_context",
				input: {
					mode: "project",
					query: "launch constraints",
					maxSiblings: 1,
					includeEvidenceCandidates: true,
				},
				status: "done",
				outputSummary: "Project memory found: Launch Folder",
				sourceType: "memory",
				candidates: [
					{
						id: "memory:sibling-1",
						title: "Prior launch chat",
						snippet: "Discussed launch constraints.",
						sourceType: "memory",
						material: true,
					},
				],
				metadata: {
					ok: true,
					evidenceReady: true,
					mode: "project",
					status: null,
					hasProjectContext: true,
					omittedSiblingCount: 2,
					omittedConversationCount: 0,
					requestedMaxSiblings: 1,
					appliedMaxSiblings: 1,
				},
			},
		]);
	});

	it("image_search calls image search directly and records stable web candidates", async () => {
		searchImagesMock.mockResolvedValue([
			{
				url: "https://example.com/images/cat.png",
				title: "Reference cat",
				source: "example.com",
				thumbnail: "https://example.com/thumbs/cat.png",
				width: 1200,
				height: 800,
			},
			{
				url: "https://cdn.example.net/dog.jpg",
				title: "Reference dog",
				source: "cdn.example.net",
			},
		]);

		const { tools, getToolCalls } = createNormalChatTools({
			userId: "user-1",
			conversationId: "conversation-1",
			turnId: "turn-1",
		});

		const result = await tools.image_search.execute(
			{ query: "visual references for pets" },
			{
				toolCallId: "call-images",
				messages: [],
			},
		);

		expect(searchImagesMock).toHaveBeenCalledWith("visual references for pets");
		expect(result).toEqual({
			success: true,
			name: "image_search",
			sourceType: "web",
			message: "Found 2 images",
			results: [
				{
					id: "image-search:4eebfc739407",
					url: "https://example.com/images/cat.png",
					title: "Reference cat",
					source: "example.com",
					thumbnail: "https://example.com/thumbs/cat.png",
					width: 1200,
					height: 800,
				},
				{
					id: "image-search:b68acb105f16",
					url: "https://cdn.example.net/dog.jpg",
					title: "Reference dog",
					source: "cdn.example.net",
				},
			],
		});
		expect(getToolCalls()).toEqual([
			{
				callId: "call-images",
				name: "image_search",
				input: {
					query: "visual references for pets",
				},
				status: "done",
				outputSummary: "Found 2 images.",
				sourceType: "web",
				candidates: [
					{
						id: "image-search:4eebfc739407",
						title: "Reference cat",
						url: "https://example.com/images/cat.png",
						snippet: "example.com",
						sourceType: "web",
						metadata: {
							source: "example.com",
							thumbnail: "https://example.com/thumbs/cat.png",
							width: 1200,
							height: 800,
						},
					},
					{
						id: "image-search:b68acb105f16",
						title: "Reference dog",
						url: "https://cdn.example.net/dog.jpg",
						snippet: "cdn.example.net",
						sourceType: "web",
						metadata: {
							source: "cdn.example.net",
						},
					},
				],
				metadata: {
					ok: true,
					evidenceReady: true,
					resultCount: 2,
				},
			},
		]);
	});

	it("records new tool service failures without evidence-ready candidates", async () => {
		researchWebViaParallelMock.mockRejectedValueOnce(
			new Error("research unavailable"),
		);
		getMemoryContextMock.mockRejectedValueOnce(new Error("memory unavailable"));
		searchImagesMock.mockRejectedValueOnce(
			new Error("image search unavailable"),
		);

		const { tools, getToolCalls } = createNormalChatTools({
			userId: "user-1",
			conversationId: "conversation-1",
			turnId: "turn-1",
		});

		await expect(
			tools.research_web.execute(
				{ query: "current docs" },
				{ toolCallId: "call-research-failed", messages: [] },
			),
		).resolves.toEqual({
			success: false,
			error: "research unavailable",
		});
		await expect(
			tools.memory_context.execute(
				{ mode: "history", query: "old decision" },
				{ toolCallId: "call-memory-failed", messages: [] },
			),
		).resolves.toEqual({
			success: false,
			error: "memory unavailable",
		});
		await expect(
			tools.image_search.execute(
				{ query: "reference image" },
				{ toolCallId: "call-image-failed", messages: [] },
			),
		).resolves.toEqual({
			success: false,
			error: "image search unavailable",
		});

		expect(getToolCalls()).toEqual([
			expect.objectContaining({
				callId: "call-research-failed",
				name: "research_web",
				sourceType: "web",
				candidates: [],
				metadata: {
					ok: false,
					evidenceReady: false,
					error: "research unavailable",
				},
			}),
			expect.objectContaining({
				callId: "call-memory-failed",
				name: "memory_context",
				sourceType: "memory",
				candidates: [],
				metadata: {
					ok: false,
					evidenceReady: false,
					error: "memory unavailable",
				},
			}),
			expect.objectContaining({
				callId: "call-image-failed",
				name: "image_search",
				sourceType: "web",
				candidates: [],
				metadata: {
					ok: false,
					evidenceReady: false,
					error: "image search unavailable",
				},
			}),
		]);
	});

	it("records timed out tool executions through the shared envelope", async () => {
		vi.useFakeTimers();
		try {
			researchWebViaParallelMock.mockReturnValueOnce(
				new Promise(() => undefined),
			);
			const { tools, getToolCalls } = createNormalChatTools({
				userId: "user-1",
				conversationId: "conversation-1",
				turnId: "turn-1",
			});

			const resultPromise = tools.research_web.execute(
				{ query: "slow current docs" },
				{ toolCallId: "call-research-timeout", messages: [] },
			);

			await vi.advanceTimersByTimeAsync(60_000);

			await expect(resultPromise).resolves.toEqual({
				success: false,
				error: "research_web timed out after 60000ms",
			});
			expect(getToolCalls()).toEqual([
				expect.objectContaining({
					callId: "call-research-timeout",
					name: "research_web",
					sourceType: "web",
					candidates: [],
					metadata: {
						ok: false,
						evidenceReady: false,
						error: "research_web timed out after 60000ms",
					},
				}),
			]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("records aborted tool executions without calling the downstream service", async () => {
		const abortController = new AbortController();
		abortController.abort(new Error("user cancelled"));
		const { tools, getToolCalls } = createNormalChatTools({
			userId: "user-1",
			conversationId: "conversation-1",
			turnId: "turn-1",
		});

		await expect(
			tools.research_web.execute(
				{ query: "cancelled current docs" },
				{
					toolCallId: "call-research-aborted",
					messages: [],
					abortSignal: abortController.signal,
				},
			),
		).resolves.toEqual({
			success: false,
			error: "research_web aborted: user cancelled",
		});

		expect(researchWebViaParallelMock).not.toHaveBeenCalled();
		expect(getToolCalls()).toEqual([
			expect.objectContaining({
				callId: "call-research-aborted",
				name: "research_web",
				sourceType: "web",
				candidates: [],
				metadata: {
					ok: false,
					evidenceReady: false,
					error: "research_web aborted: user cancelled",
				},
			}),
		]);
	});

	describe("files tool gating", () => {
		it("does not include the files tool when enabledConnectionCapabilities is omitted", () => {
			const { tools } = createNormalChatTools({
				userId: "user-1",
				conversationId: "conversation-1",
				turnId: "turn-1",
			});

			expect(tools).not.toHaveProperty("files");
		});

		it("does not include the files tool when enabledConnectionCapabilities lacks 'files'", () => {
			const { tools } = createNormalChatTools({
				userId: "user-1",
				conversationId: "conversation-1",
				turnId: "turn-1",
				enabledConnectionCapabilities: new Set(["calendar"]),
			});

			expect(tools).not.toHaveProperty("files");
		});

		it("includes the files tool when enabledConnectionCapabilities contains 'files'", () => {
			const { tools } = createNormalChatTools({
				userId: "user-1",
				conversationId: "conversation-1",
				turnId: "turn-1",
				enabledConnectionCapabilities: new Set(["files"]),
			});

			expect(tools).toHaveProperty("files");
		});
	});

	describe("files tool execute", () => {
		function createToolsWithFiles() {
			return createNormalChatTools({
				userId: "user-1",
				conversationId: "conversation-1",
				turnId: "turn-1",
				enabledConnectionCapabilities: new Set(["files"]),
			});
		}

		it("search returns results and citations", async () => {
			const conn = makeNextcloudConnection();
			resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
			getConnectionSecretMock.mockResolvedValue("secret");
			nextcloudSearchMock.mockResolvedValue([
				{
					name: "report.pdf",
					path: "Documents/report.pdf",
					isDir: false,
					size: 4096,
					mtime: null,
					contentType: "application/pdf",
					etag: "etag-1",
				},
			]);

			const { tools, getToolCalls } = createToolsWithFiles();
			const result = await tools.files?.execute?.(
				{ action: "search", query: "report" },
				{ toolCallId: "call-files-search", messages: [] },
			);

			expect(result).toMatchObject({
				success: true,
				citations: [
					{
						label: "report.pdf",
						path: "Documents/report.pdf",
						url: expect.stringContaining("cloud.example.com"),
					},
				],
			});
			expect(getToolCalls()).toEqual([
				expect.objectContaining({
					callId: "call-files-search",
					name: "files",
					sourceType: "document",
					candidates: [
						expect.objectContaining({
							id: "files:Documents/report.pdf",
							title: "report.pdf",
						}),
					],
				}),
			]);
		});

		it("degrades gracefully with a note when there is no Files connection, without throwing", async () => {
			resolveConnectionsForCapabilityMock.mockResolvedValue([]);

			const { tools, getToolCalls } = createToolsWithFiles();
			const result = await tools.files?.execute?.(
				{ action: "search", query: "report" },
				{ toolCallId: "call-files-none", messages: [] },
			);

			expect(result).toMatchObject({ success: false });
			expect((result as { message: string }).message).toContain(
				"don't have a Files connection",
			);
			expect(getToolCalls()[0]).toMatchObject({
				callId: "call-files-none",
				name: "files",
				metadata: expect.objectContaining({ ok: false }),
			});
		});

		it("surfaces ambiguity when more than one Files connection is available", async () => {
			const connA = makeNextcloudConnection({
				id: "conn-a",
				label: "Alice Nextcloud",
			});
			const connB = makeNextcloudConnection({
				id: "conn-b",
				label: "Bob Nextcloud",
			});
			resolveConnectionsForCapabilityMock.mockResolvedValue([connA, connB]);
			needsDisambiguationMock.mockReturnValue(true);
			getConnectionSecretMock.mockResolvedValue("secret");
			nextcloudSearchMock.mockResolvedValue([]);

			const { tools } = createToolsWithFiles();
			const result = await tools.files?.execute?.(
				{ action: "search", query: "report" },
				{ toolCallId: "call-files-ambiguous", messages: [] },
			);

			expect((result as { message: string }).message).toContain(
				"2 Files connections",
			);
		});
	});

	describe("calendar tool gating", () => {
		it("does not include the calendar tool when enabledConnectionCapabilities is omitted", () => {
			const { tools } = createNormalChatTools({
				userId: "user-1",
				conversationId: "conversation-1",
				turnId: "turn-1",
			});

			expect(tools).not.toHaveProperty("calendar");
		});

		it("does not include the calendar tool when enabledConnectionCapabilities lacks 'calendar'", () => {
			const { tools } = createNormalChatTools({
				userId: "user-1",
				conversationId: "conversation-1",
				turnId: "turn-1",
				enabledConnectionCapabilities: new Set(["files"]),
			});

			expect(tools).not.toHaveProperty("calendar");
		});

		it("includes the calendar tool when enabledConnectionCapabilities contains 'calendar'", () => {
			const { tools } = createNormalChatTools({
				userId: "user-1",
				conversationId: "conversation-1",
				turnId: "turn-1",
				enabledConnectionCapabilities: new Set(["calendar"]),
			});

			expect(tools).toHaveProperty("calendar");
		});
	});

	describe("calendar tool execute", () => {
		function makeGoogleConnection(
			overrides: Partial<ConnectionPublic> = {},
		): ConnectionPublic {
			return {
				id: "conn-1",
				userId: "user-1",
				provider: "google",
				label: "Google",
				accountIdentifier: "alice@example.com",
				status: "connected",
				statusDetail: null,
				defaultOn: false,
				allowWrites: false,
				writeAllowlist: [],
				capabilities: ["calendar"],
				config: {},
				oauthScopes: [],
				tokenExpiresAt: null,
				hasSecret: true,
				hasWriteSecret: false,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				...overrides,
			};
		}

		function createToolsWithCalendar() {
			return createNormalChatTools({
				userId: "user-1",
				conversationId: "conversation-1",
				turnId: "turn-1",
				enabledConnectionCapabilities: new Set(["calendar"]),
			});
		}

		it("list_events returns events and citations", async () => {
			const conn = makeGoogleConnection();
			resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
			googleListEventsMock.mockResolvedValue([
				{
					id: "evt-1",
					summary: "Standup",
					start: "2026-07-09T09:00:00-04:00",
					end: "2026-07-09T09:30:00-04:00",
					htmlLink: "https://calendar.google.com/event?eid=evt-1",
				},
			]);

			const { tools, getToolCalls } = createToolsWithCalendar();
			const result = await tools.calendar?.execute?.(
				{ action: "list_events" },
				{ toolCallId: "call-calendar-list", messages: [] },
			);

			expect(result).toMatchObject({
				success: true,
				citations: [
					{
						label: "Standup",
						url: "https://calendar.google.com/event?eid=evt-1",
					},
				],
			});
			expect(getToolCalls()).toEqual([
				expect.objectContaining({
					callId: "call-calendar-list",
					name: "calendar",
					sourceType: "tool",
					candidates: [
						expect.objectContaining({
							id: "calendar:https://calendar.google.com/event?eid=evt-1",
							title: "Standup",
						}),
					],
				}),
			]);
		});

		it("degrades gracefully with a note when there is no Calendar connection, without throwing", async () => {
			resolveConnectionsForCapabilityMock.mockResolvedValue([]);

			const { tools, getToolCalls } = createToolsWithCalendar();
			const result = await tools.calendar?.execute?.(
				{ action: "list_events" },
				{ toolCallId: "call-calendar-none", messages: [] },
			);

			expect(result).toMatchObject({ success: false });
			expect((result as { message: string }).message).toContain(
				"don't have a Calendar connection",
			);
			expect(getToolCalls()[0]).toMatchObject({
				callId: "call-calendar-none",
				name: "calendar",
				metadata: expect.objectContaining({ ok: false }),
			});
		});

		it("surfaces ambiguity when more than one Calendar connection is available", async () => {
			const connA = makeGoogleConnection({
				id: "conn-a",
				label: "Alice Google",
			});
			const connB = makeGoogleConnection({ id: "conn-b", label: "Bob Google" });
			resolveConnectionsForCapabilityMock.mockResolvedValue([connA, connB]);
			needsDisambiguationMock.mockReturnValue(true);
			googleListEventsMock.mockResolvedValue([]);

			const { tools } = createToolsWithCalendar();
			const result = await tools.calendar?.execute?.(
				{ action: "list_events" },
				{ toolCallId: "call-calendar-ambiguous", messages: [] },
			);

			expect((result as { message: string }).message).toContain(
				"2 Calendar connections",
			);
		});

		it("check_availability summarizes free/busy", async () => {
			const conn = makeGoogleConnection();
			resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
			googleFreeBusyMock.mockResolvedValue([
				{ calendarId: "primary", busy: [] },
			]);

			const { tools } = createToolsWithCalendar();
			const result = await tools.calendar?.execute?.(
				{ action: "check_availability" },
				{ toolCallId: "call-calendar-freebusy", messages: [] },
			);

			expect(result).toMatchObject({
				success: true,
				action: "check_availability",
				busy: [{ calendarId: "primary", busy: [] }],
			});
		});
	});

	describe("photos tool gating", () => {
		it("does not include the photos tool when enabledConnectionCapabilities is omitted", () => {
			const { tools } = createNormalChatTools({
				userId: "user-1",
				conversationId: "conversation-1",
				turnId: "turn-1",
			});

			expect(tools).not.toHaveProperty("photos");
		});

		it("does not include the photos tool when enabledConnectionCapabilities lacks 'photos'", () => {
			const { tools } = createNormalChatTools({
				userId: "user-1",
				conversationId: "conversation-1",
				turnId: "turn-1",
				enabledConnectionCapabilities: new Set(["calendar"]),
			});

			expect(tools).not.toHaveProperty("photos");
		});

		it("includes the photos tool when enabledConnectionCapabilities contains 'photos'", () => {
			const { tools } = createNormalChatTools({
				userId: "user-1",
				conversationId: "conversation-1",
				turnId: "turn-1",
				enabledConnectionCapabilities: new Set(["photos"]),
			});

			expect(tools).toHaveProperty("photos");
		});
	});

	describe("photos tool execute", () => {
		function makeImmichConnection(
			overrides: Partial<ConnectionPublic> = {},
		): ConnectionPublic {
			return {
				id: "conn-1",
				userId: "user-1",
				provider: "immich",
				label: "Immich",
				accountIdentifier: "alice@example.com",
				status: "connected",
				statusDetail: null,
				defaultOn: false,
				allowWrites: false,
				writeAllowlist: [],
				capabilities: ["photos"],
				config: {
					origin: "https://photos.example.com",
					immichUserId: "user-1",
				},
				oauthScopes: [],
				tokenExpiresAt: null,
				hasSecret: true,
				hasWriteSecret: false,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				...overrides,
			};
		}

		function createToolsWithPhotos() {
			return createNormalChatTools({
				userId: "user-1",
				conversationId: "conversation-1",
				turnId: "turn-1",
				enabledConnectionCapabilities: new Set(["photos"]),
			});
		}

		it("search returns results and citations", async () => {
			const conn = makeImmichConnection();
			resolveConnectionsForCapabilityMock.mockResolvedValue([conn]);
			immichSmartSearchMock.mockResolvedValue([
				{
					id: "asset-1",
					fileName: "beach.jpg",
					takenAt: "2026-06-01T09:55:00.000Z",
					type: "IMAGE",
					thumbnailPath: "/api/assets/asset-1/thumbnail",
				},
			]);

			const { tools, getToolCalls } = createToolsWithPhotos();
			const result = await tools.photos?.execute?.(
				{ action: "search", query: "beach" },
				{ toolCallId: "call-photos-search", messages: [] },
			);

			expect(result).toMatchObject({
				success: true,
				citations: [{ label: "beach.jpg", url: "" }],
			});
			expect(getToolCalls()).toEqual([
				expect.objectContaining({
					callId: "call-photos-search",
					name: "photos",
					sourceType: "tool",
					candidates: [
						expect.objectContaining({
							id: "photos:asset-1",
							title: "beach.jpg",
						}),
					],
				}),
			]);
		});

		it("degrades gracefully with a note when there is no Photos connection, without throwing", async () => {
			resolveConnectionsForCapabilityMock.mockResolvedValue([]);

			const { tools, getToolCalls } = createToolsWithPhotos();
			const result = await tools.photos?.execute?.(
				{ action: "search", query: "beach" },
				{ toolCallId: "call-photos-none", messages: [] },
			);

			expect(result).toMatchObject({ success: false });
			expect((result as { message: string }).message).toContain(
				"don't have a Photos connection",
			);
			expect(getToolCalls()[0]).toMatchObject({
				callId: "call-photos-none",
				name: "photos",
				metadata: expect.objectContaining({ ok: false }),
			});
		});

		it("surfaces ambiguity when more than one Photos connection is available", async () => {
			const connA = makeImmichConnection({
				id: "conn-a",
				label: "Alice Immich",
			});
			const connB = makeImmichConnection({ id: "conn-b", label: "Bob Immich" });
			resolveConnectionsForCapabilityMock.mockResolvedValue([connA, connB]);
			needsDisambiguationMock.mockReturnValue(true);
			immichSmartSearchMock.mockResolvedValue([]);

			const { tools } = createToolsWithPhotos();
			const result = await tools.photos?.execute?.(
				{ action: "search", query: "beach" },
				{ toolCallId: "call-photos-ambiguous", messages: [] },
			);

			expect((result as { message: string }).message).toContain(
				"2 Photos connections",
			);
		});
	});

	describe("location tool gating", () => {
		it("does not include the location tool when enabledConnectionCapabilities is omitted", () => {
			const { tools } = createNormalChatTools({
				userId: "user-1",
				conversationId: "conversation-1",
				turnId: "turn-1",
			});

			expect(tools).not.toHaveProperty("location");
		});

		it("does not include the location tool when enabledConnectionCapabilities lacks 'location'", () => {
			const { tools } = createNormalChatTools({
				userId: "user-1",
				conversationId: "conversation-1",
				turnId: "turn-1",
				enabledConnectionCapabilities: new Set(["photos"]),
			});

			expect(tools).not.toHaveProperty("location");
		});

		it("includes the location tool when enabledConnectionCapabilities contains 'location'", () => {
			const { tools } = createNormalChatTools({
				userId: "user-1",
				conversationId: "conversation-1",
				turnId: "turn-1",
				enabledConnectionCapabilities: new Set(["location"]),
			});

			expect(tools).toHaveProperty("location");
		});

		it("degrades gracefully with a note when there is no Location connection, without throwing", async () => {
			resolveConnectionsForCapabilityMock.mockResolvedValue([]);

			const { tools, getToolCalls } = createNormalChatTools({
				userId: "user-1",
				conversationId: "conversation-1",
				turnId: "turn-1",
				enabledConnectionCapabilities: new Set(["location"]),
			});
			const result = await tools.location?.execute?.(
				{ action: "last" },
				{ toolCallId: "call-location-none", messages: [] },
			);

			expect(result).toMatchObject({ success: false });
			expect((result as { message: string }).message).toContain(
				"don't have a Location connection",
			);
			expect(getToolCalls()[0]).toMatchObject({
				callId: "call-location-none",
				name: "location",
				metadata: expect.objectContaining({ ok: false }),
			});
		});
	});

	describe("contacts tool gating", () => {
		it("does not include the contacts tool when enabledConnectionCapabilities is omitted", () => {
			const { tools } = createNormalChatTools({
				userId: "user-1",
				conversationId: "conversation-1",
				turnId: "turn-1",
			});

			expect(tools).not.toHaveProperty("contacts");
		});

		it("does not include the contacts tool when enabledConnectionCapabilities lacks 'contacts'", () => {
			const { tools } = createNormalChatTools({
				userId: "user-1",
				conversationId: "conversation-1",
				turnId: "turn-1",
				enabledConnectionCapabilities: new Set(["calendar"]),
			});

			expect(tools).not.toHaveProperty("contacts");
		});

		it("includes the contacts tool when enabledConnectionCapabilities contains 'contacts'", () => {
			const { tools } = createNormalChatTools({
				userId: "user-1",
				conversationId: "conversation-1",
				turnId: "turn-1",
				enabledConnectionCapabilities: new Set(["contacts"]),
			});

			expect(tools).toHaveProperty("contacts");
		});
	});

	describe("contacts tool execute", () => {
		function createToolsWithContacts() {
			return createNormalChatTools({
				userId: "user-1",
				conversationId: "conversation-1",
				turnId: "turn-1",
				enabledConnectionCapabilities: new Set(["contacts"]),
			});
		}

		it("lookup returns the single matching contact and its citation", async () => {
			resolveConnectionsForCapabilityMock.mockResolvedValue([
				makeNextcloudConnection({
					provider: "google",
					capabilities: ["contacts"],
				}),
			]);
			resolveContactsMock.mockResolvedValue([
				{
					name: "Zsombor Kovács",
					emails: ["zsombor@example.com"],
					phones: [],
					source: "google",
					account: "alice@example.com",
				},
			]);

			const { tools, getToolCalls } = createToolsWithContacts();
			const result = await tools.contacts?.execute?.(
				{ action: "lookup", query: "Zsombor" },
				{ toolCallId: "call-contacts-lookup", messages: [] },
			);

			expect(result).toMatchObject({
				success: true,
				contacts: [
					expect.objectContaining({
						name: "Zsombor Kovács",
						emails: ["zsombor@example.com"],
					}),
				],
				citations: [{ label: "Zsombor Kovács", url: "" }],
			});
			expect(getToolCalls()).toEqual([
				expect.objectContaining({
					callId: "call-contacts-lookup",
					name: "contacts",
					sourceType: "tool",
					candidates: [expect.objectContaining({ title: "Zsombor Kovács" })],
				}),
			]);
		});

		it("degrades gracefully with a note when there is no Contacts connection, without throwing", async () => {
			resolveConnectionsForCapabilityMock.mockResolvedValue([]);

			const { tools, getToolCalls } = createToolsWithContacts();
			const result = await tools.contacts?.execute?.(
				{ action: "lookup", query: "Zsombor" },
				{ toolCallId: "call-contacts-none", messages: [] },
			);

			expect(result).toMatchObject({ success: false });
			expect((result as { message: string }).message).toContain(
				"don't have a Contacts-capable connection",
			);
			expect(getToolCalls()[0]).toMatchObject({
				callId: "call-contacts-none",
				name: "contacts",
				metadata: expect.objectContaining({ ok: false }),
			});
		});

		it("surfaces disambiguation when more than one distinct person matches", async () => {
			resolveConnectionsForCapabilityMock.mockResolvedValue([
				makeNextcloudConnection({
					provider: "google",
					capabilities: ["contacts"],
				}),
			]);
			resolveContactsMock.mockResolvedValue([
				{
					name: "Zsombor Kovács",
					emails: ["zsombor.k@example.com"],
					phones: [],
					source: "google",
				},
				{
					name: "Zsombor Nagy",
					emails: ["zsombor.n@example.com"],
					phones: [],
					source: "google",
				},
			]);

			const { tools } = createToolsWithContacts();
			const result = await tools.contacts?.execute?.(
				{ action: "lookup", query: "Zsombor" },
				{ toolCallId: "call-contacts-ambiguous", messages: [] },
			);

			expect((result as { message: string }).message).toContain(
				"2 matching contacts",
			);
		});
	});

	describe("repos tool gating", () => {
		it("does not include the repos tool when enabledConnectionCapabilities is omitted", () => {
			const { tools } = createNormalChatTools({
				userId: "user-1",
				conversationId: "conversation-1",
				turnId: "turn-1",
			});

			expect(tools).not.toHaveProperty("repos");
		});

		it("does not include the repos tool when enabledConnectionCapabilities lacks 'repos'", () => {
			const { tools } = createNormalChatTools({
				userId: "user-1",
				conversationId: "conversation-1",
				turnId: "turn-1",
				enabledConnectionCapabilities: new Set(["calendar"]),
			});

			expect(tools).not.toHaveProperty("repos");
		});

		it("includes the repos tool only when there is a connected github connection with 'repos' enabled", () => {
			const { tools } = createNormalChatTools({
				userId: "user-1",
				conversationId: "conversation-1",
				turnId: "turn-1",
				enabledConnectionCapabilities: new Set(["repos"]),
			});

			expect(tools).toHaveProperty("repos");
		});
	});

	describe("repos tool execute", () => {
		function makeGitHubConnection(
			overrides: Partial<ConnectionPublic> = {},
		): ConnectionPublic {
			return {
				id: "conn-1",
				userId: "user-1",
				provider: "github",
				label: "GitHub",
				accountIdentifier: "octocat",
				status: "connected",
				statusDetail: null,
				defaultOn: false,
				allowWrites: false,
				writeAllowlist: [],
				capabilities: ["repos"],
				config: { baseUrl: "https://api.github.com" },
				oauthScopes: [],
				tokenExpiresAt: null,
				hasSecret: true,
				hasWriteSecret: false,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				...overrides,
			};
		}

		function createToolsWithRepos() {
			return createNormalChatTools({
				userId: "user-1",
				conversationId: "conversation-1",
				turnId: "turn-1",
				enabledConnectionCapabilities: new Set(["repos"]),
			});
		}

		it("list_repos returns repos and citations", async () => {
			resolveConnectionsForCapabilityMock.mockResolvedValue([
				makeGitHubConnection(),
			]);
			githubListReposMock.mockResolvedValue([
				{
					name: "alfyai",
					fullName: "octocat/alfyai",
					private: true,
					url: "https://github.com/octocat/alfyai",
					defaultBranch: "main",
					fork: false,
				},
			]);

			const { tools, getToolCalls } = createToolsWithRepos();
			const result = await tools.repos?.execute?.(
				{ action: "list_repos" },
				{ toolCallId: "call-repos-list", messages: [] },
			);

			expect(result).toMatchObject({
				success: true,
				repos: [expect.objectContaining({ fullName: "octocat/alfyai" })],
			});
			expect(getToolCalls()).toEqual([
				expect.objectContaining({
					callId: "call-repos-list",
					name: "repos",
					sourceType: "tool",
					candidates: [
						expect.objectContaining({
							url: "https://github.com/octocat/alfyai",
						}),
					],
				}),
			]);
		});

		it("degrades gracefully with a note when there is no Repositories connection, without throwing", async () => {
			resolveConnectionsForCapabilityMock.mockResolvedValue([]);

			const { tools, getToolCalls } = createToolsWithRepos();
			const result = await tools.repos?.execute?.(
				{ action: "list_repos" },
				{ toolCallId: "call-repos-none", messages: [] },
			);

			expect(result).toMatchObject({ success: false });
			expect((result as { message: string }).message).toContain(
				"don't have a Repositories connection",
			);
			expect(getToolCalls()[0]).toMatchObject({
				callId: "call-repos-none",
				name: "repos",
				metadata: expect.objectContaining({ ok: false }),
			});
		});

		it("surfaces ambiguity when more than one Repositories connection is available", async () => {
			const connA = makeGitHubConnection({
				id: "conn-a",
				label: "Alice GitHub",
			});
			const connB = makeGitHubConnection({ id: "conn-b", label: "Bob GitHub" });
			resolveConnectionsForCapabilityMock.mockResolvedValue([connA, connB]);
			needsDisambiguationMock.mockReturnValue(true);
			githubListReposMock.mockResolvedValue([]);

			const { tools } = createToolsWithRepos();
			const result = await tools.repos?.execute?.(
				{ action: "list_repos" },
				{ toolCallId: "call-repos-ambiguous", messages: [] },
			);

			expect((result as { message: string }).message).toContain(
				"2 Repositories connections",
			);
		});
	});

	describe("connection write guidance in tool descriptions (Redesign R8)", () => {
		it.each([
			{
				lang: "en" as const,
				tool: "files",
				writeSubstring: "save",
				confirmSubstring: "propos",
				enableSubstring: "enabled writes",
			},
			{
				lang: "en" as const,
				tool: "email",
				writeSubstring: "send",
				confirmSubstring: "propos",
				enableSubstring: "enabled writes",
			},
			{
				lang: "en" as const,
				tool: "photos",
				writeSubstring: "add photos to",
				confirmSubstring: "propos",
				enableSubstring: "enabled writes",
			},
			{
				lang: "hu" as const,
				tool: "files",
				writeSubstring: "mentés",
				confirmSubstring: "javasol",
				enableSubstring: "engedélyezve kell lennie",
			},
			{
				lang: "hu" as const,
				tool: "email",
				writeSubstring: "küldés",
				confirmSubstring: "javasol",
				enableSubstring: "engedélyezve kell lennie",
			},
			{
				lang: "hu" as const,
				tool: "photos",
				writeSubstring: "album",
				confirmSubstring: "javasol",
				enableSubstring: "engedélyezve kell lennie",
			},
		])("$lang $tool description mentions its write action, confirm-required proposal, and enable-writes gating", ({
			lang,
			tool,
			writeSubstring,
			confirmSubstring,
			enableSubstring,
		}) => {
			const { tools } = createNormalChatTools({
				userId: "user-1",
				conversationId: "conversation-1",
				turnId: "turn-1",
				language: lang,
				enabledConnectionCapabilities: new Set(["files", "email", "photos"]),
			});

			const description = (
				tools as unknown as Record<string, { description: string }>
			)[tool].description;

			expect(description.toLowerCase()).toContain(writeSubstring.toLowerCase());
			expect(description.toLowerCase()).toContain(
				confirmSubstring.toLowerCase(),
			);
			expect(description.toLowerCase()).toContain(
				enableSubstring.toLowerCase(),
			);
		});

		it("email description warns a sent email cannot be unsent (en)", () => {
			const { tools } = createNormalChatTools({
				userId: "user-1",
				conversationId: "conversation-1",
				turnId: "turn-1",
				enabledConnectionCapabilities: new Set(["email"]),
			});

			expect(tools.email?.description).toContain("cannot be unsent");
		});

		it("email description warns a sent email cannot be unsent (hu)", () => {
			const { tools } = createNormalChatTools({
				userId: "user-1",
				conversationId: "conversation-1",
				turnId: "turn-1",
				language: "hu",
				enabledConnectionCapabilities: new Set(["email"]),
			});

			expect(tools.email?.description).toContain("nem lehet visszavonni");
		});

		it("photos description says originals are never deleted or modified (en)", () => {
			const { tools } = createNormalChatTools({
				userId: "user-1",
				conversationId: "conversation-1",
				turnId: "turn-1",
				enabledConnectionCapabilities: new Set(["photos"]),
			});

			expect(tools.photos?.description).toContain("never deletes or modifies");
		});

		it("photos description says originals are never deleted or modified (hu)", () => {
			const { tools } = createNormalChatTools({
				userId: "user-1",
				conversationId: "conversation-1",
				turnId: "turn-1",
				language: "hu",
				enabledConnectionCapabilities: new Set(["photos"]),
			});

			expect(tools.photos?.description).toContain(
				"soha nem törli és nem módosítja",
			);
		});
	});
});

describe("shouldForceProduceFileTool", () => {
	it.each([
		"Please create a downloadable PDF report for me.",
		"Generate a CSV file with the cleaned rows.",
		"Export this as an XLSX spreadsheet.",
		"Make me a slide deck in PPTX format.",
		"Summarize this into a DOCX document.",
	])("detects explicit file-production request: %s", (message) => {
		expect(shouldForceProduceFileTool(message)).toBe(true);
	});

	it.each([
		"Explain how PDF generation works.",
		"How do I create a CSV file myself?",
		"Summarize this in chat, no file needed.",
		"Tell me whether a spreadsheet would help.",
		"Create a brief answer about quarterly planning.",
	])("does not force file production for informational requests: %s", (message) => {
		expect(shouldForceProduceFileTool(message)).toBe(false);
	});

	it.each([
		"Could you please generate a pdf report with the content from AlmaLinux Server project folder? I want it to be detailed and long.",
		"Create a PDF report from the current project folder.",
		"Generate a DOCX using the uploaded documents.",
		"Make a report based on our memory context.",
	])("leaves tool choice automatic for context-dependent file requests: %s", (message) => {
		expect(shouldForceProduceFileTool(message)).toBe(false);
	});

	it.each([
		"Could you please generate a pdf report with the content from AlmaLinux Server project folder? I want it to be detailed and long.",
		"Create a PDF report from the current project folder.",
		"Generate a DOCX using the uploaded documents.",
	])("still recognizes context-dependent requests with explicit file targets: %s", (message) => {
		expect(isProduceFileRequest(message)).toBe(true);
	});
});
