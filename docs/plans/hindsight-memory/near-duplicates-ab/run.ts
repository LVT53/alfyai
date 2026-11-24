/**
 * Near-duplicate A/B, 2026-11-24 (Memory config 3, task 3). Synthetic data only.
 *
 * Question: do config 2's two observation-mission sentences cause the near-duplicate
 * observation rows Hindsight's consolidator leaves after a document deletion (a "green
 * bicycle" row beside a "green bicycle and white kayak" row over the same facts)?
 *
 *   S1  "When a later statement settles an earlier wish or plan about the same thing, keep only
 *        the settled state."
 *   S2  "When something really changes in the world, such as a move or a new job, state the new
 *        value as current and keep the old value only as earlier history in the same
 *        observation; never write an end date or any date the person did not state."
 *
 * Variants (the last two sentences of `nativeBankConfig("personal").observations_mission`, cut
 * out by string): base (config 2 as shipped), no-s1, no-s2, no-both. Each run makes a fresh bank
 * with one `PATCH /config {updates: <config>}` (the call the app sends), loads the scenario's
 * facts, consolidates, deletes the pending document, consolidates again and reads the bank.
 *
 * The scenario is the current-list Hungarian case (`current-list-followup/regression-2026-11-24.ts`,
 * stage "pending-removed") cut to what the near-duplicate needs. Its facts are the raw facts the
 * recorded runs' extraction produced (`fixes-2026-11-24-tip/current-list-hu-*.json.gz`), stored
 * verbatim (`retain_extraction_mode: "chunks"`, the one key set apart from config 2, after the
 * app's PATCH) so extraction variance is out of the comparison and the only model calls are the
 * consolidator's, in arrival order, one fact per call as in the app (`consolidation_llm_batch_size`
 * 1). Auto-consolidation is off while loading so the consolidations are explicit and in order.
 *
 *   node --import tsx docs/plans/hindsight-memory/near-duplicates-ab/run.ts run <variant> <runs> [--scenario short|sister|full]
 *   node --import tsx docs/plans/hindsight-memory/near-duplicates-ab/run.ts summary [--scenario ...]
 *   node --import tsx docs/plans/hindsight-memory/near-duplicates-ab/run.ts plan      # prints the variants' mission texts
 *
 * Talks to 127.0.0.1 only, never to the shared instances (18990, 18890, 18895) or the bridge.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
	type NativeBankConfig,
	nativeBankConfig,
	PREVIOUS_NATIVE_BANK_CONFIG,
} from "../../../../src/lib/server/services/memory-profile/contracts.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(here, "results");
mkdirSync(RESULTS, { recursive: true });

const args = process.argv.slice(2);
const mode = args[0];
const option = (name: string) => {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
};
const BASE = (process.env.AB_HINDSIGHT_URL ?? "http://127.0.0.1:18992").replace(/\/+$/, "");
{
	const url = new URL(BASE);
	if (url.hostname !== "127.0.0.1") throw new Error("This run talks to 127.0.0.1 only");
	if (["18990", "18890", "18895", "18891"].includes(url.port))
		throw new Error(`port ${url.port} is not this task's instance`);
}

// ---------------------------------------------------------------------------------------
// Variants: config 2's observations_mission with exactly the named sentences cut out
// ---------------------------------------------------------------------------------------

export const S1 =
	"When a later statement settles an earlier wish or plan about the same thing, keep only the settled state.";
export const S2 =
	"When something really changes in the world, such as a move or a new job, state the new value as current and keep the old value only as earlier history in the same observation; never write an end date or any date the person did not state.";
export const VARIANTS = ["base", "no-s1", "no-s2", "no-both"] as const;
export type Variant = (typeof VARIANTS)[number];

function cutSentence(mission: string, sentence: string) {
	const at = mission.indexOf(sentence);
	if (at < 0 || mission.indexOf(sentence, at + 1) >= 0)
		throw new Error("the sentence is not in the mission exactly once");
	return `${mission.slice(0, at).trimEnd()} ${mission.slice(at + sentence.length).trimStart()}`.trim();
}

export function variantConfig(variant: Variant): NativeBankConfig {
	const config = nativeBankConfig("personal");
	let mission = config.observations_mission;
	if (mission !== `${PREVIOUS_NATIVE_BANK_CONFIG.observations_mission} ${S1} ${S2}`)
		throw new Error("config 2's mission is no longer config 1's plus S1 and S2");
	if (variant === "no-s1" || variant === "no-both") mission = cutSentence(mission, S1);
	if (variant === "no-s2" || variant === "no-both") mission = cutSentence(mission, S2);
	if (variant === "no-both" && mission !== PREVIOUS_NATIVE_BANK_CONFIG.observations_mission)
		throw new Error("no-both is not config 1's mission");
	return { ...config, observations_mission: mission };
}

// ---------------------------------------------------------------------------------------
// The scenario: recorded raw facts (Hungarian current-list case), loaded in arrival order
// ---------------------------------------------------------------------------------------

interface FactSpec {
	doc: string;
	at: string;
	text: string;
}
const CONTEXT =
	"Synthetic user message or explicit source edit. Preserve attribution and original assertion time.";
const FACTS: Record<string, FactSpec> = {
	"old-bike": {
		doc: "old-bike",
		at: "2026-11-01T12:00:00Z",
		text: "A felhasználónak van egy piros kerékpárja és egy fehér kajakja. | Involving: user",
	},
	"old-sister": {
		doc: "old-sister",
		at: "2026-11-01T12:00:00Z",
		text: "A felhasználó húga Győrben él. | Where: Győr | Involving: user, húg",
	},
	"old-short": {
		doc: "old-short",
		at: "2026-11-01T12:00:00Z",
		text: "A felhasználó rövid válaszokat kér. | Involving: user",
	},
	newer: {
		doc: "newer",
		at: "2026-11-10T12:00:00Z",
		text: "A felhasználó kerékpárja kék. | Involving: user",
	},
	correction: {
		doc: "correction",
		at: "2026-11-12T12:00:00Z",
		text: "A felhasználó kerékpárja zöld; a korábbi kék leírás téves volt, és a kerékpár színe nem változott meg. | Involving: user",
	},
	"replay-bike": {
		doc: "old-replay-bike",
		at: "2026-11-01T12:00:00Z",
		text: "A felhasználónak van egy piros kerékpárja és egy fehér kajakja. | Involving: user",
	},
	"replay-sister": {
		doc: "old-replay-sister",
		at: "2026-11-01T12:00:00Z",
		text: "A felhasználó húga Győrben él. | Where: Győr | Involving: user húga",
	},
	pending: {
		doc: "pending",
		at: "2026-11-20T12:00:00Z",
		text: "A felhasználó kerékpárja narancssárga. | Involving: user",
	},
};
/** The recorded events as the app sends them (the real path: the model extracts the facts, consolidation follows each retain). */
const REAL_EVENTS = [
	{
		doc: "old",
		at: "2026-11-01T12:00:00Z",
		text: "User: Van egy piros kerékpárom és egy fehér kajakom. Rövid válaszokat kérek. A húgom Győrben él.",
	},
	{ doc: "newer", at: "2026-11-10T12:00:00Z", text: "User: A kerékpárom kék. Most részletes válaszokat kérek." },
	{
		doc: "correction",
		at: "2026-11-12T12:00:00Z",
		text: "User: Javítás: a kerékpárom zöld. A korábbi kék leírás téves volt; nem változott meg a színe.",
	},
	{
		doc: "old-replay",
		at: "2026-11-01T12:00:00Z",
		text: "User: Van egy piros kerékpárom és egy fehér kajakom. Rövid válaszokat kérek. A húgom Győrben él.",
	},
	{ doc: "pending", at: "2026-11-20T12:00:00Z", text: "User: A kerékpárom narancssárga." },
];
const SCENARIOS: Record<string, { load: string[]; deleteDocument: string; real?: boolean }> = {
	// The whole path to the deletion as the recorded run takes it: concise extraction by the model, auto-consolidation.
	real: { load: [], deleteDocument: "pending", real: true },
	// The bicycle and kayak facts only: five facts, then the deletion (five consolidator calls, then four).
	short: {
		load: ["old-bike", "newer", "correction", "replay-bike", "pending"],
		deleteDocument: "pending",
	},
	// Plus the sister's two facts, as in the recorded case (the other observation in the pool).
	sister: {
		load: ["old-bike", "old-sister", "newer", "correction", "replay-bike", "replay-sister", "pending"],
		deleteDocument: "pending",
	},
	// Only what the first re-consolidation after the deletion needs: the compound fact and its replay (so the kayak
	// row has two sources), the sister's and the short-answers facts (the pool of three rows) and the pending fact
	// (the bicycle row's last source). Five facts, then the deletion requeues the compound fact and its replay: seven
	// consolidator calls, the second-to-last of which is the call the recorded near-duplicates start from.
	mini: {
		load: ["old-bike", "old-sister", "old-short", "replay-bike", "pending"],
		deleteDocument: "pending",
	},
	// All the recorded case's facts before the deletion.
	full: {
		load: [
			"old-bike",
			"old-sister",
			"old-short",
			"newer",
			"correction",
			"replay-bike",
			"replay-sister",
			"pending",
		],
		deleteDocument: "pending",
	},
};
const scenarioName = option("--scenario") ?? "short";

// ---------------------------------------------------------------------------------------
// Hindsight HTTP (thin: `call` as part 2's run.ts)
// ---------------------------------------------------------------------------------------

type Json = Record<string, any>;
class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}
async function call(
	bank: string | null,
	method: string,
	suffix: string,
	body?: unknown,
	attempts = method === "GET" ? 4 : 1,
): Promise<any> {
	const url =
		bank === null ? `${BASE}${suffix}` : `${BASE}/v1/default/banks/${encodeURIComponent(bank)}${suffix}`;
	let last: unknown;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const response = await fetch(url, {
				method,
				headers: { "Content-Type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(300_000),
			});
			const text = await response.text();
			if (!response.ok)
				throw new HttpError(response.status, `${method} ${suffix} -> ${response.status} ${text.slice(0, 200)}`);
			return text ? JSON.parse(text) : null;
		} catch (error) {
			last = error;
			if (error instanceof HttpError && error.status < 500) throw error;
			if (attempt < attempts) await sleep(1_000 * attempt);
		}
	}
	throw last;
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, sortKeys((value as Json)[key])]),
		);
	return value;
}
const sameValue = (a: unknown, b: unknown) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));

/** `configure()`: one PATCH /config {updates} (it creates the bank), then a by-value readback. */
async function configure(bank: string, config: NativeBankConfig) {
	await call(bank, "PATCH", "/config", { updates: config });
	const live = ((await call(bank, "GET", "/config")).config ?? {}) as Json;
	for (const [key, value] of Object.entries(config))
		if (!sameValue(live[key], value)) throw new Error(`config ${key} did not land on ${bank}`);
}

async function waitOperation(bank: string, id: string, deadline: number) {
	let missing = 0;
	for (;;) {
		if (Date.now() > deadline) throw new Error(`timeout waiting for operation ${id}`);
		let status: string;
		try {
			status = (await call(bank, "GET", `/operations/${encodeURIComponent(id)}`)).status;
		} catch (error) {
			if (error instanceof HttpError && error.status === 404 && ++missing <= 5) {
				await sleep(1_000);
				continue;
			}
			throw error;
		}
		if (status === "completed") return;
		if (status === "failed" || status === "cancelled") throw new Error(`operation ${id} ${status}`);
		await sleep(1_000);
	}
}

async function listAll(bank: string): Promise<Json[]> {
	const rows: Json[] = [];
	for (let offset = 0; offset < 1000; offset += 100) {
		const page = await call(bank, "GET", `/memories/list?state=valid&limit=100&offset=${offset}`);
		rows.push(...(page.items as Json[]));
		if (rows.length >= page.total || page.items.length === 0) break;
	}
	return rows;
}
const isObservation = (row: Json) => row.fact_type === "observation";

/** Nothing running in the bank and every valid raw fact consolidated, on two polls in a row. */
async function settle(bank: string, deadline: number) {
	let quiet = 0;
	for (;;) {
		if (Date.now() > deadline) throw new Error("timeout: the bank did not settle");
		const ops = (await call(bank, "GET", "/operations?limit=100&offset=0")).operations as Json[];
		const active = ops.filter((op) => op.status === "pending" || op.status === "processing");
		const rows = await listAll(bank);
		const pending = rows.filter((r) => !isObservation(r) && !r.consolidated_at && !r.consolidation_failed_at);
		quiet = active.length === 0 && pending.length === 0 ? quiet + 1 : 0;
		if (quiet >= 2) {
			const failed = rows.filter((r) => !isObservation(r) && r.consolidation_failed_at).map((r) => r.id);
			const failedOps = ops.filter((op) => op.status === "failed").map((op) => op.error_message);
			if (failed.length || failedOps.length)
				throw new Error(
					`consolidation failed: ${failed.length} facts, ops ${JSON.stringify(failedOps).slice(0, 300)}`,
				);
			return rows;
		}
		await sleep(1_500);
	}
}

async function consolidate(bank: string, deadline: number) {
	const answer = await call(bank, "POST", "/consolidate", {});
	const id = answer?.operation_id;
	if (typeof id === "string" && id) await waitOperation(bank, id, deadline);
	return settle(bank, deadline);
}

// ---------------------------------------------------------------------------------------
// Reading the bank: the mechanical near-duplicate definition and the side checks
// ---------------------------------------------------------------------------------------

/** The engine's own bracketed earlier-state note: `(2026-11-01 12:00: ...)`. */
const NOTE_ALL = /\(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:[^)]*\)/g;
const NOTE_ANY = /\(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:[^)]*\)/;
const STOP = new Set([
	"egy",
	"és",
	"van",
	"volt",
	"hogy",
	"nem",
	"the",
	"and",
	"are",
	"was",
	"has",
	"have",
	"felhasználó",
	"felhasználónak",
	"felhasználónál",
	"user",
	"users",
]);
/** The text without the engine's bracketed earlier-state notes. */
export const statementOf = (text: string) => text.replace(NOTE_ALL, " ").replace(/\s+/g, " ").trim();
/** Content stems: lower-cased words, 5-letter prefixes (Hungarian is agglutinative), the user and filler left out. */
export function stemsOf(text: string): Set<string> {
	const words = statementOf(text)
		.toLowerCase()
		.normalize("NFC")
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.split(/\s+/)
		.filter((word) => word.length >= 3 && !STOP.has(word));
	return new Set(words.map((word) => word.slice(0, 5)));
}
const subset = (a: Set<string>, b: Set<string>) => a.size >= 2 && [...a].every((stem) => b.has(stem));

export interface Observation {
	id: string;
	text: string;
	source_memory_ids: string[];
}
export interface Pair {
	a: string;
	b: string;
	kind: "twin" | "near";
	sharedSources: number;
	sameSources: boolean;
}
/**
 * Two valid observations are a near-duplicate when their supporting facts overlap and one's
 * statement (its words without the bracketed earlier-state notes) is contained in the other's;
 * a twin when each contains the other.
 */
export function duplicatePairs(observations: Observation[]): Pair[] {
	const pairs: Pair[] = [];
	for (let i = 0; i < observations.length; i++)
		for (let j = i + 1; j < observations.length; j++) {
			const x = observations[i];
			const y = observations[j];
			const shared = x.source_memory_ids.filter((id) => y.source_memory_ids.includes(id));
			if (!shared.length) continue;
			const sx = stemsOf(x.text);
			const sy = stemsOf(y.text);
			const xy = subset(sx, sy);
			const yx = subset(sy, sx);
			if (!xy && !yx) continue;
			pairs.push({
				a: x.id,
				b: y.id,
				kind: xy && yx ? "twin" : "near",
				sharedSources: shared.length,
				sameSources:
					x.source_memory_ids.length === y.source_memory_ids.length &&
					x.source_memory_ids.length === shared.length,
			});
		}
	return pairs;
}

/** Side checks on the final rows (the obvious regressions): flags only, read the rows for the verdict. */
export function sideChecks(observations: Observation[]) {
	const statements = observations.map((o) => statementOf(o.text).toLowerCase());
	const all = observations.map((o) => o.text.toLowerCase());
	const has = (list: string[], ...needles: string[]) => list.some((s) => needles.every((n) => s.includes(n)));
	const bicycleStatements = statements.filter((s) => s.includes("kerékp"));
	return {
		/** the green bicycle is current somewhere */
		greenCurrent: has(statements, "kerékp", "zöld"),
		/** the white kayak is still in a row */
		kayakKept: has(all, "kajak", "fehér"),
		/** the deleted document's value is in no row at all */
		orangeLeak: all.some((s) => s.includes("narancs")),
		/** a bicycle statement (engine notes left out) that names a replaced colour with no word of history */
		oldColourCurrent: bicycleStatements.some(
			(s) => /piros|kék/.test(s) && !/korábban|régebben|volt|eredetileg|előzőleg/.test(s),
		),
		/** earlier history kept in some form: the engine's dated note or prose */
		historyKept: all.some((s) => NOTE_ANY.test(s) || /korábban|régebben|eredetileg|előzőleg/.test(s)),
		/** a year the person did not state, written by the model (outside the engine's own notes) */
		inventedDate: statements.some((s) => /\b(19|20)\d{2}\b/.test(s)),
		/** the sister's row kept (only meaningful when the scenario holds her facts) */
		sisterKept: has(all, "húga", "győr"),
		/** one row states the bicycle and the kayak together (statement only, engine notes left out): the facets joined */
		compoundRow: has(statements, "kerékp", "kajak"),
		rows: observations.length,
	};
}

export function analyse(observations: Observation[]) {
	const pairs = duplicatePairs(observations);
	return {
		twin: pairs.some((p) => p.kind === "twin"),
		near: pairs.some((p) => p.kind === "near"),
		duplicate: pairs.length > 0,
		pairs,
		checks: sideChecks(observations),
	};
}

/** The end state in one word: the shapes the recorded runs show (clean, a compound row, twins, a near-duplicate). */
export function shapeOf(observations: Observation[]) {
	const a = analyse(observations);
	if (a.twin && a.near) return "twin+near";
	if (a.twin) return "twin";
	if (a.near) return "near";
	if (a.checks.compoundRow) return "compound-only";
	return "clean";
}

// ---------------------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------------------

const log = (scope: string, message: string) =>
	console.log(`${new Date().toISOString().slice(11, 19)} [${scope}] ${message}`);

function snapshot(rows: Json[]) {
	return {
		raw: rows
			.filter((r) => !isObservation(r))
			.map((r) => ({ id: r.id, document_id: r.document_id, text: r.text, mentioned_at: r.mentioned_at })),
		observations: rows.filter(isObservation).map((r) => ({
			id: r.id as string,
			text: r.text as string,
			source_memory_ids: (r.source_memory_ids ?? []) as string[],
		})),
	};
}

/** Each surviving observation's own change log (what the engine keeps of its earlier texts), to see which step wrote a row. */
async function observationHistories(bank: string, observations: Observation[]) {
	const out: Record<string, unknown> = {};
	for (const o of observations) {
		try {
			out[o.id] = await call(bank, "GET", `/memories/${encodeURIComponent(o.id)}/history`, undefined, 1);
		} catch (error) {
			out[o.id] = { error: error instanceof Error ? error.message : String(error) };
		}
	}
	return out;
}

async function oneRun(variant: Variant, index: number, scenario: string) {
	const spec = SCENARIOS[scenario];
	if (!spec) throw new Error(`unknown scenario ${scenario}`);
	const bank = `ab-${scenario}-${variant}-${index}-${randomUUID().slice(0, 8)}`;
	const scope = `${scenario}/${variant}#${index}`;
	const began = Date.now();
	const deadline = began + 25 * 60_000;
	const record: Json = {
		suite: "near-duplicates A/B, 2026-11-24",
		scenario,
		variant,
		index,
		bank,
		startedAt: new Date().toISOString(),
		status: "running",
		error: null,
	};
	try {
		await configure(bank, variantConfig(variant));
		if (spec.real) {
			// The recorded stages, extraction by the model and the engine's own consolidation after each retain.
			for (const event of REAL_EVENTS) {
				const operationId = randomUUID();
				await call(bank, "POST", "/memories", {
					items: [
						{
							content: event.text,
							context: CONTEXT,
							timestamp: new Date(event.at).toISOString(),
							document_id: event.doc,
							tags: [event.doc],
							metadata: { chat_id: `chat-${event.doc}`, message_id: `message-${event.doc}` },
						},
					],
					async: true,
					operation_id: operationId,
				});
				await waitOperation(bank, operationId, deadline);
				await settle(bank, deadline);
			}
			record.loadedFacts = REAL_EVENTS.length;
			const beforeReal = snapshot(await listAll(bank));
			record.beforeDeletion = beforeReal;
			log(scope, `retained and consolidated: ${beforeReal.observations.length} rows; deleting ${spec.deleteDocument}`);
			await call(bank, "DELETE", `/documents/${encodeURIComponent(spec.deleteDocument)}`);
			await settle(bank, deadline);
			const afterReal = snapshot(await listAll(bank));
			record.afterDeletion = afterReal;
			record.histories = await observationHistories(bank, afterReal.observations);
			record.analysis = analyse(afterReal.observations);
			record.analysisBefore = analyse(beforeReal.observations);
			record.status = "ok";
			const ar = record.analysis;
			log(
				scope,
				`${ar.twin ? "TWIN " : ""}${ar.near ? "NEAR " : ""}${ar.duplicate ? "" : "clean "}| ${afterReal.observations.length} rows | ${afterReal.observations
					.map((o) => JSON.stringify(o.text))
					.join(" ; ")}`,
			);
			return record;
		}
		// After the app's PATCH: the facts are stored as given, and the consolidations are explicit.
		await call(bank, "PATCH", "/config", {
			updates: { retain_extraction_mode: "chunks", enable_auto_consolidation: false },
		});
		for (const key of spec.load) {
			const fact = FACTS[key];
			const operationId = randomUUID();
			await call(bank, "POST", "/memories", {
				items: [
					{
						content: fact.text,
						context: CONTEXT,
						timestamp: new Date(fact.at).toISOString(),
						document_id: fact.doc,
						tags: [fact.doc],
						metadata: {},
						// What the bank's `default_observation_scopes: "shared"` stamps in the
						// app's own (concise) extraction path, which chunks mode skips: one
						// observation pool whatever the facts' tags, so the facts are
						// consolidated one after the other and see each other's rows.
						observation_scopes: "shared",
					},
				],
				async: true,
				operation_id: operationId,
			});
			await waitOperation(bank, operationId, deadline);
		}
		record.loadedFacts = spec.load.length;
		await consolidate(bank, deadline);
		const before = snapshot(await listAll(bank));
		record.beforeDeletion = before;
		log(scope, `loaded and consolidated: ${before.observations.length} rows; deleting ${spec.deleteDocument}`);
		await call(bank, "DELETE", `/documents/${encodeURIComponent(spec.deleteDocument)}`);
		await consolidate(bank, deadline);
		const after = snapshot(await listAll(bank));
		record.afterDeletion = after;
		record.histories = await observationHistories(bank, after.observations);
		record.analysis = analyse(after.observations);
		record.analysisBefore = analyse(before.observations);
		record.status = "ok";
		const a = record.analysis;
		log(
			scope,
			`${a.twin ? "TWIN " : ""}${a.near ? "NEAR " : ""}${a.duplicate ? "" : "clean "}| ${after.observations.length} rows | ${after.observations
				.map((o) => JSON.stringify(o.text))
				.join(" ; ")}`,
		);
	} catch (error) {
		record.status = "failed";
		record.error = error instanceof Error ? error.message : String(error);
		log(scope, `FAILED ${record.error}`);
	} finally {
		record.seconds = Math.round((Date.now() - began) / 1000);
		record.finishedAt = new Date().toISOString();
		try {
			await call(bank, "DELETE", "", undefined, 1);
		} catch {
			/* a bank that never got made, or already gone */
		}
	}
	return record;
}

/** Claims the next free result file for a variant (exclusive create), so two processes never share an index. */
function claimIndex(scenario: string, variant: string) {
	for (let n = 1; n < 1000; n++) {
		const file = path.join(RESULTS, `${scenario}-${variant}-${String(n).padStart(2, "0")}.json`);
		try {
			writeFileSync(file, "{}\n", { flag: "wx" });
			return { n, file };
		} catch {
			/* taken */
		}
	}
	throw new Error("no free result index");
}

// ---------------------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------------------

function summary(scenario: string) {
	const table: Json = {};
	for (const variant of VARIANTS) {
		const files = readdirSync(RESULTS).filter((f) => f.startsWith(`${scenario}-${variant}-`) && f.endsWith(".json"));
		const since = option("--since");
		const rows = files
			.map((f) => JSON.parse(readFileSync(path.join(RESULTS, f), "utf8")) as Json)
			.filter((r) => r.status === "ok" || r.status === "failed")
			// --since <ISO time>: only the runs that started then or later (the variants' interleaved window).
			.filter((r) => !since || String(r.startedAt) >= since);
		const ok = rows.filter((r) => r.status === "ok");
		// Re-analysed here, so the definition above is the one the counts use.
		const analysed = ok.map((r) => analyse((r.afterDeletion.observations ?? []) as Observation[]));
		const count = (pick: (a: ReturnType<typeof analyse>) => boolean) => analysed.filter(pick).length;
		table[variant] = {
			runs: rows.length,
			failed: rows.length - ok.length,
			clean: count((a) => !a.duplicate),
			duplicate: count((a) => a.duplicate),
			twinOnly: count((a) => a.twin && !a.near),
			nearOnly: count((a) => a.near && !a.twin),
			twinAndNear: count((a) => a.twin && a.near),
			shapes: analysed.reduce(
				(acc, _a, i) => {
					const shape = shapeOf((ok[i].afterDeletion.observations ?? []) as Observation[]);
					acc[shape] = (acc[shape] ?? 0) + 1;
					return acc;
				},
				{} as Record<string, number>,
			),
			compoundRow: count((a) => a.checks.compoundRow),
			// The colour checks need the recorded colour changes: not meaningful in the mini scenario.
			greenCurrentMissing: scenario === "mini" ? null : count((a) => !a.checks.greenCurrent),
			kayakLost: count((a) => !a.checks.kayakKept),
			orangeLeak: count((a) => a.checks.orangeLeak),
			oldColourCurrent: scenario === "mini" ? null : count((a) => a.checks.oldColourCurrent),
			historyKept: scenario === "mini" ? null : count((a) => a.checks.historyKept),
			inventedDate: count((a) => a.checks.inventedDate),
			rowsMean: ok.length
				? +(ok.reduce((n, r) => n + r.afterDeletion.observations.length, 0) / ok.length).toFixed(2)
				: null,
			secondsMean: ok.length ? Math.round(ok.reduce((n, r) => n + r.seconds, 0) / ok.length) : null,
		};
	}
	// Two-sided Fisher exact tests of each variant against the baseline, on "has a duplicate pair".
	const fisher = (a: number, b: number, c: number, d: number) => {
		const choose = (n: number, k: number) => {
			let r = 1;
			for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
			return r;
		};
		const n1 = a + b;
		const n2 = c + d;
		const k = a + c;
		const total = n1 + n2;
		const pmf = (x: number) => (choose(n1, x) * choose(n2, k - x)) / choose(total, k);
		const observed = pmf(a);
		let p = 0;
		for (let x = Math.max(0, k - n2); x <= Math.min(n1, k); x++) if (pmf(x) <= observed * (1 + 1e-9)) p += pmf(x);
		return +Math.min(1, p).toFixed(3);
	};
	const base = table.base;
	const fisherVsBase: Json = {};
	if (base && base.duplicate + base.clean > 0)
		for (const variant of VARIANTS.filter((v) => v !== "base")) {
			const t = table[variant];
			if (t.duplicate + t.clean === 0) continue;
			fisherVsBase[variant] = {
				anyDuplicate: fisher(base.duplicate, base.clean, t.duplicate, t.clean),
				nearOrTwinAndNear: fisher(
					base.nearOnly + base.twinAndNear,
					base.runs - base.failed - base.nearOnly - base.twinAndNear,
					t.nearOnly + t.twinAndNear,
					t.runs - t.failed - t.nearOnly - t.twinAndNear,
				),
			};
		}
	// The 2x2 design pooled: the effect of S1 (present: base + no-s2, absent: no-s1 + no-both) and of S2
	// (present: base + no-s1, absent: no-s2 + no-both), on the same outcomes.
	const sum = (names: Variant[], pick: (t: Json) => number) => names.reduce((n, v) => n + (table[v] ? pick(table[v]) : 0), 0);
	const outcomes: Record<string, (t: Json) => number> = {
		anyDuplicate: (t) => t.duplicate,
		nearOrTwinAndNear: (t) => t.nearOnly + t.twinAndNear,
		compoundRow: (t) => t.compoundRow,
		notClean: (t) => t.runs - t.failed - (t.shapes?.clean ?? 0),
	};
	const pooled: Json = {};
	const groups: Record<string, [Variant[], Variant[]]> = {
		"S1 present vs absent": [["base", "no-s2"], ["no-s1", "no-both"]],
		"S2 present vs absent": [["base", "no-s1"], ["no-s2", "no-both"]],
	};
	for (const [label, [present, absent]] of Object.entries(groups)) {
		const nPresent = sum(present, (t) => t.runs - t.failed);
		const nAbsent = sum(absent, (t) => t.runs - t.failed);
		pooled[label] = { runsPresent: nPresent, runsAbsent: nAbsent } as Json;
		for (const [name, pick] of Object.entries(outcomes)) {
			const a = sum(present, pick);
			const b = sum(absent, pick);
			pooled[label][name] = { present: a, absent: b, fisherP: nPresent && nAbsent ? fisher(a, nPresent - a, b, nAbsent - b) : null };
		}
	}
	console.log(JSON.stringify({ scenario, table, fisherVsBase, pooled }, null, "\t"));
}

/** Prints each run's final rows with the documents behind each row, to read them. */
function show(scenario: string, only?: string) {
	for (const variant of VARIANTS.filter((v) => !only || v === only)) {
		const files = readdirSync(RESULTS)
			.filter((f) => f.startsWith(`${scenario}-${variant}-`) && f.endsWith(".json"))
			.sort();
		for (const file of files) {
			const r = JSON.parse(readFileSync(path.join(RESULTS, file), "utf8")) as Json;
			if (r.status !== "ok") {
				if (r.status === "failed") console.log(`\n## ${file}: FAILED ${r.error}`);
				continue;
			}
			const a = analyse(r.afterDeletion.observations as Observation[]);
			const docs = new Map<string, string>(r.afterDeletion.raw.map((x: Json) => [x.id, String(x.document_id)]));
			console.log(
				`\n## ${file} (${r.seconds}s) ${a.twin ? "TWIN " : ""}${a.near ? "NEAR " : ""}${a.duplicate ? "" : "clean"}${a.checks.compoundRow ? " COMPOUND" : ""}`,
			);
			for (const o of r.afterDeletion.observations as Observation[])
				console.log(`  - ${o.text}   [${o.source_memory_ids.map((s) => docs.get(s) ?? "?").join(", ")}]`);
		}
	}
}

// ---------------------------------------------------------------------------------------
// Main (only when run directly, so the analysis can be imported)
// ---------------------------------------------------------------------------------------

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (mode === "plan") {
		for (const variant of VARIANTS) console.log(`--- ${variant}\n${variantConfig(variant).observations_mission}\n`);
	} else if (mode === "summary") {
		summary(scenarioName);
	} else if (mode === "show") {
		show(scenarioName, args[1] && !args[1].startsWith("--") ? args[1] : undefined);
	} else if (mode === "run") {
		const variant = args[1] as Variant;
		const runs = Number(args[2] ?? "1");
		if (!VARIANTS.includes(variant)) throw new Error(`variant must be one of ${VARIANTS.join(", ")}`);
		const health = await call(null, "GET", "/health");
		log("run", `instance ${BASE} ${JSON.stringify(health).slice(0, 60)}, scenario ${scenarioName}, ${variant} x ${runs}`);
		for (let n = 0; n < runs; n++) {
			const { n: index, file } = claimIndex(scenarioName, variant);
			const record = await oneRun(variant, index, scenarioName);
			writeFileSync(file, `${JSON.stringify(record, null, "\t")}\n`);
		}
	} else {
		console.log("usage: run.ts run <variant> <runs> | summary | plan   [--scenario short|sister|full]");
	}
}
