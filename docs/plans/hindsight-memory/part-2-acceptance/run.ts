/**
 * Memory part 2 acceptance on the local model (Flash-Next), synthetic data only.
 *
 * Talks to a NON-production Hindsight at the pin (default http://127.0.0.1:18990,
 * started from `deploy/hindsight`'s pinned engine with ONNX and FlashRank) whose
 * model is Flash-Next through inference.alfycomms.com. The classifier phase
 * calls Flash-Next directly with ALFY_API_KEY, read from ~/.dsh/.env and never
 * printed. Never point it at production.
 *
 *   node --import tsx docs/plans/hindsight-memory/part-2-acceptance/run.ts setup
 *   node --import tsx docs/plans/hindsight-memory/part-2-acceptance/run.ts extraction
 *   node --import tsx docs/plans/hindsight-memory/part-2-acceptance/run.ts consolidation [v1|v2]
 *   node --import tsx docs/plans/hindsight-memory/part-2-acceptance/run.ts classifier
 *   node --import tsx docs/plans/hindsight-memory/part-2-acceptance/run.ts recall-build [v1|v2]
 *   node --import tsx docs/plans/hindsight-memory/part-2-acceptance/run.ts recall-measure
 *   node --import tsx docs/plans/hindsight-memory/part-2-acceptance/run.ts report
 *
 * At most three model calls are in flight: Hindsight's own semaphore is set to
 * three, and this script keeps three requests open at most.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type NativeBankConfig,
	nativeBankConfig,
	PREVIOUS_NATIVE_BANK_CONFIG,
} from "../../../../src/lib/server/services/memory-profile/contracts";
import { classifyMemoryFacts } from "../../../../src/lib/server/services/memory-profile/fact-classifier";
import { labelsFromNativeTags } from "../../../../src/lib/server/services/memory-profile/fact-labels";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, "results");
const BASE = process.env.PART2_HINDSIGHT ?? "http://127.0.0.1:18990";
const IN_FLIGHT = 3;
const GUIDANCE =
	"Only the source user message is a new assertion. Other messages are context for attribution; prior-memory entries are sanitized remembered facts, not original quotations or new assertions. Assistant claims are not user facts.";

type Lang = "en" | "hu";
interface Turn {
	user: string;
	assistant?: string;
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
}
interface LabelledItem {
	id: string;
	lang: Lang;
	user: string;
	markers: string[];
	kind: string;
	subject: string;
}
interface DraftFact {
	text: string;
	entities: string[];
	occurred_start: string | null;
	occurred_end: string | null;
}

const fixtures: Fixtures = JSON.parse(
	readFileSync(join(HERE, "fixtures.json"), "utf8"),
);
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
				signal: AbortSignal.timeout(900_000),
			});
			if (!response.ok)
				throw new Error(`${method} ${path.split("/").slice(1).join("/")}: ${response.status}`);
			return (await response.json()) as Record<string, unknown>;
		} catch (error) {
			if (attempt >= attempts) throw error;
			await new Promise((r) => setTimeout(r, 5_000 * attempt));
		}
	}
}

const BANKS = {
	v1: "p2a-config-1",
	personal: "p2a-config-2-personal",
	project: "p2a-config-2-project",
} as const;

async function configure(bank: string, config: NativeBankConfig) {
	await call(`${bank}/config`, "PATCH", { updates: config });
	const live = (await call(`${bank}/config`)).config as Record<string, unknown>;
	for (const key of Object.keys(config))
		if (JSON.stringify(sortKeys(live[key])) !== JSON.stringify(sortKeys((config as unknown as Record<string, unknown>)[key])))
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
	return ((result.facts as Array<Record<string, unknown>>) ?? []).map((fact) => ({
		text: String(fact.text ?? ""),
		entities: (fact.entities as string[]) ?? [],
		occurred_start: (fact.occurred_start as string | null) ?? null,
		occurred_end: (fact.occurred_end as string | null) ?? null,
	}));
}

/** What the app's recall asks Hindsight to include (hindsight-client.ts, recall). */
const APP_RECALL_INCLUDE = {
	entities: null,
	chunks: null,
	source_facts: { max_tokens: 0, max_tokens_per_observation: 0 },
};
const lower = (text: string) => text.toLowerCase();
const mentions = (text: string, markers: string[]) =>
	markers.some((marker) => lower(text).includes(lower(marker)));

async function setup() {
	await configure(BANKS.v1, PREVIOUS_NATIVE_BANK_CONFIG);
	await configure(BANKS.personal, nativeBankConfig("personal"));
	await configure(BANKS.project, nativeBankConfig("project"));
	console.log("configured", Object.values(BANKS).join(", "));
}

/** One extraction job: a turn of a chat, through one bank's config. */
interface ExtractionJob {
	set: keyof Fixtures;
	id: string;
	lang: Lang;
	config: "v1" | "v2";
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
	// Config 1 runs only where a target compares against it, or as the baseline
	// of an absolute target; labels exist only in config 2.
	const both = (job: Omit<ExtractionJob, "config" | "bank">, project = false) => {
		jobs.push({ ...job, config: "v2", bank: project ? BANKS.project : BANKS.personal });
		if (["question", "brainstorm", "lasting"].includes(job.set))
			jobs.push({ ...job, config: "v1", bank: BANKS.v1 });
	};
	for (const chat of fixtures.question)
		both({ set: "question", id: chat.id, lang: chat.lang, turn: 0, content: chat.turns[0].user, timestamp: at(0) });
	for (const chat of fixtures.brainstorm)
		chat.turns.forEach((turn, i) =>
			both({
				set: "brainstorm",
				id: chat.id,
				lang: chat.lang,
				turn: i,
				content: turn.user,
				previousAssistant: i ? chat.turns[i - 1].assistant : undefined,
				timestamp: at(i),
			}),
		);
	for (const set of ["lasting", "ongoing", "temporary"] as const)
		for (const item of fixtures[set])
			both({ set, id: item.id, lang: item.lang, turn: 0, content: item.user, timestamp: at(0) });
	for (const item of fixtures.project)
		both(
			{ set: "project", id: item.id, lang: item.lang, turn: 0, content: item.user, timestamp: at(0) },
			true,
		);
	const path = join(RESULTS, "extraction-raw.json");
	const done: Record<string, { facts?: DraftFact[]; error?: string }> = existsSync(path)
		? JSON.parse(readFileSync(path, "utf8"))
		: {};
	const key = (job: ExtractionJob) => `${job.config}:${job.set}:${job.id}:${job.turn}`;
	// Config 2 first, so the targets have numbers even if a run is cut short.
	const order = [...jobs].sort((a, b) => (a.config === b.config ? 0 : a.config === "v2" ? -1 : 1));
	const todo = order.filter((job) => !done[key(job)]?.facts);
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
	for (let i = 0; i < 360; i++) {
		const op = await call(`${bank}/operations/${operationId}`);
		if (op.status === "completed") return;
		if (op.status === "failed" || op.status === "cancelled")
			throw new Error(`operation ${op.status}`);
		await new Promise((r) => setTimeout(r, 5_000));
	}
	throw new Error("operation did not finish in 30 minutes");
}
async function observations(bank: string): Promise<string[]> {
	const page = await call(`${bank}/memories/list?state=valid&limit=100&offset=0`);
	return ((page.items as Array<Record<string, unknown>>) ?? [])
		.filter((row) => row.fact_type === "observation")
		.map((row) => String(row.text));
}

const HISTORY =
	/(\(\d{4}-\d{2}-\d{2} \d{2}:\d{2}: |\b(earlier|previously|formerly|used to|before|until|no longer|moved from|left|former|old)\b|korábban|előtte|régebben|azelőtt|egykor|korábbi|elköltöz|költözött|váltott|otthagy|helyett)/i;

async function consolidation(config: "v1" | "v2") {
	const path = join(RESULTS, `consolidation-${config}.json`);
	const done: Record<string, unknown> = existsSync(path)
		? JSON.parse(readFileSync(path, "utf8"))
		: {};
	const scenarios = [
		...fixtures.change.map((item) => ({ set: "change" as const, item })),
		...fixtures.correction.map((item) => ({ set: "correction" as const, item })),
	].filter(({ item }) => !(done[item.id] as { observations?: unknown })?.observations);
	console.log(`consolidation ${config}: ${scenarios.length} scenarios to run`);
	const started = Date.now();
	let finished = 0;
	await pool(scenarios, IN_FLIGHT, async ({ set, item }) => {
		const bank = `p2a-${config}-${item.id}`;
		try {
			await call(bank, "DELETE").catch(() => {});
			await configure(
				bank,
				config === "v1" ? PREVIOUS_NATIVE_BANK_CONFIG : nativeBankConfig("personal"),
			);
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
			`consolidation ${config} ${finished}/${scenarios.length}, ~${Math.round(((scenarios.length - finished) * per) / 60000)} min left`,
		);
	});
}

/**
 * The label entities' effect on recall: the same 60 personal facts (lasting,
 * ongoing, temporary) retained into one bank per config, each its own
 * document, dated across 2026, then consolidated.
 */
async function recallBuild(config: "v1" | "v2") {
	const bank = `p2a-recall-${config}`;
	await call(bank, "DELETE").catch(() => {});
	await configure(bank, config === "v1" ? PREVIOUS_NATIVE_BANK_CONFIG : nativeBankConfig("personal"));
	const items = [...fixtures.lasting, ...fixtures.ongoing, ...fixtures.temporary];
	let finished = 0;
	await pool(items, IN_FLIGHT, async (item, index) => {
		const timestamp = new Date(Date.UTC(2026, 0, 5 + index * 5, 12)).toISOString();
		const operationId = crypto.randomUUID();
		await call(`${bank}/memories`, "POST", {
			items: [{ content: item.user, context: context(undefined, timestamp), timestamp, document_id: item.id, tags: [item.id], metadata: {} }],
			async: true,
			operation_id: operationId,
		});
		await settle(bank, operationId);
		if (++finished % 10 === 0) console.log(`recall-build ${config}: ${finished}/${items.length} retained`);
	});
	const consolidation = await call(`${bank}/consolidate`, "POST", {});
	await settle(bank, String(consolidation.operation_id));
	console.log(`recall-build ${config}: consolidated, ${(await observations(bank)).length} observations`);
}

/** The same question about each fact's marker against both banks: where the fact ranks. */
async function recallMeasure() {
	const items = [...fixtures.lasting, ...fixtures.ongoing, ...fixtures.temporary];
	const out: Record<string, Record<string, number | null>> = { v1: {}, v2: {} };
	for (const config of ["v1", "v2"] as const)
		for (const item of items) {
			const marker = item.markers[0];
			const query = item.lang === "hu" ? `Mit tudsz arról, hogy ${marker}?` : `What do you know about ${marker}?`;
			const result = await call(`p2a-recall-${config}/memories/recall`, "POST", {
				query,
				types: ["observation"],
				budget: "mid",
				max_tokens: 4096,
				include: APP_RECALL_INCLUDE,
			});
			const texts = ((result.results as Array<Record<string, unknown>>) ?? []).map((row) => String(row.text));
			const rank = texts.findIndex((text) => mentions(text, item.markers));
			out[config][item.id] = rank < 0 ? null : rank;
		}
	// Review Minor 4: in a small bank, does a temporary entry reach the top
	// three for a message that is not about it? (Unrelated messages, config 2.)
	const list = await call("p2a-recall-v2/memories/list?state=valid&limit=100&offset=0");
	const rows = (list.items as Array<Record<string, unknown>>) ?? [];
	const temporaryFacts = new Set(
		rows
			.filter((row) => row.fact_type !== "observation" && ((row.tags as string[]) ?? []).includes("kind:temporary"))
			.map((row) => String(row.id)),
	);
	const unrelated = [
		"Thanks, that helps a lot!",
		"Can you help me write a polite email to my landlord?",
		"What is the difference between a list and a tuple in Python?",
		"Give me three ideas for a quick weeknight dinner.",
		"How do I convert Fahrenheit to Celsius?",
		"Köszönöm szépen, ez sokat segített!",
		"Segítesz megírni egy udvarias e-mailt a főbérlőmnek?",
		"Mi a különbség a lista és a tuple között Pythonban?",
		"Adj három ötletet egy gyors hétköznapi vacsorára.",
		"Hogyan váltom át a Fahrenheitet Celsiusra?",
	];
	const offTopic: number[] = [];
	for (const query of unrelated) {
		const result = await call("p2a-recall-v2/memories/recall", "POST", {
			query,
			types: ["observation"],
			budget: "mid",
			max_tokens: 4096,
			include: APP_RECALL_INCLUDE,
		});
		const top = ((result.results as Array<Record<string, unknown>>) ?? []).slice(0, 3);
		offTopic.push(
			top.filter((row) =>
				((row.source_fact_ids as string[]) ?? []).some((id) => temporaryFacts.has(id)),
			).length,
		);
	}
	out.unrelated = { temporaryInTopThree: Object.fromEntries(offTopic.map((n, i) => [String(i), n])) } as never;
	save("recall-effect.json", out);
	const summary = (config: "v1" | "v2") => {
		const ranks = Object.values(out[config]);
		return {
			first: ranks.filter((rank) => rank === 0).length,
			top3: ranks.filter((rank) => rank !== null && rank < 3).length,
			found: ranks.filter((rank) => rank !== null).length,
			of: ranks.length,
		};
	};
	console.log(
		JSON.stringify({
			v1: summary("v1"),
			v2: summary("v2"),
			unrelatedMessagesWithATemporaryEntryInTopThree: offTopic.filter((n) => n > 0).length,
			unrelatedMessages: unrelated.length,
		}),
	);
}

function alfyKey(): string {
	for (const line of readFileSync(join(homedir(), ".dsh/.env"), "utf8").split("\n"))
		if (line.startsWith("ALFY_API_KEY="))
			return line.slice("ALFY_API_KEY=".length).trim().replace(/^["']|["']$/g, "");
	throw new Error("ALFY_API_KEY missing");
}

/** The classifier on the facts config 2 extracted, through the same JSON-schema call shape. */
async function classifier() {
	const raw = load<Record<string, { facts?: DraftFact[] }>>("extraction-raw.json");
	const key = alfyKey();
	const model = async (prompt: string, input: unknown, schema: Record<string, unknown>) => {
		const response = await fetch("https://inference.alfycomms.com/v1/chat/completions", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
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
			signal: AbortSignal.timeout(300_000),
		});
		if (!response.ok) throw new Error(`model ${response.status}`);
		const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
		return JSON.parse(body.choices[0].message.content);
	};
	const facts: Array<{ id: string; text: string; scope: "personal" | "project" }> = [];
	for (const set of ["lasting", "ongoing", "temporary", "project"] as const)
		for (const item of fixtures[set] as LabelledItem[])
			(raw[`v2:${set}:${item.id}:0`]?.facts ?? []).forEach((fact, i) => {
				if (mentions(fact.text, item.markers))
					facts.push({ id: `${set}:${item.id}:${i}`, text: fact.text, scope: set === "project" ? "project" : "personal" });
			});
	const out: Record<string, { kind: string; subject: string }> = {};
	for (const scope of ["personal", "project"] as const) {
		const batch = facts.filter((fact) => fact.scope === scope);
		const chunks = Array.from({ length: Math.ceil(batch.length / 20) }, (_, i) => batch.slice(i * 20, i * 20 + 20));
		const answers = await pool(chunks, IN_FLIGHT, (chunk) =>
			classifyMemoryFacts({ scope, facts: chunk }, model).catch(() => new Map()),
		);
		for (const answer of answers) for (const [id, label] of answer) out[id] = label;
	}
	save("classifier-raw.json", { facts, labels: out });
	console.log(`classifier: ${Object.keys(out).length} of ${facts.length} facts labelled`);
}

function report() {
	const raw = load<Record<string, { facts?: DraftFact[]; error?: string }>>("extraction-raw.json");
	const factsOf = (config: "v1" | "v2", set: string, id: string, turns = 1) =>
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
	for (const config of ["v1", "v2"] as const) {
		const ok = (entries: Array<{ facts?: DraftFact[] } | undefined>) =>
			entries.every((entry) => entry?.facts) ? entries.flatMap((entry) => entry?.facts ?? []) : null;
		summary[`question-${config}`] = lang(fixtures.question, (chat: Fixtures["question"][number]) => {
			const facts = ok(factsOf(config, "question", chat.id));
			return facts === null ? null : facts.length === 0;
		});
		summary[`brainstorm-${config}`] = lang(fixtures.brainstorm, (chat: Fixtures["brainstorm"][number]) => {
			const facts = ok(factsOf(config, "brainstorm", chat.id, chat.turns.length));
			return facts === null ? null : facts.every((fact) => mentions(fact.text, chat.outcomeMarkers));
		});
		// Looser: no fact keeps a dropped option (a step or a reaction to it)
		// without the outcome; background facts stated along the way pass.
		summary[`brainstorm-${config}-no-dropped-option`] = lang(
			fixtures.brainstorm,
			(chat: Fixtures["brainstorm"][number]) => {
				const facts = ok(factsOf(config, "brainstorm", chat.id, chat.turns.length));
				return facts === null
					? null
					: !facts.some(
							(fact) =>
								mentions(fact.text, chat.stepMarkers) &&
								!mentions(fact.text, chat.outcomeMarkers),
						);
			},
		);
		summary[`brainstorm-${config}-outcome-kept`] = lang(
			fixtures.brainstorm,
			(chat: Fixtures["brainstorm"][number]) => {
				const facts = ok(factsOf(config, "brainstorm", chat.id, chat.turns.length));
				return facts === null ? null : facts.some((fact) => mentions(fact.text, chat.outcomeMarkers));
			},
		);
		summary[`brainstorm-${config}-facts`] = fixtures.brainstorm.reduce(
			(sum, chat) => sum + (ok(factsOf(config, "brainstorm", chat.id, chat.turns.length))?.length ?? 0),
			0,
		);
		summary[`lasting-kept-${config}`] = lang(fixtures.lasting, (item: LabelledItem) => {
			const facts = ok(factsOf(config, "lasting", item.id));
			return facts === null ? null : facts.some((fact) => mentions(fact.text, item.markers));
		});
	}
	// Labels: config 2's facts that name the item's fact (a marker), against the item's labels.
	const labelRows: Array<{ set: string; lang: Lang; expected: LabelledItem; got: { kind: string | null; subject: string | null } }> = [];
	for (const set of ["lasting", "ongoing", "temporary", "project"] as const)
		for (const item of fixtures[set] as LabelledItem[])
			for (const fact of raw[`v2:${set}:${item.id}:0`]?.facts ?? [])
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
		const { facts, labels } = load<{ facts: Array<{ id: string }>; labels: Record<string, { kind: string; subject: string }> }>("classifier-raw.json");
		const rows = facts.map((fact) => {
			const [set, itemId] = fact.id.split(":");
			const item = (fixtures[set as "lasting"] as LabelledItem[]).find((candidate) => candidate.id === itemId) as LabelledItem;
			return { set, lang: item.lang, expected: item, got: labels[fact.id] ?? { kind: null, subject: null } };
		});
		summary.classifier = {
			all: grade(rows),
			en: grade(rows.filter((row) => row.lang === "en")),
			hu: grade(rows.filter((row) => row.lang === "hu")),
		};
	}
	for (const config of ["v1", "v2"] as const) {
		const path = join(RESULTS, `consolidation-${config}.json`);
		if (!existsSync(path)) continue;
		const done = load<Record<string, { set: string; observations?: string[]; error?: string }>>(`consolidation-${config}.json`);
		summary[`change-${config}`] = lang(fixtures.change, (item: Fixtures["change"][number]) => {
			const obs = done[item.id]?.observations;
			if (!obs) return null;
			const current = obs.some((text) => mentions(text, item.newMarkers));
			const old = obs.filter((text) => mentions(text, item.oldMarkers));
			return current && old.length > 0 && old.every((text) => mentions(text, item.newMarkers) || HISTORY.test(text));
		});
		summary[`change-${config}-new-current`] = lang(fixtures.change, (item: Fixtures["change"][number]) => {
			const obs = done[item.id]?.observations;
			return obs ? obs.some((text) => mentions(text, item.newMarkers)) : null;
		});
		summary[`correction-${config}`] = lang(fixtures.correction, (item: Fixtures["correction"][number]) => {
			const obs = done[item.id]?.observations;
			if (!obs) return null;
			return obs.some((text) => mentions(text, item.rightMarkers)) && !obs.some((text) => mentions(text, item.wrongMarkers));
		});
	}
	save("summary.json", summary);
	console.log(JSON.stringify(summary, null, 2));
}

const phase = process.argv[2];
const phases: Record<string, () => Promise<void> | void> = {
	setup,
	extraction,
	consolidation: () => consolidation(process.argv[3] === "v1" ? "v1" : "v2"),
	classifier,
	"recall-build": () => recallBuild(process.argv[3] === "v1" ? "v1" : "v2"),
	"recall-measure": recallMeasure,
	report,
};
if (!phases[phase]) {
	console.error(`phase must be one of ${Object.keys(phases).join(", ")}`);
	process.exit(2);
}
await phases[phase]();
