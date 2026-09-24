import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GeneratedDocumentSource } from "$lib/server/services/file-production/source-schema";
import type { FileProductionJob } from "$lib/server/services/file-production/types";

// Bridge coverage for what survived the v1/v2 deletion (Phase B of the
// v3-only consolidation): `renderAtlasOutputs` no longer builds the
// `GeneratedDocumentSource` itself (that is now `atlas-v3/render.ts`'s job),
// it only hands an already-assembled one to File Production and waits for
// the HTML/PDF/Markdown sibling files. Ported from the old
// `atlas/output.test.ts` lines 47-100 and 2631-2750.

const fileProductionMocks = vi.hoisted(() => ({
	drainFileProductionWorker: vi.fn(async () => undefined),
	listConversationFileProductionJobs: vi.fn(),
	submitFileProductionIntake: vi.fn(),
}));

vi.mock("$lib/server/services/file-production", () => ({
	drainFileProductionWorker: fileProductionMocks.drainFileProductionWorker,
	listConversationFileProductionJobs:
		fileProductionMocks.listConversationFileProductionJobs,
	submitFileProductionIntake: fileProductionMocks.submitFileProductionIntake,
}));

function fileProductionJob(
	overrides: Partial<FileProductionJob> = {},
): FileProductionJob {
	return {
		id: "fp-job-1",
		conversationId: "conv-1",
		assistantMessageId: "assistant-1",
		title: "Atlas Report",
		status: "running",
		stage: null,
		createdAt: 1,
		updatedAt: 1,
		files: [],
		warnings: [],
		dismissed: false,
		error: null,
		sourceMode: null,
		...overrides,
	};
}

function documentSource(
	overrides: Partial<GeneratedDocumentSource> = {},
): GeneratedDocumentSource {
	return {
		version: 1,
		template: "alfyai_standard_report",
		title: "Enterprise Search Atlas",
		blocks: [
			{ type: "heading", level: 1, text: "Executive summary" },
			{
				type: "paragraph",
				text: "Search should combine local authority and web freshness.",
			},
		],
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("Atlas output files bridge", () => {
	it("delegates HTML/PDF/Markdown sibling storage to file production with the byte-identical idempotency key", async () => {
		const { renderAtlasOutputs } = await import("./output-files");
		const source = documentSource();
		const createOutputJob = vi.fn(async () => ({
			fileProductionJobId: "fp-job-1",
			htmlChatGeneratedFileId: "file-html",
			pdfChatGeneratedFileId: "file-pdf",
			markdownChatGeneratedFileId: "file-md",
		}));

		const outputs = await renderAtlasOutputs({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			jobId: "atlas-job-1",
			source,
			createOutputJob,
		});

		expect(createOutputJob).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				body: expect.objectContaining({
					conversationId: "conv-1",
					assistantMessageId: "assistant-1",
					idempotencyKey: "atlas-output:v2:atlas-job-1",
					requestTitle: "Enterprise Search Atlas",
					sourceMode: "document_source",
					requestedOutputs: [
						{ type: "html" },
						{ type: "pdf" },
						{ type: "markdown" },
					],
					documentIntent: "Atlas research report; atlas_job_id=atlas-job-1",
					templateHint: "alfyai_standard_report",
					documentSource: source,
				}),
			}),
		);
		expect(outputs).toEqual({
			fileProductionJobId: "fp-job-1",
			htmlChatGeneratedFileId: "file-html",
			pdfChatGeneratedFileId: "file-pdf",
			markdownChatGeneratedFileId: "file-md",
		});
	});

	it("waits for an asynchronously claimed file-production output job before returning file ids", async () => {
		vi.useFakeTimers();
		vi.setTimerTickMode("nextTimerAsync");
		const { renderAtlasOutputs } = await import("./output-files");
		const source = documentSource({
			title: "Async Atlas Output",
			blocks: [
				{ type: "heading", level: 2, text: "Executive Summary" },
				{
					type: "paragraph",
					text: "Atlas output should wait.",
				},
			],
		});
		const runningJob = fileProductionJob({
			id: "fp-job-async",
			status: "running",
			files: [],
		});
		const succeededJob = fileProductionJob({
			id: "fp-job-async",
			status: "succeeded",
			files: [
				{
					id: "file-html",
					filename: "atlas.html",
					mimeType: "text/html",
					sizeBytes: 12,
					downloadUrl: "/download/html",
					previewUrl: "/preview/html",
				},
				{
					id: "file-pdf",
					filename: "atlas.pdf",
					mimeType: "application/pdf",
					sizeBytes: 12,
					downloadUrl: "/download/pdf",
					previewUrl: "/preview/pdf",
				},
				{
					id: "file-md",
					filename: "atlas.md",
					mimeType: "text/markdown",
					sizeBytes: 12,
					downloadUrl: "/download/md",
					previewUrl: null,
				},
			],
		});
		fileProductionMocks.submitFileProductionIntake.mockResolvedValue({
			ok: true,
			status: 202,
			job: runningJob,
			reused: false,
		});
		fileProductionMocks.listConversationFileProductionJobs
			.mockResolvedValueOnce([runningJob])
			.mockResolvedValueOnce([succeededJob]);

		const outputs = await renderAtlasOutputs({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			jobId: "atlas-job-async",
			source,
		});

		expect(outputs).toEqual({
			fileProductionJobId: "fp-job-async",
			htmlChatGeneratedFileId: "file-html",
			pdfChatGeneratedFileId: "file-pdf",
			markdownChatGeneratedFileId: "file-md",
		});
	});

	it("persists Atlas lifecycle document intent through request metadata", async () => {
		const { renderAtlasOutputs } = await import("./output-files");
		const source = documentSource({
			title: "Continued Atlas",
			subtitle: "in-depth Atlas report",
			cover: { enabled: true, eyebrow: "Report date", dateLabel: null },
			blocks: [
				{
					type: "paragraph",
					text: "Continued findings.",
				},
			],
		});
		const createOutputJob = vi.fn(async () => ({
			fileProductionJobId: "fp-job-1",
			htmlChatGeneratedFileId: "file-html",
			pdfChatGeneratedFileId: "file-pdf",
			markdownChatGeneratedFileId: "file-md",
		}));

		await renderAtlasOutputs({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			jobId: "atlas-child-1",
			source,
			createOutputJob,
		});

		expect(createOutputJob).toHaveBeenCalledWith(
			expect.objectContaining({
				body: expect.objectContaining({
					documentIntent: "Atlas research report; atlas_job_id=atlas-child-1",
					templateHint: "alfyai_standard_report",
					documentSource: source,
				}),
			}),
		);
	});

	it("surfaces a File Production failure instead of returning partial output ids", async () => {
		const { renderAtlasOutputs } = await import("./output-files");
		const source = documentSource();
		const failedJob = fileProductionJob({
			id: "fp-job-failed",
			status: "failed",
			error: {
				code: "render_failed",
				message: "Renderer crashed",
				retryable: false,
			},
		});
		fileProductionMocks.submitFileProductionIntake.mockResolvedValue({
			ok: true,
			status: 202,
			job: fileProductionJob({ id: "fp-job-failed", status: "running" }),
			reused: false,
		});
		fileProductionMocks.listConversationFileProductionJobs.mockResolvedValue([
			failedJob,
		]);

		await expect(
			renderAtlasOutputs({
				userId: "user-1",
				conversationId: "conv-1",
				assistantMessageId: "assistant-1",
				jobId: "atlas-job-failed",
				source,
			}),
		).rejects.toThrow(/Renderer crashed/);
	});
});
