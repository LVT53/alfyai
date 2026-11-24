/**
 * Memory bank config 3 acceptance on the local model (Flash-Next), synthetic
 * data only: part 2's acceptance (`../run.ts`, its fixtures, its method) run
 * again with config 3's wording, plus the three new targets (purchases and
 * acquisitions labelled lasting, a plain answer-preference request kept, no new
 * false keeps) and the relabel's own check (the classifier's new words on the
 * facts config 2 labelled temporary).
 *
 * Talks to a NON-production Hindsight at the pin (default
 * http://127.0.0.1:18990, started by `start.py` beside this file), whose model
 * is Flash-Next through the shared bridge
 * (`../../regression-2026-11-24/bridge.cjs`, 127.0.0.1:18891), which holds the
 * API key and keeps every process of the run together at three calls in flight
 * at most. The classifier phase calls the same bridge. No key is read here.
 * Never point it at production.
 *
 *   node --import tsx docs/plans/hindsight-memory/part-2-acceptance/config-3/run.ts setup
 *   node --import tsx .../run.ts extraction
 *   node --import tsx .../run.ts classifier
 *   node --import tsx .../run.ts consolidation
 *   node --import tsx .../run.ts report
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type NativeBankConfig,
	nativeBankConfig,
	nativeBankConfig2,
} from "../../../../../src/lib/server/services/memory-profile/contracts";
import { classifyMemoryFacts } from "../../../../../src/lib/server/services/memory-profile/fact-classifier";
import { labelsFromNativeTags } from "../../../../../src/lib/server/services/memory-profile/fact-labels";

const HERE = dirname(fileURLToPath(import.meta.url));
const PART2 = join(HERE, "..");
const RESULTS = join(HERE, "results");
const BASE = process.env.PART2_HINDSIGHT ?? "http://127.0.0.1:18990";
const BRIDGE = process.env.CONFIG3_BRIDGE ?? "http://127.0.0.1:18891/v1";
const IN_FLIGHT = Number(process.env.CONFIG3_IN_FLIGHT ?? 3);
/**
 * A repeat of the extraction on the new sets: `CONFIG3_RAW=extraction-raw-run2.json
 * CONFIG3_ONLY=purchase,preference,preferenceReply,task,question CONFIG3_CONFIGS=v3` writes the
 * calls of those sets to their own file, and `report` reads the same variables.
 */
const RAW_FILE = process.env.CONFIG3_RAW ?? "extraction-raw.json";
const ONLY_SETS = process.env.CONFIG3_ONLY?.split(",");
const ONLY_CONFIGS = process.env.CONFIG3_CONFIGS?.split(",");
const SUMMARY_FILE = process.env.CONFIG3_SUMMARY ?? "summary.json";
const GUIDANCE =
	"Only the source user message is a new assertion. Other messages are context for attribution; prior-memory entries are sanitized remembered facts, not original quotations or new assertions. Assistant claims are not user facts.";

type Lang = "en" | "hu";
type Config = "v2" | "v3";
interface Turn {
	user: string;
	assistant?: string;
}
interface LabelledItem {
	id: string;
	lang: Lang;
	user: string;
	markers: string[];
	kind: string;
	subject: string;
}
interface Fixtures {
	question: Array<{ id: string; lang: Lang; turns: Turn[] }>;
	brainstorm: Array<{
		id: string;
		lang: Lang;
		turns: Turn[];
		outcome: string;
		outcomeMarkers: string[];
		stepMarkers: string[];
	}>;
	lasting: LabelledItem[];
	ongoing: LabelledItem[];
	temporary: Array<LabelledItem & { eventInDays: number | null }>;
	project: Array<LabelledItem & { project: string }>;
	change: Array<{
		id: string;
		lang: Lang;
		before: string;
		after: string;
		oldMarkers: string[];
		newMarkers: string[];
	}>;
	correction: Array<{
		id: string;
		lang: Lang;
		before: string;
		after: string;
		wrongMarkers: string[];
		rightMarkers: string[];
	}>;
	purchase: LabelledItem[];
	preference: LabelledItem[];
	/** The same preferences, each said right after a long answer of the assistant's (the app always sends the previous reply as context). */
	preferenceReply: Array<LabelledItem & { assistant: string }>;
	task: Array<{ id: string; lang: Lang; turns: Turn[] }>;
}
interface DraftFact {
	text: string;
	entities: string[];
	occurred_start: string | null;
	occurred_end: string | null;
}

const fixtures: Fixtures = {
	...JSON.parse(readFileSync(join(PART2, "fixtures.json"), "utf8")),
	...JSON.parse(readFileSync(join(HERE, "fixtures.json"), "utf8")),
};
mkdirSync(RESULTS, { recursive: true });
const save = (name: string, value: unknown) =>
	writeFileSync(join(RESULTS, name), `${JSON.stringify(value, null, "\t")}\n`);
const load = <T>(name: string): T =>
	JSON.parse(readFileSync(join(RESULTS, name), "utf8"));

async function pool<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) {
				const index = next++;
				out[index] = await fn(items[index], index);
			}
		}),
	);
	return out;
}

async function call(
	path: string,
	method = "GET",
	body?: unknown,
	attempts = 3,
): Promise<Record<string, unknown>> {
	for (let attempt = 1; ; attempt++) {
		try {
			const response = await fetch(`${BASE}/v1/default/banks/${path}`, {
				method,
				headers: { "Content-Type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(1_800_000),
			});
			if (!response.ok)
				throw new Error(
					`${method} ${path.split("/").slice(1).join("/")}: ${response.status}`,
				);
			return (await response.json()) as Record<string, unknown>;
		} catch (error) {
			if (attempt >= attempts) throw error;
			await new Promise((r) => setTimeout(r, 5_000 * attempt));
		}
	}
}

const BANKS = {
	v2: { personal: "c3-config-2-personal", project: "c3-config-2-project" },
	v3: { personal: "c3-config-3-personal", project: "c3-config-3-project" },
} as const;
const configOf = (config: Config, kind: "personal" | "project") =>
	config === "v2" ? nativeBankConfig2(kind) : nativeBankConfig(kind);

async function configure(bank: string, config: NativeBankConfig) {
	await call(`${bank}/config`, "PATCH", { updates: config });
	const live = (await call(`${bank}/config`)).config as Record<string, unknown>;
	for (const key of Object.keys(config))
		if (
			JSON.stringify(sortKeys(live[key])) !==
			JSON.stringify(
				sortKeys((config as unknown as Record<string, unknown>)[key]),
			)
		)
			throw new Error(`config ${key} did not land on ${bank}`);
}
function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
		);
	return value;
}

function context(previousAssistant?: string, at?: string) {
	return JSON.stringify({
		guidance: GUIDANCE,
		messages: previousAssistant
			? [{ id: "a-prev", role: "assistant", text: previousAssistant, date: at }]
			: [],
	});
}

async function dryRun(
	bank: string,
	content: string,
	previousAssistant: string | undefined,
	timestamp: string,
): Promise<DraftFact[]> {
	const result = await call(`${bank}/memories/dry-run-extract`, "POST", {
		content,
		context: context(previousAssistant, timestamp),
		timestamp,
	});
	return ((result.facts as Array<Record<string, unknown>>) ?? []).map(
		(fact) => ({
			text: String(fact.text ?? ""),
			entities: (fact.entities as string[]) ?? [],
			occurred_start: (fact.occurred_start as string | null) ?? null,
			occurred_end: (fact.occurred_end as string | null) ?? null,
		}),
	);
}

const lower = (text: string) => text.toLowerCase();
const mentions = (text: string, markers: string[]) =>
	markers.some((marker) => lower(text).includes(lower(marker)));

async function setup() {
	for (const config of ["v2", "v3"] as const)
		for (const kind of ["personal", "project"] as const)
			await configure(BANKS[config][kind], configOf(config, kind));
	console.log(
		"configured",
		Object.values(BANKS)
			.flatMap((banks) => Object.values(banks))
			.join(", "),
	);
}

/** One extraction job: a turn of a chat, through one bank's config. */
interface ExtractionJob {
	set: keyof Fixtures;
	id: string;
	lang: Lang;
	config: Config;
	turn: number;
	bank: string;
	content: string;
	previousAssistant?: string;
	timestamp: string;
}

async function extraction() {
	const at = (turn: number) =>
		new Date(Date.UTC(2026, 10, 20, 10, turn * 3)).toISOString();
	const jobs: ExtractionJob[] = [];
	// Config 3 runs every set. Config 2 runs only the sets this round is about,
	// as the same-session baseline of the new targets and of the false keeps;
	// config 2's other numbers are part 2's recorded ones.
	const add = (
		job: Omit<ExtractionJob, "config" | "bank">,
		configs: Config[],
		project = false,
	) => {
		for (const config of configs)
			jobs.push({
				...job,
				config,
				bank: BANKS[config][project ? "project" : "personal"],
			});
	};
	const both: Config[] = ["v3", "v2"];
	const only3: Config[] = ["v3"];
	for (const chat of fixtures.question)
		add(
			{ set: "question", id: chat.id, lang: chat.lang, turn: 0, content: chat.turns[0].user, timestamp: at(0) },
			both,
		);
	for (const chat of fixtures.task)
		add(
			{ set: "task", id: chat.id, lang: chat.lang, turn: 0, content: chat.turns[0].user, timestamp: at(0) },
			both,
		);
	for (const item of fixtures.purchase)
		add({ set: "purchase", id: item.id, lang: item.lang, turn: 0, content: item.user, timestamp: at(0) }, both);
	for (const item of fixtures.preference)
		add({ set: "preference", id: item.id, lang: item.lang, turn: 0, content: item.user, timestamp: at(0) }, both);
	for (const item of fixtures.preferenceReply)
		add(
			{ set: "preferenceReply", id: item.id, lang: item.lang, turn: 0, content: item.user, previousAssistant: item.assistant, timestamp: at(0) },
			both,
		);
	for (const chat of fixtures.brainstorm)
		chat.turns.forEach((turn, i) =>
			add(
				{
					set: "brainstorm",
					id: chat.id,
					lang: chat.lang,
					turn: i,
					content: turn.user,
					previousAssistant: i ? chat.turns[i - 1].assistant : undefined,
					timestamp: at(i),
				},
				only3,
			),
		);
	for (const set of ["lasting", "ongoing", "temporary"] as const)
		for (const item of fixtures[set])
			add({ set, id: item.id, lang: item.lang, turn: 0, content: item.user, timestamp: at(0) }, only3);
	for (const item of fixtures.project)
		add(
			{ set: "project", id: item.id, lang: item.lang, turn: 0, content: item.user, timestamp: at(0) },
			only3,
			true,
		);
	const path = join(RESULTS, RAW_FILE);
	const done: Record<string, { facts?: DraftFact[]; error?: string }> = existsSync(path)
		? JSON.parse(readFileSync(path, "utf8"))
		: {};
	const key = (job: ExtractionJob) => `${job.config}:${job.set}:${job.id}:${job.turn}`;
	// The new targets first (config 3, then their config 2 baseline), then the
	// part 2 sets: a cut-short run still has the numbers that matter most.
	const rank = (job: ExtractionJob) =>
		(["purchase", "preference", "preferenceReply", "task", "question"].includes(job.set as string) ? 0 : 10) +
		(job.config === "v3" ? 0 : 5);
	const todo = [...jobs]
		.filter((job) => !ONLY_SETS || ONLY_SETS.includes(job.set as string))
		.filter((job) => !ONLY_CONFIGS || ONLY_CONFIGS.includes(job.config))
		.sort((a, b) => rank(a) - rank(b))
		.filter((job) => !done[key(job)]?.facts);
	console.log(`extraction: ${todo.length} of ${jobs.length} calls to make`);
	let finished = 0;
	const started = Date.now();
	await pool(todo, IN_FLIGHT, async (job) => {
		try {
			done[key(job)] = {
				facts: await dryRun(job.bank, job.content, job.previousAssistant, job.timestamp),
			};
		} catch (error) {
			done[key(job)] = { error: String(error) };
		}
		finished++;
		if (finished % 10 === 0 || finished === todo.length) {
			writeFileSync(path, `${JSON.stringify(done, null, "\t")}\n`);
			const per = (Date.now() - started) / finished;
			console.log(
				`extraction ${finished}/${todo.length}, ${(per / 1000).toFixed(1)} s per call in parallel, ~${Math.round(((todo.length - finished) * per) / 60000)} min left`,
			);
		}
	});
	writeFileSync(path, `${JSON.stringify(done, null, "\t")}\n`);
}

/** Retain one source and consolidate it, waiting for both to finish. */
async function retainAndConsolidate(bank: string, content: string, timestamp: string, id: string) {
	const operationId = crypto.randomUUID();
	await call(`${bank}/memories`, "POST", {
		items: [{ content, context: context(undefined, timestamp), timestamp, document_id: id, tags: [id], metadata: {} }],
		async: true,
		operation_id: operationId,
	});
	await settle(bank, operationId);
	const consolidation = await call(`${bank}/consolidate`, "POST", {});
	await settle(bank, String(consolidation.operation_id));
}
async function settle(bank: string, operationId: string) {
	for (let i = 0; i < 720; i++) {
		const op = await call(`${bank}/operations/${operationId}`);
		if (op.status === "completed") return;
		if (op.status === "failed" || op.status === "cancelled")
			throw new Error(`operation ${op.status}`);
		await new Promise((r) => setTimeout(r, 5_000));
	}
	throw new Error("operation did not finish in 60 minutes");
}
async function observations(bank: string): Promise<string[]> {
	const page = await call(`${bank}/memories/list?state=valid&limit=100&offset=0`);
	return ((page.items as Array<Record<string, unknown>>) ?? [])
		.filter((row) => row.fact_type === "observation")
		.map((row) => String(row.text));
}

const HISTORY =
	/(\(\d{4}-\d{2}-\d{2} \d{2}:\d{2}: |\b(earlier|previously|formerly|used to|before|until|no longer|moved from|left|former|old)\b|korábban|előtte|régebben|azelőtt|egykor|korábbi|elköltöz|költözött|váltott|otthagy|helyett)/i;

/** Part 2's consolidation scenarios on config 3: one scratch bank each, two dated statements. */
async function consolidation() {
	const path = join(RESULTS, "consolidation-v3.json");
	const done: Record<string, unknown> = existsSync(path)
		? JSON.parse(readFileSync(path, "utf8"))
		: {};
	const scenarios = [
		...fixtures.change.map((item) => ({ set: "change" as const, item })),
		...fixtures.correction.map((item) => ({ set: "correction" as const, item })),
	].filter(({ item }) => !(done[item.id] as { observations?: unknown })?.observations);
	console.log(`consolidation v3: ${scenarios.length} scenarios to run`);
	const started = Date.now();
	let finished = 0;
	await pool(scenarios, IN_FLIGHT, async ({ set, item }) => {
		const bank = `c3-v3-${item.id}`;
		try {
			await call(bank, "DELETE").catch(() => {});
			await configure(bank, nativeBankConfig("personal"));
			await retainAndConsolidate(bank, item.before, "2026-03-10T09:00:00.000Z", `${item.id}-before`);
			await retainAndConsolidate(bank, item.after, "2026-09-20T18:30:00.000Z", `${item.id}-after`);
			done[item.id] = { set, observations: await observations(bank) };
		} catch (error) {
			done[item.id] = { set, error: String(error) };
		}
		finished++;
		writeFileSync(path, `${JSON.stringify(done, null, "\t")}\n`);
		const per = (Date.now() - started) / finished;
		console.log(
			`consolidation v3 ${finished}/${scenarios.length}, ~${Math.round(((scenarios.length - finished) * per) / 60000)} min left`,
		);
	});
}

/** The classifier's model call, through the shared bridge: the same request shape `createCurationModel` sends. */
async function bridgeModel(prompt: string, input: unknown, schema: Record<string, unknown>) {
	const response = await fetch(`${BRIDGE}/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: "qwen3-6-27b",
			messages: [
				{ role: "system", content: prompt },
				{ role: "user", content: JSON.stringify(input) },
			],
			temperature: 0,
			max_tokens: 8192,
			response_format: {
				type: "json_schema",
				json_schema: { name: "memory_edit", schema, strict: true },
			},
			chat_template_kwargs: { enable_thinking: false },
		}),
		signal: AbortSignal.timeout(600_000),
	});
	if (!response.ok) throw new Error(`model ${response.status}`);
	const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
	return JSON.parse(body.choices[0].message.content);
}

interface ClassifierFact {
	id: string;
	text: string;
	scope: "personal" | "project";
	/** The kind Hindsight's own extraction gave it, where it came from an extraction. */
	extracted: string | null;
}

/**
 * The classifier with config 3's words on three sets of facts:
 *  - `own`: config 3's extraction of part 2's labelled sets (kind and subject right, as part 2 measured it);
 *  - `relabel`: config 2's recorded extraction of those sets and this round's purchases through config 2,
 *    the facts that carry config 2's `temporary` label: what a relabel would see, and what it would change;
 *  - `purchases`: this round's purchase facts through config 3's extraction.
 */
async function classifier() {
	const raw = load<Record<string, { facts?: DraftFact[] }>>("extraction-raw.json");
	const part2 = JSON.parse(
		readFileSync(join(PART2, "results", "extraction-raw.json"), "utf8"),
	) as Record<string, { facts?: DraftFact[] }>;
	const facts: ClassifierFact[] = [];
	const scopeOf = (set: string) => (set === "project" ? "project" : "personal");
	const kindOf = (fact: DraftFact, set: string) =>
		labelsFromNativeTags(fact.entities, scopeOf(set)).kind;
	for (const set of ["lasting", "ongoing", "temporary", "project"] as const)
		for (const item of fixtures[set] as LabelledItem[]) {
			(raw[`v3:${set}:${item.id}:0`]?.facts ?? []).forEach((fact, i) => {
				if (mentions(fact.text, item.markers))
					facts.push({ id: `own:${set}:${item.id}:${i}`, text: fact.text, scope: scopeOf(set), extracted: kindOf(fact, set) });
			});
			(part2[`v2:${set}:${item.id}:0`]?.facts ?? []).forEach((fact, i) => {
				if (mentions(fact.text, item.markers))
					facts.push({ id: `relabel:${set}:${item.id}:${i}`, text: fact.text, scope: scopeOf(set), extracted: kindOf(fact, set) });
			});
		}
	for (const item of fixtures.purchase) {
		for (const config of ["v2", "v3"] as const)
			(raw[`${config}:purchase:${item.id}:0`]?.facts ?? []).forEach((fact, i) => {
				if (mentions(fact.text, item.markers))
					facts.push({
						id: `${config === "v2" ? "relabel" : "purchases"}:purchase:${item.id}:${i}`,
						text: fact.text,
						scope: "personal",
						extracted: kindOf(fact, "purchase"),
					});
			});
	}
	const out: Record<string, { kind: string; subject: string }> = {};
	for (const scope of ["personal", "project"] as const) {
		const batch = facts.filter((fact) => fact.scope === scope);
		const chunks = Array.from({ length: Math.ceil(batch.length / 20) }, (_, i) => batch.slice(i * 20, i * 20 + 20));
		const answers = await pool(chunks, IN_FLIGHT, (chunk) =>
			classifyMemoryFacts({ scope, facts: chunk }, bridgeModel).catch(() => new Map()),
		);
		for (const answer of answers) for (const [id, label] of answer) out[id] = label;
	}
	save("classifier-raw.json", { facts, labels: out });
	console.log(`classifier: ${Object.keys(out).length} of ${facts.length} facts labelled`);
}

function report() {
	const raw = load<Record<string, { facts?: DraftFact[]; error?: string }>>(RAW_FILE);
	const factsOf = (config: Config, set: string, id: string, turns = 1) =>
		Array.from({ length: turns }, (_, turn) => raw[`${config}:${set}:${id}:${turn}`]);
	const summary: Record<string, unknown> = {};
	const lang = (items: Array<{ lang: Lang }>, pass: (item: never) => boolean | null) => {
		const counts = { en: [0, 0], hu: [0, 0], errors: 0 };
		for (const item of items) {
			const verdict = pass(item as never);
			if (verdict === null) {
				counts.errors++;
				continue;
			}
			counts[item.lang][1]++;
			if (verdict) counts[item.lang][0]++;
		}
		return {
			pass: counts.en[0] + counts.hu[0],
			of: counts.en[1] + counts.hu[1],
			en: `${counts.en[0]}/${counts.en[1]}`,
			hu: `${counts.hu[0]}/${counts.hu[1]}`,
			errors: counts.errors,
		};
	};
	const ok = (entries: Array<{ facts?: DraftFact[] } | undefined>) =>
		entries.every((entry) => entry?.facts) ? entries.flatMap((entry) => entry?.facts ?? []) : null;
	for (const config of ["v2", "v3"] as const) {
		summary[`question-${config}`] = lang(fixtures.question, (chat: Fixtures["question"][number]) => {
			const facts = ok(factsOf(config, "question", chat.id));
			return facts === null ? null : facts.length === 0;
		});
		summary[`task-nothing-kept-${config}`] = lang(fixtures.task, (chat: Fixtures["task"][number]) => {
			const facts = ok(factsOf(config, "task", chat.id));
			return facts === null ? null : facts.length === 0;
		});
		const kindsOf = (item: LabelledItem) =>
			(ok(factsOf(config, "purchase", item.id)) ?? [])
				.filter((fact) => mentions(fact.text, item.markers))
				.map((fact) => labelsFromNativeTags(fact.entities, "personal").kind);
		summary[`purchase-kept-${config}`] = lang(fixtures.purchase, (item: LabelledItem) => {
			const facts = ok(factsOf(config, "purchase", item.id));
			return facts === null ? null : facts.some((fact) => mentions(fact.text, item.markers));
		});
		summary[`purchase-lasting-${config}`] = lang(fixtures.purchase, (item: LabelledItem) => {
			if (!ok(factsOf(config, "purchase", item.id))) return null;
			const kinds = kindsOf(item);
			return kinds.length > 0 && kinds.every((kind) => kind === "lasting");
		});
		summary[`purchase-any-temporary-${config}`] = lang(fixtures.purchase, (item: LabelledItem) =>
			ok(factsOf(config, "purchase", item.id)) ? kindsOf(item).includes("temporary") : null,
		);
		summary[`preference-kept-${config}`] = lang(fixtures.preference, (item: LabelledItem) => {
			const facts = ok(factsOf(config, "preference", item.id));
			return facts === null ? null : facts.some((fact) => mentions(fact.text, item.markers));
		});
		summary[`preference-kept-lasting-${config}`] = lang(fixtures.preference, (item: LabelledItem) => {
			const facts = ok(factsOf(config, "preference", item.id));
			if (facts === null) return null;
			const kept = facts.filter((fact) => mentions(fact.text, item.markers));
			return kept.length > 0 && kept.every((fact) => labelsFromNativeTags(fact.entities, "personal").kind === "lasting");
		});
		summary[`preference-after-reply-kept-${config}`] = lang(fixtures.preferenceReply, (item: LabelledItem) => {
			const facts = ok(factsOf(config, "preferenceReply", item.id));
			return facts === null ? null : facts.some((fact) => mentions(fact.text, item.markers));
		});
		summary[`preference-after-reply-kept-lasting-${config}`] = lang(fixtures.preferenceReply, (item: LabelledItem) => {
			const facts = ok(factsOf(config, "preferenceReply", item.id));
			if (facts === null) return null;
			const kept = facts.filter((fact) => mentions(fact.text, item.markers));
			return kept.length > 0 && kept.every((fact) => labelsFromNativeTags(fact.entities, "personal").kind === "lasting");
		});
	}
	const config = "v3" as const;
	summary["brainstorm-v3"] = lang(fixtures.brainstorm, (chat: Fixtures["brainstorm"][number]) => {
		const facts = ok(factsOf(config, "brainstorm", chat.id, chat.turns.length));
		return facts === null ? null : facts.every((fact) => mentions(fact.text, chat.outcomeMarkers));
	});
	summary["brainstorm-v3-no-dropped-option"] = lang(fixtures.brainstorm, (chat: Fixtures["brainstorm"][number]) => {
		const facts = ok(factsOf(config, "brainstorm", chat.id, chat.turns.length));
		return facts === null
			? null
			: !facts.some((fact) => mentions(fact.text, chat.stepMarkers) && !mentions(fact.text, chat.outcomeMarkers));
	});
	summary["brainstorm-v3-outcome-kept"] = lang(fixtures.brainstorm, (chat: Fixtures["brainstorm"][number]) => {
		const facts = ok(factsOf(config, "brainstorm", chat.id, chat.turns.length));
		return facts === null ? null : facts.some((fact) => mentions(fact.text, chat.outcomeMarkers));
	});
	summary["brainstorm-v3-facts"] = fixtures.brainstorm.reduce(
		(sum, chat) => sum + (ok(factsOf(config, "brainstorm", chat.id, chat.turns.length))?.length ?? 0),
		0,
	);
	summary["lasting-kept-v3"] = lang(fixtures.lasting, (item: LabelledItem) => {
		const facts = ok(factsOf(config, "lasting", item.id));
		return facts === null ? null : facts.some((fact) => mentions(fact.text, item.markers));
	});
	// Labels: config 3's facts that name the item's fact (a marker), against the item's labels.
	const labelRows: Array<{ set: string; lang: Lang; expected: LabelledItem; got: { kind: string | null; subject: string | null } }> = [];
	for (const set of ["lasting", "ongoing", "temporary", "project"] as const)
		for (const item of fixtures[set] as LabelledItem[])
			for (const fact of raw[`v3:${set}:${item.id}:0`]?.facts ?? [])
				if (mentions(fact.text, item.markers))
					labelRows.push({
						set,
						lang: item.lang,
						expected: item,
						got: labelsFromNativeTags(fact.entities, set === "project" ? "project" : "personal"),
					});
	const grade = (rows: typeof labelRows) => ({
		facts: rows.length,
		kindRight: rows.filter((row) => row.got.kind === row.expected.kind).length,
		subjectRight: rows.filter((row) => row.got.subject === row.expected.subject).length,
		unlabelledKind: rows.filter((row) => row.got.kind === null).length,
		lastingAsTemporaryOrOngoing: rows.filter(
			(row) => row.expected.kind === "lasting" && (row.got.kind === "temporary" || row.got.kind === "ongoing"),
		).length,
		lastingFacts: rows.filter((row) => row.expected.kind === "lasting").length,
	});
	summary.labels = {
		all: grade(labelRows),
		en: grade(labelRows.filter((row) => row.lang === "en")),
		hu: grade(labelRows.filter((row) => row.lang === "hu")),
		bySet: Object.fromEntries(
			["lasting", "ongoing", "temporary", "project"].map((set) => [set, grade(labelRows.filter((row) => row.set === set))]),
		),
	};
	if (existsSync(join(RESULTS, "classifier-raw.json"))) {
		const { facts, labels } = load<{ facts: ClassifierFact[]; labels: Record<string, { kind: string; subject: string }> }>("classifier-raw.json");
		const rowsOf = (prefix: string) =>
			facts
				.filter((fact) => fact.id.startsWith(`${prefix}:`))
				.map((fact) => {
					const [, set, itemId] = fact.id.split(":");
					const item = (fixtures[set as "lasting"] as LabelledItem[]).find((candidate) => candidate.id === itemId) as LabelledItem;
					return { set, lang: item.lang, expected: item, got: labels[fact.id] ?? { kind: null, subject: null }, extracted: fact.extracted };
				});
		const own = rowsOf("own").filter((row) => row.set !== "purchase");
		summary.classifier = {
			all: grade(own),
			en: grade(own.filter((row) => row.lang === "en")),
			hu: grade(own.filter((row) => row.lang === "hu")),
		};
		// The purchases through the classifier: the facts config 3's extraction wrote, and
		// the facts config 2's extraction wrote (what a relabel of today's banks would see).
		const purchaseKinds = (rows: ReturnType<typeof rowsOf>) => {
			const tally = (pick: (row: (typeof rows)[number]) => boolean) => rows.filter(pick).length;
			return {
				facts: rows.length,
				lasting: tally((row) => row.got.kind === "lasting"),
				ongoing: tally((row) => row.got.kind === "ongoing"),
				temporary: tally((row) => row.got.kind === "temporary"),
				unlabelled: tally((row) => row.got.kind === null),
				labelledTemporaryByExtraction: tally((row) => row.extracted === "temporary"),
				ofThose_nowLasting: tally((row) => row.extracted === "temporary" && row.got.kind === "lasting"),
				ofThose_nowOngoing: tally((row) => row.extracted === "temporary" && row.got.kind === "ongoing"),
				ofThose_stillTemporary: tally((row) => row.extracted === "temporary" && row.got.kind === "temporary"),
			};
		};
		const purchase3 = rowsOf("purchases");
		const purchase2 = rowsOf("relabel").filter((row) => row.set === "purchase");
		summary["classifier-purchase-extracted-by-v3"] = {
			all: purchaseKinds(purchase3),
			en: purchaseKinds(purchase3.filter((row) => row.lang === "en")),
			hu: purchaseKinds(purchase3.filter((row) => row.lang === "hu")),
		};
		summary["classifier-purchase-extracted-by-v2"] = {
			all: purchaseKinds(purchase2),
			en: purchaseKinds(purchase2.filter((row) => row.lang === "en")),
			hu: purchaseKinds(purchase2.filter((row) => row.lang === "hu")),
		};
		// What a relabel would change in a real account: the facts config 2 labelled temporary,
		// from part 2's recorded extraction of its labelled sets, by what they truly are.
		const relabel = rowsOf("relabel").filter((row) => row.set !== "purchase" && row.extracted === "temporary");
		const bySet = (set: string) => {
			const rows = relabel.filter((row) => row.set === set);
			return {
				facts: rows.length,
				nowLasting: rows.filter((row) => row.got.kind === "lasting").length,
				nowOngoing: rows.filter((row) => row.got.kind === "ongoing").length,
				stillTemporary: rows.filter((row) => row.got.kind === "temporary").length,
				unlabelled: rows.filter((row) => row.got.kind === null).length,
			};
		};
		summary["relabel-of-config-2-temporary-facts"] = Object.fromEntries(
			["lasting", "ongoing", "temporary", "project"].map((set) => [set, bySet(set)]),
		);
	}
	const path = join(RESULTS, "consolidation-v3.json");
	if (existsSync(path)) {
		const done = load<Record<string, { set: string; observations?: string[]; error?: string }>>("consolidation-v3.json");
		summary["change-v3"] = lang(fixtures.change, (item: Fixtures["change"][number]) => {
			const obs = done[item.id]?.observations;
			if (!obs) return null;
			const current = obs.some((text) => mentions(text, item.newMarkers));
			const old = obs.filter((text) => mentions(text, item.oldMarkers));
			return current && old.length > 0 && old.every((text) => mentions(text, item.newMarkers) || HISTORY.test(text));
		});
		summary["change-v3-new-current"] = lang(fixtures.change, (item: Fixtures["change"][number]) => {
			const obs = done[item.id]?.observations;
			return obs ? obs.some((text) => mentions(text, item.newMarkers)) : null;
		});
		summary["correction-v3"] = lang(fixtures.correction, (item: Fixtures["correction"][number]) => {
			const obs = done[item.id]?.observations;
			if (!obs) return null;
			return obs.some((text) => mentions(text, item.rightMarkers)) && !obs.some((text) => mentions(text, item.wrongMarkers));
		});
	}
	save(SUMMARY_FILE, summary);
	console.log(JSON.stringify(summary, null, 2));
}

const phase = process.argv[2];
const phases: Record<string, () => Promise<void> | void> = {
	setup,
	extraction,
	consolidation,
	classifier,
	report,
};
if (!phases[phase]) {
	console.error(`phase must be one of ${Object.keys(phases).join(", ")}`);
	process.exit(2);
}
await phases[phase]();
