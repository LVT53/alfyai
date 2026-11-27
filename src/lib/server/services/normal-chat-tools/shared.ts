import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { JSONSchema7 } from "@ai-sdk/provider";
import { asSchema } from "@ai-sdk/provider-utils";
import type { Tool, ToolExecutionOptions } from "ai";
import { jsonSchema } from "ai";
import { z } from "zod";

import { SANDBOX_TIMEOUT_MS } from "$lib/server/sandbox/config";
import { UserStopReason } from "$lib/server/services/chat-turn/active-streams";
import type { ToolCallEntry } from "$lib/server/services/messages-types";
import { ToolCallRefusedError } from "$lib/server/utils/tool-refusal";
import { abortedByTurnDeadline } from "$lib/server/utils/turn-deadline-reason";
import {
	type AnyReasonCode,
	type ConnectorReasonCode,
	REASON_CODE_KEY,
	type SharedReasonCode,
	type ToolReasonCode,
	type ToolWithReasons,
} from "$lib/shared/tool-reasons";
import { estimateTokenCount } from "$lib/utils/tokens";
import {
	boundedWebReadFailure,
	capModelPayload,
	getReadResultGrant,
	ReadResultCapacityError,
	TOOL_RESULT_MAX_TOKENS,
} from "./model-payload-budget";
import { stableStringify } from "./stable-stringify";
import { deriveToolResultDigest } from "./tool-result-digest";

// ── Record helper ──────────────────────────────────────────────

export function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// ── Text helpers ───────────────────────────────────────────────

export function truncateText(
	value: string | null | undefined,
	maxLength: number,
): string {
	const text = value ?? "";
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength).trimEnd()}...`;
}

// ── Stable serialization ───────────────────────────────────────
//
// The serializer lives in its own module so `model-payload-budget.ts` (which
// this file imports for the envelope ceiling) can measure a payload with the
// same deterministic bytes without importing this file back, which would be a
// cycle. Re-exported here because every tool already takes its helpers from
// this module.
export { stableStringify };

export function shortHash(value: unknown): string {
	return createHash("sha256")
		.update(stableStringify(value))
		.digest("hex")
		.slice(0, 12);
}

// ── Multi-connection selection (disambiguation) ───────────────
//
// Shared by every capability tool (calendar/files/photos/contacts/tasks/
// email/media/location) so an `account` selector that matches none of the
// user's connections for that capability degrades gracefully — never a hard
// error, and never a silent wrong-connection pick — by listing the accounts
// the user actually has and asking which one they meant. Mirrors the
// "degrade gracefully" posture every tool already uses for a missing/broken
// connection.
export function noMatchingConnectionMessage(
	capabilityLabel: string,
	selector: string,
	connections: { label: string; provider: string }[],
): string {
	const listed = connections
		.map((conn) => `${conn.label} (${conn.provider})`)
		.join(", ");
	return `You have these ${capabilityLabel} accounts: ${listed}. I couldn't match "${selector}" — which one did you mean?`;
}

// ── Model payload compaction ────────────────────────────────────
//
// Every successful tool `modelPayload` is run through this before it reaches
// the model (see `executeToolWithEnvelope` below): drop keys whose value
// carries no information (undefined/null, empty arrays, empty objects, empty
// strings) so the model isn't billed tokens for placeholders like
// `omittedSiblingCount: []` or `snippet: ""`. A short allow-list of envelope
// keys is kept even when empty/falsy, because their ABSENCE (not their value)
// is what a caller or the model keys off of — e.g. `success: false` must
// never be dropped for being falsy, and `name`/`sourceType`/`mode` identify
// the payload's shape. Recurses exactly one level into plain-object values
// (e.g. `answerBrief: { sourceCount, evidenceCount }`) so a nested empty key
// is also dropped; array items are left untouched — an array is a list of
// records the model should see whole, not a bag of optional fields.
const NEVER_DROP_MODEL_PAYLOAD_KEYS = new Set([
	"success",
	"name",
	"action",
	"message",
	"mode",
	"sourceType",
]);

function isEmptyModelPayloadValue(value: unknown): boolean {
	if (value === undefined || value === null) return true;
	if (typeof value === "string") return value.length === 0;
	if (Array.isArray(value)) return value.length === 0;
	if (isRecord(value)) return Object.keys(value).length === 0;
	return false;
}

function compactModelPayloadShallow(
	record: Record<string, unknown>,
): Record<string, unknown> {
	const compacted: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		if (
			!NEVER_DROP_MODEL_PAYLOAD_KEYS.has(key) &&
			isEmptyModelPayloadValue(value)
		) {
			continue;
		}
		compacted[key] = value;
	}
	return compacted;
}

export function compactModelPayload<T>(payload: T): T {
	if (!isRecord(payload)) return payload;
	const compacted: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(payload)) {
		// One level of recursion: a nested plain object gets its own empty keys
		// stripped, but we don't descend further (a grandchild object is left
		// as-is once its parent has been compacted once).
		const compactedValue = isRecord(value)
			? compactModelPayloadShallow(value)
			: value;
		if (
			!NEVER_DROP_MODEL_PAYLOAD_KEYS.has(key) &&
			isEmptyModelPayloadValue(compactedValue)
		) {
			continue;
		}
		compacted[key] = compactedValue;
	}
	return compacted as T;
}

// ── Metadata ───────────────────────────────────────────────────

export function sanitizeMetadata(
	metadata: Record<string, string | number | boolean | null>,
): Record<string, string | number | boolean | null> {
	return Object.fromEntries(
		Object.entries(metadata).filter(
			([, value]) =>
				["string", "number", "boolean"].includes(typeof value) ||
				value === null,
		),
	);
}

export function optionalScalarMetadata(
	value: string | number | boolean | null | undefined,
): string | number | boolean | null | undefined {
	return value === undefined ? undefined : value;
}

// ── Tool call recorder ─────────────────────────────────────────

const entryExecutionFacts = new WeakMap<
	ToolCallEntry,
	"failed" | "uncertain"
>();

/** An operation owner supplies certainty; payload/status strings cannot grant it. */
export function withToolExecutionFact(
	entry: ToolCallEntry,
	state: "failed" | "uncertain",
): ToolCallEntry {
	entryExecutionFacts.set(entry, state);
	return entry;
}

const payloadReasonCodes = new WeakMap<object, AnyReasonCode>();

/**
 * Names why an in-band failure or refusal happened (the call returned a payload
 * saying so instead of throwing), from its tool's closed list in
 * `$lib/shared/tool-reasons`. The code travels BESIDE the payload, never in it:
 * what the model reads, and the bytes `JSON.stringify` and `stableStringify`
 * give, stay exactly as they were. The tag belongs to this object, so read it
 * with `reasonCodeOf` where the entry is built, before the envelope compacts the
 * payload into a new object, and write it as `metadata.reasonCode`.
 */
export function withReasonCode<T extends object>(
	payload: T,
	code: AnyReasonCode,
): T {
	payloadReasonCodes.set(payload, code);
	return payload;
}

/** The code `withReasonCode` gave this very payload, if any. */
export function reasonCodeOf(payload: unknown): AnyReasonCode | undefined {
	return payload !== null && typeof payload === "object"
		? payloadReasonCodes.get(payload)
		: undefined;
}

/**
 * The reason code of an error a connection's provider threw (each provider's
 * error class names its cases with the same few codes), for the nine account
 * tools: credentials the account no longer accepts, a connection that is gone, an
 * item that is not there, a file too large, a request the provider refused for
 * its shape or its configuration. Anything else, and anything that is not a
 * provider's error, is the account not answering. The words the model reads for
 * an error stay each tool's own.
 */
export function connectorReasonForAdapterError(
	error: unknown,
): ConnectorReasonCode {
	switch (isRecord(error) ? error.code : undefined) {
		case "needs_reauth":
		case "invalid_grant":
		case "invalid_credentials":
		case "invalid_token":
			return "needs_reconnect";
		case "connection_not_found":
			return "not_connected";
		case "message_not_found":
		case "not_found":
		case "folder_not_found":
			return "item_not_found";
		case "too_large":
			return "too_large";
		case "invalid_path":
			return "request_adjusted";
		case "invalid_config":
		case "not_configured":
			return "not_set_up";
		case "writes_disabled":
			return "writes_turned_off";
		default:
			return "account_unreachable";
	}
}

/**
 * `{ reasonCode }` for the code `withReasonCode` gave this very payload, or
 * nothing: for an entry built from a payload a tool returned, read before the
 * envelope compacts the payload into a new object.
 */
export function reasonMetadataOf(
	payload: unknown,
): { reasonCode: AnyReasonCode } | Record<never, never> {
	const code = reasonCodeOf(payload);
	return code ? { [REASON_CODE_KEY]: code } : {};
}

/**
 * `{ reasonCode: code }` for an entry's metadata, with the code held to the
 * tool's own closed list (or a shared outcome) by the compiler: a code a tool
 * does not list, or a misspelt one, does not compile. The tool's name is only
 * there to pick the list.
 */
export function reasonMetadata<T extends ToolWithReasons>(
	_tool: T,
	code: ToolReasonCode<T>,
): { reasonCode: ToolReasonCode<T> } {
	return { [REASON_CODE_KEY]: code };
}

export interface ToolCallRecorder {
	record(
		entry: ToolCallEntry,
		executionFact?: {
			state: "definitely_not_executed" | "failed" | "uncertain";
			result: object;
		},
	): ToolCallEntry;
	/** Server-only original result identity; absent facts remain unknown. */
	getExecutionCertainty?(
		result: unknown,
	): "definitely_not_executed" | "failed" | "uncertain" | undefined;
	getEntries(): ToolCallEntry[];
	/**
	 * Observes the final compact model view before record/return. Legacy calls
	 * observe successes only. Granted web reads also observe their fixed bounded
	 * failures: no candidates, URLs or echoed error/input, coverage:none and
	 * evidenceReady:false. Certainty remains bound to that exact final object.
	 */
	observeResult?(result: {
		toolName: string;
		payload: unknown;
		entry: ToolCallEntry;
	}): void;
}

export function recordToolCallEntry(
	entries: ToolCallEntry[],
	entry: ToolCallEntry,
): ToolCallEntry {
	const normalized: ToolCallEntry = {
		...entry,
		input: { ...entry.input },
		outputSummary: entry.outputSummary ?? null,
		metadata: entry.metadata ? { ...entry.metadata } : undefined,
	};
	entries.push(normalized);
	return normalized;
}

// ── Failure log ────────────────────────────────────────────────
//
// The raw cause of a failed call stays in the server log, for fixing, and never
// reaches a person (a tool row says why from the reason code). One line per
// failed call, content-free: the tool, its reason code and its recorded status;
// for a thrown error also its class and its message with every address and
// every quoted span taken out, since some messages echo what the model asked for
// (`connections/dav/ical.ts` repeats an event's own text). Never an input, a
// query, an address, a result, `outputSummary` or a candidate.
//
// A call is logged once: where the error is in scope (the envelope's catch) or,
// for a failure a tool reported without throwing (`metadata.ok === false`, or a
// recorded `failed` status), where the recorder takes the entry in. The entry
// itself is what is marked, so the catch's line and the record that follows it
// are one.

const loggedFailures = new WeakSet<ToolCallEntry>();

const ADDRESS_IN_MESSAGE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>]+/gi;
// A quote opens after a space or a symbol, never after a letter: the apostrophe
// of "couldn't" is a word, not a span.
const QUOTED_IN_MESSAGE =
	/"[^"]*"|`[^`]*`|(?<![\p{L}\p{N}])'[^']*'(?![\p{L}\p{N}])/gu;
const LOGGED_MESSAGE_MAX_CHARS = 200;

function redactedErrorForLog(error: unknown): string {
	const errorClass =
		error instanceof Error
			? error.constructor?.name || error.name || "Error"
			: typeof error;
	const message =
		error instanceof Error
			? error.message
			: typeof error === "string"
				? error
				: "";
	const oneLine = message
		.replace(ADDRESS_IN_MESSAGE, "<url>")
		.replace(QUOTED_IN_MESSAGE, "<text>")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, LOGGED_MESSAGE_MAX_CHARS);
	return `${errorClass}: ${oneLine}`;
}

function reasonCodeOfEntry(entry: ToolCallEntry): string | undefined {
	const code = entry.metadata?.[REASON_CODE_KEY];
	return typeof code === "string" && code ? code : undefined;
}

function logToolFailure(params: {
	entry: ToolCallEntry;
	code: string | undefined;
	status: string;
	/** Set for a thrown error: the line then carries its class and its redacted message. */
	thrown?: { error: unknown };
}): void {
	if (loggedFailures.has(params.entry)) return;
	loggedFailures.add(params.entry);
	const tool = String(params.entry.name)
		.replace(/[^A-Za-z0-9_.-]/g, "_")
		.slice(0, 64);
	const line = `[CHAT_STREAM] tool_failure tool=${tool} code=${params.code ?? "none"} status=${params.status}`;
	console.warn(
		params.thrown
			? `${line} error=${redactedErrorForLog(params.thrown.error)}`
			: line,
	);
}

/** A failure a tool reported in its result instead of throwing: a failed status, or `ok: false` beside a result the call still returned. */
function logInBandFailure(entry: ToolCallEntry): void {
	if (entry.status !== "failed" && entry.metadata?.ok !== false) return;
	logToolFailure({
		entry,
		code: reasonCodeOfEntry(entry),
		status: entry.status,
	});
}

export function createToolCallRecorder(
	initialEntries: ToolCallEntry[] = [],
): ToolCallRecorder {
	const entries = initialEntries;
	const executionFacts = new WeakMap<
		object,
		"definitely_not_executed" | "failed" | "uncertain"
	>();
	return {
		record(entry, executionFact) {
			const recorded = recordToolCallEntry(entries, entry);
			logInBandFailure(entry);
			if (executionFact)
				executionFacts.set(executionFact.result, executionFact.state);
			return recorded;
		},
		getExecutionCertainty(result) {
			return result !== null && typeof result === "object"
				? executionFacts.get(result)
				: undefined;
		},
		getEntries() {
			return [...entries];
		},
	};
}

/** The tools whose call, given an input that does not fit the schema, is answered with the schema's message before the envelope. */
export type SchemaFailureTool =
	| "read_generated_file"
	| "create_artifact"
	| "edit_artifact";

/**
 * Records a call whose input did not fit its tool's schema, which used to record
 * nothing: the model is still answered with the schema's own message, and the
 * row gets a code of its own (`request_adjusted`, the call was changed to fit).
 * The entry keeps the history digest what it was for a call with no entry: a
 * "done" status, an empty input and no summary, digest or candidates, so a later
 * turn still replays "Completed." (`buildHistoryToolDigest`).
 *
 * The call is a refusal made before the tool did any work, so the entry is
 * recorded with the execution fact `definitely_not_executed`, bound to the payload
 * the tool answers with (the fact is keyed by that very object, so the payload is
 * handed back to be returned as it is). Nothing ran, the model reads the schema's
 * message in its next step and the turn goes on, as it does for a call a tool
 * turned down with `ToolCallRefusedError` (`chat-turn/AGENTS.md`, "A Turn's Final
 * Answer"). A call with no row is `uncertain` and a row that says only "done" reads
 * as a success (`classifyExecution`, `chat-turn/prepared-normal-chat-turn.ts`), and
 * the engine ends a turn at an uncertain call: until 2026-11-19 a malformed call the
 * model could have corrected ended the reply empty.
 */
export function recordSchemaFailure<TPayload extends object>(
	recorder: ToolCallRecorder,
	params: { callId: string; name: SchemaFailureTool; payload: TPayload },
): TPayload {
	recorder.record(
		{
			callId: params.callId,
			name: params.name,
			input: {},
			status: "done",
			metadata: {
				ok: false,
				...reasonMetadata(params.name, "request_adjusted"),
			},
		},
		{ state: "definitely_not_executed", result: params.payload },
	);
	return params.payload;
}

// ── Local distillation mark ────────────────────────────────────
//
// With a cloud chat model and local summarising on, a connector tool hands the
// model a summary a LOCAL model wrote after reading the user's mail, events or
// files (a stranger's email among them) in place of what the provider returned.
// An address in it is that model's words, not a tool's result (ADR-0068), so
// the call's entry carries `localDistilled: true` and the turn's address check
// takes only its candidates (url-provenance/turn.ts). The summary is asked for
// deep inside the tool, so `decideLocalDistill` marks the call it runs in and
// `executeToolWithEnvelope` writes the mark on the entry before the result is
// observed or recorded. Outside a tool call there is nothing to mark, and that
// is an error, not a no-op: a summary with no call to carry the mark would count
// as a tool's own words (the mark used to vanish there without a sound, so a
// connector path added outside the envelope would have passed every test). The
// one summary that is not a tool's result, the proactive block spliced into the
// prompt, asks for itself without a mark (`decideLocalDistillForPrompt`).
const callInProgress = new AsyncLocalStorage<{ localDistilled: boolean }>();

/** True while a tool call runs in this async context: what a summary is asked for inside. */
export function isInsideToolCall(): boolean {
	return callInProgress.getStore() !== undefined;
}

/**
 * Marks the tool call running now as one whose result a local model summarised.
 * Throws outside a tool call (ADR-0068: it fails closed, never to nothing).
 */
export function markCallLocallyDistilled(): void {
	const call = callInProgress.getStore();
	if (!call) {
		throw new Error(
			"markCallLocallyDistilled was called outside a tool call: there is no call to mark, and a summary nobody marked would count as a tool's own words (ADR-0068)",
		);
	}
	call.localDistilled = true;
}

// ── Timeout ────────────────────────────────────────────────────

export const TOOL_TIMEOUTS_MS: Record<string, number> = {
	research_web: 60_000,
	// fetch_url defaults to CACHED Extract (max_age 86400, ~735ms), so slow
	// fetches are rare; but an UNCACHED live Extract can spike to ~42s (see
	// parallel-search/fetch-url.ts), which the old 30s cap surfaced as a spurious
	// tool timeout. 45s clears that worst-case tail while staying under
	// research_web's 60s.
	fetch_url: 45_000,
	memory_context: 15_000,
	image_search: 30_000,
	// produce_file submits the job and then waits in-turn for the ledger's
	// verdict (PRODUCE_FILE_VERDICT_WAIT_MS, 20s) so it can tell the model
	// whether a file actually exists. The envelope timeout has to clear that
	// wait with room for the intake write and the polling reads on top,
	// otherwise a job that is about to settle is aborted as a tool timeout
	// instead of being reported as still running.
	produce_file: 40_000,
	// make_image holds its take for 130 s (so a late result is never promoted
	// before the call has decided about it) and waits IMAGE_TOOL_WAIT_MS (100 s)
	// for it; the envelope clears the wait with room for the card and the read.
	make_image: 120_000,
	// make_video waits VIDEO_TOOL_WAIT_MS (240 s, the video's own number in
	// `images/video/request.ts`, not imported here so this leaf module never
	// pulls in a graph) for a take that may be two renders; the envelope clears
	// that wait with room for the caption, the still and the read.
	make_video: 270_000,
	// run_python executes synchronously in-turn (unlike produce_file, which
	// submits a job and waits only a bounded time for it): the envelope timeout
	// must clear the sandbox's own
	// hard exec cutoff (SANDBOX_TIMEOUT_MS) so a slow-but-still-running script
	// gets the sandbox's graceful `timedOut: true` result instead of racing it
	// and returning a generic "run_python timed out" envelope error first.
	run_python: SANDBOX_TIMEOUT_MS + 15_000,
	read_generated_file: 10_000,
	files: 20_000,
	calendar: 20_000,
	email: 20_000,
	photos: 20_000,
	media: 20_000,
	location: 20_000,
	contacts: 20_000,
	teams: 20_000,
	repos: 20_000,
	tasks: 20_000,
	map_route: 20_000,
	use_skill: 10_000,
	// Two indexed reads (which project this conversation is in, and that
	// project's name) and an in-memory record; nothing leaves the process.
	suggest_instruction: 10_000,
	// One insert, nothing leaves the process (the call never waits for the person).
	ask_user: 10_000,
	// The name covers all five kinds, so it is sized for the most expensive
	// one: an App is generated and then fact-verified inside the call, a model
	// round trip rather than a database write (decisions.md ruling 40). This
	// is the ONE row for create_artifact; no type slice writes a second one.
	create_artifact: 120_000,
	// Sized like create_artifact's, for the same reason: the name covers the App,
	// whose rebuild is a model call plus the fact-verification pass inside the call
	// (F2, ruling 77), where a Document patch or a board diff is a validation pass
	// and one version row. One row per tool, as ruling 40 says.
	edit_artifact: 120_000,
	// The same as read_generated_file: a read, not a computation.
	read_artifact: 10_000,
};

export async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	toolName: string,
	abortSignal?: AbortSignal,
): Promise<T> {
	if (abortSignal?.aborted) {
		throw toolAbortError(toolName, abortSignal.reason);
	}

	if ((!Number.isFinite(timeoutMs) || timeoutMs <= 0) && !abortSignal) {
		return promise;
	}

	let timer: ReturnType<typeof setTimeout> | undefined;
	let removeAbortListener: (() => void) | undefined;
	const timeoutOrAbort = new Promise<never>((_, reject) => {
		if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
			timer = setTimeout(() => {
				reject(new Error(`${toolName} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			timer.unref?.();
		}
		if (abortSignal) {
			const onAbort = () => {
				reject(toolAbortError(toolName, abortSignal.reason));
			};
			abortSignal.addEventListener("abort", onAbort, { once: true });
			removeAbortListener = () =>
				abortSignal.removeEventListener("abort", onAbort);
		}
	});

	try {
		return await Promise.race([promise, timeoutOrAbort]);
	} finally {
		if (timer) clearTimeout(timer);
		removeAbortListener?.();
	}
}

function toolAbortError(toolName: string, reason: unknown): Error {
	if (reason instanceof Error) {
		return new Error(`${toolName} aborted: ${reason.message}`);
	}
	if (typeof reason === "string" && reason.trim()) {
		return new Error(`${toolName} aborted: ${reason.trim()}`);
	}
	return new Error(`${toolName} aborted`);
}

function toolTimeoutError(toolName: string, timeoutMs: number): Error {
	return new Error(`${toolName} timed out after ${timeoutMs}ms`);
}

/** Whether an error is the envelope's own timeout (a tool whose work may still finish later tells the person differently). */
export function isToolTimeoutError(error: unknown): boolean {
	return error instanceof Error && /timed out after \d+ms$/.test(error.message);
}

/**
 * The outcome every tool can have, for the reason code on its row (the lists in
 * `$lib/shared/tool-reasons`): the person pressed Stop (`stopped`), the turn's
 * working time ran out while the step ran (`out_of_time`), or the tool ran past
 * its own time limit (`timed_out`). Null for any other error: a stream watchdog,
 * a storage failure and the first-output timer abort with other reasons, and a
 * tool's own failure is the tool's to name. `signal` is the turn's own, not the
 * envelope's.
 */
export function sharedReasonFor(
	error: unknown,
	signal: AbortSignal | undefined,
): SharedReasonCode | null {
	if (signal?.aborted === true && signal.reason instanceof UserStopReason) {
		return "stopped";
	}
	if (abortedByTurnDeadline(signal)) return "out_of_time";
	if (isToolTimeoutError(error)) return "timed_out";
	return null;
}

/**
 * The same three outcomes, read from the text of a `tool_error` event, which
 * carries a message and no error. The completion engine's wrapper throws
 * `user_stop` and `deadline` to the SDK before or while a call runs (the SDK
 * words an Error as "Error: <message>"), and a tool's own time limit is the
 * envelope's "<tool> timed out after <n>ms". Anything else, an abort the
 * stream's classifier files under `timeout` included, names no code.
 */
export function sharedReasonForToolError(
	message: string,
): SharedReasonCode | null {
	const text = message.replace(/^Error:\s*/, "").trim();
	if (text === "user_stop") return "stopped";
	if (text === "deadline") return "out_of_time";
	return isToolTimeoutError(new Error(text)) ? "timed_out" : null;
}

/**
 * The reason code a thrown error is recorded with. A Stop and the turn's
 * working deadline override any code the tool's `onError` set (a Stop must never
 * fall to a tool's catch-all, such as memory_unavailable); the tool's own code
 * beats `timed_out`; otherwise the shared one, if there is one.
 */
function thrownErrorReasonCode(
	error: unknown,
	signal: AbortSignal | undefined,
	ownCode: string | undefined,
): string | undefined {
	const shared = sharedReasonFor(error, signal);
	if (shared === "stopped" || shared === "out_of_time") return shared;
	return ownCode ?? shared ?? undefined;
}

// Stamps the envelope's own start→settle wall-clock time onto an entry's
// metadata, feeding activity-events.ts's toolCallDurationMs (which already
// reads metadata.durationMs defensively) without a second timer anywhere
// else. A tool that already measured a more precise duration for itself
// (metadata.durationMs already set by `run`/`onError`) is left alone — this
// is a fallback, not an override.
function withMeasuredDuration(
	metadata: Record<string, string | number | boolean | null> | undefined,
	startedAt: number,
): Record<string, string | number | boolean | null> {
	if (typeof metadata?.durationMs === "number") return metadata;
	return { ...metadata, durationMs: Math.max(0, Date.now() - startedAt) };
}

export function modelSafeToolError(error: unknown, fallback: string): string {
	const message =
		error instanceof Error
			? error.message
			: typeof error === "string"
				? error
				: fallback;
	const trimmed = message.trim();
	return truncateText(trimmed || fallback, 500);
}

function validBoundedWebPayload(
	payload: Record<string, unknown>,
	entry: ToolCallEntry,
): boolean {
	if (
		payload.bounded !== true ||
		(payload.coverage !== "full" && payload.coverage !== "partial") ||
		!isRecord(payload.omitted) ||
		!Array.isArray(payload.pageRanges) ||
		typeof payload.hint !== "string" ||
		!Array.isArray(payload.sources) ||
		!Array.isArray(payload.evidence)
	)
		return false;
	if (
		!["sources", "evidence", "pages"].every(
			(key) =>
				Number.isInteger((payload.omitted as Record<string, unknown>)[key]) &&
				Number((payload.omitted as Record<string, unknown>)[key]) >= 0,
		)
	)
		return false;
	const sources = payload.sources.filter(isRecord);
	if (
		sources.length !== payload.sources.length ||
		sources.some((s) => typeof s.id !== "string" || typeof s.url !== "string")
	)
		return false;
	if (
		!payload.evidence.every(
			(e) =>
				isRecord(e) &&
				typeof e.quote === "string" &&
				sources.some((s) => s.id === e.sourceId && s.url === e.url),
		)
	)
		return false;
	const pages = Array.isArray(payload.pages) ? payload.pages : [];
	if (
		pages.length !== payload.pageRanges.length ||
		!payload.pageRanges.every((range, index) => {
			const page = pages[index];
			return (
				isRecord(range) &&
				isRecord(page) &&
				typeof page.contentMarkdown === "string" &&
				range.start === 0 &&
				Number.isInteger(range.end) &&
				Number.isInteger(range.totalChars) &&
				Number(range.end) >= 0 &&
				Number(range.end) <= Number(range.totalChars) &&
				range.end === page.contentMarkdown.length &&
				typeof range.contentHash === "string" &&
				sources.some((s) => s.id === range.sourceId && s.url === page.url)
			);
		})
	)
		return false;
	return (
		(entry.candidates ?? []).every((candidate) =>
			sources.some(
				(source) =>
					source.id === candidate.id &&
					source.url === candidate.url &&
					(!candidate.snippet ||
						source.snippet === candidate.snippet ||
						(payload.evidence as unknown[]).some(
							(e) =>
								isRecord(e) &&
								e.sourceId === source.id &&
								e.quote === candidate.snippet,
						)),
			),
		) &&
		(entry.metadata?.sourceCount === undefined ||
			entry.metadata.sourceCount === sources.length) &&
		(entry.metadata?.evidenceCount === undefined ||
			entry.metadata.evidenceCount === payload.evidence.length)
	);
}

export async function executeToolWithEnvelope<
	TModelPayload,
	TErrorPayload = TModelPayload,
>(params: {
	toolName: string;
	timeoutMs: number;
	options: Pick<ToolExecutionOptions, "toolCallId" | "abortSignal">;
	recorder: ToolCallRecorder;
	/**
	 * The tool only reads, searches or fetches: running it again changes nothing
	 * a person could lose (at most it fills a cache or counts a call), so what it
	 * throws (a timeout, an upstream error) is a settled failure, `failed`, that
	 * the model reads and answers from. The default is `uncertain`, which ends the
	 * turn, because a tool that can write anything may have written before it
	 * threw; so is an error the turn's own abort caused (a stop, the watchdog, a
	 * storage failure, the first-output timer), for every tool. The exception is
	 * the engine's own deadline: a call that only reads and was still running
	 * when the time for working ran out is a settled failure too. Say so only for
	 * a tool that cannot change anything by running; the ones that do are listed
	 * in `read-only-tools.test.ts`, and a new one is a decision made there.
	 */
	readOnly?: boolean;
	run: (abortSignal: AbortSignal) => Promise<{
		modelPayload: TModelPayload;
		entry: ToolCallEntry;
	}>;
	onError: (error: unknown) => {
		modelPayload: TErrorPayload;
		entry: ToolCallEntry;
	};
}): Promise<TModelPayload | TErrorPayload> {
	const startedAt = Date.now();
	const grant = getReadResultGrant(params.options);
	let ran = false;
	let resultEntry: ToolCallEntry | undefined;
	// Only capability-granted reads use this boundary; legacy callers retain
	// their existing compaction/cap and error behavior.
	const commit = (
		raw: unknown,
		entry: ToolCallEntry,
		state?: "failed" | "uncertain" | "definitely_not_executed",
		/** The code a failure is recorded with; the rebuilt metadata below keeps it (and the one the tool's own entry carried). */
		reasonCode?: string,
	) => {
		if (!grant) throw new Error("Missing read-result grant");
		let payload = compactModelPayload(raw);
		if (isRecord(raw) && raw.bounded === true && isRecord(payload)) {
			// Coverage is a protocol: empty ranges and zero omission counts carry meaning.
			payload = {
				...payload,
				omitted: raw.omitted,
				pageRanges: raw.pageRanges,
				...(Array.isArray(raw.sources) ? { sources: raw.sources } : {}),
				...(Array.isArray(raw.evidence) ? { evidence: raw.evidence } : {}),
			};
		}
		const valid =
			isRecord(payload) &&
			payload.success === true &&
			!state &&
			validBoundedWebPayload(payload, entry) &&
			estimateTokenCount(stableStringify(payload)) <=
				Math.min(grant.maxPayloadTokens, TOOL_RESULT_MAX_TOKENS);
		if (!valid) {
			const fixedFailure = boundedWebReadFailure(params.toolName);
			payload = fixedFailure;
			if (!state) state = "failed";
			if (
				!Number.isFinite(grant.maxFailurePayloadTokens) ||
				estimateTokenCount(stableStringify(payload)) >
					grant.maxFailurePayloadTokens
			)
				throw new ReadResultCapacityError(ran);
			const keptCode = reasonCode ?? reasonCodeOfEntry(entry);
			entry.status = "failed";
			entry.candidates = [];
			entry.outputSummary = fixedFailure.hint;
			entry.metadata = {
				ok: false,
				evidenceReady: false,
				sourceCount: 0,
				evidenceCount: 0,
				bounded: true,
				coverage: "none",
				...(keptCode ? { [REASON_CODE_KEY]: keptCode } : {}),
			};
		}
		entry.resultDigest = deriveToolResultDigest(payload);
		entry.metadata = withMeasuredDuration(entry.metadata, startedAt);
		params.recorder.observeResult?.({
			toolName: params.toolName,
			payload,
			entry,
		});
		params.recorder.record(
			entry,
			state && isRecord(payload) ? { state, result: payload } : undefined,
		);
		return payload as TModelPayload | TErrorPayload;
	};
	try {
		if (params.options.abortSignal?.aborted) {
			throw toolAbortError(params.toolName, params.options.abortSignal.reason);
		}
		if (grant?.kind === "denied")
			throw new ToolCallRefusedError(
				"Web read capacity exhausted before execution",
			);
		const timeoutController = new AbortController();
		const runSignal = params.options.abortSignal
			? AbortSignal.any([params.options.abortSignal, timeoutController.signal])
			: timeoutController.signal;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let removeAbortListener: (() => void) | undefined;
		const timeoutOrAbort = new Promise<never>((_, reject) => {
			if (Number.isFinite(params.timeoutMs) && params.timeoutMs > 0) {
				timer = setTimeout(() => {
					const error = toolTimeoutError(params.toolName, params.timeoutMs);
					timeoutController.abort(error);
					reject(error);
				}, params.timeoutMs);
				timer.unref?.();
			}
			if (params.options.abortSignal) {
				const onAbort = () => {
					reject(
						toolAbortError(params.toolName, params.options.abortSignal?.reason),
					);
				};
				params.options.abortSignal.addEventListener("abort", onAbort, {
					once: true,
				});
				removeAbortListener = () =>
					params.options.abortSignal?.removeEventListener("abort", onAbort);
			}
		});
		const call = { localDistilled: false };
		ran = true;
		const result = await Promise.race([
			callInProgress.run(call, () => params.run(runSignal)),
			timeoutOrAbort,
		]).finally(() => {
			if (timer) clearTimeout(timer);
			removeAbortListener?.();
		});
		resultEntry = result.entry;
		if (grant) {
			if (call.localDistilled)
				result.entry.metadata = {
					...result.entry.metadata,
					localDistilled: true,
				};
			return commit(
				result.modelPayload,
				result.entry,
				entryExecutionFacts.get(result.entry),
			);
		}
		// Strip empty/placeholder keys from the payload before it reaches the
		// model — see compactModelPayload above — then hold the result under the
		// envelope's hard ceiling (`capModelPayload`, the slice-2 safety net).
		const modelPayload = capModelPayload(
			compactModelPayload(result.modelPayload),
		);
		// Persist a compact digest of what the model received so later turns
		// can replay this call as a native tool result (conversation-history.ts).
		if (result.entry.resultDigest == null) {
			result.entry.resultDigest = deriveToolResultDigest(modelPayload);
		}
		result.entry.metadata = withMeasuredDuration(
			result.entry.metadata,
			startedAt,
		);
		if (call.localDistilled) {
			result.entry.metadata = {
				...result.entry.metadata,
				localDistilled: true,
			};
		}
		params.recorder.observeResult?.({
			toolName: params.toolName,
			payload: modelPayload,
			entry: result.entry,
		});
		// Transfer an operation owner's fact to the exact compacted result.
		// A generic failed row is not proof: a tool may have caught a timeout.
		const certainty = entryExecutionFacts.get(result.entry);
		params.recorder.record(
			result.entry,
			certainty && modelPayload !== null && typeof modelPayload === "object"
				? { state: certainty, result: modelPayload }
				: undefined,
		);
		return modelPayload;
	} catch (error) {
		if (error instanceof ReadResultCapacityError) throw error;
		let failure: { modelPayload: TErrorPayload; entry: ToolCallEntry };
		try {
			failure = params.onError(error);
		} catch (onErrorFailure) {
			if (!grant) throw onErrorFailure;
			failure = {
				modelPayload: boundedWebReadFailure(params.toolName) as TErrorPayload,
				entry: resultEntry ?? {
					name: params.toolName,
					callId: params.options.toolCallId,
					input: {},
					status: "failed",
				},
			};
		}
		// A budgeted read the turn's reading budget refused before it began (the
		// throw at the top of the try): the one case that is the envelope's own.
		const refusedForBudget =
			grant?.kind === "denied" && error instanceof ToolCallRefusedError && !ran;
		const reasonCode = thrownErrorReasonCode(
			error,
			params.options.abortSignal,
			reasonCodeOfEntry(failure.entry) ??
				(resultEntry ? reasonCodeOfEntry(resultEntry) : undefined) ??
				(refusedForBudget ? "reading_budget_used" : undefined),
		);
		if (grant) {
			const state =
				params.options.abortSignal?.aborted &&
				!abortedByTurnDeadline(params.options.abortSignal)
					? "uncertain"
					: error instanceof ToolCallRefusedError && !resultEntry
						? "definitely_not_executed"
						: "failed";
			const committed = resultEntry ?? failure.entry;
			// The commit records the entry as a failure whatever its own status was,
			// and cannot see the error: the line is written here, where the error is,
			// and the recorder then skips the entry.
			logToolFailure({
				entry: committed,
				code: reasonCode,
				status: "failed",
				thrown: { error },
			});
			return commit(failure.modelPayload, committed, state, reasonCode);
		}
		failure.entry.metadata = withMeasuredDuration(
			reasonCode
				? { ...failure.entry.metadata, [REASON_CODE_KEY]: reasonCode }
				: failure.entry.metadata,
			startedAt,
		);
		logToolFailure({
			entry: failure.entry,
			code: reasonCode,
			status: failure.entry.status,
			thrown: { error },
		});
		// A thrown error cannot prove that nothing ran, so it is `uncertain` and the
		// engine stops the turn at that call. Two exceptions, and in both the model
		// reads the error, which is written for it, and the turn goes on: an error
		// a tool threw to turn the call down before it dispatched anything
		// (`ToolCallRefusedError`) is a proven non-execution, and an error of a
		// tool that says it only reads (`readOnly`) is a settled failure, since
		// running it again changes nothing a person could lose. A timeout is an
		// ordinary Error here: uncertain for every tool that has not said it only
		// reads. An error the turn's own abort caused (a stop, the watchdog, a
		// storage failure, the first-output timer) stays uncertain for every tool:
		// the wrapper in `normal-chat-model/completion-tools.ts` marks such a call
		// uncertain, and its settle step runs after it and writes whatever fact is
		// recorded here over that state. The one abort that does not is the
		// engine's own deadline timer, recognised by the reason it aborts with
		// (`abortedByTurnDeadline`): a call that only reads and was still running
		// when the time for working ran out is a settled failure too, so the engine
		// can close the turn with what it has instead of ending it empty.
		const state =
			error instanceof ToolCallRefusedError
				? "definitely_not_executed"
				: params.readOnly &&
						(!params.options.abortSignal?.aborted ||
							abortedByTurnDeadline(params.options.abortSignal))
					? "failed"
					: "uncertain";
		params.recorder.record(
			failure.entry,
			failure.modelPayload !== null && typeof failure.modelPayload === "object"
				? { state, result: failure.modelPayload }
				: undefined,
		);
		return failure.modelPayload;
	}
}

// ── Compact model-facing schemas ─────────────────────────────────
//
// The chat template renders every tool's JSON schema verbatim into the
// prompt, so zod's boilerplate ("$schema", additionalProperties:false,
// minLength:1, the 2^53 integer ceiling) costs real tokens on every turn.
// The model is shown a trimmed copy; validation still runs the full zod
// schema, so nothing is accepted that was not accepted before.

const NOISE_KEYS = new Set(["$schema", "additionalProperties"]);

function compactJsonSchema(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(compactJsonSchema);
	if (!value || typeof value !== "object") return value;
	const out: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (NOISE_KEYS.has(key)) continue;
		if (key === "minLength" && entry === 1) continue;
		if (key === "maximum" && entry === 9007199254740991) continue;
		if (key === "minimum" && entry === -9007199254740991) continue;
		out[key] = compactJsonSchema(entry);
	}
	return out;
}

export function compactToolInputSchema<T>(
	schema: z.ZodType<T>,
	shown: z.ZodType | JSONSchema7 = schema,
): ReturnType<typeof jsonSchema<T>> {
	const full = shown instanceof z.ZodType ? asSchema(shown).jsonSchema : shown;
	return jsonSchema<T>(compactJsonSchema(full) as JSONSchema7, {
		validate: (value) => {
			const parsed = schema.safeParse(value);
			return parsed.success
				? { success: true, value: parsed.data }
				: { success: false, error: parsed.error };
		},
	});
}

// ── Tool-shape narrowing ──────────────────────────────────────────
//
// Moved here from index.ts (decisions.md ruling 57): a pure type-narrowing
// cast with no runtime behavior, needed by every tool `index.ts` builds AND
// by `research-web-tool.ts`, which could no longer import it from index.ts
// once that import became the other half of a circular dependency (verify.ts
// -> normal-chat-tools/index.ts -> artifact-tools/create.ts -> ... ->
// verify.ts). `shared.ts` is a leaf module with no such risk.

export type RequiredExecuteTool<TInput, TOutput> = Tool<TInput, TOutput> & {
	execute: NonNullable<Tool<TInput, TOutput>["execute"]>;
};

export function asExecutableTool<TInput, TOutput>(
	toolDefinition: Tool<TInput, TOutput>,
): RequiredExecuteTool<TInput, TOutput> {
	return toolDefinition as RequiredExecuteTool<TInput, TOutput>;
}
