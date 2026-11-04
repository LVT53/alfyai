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
 * `results` has one row for each tool result in `messages`, naming the tool it
 * came from and carrying its digest, so a resume can still gate the whole result
 * for each model attempt (a cloud model is never sent what a local one
 * summarised). A row is made once: the rows of an earlier capture (`priorResults`)
 * stand as they were and are not read again, because `toolCalls` holds this run's
 * calls alone. A result whose call left no record still gets a plain row, so no
 * result in `messages` is left without one to gate. An ask call has no row: its
 * result is the pause and then the person's answer, not data of a tool.
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

	const results = [...p.priorResults];
	const made = new Set(results.map((row) => row.toolCallId));
	for (const message of messages) {
		if (message.role !== "tool") continue;
		for (const part of message.content) {
			if (part.type !== "tool-result") continue;
			if (made.has(part.toolCallId)) continue;
			if (part.toolCallId === p.askToolCallId || isAskToolName(part.toolName)) {
				continue;
			}
			made.add(part.toolCallId);
			const entry = recorded.get(part.toolCallId);
			results.push({
				toolCallId: part.toolCallId,
				toolName: part.toolName,
				localDistilled: entry?.metadata?.localDistilled === true,
				digest: buildHistoryToolDigest(entry ?? { status: "done" }),
			});
		}
	}

	return { v: 1, messages, results };
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
 * The gate a resume gives its model run for each attempt: an attempt on a model
 * that is not on the person's own box is not sent what their setting keeps local
 * (the existing connector rule, design 5.5; `normal-chat-tools/connector-distill.ts`).
 *
 * A connector's result (`isConnectionToolName`) read by the run that paused is
 * raw when that run was on the person's box, and a cloud run would have been
 * handed a local model's summary instead (`localDistilled`, kept for each result).
 * So when the person keeps connector data local, an attempt whose provider does
 * not run locally gets each captured raw connector result as its digest, the form
 * a later turn would see it in. Everything else stays as captured: a local
 * attempt, a result already a summary, and any result that is not a connector's.
 * Decided for each attempt with that attempt's provider, never once for the run.
 *
 * Never changes the array or the messages it is given (the model run may hand it
 * the original list): a message that changes is a new one.
 */
export function gateCapturedConnectorResults(p: {
	results: readonly AskCapturedResult[];
	keepConnectorDataLocal: boolean;
}): (
	messages: ModelMessage[],
	provider: NormalChatModelRunProvider,
) => ModelMessage[] {
	const digests = new Map<string, HistoryToolDigest>();
	for (const row of p.results) {
		if (isConnectionToolName(row.toolName) && !row.localDistilled) {
			digests.set(row.toolCallId, row.digest);
		}
	}
	return (messages, provider) => {
		if (
			!p.keepConnectorDataLocal ||
			digests.size === 0 ||
			providerRunsLocally(provider)
		) {
			return messages;
		}
		return messages.map((message) => withDigests(message, digests));
	};
}

function withDigests(
	message: ModelMessage,
	digests: ReadonlyMap<string, HistoryToolDigest>,
): ModelMessage {
	if (message.role !== "tool") return message;
	const holdsOne = message.content.some(
		(part) => part.type === "tool-result" && digests.has(part.toolCallId),
	);
	if (!holdsOne) return message;
	return {
		...message,
		content: message.content.map((part): (typeof message.content)[number] => {
			if (part.type !== "tool-result") return part;
			const digest = digests.get(part.toolCallId);
			return digest
				? { ...part, output: { type: "json", value: digest } }
				: part;
		}),
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
 */
export function capturedProvenanceResults(
	capture: AskResumeCapture,
): ToolResultObservation[] {
	const inputs = new Map<string, unknown>();
	const outputs = new Map<string, ToolOutput>();
	for (const message of capture.messages) {
		if (message.role === "assistant" && typeof message.content !== "string") {
			for (const part of message.content) {
				if (part.type === "tool-call") inputs.set(part.toolCallId, part.input);
			}
		} else if (message.role === "tool") {
			for (const part of message.content) {
				if (part.type === "tool-result") {
					outputs.set(part.toolCallId, part.output);
				}
			}
		}
	}
	return capture.results.map((row) => {
		const output = outputs.get(row.toolCallId);
		const input = inputs.get(row.toolCallId);
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

function isDigest(value: unknown): value is HistoryToolDigest {
	return (
		isRecord(value) &&
		typeof value.ok === "boolean" &&
		typeof value.summary === "string"
	);
}

/** A tool result said as a digest: already one, or the text of what the model was handed. */
function digestOfOutput(output: ToolOutput): HistoryToolDigest {
	if (output.type === "json" && isDigest(output.value)) return output.value;
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
