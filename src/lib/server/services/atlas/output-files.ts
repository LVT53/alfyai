// Atlas v3 is the only content pipeline left (Phase B of the v3-only
// consolidation). This module is what remains of the old `renderer-output.ts`
// after the v1 markdown-assembly and honesty-marker rendering machinery
// (`buildAtlasDocumentSource` and everything it called) was deleted with the
// rest of the v1 pipeline: the bridge that hands a `GeneratedDocumentSource`
// (already assembled by `atlas-v3/render.ts`) to File Production and waits
// for the HTML/PDF/Markdown sibling files it produces.
//
// The idempotency key below is kept byte-for-byte as `atlas-output:v2:` even
// though v2 is gone: a job resumed mid-flight after this rename must land on
// the SAME File Production job it already created, not fork a duplicate.
import { waitForFileProductionJobVerdict } from "$lib/server/services/file-production/job-wait";
import type { GeneratedDocumentSource } from "$lib/server/services/file-production/source-schema";
import type { FileProductionJob } from "$lib/server/services/file-production/types";

export interface AtlasOutputIds {
	fileProductionJobId: string | null;
	htmlChatGeneratedFileId: string | null;
	pdfChatGeneratedFileId: string | null;
	markdownChatGeneratedFileId: string | null;
}

export interface RenderAtlasOutputsInput {
	userId: string;
	conversationId: string;
	assistantMessageId: string | null;
	jobId: string;
	source: GeneratedDocumentSource;
	createOutputJob?: (input: {
		userId: string;
		conversationId: string;
		body: unknown;
	}) => Promise<AtlasOutputIds>;
}

const ATLAS_OUTPUT_JOB_POLL_INTERVAL_MS = 250;
const ATLAS_OUTPUT_JOB_POLL_TIMEOUT_MS = 120_000;

function atlasDocumentIntent(input: {
	jobId: string;
	source: GeneratedDocumentSource;
}): string {
	return ["Atlas research report", `atlas_job_id=${input.jobId}`]
		.filter((part): part is string => part !== null)
		.join("; ");
}

type ListConversationFileProductionJobs = (
	userId: string,
	conversationId: string,
) => Promise<FileProductionJob[]>;

async function findConversationFileProductionJob(input: {
	userId: string;
	conversationId: string;
	jobId: string;
	listConversationFileProductionJobs: ListConversationFileProductionJobs;
}): Promise<FileProductionJob | null> {
	const jobs = await input.listConversationFileProductionJobs(
		input.userId,
		input.conversationId,
	);
	return jobs.find((job) => job.id === input.jobId) ?? null;
}

// Atlas keeps its own timeout/interval and its own throw-on-unsettled
// contract (an Atlas run has no answer without its output files), but the
// polling loop itself is the shared one in file-production/job-wait.ts.
async function waitForAtlasOutputFileProductionJob(input: {
	userId: string;
	conversationId: string;
	jobId: string;
	listConversationFileProductionJobs: ListConversationFileProductionJobs;
}): Promise<FileProductionJob> {
	const verdict = await waitForFileProductionJobVerdict({
		getJob: () => findConversationFileProductionJob(input),
		timeoutMs: ATLAS_OUTPUT_JOB_POLL_TIMEOUT_MS,
		pollIntervalMs: ATLAS_OUTPUT_JOB_POLL_INTERVAL_MS,
	});
	if (verdict.settled) {
		return verdict.job;
	}

	throw new Error(
		verdict.job
			? `Atlas output files were not produced before the timeout; latest status was ${verdict.job.status}.`
			: "Atlas output files were not produced before the timeout; the output job was not found.",
	);
}

async function createFileProductionAtlasOutputJob(input: {
	userId: string;
	conversationId: string;
	body: unknown;
}): Promise<AtlasOutputIds> {
	const {
		drainFileProductionWorker,
		listConversationFileProductionJobs,
		submitFileProductionIntake,
	} = await import("$lib/server/services/file-production");
	const result = await submitFileProductionIntake({
		...input,
		wakeWorker: () => drainFileProductionWorker(),
	});
	if (!result.ok) {
		throw new Error(result.error);
	}
	const completedJob = await waitForAtlasOutputFileProductionJob({
		userId: input.userId,
		conversationId: input.conversationId,
		jobId: result.job.id,
		listConversationFileProductionJobs,
	});
	if (completedJob.status !== "succeeded") {
		throw new Error(
			completedJob.error?.message
				? `Atlas output files were not produced: ${completedJob.error.message}`
				: "Atlas output files were not produced.",
		);
	}
	const htmlChatGeneratedFileId =
		completedJob.files.find((file) => file.mimeType === "text/html")?.id ??
		null;
	const pdfChatGeneratedFileId =
		completedJob.files.find((file) => file.mimeType === "application/pdf")
			?.id ?? null;
	const markdownChatGeneratedFileId =
		completedJob.files.find((file) => file.mimeType === "text/markdown")?.id ??
		null;
	const missingOutputs = [
		htmlChatGeneratedFileId === null && "html",
		pdfChatGeneratedFileId === null && "pdf",
		markdownChatGeneratedFileId === null && "markdown",
	].filter(Boolean);
	if (missingOutputs.length > 0) {
		console.warn(
			`[ATLAS] File production job ${completedJob.id} succeeded but missing expected output types: ${missingOutputs.join(", ")}. Available files: ${completedJob.files.map((f) => f.mimeType).join(", ") || "none"}`,
		);
	}
	if (
		!htmlChatGeneratedFileId &&
		!pdfChatGeneratedFileId &&
		!markdownChatGeneratedFileId
	) {
		throw new Error(
			`Atlas output file production job ${completedJob.id} succeeded but produced no expected output files (HTML, PDF, Markdown). Available mime types: ${completedJob.files.map((f) => f.mimeType).join(", ") || "none"}.`,
		);
	}
	return {
		fileProductionJobId: completedJob.id,
		htmlChatGeneratedFileId,
		pdfChatGeneratedFileId,
		markdownChatGeneratedFileId,
	};
}

export async function renderAtlasOutputs(
	input: RenderAtlasOutputsInput,
): Promise<AtlasOutputIds> {
	const createOutputJob =
		input.createOutputJob ?? createFileProductionAtlasOutputJob;
	return createOutputJob({
		userId: input.userId,
		conversationId: input.conversationId,
		body: {
			conversationId: input.conversationId,
			assistantMessageId: input.assistantMessageId,
			idempotencyKey: `atlas-output:v2:${input.jobId}`,
			requestTitle: input.source.title,
			sourceMode: "document_source",
			requestedOutputs: [
				{ type: "html" },
				{ type: "pdf" },
				{ type: "markdown" },
			],
			documentIntent: atlasDocumentIntent({
				jobId: input.jobId,
				source: input.source,
			}),
			templateHint: "alfyai_standard_report",
			documentSource: input.source,
		},
	});
}
