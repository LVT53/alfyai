import { marked } from "marked";
import type { GeneratedDocumentSource } from "$lib/server/services/file-production/source-schema";
import type { AtlasDocumentFamilyMetadata, AtlasHonestyMarker } from "./types";

export interface AtlasReportSource {
	title: string;
	url?: string | null;
	authority?: string | null;
	reasoning?: string | null;
}

export interface BuildAtlasDocumentSourceInput {
	title: string;
	subtitle?: string | null;
	family?: AtlasDocumentFamilyMetadata | null;
	assembledMarkdown: string;
	sources: AtlasReportSource[];
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

function addSourceSection(
	blocks: GeneratedDocumentSource["blocks"],
	title: string,
	sources: AtlasReportSource[],
) {
	if (sources.length === 0) return;
	blocks.push({
		type: "sourceChips",
		title,
		sources: sources.map((source) => {
			const isWeb = Boolean(source.url);
			const provided = source.authority === "explicit";
			return {
				title: source.title,
				url: source.url ?? null,
				kind: isWeb ? "web" : "library",
				provided,
				reasoning:
					source.reasoning ??
					(provided
						? "You provided these"
						: isWeb
							? "Accepted web evidence gathered by Atlas"
							: "Accepted library evidence selected by Atlas"),
			};
		}),
	});
}

function confidenceLabelForSeverity(
	severity: AtlasHonestyMarker["severity"],
): string {
	switch (severity) {
		case "critical":
			return "Unsupported";
		case "warning":
			return "Partially Supported";
		case "info":
			return "Supported";
	}
}

function cleanText(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.replace(/\s+/g, " ").trim();
	return trimmed.length > 0 ? trimmed : null;
}

function cleanCodeText(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trimEnd();
	return trimmed.trim().length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function inlineTextFromToken(token: unknown): string {
	if (!isRecord(token)) return "";
	if (Array.isArray(token.tokens)) {
		return inlineTextFromTokens(token.tokens);
	}
	if (token.type === "br") return " ";
	return typeof token.text === "string" ? token.text : "";
}

function inlineTextFromTokens(tokens: unknown[]): string {
	return tokens.map((token) => inlineTextFromToken(token)).join("");
}

function blockText(token: unknown): string | null {
	if (!isRecord(token)) return null;
	if (Array.isArray(token.tokens)) {
		return cleanText(inlineTextFromTokens(token.tokens));
	}
	return cleanText(token.text);
}

function makeColumnKey(
	label: string,
	index: number,
	usedKeys: Set<string>,
): string {
	const base =
		label
			.normalize("NFD")
			.replace(/[\u0300-\u036f]/g, "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "_")
			.replace(/^_+|_+$/g, "") || `col_${index + 1}`;
	let key = base;
	let suffix = 2;
	while (usedKeys.has(key)) {
		key = `${base}_${suffix}`;
		suffix += 1;
	}
	usedKeys.add(key);
	return key;
}

function appendMarkdownBlocks(
	blocks: GeneratedDocumentSource["blocks"],
	markdown: string,
) {
	const tokens = marked.lexer(markdown, { gfm: true });
	for (const token of tokens) {
		if (token.type === "space") continue;

		if (token.type === "heading") {
			const text = blockText(token);
			if (!text) continue;
			blocks.push({
				type: "heading",
				level: token.depth >= 3 ? 3 : 2,
				text,
			});
			continue;
		}

		if (token.type === "paragraph" || token.type === "text") {
			const text = blockText(token);
			if (text) blocks.push({ type: "paragraph", text });
			continue;
		}

		if (token.type === "list") {
			const listToken = token as {
				ordered?: boolean;
				items?: unknown[];
			};
			const items = (Array.isArray(listToken.items) ? listToken.items : [])
				.map((item) => blockText(item))
				.filter((item): item is string => Boolean(item));
			if (items.length > 0) {
				blocks.push({
					type: "list",
					style: listToken.ordered ? "numbered" : "bullet",
					items,
				});
			}
			continue;
		}

		if (token.type === "code") {
			const text = cleanCodeText(token.text);
			if (text) {
				blocks.push({
					type: "code",
					language: cleanText(token.lang)?.split(/\s+/)[0] ?? null,
					text,
				});
			}
			continue;
		}

		if (token.type === "blockquote") {
			const text = blockText(token);
			if (text) blocks.push({ type: "quote", text, citation: null });
			continue;
		}

		if (token.type === "table") {
			const tableToken = token as {
				header?: unknown[];
				rows?: unknown[][];
			};
			const usedKeys = new Set<string>();
			const columns = (
				Array.isArray(tableToken.header) ? tableToken.header : []
			)
				.map((cell, index) => {
					const label = blockText(cell);
					return label
						? {
								key: makeColumnKey(label, index, usedKeys),
								label,
								kind: "text" as const,
							}
						: null;
				})
				.filter((column): column is NonNullable<typeof column> =>
					Boolean(column),
				);
			const rows = (Array.isArray(tableToken.rows) ? tableToken.rows : [])
				.map((row) => {
					const record: Record<string, string | null> = {};
					for (const [index, column] of columns.entries()) {
						record[column.key] = blockText(row[index] ?? {}) ?? null;
					}
					return record;
				})
				.filter((row) => Object.values(row).some((value) => value !== null));
			if (columns.length > 0 && rows.length > 0) {
				blocks.push({ type: "table", columns, rows });
			}
			continue;
		}

		if (token.type === "hr") {
			blocks.push({ type: "divider" });
		}
	}
}

export function buildAtlasDocumentSource(
	input: BuildAtlasDocumentSourceInput,
): GeneratedDocumentSource {
	const blocks: GeneratedDocumentSource["blocks"] = [];
	appendMarkdownBlocks(blocks, input.assembledMarkdown);

	const librarySources = input.sources.filter((source) => !source.url);
	const webSources = input.sources.filter((source) => Boolean(source.url));
	if (webSources.length > 0 || librarySources.length > 0) {
		blocks.push({ type: "heading", level: 2, text: "Sources" });
	}
	addSourceSection(blocks, "Web Sources", webSources);
	addSourceSection(blocks, "Your Library", librarySources);

	if (input.honestyMarkers.length > 0) {
		blocks.push({ type: "heading", level: 2, text: "Honesty markers" });
		for (const marker of input.honestyMarkers) {
			blocks.push({
				type: "confidenceMarker",
				code: marker.code,
				label: confidenceLabelForSeverity(marker.severity),
				severity: marker.severity,
				message: marker.message,
			});
		}
	}

	return {
		version: 1,
		template: "alfyai_standard_report",
		title: input.title,
		subtitle: input.subtitle ?? null,
		date: input.date ?? null,
		cover:
			input.family || input.date
				? {
						enabled: true,
						eyebrow: input.date ? `Report date: ${input.date}` : "Report date",
						dateLabel: null,
					}
				: undefined,
		blocks,
	};
}

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
