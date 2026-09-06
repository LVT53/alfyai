import { z } from "zod";

import type { FileProductionIntakeResult } from "$lib/server/services/file-production";
import type { ToolCallEntry } from "$lib/server/services/messages-types";
import {
	type AsciiBarChart,
	barFillLength,
	hasBarChars,
	isBarOnlyCell,
	legendPerBlock,
	parseAsciiBarChart,
	parseNumericCell,
	pickBarMatchedColumn,
	sameChartCategories,
} from "$lib/services/ascii-bar-chart";

import { isRecord, shortHash, stableStringify } from "./shared";

// ── Input schema ───────────────────────────────────────────────

export const requestedOutputSchema = z.object({
	type: z.string().min(1),
});

export const produceFileInputSchema = z
	.object({
		idempotencyKey: z.string().min(1).optional(),
		requestTitle: z.string().min(1).optional(),
		title: z.string().min(1).optional(),
		requestedOutputs: z.array(requestedOutputSchema).min(1).optional(),
		outputs: z.array(requestedOutputSchema).min(1).optional(),
		outputType: z.string().min(1).optional(),
		fileType: z.string().min(1).optional(),
		filename: z.string().min(1).optional(),
		sourceMode: z.enum(["program", "document_source"]).optional(),
		documentIntent: z.string().min(1).optional(),
		templateHint: z.string().min(1).optional(),
		content: z.string().min(1).optional(),
		markdown: z.string().min(1).optional(),
		text: z.string().min(1).optional(),
		patches: z
			.array(
				z.object({
					oldText: z.string().min(1),
					newText: z.string(),
				}),
			)
			.min(1)
			.optional(),
		program: z
			.object({
				language: z.enum(["python", "javascript"]),
				sourceCode: z.string().min(1),
				filename: z.string().min(1).optional(),
			})
			.optional(),
		documentSource: z.record(z.string(), z.unknown()).optional(),
	})
	.passthrough();

// ── Types ──────────────────────────────────────────────────────

export type ProduceFileInput = z.infer<typeof produceFileInputSchema>;
export type NormalizedProduceFileInput = {
	idempotencyKey?: string;
	requestTitle: string;
	requestedOutputs: Array<{ type: string }>;
	sourceMode: "program" | "document_source";
	documentIntent?: string;
	templateHint?: string;
	patches?: Array<{ oldText: string; newText: string }>;
	program?: {
		language: "python" | "javascript";
		sourceCode: string;
		filename?: string;
	};
	documentSource?: Record<string, unknown>;
};
export type SafeProduceFileInput = Record<string, unknown>;

// ── File production detection ──────────────────────────────────

const FILE_PRODUCTION_ACTION_RE =
	/\b(create|make|generate|prepare|produce|build|write|export|convert|save|download|summari[sz]e)\b/i;
const FILE_PRODUCTION_TARGET_RE =
	/\b(downloadable|download|file|pdf|docx?|xlsx?|csv|pptx?|powerpoint|spreadsheet|excel|word document|slide deck|presentation|html|markdown|md|txt|json|zip|archive)\b|\.[a-z0-9]{2,5}\b/i;
const FILE_PRODUCTION_NEGATION_RE =
	/\b(no file needed|no downloadable file|without (?:a )?(?:file|download)|do not (?:create|make|generate|produce|export|download).*file|don't (?:create|make|generate|produce|export|download).*file)\b/i;
const INFORMATIONAL_FILE_QUESTION_RE = /^\s*(how|what|why|when|where|who)\b/i;
const REQUEST_FOR_ME_RE = /\b(for me|please|can you|could you|would you)\b/i;
const CONTEXT_DEPENDENT_FILE_SOURCE_RE =
	/\b(content from|project folder|folder|workspace|knowledge|memory|context|attached|uploaded|current document|existing document|library|notes?)\b/i;

export function isProduceFileRequest(message: string): boolean {
	const text = message.trim();
	if (!text) return false;
	if (FILE_PRODUCTION_NEGATION_RE.test(text)) return false;
	if (!FILE_PRODUCTION_ACTION_RE.test(text)) return false;
	if (!FILE_PRODUCTION_TARGET_RE.test(text)) return false;
	if (
		INFORMATIONAL_FILE_QUESTION_RE.test(text) &&
		!REQUEST_FOR_ME_RE.test(text)
	) {
		return false;
	}
	return true;
}

export function shouldForceProduceFileTool(message: string): boolean {
	const text = message.trim();
	if (!isProduceFileRequest(text)) return false;
	if (CONTEXT_DEPENDENT_FILE_SOURCE_RE.test(text)) return false;
	return true;
}

// ── Patch helpers ───────────────────────────────────────────────

export function applyTextPatches(
	baseText: string,
	patches: Array<{ oldText: string; newText: string }>,
): { ok: true; resolvedText: string } | { ok: false; error: string } {
	let resolved = baseText;
	for (const patch of patches) {
		if (!resolved.includes(patch.oldText)) {
			const preview =
				patch.oldText.length > 100
					? `${patch.oldText.slice(0, 100)}...`
					: patch.oldText;
			return {
				ok: false,
				error: `Could not find "${preview}" in the previous version of the file. Ensure oldText exactly matches a section of the existing file content.`,
			};
		}
		resolved = resolved.replace(patch.oldText, patch.newText);
	}
	return { ok: true, resolvedText: resolved };
}

// ── Input normalization ────────────────────────────────────────

export function normalizeProduceFileInput(
	input: ProduceFileInput,
):
	| { ok: true; input: NormalizedProduceFileInput }
	| { ok: false; error: string } {
	const requestTitle =
		input.requestTitle?.trim() ||
		input.title?.trim() ||
		titleFromFilename(input.filename) ||
		"Generated file";
	const requestedOutputs = normalizeToolRequestedOutputs(input);
	const content = firstNonEmptyString(
		input.markdown,
		input.content,
		input.text,
	);
	const explicitMode = input.sourceMode;

	if (explicitMode === "program" || input.program) {
		if (!input.program) {
			if (!content) {
				return {
					ok: false,
					error: "program or content is required when sourceMode is program",
				};
			}
			return {
				ok: true,
				input: {
					idempotencyKey: input.idempotencyKey,
					requestTitle,
					requestedOutputs,
					sourceMode: "program",
					documentIntent: input.documentIntent,
					templateHint: input.templateHint,
					program: buildTextFileProgram({
						content,
						filename: resolveTextFilename({
							filename: input.filename,
							requestTitle,
							outputType: requestedOutputs[0]?.type,
						}),
					}),
				},
			};
		}
		return {
			ok: true,
			input: {
				idempotencyKey: input.idempotencyKey,
				requestTitle,
				requestedOutputs,
				sourceMode: "program",
				documentIntent: input.documentIntent,
				templateHint: input.templateHint,
				program: input.program,
			},
		};
	}

	if (explicitMode === "document_source" || input.documentSource) {
		if (!input.documentSource && !content) {
			return {
				ok: false,
				error:
					"documentSource or content is required when sourceMode is document_source",
			};
		}
		if (
			input.documentSource &&
			!hasSubstantiveDocumentSource(input.documentSource)
		) {
			return {
				ok: false,
				error:
					"documentSource must contain substantive content when sourceMode is document_source",
			};
		}
		const documentSource = input.documentSource
			? normalizeDocumentSourceEnvelope(input.documentSource, requestTitle)
			: buildDocumentSourceFromText({
					title: requestTitle,
					text: content ?? "",
				});
		if (!hasSubstantiveDocumentSource(documentSource)) {
			return {
				ok: false,
				error:
					"documentSource must contain substantive content when sourceMode is document_source",
			};
		}
		return {
			ok: true,
			input: {
				idempotencyKey: input.idempotencyKey,
				requestTitle,
				requestedOutputs,
				sourceMode: "document_source",
				documentIntent: input.documentIntent,
				templateHint: input.templateHint,
				documentSource,
			},
		};
	}

	if (content) {
		if (!hasSubstantiveContent(content)) {
			return {
				ok: false,
				error:
					"Content is too short or appears to be a template. Provide substantive content with actual data, or use explicit sourceMode with program.sourceCode or documentSource. Do not call produce_file with placeholder or template content.",
			};
		}
		if (shouldUseDocumentSourceForOutputs(requestedOutputs)) {
			return {
				ok: true,
				input: {
					idempotencyKey: input.idempotencyKey,
					requestTitle,
					requestedOutputs,
					sourceMode: "document_source",
					documentIntent: input.documentIntent ?? "document",
					templateHint: input.templateHint,
					patches: normalizePatches(input.patches),
					documentSource: buildDocumentSourceFromText({
						title: requestTitle,
						text: content,
					}),
				},
			};
		}
		return {
			ok: true,
			input: {
				idempotencyKey: input.idempotencyKey,
				requestTitle,
				requestedOutputs,
				sourceMode: "program",
				documentIntent: input.documentIntent ?? "data export",
				templateHint: input.templateHint,
				patches: normalizePatches(input.patches),
				program: buildTextFileProgram({
					content,
					filename: resolveTextFilename({
						filename: input.filename,
						requestTitle,
						outputType: requestedOutputs[0]?.type,
					}),
				}),
			},
		};
	}

	if (input.patches && input.patches.length > 0) {
		const patches = normalizePatches(input.patches);
		if (!patches) {
			return {
				ok: false,
				error:
					"Each patch.oldText must be a non-empty string that matches text in the previous version of the file.",
			};
		}
		const patchedFilename = resolveTextFilename({
			filename: input.filename,
			requestTitle,
			outputType: requestedOutputs[0]?.type,
		});
		return {
			ok: true,
			input: {
				idempotencyKey: input.idempotencyKey,
				requestTitle,
				requestedOutputs,
				sourceMode: "program",
				documentIntent: input.documentIntent,
				templateHint: input.templateHint,
				patches,
				program: buildTextFileProgram({
					content: "",
					filename: patchedFilename,
				}),
			},
		};
	}

	return {
		ok: false,
		error:
			"produce_file requires content, markdown, text, patches, documentSource, or program",
	};
}

// ── Internal normalization helpers ─────────────────────────────

function normalizePatches(
	patches: Array<{ oldText: string; newText: string }> | undefined,
): Array<{ oldText: string; newText: string }> | undefined {
	if (!patches || patches.length === 0) return undefined;
	const result: Array<{ oldText: string; newText: string }> = [];
	for (const patch of patches) {
		const oldText = typeof patch.oldText === "string" ? patch.oldText : "";
		if (!oldText.trim()) return undefined;
		result.push({
			oldText,
			newText: typeof patch.newText === "string" ? patch.newText : "",
		});
	}
	return result.length > 0 ? result : undefined;
}

function normalizeDocumentSourceEnvelope(
	documentSource: Record<string, unknown>,
	requestTitle: string,
): Record<string, unknown> {
	const blocksSource =
		Array.isArray(documentSource.blocks) && documentSource.blocks.length > 0
			? documentSource.blocks
			: [
					{
						type: "paragraph",
						text: `Generated file request: ${requestTitle}`,
					},
				];
	const explicitTitle =
		typeof documentSource.title === "string" &&
		documentSource.title.trim().length > 0
			? documentSource.title.trim()
			: null;
	const repaired = dedupeAdjacentCharts(
		blocksSource.flatMap(repairDocumentSourceBlock),
	);
	// The report template already prints the document title; a leading H1 that
	// repeats it (or the request title) would render the title twice. When the
	// model gave no title at all, the leading H1 IS the title.
	const first = repaired[0];
	const leadingH1 =
		first &&
		first.type === "heading" &&
		Number(first.level) === 1 &&
		typeof first.text === "string" &&
		first.text.trim().length > 0
			? first.text.trim()
			: null;
	const title = explicitTitle ?? leadingH1 ?? requestTitle;
	const dropLeadingH1 =
		leadingH1 !== null &&
		(titleKey(leadingH1) === titleKey(title) ||
			titleKey(leadingH1) === titleKey(requestTitle));
	const blocks = dropLeadingH1 ? repaired.slice(1) : repaired;
	return {
		...documentSource,
		version: 1,
		template: "alfyai_standard_report",
		title,
		blocks,
	};
}

// A bar-column table yields a provisional chart; the model's own chart of
// the same categories right after it (a ```text bar chart under the table)
// replaces it, and identical data is not repeated.
function dedupeAdjacentCharts(
	blocks: Record<string, unknown>[],
): Record<string, unknown>[] {
	const shape = (
		block: Record<string, unknown>,
	): { labels: unknown[]; values: unknown[] } | null => {
		if (block.type !== "chart" || !Array.isArray(block.data)) return null;
		const rows = block.data.filter(isRecord);
		if (rows.length === 0) return null;
		const labelKey =
			typeof block.xKey === "string"
				? block.xKey
				: typeof block.labelKey === "string"
					? block.labelKey
					: null;
		const valueKey =
			typeof block.yKey === "string"
				? block.yKey
				: typeof block.valueKey === "string"
					? block.valueKey
					: null;
		if (!labelKey || !valueKey) return null;
		return {
			labels: rows.map((row) => row[labelKey]),
			values: rows.map((row) => row[valueKey]),
		};
	};
	const result: Record<string, unknown>[] = [];
	for (const block of blocks) {
		const current = shape(block);
		if (current) {
			let skip = false;
			for (
				let index = result.length - 1;
				index >= Math.max(0, result.length - 2);
				index--
			) {
				const previous = shape(result[index]);
				if (!previous) continue;
				const sameCategories = sameChartCategories(
					previous.labels,
					current.labels,
				);
				const sameValues =
					sameCategories &&
					JSON.stringify(previous.values) === JSON.stringify(current.values);
				if (sameValues || (sameCategories && block.derived === true)) {
					skip = true;
					break;
				}
				if (sameCategories && result[index].derived === true) {
					result.splice(index, 1);
					break;
				}
			}
			if (skip) continue;
		}
		result.push(block);
	}
	return result.map((block) => {
		if (block.type === "chart" && "derived" in block) {
			const { derived: _derived, ...rest } = block;
			return rest;
		}
		return block;
	});
}

function titleKey(value: string): string {
	return value
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "");
}

// Model-authored `documentSource` blocks are hand-built JSON, and small local
// models routinely botch the paragraph block: a GFM pipe table or an ASCII bar
// chart flattened onto a single line (no newlines survive whatever produced
// the tool call), sometimes wrapped in a stray code-fence/backtick pair. This
// repairs a paragraph block IN PLACE before it reaches `validateGeneratedDocumentSource`
// — reconstructing the structure the model clearly intended instead of letting
// it render as a run-on paragraph. Non-paragraph blocks (and paragraphs with
// nothing to repair) pass through untouched.
function repairDocumentSourceBlock(raw: unknown): Record<string, unknown>[] {
	if (!isRecord(raw)) return [raw as Record<string, unknown>];
	const block = coerceDocumentBlockShape(raw);
	if (block.type === "table") return repairTableBlock(block);
	if (block.type === "chart") return [fillChartBlockDefaults(block)];
	if (block.type === "code") return repairCodeBlock(block);
	if (block.type !== "paragraph" || typeof block.text !== "string")
		return [block];
	const text = block.text;

	// (b) A fenced or backtick-wrapped paragraph: a ```chart / ```csv fence, or
	// an ASCII bar chart (with or without a fence) flattened onto one line.
	const fenced = unwrapFencedParagraph(text);
	if (fenced) {
		if (fenced.lang === "chart") {
			const chartBlock = chartJsFenceToBlock(fenced.content);
			if (chartBlock) return [chartBlock];
		} else if (fenced.lang === "csv") {
			const tableBlock = csvFenceToTableBlock(fenced.content);
			if (tableBlock) return [tableBlock];
		}
		const asciiSource = fenced.content.includes("\n")
			? fenced.content
			: (reconstructAsciiChartLines(fenced.content) ?? fenced.content);
		const ascii = parseAsciiBarChart(asciiSource);
		if (ascii) return [asciiBarChartToBlock(ascii)];
		return [
			{
				type: "code",
				...(fenced.lang ? { language: fenced.lang } : {}),
				text: fenced.content.trim(),
			},
		];
	}

	// A bare (unwrapped) ASCII bar chart, still flattened onto one line.
	const bareAsciiSource = text.includes("\n")
		? text
		: reconstructAsciiChartLines(text);
	if (bareAsciiSource) {
		const ascii = parseAsciiBarChart(bareAsciiSource);
		if (ascii) return [asciiBarChartToBlock(ascii)];
	}

	// (a) A GFM pipe table crammed onto a single line: reconstruct the row
	// boundaries (each original line started/ended with "|", so joined lines
	// leave a telltale "| |" seam) and re-run the table parser.
	if (!text.includes("\n") && /\|\s*:?-{2,}:?\s*\|/.test(text)) {
		const rebuilt = reconstructPipeTableParagraph(text);
		if (rebuilt) {
			const blocks = markdownishTextToBlocks(rebuilt);
			if (blocks.length > 0) return blocks;
		}
	}

	// (c) Markdown structure (headings/bullets/tables) embedded with real
	// newlines inside one paragraph's text instead of being split into blocks.
	if (
		text.includes("\n") &&
		/(^|\n)\s*(#{1,3}\s|[-*]\s|\d+\.\s|>\s*\[!|\|.*\||(?:---|\*\*\*|___)\s*(?:\n|$)|```)/.test(
			text,
		)
	) {
		const blocks = markdownishTextToBlocks(text);
		if (blocks.length > 0) return blocks;
	}

	// Plain paragraph: still unescape markdown punctuation the model escaped
	// (\*, \_, \#) so it does not print literally.
	const unescaped = stripInlineMarkdown(text);
	return [unescaped === text ? block : { ...block, text: unescaped }];
}

function normalizeToolRequestedOutputs(
	input: ProduceFileInput,
): Array<{ type: string }> {
	const explicitOutputs = input.requestedOutputs ?? input.outputs;
	if (Array.isArray(explicitOutputs) && explicitOutputs.length > 0) {
		return explicitOutputs.map((output) => ({
			type: output.type.trim() || "file",
		}));
	}
	const directType =
		input.outputType?.trim() ||
		input.fileType?.trim() ||
		outputTypeFromFilename(input.filename);
	if (directType) return [{ type: directType }];
	if (input.markdown) return [{ type: "md" }];
	if (input.text || input.content) return [{ type: "txt" }];
	if (input.documentSource) return [{ type: "pdf" }];
	return [{ type: "file" }];
}

function firstNonEmptyString(
	...values: Array<string | undefined>
): string | null {
	for (const value of values) {
		const trimmed = value?.trim();
		if (trimmed) return trimmed;
	}
	return null;
}

function outputTypeFromFilename(filename?: string): string | null {
	const trimmed = filename?.trim();
	if (!trimmed) return null;
	const match = /\.([a-z0-9]+)$/i.exec(trimmed);
	return match?.[1]?.toLowerCase() ?? null;
}

function titleFromFilename(filename?: string): string | null {
	const trimmed = filename?.trim();
	if (!trimmed) return null;
	const withoutExtension = trimmed.replace(/\.[a-z0-9]+$/i, "");
	const title = withoutExtension
		.replace(/[_-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return title || null;
}

function shouldUseDocumentSourceForOutputs(
	outputs: Array<{ type: string }>,
): boolean {
	const documentTypes = new Set(["pdf", "docx", "html"]);
	return outputs.every((output) =>
		documentTypes.has(output.type.trim().toLowerCase()),
	);
}

// ── Filename / program helpers ─────────────────────────────────

const OUTPUT_TYPE_EXTENSIONS: Record<string, string> = {
	markdown: "md",
	"text/markdown": "md",
	md: "md",
	txt: "txt",
	text: "txt",
	"text/plain": "txt",
	json: "json",
	"application/json": "json",
	csv: "csv",
	"text/csv": "csv",
	html: "html",
	"text/html": "html",
	css: "css",
	js: "js",
	javascript: "js",
	ts: "ts",
	typescript: "ts",
	sh: "sh",
	shell: "sh",
	svg: "svg",
	xml: "xml",
	yaml: "yaml",
	yml: "yml",
};

function resolveTextFilename(params: {
	filename?: string;
	requestTitle: string;
	outputType?: string;
}): string {
	const explicit = sanitizeFilename(params.filename);
	if (explicit) return explicit;
	const normalizedType =
		OUTPUT_TYPE_EXTENSIONS[params.outputType?.trim().toLowerCase() ?? ""] ??
		params.outputType?.trim().toLowerCase() ??
		"txt";
	const extension = normalizedType.replace(/^\./, "") || "txt";
	const basename =
		params.requestTitle
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 80) || "generated-file";
	return `${basename}.${extension}`;
}

function sanitizeFilename(value?: string): string | null {
	const trimmed = value?.trim();
	if (!trimmed) return null;
	const basename = trimmed.split(/[\\/]/).filter(Boolean).pop() ?? "";
	const safe = basename.replace(/[^a-zA-Z0-9._ -]+/g, "-").trim();
	return safe && safe !== "." && safe !== ".." ? safe.slice(0, 120) : null;
}

function buildTextFileProgram(params: {
	content: string;
	filename: string;
}): NonNullable<NormalizedProduceFileInput["program"]> {
	const filename = sanitizeFilename(params.filename) ?? "generated-file.txt";
	return {
		language: "python",
		filename,
		sourceCode: [
			"from pathlib import Path",
			"output = Path('/output')",
			"output.mkdir(parents=True, exist_ok=True)",
			`(output / ${JSON.stringify(filename)}).write_text(${JSON.stringify(params.content)}, encoding='utf-8')`,
			"",
		].join("\n"),
	};
}

// ── Document source construction ───────────────────────────────

function buildDocumentSourceFromText(params: {
	title: string;
	text: string;
}): Record<string, unknown> {
	const blocks = markdownishTextToBlocks(params.text);
	return {
		version: 1,
		template: "alfyai_standard_report",
		title: params.title,
		blocks:
			blocks.length > 0
				? blocks
				: [{ type: "paragraph", text: params.text || params.title }],
	};
}

function stripInlineMarkdown(text: string): string {
	return (
		text
			// Escaped markdown punctuation (\*, \_, \#, \|) is meant literally.
			.replace(/\\([*_#|`~[\]()>-])/g, "$1")
			.replace(/\*\*([^*]+)\*\*/g, "$1")
			.replace(/__([^_]+)__/g, "$1")
			.replace(/\*([^*]+)\*/g, "$1")
			.replace(/_([^_]+)_/g, "$1")
			.replace(/~~([^~]+)~~/g, "$1")
			.replace(/`([^`]+)`/g, "$1")
			.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
			.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
			.replace(/\s+/g, " ")
			.trim()
	);
}

const NUMBERED_LIST_ITEM_RE = /^\d+[.)]\s+(.+)$/;
const BULLET_LIST_ITEM_RE = /^[-*]\s+(.+)$/;
const HEADING_RE = /^(#{1,3})\s+(.+)$/;
const FENCE_OPEN_RE = /^(`{3,}|~{3,})\s*(\S.*)?$/;
const CALLOUT_START_RE = /^>\s*\[!([A-Za-z]+)\]\s*(.*)$/;
const PIPE_ROW_HINT_RE = /\|/;

function markdownishTextToBlocks(text: string): Array<Record<string, unknown>> {
	const blocks: Array<Record<string, unknown>> = [];
	const lines = text.split(/\r?\n/);
	const paragraph: string[] = [];
	let listItems: string[] = [];
	let listStyle: "bullet" | "numbered" = "bullet";

	const flushParagraph = () => {
		if (paragraph.length === 0) return;
		blocks.push({
			type: "paragraph",
			text: stripInlineMarkdown(paragraph.join(" ")),
		});
		paragraph.length = 0;
	};
	const flushList = () => {
		if (listItems.length === 0) return;
		blocks.push({
			type: "list",
			style: listStyle,
			items: listItems.map(stripInlineMarkdown),
		});
		listItems = [];
		listStyle = "bullet";
	};

	let i = 0;
	while (i < lines.length) {
		const line = lines[i].trim();

		if (!line) {
			flushParagraph();
			flushList();
			i++;
			continue;
		}

		const fenceOpen = FENCE_OPEN_RE.exec(line);
		if (fenceOpen) {
			flushParagraph();
			flushList();
			const fenceChar = fenceOpen[1][0];
			const fenceLen = fenceOpen[1].length;
			const info = fenceOpen[2]?.trim() ?? "";
			const closeRe = new RegExp(
				`^${fenceChar === "`" ? "`" : "~"}{${fenceLen},}\\s*$`,
			);
			let j = i + 1;
			const bodyLines: string[] = [];
			while (j < lines.length && !closeRe.test(lines[j].trim())) {
				bodyLines.push(lines[j]);
				j++;
			}
			blocks.push(fenceToBlock(info, bodyLines.join("\n")));
			i = j + 1;
			continue;
		}

		if (
			PIPE_ROW_HINT_RE.test(line) &&
			i + 1 < lines.length &&
			isPipeSeparatorRow(lines[i + 1])
		) {
			flushParagraph();
			flushList();
			const parsed = parsePipeTable(lines, i);
			blocks.push(parsed.block);
			i = parsed.nextIndex;
			continue;
		}

		if (CALLOUT_START_RE.test(line)) {
			flushParagraph();
			flushList();
			const parsed = parseCalloutLines(lines, i);
			blocks.push(parsed.block);
			i = parsed.nextIndex;
			continue;
		}

		if (/^(?:---|\*\*\*|___)\s*$/.test(line)) {
			flushParagraph();
			flushList();
			blocks.push({ type: "divider" });
			i++;
			continue;
		}
		const heading = HEADING_RE.exec(line);
		if (heading) {
			flushParagraph();
			flushList();
			blocks.push({
				type: "heading",
				level: Math.min(3, Math.max(1, heading[1].length)),
				text: stripInlineMarkdown(heading[2].trim()),
			});
			i++;
			continue;
		}

		const numbered = NUMBERED_LIST_ITEM_RE.exec(line);
		if (numbered) {
			flushParagraph();
			if (listStyle !== "numbered") flushList();
			listStyle = "numbered";
			listItems.push(numbered[1].trim());
			i++;
			continue;
		}

		const bullet = BULLET_LIST_ITEM_RE.exec(line);
		if (bullet) {
			flushParagraph();
			if (listStyle !== "bullet") flushList();
			listStyle = "bullet";
			listItems.push(bullet[1].trim());
			i++;
			continue;
		}

		flushList();
		paragraph.push(line);
		i++;
	}
	flushParagraph();
	flushList();
	return blocks;
}

// ── GFM pipe tables ─────────────────────────────────────────────

function splitPipeRow(line: string): string[] {
	let trimmed = line.trim();
	if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
	if (trimmed.endsWith("|") && !trimmed.endsWith("\\|"))
		trimmed = trimmed.slice(0, -1);
	return trimmed
		.split(/(?<!\\)\|/)
		.map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function isPipeSeparatorRow(line: string): boolean {
	const trimmed = line.trim();
	if (!trimmed.includes("|") && !trimmed.includes("-")) return false;
	const cells = splitPipeRow(trimmed);
	if (cells.length === 0) return false;
	return cells.every((cell) => /^:?-{1,}:?$/.test(cell.trim()));
}

function slugifyKey(label: string, usedKeys: Set<string>): string {
	const base =
		label
			.normalize("NFD")
			.replace(/[̀-ͯ]/g, "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "_")
			.replace(/^_+|_+$/g, "") || "col";
	let key = base;
	let suffix = 2;
	while (usedKeys.has(key)) {
		key = `${base}_${suffix}`;
		suffix += 1;
	}
	usedKeys.add(key);
	return key;
}

function parsePipeTable(
	lines: string[],
	startIndex: number,
): { block: Record<string, unknown>; nextIndex: number } {
	const headerCells = splitPipeRow(lines[startIndex]);
	const usedKeys = new Set<string>();
	const columns = headerCells.map((label, index) => ({
		key: slugifyKey(label || `col_${index + 1}`, usedKeys),
		label: stripInlineMarkdown(label) || `Column ${index + 1}`,
	}));

	let i = startIndex + 2;
	const rows: Record<string, unknown>[] = [];
	while (
		i < lines.length &&
		lines[i].trim() &&
		PIPE_ROW_HINT_RE.test(lines[i])
	) {
		const cells = splitPipeRow(lines[i]);
		const row: Record<string, unknown> = {};
		columns.forEach((column, index) => {
			row[column.key] = stripInlineMarkdown(cells[index] ?? "");
		});
		rows.push(row);
		i++;
	}

	return { block: { type: "table", columns, rows }, nextIndex: i };
}

// A single-line paragraph the model produced by joining table rows with a
// space: each original line started and ended with "|", so the join leaves a
// "| |" seam right at the row boundary (and before/after the separator row).
// Splitting on that seam reconstructs the original line breaks.
function reconstructPipeTableParagraph(text: string): string | null {
	if (!text.includes("|")) return null;
	const rebuilt = text.replace(/\|\s+\|/g, "|\n|").trim();
	return rebuilt.includes("\n") ? rebuilt : null;
}

// ── Callouts (`> [!TIP] ...`) ───────────────────────────────────

const CALLOUT_TONE_MAP: Record<string, "info" | "warning" | "tip" | "note"> = {
	tip: "tip",
	hint: "tip",
	success: "tip",
	check: "tip",
	warning: "warning",
	caution: "warning",
	danger: "warning",
	important: "warning",
	info: "info",
	note: "note",
};

function calloutTone(tag: string): "info" | "warning" | "tip" | "note" {
	return CALLOUT_TONE_MAP[tag.toLowerCase()] ?? "note";
}

function parseCalloutLines(
	lines: string[],
	startIndex: number,
): { block: Record<string, unknown>; nextIndex: number } {
	const startMatch = CALLOUT_START_RE.exec(lines[startIndex].trim());
	const tag = startMatch?.[1] ?? "note";
	const inlineText = startMatch?.[2]?.trim() ?? "";

	let i = startIndex + 1;
	const bodyLines: string[] = [];
	while (i < lines.length && /^>\s?/.test(lines[i])) {
		bodyLines.push(lines[i].replace(/^>\s?/, ""));
		i++;
	}

	const tone = calloutTone(tag);
	const bodyText = bodyLines.join(" ").trim();
	const title = bodyText && inlineText ? stripInlineMarkdown(inlineText) : null;
	const text = stripInlineMarkdown(bodyText || inlineText || tag);

	return {
		block: {
			type: "callout",
			tone,
			...(title ? { title } : {}),
			text,
		},
		nextIndex: i,
	};
}

// ── Fenced code blocks (```chart / ```csv / generic) ────────────

function fenceToBlock(info: string, body: string): Record<string, unknown> {
	const keyword = info.trim().toLowerCase().split(/\s+/)[0] ?? "";

	if (keyword === "chart") {
		const chartBlock = chartJsFenceToBlock(body);
		if (chartBlock) return chartBlock;
		return { type: "code", language: "json", text: body.trim() };
	}

	if (keyword === "csv") {
		const tableBlock = csvFenceToTableBlock(body);
		if (tableBlock) return tableBlock;
		return { type: "code", language: "csv", text: body.trim() };
	}

	if (keyword === "" || keyword === "text" || keyword === "txt") {
		const ascii = parseAsciiBarChart(body);
		if (ascii) return asciiBarChartToBlock(ascii);
	}

	return {
		type: "code",
		...(info.trim() ? { language: info.trim() } : {}),
		text: body.trim(),
	};
}

function parseCsvLine(line: string): string[] {
	const result: string[] = [];
	let current = "";
	let inQuotes = false;
	for (let index = 0; index < line.length; index++) {
		const char = line[index];
		if (inQuotes) {
			if (char === '"') {
				if (line[index + 1] === '"') {
					current += '"';
					index++;
				} else {
					inQuotes = false;
				}
			} else {
				current += char;
			}
			continue;
		}
		if (char === '"') {
			inQuotes = true;
		} else if (char === ",") {
			result.push(current);
			current = "";
		} else {
			current += char;
		}
	}
	result.push(current);
	return result;
}

function csvFenceToTableBlock(body: string): Record<string, unknown> | null {
	const lines = body.split(/\r?\n/).filter((line) => line.trim().length > 0);
	if (lines.length < 2) return null;
	const header = parseCsvLine(lines[0]).map((cell) => cell.trim());
	if (header.length === 0 || header.every((cell) => !cell)) return null;

	const usedKeys = new Set<string>();
	const columns = header.map((label, index) => ({
		key: slugifyKey(label || `col_${index + 1}`, usedKeys),
		label: label || `Column ${index + 1}`,
	}));

	const rows = lines.slice(1).map((line) => {
		const cells = parseCsvLine(line);
		const row: Record<string, unknown> = {};
		columns.forEach((column, index) => {
			row[column.key] = (cells[index] ?? "").trim();
		});
		return row;
	});

	return { type: "table", columns, rows };
}

// ── Chart.js fences (```chart) ───────────────────────────────────

const CHART_JS_TYPE_MAP: Record<string, string> = {
	bar: "bar",
	line: "line",
	pie: "pie",
	doughnut: "donut",
	scatter: "scatter",
};

function chartConfigTitle(config: Record<string, unknown>): string | null {
	const options = isRecord(config.options) ? config.options : null;
	const plugins = options && isRecord(options.plugins) ? options.plugins : null;
	const titleConfig = plugins && isRecord(plugins.title) ? plugins.title : null;
	const text = titleConfig?.text;
	return typeof text === "string" && text.trim() ? text.trim() : null;
}

function chartJsFenceToBlock(body: string): Record<string, unknown> | null {
	let config: unknown;
	try {
		config = JSON.parse(body);
	} catch {
		return null;
	}
	if (!isRecord(config) || !isRecord(config.data)) return null;

	const chartJsType =
		typeof config.type === "string" ? config.type.toLowerCase() : "";
	const title = chartConfigTitle(config);
	const mapped = CHART_JS_TYPE_MAP[chartJsType];

	if (mapped) {
		const resolvedTitle = title ?? "Chart";
		return {
			type: "chart",
			chartType: mapped,
			title: resolvedTitle,
			caption: `Generated ${chartJsType} chart.`,
			altText: `${resolvedTitle} (${mapped} chart).`,
			data: config.data,
		};
	}

	return chartJsConfigToTableBlock(config, title);
}

function chartJsConfigToTableBlock(
	config: Record<string, unknown>,
	title: string | null,
): Record<string, unknown> | null {
	const data = config.data as Record<string, unknown>;
	const labels = Array.isArray(data.labels) ? data.labels : [];
	const datasets = Array.isArray(data.datasets)
		? data.datasets.filter(isRecord)
		: [];
	if (labels.length === 0 || datasets.length === 0) return null;

	const usedKeys = new Set<string>();
	const labelKey = slugifyKey("label", usedKeys);
	const columns: Array<Record<string, unknown>> = [
		{ key: labelKey, label: "Label" },
	];
	const datasetKeys = datasets.map((dataset, index) => {
		const label =
			typeof dataset.label === "string" && dataset.label.trim()
				? dataset.label.trim()
				: `Series ${index + 1}`;
		const key = slugifyKey(label, usedKeys);
		columns.push({ key, label });
		return key;
	});

	const rows = labels.map((label, index) => {
		const row: Record<string, unknown> = { [labelKey]: String(label) };
		datasets.forEach((dataset, datasetIndex) => {
			const values = Array.isArray(dataset.data) ? dataset.data : [];
			row[datasetKeys[datasetIndex]] = values[index] ?? null;
		});
		return row;
	});

	return { type: "table", ...(title ? { title } : {}), columns, rows };
}

// ── ASCII bar charts ─────────────────────────────────────────────

function asciiBarChartToBlock(chart: AsciiBarChart): Record<string, unknown> {
	const title = chart.title ?? "Bar chart";
	const units = chart.units ?? "value";
	return {
		type: "chart",
		chartType: "bar",
		title,
		caption: `Extracted from an ASCII bar chart (${chart.points.length} items).`,
		altText: `${title}: bar chart with ${chart.points.length} items, values in ${units}.`,
		xKey: "label",
		yKey: "value",
		units,
		data: chart.points.map((point) => ({
			label: point.label,
			value: point.value,
		})),
	};
}

// ── Block shape repair (model-authored documentSource) ───────────

const KNOWN_BLOCK_TYPES = new Set([
	"heading",
	"paragraph",
	"list",
	"sourceChips",
	"callout",
	"confidenceMarker",
	"basisMarker",
	"code",
	"quote",
	"divider",
	"table",
	"chart",
	"image",
	"pageBreak",
]);

const NESTED_BLOCK_KEYS = [
	"chart",
	"table",
	"callout",
	"code",
	"list",
	"heading",
	"paragraph",
] as const;

// Models drop `type`, invent aliases ("h2", "bullets", "bar_chart"), or nest
// the block under its own name ({ "chart": { ... } }). Recover the intended
// block instead of failing the whole document with unsupported_document_block.
function coerceDocumentBlockShape(
	block: Record<string, unknown>,
): Record<string, unknown> {
	if (typeof block.type === "string" && KNOWN_BLOCK_TYPES.has(block.type)) {
		return block;
	}
	const keys = Object.keys(block).filter((key) => key !== "type");
	for (const key of NESTED_BLOCK_KEYS) {
		if (keys.length === 1 && keys[0] === key && isRecord(block[key])) {
			return coerceDocumentBlockShape({
				type: key,
				...(block[key] as Record<string, unknown>),
			});
		}
	}
	const alias =
		typeof block.type === "string" ? block.type.trim().toLowerCase() : "";
	const headingLevel = /^h([1-6])$/.exec(alias);
	if (headingLevel) {
		return { ...block, type: "heading", level: Number(headingLevel[1]) };
	}
	switch (alias) {
		case "header":
		case "title":
		case "subheading":
			return { ...block, type: "heading", level: block.level ?? 2 };
		case "text":
		case "p":
		case "para":
		case "body":
			return { ...block, type: "paragraph" };
		case "bullets":
		case "bullet_list":
		case "bulletlist":
		case "ul":
			return { ...block, type: "list", style: "bullet" };
		case "ol":
		case "numbered":
		case "numbered_list":
		case "numberedlist":
			return { ...block, type: "list", style: "numbered" };
		case "graph":
		case "barchart":
		case "bar_chart":
		case "bar":
		case "linechart":
		case "line_chart":
		case "piechart":
		case "pie_chart":
			return {
				...block,
				type: "chart",
				chartType:
					block.chartType ??
					(alias.startsWith("line")
						? "line"
						: alias.startsWith("pie")
							? "pie"
							: "bar"),
			};
		case "hr":
		case "rule":
		case "separator":
			return { type: "divider" };
		case "note":
		case "tip":
		case "warning":
		case "info":
		case "important":
			return { ...block, type: "callout", tone: block.tone ?? alias };
		case "codeblock":
		case "code_block":
		case "pre":
			return { ...block, type: "code" };
		case "blockquote":
			return { ...block, type: "quote" };
		default:
			break;
	}
	// No usable type: infer from shape.
	if (Array.isArray(block.columns) && Array.isArray(block.rows)) {
		return { ...block, type: "table" };
	}
	if (
		typeof block.chartType === "string" ||
		(isRecord(block.data) && Array.isArray(block.data.datasets)) ||
		(Array.isArray(block.data) &&
			(typeof block.xKey === "string" || typeof block.labelKey === "string"))
	) {
		return { ...block, type: "chart" };
	}
	if (Array.isArray(block.items)) return { ...block, type: "list" };
	if (typeof block.text === "string") {
		if (typeof block.level === "number") return { ...block, type: "heading" };
		if (typeof block.language === "string") return { ...block, type: "code" };
		if (typeof block.tone === "string") return { ...block, type: "callout" };
		return { ...block, type: "paragraph" };
	}
	return block;
}

const CHART_TYPE_ALIASES: Record<string, string> = {
	bar: "bar",
	column: "bar",
	horizontalbar: "bar",
	stackedbar: "stackedBar",
	stacked: "stackedBar",
	line: "line",
	area: "area",
	pie: "pie",
	donut: "donut",
	doughnut: "donut",
	scatter: "scatter",
};

function cleanString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

// The schema insists on title, caption, altText, units and the axis keys.
// A model that just wrote {chartType, title, data:[{label,value}]} clearly
// meant a chart; fill the boilerplate instead of rejecting the document.
function fillChartBlockDefaults(
	block: Record<string, unknown>,
): Record<string, unknown> {
	const rawType =
		typeof block.chartType === "string"
			? block.chartType.trim().toLowerCase()
			: typeof block.type === "string" && block.type !== "chart"
				? block.type.trim().toLowerCase()
				: "bar";
	const chartType = CHART_TYPE_ALIASES[rawType] ?? rawType;
	const title = cleanString(block.title) ?? "Chart";
	const isPie = chartType === "pie" || chartType === "donut";
	const chartJsForm =
		isRecord(block.data) && Array.isArray(block.data.datasets);
	const rows = Array.isArray(block.data) ? block.data.filter(isRecord) : [];

	let labelKey = cleanString(block.labelKey) ?? cleanString(block.xKey);
	let valueKey = cleanString(block.valueKey) ?? cleanString(block.yKey);
	let units = cleanString(block.units);
	let data: unknown = block.data;

	if (!chartJsForm && rows.length > 0) {
		const keys = Object.keys(rows[0]);
		const numericKeys = keys.filter((key) =>
			rows.every((row) => parseNumericCell(row[key]) !== null),
		);
		const textKeys = keys.filter((key) => !numericKeys.includes(key));
		if (!labelKey || !keys.includes(labelKey)) labelKey = textKeys[0] ?? null;
		if (!valueKey || !keys.includes(valueKey)) {
			valueKey = numericKeys.find((key) => key !== labelKey) ?? null;
		}
		if (valueKey) {
			// "€24.25" / "13%" strings → numbers, remembering the unit.
			const resolvedValueKey = valueKey;
			data = rows.map((row) => {
				const parsed = parseNumericCell(row[resolvedValueKey]);
				if (parsed && typeof row[resolvedValueKey] !== "number") {
					if (!units && parsed.units) units = parsed.units;
					return { ...row, [resolvedValueKey]: parsed.value };
				}
				return row;
			});
		}
	}

	const axisKeys = isPie
		? {
				labelKey: labelKey ?? block.labelKey ?? null,
				valueKey: valueKey ?? block.valueKey ?? null,
			}
		: {
				xKey: labelKey ?? block.xKey ?? null,
				yKey: valueKey ?? block.yKey ?? null,
			};

	return {
		...block,
		type: "chart",
		chartType,
		title,
		caption: cleanString(block.caption) ?? title,
		altText: cleanString(block.altText) ?? `${title} (${chartType} chart).`,
		units: units ?? (chartJsForm ? block.units : "value"),
		...axisKeys,
		data,
	};
}

// A table whose column is nothing but block-character bars ("Relative
// Scale": ██████) is a chart drawn into a table. Drop the decorative column
// and, when exactly one numeric column remains next to a label column, add
// the real chart the bars were standing in for.
function repairTableBlock(
	block: Record<string, unknown>,
): Record<string, unknown>[] {
	const columns = Array.isArray(block.columns)
		? block.columns.filter(isRecord)
		: [];
	const rows = Array.isArray(block.rows) ? block.rows.filter(isRecord) : [];
	if (columns.length === 0 || rows.length === 0) return [block];

	const columnKey = (column: Record<string, unknown>): string | null =>
		typeof column.key === "string" ? column.key : null;
	const barColumns = columns.filter((column) => {
		const key = columnKey(column);
		if (!key) return false;
		const cells = rows.map((row) => row[key]);
		return (
			cells.some(hasBarChars) &&
			cells.every(
				(cell) =>
					cell === null ||
					cell === undefined ||
					cell === "" ||
					isBarOnlyCell(cell),
			)
		);
	});
	if (barColumns.length === 0) return [block];

	const keptColumns = columns.filter((column) => !barColumns.includes(column));
	if (keptColumns.length === 0) return [block];
	const keptKeys = keptColumns
		.map(columnKey)
		.filter((key): key is string => key !== null);
	const keptRows = rows.map((row) =>
		Object.fromEntries(keptKeys.map((key) => [key, row[key]])),
	);
	const table = { ...block, columns: keptColumns, rows: keptRows };

	const numericColumns = keptColumns.filter((column) => {
		const key = columnKey(column);
		return (
			key !== null && rows.every((row) => parseNumericCell(row[key]) !== null)
		);
	});
	const labelColumn = keptColumns.find(
		(column) => !numericColumns.includes(column),
	);
	const labelKey = labelColumn ? columnKey(labelColumn) : null;
	const barKey = columnKey(barColumns[0]);
	const barLengths = rows.map((row) =>
		barKey ? barFillLength(row[barKey]) : 0,
	);
	const barIndex = columns.indexOf(barColumns[0]);
	const valueColumn = pickBarMatchedColumn(
		barLengths,
		[...numericColumns]
			.sort(
				(a, b) =>
					Math.abs(columns.indexOf(a) - barIndex) -
					Math.abs(columns.indexOf(b) - barIndex),
			)
			.flatMap((column) => {
				const key = columnKey(column);
				return key
					? [
							{
								id: column,
								values: rows.map(
									(row) => parseNumericCell(row[key])?.value ?? 0,
								),
							},
						]
					: [];
			}),
		legendPerBlock(barColumns[0].label),
	);
	const valueKey = valueColumn ? columnKey(valueColumn) : null;
	if (!labelKey || !valueKey || !labelColumn || !valueColumn) return [table];

	let units: string | null = null;
	const data = rows.map((row) => {
		const parsed = parseNumericCell(row[valueKey]);
		if (!units && parsed?.units) units = parsed.units;
		return { label: String(row[labelKey] ?? ""), value: parsed?.value ?? 0 };
	});
	const valueLabel = cleanString(valueColumn.label) ?? "Value";
	const labelLabel = cleanString(labelColumn.label) ?? "Item";
	const title = cleanString(block.title) ?? `${valueLabel} by ${labelLabel}`;
	return [
		table,
		{
			type: "chart",
			chartType: "bar",
			title,
			caption: `${valueLabel} by ${labelLabel}.`,
			altText: `${title}: bar chart with ${data.length} items.`,
			xKey: "label",
			yKey: "value",
			units: units ?? "value",
			data,
			derived: true,
		},
	];
}

const PLAIN_CODE_LANGS = new Set([
	"",
	"text",
	"txt",
	"plain",
	"plaintext",
	"ascii",
	"console",
]);

// A ```text code block that is really an ASCII bar chart.
function repairCodeBlock(
	block: Record<string, unknown>,
): Record<string, unknown>[] {
	const language =
		typeof block.language === "string"
			? block.language.trim().toLowerCase()
			: "";
	const text = typeof block.text === "string" ? block.text : "";
	if (!PLAIN_CODE_LANGS.has(language) || !BLOCK_BAR_RUN_RE.test(text)) {
		return [block];
	}
	const source = text.includes("\n")
		? text
		: (reconstructAsciiChartLines(text) ?? text);
	const ascii = parseAsciiBarChart(source);
	return ascii ? [asciiBarChartToBlock(ascii)] : [block];
}

const BLOCK_BAR_RUN_RE = /[█▓▒░■□▪▫]{2,}/;
const ASCII_CHART_ENTRY_RE =
	/([A-Za-zÀ-ÖØ-öø-ÿ][\w' .()-]*?)\s+([█▓▒░■□▪▫]{2,})\s*([\s\S]*?)(?=[A-Za-zÀ-ÖØ-öø-ÿ][\w' .()-]*?\s+[█▓▒░■□▪▫]{2,}|$)/g;

// A model sometimes flattens an ASCII bar chart onto a single line (no
// newlines survived). Re-derive the original per-item lines by finding each
// "label + bar-run + value" entry and splitting right before it, so the
// result can be handed to `parseAsciiBarChart` as if it were never flattened.
function reconstructAsciiChartLines(text: string): string | null {
	if (!BLOCK_BAR_RUN_RE.test(text)) return null;
	const entryRe = new RegExp(ASCII_CHART_ENTRY_RE);
	const entries: string[] = [];
	let firstIndex: number | null = null;
	let match: RegExpExecArray | null = entryRe.exec(text);
	while (match) {
		if (firstIndex === null) firstIndex = match.index;
		const [, label, bars, tail] = match;
		entries.push(`${label.trim()} ${bars} ${tail.trim()}`.trim());
		if (entryRe.lastIndex === match.index) entryRe.lastIndex += 1;
		match = entryRe.exec(text);
	}
	if (entries.length < 2 || firstIndex === null) return null;
	const prefix = text.slice(0, firstIndex).trim();
	return (prefix ? [prefix, ...entries] : entries).join("\n");
}

// ── Fenced / backtick-wrapped paragraph text ─────────────────────

function unwrapFencedParagraph(
	text: string,
): { content: string; lang: string | null } | null {
	const trimmed = text.trim();
	const fenceMatch = /^(`{3,}|~{3,})([^\n]*)\n?([\s\S]*?)\n?\1\s*$/.exec(
		trimmed,
	);
	if (fenceMatch) {
		const lang = fenceMatch[2].trim().toLowerCase().split(/\s+/)[0] || null;
		return { content: fenceMatch[3], lang };
	}
	const backtickMatch = /^(`{1,2})([\s\S]*)\1$/.exec(trimmed);
	if (backtickMatch && backtickMatch[2].trim().length > 0) {
		return { content: backtickMatch[2].trim(), lang: null };
	}
	return null;
}

// ── Content validation ─────────────────────────────────────────

const TEMPLATE_MARKER_RE =
	/\b(TODO|placeholder|content (goes )?here|to be filled|\[placeholder\]|\.\.\.\s*$|^#\s+\w+(\s+\w+){0,3}\s*\.\.\.\s*$)/im;
const MIN_SUBSTANTIVE_CONTENT_LENGTH = 80;

function hasSubstantiveContent(content: string): boolean {
	const text = stripMarkdownFormatting(content).trim();
	if (text.length < MIN_SUBSTANTIVE_CONTENT_LENGTH) return false;
	if (TEMPLATE_MARKER_RE.test(text)) return false;
	return true;
}

function stripMarkdownFormatting(content: string): string {
	return content
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/```[\s\S]*?```/g, "")
		.replace(/`[^`\n]+`/g, "")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
		.replace(/[*_~]{1,3}/g, "")
		.replace(/^[\s]*[-*+]\s+/gm, "")
		.replace(/^[\s]*\d+\.\s+/gm, "")
		.replace(/^>\s*/gm, "")
		.replace(/\n{2,}/g, "\n")
		.replace(/\s+/g, " ");
}

const DOCUMENT_SOURCE_METADATA_KEYS = new Set([
	"template",
	"title",
	"type",
	"version",
]);

function hasSubstantiveDocumentSource(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return hasSubstantiveDocumentValue(value);
}

function hasSubstantiveDocumentValue(value: unknown): boolean {
	if (typeof value === "string") return value.trim().length > 0;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) {
		return value.some((item) => hasSubstantiveDocumentValue(item));
	}
	if (!isRecord(value)) return false;
	return Object.entries(value).some(([key, item]) => {
		if (DOCUMENT_SOURCE_METADATA_KEYS.has(key)) return false;
		return hasSubstantiveDocumentValue(item);
	});
}

// ── Idempotency ────────────────────────────────────────────────

export function buildScopedIdempotencyKey(params: {
	turnId: string;
	input: NormalizedProduceFileInput;
}): string {
	const idempotencySource =
		params.input.idempotencyKey ?? params.input.requestTitle;
	const parts = [
		slugifyIdempotencyPart(params.turnId, 48),
		"produce_file",
		slugifyIdempotencyPart(idempotencySource, 60),
		shortHash({
			idempotencyKey: params.input.idempotencyKey ?? null,
			requestTitle: params.input.requestTitle,
			inputHash: shortHash(params.input),
		}),
	];
	return parts.join(":").slice(0, 160);
}

export function buildSameTurnProduceFileDedupeKey(
	input: NormalizedProduceFileInput,
): string {
	const requestedOutputs = input.requestedOutputs
		.map((output) => output.type.trim().toLowerCase())
		.sort();
	const programFilename =
		input.sourceMode === "program" && input.program?.filename
			? input.program.filename.trim().toLowerCase()
			: null;

	return stableStringify({
		requestTitle: input.requestTitle.trim().toLowerCase(),
		requestedOutputs,
		sourceMode: input.sourceMode,
		documentIntent: input.documentIntent?.trim().toLowerCase() ?? null,
		templateHint: input.templateHint?.trim().toLowerCase() ?? null,
		programFilename,
	});
}

function slugifyIdempotencyPart(value: string, maxLength = 80): string {
	const slug = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return (slug || "request").slice(0, maxLength);
}

// ── Input sanitization for tool call recording ─────────────────

export function sanitizeProduceFileInput(
	input: NormalizedProduceFileInput,
): SafeProduceFileInput {
	const safe: SafeProduceFileInput = {
		...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
		requestTitle: input.requestTitle,
		requestedOutputs: input.requestedOutputs.map((output) => ({
			type: output.type,
		})),
		sourceMode: input.sourceMode,
		...(input.documentIntent ? { documentIntent: input.documentIntent } : {}),
		...(input.templateHint ? { templateHint: input.templateHint } : {}),
	};

	if (input.program) {
		safe.program = {
			language: input.program.language,
			...(input.program.filename ? { filename: input.program.filename } : {}),
			sourceCodeHash: shortHash(input.program.sourceCode),
			sourceCodeLength: input.program.sourceCode.length,
		};
	}

	if (input.documentSource) {
		const serializedDocumentSource = stableStringify(input.documentSource);
		safe.documentSource = {
			contentHash: shortHash(input.documentSource),
			topLevelKeyCount: Object.keys(input.documentSource).length,
			serializedLength: serializedDocumentSource.length,
		};
	}

	return safe;
}

export function sanitizeUnsafeProduceFileInput(
	input: unknown,
): SafeProduceFileInput {
	if (!isRecord(input)) return {};
	const safe: SafeProduceFileInput = {};
	if (typeof input.idempotencyKey === "string" && input.idempotencyKey) {
		safe.idempotencyKey = input.idempotencyKey;
	}
	if (typeof input.requestTitle === "string") {
		safe.requestTitle = input.requestTitle;
	}
	if (typeof input.title === "string") {
		safe.title = input.title;
	}
	if (Array.isArray(input.requestedOutputs)) {
		safe.requestedOutputs = input.requestedOutputs
			.filter(isRecord)
			.map((output) => ({
				...(typeof output.type === "string" ? { type: output.type } : {}),
			}));
	}
	if (Array.isArray(input.outputs)) {
		safe.outputs = input.outputs.filter(isRecord).map((output) => ({
			...(typeof output.type === "string" ? { type: output.type } : {}),
		}));
	}
	if (typeof input.outputType === "string") {
		safe.outputType = input.outputType;
	}
	if (typeof input.fileType === "string") {
		safe.fileType = input.fileType;
	}
	if (typeof input.filename === "string") {
		safe.filename = input.filename;
	}
	if (typeof input.sourceMode === "string") {
		safe.sourceMode = input.sourceMode;
	}
	if (typeof input.documentIntent === "string") {
		safe.documentIntent = input.documentIntent;
	}
	if (typeof input.templateHint === "string") {
		safe.templateHint = input.templateHint;
	}
	if (isRecord(input.program)) {
		safe.program = {
			...(typeof input.program.language === "string"
				? { language: input.program.language }
				: {}),
			...(typeof input.program.filename === "string"
				? { filename: input.program.filename }
				: {}),
			...(typeof input.program.sourceCode === "string"
				? {
						sourceCodeHash: shortHash(input.program.sourceCode),
						sourceCodeLength: input.program.sourceCode.length,
					}
				: {}),
		};
	}
	if (isRecord(input.documentSource)) {
		const serializedDocumentSource = stableStringify(input.documentSource);
		safe.documentSource = {
			contentHash: shortHash(input.documentSource),
			topLevelKeyCount: Object.keys(input.documentSource).length,
			serializedLength: serializedDocumentSource.length,
		};
	}
	for (const field of ["content", "markdown", "text"] as const) {
		if (typeof input[field] === "string") {
			safe[field] = {
				contentHash: shortHash(input[field]),
				contentLength: input[field].length,
			};
		}
	}
	return safe;
}

// ── Model payload / result compaction ──────────────────────────

export function compactProduceFileModelPayload(
	result: FileProductionIntakeResult,
) {
	if (result.ok) {
		return {
			ok: true as const,
			status: result.status,
			jobId: result.job.id,
			jobStatus: result.job.status,
			reused: result.reused,
		};
	}

	return {
		ok: false as const,
		status: result.status,
		code: result.code,
		error: result.error,
		...(result.job
			? {
					jobId: result.job.id,
					jobStatus: result.job.status,
				}
			: {}),
	};
}

export function summarizeProduceFileResult(
	payload: ReturnType<typeof compactProduceFileModelPayload>,
): string {
	if (payload.ok) {
		return `File production job ${payload.jobId} queued with status ${payload.jobStatus}.`;
	}
	return payload.jobId
		? `File production intake failed for job ${payload.jobId}: ${payload.error}`
		: `File production intake failed: ${payload.error}`;
}

// ── Tool call entry creation ───────────────────────────────────

export function createProduceFileToolCallEntry(params: {
	callId: string;
	input: SafeProduceFileInput;
	result: FileProductionIntakeResult;
	outputSummary: string;
	metadata?: Record<string, string | number | boolean | null>;
}): ToolCallEntry {
	const metadata: ToolCallEntry["metadata"] = {
		ok: params.result.ok,
		intakeStatus: params.result.status,
		...params.metadata,
	};
	if (params.result.ok) {
		metadata.jobId = params.result.job.id;
		metadata.jobStatus = params.result.job.status;
		metadata.reused = params.result.reused;
	} else {
		metadata.evidenceReady = false;
		metadata.code = params.result.code;
		if (params.result.job) {
			metadata.jobId = params.result.job.id;
			metadata.jobStatus = params.result.job.status;
		}
	}

	return {
		callId: params.callId,
		name: "produce_file",
		input: params.input,
		status: "done",
		outputSummary: params.outputSummary,
		sourceType: "tool",
		metadata,
	};
}
