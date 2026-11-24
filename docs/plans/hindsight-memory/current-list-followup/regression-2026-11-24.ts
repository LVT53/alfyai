/**
 * Regression run, 2026-11-24: the 2026-11-18 "current list" sequences (en, hu, holdout)
 * replayed on TODAY's product bank config.
 *
 * The 2026-11-18 scripts (`serial.cjs`, `holdout.cjs`) were never committed; only their
 * records remain (`frozen.json`, `serial-results.json`, `serial-api.jsonl`,
 * `holdout-results.json`, `model-calls.jsonl`). This script rebuilds them from those records:
 *
 *  - inputs: the event texts, timestamps, document ids and chat/message ids come from the
 *    recorded model calls (`model-calls.jsonl`: the extraction chunk of every retain) and
 *    `serial-results.json` / `holdout-results.json`; the raw facts' `context`, `tags` and
 *    `metadata` in the recorded listings give the retain item's shape.
 *  - operations and their order: `serial-api.jsonl` (retain, wait, list; delete the pending
 *    document; add, edit and invalidate one fact; full native rebuild: auto-consolidation off,
 *    delete every raw fact's observations, POST /consolidate, auto-consolidation on).
 *  - config: NOT the 2026-11-18 overrides but `nativeBankConfig("personal")`, applied the way
 *    `hindsight-client.ts` `configure()` applies it (one PATCH /config {updates}, which creates
 *    the bank, then a readback of every key by value).
 *
 * Requests mirror `hindsight-client.ts`: retain {items:[{content, context, timestamp,
 * document_id, tags, metadata}], async, operation_id}; GET /operations/{id}; POST /consolidate {};
 * GET /memories/list?state=valid&limit=100&offset=N; PATCH /memories/{id} {text} or
 * {state:"invalidated", reason}; DELETE /documents/{id}; DELETE /memories/{id}/observations.
 *
 * Synthetic data only. Talks to 127.0.0.1 only. Never calls the model: Hindsight does, through
 * the running services. Uses its own fresh tenant per run; the full run leaves its banks in place
 * (--quick and --plumbing delete theirs).
 *
 *   node --import tsx docs/plans/hindsight-memory/current-list-followup/regression-2026-11-24.ts
 *   ... --plumbing --out <file>   no model calls: bank creation, config readback, empty reads
 *   ... --quick --out <file>      a short en sequence on a throwaway bank (deleted afterwards)
 *   ... --cases en,hu,holdout     default: all three, run side by side
 */
import { createHash, createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import {
	HINDSIGHT_ENGINE_COMMIT,
	type NativeBankConfig,
	nativeBankConfig,
	type RetainSource,
} from "../../../../src/lib/server/services/memory-profile/contracts.ts";

// ---------------------------------------------------------------------------------------
// Arguments and constants
// ---------------------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
};

const BASE = (option("--hindsight") ?? "http://127.0.0.1:18895").replace(/\/+$/, "");
if (new URL(BASE).hostname !== "127.0.0.1")
	throw new Error("This run talks to 127.0.0.1 only");
const PLUMBING = flag("--plumbing");
const QUICK = flag("--quick");
if ((PLUMBING || QUICK) && !option("--out"))
	throw new Error("--plumbing and --quick need --out <file> outside the repository");
const OUT = path.resolve(option("--out") ?? path.join(here, "results-2026-11-24.json"));
const CASES = (option("--cases") ?? "en,hu,holdout").split(",");

/** What the recorded raw facts carry in `context` (serial-results.json, holdout-results.json). */
const SYNTHETIC_CONTEXT =
	"Synthetic user message or explicit source edit. Preserve attribution and original assertion time.";
const POLL_MS = 2_000;
/** No operation gets less than ten minutes; one stage may wait this long in all. */
const STAGE_WAIT_MS = 45 * 60_000;
const REQUEST_TIMEOUT_MS = 180_000;

// ---------------------------------------------------------------------------------------
// Scratch tenant and credential (hindsight-client.ts tenantKey(): `${version}.${tenantId}.${hmac}`)
// ---------------------------------------------------------------------------------------

const TENANT = randomUUID();
const API_KEY = (() => {
	const body = `synthetic.${TENANT}`;
	const signature = createHmac("sha256", Buffer.from("ab".repeat(32), "hex"))
		.update(body)
		.digest("hex");
	return `${body}.${signature}`;
})();

// ---------------------------------------------------------------------------------------
// Types and small helpers
// ---------------------------------------------------------------------------------------

type Json = Record<string, any>;
interface Row extends Json {
	id: string;
	text: string;
	fact_type: string;
	document_id?: string | null;
	mentioned_at?: string | null;
	tags?: string[] | null;
	source_memory_ids?: string[] | null;
	consolidated_at?: string | null;
	consolidation_failed_at?: string | null;
}
interface SourceEvent {
	id: string;
	at: string;
	text: string;
	metadata: { chat_id: string; message_id: string };
}
type Stage =
	| { name: string; kind: "retain"; events: string[] }
	| { name: string; kind: "delete-document"; document: string }
	| { name: string; kind: "edit-single"; document: string; text: string }
	| { name: string; kind: "remove-single"; document: string; reason: string }
	| { name: string; kind: "rebuild" };
interface CaseSpec {
	id: string;
	bank: string;
	lang: string;
	events: SourceEvent[];
	stages: Stage[];
	/** Terms whose presence in the visible rows is reported as evidence (never as a verdict). */
	watch: string[];
	/** Documents not yet accepted while they exist (the recorded `pending` source). */
	pendingDocument: string | null;
	/** One native search over the observations after the last stage, for the old value. */
	oldWord: string | null;
}

const isObservation = (row: Row) => row.fact_type === "observation";
const now = () => new Date().toISOString();
const t0 = Date.now();
const log = (scope: string, message: string) =>
	console.log(`${now().slice(11, 19)} [${scope}] ${message}`);

/** `verifyConfig`'s comparison: arrays in order, objects whatever their key order. */
function sameValue(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) || Array.isArray(b))
		return (
			Array.isArray(a) &&
			Array.isArray(b) &&
			a.length === b.length &&
			a.every((item, index) => sameValue(item, b[index]))
		);
	if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
	const keys = Object.keys(a);
	return (
		keys.length === Object.keys(b).length &&
		keys.every(
			(key) =>
				Object.hasOwn(b, key) &&
				sameValue(
					(a as Record<string, unknown>)[key],
					(b as Record<string, unknown>)[key],
				),
		)
	);
}

class HttpError extends Error {
	constructor(
		readonly status: number,
		readonly method: string,
		readonly suffix: string,
		readonly body: string,
	) {
		super(`${method} ${suffix} -> ${status} ${body.slice(0, 300)}`);
	}
}

// ---------------------------------------------------------------------------------------
// Results file (checkpointed after every stage, atomically)
// ---------------------------------------------------------------------------------------

const results: Json = {
	suite: "current-list regression, 2026-11-24",
	status: "running",
	started: now(),
	finished: null,
	wallSeconds: null,
	run: {
		script: "docs/plans/hindsight-memory/current-list-followup/regression-2026-11-24.ts",
		mode: PLUMBING ? "plumbing" : QUICK ? "quick" : "full",
		hindsightUrl: BASE,
		enginePin: HINDSIGHT_ENGINE_COMMIT,
		tenant: TENANT,
		credentialVersion: "synthetic",
		configSource:
			"nativeBankConfig('personal') from src/lib/server/services/memory-profile/contracts.ts, applied by one PATCH /config {updates} as hindsight-client.ts configure() does",
		pollMs: POLL_MS,
		stageWaitMinutes: STAGE_WAIT_MS / 60_000,
		recordedBaseline: "docs/plans/hindsight-memory/current-list-followup/serial-results.json and holdout-results.json (2026-11-18)",
	},
	configSent: nativeBankConfig("personal"),
	cases: [] as Json[],
	holdout: null,
	apiLog: [] as Json[],
};
function save() {
	results.wallSeconds = Math.round((Date.now() - t0) / 1000);
	const tmp = `${OUT}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(results, null, "\t")}\n`);
	renameSync(tmp, OUT);
}

// ---------------------------------------------------------------------------------------
// Hindsight HTTP (the calls of hindsight-client.ts, against one bank)
// ---------------------------------------------------------------------------------------

async function http(
	bank: string | null,
	method: string,
	suffix: string,
	body?: unknown,
	options: { log?: Json; okStatuses?: number[]; attempts?: number } = {},
): Promise<{ status: number; data: any }> {
	const url =
		bank === null
			? `${BASE}${suffix}`
			: `${BASE}/v1/default/banks/${encodeURIComponent(bank)}${suffix}`;
	const attempts = options.attempts ?? (method === "GET" ? 5 : 1);
	let lastError: unknown;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		const started = Date.now();
		try {
			const response = await fetch(url, {
				method,
				redirect: "error",
				headers: {
					Authorization: `Bearer ${API_KEY}`,
					"Content-Type": "application/json",
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			const text = await response.text();
			let data: any = null;
			try {
				data = text ? JSON.parse(text) : null;
			} catch {
				data = { unparsed: text.slice(0, 500) };
			}
			if (options.log)
				(results.apiLog as Json[]).push({
					at: now(),
					bank,
					method,
					suffix,
					status: response.status,
					ms: Date.now() - started,
					...options.log,
				});
			const ok =
				response.ok || (options.okStatuses ?? []).includes(response.status);
			if (!ok) {
				const error = new HttpError(response.status, method, suffix, text);
				if (method === "GET" && response.status >= 500 && attempt < attempts) {
					lastError = error;
					await sleep(1_000 * attempt);
					continue;
				}
				throw error;
			}
			return { status: response.status, data };
		} catch (error) {
			if (error instanceof HttpError) throw error;
			lastError = error;
			if (attempt < attempts) await sleep(1_000 * attempt);
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Mutations are logged with their request body, config bodies by key only. */
const mutation = (body?: unknown, extra: Json = {}): Json => ({
	request: body,
	...extra,
});

async function verifyCapabilities() {
	const { data } = await http(null, "GET", "/ext/alfyai/capabilities");
	const expected = createHash("sha256")
		.update(`alfyai_t_${TENANT.replaceAll("-", "_")}`)
		.digest("hex");
	if (
		data.engine_commit !== HINDSIGHT_ENGINE_COMMIT ||
		data.extension !== "alfyai-identity-v1" ||
		data.tenant_binding !== expected
	)
		throw new Error(`capability mismatch: ${JSON.stringify(data)}`);
	return data as Json;
}

/** `configure()`: one PATCH /config {updates} (creates the bank), then a by-value readback. */
async function configureBank(bank: string, config: NativeBankConfig) {
	await http(
		bank,
		"PATCH",
		"/config",
		{ updates: config },
		{ log: { request: { updates: Object.keys(config) } } },
	);
	const { data } = await http(bank, "GET", "/config", undefined, {
		log: { purpose: "verifyConfig readback" },
	});
	const effective = (data.config ?? data) as Json;
	const mismatched = Object.entries(config)
		.filter(([key, value]) => !sameValue(effective[key], value))
		.map(([key]) => key);
	if (mismatched.length)
		throw new Error(`native_config_mismatch on ${bank}: ${mismatched.join(", ")}`);
	return { verified: true, readback: data as Json };
}

async function patchConfig(bank: string, updates: Json) {
	const { data } = await http(bank, "PATCH", "/config", { updates }, {
		log: mutation({ updates }),
	});
	return data as Json;
}

async function readConfig(bank: string) {
	return (await http(bank, "GET", "/config")).data as Json;
}

async function listAll(bank: string): Promise<{ rows: Row[]; total: number }> {
	const rows: Row[] = [];
	const seen = new Set<string>();
	let total = -1;
	for (let offset = 0; offset < 100_000; offset += 100) {
		const { data } = await http(
			bank,
			"GET",
			`/memories/list?state=valid&limit=100&offset=${offset}`,
		);
		if (typeof data.total !== "number" || data.offset !== offset)
			throw new Error("native_capture_unstable: list paging");
		if (total >= 0 && data.total !== total)
			throw new Error("native_capture_unstable: total moved");
		total = data.total;
		for (const row of data.items as Row[]) {
			if (seen.has(row.id)) throw new Error("native_capture_unstable: duplicate row");
			seen.add(row.id);
			rows.push(row);
		}
		if (rows.length >= total || data.items.length === 0) break;
	}
	return { rows, total };
}

/** Two listings in a row that agree: a stable capture. */
async function captureStable(bank: string) {
	let last = await listAll(bank);
	for (let attempt = 0; attempt < 5; attempt++) {
		await sleep(500);
		const next = await listAll(bank);
		const key = (rows: Row[]) =>
			JSON.stringify(
				rows.map((r) => [r.id, r.text, r.state, r.source_memory_ids, r.consolidated_at]),
			);
		if (key(next.rows) === key(last.rows)) return next;
		last = next;
	}
	return last;
}

async function listOperations(bank: string): Promise<Json[]> {
	const all: Json[] = [];
	for (let offset = 0; offset < 1000; offset += 100) {
		const { data } = await http(bank, "GET", `/operations?limit=100&offset=${offset}`);
		const page = (data.operations ?? []) as Json[];
		all.push(...page);
		if (page.length < 100) break;
	}
	return all;
}

const ACTIVE = new Set(["pending", "processing"]);
const TERMINAL_BAD = new Set(["failed", "cancelled"]);

/** Waits for one operation (a retain's, a consolidation's) to end; `failed` or `cancelled` throws. */
async function waitOperation(bank: string, id: string, scope: string, deadline: number) {
	let missing = 0;
	for (;;) {
		if (Date.now() > deadline) throw new Error(`timeout waiting for operation ${id}`);
		let status: string;
		try {
			status = (await http(bank, "GET", `/operations/${encodeURIComponent(id)}`)).data.status;
		} catch (error) {
			if (error instanceof HttpError && error.status === 404 && ++missing <= 5) {
				await sleep(POLL_MS);
				continue;
			}
			throw error;
		}
		if (status === "completed") return status;
		if (TERMINAL_BAD.has(status))
			throw new Error(`operation ${id} ended ${status} (${scope})`);
		await sleep(POLL_MS);
	}
}

interface SettleReport {
	polls: number;
	seconds: number;
	safetyConsolidation: boolean;
	failedOperations: Json[];
	rawFailedConsolidation: string[];
}

/**
 * Waits until nothing is running in the bank: no pending or processing operation of any kind and,
 * with auto-consolidation on, every valid raw fact consolidated, on two polls in a row. Retains
 * and consolidations (also the ones Hindsight queues itself after a retain, a document delete, a
 * memory edit) all end before a stage is read. If raw facts stay unconsolidated for ~90 seconds
 * with nothing running, one POST /consolidate is sent, as the app's delivery does, and said so.
 */
async function settle(
	bank: string,
	scope: string,
	options: { startedIso: string; explicit?: string[]; autoConsolidation: boolean },
): Promise<SettleReport> {
	const began = Date.now();
	const deadline = began + STAGE_WAIT_MS;
	for (const id of options.explicit ?? []) await waitOperation(bank, id, scope, deadline);
	let quiet = 0;
	let idleWithPending = 0;
	let polls = 0;
	let safetyConsolidation = false;
	for (;;) {
		if (Date.now() > deadline)
			throw new Error(`timeout: ${scope} did not settle in ${STAGE_WAIT_MS / 60_000} minutes`);
		const operations = await listOperations(bank);
		const active = operations.filter((op) => ACTIVE.has(op.status));
		const { rows } = await listAll(bank);
		const pendingRaw = rows.filter(
			(r) => !isObservation(r) && !r.consolidated_at && !r.consolidation_failed_at,
		);
		polls++;
		const idle = active.length === 0;
		const settled = idle && (pendingRaw.length === 0 || !options.autoConsolidation);
		quiet = settled ? quiet + 1 : 0;
		idleWithPending =
			idle && pendingRaw.length > 0 && options.autoConsolidation ? idleWithPending + 1 : 0;
		if (quiet >= 2) {
			const failedSince = operations.filter(
				(op) =>
					op.status === "failed" &&
					typeof op.created_at === "string" &&
					op.created_at >= options.startedIso,
			);
			return {
				polls,
				seconds: Math.round((Date.now() - began) / 1000),
				safetyConsolidation,
				failedOperations: failedSince.map((op) => ({
					id: op.id,
					type: op.operation_type,
					error_message: op.error_message,
					retry_count: op.retry_count,
				})),
				rawFailedConsolidation: rows
					.filter((r) => !isObservation(r) && r.consolidation_failed_at)
					.map((r) => r.id),
			};
		}
		if (idleWithPending >= 45 && !safetyConsolidation) {
			safetyConsolidation = true;
			idleWithPending = 0;
			log(scope, "raw facts unconsolidated with nothing running for ~90 s: POST /consolidate (as the app's delivery does)");
			const { data } = await http(bank, "POST", "/consolidate", {}, {
				log: mutation({}, { purpose: "safety consolidation" }),
			});
			await waitOperation(bank, data.operation_id, scope, deadline);
		}
		await sleep(POLL_MS);
	}
}

/** The operations Hindsight ran since a moment, compactly (kind, how it ended, the consolidation's counts). */
async function operationsSince(bank: string, sinceIso: string): Promise<Json[]> {
	const skew = new Date(Date.parse(sinceIso) - 2_000).toISOString();
	return (await listOperations(bank))
		.filter((op) => typeof op.created_at === "string" && op.created_at >= skew)
		.map((op) => ({
			id: op.id,
			type: op.operation_type,
			status: op.status,
			items_count: op.items_count,
			document_id: op.document_id,
			created_at: op.created_at,
			updated_at: op.updated_at,
			retry_count: op.retry_count,
			error_message: op.error_message,
			progress: op.progress?.detail ?? null,
		}))
		.reverse();
}

// ---------------------------------------------------------------------------------------
// Labels (what the app reads from a raw fact's tags: `kind:` and `subject:`)
// ---------------------------------------------------------------------------------------

function labelsOf(tags: readonly string[] | null | undefined) {
	const pick = (prefix: string) => {
		for (const tag of tags ?? [])
			if (tag.startsWith(prefix)) return tag.slice(prefix.length).trim().toLowerCase();
		return null;
	};
	return { kind: pick("kind:"), subject: pick("subject:") };
}

// ---------------------------------------------------------------------------------------
// One stage's record: raw, observations, eligible, rejected, view, visible
// ---------------------------------------------------------------------------------------

/** The recorded `visible` row: id, current text, native notes (none separated), original, sources. */
function viewRow(observation: Row, rawById: Map<string, Row>) {
	const sources = (observation.source_memory_ids ?? [])
		.map((id) => rawById.get(id))
		.filter((fact): fact is Row => !!fact)
		.sort((a, b) => String(b.mentioned_at ?? "").localeCompare(String(a.mentioned_at ?? "")));
	const labelled = sources.find((fact) => {
		const { kind, subject } = labelsOf(fact.tags);
		return kind || subject;
	});
	return {
		id: observation.id,
		current: observation.text,
		nativeNotes: [] as string[],
		original: observation.text,
		sourceIds: observation.source_memory_ids ?? [],
		// Extra to the recorded shape: the kind and subject Hindsight's extraction wrote into the
		// supporting facts' tags (today's config 2), as the app's entryLabels picks them.
		labels: labelled
			? { ...labelsOf(labelled.tags), fromFact: labelled.id }
			: { kind: null, subject: null, fromFact: null },
	};
}

function classify(rows: Row[], pendingDocument: string | null, pendingExists: boolean) {
	const raw = rows.filter((r) => !isObservation(r));
	const observations = rows.filter(isObservation);
	const rawById = new Map(raw.map((r) => [r.id, r]));
	const accepted = (document: string | null | undefined) =>
		!(pendingExists && pendingDocument !== null && document === pendingDocument);
	const eligible: Row[] = [];
	const rejected: Json[] = [];
	for (const observation of observations) {
		const sources = observation.source_memory_ids ?? [];
		const bad = sources
			.map((id) => ({ id, fact: rawById.get(id) }))
			.filter(({ fact }) => !fact || !accepted(fact.document_id))
			.map(({ id, fact }) => ({
				sourceId: id,
				document_id: fact ? fact.document_id : "missing from the valid listing",
			}));
		if (!sources.length || bad.length)
			rejected.push({ ...observation, rejectedBecause: sources.length ? bad : "no source facts" });
		else eligible.push(observation);
	}
	return { raw, observations, rawById, eligible, rejected };
}

function termReport(visible: Json[], watch: string[]) {
	const report: Record<string, number[]> = {};
	for (const term of watch) {
		const needle = term.toLowerCase();
		report[term] = visible
			.map((row, index) => (String(row.current).toLowerCase().includes(needle) ? index : -1))
			.filter((index) => index >= 0);
	}
	return report;
}

/** Earlier-history wording in a row: today's "previously ..." and the engine's dated "(YYYY-MM-DD HH:MM: ...)" notes. */
const HISTORY_MARKERS =
	/\b(previously|formerly|earlier|used to|before that|originally|korábban|régebben|eredetileg|előzőleg|azelőtt)\b|\(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:/i;
const historyMarkers = (text: string) => {
	const match = HISTORY_MARKERS.exec(text);
	return match ? match[0] : null;
};

// ---------------------------------------------------------------------------------------
// The sequences
// ---------------------------------------------------------------------------------------

const EN_EVENTS: SourceEvent[] = [
	{
		id: "old",
		at: "2026-11-01T12:00:00Z",
		text: "User: I own an amber hiking backpack and a white canoe. I prefer decaf coffee. My sister prefers green tea.",
		metadata: { chat_id: "chat-old", message_id: "message-old" },
	},
	{
		id: "newer",
		at: "2026-11-10T12:00:00Z",
		text: "User: My hiking backpack is teal. I now prefer espresso.",
		metadata: { chat_id: "chat-newer", message_id: "message-newer" },
	},
	{
		id: "correction",
		at: "2026-11-12T12:00:00Z",
		text: "User: Correction: my hiking backpack is green. The earlier teal description was wrong; it has not changed colour.",
		metadata: { chat_id: "chat-correction", message_id: "message-correction" },
	},
	{
		id: "old-replay",
		at: "2026-11-01T12:00:00Z",
		text: "User: I own an amber hiking backpack and a white canoe. I prefer decaf coffee. My sister prefers green tea.",
		metadata: { chat_id: "chat-old", message_id: "message-old" },
	},
	{
		id: "pending",
		at: "2026-11-20T12:00:00Z",
		text: "User: My hiking backpack is orange.",
		metadata: { chat_id: "chat-pending", message_id: "message-pending" },
	},
	{
		id: "notebook",
		at: "2026-11-21T12:00:00Z",
		text: "User: My preferred notebook brand is Leuchtturm.",
		metadata: { chat_id: "chat-notebook", message_id: "message-notebook" },
	},
	{
		id: "insert",
		at: "2026-11-22T12:00:00Z",
		text: "User: I own a copper kettle.",
		metadata: { chat_id: "chat-insert", message_id: "message-insert" },
	},
];

const HU_EVENTS: SourceEvent[] = [
	{
		id: "old",
		at: "2026-11-01T12:00:00Z",
		text: "User: Van egy piros kerékpárom és egy fehér kajakom. Rövid válaszokat kérek. A húgom Győrben él.",
		metadata: { chat_id: "chat-old", message_id: "message-old" },
	},
	{
		id: "newer",
		at: "2026-11-10T12:00:00Z",
		text: "User: A kerékpárom kék. Most részletes válaszokat kérek.",
		metadata: { chat_id: "chat-newer", message_id: "message-newer" },
	},
	{
		id: "correction",
		at: "2026-11-12T12:00:00Z",
		text: "User: Javítás: a kerékpárom zöld. A korábbi kék leírás téves volt; nem változott meg a színe.",
		metadata: { chat_id: "chat-correction", message_id: "message-correction" },
	},
	{
		id: "old-replay",
		at: "2026-11-01T12:00:00Z",
		text: "User: Van egy piros kerékpárom és egy fehér kajakom. Rövid válaszokat kérek. A húgom Győrben él.",
		metadata: { chat_id: "chat-old", message_id: "message-old" },
	},
	{
		id: "pending",
		at: "2026-11-20T12:00:00Z",
		text: "User: A kerékpárom narancssárga.",
		metadata: { chat_id: "chat-pending", message_id: "message-pending" },
	},
	{
		id: "notebook",
		at: "2026-11-21T12:00:00Z",
		text: "User: A kedvenc füzetmárkám a Leuchtturm.",
		metadata: { chat_id: "chat-notebook", message_id: "message-notebook" },
	},
	{
		// The recorded Hungarian run inserted this English sentence.
		id: "insert",
		at: "2026-11-22T12:00:00Z",
		text: "User: I own a copper kettle.",
		metadata: { chat_id: "chat-insert", message_id: "message-insert" },
	},
];

/** The eleven recorded stages, in the recorded order. */
function serialStages(editedText: string, removeReason: string): Stage[] {
	return [
		{ name: "original", kind: "retain", events: ["old"] },
		{ name: "newer", kind: "retain", events: ["newer"] },
		{ name: "correction", kind: "retain", events: ["correction"] },
		{ name: "old-replay", kind: "retain", events: ["old-replay"] },
		{ name: "pending", kind: "retain", events: ["pending"] },
		{ name: "pending-removed", kind: "delete-document", document: "pending" },
		{ name: "single-added", kind: "retain", events: ["notebook"] },
		{ name: "single-edited", kind: "edit-single", document: "notebook", text: editedText },
		{ name: "single-removed", kind: "remove-single", document: "notebook", reason: removeReason },
		{ name: "full-native-rebuild", kind: "rebuild" },
		{ name: "insert", kind: "retain", events: ["insert"] },
	];
}
/** `curation-runner.ts` removes a fact with this reason. */
const REMOVE_REASON = "Explicit user memory removal";

const EN: CaseSpec = {
	id: "en",
	bank: "clf-1124-en",
	lang: "en",
	events: EN_EVENTS,
	stages: serialStages("The user prefers Rhodia notebooks.", REMOVE_REASON),
	watch: [
		"amber", "teal", "green", "orange", "espresso", "decaf", "canoe", "sister",
		"tea", "Leuchtturm", "Rhodia", "kettle", "previously",
	],
	pendingDocument: "pending",
	oldWord: "amber",
};
const HU: CaseSpec = {
	id: "hu",
	bank: "clf-1124-hu",
	lang: "hu",
	events: HU_EVENTS,
	stages: serialStages("A felhasználó a Rhodia füzeteket kedveli.", REMOVE_REASON),
	watch: [
		"piros", "kék", "zöld", "narancs", "részletes", "rövid", "kajak", "Győr",
		"húga", "Leuchtturm", "Rhodia", "vízforraló", "korábban",
	],
	pendingDocument: "pending",
	oldWord: "piros",
};

/** The recorded holdout: one native batch of four sources, out of order, then a full native rebuild. */
const HOLDOUT_EVENTS: SourceEvent[] = [
	{
		id: "newer",
		at: "2026-11-12T12:00:00Z",
		text: "User: I now live in Cork. I still commute by train.",
		metadata: { chat_id: "chat-newer", message_id: "message-newer" },
	},
	{
		id: "past",
		at: "2026-11-13T12:00:00Z",
		text: "User: I lived in Galway in 2020. I might move to Belfast next summer, but I have not decided.",
		metadata: { chat_id: "chat-past", message_id: "message-past" },
	},
	{
		id: "older",
		at: "2026-11-01T12:00:00Z",
		text: "User: I live in Dublin and commute by train.",
		metadata: { chat_id: "chat-older", message_id: "message-older" },
	},
	{
		id: "question",
		at: "2026-11-14T12:00:00Z",
		text: "User: Would a cordless drill help with this shelf? I do not own a drill. My colleague Nora owns one.",
		metadata: { chat_id: "chat-question", message_id: "message-question" },
	},
];
const HOLDOUT: CaseSpec = {
	id: "holdout",
	bank: "clf-1124-holdout",
	lang: "en",
	events: HOLDOUT_EVENTS,
	stages: [
		{ name: "batch", kind: "retain", events: ["newer", "past", "older", "question"] },
		{ name: "rebuild", kind: "rebuild" },
	],
	watch: [
		"Cork", "Dublin", "Galway", "Belfast", "2020", "drill", "Nora", "does not own",
		"not decided", "commute", "previously",
	],
	pendingDocument: null,
	oldWord: "Dublin",
};

/** --quick: a short en sequence that runs every kind of stage once (a throwaway bank). */
const QUICK_CASE: CaseSpec = {
	...EN,
	id: "quick",
	bank: "clf-1124-quick",
	stages: serialStages("The user prefers Rhodia notebooks.", REMOVE_REASON).filter((stage) =>
		["original", "pending", "pending-removed", "single-added", "single-edited", "single-removed", "full-native-rebuild", "insert"].includes(stage.name),
	),
};

// ---------------------------------------------------------------------------------------
// Running one case
// ---------------------------------------------------------------------------------------

function retainItem(event: SourceEvent): RetainSource {
	return {
		content: event.text,
		context: SYNTHETIC_CONTEXT,
		timestamp: new Date(event.at).toISOString(),
		document_id: event.id,
		tags: [event.id],
		metadata: event.metadata,
	};
}

async function runCase(spec: CaseSpec, record: Json) {
	const { bank } = spec;
	const scope = spec.id;
	const eventById = new Map(spec.events.map((event) => [event.id, event]));
	const eventRecords = new Map<string, Json>();
	const config = nativeBankConfig("personal");

	// Bank creation and config: PATCH /config creates the bank; every key is read back by value.
	const applied = await configureBank(bank, config);
	record.config = {
		sent: config,
		verifiedByValue: applied.verified,
		readback: applied.readback,
		final: null,
	};
	log(scope, `bank ${bank} created and its config verified (${Object.keys(config).join(", ")})`);
	save();

	let published: Json[] | null = null;
	let pendingExists = false;

	for (const stage of spec.stages) {
		const startedIso = now();
		const began = Date.now();
		log(scope, `stage ${stage.name}: start`);
		const stageRecord: Json = { stage: stage.name, kind: stage.kind, startedAt: startedIso };
		let explicit: string[] = [];
		let autoConsolidation = true;

		if (stage.kind === "retain") {
			const events = stage.events.map((id) => {
				const event = eventById.get(id);
				if (!event) throw new Error(`unknown event ${id}`);
				return event;
			});
			const operationId = randomUUID();
			const items = events.map(retainItem);
			const body = { items, async: true, operation_id: operationId };
			let response: { data: any };
			try {
				response = await http(bank, "POST", "/memories", body, {
					log: mutation(body),
					attempts: 1,
				});
			} catch (error) {
				if (error instanceof HttpError) throw error;
				// The operation id makes a resend of the same retain idempotent.
				response = await http(bank, "POST", "/memories", body, { log: mutation(body), attempts: 1 });
			}
			const returned: string[] =
				response.data.operation_ids ??
				(typeof response.data.operation_id === "string" ? [response.data.operation_id] : []);
			if (!returned.includes(operationId))
				stageRecord.warnings = [
					...(stageRecord.warnings ?? []),
					`retain answered operation ids ${JSON.stringify(returned)}, not the one sent`,
				];
			explicit = [...new Set([operationId, ...returned])];
			stageRecord.request = { operation_id: operationId, items: items.length };
			for (const event of events) {
				if (event.id === spec.pendingDocument) pendingExists = true;
				eventRecords.set(event.id, {
					id: event.id,
					at: event.at,
					text: event.text,
					metadata: event.metadata,
					document_id: event.id,
					tags: [event.id],
					context: SYNTHETIC_CONTEXT,
					stage: stage.name,
					operation_id: operationId,
					facts: [],
				});
			}
		} else if (stage.kind === "delete-document") {
			const { data } = await http(
				bank,
				"DELETE",
				`/documents/${encodeURIComponent(stage.document)}`,
				undefined,
				{ log: mutation(undefined, { document: stage.document }), okStatuses: [404] },
			);
			stageRecord.request = { document: stage.document };
			stageRecord.response = data;
			if (stage.document === spec.pendingDocument) pendingExists = false;
		} else if (stage.kind === "edit-single" || stage.kind === "remove-single") {
			const { rows } = await listAll(bank);
			const facts = rows.filter((r) => !isObservation(r) && r.document_id === stage.document);
			if (facts.length !== 1)
				stageRecord.warnings = [
					...(stageRecord.warnings ?? []),
					`document ${stage.document} holds ${facts.length} raw facts; the first is patched`,
				];
			if (!facts.length) throw new Error(`no raw fact for document ${stage.document}`);
			const fact = facts[0];
			const patch =
				stage.kind === "edit-single"
					? { text: stage.text }
					: { state: "invalidated", reason: stage.reason };
			const { data } = await http(
				bank,
				"PATCH",
				`/memories/${encodeURIComponent(fact.id)}`,
				patch,
				{ log: mutation(patch, { memory: fact.id }) },
			);
			stageRecord.request = { memory: fact.id, textBefore: fact.text, patch };
			stageRecord.response = data;
		} else if (stage.kind === "rebuild") {
			// The recorded full native rebuild: auto-consolidation off, every raw fact's
			// observations deleted, one explicit consolidation, auto-consolidation back on.
			const { rows } = await listAll(bank);
			const rawIds = rows.filter((r) => !isObservation(r)).map((r) => r.id);
			await patchConfig(bank, { enable_auto_consolidation: false });
			const deleted: Json[] = [];
			for (const id of rawIds) {
				const { data } = await http(bank, "DELETE", `/memories/${encodeURIComponent(id)}/observations`, undefined, {
					log: mutation(undefined, { memory: id }),
				});
				deleted.push({ id, deleted_count: data.deleted_count });
			}
			const { data } = await http(bank, "POST", "/consolidate", {}, { log: mutation({}) });
			stageRecord.request = { rawFacts: rawIds.length, deleted, consolidation: data };
			autoConsolidation = false;
			const deadline = Date.now() + STAGE_WAIT_MS;
			await waitOperation(bank, data.operation_id, `${scope}/${stage.name}`, deadline);
			await patchConfig(bank, { enable_auto_consolidation: true });
			autoConsolidation = true;
		}

		const report = await settle(bank, `${scope}/${stage.name}`, {
			startedIso,
			explicit,
			autoConsolidation,
		});
		const captured = await captureStable(bank);
		const { raw, observations, rawById, eligible, rejected } = classify(
			captured.rows,
			spec.pendingDocument,
			pendingExists,
		);
		const view = eligible.map((row) => viewRow(row, rawById));
		// The recorded publication rule: a row resting on an unaccepted source holds the previous
		// complete snapshot back; otherwise the eligible rows are the published snapshot.
		const visible: Json[] = rejected.length && published ? published : view;
		if (!rejected.length) published = view;

		// An event's facts are what its own retain made, read once, when that stage settled.
		for (const eventRecord of eventRecords.values())
			if (eventRecord.stage === stage.name)
				eventRecord.facts = raw
					.filter((fact) => fact.document_id === eventRecord.document_id)
					.map((fact) => ({
						id: fact.id,
						text: fact.text,
						tags: fact.tags,
						mentioned_at: fact.mentioned_at,
						occurred_start: fact.occurred_start ?? null,
						occurred_end: fact.occurred_end ?? null,
					}));

		const finishedIso = now();
		Object.assign(stageRecord, {
			finishedAt: finishedIso,
			seconds: Math.round((Date.now() - began) / 1000),
			settle: report,
			operations: await operationsSince(bank, startedIso),
			native: { total: captured.total, valid: captured.rows.length },
			raw,
			observations,
			eligibleIds: eligible.map((row) => row.id),
			rejected,
			view,
			visible,
			visibleIsHeldSnapshot: visible !== view,
			terms: termReport(visible, spec.watch),
			earlierHistory: visible
				.map((row) => ({ id: row.id, marker: historyMarkers(row.current) }))
				.filter((row) => row.marker),
		});
		(record.stages as Json[]).push(stageRecord);
		(record.events as Json[]).splice(0, (record.events as Json[]).length, ...eventRecords.values());
		save();
		log(
			scope,
			`stage ${stage.name}: done in ${stageRecord.seconds}s, ${raw.length} raw, ${observations.length} observations, ${rejected.length} rejected; visible: ${visible
				.map((row) => JSON.stringify(row.current))
				.join(" | ")}`,
		);
		if (report.failedOperations.length || report.rawFailedConsolidation.length)
			log(
				scope,
				`WARNING failed operations ${JSON.stringify(report.failedOperations)} / failed consolidation facts ${report.rawFailedConsolidation.length}`,
			);
	}

	// One cheap native text search for the old value, as the recorded run made (no model call).
	if (spec.oldWord) {
		const { data } = await http(
			bank,
			"GET",
			`/memories/list?state=valid&type=observation&q=${encodeURIComponent(spec.oldWord)}&limit=100`,
		);
		record.nativeSearchOldValue = {
			q: spec.oldWord,
			total: data.total,
			rows: (data.items as Row[]).map((row) => ({ id: row.id, text: row.text })),
		};
	}
	const final = await readConfig(bank);
	record.config.final = final;
	record.configUnchangedBySequence = sameValue(
		{ ...(final.config ?? {}), enable_auto_consolidation: undefined },
		{ ...(record.config.readback.config ?? {}), enable_auto_consolidation: undefined },
	);
	save();
}

// ---------------------------------------------------------------------------------------
// The recorded baseline, for the config comparison only (read, never written)
// ---------------------------------------------------------------------------------------

function configAgainstRecorded(): Json | null {
	const recordedPath = path.join(here, "serial-results.json");
	if (!existsSync(recordedPath)) return null;
	try {
		const recorded = JSON.parse(readFileSync(recordedPath, "utf8")).cases?.[0]?.config;
		const today = nativeBankConfig("personal");
		const overrides = recorded.overrides as Json;
		const differing: Json = {};
		for (const key of new Set([...Object.keys(overrides), ...Object.keys(today)])) {
			const was = overrides[key];
			const is = (today as Json)[key];
			if (sameValue(was, is)) continue;
			differing[key] =
				typeof was === "string" && typeof is === "string" && is.startsWith(was)
					? { change: "recorded text kept, sentences appended", appended: is.slice(was.length).trim() }
					: was === undefined
						? { change: "new key today", value: is }
						: { change: "different", recorded: was, today: is };
		}
		return {
			recordedOverrideKeys: Object.keys(overrides),
			todayKeys: Object.keys(today),
			differing,
		};
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------

process.on("SIGINT", () => {
	results.status = "interrupted";
	results.finished = now();
	save();
	process.exit(130);
});

const capabilities = await verifyCapabilities();
results.run.capabilities = capabilities;
results.configAgainstRecorded = configAgainstRecorded();
log("run", `tenant ${TENANT}, engine ${capabilities.engine_commit.slice(0, 8)}, ${PLUMBING ? "plumbing" : QUICK ? "quick" : CASES.join("+")}`);
save();

if (PLUMBING) {
	// No model call: bank creation by PATCH, readback, empty reads, a toggle, one empty consolidation.
	const bank = "clf-1124-plumbing";
	const applied = await configureBank(bank, nativeBankConfig("personal"));
	const empty = await listAll(bank);
	const ops = await listOperations(bank);
	await patchConfig(bank, { enable_auto_consolidation: false });
	const { data } = await http(bank, "POST", "/consolidate", {}, { log: mutation({}) });
	await waitOperation(bank, data.operation_id, "plumbing", Date.now() + 120_000);
	await patchConfig(bank, { enable_auto_consolidation: true });
	const report = await settle(bank, "plumbing", { startedIso: now(), autoConsolidation: true });
	results.plumbing = {
		bank,
		configVerified: applied.verified,
		readbackOverrideKeys: Object.keys(applied.readback.overrides ?? {}),
		emptyList: empty,
		operationsBefore: ops.length,
		consolidation: data,
		settle: report,
		operationsAfter: await operationsSince(bank, results.started),
	};
	await http(bank, "DELETE", "", undefined, { okStatuses: [404] });
	results.status = "plumbing-ok";
	results.finished = now();
	save();
	log("run", "plumbing ok");
	process.exit(0);
}

const specs: CaseSpec[] = QUICK
	? [QUICK_CASE]
	: [EN, HU, HOLDOUT].filter((spec) => CASES.includes(spec.id));
const outcomes = await Promise.allSettled(
	specs.map(async (spec) => {
		const record: Json = {
			id: spec.id,
			bank: spec.bank,
			lang: spec.lang,
			config: null,
			events: [],
			stages: [],
			error: null,
		};
		if (spec.id === "holdout") {
			record.items = spec.events.map((event) => ({
				document_id: event.id,
				timestamp: new Date(event.at).toISOString(),
				content: event.text,
				tags: [event.id],
				metadata: event.metadata,
			}));
			results.holdout = record;
		} else (results.cases as Json[]).push(record);
		try {
			await runCase(spec, record);
		} catch (error) {
			record.error = {
				stage: (record.stages as Json[]).length
					? `after ${(record.stages as Json[]).at(-1)?.stage}`
					: "setup",
				message: error instanceof Error ? error.message : String(error),
			};
			log(spec.id, `ERROR ${record.error.message}`);
			save();
			throw error;
		}
	}),
);

if (QUICK) {
	// A throwaway bank: remove it again.
	await http(QUICK_CASE.bank, "DELETE", "", undefined, { okStatuses: [404] });
}
const failed = outcomes.filter((outcome) => outcome.status === "rejected");
results.status = failed.length ? "errors" : "complete";
results.finished = now();
save();
log("run", `${results.status} after ${results.wallSeconds}s`);
process.exit(failed.length ? 1 : 0);
