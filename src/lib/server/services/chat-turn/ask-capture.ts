import type { ModelMessage, ToolResultPart } from "ai";
import type { ToolCallEntry } from "$lib/server/services/messages-types";
import type { NormalChatModelRunProvider } from "$lib/server/services/normal-chat-model";
import type { AskAnswerResult } from "$lib/server/services/normal-chat-tools/ask-user";
import type { ToolResultObservation } from "$lib/server/services/url-provenance";
import { providerRunsLocally } from "$lib/server/services/vision/provider-vision";
import { isAskToolName } from "$lib/shared/ask-user";
import { isConnectionToolName } from "$lib/utils/tool-calls";
import {
	type NormalChatContinuationSnapshot,
	parseNormalChatContinuation,
	serializeNormalChatContinuation,
} from "../normal-chat-model";
import type { AskCapturedResult, AskResumeCapture } from "./ask-questions";
import {
	buildHistoryToolDigest,
	flattenedAskLines,
	flattenedToolLine,
	type HistoryToolDigest,
	isHistoryToolDigest,
} from "./conversation-history";
import { normalizeVisibleAssistantText } from "./thinking-normalizer";

/**
 * What a resume needs of a reply that paused on `ask_user` ("Ask me first",
 * docs/plans/ask-me-first, design 5.4 and 5.5), as `stampAskQuestion` keeps it.
 * Pure: it reads what the turn hands it and writes nothing.
 *
 * `messages` follows the person's message in the model input. It is what the run
 * was given after that message (`continuationGiven`: the page the server fetched
 * before the model ran and, on a later segment, the earlier segments and their
 * answers) and then what the run said and read (`responseMessages`, the SDK's
 * cumulative `response.messages`, tool results whole).
 *
 * `results` has one row for each tool result in `messages`, in the order the
 * results come, naming the tool it came from and carrying its digest, so a resume
 * can still gate the whole result for each model attempt (a cloud model is never
 * sent what a local one summarised). What the run was given (`continuationGiven`)
 * already has its rows in the capture of the segment before (`priorResults`):
 * they stand as they were and are not read again, because `toolCalls` holds this
 * run's calls alone, and only the first segment's page has none yet. Every result
 * of the run itself (`responseMessages`) gets a row of its own from this run's
 * calls, even when its call id repeats one an earlier row carries: a provider may
 * reuse an id from one response to the next, and a result classed by the earlier
 * row would be classed by another tool's. A result whose call left no record
 * still gets a plain row, so no result in `messages` is left without one to gate.
 * An ask call has no row: its result is the pause and then the person's answer,
 * not data of a tool. Every result of the `ask_user` tool is told by its tool and
 * never by its call id: the run's own pause, an answered ask in what the run was
 * given (its answer holds the model's labels, which ADR-0068 does not count as a
 * tool's results) and a card the tool refused all go without a row, while a
 * provider may reuse any call id, the ask's included, for a connector's result,
 * which is data and has one. A result finds the call that made it by id and tool
 * together for the same reason.
 */
export function buildAskResumeCapture(p: {
	continuationGiven: ModelMessage[];
	responseMessages: ModelMessage[];
	toolCalls: ToolCallEntry[];
	priorResults: AskCapturedResult[];
	snapshot?: NormalChatContinuationSnapshot | null;
}): AskResumeCapture {
	const messages = [...p.continuationGiven, ...p.responseMessages];

	const recorded = new Map<string, ToolCallEntry>();
	for (const entry of p.toolCalls) {
		if (entry.callId) recorded.set(resultKey(entry.callId, entry.name), entry);
	}
	const rowFor = (part: ToolResultPart): AskCapturedResult => {
		const entry = recorded.get(resultKey(part.toolCallId, part.toolName));
		return {
			toolCallId: part.toolCallId,
			toolName: part.toolName,
			localDistilled: entry?.metadata?.localDistilled === true,
			digest: buildHistoryToolDigest(entry ?? { status: "done" }),
		};
	};
	const isAsk = (part: ToolResultPart) => isAskToolName(part.toolName);

	const results = [...p.priorResults];
	// What the run was given has its rows already: the capture of the segment before
	// made one for each result, in this order. For each call id and tool name, as
	// many results as there are rows are covered; any more (the first segment's page
	// has no row yet) get theirs here. Counted, because an id may come back.
	const covered = new Map<string, number>();
	for (const row of p.priorResults) {
		const key = resultKey(row.toolCallId, row.toolName);
		covered.set(key, (covered.get(key) ?? 0) + 1);
	}
	const given = new Map<string, number>();
	for (const part of toolResultParts(p.continuationGiven)) {
		if (isAsk(part)) continue;
		const key = resultKey(part.toolCallId, part.toolName);
		const nth = given.get(key) ?? 0;
		given.set(key, nth + 1);
		if (nth < (covered.get(key) ?? 0)) continue;
		results.push(rowFor(part));
	}
	for (const part of toolResultParts(p.responseMessages)) {
		if (!isAsk(part)) results.push(rowFor(part));
	}

	return p.snapshot
		? {
				v: 2,
				messages,
				results,
				continuation: serializeNormalChatContinuation(p.snapshot),
			}
		: { v: 1, messages, results };
}

/** The tool-result parts of the tool messages, in order. */
function toolResultParts(messages: readonly ModelMessage[]): ToolResultPart[] {
	return messages.flatMap((message) =>
		message.role === "tool"
			? message.content.filter(
					(part): part is ToolResultPart => part.type === "tool-result",
				)
			: [],
	);
}

/**
 * What a tool result and its row have in common: the call's id and the tool's
 * name. The id alone does not say which result a row is of, because a provider may
 * reuse one from a response to the next; with the name, and the order among those
 * that share both, it does.
 */
function resultKey(toolCallId: string, toolName: string): string {
	return JSON.stringify([toolCallId, toolName]);
}

/**
 * Whether a part of a tool message is the result of the ask call `askToolCallId`:
 * its call id and its tool together, since a provider may reuse an id for the
 * result of another tool (a connector's), which is not the ask's.
 */
function isResultOfAsk(
	part: Extract<ModelMessage, { role: "tool" }>["content"][number],
	askToolCallId: string,
): part is ToolResultPart {
	return (
		part.type === "tool-result" &&
		part.toolCallId === askToolCallId &&
		isAskToolName(part.toolName)
	);
}

/**
 * Whether `messages` (what the run said and read, as of its last finished step)
 * hold a tool result for the ask call. A resume answers that result: it swaps
 * the person's answer in for whatever the result said, so a capture without it
 * cannot be answered. A run that ends with a `finish` has it, because the SDK
 * finishes the last step's callback first; a stream that closed without one can
 * end before the step that asked was captured. Such a turn is not paused.
 */
export function holdsAskResult(
	messages: ModelMessage[],
	askToolCallId: string,
): boolean {
	return messages.some(
		(message) =>
			message.role === "tool" &&
			message.content.some((part) => isResultOfAsk(part, askToolCallId)),
	);
}

/**
 * What a resume sends after the person's message: the captured messages with the
 * result of the ask call `askToolCallId`, which said the reply paused, replaced by
 * the person's answer (`buildAskAnswerRecord`'s result). Every other part stays as
 * it was, the tool results whole: a result of another tool that happens to share
 * the ask's call id is not the ask's. The run stopped on its ask, so the pause is
 * the newest result under that id and tool; an earlier segment's answered ask may
 * have the same id and keeps its answer.
 *
 * Never changes the capture: a message that changes is a new one. A capture that
 * holds no result of the ask comes back as it is (it cannot be answered: the
 * caller asks `holdsAskResult` first).
 */
export function buildAskResumeContinuation(
	capture: AskResumeCapture,
	askToolCallId: string,
	result: AskAnswerResult,
): ModelMessage[] {
	let at: { message: number; part: number } | null = null;
	for (const [m, message] of capture.messages.entries()) {
		if (message.role !== "tool") continue;
		for (const [i, part] of message.content.entries()) {
			if (isResultOfAsk(part, askToolCallId)) at = { message: m, part: i };
		}
	}
	const target = at;
	if (target === null) return [...capture.messages];
	return capture.messages.map((message, m) => {
		if (m !== target.message || message.role !== "tool") return message;
		return {
			...message,
			content: message.content.map((part, i) =>
				i === target.part && part.type === "tool-result"
					? { ...part, output: { type: "json" as const, value: result } }
					: part,
			),
		};
	});
}

/** Exact private continuation. Only the human answer replaces the recorded pause. */
export function buildAskResumeSnapshot(
	capture: AskResumeCapture,
	askToolCallId: string,
	result: AskAnswerResult,
): NormalChatContinuationSnapshot | undefined {
	if (capture.v !== 2 || !capture.continuation) return undefined;
	const snapshot = parseNormalChatContinuation(capture.continuation);
	for (let n = snapshot.steps.length - 1; n >= 0; n--) {
		const step = snapshot.steps[n];
		if (!holdsAskResult(step.response, askToolCallId)) continue;
		step.response = buildAskResumeContinuation(
			{ v: 1, messages: step.response, results: [] },
			askToolCallId,
			result,
		);
		const execution = snapshot.executions.findLast(
			(e) =>
				e.segmentId === step.segmentId &&
				e.stepId === step.stepId &&
				e.callId === askToolCallId &&
				isAskToolName(e.toolName),
		);
		if (execution) {
			execution.output = result;
			execution.modelOutput = { type: "json", value: result };
		}
		return snapshot;
	}
	throw new Error("Exact ask capture has no matching pause");
}

/**
 * What a resume is run from ("Ask me first"): the claimed question and the claim
 * that holds it, the row that asked and the call that asked, the person's message
 * the reply answers, and what the run is carried on from. The entry
 * (`ask-resume.ts`) makes it; the orchestrator, completion and finalize read it.
 * It lives here so none of them has to import the entry, which imports the
 * orchestrator's types.
 */
export type AskResumeInput = {
	/** Validated human depth selection overrides captured defaults only when present. */
	depthOverride?: boolean;
	snapshot?: NormalChatContinuationSnapshot;
	questionId: string;
	/** The token of the won claim: release and settle act only for it (ask-questions.ts). */
	claim: string;
	/** The row that asked, which the segment this resume saves continues. */
	askedMessageId: string;
	askToolCallId: string;
	/** The person's message: the history ends before it, and the reply is sent after it. */
	userMessageId: string;
	/** What follows the person's message: the reply so far, the answer as the ask's result. */
	continuation: ModelMessage[];
	/** One row per tool result in `continuation`, to gate it for each model attempt. */
	capturedResults: AskCapturedResult[];
	/** The words the person typed into the answers of this reply (never a label). */
	userTexts: string[];
	/** The tool calls stored on the reply's segments so far, for the citation gate. */
	priorSegmentToolCalls: ToolCallEntry[];
	/** Whether the person keeps connector data on their own device (asked once). */
	keepConnectorDataLocal: boolean;
	/** What the asking row's ask call keeps of the answer once this segment is saved. */
	answerDigest: { outputSummary: string; resultDigest: string };
};

// --- what a resume does with the capture ------------------------------------
//
// A resume's original messages are the captured ones (design 5.5), and each of
// the three below turns them into what one part of the run needs: the gate for
// each model attempt, the seeds of the turn's address check, and the text form
// for a provider that takes no tool messages. All pure.

type ToolOutput = ToolResultPart["output"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What a connector result is sent as when no captured row says what it was: the
 * gate fails closed, so a result it cannot place is withheld, not passed. Ruling
 * 79: ASCII English, and shaped as a digest so a second pass leaves it be.
 */
const WITHHELD_CONNECTOR_DIGEST: HistoryToolDigest = {
	ok: false,
	summary:
		"The details of this result stay on the person's own device and were not sent to this model.",
};

// Every key a `HistoryToolDigest` has. Typed as a record of the type's keys, so a
// key added to the type does not compile until it is listed here, and the exact
// check below can never silently turn a digest with the new key into "not one".
const DIGEST_KEY_LIST: Record<keyof HistoryToolDigest, true> = {
	ok: true,
	summary: true,
	detail: true,
	sources: true,
};
const DIGEST_KEYS: ReadonlySet<string> = new Set(Object.keys(DIGEST_KEY_LIST));

/**
 * A digest and nothing but one: `isHistoryToolDigest` does not look at other keys,
 * and a connector's payload that happens to have an `ok` and a `summary` among
 * its fields is its data, not a digest of it.
 */
function isExactDigest(value: unknown): value is HistoryToolDigest {
	return (
		isHistoryToolDigest(value) &&
		Object.keys(value).every((key) => DIGEST_KEYS.has(key))
	);
}

/**
 * The gate a resume gives its model run for each attempt: an attempt on a model
 * that is not on the person's own box is not sent what their setting keeps local
 * (the existing connector rule, design 5.5; `normal-chat-tools/connector-distill.ts`).
 *
 * It reads each tool result by its own tool name (`isConnectionToolName`), never
 * by the row an id happens to match: the whole outbound list passes through it,
 * the history's tool results reuse their calls' stored ids, and a provider may
 * reuse an id from one response to the next. When the person keeps connector data
 * local and the attempt's provider does not run locally, a connector result goes
 * as follows.
 * - Already a digest (the history's own tool results are): it stays.
 * - The rows for its call id and tool cover every such result in the list (as many
 *   rows as results, not counting digests) and every row says a local model
 *   summarised it: it stays, a cloud run having been handed that summary too. A
 *   row cannot vouch for a result it was not made for, so with fewer rows than
 *   results, a summary row and a raw result under the same id are not both left.
 * - Otherwise it is sent as the digest of the row that is its own, the nth row of
 *   that id and tool for the nth such result (the rows come in the order of the
 *   results), else of any such row that is not a summary.
 * - No row has its id and tool: it is sent as a note that its details stay on the
 *   person's device. The gate fails closed.
 * The same attempts are not sent what the segment thought either. A local model's
 * thinking can quote the mail, the file or the photo it read, and the capture keeps
 * it (the SDK's reasoning parts, and thinking a provider left in the text), where a
 * stored reply's history never replays any: so the assistant messages lose their
 * reasoning parts and the thinking in their text (`withoutThinking`), and a part or
 * a message left empty goes.
 * Everything else stays as captured: a local attempt, a person who does not keep
 * connector data local, and any result that is not a connector's. Decided for each
 * attempt with that attempt's provider, never once for the run.
 *
 * Never changes the array or the messages it is given (the model run may hand it
 * the original list): a message that changes is a new one, and the list itself is
 * returned when nothing changed.
 */
export function gateCapturedConnectorResults(p: {
	results: readonly AskCapturedResult[];
	keepConnectorDataLocal: boolean;
}): (
	messages: ModelMessage[],
	provider: NormalChatModelRunProvider,
) => ModelMessage[] {
	const rowsByKey = new Map<string, AskCapturedResult[]>();
	for (const row of p.results) {
		const key = resultKey(row.toolCallId, row.toolName);
		rowsByKey.set(key, [...(rowsByKey.get(key) ?? []), row]);
	}
	return (messages, provider) => {
		if (!p.keepConnectorDataLocal || providerRunsLocally(provider)) {
			return messages;
		}
		const state: GateState = {
			rowsByKey,
			counts: countResultsToPlace(messages),
			nth: new Map<string, number>(),
		};
		let changed = false;
		const gated: ModelMessage[] = [];
		for (const message of messages) {
			const sent = gateMessage(message, state);
			if (sent !== message) changed = true;
			if (sent !== null) gated.push(sent);
		}
		return changed ? gated : messages;
	};
}

/** What the gate reads, shared by the parts of one list: the rows, how many results each id and tool has to place, and how many it has placed. */
type GateState = {
	rowsByKey: ReadonlyMap<string, readonly AskCapturedResult[]>;
	counts: ReadonlyMap<string, number>;
	nth: Map<string, number>;
};

function isDigestOutput(output: ToolOutput): boolean {
	return output.type === "json" && isExactDigest(output.value);
}

/**
 * How many results the gate has to place under each call id and tool: the
 * connector results of the list that are not already digests (a digest needs no
 * row, and cannot leak).
 */
function countResultsToPlace(
	messages: readonly ModelMessage[],
): Map<string, number> {
	const counts = new Map<string, number>();
	for (const message of messages) {
		if (message.role !== "tool") continue;
		for (const part of message.content) {
			if (
				part.type !== "tool-result" ||
				!isConnectionToolName(part.toolName) ||
				isDigestOutput(part.output)
			) {
				continue;
			}
			const key = resultKey(part.toolCallId, part.toolName);
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
	}
	return counts;
}

/**
 * What an attempt is sent of one message: the message itself when the gate leaves
 * it, a new one when it changes it, and null when nothing of it is left to send.
 */
function gateMessage(
	message: ModelMessage,
	state: GateState,
): ModelMessage | null {
	if (message.role === "assistant") return withoutThinking(message);
	if (message.role !== "tool") return message;
	let changed = false;
	const content = message.content.map(
		(part): (typeof message.content)[number] => {
			if (part.type !== "tool-result" || !isConnectionToolName(part.toolName)) {
				return part;
			}
			const output = gatedOutput(part, state);
			if (output === null) return part;
			changed = true;
			return { ...part, output };
		},
	);
	return changed ? { ...message, content } : message;
}

type AssistantMessage = Extract<ModelMessage, { role: "assistant" }>;
type AssistantPart = Exclude<AssistantMessage["content"], string>[number];

/**
 * An assistant message without its thinking: the reasoning parts gone, and the
 * thinking a provider left in a text part cut out of it (`normalizeVisibleAssistantText`,
 * the one stripper the stored reply's text goes through). The message itself when
 * it holds none, a new one when it does, and null when nothing is left of it. A
 * text only changes when thinking was in it, so a trailing space is no change.
 */
function withoutThinking(message: AssistantMessage): ModelMessage | null {
	if (typeof message.content === "string") {
		const text = visibleText(message.content);
		if (text === message.content) return message;
		return text === "" ? null : { ...message, content: text };
	}
	let changed = false;
	const content = message.content.flatMap((part): AssistantPart[] => {
		if (part.type === "reasoning") {
			changed = true;
			return [];
		}
		if (part.type !== "text") return [part];
		const text = visibleText(part.text);
		if (text === part.text) return [part];
		changed = true;
		return text === "" ? [] : [{ ...part, text }];
	});
	if (!changed) return message;
	return content.length === 0 ? null : { ...message, content };
}

/** A text without the thinking in it; the text itself when it holds none. */
function visibleText(text: string): string {
	const visible = normalizeVisibleAssistantText(text);
	return visible === text.trim() ? text : visible;
}

/** What a connector result is sent as instead of its output; null when it stays. */
function gatedOutput(
	part: ToolResultPart,
	{ rowsByKey, counts, nth }: GateState,
): ToolOutput | null {
	if (isDigestOutput(part.output)) return null;
	const key = resultKey(part.toolCallId, part.toolName);
	const index = nth.get(key) ?? 0;
	nth.set(key, index + 1);
	const rows = rowsByKey.get(key) ?? [];
	// Summaries stand for results only as far as there are rows for them: a result
	// the rows run out for (a raw read under a summary's id) is not one of them.
	const covered = rows.length > 0 && rows.length >= (counts.get(key) ?? 0);
	if (covered && rows.every((row) => row.localDistilled)) return null;
	const own = rows[index];
	const row =
		own && !own.localDistilled
			? own
			: rows.find((candidate) => !candidate.localDistilled);
	return {
		type: "json",
		value: row ? row.digest : { ...WITHHELD_CONNECTOR_DIGEST },
	};
}

/** What the model was handed as a tool's result, for the address check; nothing for a failure. */
function outputPayload(output: ToolOutput): unknown {
	switch (output.type) {
		case "json":
		case "text":
		case "content":
			return output.value;
		default:
			// An error, or a call that was not run: the turn's own check is told of
			// neither while a turn runs (executeToolWithEnvelope), so not here.
			return undefined;
	}
}

/**
 * The tool results of a paused segment as the address check of the run that
 * carries it on has to hear them (`createNormalChatTools`' `resumeProvenance`):
 * the results the model was handed are still tools' results (ADR-0068), so an
 * address in them is one the run may open.
 *
 * Each captured result becomes the observation the turn that made it would have
 * noted: the payload as the model received it, the call's input (an address the
 * model wrote into it never counts), and the sources the call returned, from its
 * digest. A result a local model summarised carries the mark, so only those
 * sources count. A row whose result is no longer in the messages is still told by
 * its sources. The ask call has no row: its result is the pause and then the
 * person's answer, and the person's own words reach the check as `userTexts`.
 * (A `read_generated_file` row cannot say whether the file was the person's own,
 * so it counts for nothing: the safe side.)
 *
 * A row finds its result and its call by id and tool name, and by order among
 * those that share both (the rows come in the order of the results): a provider
 * may reuse an id from one response to the next, and a row of one segment must not
 * be told of another segment's payload, whose summary a local model wrote.
 */
export function capturedProvenanceResults(
	capture: AskResumeCapture,
): ToolResultObservation[] {
	const inputs = new Map<string, unknown[]>();
	const outputs = new Map<string, ToolOutput[]>();
	const add = <T>(into: Map<string, T[]>, key: string, value: T) => {
		into.set(key, [...(into.get(key) ?? []), value]);
	};
	for (const message of capture.messages) {
		if (message.role === "assistant" && typeof message.content !== "string") {
			for (const part of message.content) {
				if (part.type === "tool-call") {
					add(inputs, resultKey(part.toolCallId, part.toolName), part.input);
				}
			}
		} else if (message.role === "tool") {
			for (const part of message.content) {
				if (part.type === "tool-result") {
					add(outputs, resultKey(part.toolCallId, part.toolName), part.output);
				}
			}
		}
	}
	const nth = new Map<string, number>();
	return capture.results.map((row) => {
		const key = resultKey(row.toolCallId, row.toolName);
		const index = nth.get(key) ?? 0;
		nth.set(key, index + 1);
		const output = outputs.get(key)?.[index];
		const input = inputs.get(key)?.[index];
		return {
			toolName: row.toolName,
			payload: output === undefined ? undefined : outputPayload(output),
			entry: {
				input: isRecord(input) ? input : {},
				candidates: (row.digest.sources ?? []).flatMap((source, index) =>
					source.url
						? [
								{
									id: `${row.toolCallId}:${index}`,
									title: source.title,
									url: source.url,
									sourceType: "tool" as const,
								},
							]
						: [],
				),
				...(row.localDistilled ? { metadata: { localDistilled: true } } : {}),
			},
		};
	});
}

/** A tool result said as a digest: already one, or the text of what the model was handed. */
function digestOfOutput(output: ToolOutput): HistoryToolDigest {
	if (output.type === "json" && isExactDigest(output.value)) {
		return output.value;
	}
	switch (output.type) {
		case "text":
			return { ok: true, summary: output.value };
		case "error-text":
			return { ok: false, summary: output.value };
		case "execution-denied":
			return {
				ok: false,
				summary: output.reason ?? "The tool call was not run.",
			};
		case "error-json":
			return { ok: false, summary: JSON.stringify(output.value) ?? "" };
		default:
			// json and content
			return { ok: true, summary: JSON.stringify(output.value) ?? "" };
	}
}

/**
 * The continuation of a reply that asked, said as text, for a provider that takes
 * no tool messages (`resolveHistoryToolMessagesMode` says "flatten"): one
 * assistant message of lines, in the order the reply happened. It says what a
 * stored reply says in that mode (`conversation-history.ts`): `[used <tool>: ...]`
 * for a call and its result, `[asked the user: ...]` and `[the user's answer: ...]`
 * for the ask, each within the length a flattened line keeps, and the assistant's
 * own words as they are. Hidden reasoning is dropped, as the history drops it. A
 * message that is neither the assistant's nor a tool's stays where it was.
 *
 * Ruling 79: the scaffold is ASCII English; the questions and the answer are data.
 * What a result says is cut from the result the model was handed, so a provider
 * that gets this must be given the continuation after the attempt gate
 * (`gateCapturedConnectorResults`) has run.
 */
export function renderAskContinuationAsText(
	messages: ModelMessage[],
): ModelMessage[] {
	const inputs = new Map<string, Record<string, unknown> | undefined>();
	const out: ModelMessage[] = [];
	let lines: string[] = [];
	const flush = () => {
		if (lines.length === 0) return;
		out.push({ role: "assistant", content: lines.join("\n") });
		lines = [];
	};
	const say = (text: string) => {
		const trimmed = text.trim();
		if (trimmed) lines.push(trimmed);
	};
	for (const message of messages) {
		if (message.role === "assistant") {
			if (typeof message.content === "string") {
				say(message.content);
				continue;
			}
			for (const part of message.content) {
				if (part.type === "text") say(part.text);
				else if (part.type === "tool-call") {
					inputs.set(part.toolCallId, isRecord(part.input) ? part.input : {});
				}
			}
		} else if (message.role === "tool") {
			for (const part of message.content) {
				if (part.type !== "tool-result") continue;
				const digest = digestOfOutput(part.output);
				if (isAskToolName(part.toolName)) {
					lines.push(
						...flattenedAskLines(inputs.get(part.toolCallId), digest.summary),
					);
				} else {
					lines.push(flattenedToolLine(part.toolName, digest));
				}
			}
		} else {
			flush();
			out.push(message);
		}
	}
	flush();
	return out;
}
