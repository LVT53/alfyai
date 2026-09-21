import { z } from "zod";

import type { FileProductionIntakeResult } from "$lib/server/services/file-production";
// Leaf module (no imports of its own), so this pulls no DB into the tool graph.
import { redactHostPathsFromFileProductionMessage } from "$lib/server/services/file-production/error-message";
// Leaf module too: the mixed-output-family rule, shared with the HTTP intake
// so both callers refuse the same shapes with the same words.
import { refuseMixedOutputGroups as refuseMixedOutputGroupsForTypes } from "$lib/server/services/file-production/mixed-output-groups";
import { FILE_PRODUCTION_OUTPUT_TYPE_EXAMPLES } from "$lib/server/services/file-production/output-types";
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
import { fileExtension } from "$lib/shared/file-types";
import {
	getExpectedExtensionForOutputType,
	isInlineTextOutputType,
	shouldUseDocumentSourceForOutputs as shouldUseDocumentSourceForOutputTypes,
} from "$lib/shared/file-types/production";

import { isRecord, shortHash, stableStringify } from "./shared";

/** What `dev`'s /\.([a-z0-9]+)$/i accepted as an extension. See `outputTypeFromFilename`. */
const ALPHANUMERIC_EXTENSION = /^[a-z0-9]+$/;

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
		// `.catch(undefined)` for the same reason as on the model schema below:
		// the server picks the mode, so an unrecognised one is dropped rather
		// than failing a request whose content is perfectly good.
		sourceMode: z
			.enum(["program", "document_source"])
			.optional()
			.catch(undefined),
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

// What the model is shown. The full schema above stays the parser: it keeps
// accepting the aliases (`title`, `outputs`, `fileType`, `text`, ...) that
// older prompts and the model still occasionally send, but describing every
// alias to the model costs hundreds of prompt tokens on every turn.
export const produceFileModelInputSchema = z
	.object({
		requestTitle: z.string().min(1).optional(),
		filename: z.string().min(1).optional(),
		outputType: z
			.string()
			.min(1)
			.optional()
			.describe("File type, e.g. xlsx, docx, pptx, pdf, csv, zip, md."),
		// The built-in skills (system:spreadsheet-builder) instruct the model to
		// send this, so it has to be in the schema the model is shown.
		requestedOutputs: z
			.array(requestedOutputSchema)
			.min(1)
			.optional()
			.describe(
				'Only for several formats of one artifact: [{"type":"pdf"},{"type":"docx"}].',
			),
		// Named by the built-in skills, so the model has to be able to see it.
		// Omitting it is still normal: the server infers the mode.
		//
		// `.catch(undefined)` is what keeps an unrecognised value from failing the
		// whole tool call: it drops the value during the SDK's own validation, so
		// the call proceeds and the server picks the mode — which the description
		// already says it does. The mode the server picks can be `inline_text`,
		// which is NOT one the model may send, and a model imitating its own
		// history sent it straight back and had the call rejected. It does not
		// change the serialised JSON Schema by one byte (1 479, verified), exactly
		// as `read_generated_file`'s `page` does not.
		sourceMode: z
			.enum(["program", "document_source"])
			.optional()
			.catch(undefined),
		markdown: z.string().min(1).optional(),
		content: z.string().min(1).optional(),
		patches: z
			.array(z.object({ oldText: z.string().min(1), newText: z.string() }))
			.min(1)
			.optional(),
		program: z
			.object({
				language: z.enum(["python", "javascript"]),
				sourceCode: z.string().min(1),
				filename: z.string().min(1).optional(),
			})
			.optional()
			.describe(
				"Code that builds the file. It must write into /output (e.g. /output/report.xlsx); only /output is collected. Needs outputType or requestedOutputs.",
			),
		documentSource: z.record(z.string(), z.unknown()).optional(),
	})
	.passthrough();

// ── Types ──────────────────────────────────────────────────────

export type ProduceFileInput = z.infer<typeof produceFileInputSchema>;

/**
 * Phase 6 D8. The model already supplied the bytes, and every requested output
 * is a plain-text type, so the app writes them itself: no Docker container, no
 * generated Python `write_text` one-liner. One entry in `files` per requested
 * output type, all carrying the same `content`.
 */
export type NormalizedInlineTextRequest = {
	content: string;
	files: Array<{ filename: string; outputType: string }>;
};

export type NormalizedProduceFileInput = {
	idempotencyKey?: string;
	requestTitle: string;
	requestedOutputs: Array<{ type: string }>;
	sourceMode: "program" | "document_source" | "inline_text";
	documentIntent?: string;
	templateHint?: string;
	patches?: Array<{ oldText: string; newText: string }>;
	program?: {
		language: "python" | "javascript";
		sourceCode: string;
		filename?: string;
	};
	documentSource?: Record<string, unknown>;
	inlineText?: NormalizedInlineTextRequest;
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

/**
 * What a request that sends both a change and a replacement is told. One
 * sentence naming both halves, and the one thing to do about it, because the
 * model has to be able to resend without guessing which field offended.
 */
export const PATCHES_WITH_OWN_CONTENT_ERROR =
	"Send either the full content or patches, not both: patches change the previous version of the file, while content, markdown, text, documentSource and program replace it entirely. Resend this call with only one of them.";

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
	// `patches` and content of the request's own are two different claims about
	// the same file: the patches describe a CHANGE to the previous version,
	// while `content`/`markdown`/`text`, a `documentSource` or a `program`
	// describe the WHOLE new version. A request that sends both says two
	// incompatible things, and whichever one this function honoured, the other
	// was thrown away without a word — an explicit `sourceMode` took the
	// content and dropped the patches, no mode took the patches and dropped the
	// content, and both reported success on a file the model did not ask for.
	// Neither half is safe to guess at, so the call is refused and the model is
	// told to resend with one of them.
	const hasPatches = Array.isArray(input.patches) && input.patches.length > 0;
	const hasOwnContent = Boolean(
		content || input.documentSource || input.program,
	);
	if (hasPatches && hasOwnContent) {
		return {
			ok: false,
			error: PATCHES_WITH_OWN_CONTENT_ERROR,
		};
	}
	// A patch brings its own content: the base file, plus the edit. So a request
	// that carries `patches` — and, after the refusal above, nothing else to
	// produce from — has named no mode it can be held to: the mode follows from
	// the base file and the requested outputs, which the patch path below (and
	// the adapter, once it HAS the patched bytes) decides. Validating the named
	// mode against content the model was never going to send is what refused the
	// live call `{filename, sourceMode: "document_source", patches}` with
	// "documentSource or content is required", after which the model gave up on
	// patching and rewrote the whole file.
	const explicitMode = hasPatches ? undefined : input.sourceMode;

	if (explicitMode === "program" || input.program) {
		if (!input.program) {
			if (!content) {
				return {
					ok: false,
					error: "program or content is required when sourceMode is program",
				};
			}
			// The model named program mode but supplied prose, so WE pick the
			// writer — and must refuse the shapes that would write bytes not
			// matching their extension. A model-authored `program.sourceCode`
			// (below) is left alone: a real program may legitimately write both a
			// PDF and a Markdown file.
			const mixed = refuseMixedOutputGroups(requestedOutputs);
			if (mixed) return mixed;
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
		if (requestedOutputs.length === 0) {
			return {
				ok: false,
				error: `outputType is required for program mode, e.g. ${FILE_PRODUCTION_OUTPUT_TYPE_EXAMPLES}. Set outputType (or requestedOutputs), or give program.filename an extension.`,
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
					documentSource: buildDocumentSourceFromText({
						title: requestTitle,
						text: content,
					}),
				},
			};
		}
		const mixed = refuseMixedOutputGroups(requestedOutputs);
		if (mixed) return mixed;
		// Phase 6 D8: the bytes are already here and every output is a plain-text
		// type, so nothing has to run. This branch never carries patches — a
		// request holding both was refused above — so the mode follows from the
		// output types alone. It is also the branch the adapter re-enters with
		// the PATCHED bytes as `content`, which is how a patched `.md` reaches
		// `inline_text` instead of starting a container.
		if (isInlineTextRequest(outputTypesOf(requestedOutputs))) {
			return {
				ok: true,
				input: {
					idempotencyKey: input.idempotencyKey,
					requestTitle,
					requestedOutputs,
					sourceMode: "inline_text",
					documentIntent: input.documentIntent ?? "data export",
					templateHint: input.templateHint,
					inlineText: {
						content,
						files: requestedOutputs.map((output) => ({
							filename: resolveInlineTextFilename({
								filename: input.filename,
								requestTitle,
								outputType: output.type,
							}),
							outputType: output.type,
						})),
					},
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
		// A patch-only call names no format; the reconstructed file is plain
		// text, which `resolveTextFilename` has already assumed above.
		const patchedOutputs =
			requestedOutputs.length > 0
				? requestedOutputs
				: [{ type: outputTypeFromFilename(patchedFilename) ?? "txt" }];
		const mixed = refuseMixedOutputGroups(patchedOutputs);
		if (mixed) return mixed;
		return {
			ok: true,
			input: {
				idempotencyKey: input.idempotencyKey,
				requestTitle,
				requestedOutputs: patchedOutputs,
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

// Resolution order: explicit `requestedOutputs`/`outputs`, `outputType`/
// `fileType`, the top-level `filename`'s extension, `program.filename`'s
// extension, then what the supplied content implies. Returning an EMPTY list
// is a real answer — "nothing here names a file type" — and the caller turns
// it into an error. It must never become a `"file"` placeholder: nothing
// downstream can map that to an extension, so it used to surface as
// `unsupported_program_output_type` only after the sandbox run had finished.
function normalizeToolRequestedOutputs(
	input: ProduceFileInput,
): Array<{ type: string }> {
	const explicitOutputs = input.requestedOutputs ?? input.outputs;
	if (Array.isArray(explicitOutputs) && explicitOutputs.length > 0) {
		const named = explicitOutputs
			.map((output) => ({ type: output.type.trim() }))
			.filter((output) => output.type.length > 0);
		if (named.length > 0) return named;
	}
	const directType = namedOutputTypeFromInput(input);
	if (directType) return [{ type: directType }];
	if (input.markdown) return [{ type: "md" }];
	if (input.text || input.content) return [{ type: "txt" }];
	if (input.documentSource) return [{ type: "pdf" }];
	return [];
}

/**
 * The output type the MODEL named, or null when nothing in the request names
 * one and `normalizeToolRequestedOutputs`'s default ladder (markdown → md,
 * text → txt, documentSource → pdf, patches → txt) would have to answer.
 *
 * The patch resolver needs that difference: a patch-only call defaults to
 * `txt`, and looking for the previous version of the file among THIS
 * conversation's `.txt` outputs would miss the `.md` the model actually means.
 */
export function namedOutputTypeFromInput(
	input: ProduceFileInput,
): string | null {
	const explicitOutputs = input.requestedOutputs ?? input.outputs;
	if (Array.isArray(explicitOutputs)) {
		const named = explicitOutputs
			.map((output) => output.type?.trim())
			.find((type) => type);
		if (named) return named;
	}
	return (
		input.outputType?.trim() ||
		input.fileType?.trim() ||
		outputTypeFromFilename(input.filename) ||
		outputTypeFromFilename(input.program?.filename) ||
		null
	);
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

export function outputTypeFromFilename(filename?: string): string | null {
	// The registry parser answers "everything after the last dot". `dev` used
	// /\.([a-z0-9]+)$/i, which is stricter in a load-bearing way: a tail that is
	// not purely alphanumeric named NO output type, and the caller fell through
	// to its markdown/text/documentSource default. Without the guard
	// "Q1 vs Q2 (rev. 3)" becomes the output type "3)" and the whole request is
	// refused as unsupported.
	const extension = fileExtension(filename?.trim() ?? "");
	return ALPHANUMERIC_EXTENSION.test(extension) ? extension : null;
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

// Thin wrapper over the registry so the call site keeps passing output
// objects. The registry matches on ENTRY ID only, which is exactly the old
// {pdf, docx, html} set — a MIME token such as "application/pdf" was never in
// it and still is not (spec conflict 5).
function shouldUseDocumentSourceForOutputs(
	outputs: Array<{ type: string }>,
): boolean {
	return shouldUseDocumentSourceForOutputTypes(
		outputs.map((output) => output.type),
	);
}

function outputTypesOf(outputs: Array<{ type: string }>): string[] {
	return outputs.map((output) => output.type);
}

/**
 * True iff EVERY requested output resolves to a registry entry that is
 * text-validated and is not a document source — exactly the set
 * `buildTextFileProgram` was being used for. An EMPTY list is false: the
 * caller's default-type ladder has already run, so "nothing named a type" is
 * not "every type qualifies".
 *
 * HTML is text-validated but IS a document source, so it stays with the
 * report renderers.
 */
export function isInlineTextRequest(types: readonly string[]): boolean {
	return types.length > 0 && types.every(isInlineTextOutputType);
}

/**
 * The refusal for a request that mixes the two production families when WE,
 * not the model, choose the writer.
 *
 * The rule itself now lives in `file-production/mixed-output-groups.ts`, so
 * the HTTP intake — which Atlas and the signed service-assertion callers use
 * and which the tool layer never passes through — applies the identical rule
 * and the identical message. This wrapper keeps the call sites below taking
 * output objects.
 *
 * Only the paths that synthesise the writer call it. A model-authored
 * `program.sourceCode` or `documentSource` may legitimately produce both
 * families from one request.
 */
function refuseMixedOutputGroups(
	outputs: Array<{ type: string }>,
): { ok: false; error: string } | null {
	const mixed = refuseMixedOutputGroupsForTypes(outputTypesOf(outputs));
	return mixed ? { ok: false, error: mixed.error } : null;
}

// ── Filename / program helpers ─────────────────────────────────

function resolveTextFilename(params: {
	filename?: string;
	requestTitle: string;
	outputType?: string;
}): string {
	const explicit = sanitizeFilename(params.filename);
	if (explicit) return explicit;
	// The registry token map replaces a local, narrower copy; the raw-token
	// fallback below is unchanged, so an unknown token still becomes the
	// extension verbatim.
	const normalizedType =
		getExpectedExtensionForOutputType(params.outputType ?? "") ??
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

/**
 * `resolveTextFilename` for one output of a possibly multi-output inline_text
 * request. An explicit `filename` names ONE file, so it is honoured only for
 * the output type whose extension it already carries; every other output is
 * named from the request title. Without that, a `[md, txt]` request with
 * `filename: "notes.md"` would try to write two files called `notes.md`.
 */
function resolveInlineTextFilename(params: {
	filename?: string;
	requestTitle: string;
	outputType: string;
}): string {
	const explicit = sanitizeFilename(params.filename);
	const expected = getExpectedExtensionForOutputType(params.outputType);
	if (explicit && expected && explicit.toLowerCase().endsWith(expected)) {
		return explicit;
	}
	return resolveTextFilename({
		requestTitle: params.requestTitle,
		outputType: params.outputType,
	});
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
			: input.sourceMode === "inline_text" && input.inlineText
				? input.inlineText.files
						.map((file) => file.filename.trim().toLowerCase())
						.join("|")
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

	if (input.inlineText) {
		// The recorded tool call keeps the SHAPE, never the bytes — the content
		// is the user's own text and the recording ends up in prompt context.
		safe.inlineText = {
			files: input.inlineText.files.map((file) => ({
				filename: file.filename,
				outputType: file.outputType,
			})),
			contentHash: shortHash(input.inlineText.content),
			contentLength: input.inlineText.content.length,
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

// ── In-turn verdict ────────────────────────────────────────────
//
// `produce_file` used to return the INTAKE receipt ("job queued") and nothing
// else. The model read `ok: true` and wrote "your file is ready" in the same
// turn, while the detached worker was still deciding — and when the job later
// failed, nothing rewrote that claim. The tool now waits a bounded time for the
// ledger's verdict and reports THAT, so `ok: true, status: "succeeded"` is the
// only shape that means a file exists.

/** Upper bound on the in-turn wait for a verdict. Must stay comfortably under
 * TOOL_TIMEOUTS_MS.produce_file, which is what aborts the tool call. A program
 * job can legitimately run up to the sandbox's own 90s cutoff, so a wait long
 * enough to cover every job would stall every file turn; 20s covers the
 * document renders and the ordinary program run, and anything slower reports
 * `running` honestly instead of guessing. */
export const PRODUCE_FILE_VERDICT_WAIT_MS = 20_000;
export const PRODUCE_FILE_VERDICT_POLL_INTERVAL_MS = 400;

/** Cap on `message`: enough of a traceback to fix the program, not enough to
 * blow up the next turn's prompt. */
export const PRODUCE_FILE_ERROR_MESSAGE_MAX_CHARS = 600;

/** How many times one requested artifact may be submitted to intake within a
 * single turn. One first attempt plus exactly one correction; the third is
 * refused server-side so a model that cannot fix its program cannot spin. */
export const MAX_SAME_TURN_PRODUCE_FILE_SUBMISSIONS = 2;

/** Backstop over the per-artifact counter above, which is keyed by
 * title/outputs/mode/filename and so resets the moment the model retitles a
 * failing request. Without a turn-total cap, NORMAL_CHAT_MAX_TOOL_STEPS (20)
 * produce_file calls each waiting PRODUCE_FILE_VERDICT_WAIT_MS would hold one
 * request open for ~400s and queue 20 jobs. Six is more artifacts than any
 * real turn asks for — a three-file request with a correction each still
 * fits — and bounds the worst case to ~2 minutes. */
export const MAX_PRODUCE_FILE_SUBMISSIONS_PER_TURN = 6;

export const PRODUCE_FILE_RETRY_LIMIT_ERROR_CODE =
	"produce_file_turn_retry_limit";

export const PRODUCE_FILE_TURN_LIMIT_ERROR_CODE = "produce_file_turn_limit";

// Ledger error codes the MODEL can act on by sending a corrected program.
// Deliberately NOT the ledger's own `retryable`, which answers a different
// question — whether the user's Retry button may re-run the SAME request.
// A sandbox outage is `retryable` for the button and useless to the model;
// a Python traceback is the opposite.
const MODEL_CORRECTABLE_ERROR_CODES = new Set([
	"program_execution_failed",
	"program_execution_threw",
	// The program ran but wrote nothing into /output — a code fix.
	"program_no_outputs",
	// Argument-level mistakes the model owns.
	"invalid_tool_input",
	"patch_failed",
	"no_previous_version_for_patches",
	// Intake 422s (intake.ts). Every one of these says "the arguments you sent
	// are wrong", which is the definition of something the model fixes by
	// resending — including the two the program-mode output-type work added,
	// where the fix is literally "name a supported outputType".
	"missing_request_title",
	"unsupported_source_mode",
	// Two families of output in one request. The fix is literally "call
	// produce_file twice", which the message says, so the model can act on it.
	"mixed_output_groups",
	"invalid_program_language",
	"missing_program_source",
	"missing_program_output_type",
	"unsupported_program_output_type",
	"missing_program_requested_outputs",
	"unsupported_output_type",
	"unsupported_file_production_request",
	"invalid_file_production_request",
	// documentSource validation (source-schema.ts, reached from intake and
	// from the renderer): the block the model wrote is not one the pipeline
	// renders. Rewriting the blocks is the fix.
	"invalid_document_source",
	"unsupported_document_block",
	"unsupported_table_structure",
	"unsupported_chart_type",
	"unsupported_chart_data",
	"unsupported_pdf_block",
	// Post-execution output contract (output-validation.ts, storage-adapter.ts):
	// the program ran and wrote SOMETHING, but not what was asked for or not a
	// readable file of that type. A corrected program is exactly the remedy.
	"program_output_type_mismatch",
	"invalid_xlsx_output",
	"xlsx_output_too_large",
	"invalid_text_output",
	// Size/count limits (limits.ts). The model can write fewer or smaller
	// outputs, so these are correctable rather than terminal.
	"too_many_outputs",
	"source_too_large",
	"output_file_too_large",
	"job_outputs_too_large",
]);

// `program_execution_failed` is also how the sandbox reports its own
// unavailability and its hard timeout (sandbox-execution.ts `classifyError` /
// the catch tail), which no rewrite of the program fixes. These markers pull
// those back out of the correctable set.
const NON_CORRECTABLE_EXECUTION_MARKERS = [
	"timed out",
	"sandbox runtime error",
	"memory limit exceeded",
	"temporary storage exhausted",
	"docker",
	"could not be collected",
];

export function isModelCorrectableFileProductionError(
	errorCode: string,
	message?: string | null,
): boolean {
	if (!MODEL_CORRECTABLE_ERROR_CODES.has(errorCode)) {
		return false;
	}
	const haystack = (message ?? "").toLowerCase();
	return !NON_CORRECTABLE_EXECUTION_MARKERS.some((marker) =>
		haystack.includes(marker),
	);
}

/** Keeps the TAIL of a long error: a traceback's last lines are the ones that
 * say what to fix. Host paths are scrubbed BEFORE the clip, so the redaction
 * can never be defeated by a path that straddles the cut. */
export function clipFileProductionErrorMessage(message: string): string {
	const trimmed = redactHostPathsFromFileProductionMessage(message).trim();
	if (trimmed.length <= PRODUCE_FILE_ERROR_MESSAGE_MAX_CHARS) {
		return trimmed;
	}
	return `…${trimmed.slice(trimmed.length - (PRODUCE_FILE_ERROR_MESSAGE_MAX_CHARS - 1))}`;
}

export type ProduceFileModelPayload =
	| {
			ok: true;
			status: "succeeded";
			jobId: string;
			files: Array<{
				filename: string;
				mimeType: string | null;
				sizeBytes: number;
			}>;
			reused?: boolean;
	  }
	| {
			ok: true;
			status: "running";
			jobId: string;
			message: string;
			reused?: boolean;
	  }
	| {
			ok: false;
			status: "failed";
			jobId?: string;
			errorCode: string;
			message: string;
			retryable: boolean;
	  };

const STILL_RUNNING_MESSAGE =
	"The file is still being made and does not exist yet. Tell the user it is still being produced and that it will appear on its own; do not say it is ready and do not call produce_file again for it.";

export function buildProduceFileSucceededPayload(params: {
	jobId: string;
	files: Array<{
		filename: string;
		mimeType: string | null;
		sizeBytes: number;
	}>;
	reused?: boolean;
}): ProduceFileModelPayload {
	return {
		ok: true,
		status: "succeeded",
		jobId: params.jobId,
		files: params.files.map((file) => ({
			filename: file.filename,
			mimeType: file.mimeType,
			sizeBytes: file.sizeBytes,
		})),
		...(params.reused ? { reused: true } : {}),
	};
}

export function buildProduceFileRunningPayload(params: {
	jobId: string;
	reused?: boolean;
}): ProduceFileModelPayload {
	return {
		ok: true,
		status: "running",
		jobId: params.jobId,
		message: STILL_RUNNING_MESSAGE,
		...(params.reused ? { reused: true } : {}),
	};
}

export function buildProduceFileFailedPayload(params: {
	jobId?: string | null;
	errorCode: string;
	message: string;
}): ProduceFileModelPayload {
	return {
		ok: false,
		status: "failed",
		...(params.jobId ? { jobId: params.jobId } : {}),
		errorCode: params.errorCode,
		message: clipFileProductionErrorMessage(params.message),
		// Classified on the FULL message: clipping keeps the tail, and a marker
		// like "Execution timed out" can sit in the part that was cut.
		retryable: isModelCorrectableFileProductionError(
			params.errorCode,
			params.message,
		),
	};
}

/** Maps an intake refusal (nothing was queued, or the job row was created
 * already failed) onto the same verdict vocabulary the wait produces, so the
 * model only ever has to understand succeeded / running / failed. */
export function buildProduceFileIntakeFailurePayload(
	result: Extract<FileProductionIntakeResult, { ok: false }>,
): ProduceFileModelPayload {
	return buildProduceFileFailedPayload({
		jobId: result.job?.id ?? null,
		errorCode: result.code,
		message: result.error,
	});
}

export function summarizeProduceFileResult(
	payload: ProduceFileModelPayload,
): string {
	if (payload.status === "succeeded") {
		const names = payload.files.map((file) => file.filename).join(", ");
		return names
			? `File production job ${payload.jobId} succeeded: ${names}.`
			: `File production job ${payload.jobId} succeeded.`;
	}
	if (payload.status === "running") {
		return `File production job ${payload.jobId} is still running; no file exists yet.`;
	}
	return payload.jobId
		? `File production failed for job ${payload.jobId} (${payload.errorCode}): ${payload.message}`
		: `File production failed (${payload.errorCode}): ${payload.message}`;
}

// ── Tool call entry creation ───────────────────────────────────

/** The two `sourceMode` values `produceFileModelInputSchema` lets the model
 * send. */
const MODEL_SENDABLE_SOURCE_MODES = new Set(["program", "document_source"]);

/**
 * The recorded `input` of a call is REPLAYED to the model next turn as its own
 * history (`conversation-history.ts` puts it in the tool-call part), so it has
 * to be an input the tool would accept back. `inline_text` is the server's own
 * choice, not one the model may send, and a model imitating its history sent it
 * straight back and had the call rejected — two failed tool calls per edit.
 *
 * The chosen mode is a fact about the RUN rather than an argument, so it moves
 * to the entry's metadata. A value the model itself invented moves too: with
 * the schema's `.catch(undefined)` the server would drop it anyway, so the
 * honest record of what ran is "the server chose".
 */
function splitServerChosenSourceMode(input: SafeProduceFileInput): {
	input: SafeProduceFileInput;
	serverSourceMode: string | null;
} {
	const sourceMode = input.sourceMode;
	if (
		typeof sourceMode !== "string" ||
		MODEL_SENDABLE_SOURCE_MODES.has(sourceMode)
	) {
		return { input, serverSourceMode: null };
	}
	const { sourceMode: _serverChosen, ...rest } = input;
	return { input: rest, serverSourceMode: sourceMode };
}

export function createProduceFileToolCallEntry(params: {
	callId: string;
	input: SafeProduceFileInput;
	payload: ProduceFileModelPayload;
	outputSummary: string;
	/** Intake's HTTP-ish status, kept for telemetry only — it never reaches the
	 * model, whose `status` is the ledger verdict. */
	intakeStatus?: number;
	metadata?: Record<string, string | number | boolean | null>;
}): ToolCallEntry {
	const { input, serverSourceMode } = splitServerChosenSourceMode(params.input);
	const metadata: ToolCallEntry["metadata"] = {
		ok: params.payload.ok,
		jobStatus: params.payload.status,
		...(serverSourceMode ? { sourceMode: serverSourceMode } : {}),
		...(params.intakeStatus === undefined
			? {}
			: { intakeStatus: params.intakeStatus }),
		...params.metadata,
	};
	if (params.payload.jobId) {
		metadata.jobId = params.payload.jobId;
	}
	if (params.payload.ok) {
		if (params.payload.reused) {
			metadata.reused = true;
		}
	} else {
		metadata.evidenceReady = false;
		metadata.code = params.payload.errorCode;
		metadata.retryable = params.payload.retryable;
	}

	return {
		callId: params.callId,
		name: "produce_file",
		input,
		// E1 — an `ok: false` produce_file is a FAILED tool call, not a "done"
		// one. The activity row, the completion warning and the next turn's
		// history all key off this.
		status: params.payload.ok ? "done" : "failed",
		outputSummary: params.outputSummary,
		resultDigest: buildProduceFileResultDigest(params.payload),
		sourceType: "tool",
		metadata,
	};
}

/**
 * The one line the NEXT turn's history carries under this call's tool result
 * (`buildHistoryToolDigest` puts `outputSummary` in `summary` and this in
 * `detail`).
 *
 * The summary already names the files and the job verdict; what a model asked
 * "what is in the file you just made?" a turn later also needs is the way back
 * into it, by the name it actually produced — and, when the user asks for an
 * edit, the way to CHANGE that same file instead of regenerating it. Both
 * clauses name the file, because `filename` is the argument that makes a patch
 * land on it. Kept to two short clauses (~40 estimated tokens): they are paid
 * once per produced file, per turn, for as long as the turn stays in the
 * history window.
 */
function buildProduceFileResultDigest(
	payload: ProduceFileModelPayload,
): string | null {
	if (payload.status !== "succeeded") return null;
	const first = payload.files[0]?.filename;
	if (!first) return null;
	return `Read it back with read_generated_file({filename:"${first}"}). Change it with produce_file patches on "${first}".`;
}

/**
 * The refusal for a patch whose previous version could not be found.
 *
 * When this conversation HAS produced files, naming them is the whole remedy:
 * the resolver could not tell which one the patch meant, and the model can only
 * say so with `filename`. Listing them beats "no previous version", which the
 * model could answer only by regenerating the file from scratch — which is
 * exactly what it did live.
 */
export function buildNoPatchBaseMessage(candidates: readonly string[]): string {
	if (candidates.length === 0) {
		return "No previous version of this file could be found. Use content, markdown, or text to create the initial version instead of patches.";
	}
	return `No previous version of this file could be found. Files produced in this conversation: ${candidates.join(
		", ",
	)}. Send the patches again with filename set to the one you mean, or use content, markdown, or text to create a new file.`;
}
