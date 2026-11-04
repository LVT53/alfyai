import type { ModelMessage, ToolResultPart } from "ai";
import type { ToolCallEntry } from "$lib/server/services/messages-types";
import type { NormalChatModelRunProvider } from "$lib/server/services/normal-chat-model";
import type { ToolResultObservation } from "$lib/server/services/url-provenance";
import { providerRunsLocally } from "$lib/server/services/vision/provider-vision";
import { isAskToolName } from "$lib/shared/ask-user";
import { isConnectionToolName } from "$lib/utils/tool-calls";
import type { AskCapturedResult, AskResumeCapture } from "./ask-questions";
import {
	buildHistoryToolDigest,
	flattenedAskLines,
	flattenedToolLine,
	type HistoryToolDigest,
	isHistoryToolDigest,
} from "./conversation-history";

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
 * not data of a tool.
 */
export function buildAskResumeCapture(p: {
	continuationGiven: ModelMessage[];
	responseMessages: ModelMessage[];
	toolCalls: ToolCallEntry[];
	priorResults: AskCapturedResult[];
	askToolCallId: string;
}): AskResumeCapture {
	const messages = [...p.continuationGiven, ...p.responseMessages];

	const recorded = new Map<string, ToolCallEntry>();
	for (const entry of p.toolCalls) {
		if (entry.callId) recorded.set(entry.callId, entry);
	}
	const rowFor = (part: ToolResultPart): AskCapturedResult => {
		const entry = recorded.get(part.toolCallId);
		return {
			toolCallId: part.toolCallId,
			toolName: part.toolName,
			localDistilled: entry?.metadata?.localDistilled === true,
			digest: buildHistoryToolDigest(entry ?? { status: "done" }),
		};
	};
	const isAsk = (part: ToolResultPart) =>
		part.toolCallId === p.askToolCallId || isAskToolName(part.toolName);

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

	return { v: 1, messages, results };
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
			message.content.some(
				(part) =>
					part.type === "tool-result" && part.toolCallId === askToolCallId,
			),
	);
}

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

const DIGEST_KEYS: ReadonlySet<string> = new Set([
	"ok",
	"summary",
	"detail",
	"sources",
]);

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
 * - Every row for its call id and tool says a local model summarised it: it stays,
 *   a cloud run having been handed that summary too.
 * - Otherwise it is sent as the digest of the row that is its own, the nth row of
 *   that id and tool for the nth such result (the rows come in the order of the
 *   results), else of any such row that is not a summary.
 * - No row has its id and tool: it is sent as a note that its details stay on the
 *   person's device. The gate fails closed.
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
		const nth = new Map<string, number>();
		const gated = messages.map((message) =>
			gateMessage(message, rowsByKey, nth),
		);
		return gated.some((message, index) => message !== messages[index])
			? gated
			: messages;
	};
}

function gateMessage(
	message: ModelMessage,
	rowsByKey: ReadonlyMap<string, readonly AskCapturedResult[]>,
	nth: Map<string, number>,
): ModelMessage {
	if (message.role !== "tool") return message;
	let changed = false;
	const content = message.content.map(
		(part): (typeof message.content)[number] => {
			if (part.type !== "tool-result" || !isConnectionToolName(part.toolName)) {
				return part;
			}
			const output = gatedOutput(part, rowsByKey, nth);
			if (output === null) return part;
			changed = true;
			return { ...part, output };
		},
	);
	return changed ? { ...message, content } : message;
}

/** What a connector result is sent as instead of its output; null when it stays. */
function gatedOutput(
	part: ToolResultPart,
	rowsByKey: ReadonlyMap<string, readonly AskCapturedResult[]>,
	nth: Map<string, number>,
): ToolOutput | null {
	if (part.output.type === "json" && isExactDigest(part.output.value)) {
		return null;
	}
	const key = resultKey(part.toolCallId, part.toolName);
	const index = nth.get(key) ?? 0;
	nth.set(key, index + 1);
	const rows = rowsByKey.get(key) ?? [];
	if (rows.length > 0 && rows.every((row) => row.localDistilled)) return null;
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
