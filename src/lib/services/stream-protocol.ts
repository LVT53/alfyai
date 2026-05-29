export const BROWSER_CHAT_SSE_EVENTS = {
	token: "token",
	thinking: "thinking",
	toolCall: "tool_call",
	end: "end",
	error: "error",
	replayStart: "replay_start",
	replayEnd: "replay_end",
	waiting: "waiting",
} as const;

export const BROWSER_CHAT_SSE_EVENT_NAMES = [
	BROWSER_CHAT_SSE_EVENTS.token,
	BROWSER_CHAT_SSE_EVENTS.thinking,
	BROWSER_CHAT_SSE_EVENTS.toolCall,
	BROWSER_CHAT_SSE_EVENTS.end,
	BROWSER_CHAT_SSE_EVENTS.error,
	BROWSER_CHAT_SSE_EVENTS.replayStart,
	BROWSER_CHAT_SSE_EVENTS.replayEnd,
	BROWSER_CHAT_SSE_EVENTS.waiting,
] as const;

export type BrowserChatSseEventName =
	(typeof BROWSER_CHAT_SSE_EVENT_NAMES)[number];

const BROWSER_CHAT_SSE_EVENT_NAME_SET: ReadonlySet<string> = new Set(
	BROWSER_CHAT_SSE_EVENT_NAMES,
);

export function isBrowserChatSseEventName(
	value: string,
): value is BrowserChatSseEventName {
	return BROWSER_CHAT_SSE_EVENT_NAME_SET.has(value);
}

export interface BrowserChatSseTextPayload {
	text: string;
}

export interface BrowserChatSseToolCallPayload {
	callId?: string;
	name: string;
	input: Record<string, unknown>;
	status: "running" | "done";
	outputSummary?: string | null;
	sourceType?: string | null;
	candidates?: unknown[];
	metadata?: Record<string, string | number | boolean | null>;
}

export interface BrowserChatSseEndPayload {
	thinkingTokenCount?: number;
	responseTokenCount?: number;
	totalTokenCount?: number;
	thinking?: string;
	wasStopped?: boolean;
	userMessageId?: string;
	assistantMessageId?: string;
	modelId?: string | null;
	modelDisplayName?: string | null;
	contextStatus?: unknown;
	contextSources?: unknown;
	activeWorkingSet?: unknown;
	taskState?: unknown;
	contextDebug?: unknown;
	messageEvidence?: unknown;
	generatedFiles?: unknown;
	contextCompressionSnapshots?: unknown;
}

export interface BrowserChatSseErrorPayload {
	message?: string;
	error?: string;
	code?: string;
}

export interface BrowserChatSseReplayStartPayload {
	tokenCount?: number;
	thinkingCount?: number;
	toolCallCount?: number;
	userMessage?: string | null;
}

export type BrowserChatSseEmptyPayload = Record<string, never>;

export interface BrowserChatSsePayloadByEvent {
	token: BrowserChatSseTextPayload;
	thinking: BrowserChatSseTextPayload;
	tool_call: BrowserChatSseToolCallPayload;
	end: BrowserChatSseEndPayload;
	error: BrowserChatSseErrorPayload;
	replay_start: BrowserChatSseReplayStartPayload;
	replay_end: BrowserChatSseEmptyPayload;
	waiting: BrowserChatSseEmptyPayload;
}

export type BrowserChatSsePayload<Name extends BrowserChatSseEventName> =
	BrowserChatSsePayloadByEvent[Name];

export function encodeBrowserChatSseEvent<Name extends BrowserChatSseEventName>(
	event: Name,
	payload: BrowserChatSsePayload<Name>,
): string {
	return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export type DecodedBrowserChatSseJsonEvent = {
	[Name in BrowserChatSseEventName]: {
		event: Name;
		data: BrowserChatSsePayload<Name>;
		rawData: string;
		dataKind: "json";
	};
}[BrowserChatSseEventName];

export type DecodedBrowserChatSseInvalidDataEvent = {
	[Name in BrowserChatSseEventName]: {
		event: Name;
		data: null;
		rawData: string;
		dataKind: "invalid-json";
	};
}[BrowserChatSseEventName];

export type DecodedBrowserChatSseEvent =
	| DecodedBrowserChatSseJsonEvent
	| DecodedBrowserChatSseInvalidDataEvent;

function readSseFieldLine(line: string): { field: string; value: string } {
	const separatorIndex = line.indexOf(":");
	if (separatorIndex === -1) {
		return { field: line, value: "" };
	}

	let value = line.slice(separatorIndex + 1);
	if (value.startsWith(" ")) {
		value = value.slice(1);
	}

	return {
		field: line.slice(0, separatorIndex),
		value,
	};
}

export function decodeBrowserChatSseEventBlock(
	block: string,
): DecodedBrowserChatSseEvent | null {
	let event = "";
	const dataLines: string[] = [];

	for (const rawLine of block.split("\n")) {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (!line || line.startsWith(":")) {
			continue;
		}

		const { field, value } = readSseFieldLine(line);
		if (field === "event") {
			event = value.trim();
			continue;
		}
		if (field === "data") {
			dataLines.push(value);
		}
	}

	if (!event && dataLines.length === 0) {
		return null;
	}

	const rawData = dataLines.join("\n");
	const eventName = event || "message";
	if (!isBrowserChatSseEventName(eventName)) {
		return null;
	}

	try {
		return {
			event: eventName,
			data: JSON.parse(rawData),
			rawData,
			dataKind: "json",
		} as DecodedBrowserChatSseEvent;
	} catch {
		return {
			event: eventName,
			data: null,
			rawData,
			dataKind: "invalid-json",
		};
	}
}

export function decodeBrowserChatSseEvents(
	text: string,
): DecodedBrowserChatSseEvent[] {
	const events: DecodedBrowserChatSseEvent[] = [];
	const blockLines: string[] = [];
	const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

	const flushBlock = () => {
		if (blockLines.length === 0) {
			return;
		}
		const event = decodeBrowserChatSseEventBlock(blockLines.join("\n"));
		blockLines.length = 0;
		if (event) {
			events.push(event);
		}
	};

	for (const line of normalized.split("\n")) {
		if (line === "") {
			flushBlock();
			continue;
		}
		blockLines.push(line);
	}

	flushBlock();
	return events;
}

export const THINKING_OPEN_TAG = "<thinking>";
export const THINKING_CLOSE_TAG = "</thinking>";
export const DEEPSEEK_THINKING_OPEN_TAG = "<think>";
export const DEEPSEEK_THINKING_CLOSE_TAG = "</think>";
export const QWEN_CHATML_THINKING_OPEN_TAG = "<|im_start|>think";
export const QWEN_CHATML_ANALYSIS_OPEN_TAG = "<|im_start|>analysis";
export const QWEN_CHATML_THINKING_CLOSE_TAG = "<|im_end|>";
export const SKILL_CONTROL_ENVELOPE_OPEN_TAG = "<skill_control_v1>";
export const SKILL_CONTROL_ENVELOPE_CLOSE_TAG = "</skill_control_v1>";

const THINKING_OPEN_TAGS = [
	THINKING_OPEN_TAG,
	DEEPSEEK_THINKING_OPEN_TAG,
	QWEN_CHATML_THINKING_OPEN_TAG,
	QWEN_CHATML_ANALYSIS_OPEN_TAG,
] as const;
const THINKING_CLOSE_TAGS = [
	THINKING_CLOSE_TAG,
	DEEPSEEK_THINKING_CLOSE_TAG,
	QWEN_CHATML_THINKING_CLOSE_TAG,
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
	/Found\s+\d+\s+source(?:\(s\)|s)?\s+and\s+\d+\s+evidence(?:\s+snippet(?:s|\(s\))?)?(?:\.|(?=$|\s|[A-Z]|[,;:!?]))/i;
const WEB_TOOL_MARKER_PATTERNS = [
	WEB_RESEARCH_DIAGNOSTIC_RE,
	/(?:search|research)\s+results(?:\s+for)?\s*:/i,
	/(?:fetch_content|get_contents|fetch)\s+(?:results?|output|content)\s*:/i,
] as const;
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
const WEB_TOOL_DIAGNOSTIC_PREFIXES = [
	{ marker: "search results", minPrefixLength: "search".length },
	{ marker: "research results", minPrefixLength: "research".length },
	{ marker: "fetch_content output", minPrefixLength: "fetch_".length },
	{ marker: "get_contents output", minPrefixLength: "get_".length },
	{ marker: "fetch output", minPrefixLength: "fetch".length },
] as const;
const WEB_TOOL_RAW_LINE_PATTERNS = [
	/^(?:\{|\}|\[|\]|,)/,
	/^```(?:json)?\s*$/i,
	/^```\s*$/i,
	/^"?(?:success|name|sourceType|answerBrief|answerBriefMarkdown|query|queries|sources|evidence|diagnostics|instructions|conversationId)"?\s*:/i,
	/^(?:success|name|sourceType|answerBrief|answerBriefMarkdown|query|queries|sources|evidence|diagnostics|instructions|conversationId)\s*:/i,
	/^(?:\d+\.|-\s*)\s*(?:source|title|url|snippet|evidence|content)\b\s*[:=-]/i,
	/^(?:title|url|source|snippet|evidence|content)\s*:/i,
	/^(?:\d+\.|-\s*)\s*\S.{0,180}https?:\/\/\S+/i,
	/^https?:\/\/\S+/i,
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
const LEADING_TOOL_PLANNING_NARRATION_RE =
	/^\s*(?:(?:i(?:'ll| will| am going to)?|let me)\s+(?:search|look up|fetch|check|research|retrieve)\b|röviden,?\s+(?:(?:ki)?keresem|ellenőrzöm|megnézem|átnézem|lekérdezem|lekérdezek|rákeresek|utánanézek)\b|(?:friss\s+adatokat\s+)?keresek\b|(?:ki)?keresem\b|rákeresek\b|lekérdezek\b|lekérdezem\b|ellenőrzöm\b|megnézem\b|átnézem\b|utánanézek\b|(?:két|több)\s+konkrét\b[\s\S]{0,180}\b(?:forrást|forrás)\b[\s\S]{0,180}\blekérdezek\b)[^.!?\n]*(?:[.!?]|(?=\n|$))\s*/i;
const LEADING_FILE_PRODUCTION_REPAIR_NARRATION_RE =
	/^\s*(?:(?:i(?:'ll| will| am going to| need to| should)?|let me)\s+(?:fix|repair|correct|adjust|rewrite|reformat)\b[^.!?\n]{0,220}\b(?:json|document[_\s-]+source|source\s+json|schema|formatting)\b[^.!?\n]*(?:[.!?]|(?=\n|$)))\s*/i;
const TOOL_PLANNING_NARRATION_PREFIX_SCAN_CHARS = 240;
const TOOL_PLANNING_NARRATION_PREFIXES = [
	"i'll search",
	"i will search",
	"i am going to search",
	"let me search",
	"i'll look up",
	"i will look up",
	"let me look up",
	"i'll fetch",
	"i will fetch",
	"let me fetch",
	"friss adatokat keresek",
	"keresek",
	"kikeresem",
	"keresem",
	"rákeresek",
	"lekérdezek",
	"lekérdezem",
	"ellenőrzöm",
	"megnézem",
	"átnézem",
	"utánanézek",
	"röviden kikeresem",
	"röviden, kikeresem",
	"röviden keresek",
	"röviden, keresek",
	"röviden ellenőrzöm",
	"röviden, ellenőrzöm",
	"röviden megnézem",
	"röviden, megnézem",
	"két konkrét",
	"több konkrét",
] as const;
const FILE_PRODUCTION_REPAIR_NARRATION_PREFIXES = [
	"i'll fix",
	"i will fix",
	"i am going to fix",
	"i need to fix",
	"i should fix",
	"let me fix",
	"i'll repair",
	"i will repair",
	"let me repair",
	"i'll correct",
	"i will correct",
	"let me correct",
	"i'll adjust",
	"i will adjust",
	"let me adjust",
	"i'll rewrite",
	"i will rewrite",
	"let me rewrite",
	"i'll reformat",
	"i will reformat",
	"let me reformat",
] as const;
const PLAIN_SOURCE_REFERENCE_MARKER_RE = /[ \t]*【S\d+】[ \t]*/g;
const PLAIN_SOURCE_REFERENCE_MARKER_PREFIX_SCAN_CHARS = 24;
const DOCUMENT_SOURCE_BLOCK_TYPES = [
	"heading",
	"paragraph",
	"list",
	"table",
	"callout",
	"quote",
	"code",
	"divider",
	"image",
	"chart",
] as const;
const DOCUMENT_SOURCE_CONTINUATION_LINE_RE =
	/^(?:(?:\{|\}|\[|\]),?|,|"?(?:documentSource|document_source|program|sourceMode|documentIntent|requestedOutputs|idempotencyKey|requestTitle|templateHint|sourceCode|filename|version|template|type|title|subtitle|summary|blocks|sections|level|text|items|ordered|columns|rows|cells|callout|variant|quote|language|code|caption|chartType|data|labels|datasets|url|alt)"?\s*:)/i;
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
	"the final answer",
	"the answer",
	"based on",
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
const WEB_ASSISTANT_PROSE_BOUNDARY_PATTERNS = [
	"i see",
	"i found",
	"i can",
	"i will",
	"i should",
	"i'll",
	"here's",
	"here is",
	"here are",
	"the final answer",
	"the answer",
	"based on",
	"in short",
	"in summary",
	"to summarize",
	"the key point",
	"magyarországon",
	"ha a vonóhorgos",
	"röviden",
	"a rövid válasz",
	"a válasz",
	"összefoglalva",
] as const;

export interface LeakedToolDiagnosticsState {
	suppressWebToolOutput: boolean;
	pendingWebToolWhitespace: string;
	suppressPythonToolOutput: boolean;
	suppressDocumentSourceOutput: boolean;
	documentSourceJsonDepth: number;
	documentSourceJsonInString: boolean;
	documentSourceJsonEscaped: boolean;
	lastVisibleChar: string;
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
	/<\/?(?:thinking|think)>|<\|im_start\|>\s*(?:think|analysis)?|<\|im_end\|>/gi;

export function stripLeadingResponseMarker(value: string): string {
	return value
		.replace(LEADING_RESPONSE_SPACE_BEFORE_UPPER_RE, "")
		.replace(LEADING_RESPONSE_MARKER_RE, "");
}

function stripTentativeLeadingResponseMarker(value: string): string {
	return value.replace(TENTATIVE_LEADING_RESPONSE_MARKER_RE, "");
}

export function createLeakedToolDiagnosticsState(): LeakedToolDiagnosticsState {
	return {
		suppressWebToolOutput: false,
		pendingWebToolWhitespace: "",
		suppressPythonToolOutput: false,
		suppressDocumentSourceOutput: false,
		documentSourceJsonDepth: 0,
		documentSourceJsonInString: false,
		documentSourceJsonEscaped: false,
		lastVisibleChar: "",
	};
}

function shouldInsertSpaceAfterRemovedSourceMarker(params: {
	previousChar: string;
	nextChar: string;
}): boolean {
	const { previousChar, nextChar } = params;
	if (!previousChar || !nextChar) return false;
	if (/\s/.test(previousChar) || /\s/.test(nextChar)) return false;
	if (/^[.,;:!?)]$/.test(nextChar)) return false;
	if (/^[([{]$/.test(previousChar)) return false;
	return true;
}

export function stripPlainSourceReferenceMarkers(
	value: string,
	state?: LeakedToolDiagnosticsState,
): string {
	let output = "";
	let cursor = 0;
	let previousChar = state?.lastVisibleChar ?? "";

	for (const match of value.matchAll(PLAIN_SOURCE_REFERENCE_MARKER_RE)) {
		const markerStart = match.index ?? 0;
		const rawMatch = match[0];
		const markerEnd = markerStart + rawMatch.length;
		const beforeMarker = value.slice(cursor, markerStart);
		if (beforeMarker) {
			output += beforeMarker;
			previousChar = beforeMarker.at(-1) ?? previousChar;
		}

		const nextChar = value[markerEnd] ?? "";
		if (
			shouldInsertSpaceAfterRemovedSourceMarker({
				previousChar,
				nextChar,
			})
		) {
			output += " ";
			previousChar = " ";
		}

		cursor = markerEnd;
	}

	const remainder = value.slice(cursor);
	if (remainder) {
		output += remainder;
		previousChar = remainder.at(-1) ?? previousChar;
	}

	if (state && output) {
		state.lastVisibleChar = previousChar;
	}

	return output;
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

function findFirstWebToolMarker(
	value: string,
): { index: number; length: number; suppressFollowing: boolean } | null {
	let bestMatch: {
		index: number;
		length: number;
		suppressFollowing: boolean;
	} | null = null;
	for (const pattern of WEB_TOOL_MARKER_PATTERNS) {
		const match = pattern.exec(value);
		if (match?.index !== undefined) {
			const candidate = {
				index: match.index,
				length: match[0].length,
				suppressFollowing: pattern !== WEB_RESEARCH_DIAGNOSTIC_RE,
			};
			if (!bestMatch || candidate.index < bestMatch.index) {
				bestMatch = candidate;
			}
		}
	}
	return bestMatch;
}

function isWebToolRawOutputLine(value: string): boolean {
	const candidate = value.trim();
	if (!candidate) return false;
	return WEB_TOOL_RAW_LINE_PATTERNS.some((pattern) => pattern.test(candidate));
}

function findFirstBoundaryPatternIndex(
	value: string,
	patterns: readonly string[],
): number {
	const lowerValue = value.toLowerCase();
	let bestIndex = -1;

	for (const pattern of patterns) {
		const index = lowerValue.indexOf(pattern);
		if (index === -1) {
			continue;
		}
		bestIndex = bestIndex === -1 ? index : Math.min(bestIndex, index);
	}

	return bestIndex;
}

function findAssistantProseBoundaryIndex(value: string): number {
	return findFirstBoundaryPatternIndex(
		value,
		ASSISTANT_PROSE_BOUNDARY_PATTERNS,
	);
}

function findWebAssistantProseBoundaryIndex(value: string): number {
	return findFirstBoundaryPatternIndex(
		value,
		WEB_ASSISTANT_PROSE_BOUNDARY_PATTERNS,
	);
}

function stripLeakedWebToolDiagnostics(
	value: string,
	state: LeakedToolDiagnosticsState,
): string {
	let output = "";

	for (const { line, lineEnding } of splitPreservingLineEndings(value)) {
		if (state.pendingWebToolWhitespace) {
			if (!line.trim()) {
				state.pendingWebToolWhitespace += lineEnding;
				continue;
			}
			if (isWebToolRawOutputLine(line)) {
				state.suppressWebToolOutput = true;
				continue;
			}
			if (!state.suppressWebToolOutput) {
				output += state.pendingWebToolWhitespace;
				state.pendingWebToolWhitespace = "";
			}
		}

		if (state.suppressWebToolOutput) {
			if (!line.trim() || isWebToolRawOutputLine(line)) {
				continue;
			}
			const boundaryIndex = findWebAssistantProseBoundaryIndex(line);
			if (boundaryIndex < 0 && !startsWithAssistantAnswerBoundary(line)) {
				continue;
			}
			if (state.pendingWebToolWhitespace) {
				if (output || state.lastVisibleChar) {
					output += state.pendingWebToolWhitespace;
				}
				state.pendingWebToolWhitespace = "";
			}
			state.suppressWebToolOutput = false;
			const prose = line.slice(Math.max(0, boundaryIndex));
			const markerIndex = findFirstWebToolMarker(prose)?.index ?? -1;
			if (markerIndex >= 0) {
				const prefix = prose.slice(0, markerIndex);
				if (prefix.trim()) {
					output += prefix;
					if (lineEnding) {
						output += lineEnding;
					}
				}
				state.suppressWebToolOutput = true;
				continue;
			}
			output += prose + lineEnding;
			continue;
		}

		const marker = findFirstWebToolMarker(line);
		if (marker) {
			const prefix = line.slice(0, marker.index);
			const remainder = line.slice(marker.index + marker.length);
			if (prefix.trim()) {
				output += prefix;
			}
			if (remainder.trim() && !isWebToolRawOutputLine(remainder)) {
				output += remainder + lineEnding;
			} else {
				state.suppressWebToolOutput = marker.suppressFollowing;
				state.pendingWebToolWhitespace += lineEnding;
			}
			continue;
		}

		output += line + lineEnding;
	}

	return output;
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

function startsWithAssistantAnswerBoundary(value: string): boolean {
	const firstLine = value.trimStart().split(/\r?\n/, 1)[0] ?? "";
	if (!firstLine.trim() || isWebToolRawOutputLine(firstLine)) {
		return false;
	}

	return (
		findWebAssistantProseBoundaryIndex(firstLine) === 0 ||
		/^\d+[.)]\s+\S/.test(firstLine)
	);
}

function shouldSuppressWebOutputAfterToolPlanning(value: string): boolean {
	const candidate = value.trimStart();
	if (!candidate) {
		return true;
	}

	return !startsWithAssistantAnswerBoundary(candidate);
}

function stripLeadingToolPlanningNarration(
	value: string,
	state?: LeakedToolDiagnosticsState,
): string {
	if (!value.trim()) {
		return value;
	}

	let remainder = value;
	let strippedNarration = false;

	while (remainder.trim()) {
		const match = LEADING_TOOL_PLANNING_NARRATION_RE.exec(remainder);
		if (!match) {
			break;
		}

		const nextRemainder = remainder.slice(match[0].length);
		if (!nextRemainder.trim() && !/[.!?]\s*$/.test(match[0])) {
			break;
		}

		strippedNarration = true;
		remainder = nextRemainder.trimStart() ? nextRemainder.trimStart() : "";
	}

	if (!strippedNarration) {
		return value;
	}

	if (state && shouldSuppressWebOutputAfterToolPlanning(remainder)) {
		state.suppressWebToolOutput = true;
	}

	return remainder;
}

function stripLeadingFileProductionRepairNarration(
	value: string,
	state: LeakedToolDiagnosticsState,
): string {
	if (!value.trim()) {
		return value;
	}

	const match = LEADING_FILE_PRODUCTION_REPAIR_NARRATION_RE.exec(value);
	if (!match) {
		return value;
	}

	state.suppressDocumentSourceOutput = true;
	const remainder = value.slice(match[0].length);
	return remainder.trimStart() ? remainder.trimStart() : "";
}

function getDocumentSourceBlockType(value: string): string | null {
	const match = /(?:^|(?:\[|\{|,)\s*)"type"\s*:\s*"([^"]+)"/i.exec(value);
	return match?.[1]?.toLowerCase() ?? null;
}

function hasDocumentSourceBlockType(value: string): boolean {
	const blockType = getDocumentSourceBlockType(value);
	return Boolean(
		blockType && DOCUMENT_SOURCE_BLOCK_TYPES.some((type) => type === blockType),
	);
}

function looksLikeRawFileProductionPayload(value: string): boolean {
	const hasDocumentSource = /"documentSource"\s*:/i.test(value);
	const hasDocumentStructure =
		/"blocks"\s*:/i.test(value) || /"template"\s*:/i.test(value);
	const hasProgramSource =
		/"program"\s*:/i.test(value) && /"sourceCode"\s*:/i.test(value);
	const hasDocumentSourceRoot =
		/"version"\s*:\s*1\b/i.test(value) && /"blocks"\s*:/i.test(value);

	return (
		(hasDocumentSource && hasDocumentStructure) ||
		hasProgramSource ||
		hasDocumentSourceRoot
	);
}

function findJsonObjectEnd(value: string, startIndex: number): number | null {
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let index = startIndex; index < value.length; index += 1) {
		const char = value[index];

		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === '"') {
				inString = false;
			}
			continue;
		}

		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === "{") {
			depth += 1;
			continue;
		}
		if (char === "}") {
			depth -= 1;
			if (depth === 0) {
				return index + 1;
			}
		}
	}

	return null;
}

function resetDocumentSourceJsonSuppression(state: LeakedToolDiagnosticsState) {
	state.documentSourceJsonDepth = 0;
	state.documentSourceJsonInString = false;
	state.documentSourceJsonEscaped = false;
}

function consumeDocumentSourceJsonLine(
	line: string,
	state: LeakedToolDiagnosticsState,
): { remainder: string; openEnded: boolean } {
	for (let index = 0; index < line.length; index += 1) {
		const char = line[index];

		if (state.documentSourceJsonInString) {
			if (state.documentSourceJsonEscaped) {
				state.documentSourceJsonEscaped = false;
				continue;
			}
			if (char === "\\") {
				state.documentSourceJsonEscaped = true;
				continue;
			}
			if (char === '"') {
				state.documentSourceJsonInString = false;
			}
			continue;
		}

		if (char === '"') {
			state.documentSourceJsonInString = true;
			continue;
		}
		if (char === "{" || char === "[") {
			state.documentSourceJsonDepth += 1;
			continue;
		}
		if (char === "}" || char === "]") {
			if (state.documentSourceJsonDepth > 0) {
				state.documentSourceJsonDepth -= 1;
			}
			if (state.documentSourceJsonDepth === 0) {
				const remainder = line.slice(index + 1).trimStart();
				resetDocumentSourceJsonSuppression(state);
				return { remainder, openEnded: false };
			}
		}
	}

	return {
		remainder: "",
		openEnded:
			state.documentSourceJsonDepth > 0 || state.documentSourceJsonInString,
	};
}

function beginDocumentSourceJsonSuppression(
	line: string,
	state: LeakedToolDiagnosticsState,
): { remainder: string; openEnded: boolean } {
	resetDocumentSourceJsonSuppression(state);
	const startIndex = line.search(/[[{]/);
	if (startIndex === -1) {
		return { remainder: "", openEnded: false };
	}
	return consumeDocumentSourceJsonLine(line.slice(startIndex), state);
}

function isFileProductionPayloadRawOutputPrefix(value: string): boolean {
	if (/^\s/.test(value)) return false;
	const candidate = value.trimStart();
	if (!candidate) return false;

	const compact = candidate.toLowerCase().replace(/\s+/g, "");
	return (
		compact.length >= 4 &&
		[
			'{"documentsource":',
			'{"program":',
			'{"version":1,"blocks"',
			'{"version":1,"template"',
		].some((prefix) => prefix.startsWith(compact) || compact.startsWith(prefix))
	);
}

function stripLeadingDocumentSourceObjectStream(line: string): {
	line: string;
	removed: boolean;
	openEnded: boolean;
} {
	return stripLeadingStructuredPayloadStream(line, {
		allowDocumentBlockObjects: true,
	});
}

function stripLeadingFileProductionPayloadStream(line: string): {
	line: string;
	removed: boolean;
	openEnded: boolean;
} {
	return stripLeadingStructuredPayloadStream(line, {
		allowDocumentBlockObjects: false,
	});
}

function stripLeadingStructuredPayloadStream(
	line: string,
	options: { allowDocumentBlockObjects: boolean },
): {
	line: string;
	removed: boolean;
	openEnded: boolean;
} {
	let cursor = 0;
	let removed = false;

	while (cursor < line.length) {
		while (/[\s,]/.test(line[cursor] ?? "")) {
			cursor += 1;
		}

		if (line[cursor] !== "{") {
			break;
		}

		const objectEnd = findJsonObjectEnd(line, cursor);
		if (objectEnd === null) {
			if (
				(options.allowDocumentBlockObjects &&
					isDocumentSourceRawOutputPrefix(line.slice(cursor))) ||
				isFileProductionPayloadRawOutputPrefix(line.slice(cursor))
			) {
				return { line: "", removed: true, openEnded: true };
			}
			break;
		}

		const objectText = line.slice(cursor, objectEnd);
		if (
			!(
				options.allowDocumentBlockObjects &&
				hasDocumentSourceBlockType(objectText)
			) &&
			!looksLikeRawFileProductionPayload(objectText)
		) {
			break;
		}

		removed = true;
		cursor = objectEnd;
	}

	if (!removed) {
		return { line, removed: false, openEnded: false };
	}

	return {
		line: line.slice(cursor).trimStart(),
		removed: true,
		openEnded: false,
	};
}

function isDocumentSourceContinuationLine(value: string): boolean {
	const candidate = value.trim();
	if (!candidate) return false;
	return (
		DOCUMENT_SOURCE_CONTINUATION_LINE_RE.test(candidate) ||
		hasDocumentSourceBlockType(candidate)
	);
}

function stripLeakedDocumentSourceDiagnostics(
	value: string,
	state: LeakedToolDiagnosticsState,
): string {
	let output = "";

	for (const { line, lineEnding } of splitPreservingLineEndings(value)) {
		if (state.documentSourceJsonDepth > 0) {
			const consumed = consumeDocumentSourceJsonLine(line, state);
			state.suppressDocumentSourceOutput = consumed.openEnded;
			if (!consumed.remainder.trim()) {
				continue;
			}
			state.suppressDocumentSourceOutput = false;
			output += consumed.remainder + lineEnding;
			continue;
		}

		const directPayload = stripLeadingFileProductionPayloadStream(line);
		if (directPayload.removed) {
			if (directPayload.openEnded) {
				const consumed = beginDocumentSourceJsonSuppression(line, state);
				state.suppressDocumentSourceOutput = consumed.openEnded;
			} else {
				resetDocumentSourceJsonSuppression(state);
				state.suppressDocumentSourceOutput = !directPayload.line.trim();
			}
			if (!directPayload.line.trim()) {
				continue;
			}
			output += directPayload.line + lineEnding;
			continue;
		}

		if (state.suppressDocumentSourceOutput) {
			const stripped = stripLeadingDocumentSourceObjectStream(line);
			if (stripped.removed) {
				if (stripped.openEnded) {
					const consumed = beginDocumentSourceJsonSuppression(line, state);
					state.suppressDocumentSourceOutput = consumed.openEnded;
				} else {
					resetDocumentSourceJsonSuppression(state);
					state.suppressDocumentSourceOutput = !stripped.line.trim();
				}
				if (!stripped.line.trim()) {
					continue;
				}
				output += stripped.line + lineEnding;
				continue;
			}

			if (!line.trim() || isDocumentSourceContinuationLine(line)) {
				continue;
			}
			state.suppressDocumentSourceOutput = false;
		}

		output += line + lineEnding;
	}

	return output;
}

export function stripLeakedToolDiagnostics(
	value: string,
	state: LeakedToolDiagnosticsState = createLeakedToolDiagnosticsState(),
): string {
	const withoutLeadingToolNarration = stripLeadingToolPlanningNarration(
		value,
		state,
	);
	const withoutFileProductionRepair = stripLeadingFileProductionRepairNarration(
		withoutLeadingToolNarration,
		state,
	);
	const withoutDocumentSourceDiagnostics = stripLeakedDocumentSourceDiagnostics(
		withoutFileProductionRepair,
		state,
	);
	const withoutWebDiagnostics = stripLeakedWebToolDiagnostics(
		withoutDocumentSourceDiagnostics,
		state,
	);
	const withoutPythonDiagnostics = stripLeakedPythonToolDiagnostics(
		withoutWebDiagnostics,
		state,
	);
	return stripPlainSourceReferenceMarkers(
		withoutPythonDiagnostics,
		state,
	).replace(/[ \t]+\n/g, "\n");
}

function isLeakedToolDiagnosticPrefix(value: string): boolean {
	const candidate = value.trimStart();
	if (!candidate) return false;
	const lowerCandidate = candidate.toLowerCase();

	if (isToolPlanningNarrationPrefix(candidate)) return true;

	const hasKnownWebToolPrefix = WEB_TOOL_DIAGNOSTIC_PREFIXES.some(
		({ marker, minPrefixLength }) => {
			if (lowerCandidate.startsWith(marker)) {
				return true;
			}
			return (
				lowerCandidate.length >= minPrefixLength &&
				marker.startsWith(lowerCandidate)
			);
		},
	);
	if (hasKnownWebToolPrefix) return true;

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

function isToolPlanningNarrationPrefix(value: string): boolean {
	if (/^\s/.test(value)) return false;
	const candidate = value.trimEnd().toLowerCase();
	if (!candidate) return false;
	if (
		candidate.length >= 2 &&
		TOOL_PLANNING_NARRATION_PREFIXES.some((prefix) =>
			prefix.startsWith(candidate),
		)
	) {
		return true;
	}
	if (candidate.length < 4) return false;
	if (LEADING_TOOL_PLANNING_NARRATION_RE.test(candidate)) return true;

	return TOOL_PLANNING_NARRATION_PREFIXES.some(
		(prefix) => prefix.startsWith(candidate) || candidate.startsWith(prefix),
	);
}

function isFileProductionRepairNarrationPrefix(value: string): boolean {
	if (/^\s/.test(value)) return false;
	const candidate = value.toLowerCase();
	if (!candidate) return false;
	if (candidate.length < 4) return false;
	if (LEADING_FILE_PRODUCTION_REPAIR_NARRATION_RE.test(candidate)) return true;

	return FILE_PRODUCTION_REPAIR_NARRATION_PREFIXES.some(
		(prefix) => prefix.startsWith(candidate) || candidate.startsWith(prefix),
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

function isPlainSourceReferenceMarkerPrefix(value: string): boolean {
	return /^[ \t]*【(?:S\d*)?$/i.test(value);
}

function isDocumentSourceRawOutputPrefix(value: string): boolean {
	if (/^\s/.test(value)) return false;
	const candidate = value.trimStart();
	if (!candidate) return false;

	const compact = candidate.toLowerCase().replace(/\s+/g, "");
	if (
		compact.length >= 1 &&
		(['{"type":', '[{"type":'] as const).some((prefix) =>
			prefix.startsWith(compact),
		)
	) {
		return true;
	}

	const partialTypeMatch = /^(?:\[\s*)?\{\s*"type"\s*:\s*"([^"]*)$/i.exec(
		candidate,
	);
	if (partialTypeMatch) {
		const typePrefix = partialTypeMatch[1].toLowerCase();
		return DOCUMENT_SOURCE_BLOCK_TYPES.some((type) =>
			type.startsWith(typePrefix),
		);
	}

	return hasDocumentSourceBlockType(candidate);
}

export function getLeakedToolDiagnosticPrefixLength(value: string): number {
	const scanStart = Math.max(
		0,
		value.length -
			Math.max(
				WEB_RESEARCH_DIAGNOSTIC_PREFIX_SCAN_CHARS,
				PYTHON_TOOL_DIAGNOSTIC_PREFIX_SCAN_CHARS,
				TOOL_PLANNING_NARRATION_PREFIX_SCAN_CHARS,
				PLAIN_SOURCE_REFERENCE_MARKER_PREFIX_SCAN_CHARS,
			),
	);
	for (let index = scanStart; index < value.length; index += 1) {
		const suffix = value.slice(index);
		const trimmedSuffix = suffix.trimEnd().toLowerCase();
		if (
			index === 0 &&
			trimmedSuffix.length === 1 &&
			TOOL_PLANNING_NARRATION_PREFIXES.some((prefix) =>
				prefix.startsWith(trimmedSuffix),
			)
		) {
			return value.length - index;
		}
		if (
			isLeakedToolDiagnosticPrefix(suffix) ||
			isFileProductionRepairNarrationPrefix(suffix) ||
			isLeakedPythonToolDiagnosticPrefix(suffix) ||
			isPlainSourceReferenceMarkerPrefix(suffix) ||
			isFileProductionPayloadRawOutputPrefix(suffix)
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

	const prioritized: Array<{
		text: string;
		priority: number;
		headerTitle: string;
		headerIcon: string;
	}> = [];

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
			const headerIcon =
				typeof header?.icon === "string"
					? header.icon.toLowerCase().trim()
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

			prioritized.push({ text, priority, headerTitle, headerIcon });
		}
	}

	if (prioritized.length === 0) {
		return "";
	}

	const highestPriority = prioritized.reduce(
		(best, entry) => Math.max(best, entry.priority),
		0,
	);

	const candidates = prioritized.filter(
		(entry) => entry.priority === highestPriority,
	);

	if (highestPriority > 1) {
		const assistantOutputs = candidates.filter(
			(entry) => !looksLikeIntermediateToolContentBlock(entry),
		);
		if (assistantOutputs.length !== candidates.length) {
			return (assistantOutputs.at(-1)?.text ?? "").trim();
		}
	}

	return candidates
		.map((entry) => entry.text)
		.join("\n")
		.trim();
}

function looksLikeIntermediateToolContentBlock(entry: {
	text: string;
	headerTitle: string;
	headerIcon: string;
}): boolean {
	const headerHint = `${entry.headerTitle} ${entry.headerIcon}`;
	if (/\b(?:search|tool|retriever|retrieval|web|globe)\b/i.test(headerHint)) {
		return true;
	}
	return (
		looksLikeToolPlanningNarration(entry.text) ||
		looksLikeRawToolContentBlock(entry.text)
	);
}

function looksLikeToolPlanningNarration(value: string): boolean {
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > 360) {
		return false;
	}

	return LEADING_TOOL_PLANNING_NARRATION_RE.test(trimmed);
}

function looksLikeRawToolContentBlock(value: string): boolean {
	const trimmed = value.trim();
	if (!trimmed) {
		return false;
	}
	if (/^(?:\{|\[)[\s\S]*(?:\}|\])$/.test(trimmed)) {
		return true;
	}

	const lines = trimmed
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length < 6) {
		return false;
	}

	const rawLineHits = lines.filter(isWebToolRawOutputLine).length;
	if (rawLineHits >= 3) {
		return true;
	}

	const chromeHits = lines.filter(isLikelyWebPageChromeLine).length;
	const shortLineRatio =
		lines.filter((line) => line.length <= 56).length / lines.length;
	const dateLineHits = lines.filter((line) =>
		/^20\d{2}[-./]\d{2}[-./]\d{2}$/.test(line),
	).length;

	return (
		chromeHits >= 3 ||
		(lines.length >= 12 && chromeHits >= 2 && shortLineRatio >= 0.55) ||
		(lines.length >= 18 && dateLineHits >= 2 && shortLineRatio >= 0.5)
	);
}

function isLikelyWebPageChromeLine(value: string): boolean {
	const normalized = value.toLowerCase().trim();
	return /^(?:search|home|menu|contact|login|log in|sign in|register|favorites|cart|basket|orders|shop|webshop|categories|previous article|next article|privacy policy|terms|terms and conditions|cookie settings|accept|facebook|copyright|impressum|keresés|főoldal|otthon|menü|kapcsolat|belépés|regisztráció|kedvencek|kosár|rendeléseim|webshop|kategóriák|címlapon|előző cikk|következő cikk|adatvédelmi nyilatkozat|adatkezelési beállítások|ászf|sütik|elfogadom|impresszum)$/i.test(
		normalized,
	);
}

function isReasoningTextPartType(value: unknown): boolean {
	if (typeof value !== "string") {
		return false;
	}

	return ["reasoning", "reasoning_text", "summary_text"].includes(
		value.toLowerCase(),
	);
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

			if (isReasoningTextPartType(partRecord.type)) {
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

function getTextFromArrayItems(value: unknown[]): string {
	return value
		.map((item) => {
			if (typeof item === "string") {
				return item;
			}

			const itemRecord = getNestedObject(item);
			if (itemRecord && isReasoningTextPartType(itemRecord.type)) {
				return "";
			}

			return getTextContent(item);
		})
		.filter(Boolean)
		.join("");
}

function getTextContent(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}

	if (Array.isArray(value)) {
		return getTextFromArrayItems(value);
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

	if ("content_blocks" in payload) {
		const contentBlocksText = getTextFromContentBlocks(payload.content_blocks);
		if (contentBlocksText) {
			return contentBlocksText;
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
