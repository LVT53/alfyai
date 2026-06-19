import type { GeneratedDocumentSource } from "$lib/server/services/file-production/source-schema";
import type { AtlasDocumentFamilyMetadata, AtlasHonestyMarker } from "./types";

export interface BuildAtlasDocumentSourceInput {
	title: string;
	subtitle?: string | null;
	family?: AtlasDocumentFamilyMetadata | null;
	assembledMarkdown: string;
	sources: Array<{ title: string; url?: string | null }>;
	honestyMarkers: AtlasHonestyMarker[];
	date?: string | null;
}

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

function markdownLines(markdown: string): string[] {
	return markdown
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
}

export function buildAtlasDocumentSource(
	input: BuildAtlasDocumentSourceInput,
): GeneratedDocumentSource {
	const blocks: GeneratedDocumentSource["blocks"] = [];
	for (const line of markdownLines(input.assembledMarkdown)) {
		if (line.startsWith("# ")) {
			blocks.push({ type: "heading", level: 2, text: line.slice(2).trim() });
		} else if (line.startsWith("## ")) {
			blocks.push({ type: "heading", level: 2, text: line.slice(3).trim() });
		} else {
			blocks.push({ type: "paragraph", text: line.replace(/^[-*]\s+/, "") });
		}
	}

	if (input.sources.length > 0) {
		blocks.push({ type: "heading", level: 2, text: "Sources" });
		blocks.push({
			type: "list",
			style: "bullet",
			items: input.sources.map((source) =>
				source.url ? `${source.title} - ${source.url}` : source.title,
			),
		});
	}

	if (input.honestyMarkers.length > 0) {
		blocks.push({ type: "heading", level: 2, text: "Honesty markers" });
		for (const marker of input.honestyMarkers) {
			blocks.push({
				type: "callout",
				tone: marker.severity === "critical" ? "warning" : "info",
				title: marker.code,
				text: marker.message,
			});
		}
	}

	return {
		version: 1,
		template: "alfyai_standard_report",
		title: input.title,
		subtitle: input.subtitle ?? null,
		date: input.date ?? null,
		cover: input.family
			? {
					enabled: true,
					eyebrow: `Atlas ${input.family.mode} ${input.family.familyId}`,
				}
			: undefined,
		blocks,
	};
}

function atlasDocumentIntent(input: {
	jobId: string;
	source: GeneratedDocumentSource;
}): string {
	const coverEyebrow = input.source.cover?.eyebrow?.trim();
	return [
		"Atlas research report",
		`atlas_job_id=${input.jobId}`,
		coverEyebrow ? `atlas_source=${coverEyebrow}` : null,
	]
		.filter((part): part is string => part !== null)
		.join("; ");
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
	const jobs = await listConversationFileProductionJobs(
		input.userId,
		input.conversationId,
	);
	const completedJob = jobs.find((job) => job.id === result.job.id);
	if (!completedJob || completedJob.status !== "succeeded") {
		throw new Error("Atlas output files were not produced.");
	}
	return {
		fileProductionJobId: completedJob.id,
		htmlChatGeneratedFileId:
			completedJob.files.find((file) => file.mimeType === "text/html")?.id ??
			null,
		pdfChatGeneratedFileId:
			completedJob.files.find((file) => file.mimeType === "application/pdf")
				?.id ?? null,
		markdownChatGeneratedFileId:
			completedJob.files.find((file) => file.mimeType === "text/markdown")
				?.id ?? null,
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
			idempotencyKey: `atlas-output:${input.jobId}`,
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
			templateHint: input.source.cover?.eyebrow
				? `alfyai_standard_report:${input.source.cover.eyebrow}`
				: "alfyai_standard_report",
			documentSource: input.source,
		},
	});
}
