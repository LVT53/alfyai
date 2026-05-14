export const THINKING_OPEN_TAG = "<thinking>";
export const THINKING_CLOSE_TAG = "</thinking>";
export const DEEPSEEK_THINKING_OPEN_TAG = "<think>";
export const DEEPSEEK_THINKING_CLOSE_TAG = "</think>";
export const QWEN_CHATML_THINKING_OPEN_TAG = "<|im_start|>think";
export const QWEN_CHATML_ANALYSIS_OPEN_TAG = "<|im_start|>analysis";
export const QWEN_CHATML_THINKING_CLOSE_TAG = "<|im_end|>";
export const MISTRAL_THINKING_OPEN_TAG = "[THINK]";
export const MISTRAL_THINKING_CLOSE_TAG = "[/THINK]";
export const SKILL_CONTROL_ENVELOPE_OPEN_TAG = "<skill_control_v1>";
export const SKILL_CONTROL_ENVELOPE_CLOSE_TAG = "</skill_control_v1>";

const THINKING_OPEN_TAGS = [
	THINKING_OPEN_TAG,
	DEEPSEEK_THINKING_OPEN_TAG,
	QWEN_CHATML_THINKING_OPEN_TAG,
	QWEN_CHATML_ANALYSIS_OPEN_TAG,
	MISTRAL_THINKING_OPEN_TAG,
] as const;
const THINKING_CLOSE_TAGS = [
	THINKING_CLOSE_TAG,
	DEEPSEEK_THINKING_CLOSE_TAG,
	QWEN_CHATML_THINKING_CLOSE_TAG,
	MISTRAL_THINKING_CLOSE_TAG,
] as const;

export interface InlineThinkingState {
	buffer: string;
	insideThinking: boolean;
}

export interface LeadingThinkingPreambleSplit {
	thinkingText: string;
	visibleText: string;
}

interface InlineThinkingEmitters {
	onVisible: (chunk: string) => boolean | undefined;
	onThinking: (chunk: string) => boolean | undefined;
}

interface TagMatch {
	index: number;
	tag: string;
}

export interface SkillControlEnvelopeBlock {
	rawJson: string;
	rawBlock: string;
}

export function createInlineThinkingState(): InlineThinkingState {
	return {
		buffer: "",
		insideThinking: false,
	};
}

export function getPartialTagPrefixLength(value: string, tag: string): number {
	const maxLength = Math.min(value.length, tag.length - 1);

	for (let length = maxLength; length > 0; length -= 1) {
		if (value.endsWith(tag.slice(0, length))) {
			return length;
		}
	}

	return 0;
}

export function getSkillControlEnvelopePrefixHoldLength(value: string): number {
	return getPartialTagPrefixLength(value, SKILL_CONTROL_ENVELOPE_OPEN_TAG);
}

export function stripCompleteSkillControlEnvelopeBlocks(value: string): {
	visibleText: string;
	envelopes: SkillControlEnvelopeBlock[];
} {
	if (!value) {
		return { visibleText: "", envelopes: [] };
	}

	const envelopes: SkillControlEnvelopeBlock[] = [];
	let visibleText = "";
	let cursor = 0;
	const lowerValue = value.toLowerCase();
	const openTag = SKILL_CONTROL_ENVELOPE_OPEN_TAG;
	const closeTag = SKILL_CONTROL_ENVELOPE_CLOSE_TAG;

	while (cursor < value.length) {
		const openIndex = lowerValue.indexOf(openTag, cursor);
		if (openIndex === -1) {
			visibleText += value.slice(cursor);
			break;
		}

		const payloadStart = openIndex + openTag.length;
		const closeIndex = lowerValue.indexOf(closeTag, payloadStart);
		if (closeIndex === -1) {
			visibleText += value.slice(cursor);
			break;
		}

		visibleText += value.slice(cursor, openIndex);
		const blockEnd = closeIndex + closeTag.length;
		envelopes.push({
			rawJson: value.slice(payloadStart, closeIndex).trim(),
			rawBlock: value.slice(openIndex, blockEnd),
		});
		cursor = blockEnd;
	}

	return { visibleText, envelopes };
}

function emitChunk(
	emit: (chunk: string) => boolean | undefined,
	chunk: string,
): boolean {
	if (!chunk) {
		return true;
	}

	return emit(chunk) !== false;
}

function findFirstTagMatch(
	value: string,
	tags: readonly string[],
): TagMatch | null {
	let bestMatch: TagMatch | null = null;
	const lowerValue = value.toLowerCase();

	for (const tag of tags) {
		const index = lowerValue.indexOf(tag.toLowerCase());
		if (index === -1) {
			continue;
		}
		if (!bestMatch || index < bestMatch.index) {
			bestMatch = { index, tag };
		}
	}

	return bestMatch;
}

function getPartialTagPrefixLengthForAny(
	value: string,
	tags: readonly string[],
): number {
	let bestLength = 0;

	for (const tag of tags) {
		bestLength = Math.max(bestLength, getPartialTagPrefixLength(value, tag));
	}

	return bestLength;
}

export function processInlineThinkingChunk(
	state: InlineThinkingState,
	chunk: string,
	emitters: InlineThinkingEmitters,
): boolean {
	if (!chunk) {
		return true;
	}

	state.buffer += chunk;

	while (state.buffer) {
		if (state.insideThinking) {
			const closeMatch = findFirstTagMatch(state.buffer, THINKING_CLOSE_TAGS);
			if (closeMatch) {
				const thinkingChunk = state.buffer.slice(0, closeMatch.index);
				if (!emitChunk(emitters.onThinking, thinkingChunk)) {
					return false;
				}
				state.buffer = state.buffer.slice(
					closeMatch.index + closeMatch.tag.length,
				);
				state.insideThinking = false;
				continue;
			}

			const partialCloseLength = getPartialTagPrefixLengthForAny(
				state.buffer,
				THINKING_CLOSE_TAGS,
			);
			const flushLength = state.buffer.length - partialCloseLength;
			if (flushLength > 0) {
				const thinkingChunk = state.buffer.slice(0, flushLength);
				if (!emitChunk(emitters.onThinking, thinkingChunk)) {
					return false;
				}
				state.buffer = state.buffer.slice(flushLength);
			}
			break;
		}

		const openMatch = findFirstTagMatch(state.buffer, THINKING_OPEN_TAGS);
		if (openMatch) {
			const visibleChunk = state.buffer.slice(0, openMatch.index);
			if (!emitChunk(emitters.onVisible, visibleChunk)) {
				return false;
			}
			state.buffer = state.buffer.slice(openMatch.index + openMatch.tag.length);
			state.insideThinking = true;
			continue;
		}

		const partialOpenLength = getPartialTagPrefixLengthForAny(
			state.buffer,
			THINKING_OPEN_TAGS,
		);
		const flushLength = state.buffer.length - partialOpenLength;
		if (flushLength > 0) {
			const visibleChunk = state.buffer.slice(0, flushLength);
			if (!emitChunk(emitters.onVisible, visibleChunk)) {
				return false;
			}
			state.buffer = state.buffer.slice(flushLength);
		}
		break;
	}

	return true;
}

export function flushInlineThinkingState(
	state: InlineThinkingState,
	emitters: InlineThinkingEmitters,
): boolean {
	if (!state.buffer) {
		return true;
	}

	const remainder = state.buffer;
	state.buffer = "";

	if (state.insideThinking) {
		state.insideThinking = false;
		return emitChunk(emitters.onThinking, remainder);
	}

	const isPartialOpenTag = THINKING_OPEN_TAGS.some((tag) =>
		tag.startsWith(remainder),
	);
	if (isPartialOpenTag) {
		return true;
	}

	return emitChunk(emitters.onVisible, remainder);
}

const LEADING_RESPONSE_MARKER_RE =
	/^response(?:(?=[A-Z])|(?=\s*<)|:\s*(?=\S)|[\t ]+(?=(?:the user|user|this is|okay,|i\s+(?:need|should|will|can|must|am going)|i'll|let me)\b)|\n+(?=\S)|$)/i;
const LEADING_RESPONSE_SPACE_BEFORE_UPPER_RE = /^response[\t ]+(?=[A-Z])/;
const TENTATIVE_LEADING_RESPONSE_MARKER_RE =
	/^response(?:(?=[A-Z])|(?=\s*<)|:\s*|[\t ]+|\n+)/i;
const WEB_RESEARCH_DIAGNOSTIC_RE =
	/Found\s+\d+\s+source(?:\(s\)|s)?\s+and\s+\d+\s+evidence(?:\s+snippet(?:s|\(s\))?)?(?:\.|(?=$|\s|[A-Z]|[,;:!?]))/gi;
const WEB_RESEARCH_DIAGNOSTIC_PREFIX_SCAN_CHARS = 180;
const WEB_RESEARCH_DIAGNOSTIC_PREFIX_WORDS = [
	"found",
	"source",
	"sources",
	"s",
	"and",
	"evidence",
	"snippet",
	"snippets",
] as const;
const PYTHON_TOOL_DIAGNOSTIC_PREFIX_SCAN_CHARS = 120;
const PYTHON_TOOL_DIAGNOSTIC_PREFIXES = [
	{ marker: "run_python_repl:", minPrefixLength: "run_".length },
	{
		marker: "successfully imported modules:",
		minPrefixLength: "success".length,
	},
	{ marker: "code execution completed", minPrefixLength: "code ".length },
	{ marker: "code execution failed", minPrefixLength: "code ".length },
] as const;
const PYTHON_TOOL_MARKER_PATTERNS = [
	/run_python_repl\s*:/i,
	/successfully imported modules\s*:/i,
	/code execution (?:completed|failed)\b/i,
] as const;
const ASSISTANT_PROSE_BOUNDARY_PATTERNS = [
	"i see",
	"i found",
	"i can",
	"i will",
	"i should",
	"i'll",
	"here's",
	"here is",
	"here are",
	"based on",
	"the ",
	"this ",
	"it ",
	"you ",
	"your ",
	"there ",
	"we ",
	"yes,",
	"yes.",
	"yes ",
	"no,",
	"no.",
	"no ",
] as const;

export interface LeakedToolDiagnosticsState {
	suppressPythonToolOutput: boolean;
}

const THINKING_PREAMBLE_STARTS = [
	"the user wants me",
	"the user asked me",
	"the user asks me",
	"the user is asking me",
	"user wants me",
	"user asked me",
	"user asks me",
	"this is a straightforward",
	"this is straightforward",
	"this is a simple",
	"this is simple",
	"okay, let me",
] as const;

const THINKING_PREAMBLE_START_RE =
	/^(?:(?:the user|user)\s+(?:wants|asked|asks|is asking)\s+me\b|this is (?:a )?(?:straightforward|simple|content request)\b|okay,\s*let me\b)/i;

const THINKING_PREAMBLE_PARAGRAPH_RE =
	/(?:\b(?:the user|user)\s+(?:wants|asked|asks|is asking)\s+me\b|\bi\s+(?:need|should|will|can|must|am going)\b|\bi'll\b|\bthis is (?:a )?(?:straightforward|simple|content request)\b|(?:okay,\s*)?let me\b|\bprovide it in english\b|\bwrap the content\b)/i;
const DANGLING_THINKING_DELIMITER_RE =
	/<\/?(?:thinking|think)>|<\|im_start\|>\s*(?:think|analysis)?|<\|im_end\|>|\[\/?THINK\]/gi;

export function stripLeadingResponseMarker(value: string): string {
	return value
		.replace(LEADING_RESPONSE_SPACE_BEFORE_UPPER_RE, "")
		.replace(LEADING_RESPONSE_MARKER_RE, "");
}

function stripTentativeLeadingResponseMarker(value: string): string {
	return value.replace(TENTATIVE_LEADING_RESPONSE_MARKER_RE, "");
}

export function createLeakedToolDiagnosticsState(): LeakedToolDiagnosticsState {
	return { suppressPythonToolOutput: false };
}

function findFirstPythonToolMarkerIndex(value: string): number {
	let bestIndex = -1;
	for (const pattern of PYTHON_TOOL_MARKER_PATTERNS) {
		const match = pattern.exec(value);
		if (match?.index !== undefined) {
			bestIndex =
				bestIndex === -1 ? match.index : Math.min(bestIndex, match.index);
		}
	}
	return bestIndex;
}

function findAssistantProseBoundaryIndex(value: string): number {
	const lowerValue = value.toLowerCase();
	let bestIndex = -1;

	for (const pattern of ASSISTANT_PROSE_BOUNDARY_PATTERNS) {
		const index = lowerValue.indexOf(pattern);
		if (index === -1) {
			continue;
		}
		bestIndex = bestIndex === -1 ? index : Math.min(bestIndex, index);
	}

	return bestIndex;
}

function splitPreservingLineEndings(
	value: string,
): Array<{ line: string; lineEnding: string }> {
	const matches = value.match(/[^\r\n]*(?:\r?\n|$)/g) ?? [];
	const lines: Array<{ line: string; lineEnding: string }> = [];

	for (const match of matches) {
		if (!match) {
			continue;
		}
		const lineEnding = match.endsWith("\r\n")
			? "\r\n"
			: match.endsWith("\n")
				? "\n"
				: "";
		const line = lineEnding ? match.slice(0, -lineEnding.length) : match;
		lines.push({ line, lineEnding });
	}

	return lines;
}

function stripLeakedPythonToolDiagnostics(
	value: string,
	state: LeakedToolDiagnosticsState,
): string {
	let output = "";

	for (const { line, lineEnding } of splitPreservingLineEndings(value)) {
		if (state.suppressPythonToolOutput) {
			const boundaryIndex = findAssistantProseBoundaryIndex(line);
			if (boundaryIndex >= 0) {
				state.suppressPythonToolOutput = false;
				const prose = line.slice(boundaryIndex);
				const markerIndex = findFirstPythonToolMarkerIndex(prose);
				if (markerIndex >= 0) {
					const prefix = prose.slice(0, markerIndex);
					if (prefix.trim()) {
						output += prefix;
						if (lineEnding) {
							output += lineEnding;
						}
					}
					state.suppressPythonToolOutput = true;
					continue;
				}
				output += prose + lineEnding;
			}
			continue;
		}

		const markerIndex = findFirstPythonToolMarkerIndex(line);
		if (markerIndex >= 0) {
			const prefix = line.slice(0, markerIndex);
			if (prefix.trim()) {
				output += prefix;
				if (lineEnding) {
					output += lineEnding;
				}
			}
			state.suppressPythonToolOutput = true;
			continue;
		}

		output += line + lineEnding;
	}

	return output;
}

export function stripLeakedToolDiagnostics(
	value: string,
	state: LeakedToolDiagnosticsState = createLeakedToolDiagnosticsState(),
): string {
	const withoutWebDiagnostics = value.replace(WEB_RESEARCH_DIAGNOSTIC_RE, "");
	return stripLeakedPythonToolDiagnostics(withoutWebDiagnostics, state).replace(
		/[ \t]+\n/g,
		"\n",
	);
}

function isLeakedToolDiagnosticPrefix(value: string): boolean {
	const candidate = value.trimStart();
	if (!candidate) return false;
	if (!/^found[\s\d()a-z]*$/i.test(candidate)) return false;

	const words = candidate.toLowerCase().match(/[a-z]+/g) ?? [];
	const [firstWord, ...restWords] = words;
	if (!firstWord || !"found".startsWith(firstWord)) return false;

	return restWords.every((word) =>
		WEB_RESEARCH_DIAGNOSTIC_PREFIX_WORDS.some(
			(allowed) => allowed.startsWith(word) || word.startsWith(allowed),
		),
	);
}

function isLeakedPythonToolDiagnosticPrefix(value: string): boolean {
	if (/^\s/.test(value)) return false;
	const candidate = value.toLowerCase();
	if (!candidate) return false;

	return PYTHON_TOOL_DIAGNOSTIC_PREFIXES.some(({ marker, minPrefixLength }) => {
		if (candidate.startsWith(marker)) {
			return true;
		}
		return candidate.length >= minPrefixLength && marker.startsWith(candidate);
	});
}

export function getLeakedToolDiagnosticPrefixLength(value: string): number {
	const scanStart = Math.max(
		0,
		value.length -
			Math.max(
				WEB_RESEARCH_DIAGNOSTIC_PREFIX_SCAN_CHARS,
				PYTHON_TOOL_DIAGNOSTIC_PREFIX_SCAN_CHARS,
			),
	);
	for (let index = scanStart; index < value.length; index += 1) {
		const suffix = value.slice(index);
		if (
			isLeakedToolDiagnosticPrefix(suffix) ||
			isLeakedPythonToolDiagnosticPrefix(suffix)
		) {
			return value.length - index;
		}
	}
	return 0;
}

export function looksLikeLeadingThinkingPreamble(value: string): boolean {
	return THINKING_PREAMBLE_START_RE.test(
		stripLeadingResponseMarker(value).trimStart(),
	);
}

export function mayStartLeadingThinkingPreamble(value: string): boolean {
	const rawCandidate = value.trimStart().toLowerCase();
	if ("response".startsWith(rawCandidate)) {
		return true;
	}

	const candidate = stripTentativeLeadingResponseMarker(value)
		.trimStart()
		.toLowerCase();
	if (!candidate) {
		return true;
	}

	if (
		THINKING_OPEN_TAGS.some((tag) => {
			const normalizedTag = tag.toLowerCase();
			return (
				normalizedTag.startsWith(candidate) ||
				candidate.startsWith(normalizedTag)
			);
		})
	) {
		return true;
	}

	return THINKING_PREAMBLE_STARTS.some(
		(start) => start.startsWith(candidate) || candidate.startsWith(start),
	);
}

function isThinkingPreambleParagraph(value: string): boolean {
	return THINKING_PREAMBLE_PARAGRAPH_RE.test(value.trim());
}

function stripDanglingThinkingDelimiters(value: string): string {
	return value.replace(DANGLING_THINKING_DELIMITER_RE, "").trim();
}

export function splitLeadingThinkingPreamble(
	value: string,
	options: { allowOpenEnded?: boolean } = {},
): LeadingThinkingPreambleSplit | null {
	const stripped = stripLeadingResponseMarker(value).trimStart();
	if (!looksLikeLeadingThinkingPreamble(stripped)) {
		return null;
	}

	const boundaryMatches = [...stripped.matchAll(/\n{2,}/g)];
	for (const match of boundaryMatches) {
		if (match.index === undefined) {
			continue;
		}

		const boundaryEnd = match.index + match[0].length;
		const thinkingCandidate = stripped.slice(0, match.index).trim();
		const cleanedThinkingCandidate =
			stripDanglingThinkingDelimiters(thinkingCandidate);
		const visibleCandidate = stripped.slice(boundaryEnd).trimStart();
		const nextParagraph = visibleCandidate.split(/\n{2,}/, 1)[0]?.trim() ?? "";
		if (!cleanedThinkingCandidate || !nextParagraph) {
			continue;
		}

		const thinkingParagraphs = cleanedThinkingCandidate
			.split(/\n{2,}/)
			.map((paragraph) => paragraph.trim())
			.filter(Boolean);

		if (
			thinkingParagraphs.length > 0 &&
			thinkingParagraphs.every(isThinkingPreambleParagraph) &&
			!isThinkingPreambleParagraph(nextParagraph)
		) {
			return {
				thinkingText: cleanedThinkingCandidate,
				visibleText: visibleCandidate,
			};
		}
	}

	return options.allowOpenEnded
		? {
				thinkingText: stripDanglingThinkingDelimiters(stripped),
				visibleText: "",
			}
		: null;
}

export const FRIENDLY_STREAM_ERRORS = {
	timeout:
		"The model stopped sending updates before it finished. This usually means the provider stream stalled or the request ran too long. Retry the message; if it repeats, try a shorter prompt or another model.",
	network:
		"The chat service could not stay connected to the model provider. Check the server connection and retry; if it keeps happening, the provider endpoint may be unavailable.",
	backend_failure:
		"The model provider or Langflow returned an error before a complete response was produced. Retry the message; if it repeats, check the model and provider logs.",
	capacity_exceeded:
		"The chat service is already handling the maximum number of active responses. Wait a moment, then retry.",
	file_too_large:
		"The uploaded file is larger than the configured upload limit. Upload a smaller file or raise the limit in admin settings.",
	message_too_long:
		"That message is longer than the configured model input limit. Shorten it or split the request into smaller parts.",
	provider_tool_rounds:
		"The provider needed too many tool-call rounds and the turn was stopped to avoid looping. Retry with a narrower request or fewer required sources.",
} as const;

export type StreamErrorCode = keyof typeof FRIENDLY_STREAM_ERRORS;

// --- Internal stream parsing helpers ---
function getNestedObject(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

function getFirstChoice(
	payload: Record<string, unknown>,
): Record<string, unknown> | null {
	if (
		!payload ||
		!Array.isArray(payload.choices) ||
		payload.choices.length === 0
	) {
		return null;
	}

	const [firstChoice] = payload.choices;
	return getNestedObject(firstChoice);
}

function getTextFromContentBlocks(value: unknown): string {
	if (!Array.isArray(value)) {
		return "";
	}

	const prioritized: Array<{ text: string; priority: number }> = [];

	for (const block of value) {
		const blockRecord = getNestedObject(block);
		if (!blockRecord || !Array.isArray(blockRecord.contents)) {
			continue;
		}

		for (const content of blockRecord.contents) {
			const contentRecord = getNestedObject(content);
			if (!contentRecord) {
				continue;
			}

			const text =
				typeof contentRecord.text === "string" ? contentRecord.text.trim() : "";
			if (!text) {
				continue;
			}

			const header = getNestedObject(contentRecord.header);
			const headerTitle =
				typeof header?.title === "string"
					? header.title.toLowerCase().trim()
					: "";

			if (headerTitle.includes("input")) {
				continue;
			}

			const priority =
				headerTitle.includes("output") ||
				headerTitle.includes("answer") ||
				headerTitle.includes("response")
					? 2
					: 1;

			prioritized.push({ text, priority });
		}
	}

	if (prioritized.length === 0) {
		return "";
	}

	const highestPriority = prioritized.reduce(
		(best, entry) => Math.max(best, entry.priority),
		0,
	);

	return prioritized
		.filter((entry) => entry.priority === highestPriority)
		.map((entry) => entry.text)
		.join("\n")
		.trim();
}

function getTextFromContentParts(value: unknown): string {
	if (!Array.isArray(value)) {
		return "";
	}

	return value
		.map((part) => {
			if (typeof part === "string") {
				return part;
			}

			const partRecord = getNestedObject(part);
			if (!partRecord) {
				return "";
			}

			const text = partRecord.text;
			if (typeof text === "string") {
				return text;
			}

			return "";
		})
		.filter(Boolean)
		.join("");
}

function getTextContent(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}

	const payload = getNestedObject(value);
	if (!payload) return "";

	const choice = getFirstChoice(payload);
	if (choice) {
		for (const key of ["delta", "message"]) {
			if (key in choice) {
				const nestedContent = getTextContent(choice[key]);
				if (nestedContent) {
					return nestedContent;
				}
			}
		}
	}

	for (const key of ["text", "chunk", "content"]) {
		const candidate = payload[key];
		if (typeof candidate === "string" && candidate.length > 0) {
			return candidate;
		}
		if (key === "content") {
			const contentPartsText = getTextFromContentParts(candidate);
			if (contentPartsText) {
				return contentPartsText;
			}
		}
	}

	if ("content_blocks" in payload) {
		const contentBlocksText = getTextFromContentBlocks(payload.content_blocks);
		if (contentBlocksText) {
			return contentBlocksText;
		}
	}

	for (const key of [
		"delta",
		"message",
		"chunk",
		"kwargs",
		"output",
		"response",
		"result",
		"data",
	]) {
		if (key in payload) {
			const nestedText = getTextContent(payload[key]);
			if (nestedText) {
				return nestedText;
			}
		}
	}

	return "";
}

// Exported for stream.ts import
export {
	getFirstChoice,
	getNestedObject,
	getTextContent,
	getTextFromContentBlocks,
};
