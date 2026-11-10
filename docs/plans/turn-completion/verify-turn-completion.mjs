#!/usr/bin/env node
// Live check of how Normal Chat turns END on a staging AlfyAI instance (docs/plans/turn-completion).
// Node 22, no dependencies. One new conversation per prompt, one streamed turn each, one after another.
// Nothing is deleted. Credentials come from the environment only (same names as
// docs/plans/jobs-merge/verify-jobs.mjs: EMAIL, PASSWORD, BASE, APP_ORIGIN).
//
//   set -a; . /root/verify-harness.env; set +a
//   BASE=http://127.0.0.1:3002 node verify-turn-completion.mjs --list-models
//   BASE=http://127.0.0.1:3002 node verify-turn-completion.mjs --model <modelId> --set <tools|silent|smoke> \
//       [--limit N] [--label NAME] [--depth thorough|quick]
//
// Per turn it records: HTTP status, whether an error part arrived and its code, the visible text (the
// concatenated text deltas), reasoning characters, tool names in order, the terminal metadata part
// (assistantMessageId, completionWarningCodes, wasStopped, ...), wall time and the conversation id.
// Output: one compact line per turn, a last line `SUMMARY {json}`, and the full results as
// ./turn-completion-<label or model tail>-<set>.json (rewritten after every turn).
// Exit 0 when every turn reached a terminal frame (a finish part, [DONE] or an error part; warnings do not
// matter), 1 otherwise (HTTP refusal, timeout, connection cut with no terminal frame, no login). 2 = bad usage.

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

const BASE = (process.env.BASE ?? "http://127.0.0.1:3002").replace(/\/+$/, "");
const EMAIL = process.env.EMAIL;
const PASSWORD = process.env.PASSWORD;
// SvelteKit refuses form-type requests with a missing or foreign Origin; verify-jobs.mjs sends the
// instance's public origin on every request and so does this script.
const ORIGIN = process.env.APP_ORIGIN ?? "https://ai.dev.alfydesign.com";

const TURN_TIMEOUT_MS = (Number(process.env.TURN_TIMEOUT_SEC) || 240) * 1000; // per turn, from the request the server accepted
const HEADERS_TIMEOUT_MS = 60_000; // the server answers at once (it sends a padding comment first)
const CALL_TIMEOUT_MS = 30_000; // login, conversation create, model list, stop
const CAPACITY_RETRIES = 8; // 503 CAPACITY_EXCEEDED: the previous stream is still being released

// ---------------------------------------------------------------------------------------------
// Prompt sets. Made up on purpose; do not replace them with anything from the repository.
// ---------------------------------------------------------------------------------------------

const TOOLS_PROMPTS = [
	"A job used 1,283,417 input tokens at $0.95 per million and 96,204 output tokens at $4.00 per million. Use Python to compute each cost from the unrounded token counts, then give me the two costs and the total, rounded to cents only at the end.",
	"Use Python to work out the monthly payment on a 240,000 loan over 25 years at 4.1% a year, then tell me the payment and the total interest.",
	"Search the web for the current population of Limerick city and of Cork city, then tell me the difference and where each figure comes from.",
	"Use Python to compute what 5,000 grows to after 12 years at 3.7% a year, once with monthly compounding and once with annual compounding, and give both amounts and their difference to the cent.",
	"Search the web for the length of the River Shannon and of the River Liffey in kilometres, then tell me which is longer, by how much, and where each figure comes from.",
	"Here are twelve monthly electricity readings in kWh: 412, 389, 377, 301, 268, 244, 251, 262, 297, 341, 398, 431. Use Python to get the mean, the median, the sample standard deviation, and the pair of consecutive months with the biggest absolute change.",
	"Read https://en.wikipedia.org/wiki/Antikythera_mechanism and tell me in three sentences when it was found and what it is believed to have calculated.",
	"Use Python to find how many prime numbers there are below 20,000 and what they add up to.",
	"Search the web for the year the Panama Canal opened and the year the Suez Canal opened, then tell me how many years apart they are.",
	"Use Python to convert 73.6 miles per gallon (US) into litres per 100 km, and 6.2 litres per 100 km into miles per gallon (US). Show four decimal places.",
	"Open https://en.wikipedia.org/wiki/Mount_Kilimanjaro and tell me the height of its highest summit and the names of its three volcanic cones.",
	"Use Python to count the days between 14 March 2019 and 2 October 2031, and tell me which weekday the later date falls on.",
	"Search the web for the depth of the Challenger Deep and the height of Mount Everest, then tell me the total vertical distance between the two.",
	"Use Python with random seed 7 to simulate 100,000 rolls of two fair six-sided dice, report how often the total was 7, and compare that with the exact probability.",
	"Read https://en.wikipedia.org/wiki/Voyager_1 and tell me its launch date and, according to the page, how far from the Sun it is and how fast it travels.",
	"Use Python to solve the system 3x + 2y - z = 7, 2x - 2y + 4z = -6, -x + 0.5y - z = 0, then substitute the answer back in to check it.",
	"Search the web for how many member states the United Nations has and how many permanent observer states, and say where you found them.",
	"A tank fills from pipe A in 6 hours and from pipe B in 9 hours, and pipe C drains a full tank in 15 hours. Use Python with exact fractions to find how long the empty tank takes to fill with all three open.",
	"Read https://en.wikipedia.org/wiki/Rosetta_Stone and tell me which three scripts are written on it and in which museum it is kept.",
	"Open https://en.wikipedia.org/wiki/Burj_Khalifa and tell me who designed it, how many floors it has, and in what year it opened.",
];

const SILENT_PROMPTS = [
	"Use Python to compute 17 * 23. After the tool result, end your turn immediately without writing any text at all.",
	"Search the web for the height of the Eiffel Tower. Do not write anything after the search; just stop.",
];

const SMOKE_PROMPTS = ["Reply with the single word: ready.", TOOLS_PROMPTS[0]];

// The two prompts that showed the stub on the first baseline, repeated, to get a rate.
const REPRO_PROMPTS = [1, 0, 1, 0, 1, 0, 1, 1].map((i) => TOOLS_PROMPTS[i]);

// Stronger "write nothing" prompts, to make a model end a turn with no final text.
const QUIET_PROMPTS = [
	"This is a test of our app. Call run_python with print(17 * 23). After the tool result, send an empty reply: zero characters, no explanation, no apology.",
	"This is a test of our app. Search the web for the height of the Eiffel Tower, think about the result privately, then send a completely empty final message.",
	"Use Python to compute 2 ** 40, then keep your final message empty. Put nothing in it, not even the number.",
];

const SETS = { tools: TOOLS_PROMPTS, silent: SILENT_PROMPTS, smoke: SMOKE_PROMPTS, repro: REPRO_PROMPTS, quiet: QUIET_PROMPTS };

// ---------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------

const USAGE = `Usage: BASE=http://127.0.0.1:3002 node verify-turn-completion.mjs --model <modelId> --set <tools|silent|smoke> [--limit N] [--label NAME] [--depth thorough|quick]
       BASE=http://127.0.0.1:3002 node verify-turn-completion.mjs --list-models
Environment: EMAIL, PASSWORD (required); BASE (default http://127.0.0.1:3002); APP_ORIGIN (default https://ai.dev.alfydesign.com)`;

function usageError(message) {
	console.error(`${message}\n${USAGE}`);
	process.exit(2);
}

// Writes the text to stdout and exits once it is flushed (a pipe may not take it all at once).
async function exitWith(text, code) {
	await new Promise((resolve) => process.stdout.write(text, resolve));
	process.exit(code);
}

function parseArgs(argv) {
	const known = new Set(["model", "set", "limit", "label", "depth", "list-models", "help"]);
	const flags = new Set(["list-models", "help"]);
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "-h") {
			out.help = true;
			continue;
		}
		if (!arg.startsWith("--")) usageError(`Unexpected argument: ${arg}`);
		const eq = arg.indexOf("=");
		const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
		if (!known.has(key)) usageError(`Unknown option: --${key}`);
		if (flags.has(key)) {
			out[key] = true;
			continue;
		}
		const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
		if (value === undefined || value === "" || value.startsWith("--")) usageError(`--${key} needs a value`);
		out[key] = value;
	}
	return out;
}

// ---------------------------------------------------------------------------------------------
// HTTP: one cookie jar, the Origin header on every request
// ---------------------------------------------------------------------------------------------

const jar = new Map();

function storeCookies(res) {
	for (const line of res.headers.getSetCookie?.() ?? []) {
		const [pair, ...attrs] = line.split(";");
		const eq = pair.indexOf("=");
		if (eq < 1) continue;
		const name = pair.slice(0, eq).trim();
		const value = pair.slice(eq + 1).trim();
		const gone = value === "" || attrs.some((a) => /^\s*max-age\s*=\s*(0|-\d+)\s*$/i.test(a));
		if (gone) jar.delete(name);
		else jar.set(name, value);
	}
}

async function api(path, init = {}) {
	const headers = {
		origin: ORIGIN,
		...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
		...(init.headers ?? {}),
	};
	if (init.body !== undefined && !headers["content-type"]) headers["content-type"] = "application/json";
	const res = await fetch(`${BASE}${path}`, {
		...init,
		headers,
		signal: init.signal ?? AbortSignal.timeout(CALL_TIMEOUT_MS),
	});
	storeCookies(res);
	return res;
}

async function json(path, init) {
	const res = await api(path, init);
	const text = await res.text();
	let body = null;
	try {
		body = JSON.parse(text);
	} catch {
		body = text;
	}
	return { status: res.status, ok: res.ok, body };
}

function describeError(err) {
	const cause = err?.cause;
	return [err?.name, err?.message, cause?.code ?? cause?.message].filter(Boolean).join(": ");
}

function sleep(ms, signal) {
	return new Promise((resolve) => {
		const done = () => {
			clearTimeout(id);
			signal?.removeEventListener("abort", done);
			resolve();
		};
		const id = setTimeout(done, ms);
		signal?.addEventListener("abort", done, { once: true });
	});
}

async function login() {
	const r = await json("/api/auth/login", {
		method: "POST",
		body: JSON.stringify({ email: EMAIL, password: PASSWORD, rememberMe: false }),
	});
	if (r.ok && r.body?.twoStep === true) {
		throw new Error("login: this account has two-step sign-in on; use a test account without it");
	}
	if (!r.ok) throw new Error(`login failed: HTTP ${r.status} ${typeof r.body?.error === "string" ? r.body.error : ""}`.trim());
	if (!jar.has("session")) throw new Error("login answered 200 but set no session cookie");
}

async function listModels() {
	const r = await json("/api/models");
	const groups = Array.isArray(r.body?.providers) ? r.body.providers : null;
	if (!groups) return { rows: null, raw: `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 300)}` };
	const rows = [];
	for (const g of groups) {
		for (const m of Array.isArray(g?.models) ? g.models : []) {
			rows.push({ id: m?.id, name: m?.displayName, provider: g?.displayName ?? g?.name });
		}
	}
	// Ids the server also accepts without listing them: the built-ins when a provider row of the same
	// name hides them from the list, and the legacy aliases.
	const accepted = ["model1", "model2", ...(isObject(r.body?.modelAliases) ? Object.keys(r.body.modelAliases) : [])];
	return { rows, accepted, raw: null };
}

// ---------------------------------------------------------------------------------------------
// The stream: frame decoding mirrors src/lib/services/ai-sdk-ui-stream-contract.ts
// ---------------------------------------------------------------------------------------------

const DELIMITERS = ["\r\n\r\n", "\n\n", "\r\r"];

function decodeBlock(block) {
	const dataLines = [];
	let namedEvent = false;
	for (const line of block.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
		if (!line || line.startsWith(":")) continue; // padding and keep-alive comments
		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		if (field === "event") {
			namedEvent = true;
			continue;
		}
		if (field !== "data") continue;
		let value = colon === -1 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		dataLines.push(value);
	}
	if (namedEvent || dataLines.length === 0) return null;
	const raw = dataLines.join("\n").trim();
	if (raw === "[DONE]") return { kind: "done" };
	try {
		const part = JSON.parse(raw);
		return part && typeof part === "object" && typeof part.type === "string" ? { kind: "part", part } : null;
	} catch {
		return null;
	}
}

export function consumeFrames(value) {
	const frames = [];
	let rest = value;
	for (;;) {
		let next = null;
		for (const d of DELIMITERS) {
			const index = rest.indexOf(d);
			if (index !== -1 && (!next || index < next.index)) next = { index, length: d.length };
		}
		if (!next) break;
		const frame = decodeBlock(rest.slice(0, next.index));
		rest = rest.slice(next.index + next.length);
		if (frame) frames.push(frame);
	}
	return { frames, rest };
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" && v ? v : null);

export function newTurn(index, prompt) {
	return {
		index,
		prompt,
		conversationId: null,
		streamId: null,
		httpStatus: null,
		httpError: null,
		capacityRetries: 0,
		capacityWaitSec: 0,
		transportError: null,
		timedOut: false,
		interrupted: false,
		errorPart: false,
		errorCode: null,
		errorMessage: null,
		sawFinish: false,
		finishReason: null,
		sawDone: false,
		reachedTerminal: false,
		visibleText: "",
		visibleLength: 0,
		charsAfterLastTool: 0,
		reasoningChars: 0,
		tools: [],
		toolCalls: [],
		fallbackActivities: [],
		assistantMessageId: null,
		userMessageId: null,
		completionWarningCodes: [],
		upstreamFinishReason: null,
		upstreamRawFinishReason: null,
		wasStopped: null,
		streamClosedWithoutFinish: null,
		waitingQuestionId: null,
		servedModelId: null,
		servedModelDisplayName: null,
		serverGenerationMs: null,
		followUps: null,
		finalContent: null,
		partCounts: {},
		ms: 0,
		seconds: 0,
		outcome: "",
	};
}

// Parts that are only collected while the stream runs; they are folded into the turn by settle().
export function newAccumulator() {
	return { textChunks: [], metaParts: [] };
}

// One tool call arrives as a "running" event and then a "done" or "failed" one, with the same callId when
// there is one. Count calls, not events.
function noteToolCall(t, data) {
	const d = isObject(data) ? data : {};
	const name = str(d.name) ?? "?";
	const status = str(d.status);
	const callId = str(d.callId);
	let call = callId ? t.toolCalls.find((c) => c.callId === callId) : null;
	if (!call && status !== "running") {
		for (let i = t.toolCalls.length - 1; i >= 0; i--) {
			const c = t.toolCalls[i];
			if (c.name === name && c.status === "running" && (!callId || !c.callId)) {
				call = c;
				break;
			}
		}
	}
	if (call) {
		if (callId && !call.callId) call.callId = callId;
		if (status) call.status = status;
	} else {
		t.toolCalls.push({ name, callId, status });
	}
	t.charsAfterLastTool = 0;
}

// Returns true once the stream's [DONE] frame is seen.
export function applyFrame(t, acc, frame) {
	if (frame.kind === "done") {
		t.sawDone = true;
		return true;
	}
	const part = frame.part;
	t.partCounts[part.type] = (t.partCounts[part.type] ?? 0) + 1;
	switch (part.type) {
		case "text-delta": {
			const chunk = typeof part.delta === "string" ? part.delta : typeof part.text === "string" ? part.text : "";
			if (chunk) {
				acc.textChunks.push(chunk);
				t.charsAfterLastTool += chunk.length;
			}
			break;
		}
		case "reasoning-delta": {
			const chunk = typeof part.delta === "string" ? part.delta : typeof part.text === "string" ? part.text : "";
			t.reasoningChars += chunk.length;
			break;
		}
		case "data-tool-call":
			noteToolCall(t, part.data);
			break;
		case "data-response-activity":
			if (isObject(part.data) && part.data.kind === "fallback") {
				t.fallbackActivities.push({ id: str(part.data.id), status: str(part.data.status), detail: str(part.data.detail) });
			}
			break;
		case "data-stream-metadata":
			if (isObject(part.data)) acc.metaParts.push(part.data);
			break;
		case "data-stream-error": {
			const d = isObject(part.data) ? part.data : {};
			t.errorPart = true;
			t.errorCode ??= str(d.code) ?? (typeof d.status === "number" ? `http_${d.status}` : "unknown");
			t.errorMessage ??= str(d.message) ?? str(d.error) ?? str(part.data);
			break;
		}
		case "error":
			t.errorPart = true;
			t.errorCode ??= "error_part";
			t.errorMessage ??= str(part.errorText) ?? str(part.error);
			break;
		case "finish":
			t.sawFinish = true;
			t.finishReason = str(part.finishReason);
			break;
		default:
			break;
	}
	return false;
}

export function isEmptyVisible(t) {
	return t.visibleText.trim() === "" && !(typeof t.finalContent === "string" && t.finalContent.trim() !== "");
}

export function isCompleted(t) {
	return t.httpStatus === 200 && t.reachedTerminal && !t.errorPart && !t.timedOut && !t.interrupted && !t.transportError;
}

function outcomeOf(t) {
	let o;
	if (t.interrupted) o = "INTERRUPTED";
	else if (t.timedOut) o = "TIMEOUT";
	else if (t.transportError) o = `NET:${t.transportError.slice(0, 60)}`;
	else if (t.httpStatus !== null && t.httpStatus !== 200) o = `HTTP${t.httpStatus}${t.httpError?.code ? `:${t.httpError.code}` : ""}`;
	else if (t.errorPart) o = `ERR:${t.errorCode ?? "unknown"}`;
	else if (!t.reachedTerminal) o = "NO-TERMINAL";
	else if (t.wasStopped) o = "STOPPED";
	else if (t.waitingQuestionId) o = "PAUSED";
	else if (t.completionWarningCodes.length) o = `WARN:${t.completionWarningCodes.join("+")}`;
	else o = "ok";
	if (t.fallbackActivities.length) o += "+fb";
	return o;
}

// Folds what the stream carried into the turn's fields. Safe to call on a turn that failed early.
export function settle(t, acc, startedAtMs) {
	t.visibleText = acc.textChunks.join("");
	t.visibleLength = t.visibleText.length;
	const meta = Object.assign({}, ...acc.metaParts);
	t.assistantMessageId = str(meta.assistantMessageId);
	t.userMessageId = str(meta.userMessageId);
	t.completionWarningCodes = Array.isArray(meta.completionWarningCodes)
		? meta.completionWarningCodes.filter((c) => typeof c === "string")
		: [];
	t.upstreamFinishReason = str(meta.upstreamFinishReason);
	t.upstreamRawFinishReason = str(meta.upstreamRawFinishReason);
	t.wasStopped = typeof meta.wasStopped === "boolean" ? meta.wasStopped : null;
	t.streamClosedWithoutFinish = meta.streamClosedWithoutFinish === true ? true : null;
	t.waitingQuestionId = str(meta.waitingQuestionId);
	t.servedModelId = str(meta.modelId);
	t.servedModelDisplayName = str(meta.modelDisplayName);
	t.serverGenerationMs = typeof meta.generationDurationMs === "number" ? meta.generationDurationMs : null;
	t.followUps = Array.isArray(meta.followUps) ? meta.followUps.length : null;
	t.finalContent = typeof meta.finalContent === "string" ? meta.finalContent : null;
	t.reachedTerminal = t.sawDone || t.sawFinish || t.errorPart;
	t.tools = t.toolCalls.map((c) => c.name);
	if (startedAtMs !== undefined) t.ms = Math.round(performance.now() - startedAtMs);
	t.seconds = Math.round(t.ms / 100) / 10;
	t.outcome = outcomeOf(t);
	return t;
}

// ---------------------------------------------------------------------------------------------
// Running one turn
// ---------------------------------------------------------------------------------------------

let interrupted = false;
let currentAbort = null;

async function runTurn(index, prompt, cfg) {
	const t = newTurn(index, prompt);
	const acc = newAccumulator();
	let startedAt = performance.now();
	let timer = null;
	let timedOut = false;
	const ac = new AbortController();
	currentAbort = ac;
	const arm = (ms) => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			timedOut = true;
			ac.abort();
		}, ms);
	};
	try {
		const title = `verify-turn-completion ${cfg.label} ${cfg.set} #${index} ${new Date().toISOString().slice(0, 19)}Z`;
		const created = await json("/api/conversations", { method: "POST", body: JSON.stringify({ title }) });
		const conversationId = created.body?.id ?? created.body?.conversation?.id ?? created.body?.conversationId;
		if (!created.ok || typeof conversationId !== "string") {
			t.transportError = `conversation not created: HTTP ${created.status}`;
			return settle(t, acc, startedAt);
		}
		t.conversationId = conversationId;
		t.streamId = randomUUID();
		const body = { message: prompt, conversationId, streamId: t.streamId, model: cfg.model };
		if (cfg.depth) body.reasoningDepth = cfg.depth;

		let res;
		for (let attempt = 0; ; attempt++) {
			startedAt = performance.now();
			arm(HEADERS_TIMEOUT_MS);
			res = await api("/api/chat/stream", { method: "POST", body: JSON.stringify(body), signal: ac.signal });
			t.httpStatus = res.status;
			if (res.ok) break;
			const text = await res.text();
			let parsed = null;
			try {
				parsed = JSON.parse(text);
			} catch {
				/* not JSON: the proxy's page */
			}
			t.httpError = {
				code: str(parsed?.code),
				reason: str(parsed?.reason),
				message: str(parsed?.error) ?? text.slice(0, 200),
			};
			const retry = res.status === 503 && parsed?.code === "CAPACITY_EXCEEDED" && attempt < CAPACITY_RETRIES && !interrupted;
			if (!retry) return settle(t, acc, startedAt);
			const waitSec = Math.min(15, Math.max(2, Number(res.headers.get("retry-after")) || 5));
			t.capacityRetries++;
			t.capacityWaitSec += waitSec;
			clearTimeout(timer);
			await sleep(waitSec * 1000, ac.signal);
			if (interrupted) {
				t.interrupted = true;
				return settle(t, acc, startedAt);
			}
		}
		t.httpError = null;
		arm(Math.max(1000, TURN_TIMEOUT_MS - (performance.now() - startedAt)));
		if (!res.body) {
			t.transportError = "response has no body";
			return settle(t, acc, startedAt);
		}
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let sawDone = false;
		while (!sawDone) {
			const { done, value } = await reader.read();
			if (done) {
				buffer += decoder.decode();
				for (const frame of consumeFrames(buffer).frames) applyFrame(t, acc, frame);
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			const consumed = consumeFrames(buffer);
			buffer = consumed.rest;
			for (const frame of consumed.frames) {
				if (applyFrame(t, acc, frame)) sawDone = true;
			}
		}
		if (sawDone) await reader.cancel().catch(() => undefined);
	} catch (err) {
		if (timedOut) t.timedOut = true;
		else if (interrupted) t.interrupted = true;
		else t.transportError = describeError(err);
	} finally {
		clearTimeout(timer);
		currentAbort = null;
	}
	settle(t, acc, startedAt);
	if (t.timedOut && t.streamId) {
		// The server lets a turn run on when its reader disconnects; stop it as the browser's Stop button does,
		// so the next turn is not refused for capacity.
		await json("/api/chat/stream/stop", { method: "POST", body: JSON.stringify({ streamId: t.streamId }) }).catch(() => undefined);
	}
	return t;
}

// ---------------------------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------------------------

export function buildSummary(turns, cfg) {
	const withWarnings = {};
	const served = new Set();
	const assistantMessageIds = [];
	let completed = 0;
	let emptyVisible = 0;
	let fallbackTurns = 0;
	let doneToolTurns = 0;
	for (const t of turns) {
		if (isCompleted(t)) completed++;
		for (const code of new Set(t.completionWarningCodes)) withWarnings[code] = (withWarnings[code] ?? 0) + 1;
		if (t.httpStatus === 200 && isEmptyVisible(t)) emptyVisible++;
		if (t.fallbackActivities.length > 0) fallbackTurns++;
		if (t.tools.includes("done")) doneToolTurns++;
		if (t.servedModelId || t.servedModelDisplayName) served.add(`${t.servedModelId ?? "?"} ${t.servedModelDisplayName ?? ""}`.trim());
		if (t.assistantMessageId) assistantMessageIds.push(t.assistantMessageId);
	}
	return {
		turns: turns.length,
		completed,
		errors: turns.length - completed,
		withWarnings,
		emptyVisible,
		assistantMessageIds,
		fallbackTurns,
		doneToolTurns,
		servedAs: [...served],
		model: cfg.model,
		set: cfg.set,
		label: cfg.label,
	};
}

export function compactLine(t) {
	const tools = t.toolCalls.length ? t.toolCalls.map((c) => c.name + (c.status === "failed" ? "!" : "")).join(",") : "-";
	const head = t.visibleText.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 70);
	return [
		String(t.index).padStart(2, "0"),
		`${t.seconds.toFixed(1)}s`.padStart(7),
		`tools=${tools}`,
		`vis=${t.visibleLength}`,
		`post=${t.charsAfterLastTool}`,
		t.outcome,
		`| ${head}`,
	].join("  ");
}

function writeResults(file, cfg, startedAt, turns) {
	const doc = {
		meta: {
			script: "verify-turn-completion.mjs",
			startedAt,
			updatedAt: new Date().toISOString(),
			base: BASE,
			model: cfg.model,
			modelListed: cfg.modelListed,
			set: cfg.set,
			label: cfg.label,
			limit: cfg.limit ?? null,
			depth: cfg.depth ?? null,
			requestBodyFields: ["message", "conversationId", "streamId", "model", ...(cfg.depth ? ["reasoningDepth"] : [])],
		},
		summary: buildSummary(turns, cfg),
		turns,
	};
	writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
}

function safeName(s) {
	return String(s).replace(/[^A-Za-z0-9._-]+/g, "_");
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

export async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) await exitWith(`${USAGE}\n`, 0);
	if (!EMAIL || !PASSWORD) usageError("EMAIL and PASSWORD are required (environment variables)");
	if (!args["list-models"]) {
		if (!args.model) usageError("--model is required");
		if (!args.set || !Object.hasOwn(SETS, args.set)) usageError("--set must be one of: tools, silent, smoke, repro, quiet");
	}
	if (args.depth !== undefined && args.depth !== "thorough" && args.depth !== "quick") usageError("--depth must be thorough or quick");
	let limit;
	if (args.limit !== undefined) {
		limit = Number(args.limit);
		if (!Number.isInteger(limit) || limit < 1) usageError("--limit must be a positive integer");
	}

	process.on("SIGINT", () => {
		if (interrupted) process.exit(130);
		interrupted = true;
		console.error("\nInterrupted: finishing the report (press Ctrl-C again to quit at once)");
		currentAbort?.abort();
	});

	await login();
	const listing = await listModels().catch((err) => ({ rows: null, raw: describeError(err) }));

	if (args["list-models"]) {
		if (!listing.rows) await exitWith(`Could not read the model list: ${listing.raw}\n`, 1);
		await exitWith(listing.rows.map((r) => `${r.id}\t${r.name ?? ""}\t(${r.provider ?? ""})\n`).join(""), 0);
	}

	const model = args.model.trim();
	const modelTail = model.split(":").filter(Boolean).pop() ?? model;
	const cfg = {
		model,
		set: args.set,
		label: args.label ?? modelTail,
		depth: args.depth,
		limit,
		modelListed: listing.rows ? listing.rows.some((r) => r.id === model) || listing.accepted.includes(model) : null,
	};
	if (cfg.modelListed === false) {
		console.error(
			`WARNING: ${model} is not in GET /api/models. The server falls back to model1 for an id it does not know; ` +
				"check the 'servedAs' field of the SUMMARY line for the model that really answered.",
		);
	}
	const prompts = SETS[cfg.set].slice(0, limit ?? undefined);
	if (limit && limit > SETS[cfg.set].length) console.error(`Note: set '${cfg.set}' has only ${SETS[cfg.set].length} prompts`);
	const file = `./turn-completion-${safeName(args.label ?? modelTail)}-${cfg.set}.json`;
	const startedAt = new Date().toISOString();
	const turns = [];

	for (let i = 0; i < prompts.length && !interrupted; i++) {
		console.error(`[${i + 1}/${prompts.length}] ${prompts[i].slice(0, 80)}`);
		const t = await runTurn(i + 1, prompts[i], cfg);
		turns.push(t);
		writeResults(file, cfg, startedAt, turns);
		console.error(`    ${t.seconds.toFixed(1)}s ${t.outcome}`);
	}

	const summary = buildSummary(turns, cfg);
	const lines = [
		`# verify-turn-completion model=${model} set=${cfg.set} label=${cfg.label}${cfg.depth ? ` depth=${cfg.depth}` : ""} base=${BASE}`,
		"# idx  secs  tools  vis=visible chars  post=visible chars after the last tool event  end  | first 70 chars of the visible text",
		"# end: ok | WARN:<completionWarningCodes> | ERR:<error part code> | HTTP<status>:<code> | TIMEOUT | NO-TERMINAL | NET:<error> | STOPPED | PAUSED; +fb = a fallback activity was seen; tool! = the call failed",
		...turns.map(compactLine),
		`# wrote ${file}`,
		`SUMMARY ${JSON.stringify(summary)}`,
	];
	await exitWith(`${lines.join("\n")}\n`, turns.length > 0 && turns.every((t) => t.reachedTerminal) ? 0 : 1);
}

// VTC_IMPORT_ONLY=1 lets a test import the decoder and the report functions without running a check.
if (process.env.VTC_IMPORT_ONLY !== "1") {
	main().catch((err) => {
		console.error(`verify-turn-completion: ${err?.message ?? err}`);
		process.exit(1);
	});
}
