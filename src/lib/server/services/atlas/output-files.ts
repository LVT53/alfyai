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
import type { GeneratedDocumentSource } from "$lib/server/services/file-production/source-schema";

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

const ATLAS_OUTPUT_JOB_TIMEOUT_MS = 120_000;

function atlasDocumentIntent(input: {
	jobId: string;
	source: GeneratedDocumentSource;
}): string {
	return ["Atlas research report", `atlas_job_id=${input.jobId}`]
		.filter((part): part is string => part !== null)
		.join("; ");
}

async function createFileProductionAtlasOutputJob(input: {
	userId: string;
	conversationId: string;
	body: unknown;
}): Promise<AtlasOutputIds> {
	const { submitFileProductionIntake, waitForFileProductionJobVerdict } =
		await import("$lib/server/services/file-production");
	// The intake's enqueue wakes the file-production kind, which the job engine
	// runs on its own; this step only waits for the verdict.
	const result = await submitFileProductionIntake({
		userId: input.userId,
		body: input.body,
	});
	if (!result.ok) {
		throw new Error(result.error);
	}
	// Atlas keeps its own timeout and its own throw-on-unsettled contract (an Atlas
	// run has no answer without its output files); the wait itself is the file-
	// production kind's, on the job engine: it resolves the moment the job settles.
	const verdict = await waitForFileProductionJobVerdict({
		userId: input.userId,
		conversationId: input.conversationId,
		jobId: result.job.id,
		timeoutMs: ATLAS_OUTPUT_JOB_TIMEOUT_MS,
	});
	if (!verdict.settled) {
		throw new Error(
			verdict.job
				? `Atlas output files were not produced before the timeout; latest status was ${verdict.job.status}.`
				: "Atlas output files were not produced before the timeout; the output job was not found.",
		);
	}
	const completedJob = verdict.job;
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
