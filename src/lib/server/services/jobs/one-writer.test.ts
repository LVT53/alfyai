// One writer.
//
// Every state change of a job and every scheduling decision lives in
// `services/jobs/` and nowhere else; that is the whole point of the engine, and
// it is only true while this test passes. No file outside the engine writes a
// lifecycle column of a kind's jobs table, or a lifecycle column of its
// attempts table, or inserts a row into either: a job is born through `enqueue`
// and an attempt through the claim.
//
// What a kind MAY write is its own domain columns, and its own extra attempt
// columns (`extractor`, `resumed`, `text_length`, `mode`, `renderer`…) inside the
// `apply` of `ctx.write`, `succeed` and `fail`, which run in the engine's fenced
// transaction. This scan allows those and refuses the rest.
//
// The scan is deliberately dumb: it reads source text, of `src/` and of the
// `scripts/` that open the same database. It finds
//
//   - `update(<kind table>).set({ … })` with a lifecycle key in the object, or
//     in an object a spread in it may spread (`...(failed ? { status } : {})`),
//   - `update(<kind table>).set(…)` whose columns it cannot read: an argument
//     that is not an object literal, a spread of a variable, a computed key,
//   - `insert(<kind table>)` at all,
//   - `delete(<kind table>)` is NOT a lifecycle write (account and conversation
//     erasure delete rows; the foreign keys cascade) and is allowed,
//   - raw SQL `UPDATE <kind table>` / `INSERT INTO <kind table>`.
//
// What it cannot see is a kind table reached under another name (an import
// alias, a variable holding the table); review catches those.
//
// `ALLOWED` lists, with a reason each, the files that still do. It can only
// shrink: the second test fails for an entry that no longer matches, so a slice
// that moves a kind onto the engine removes its entries in the same commit.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");
const SCRIPTS = join(ROOT, "scripts");
const ENGINE_DIR = join(SRC, "lib", "server", "services", "jobs");
const SCHEMA = join(SRC, "lib", "server", "db", "schema.ts");

/** Lifecycle columns of a kind's jobs table, by property name (design: "The lifecycle shape"), with the legacy spellings. */
const JOB_LIFECYCLE_KEYS = new Set([
	"status",
	"phase",
	"priority",
	"currentAttemptId",
	"attemptCount",
	"runAfter",
	"nextAttemptAt",
	"retryable",
	"errorRetryable",
	"errorCode",
	"errorMessage",
	"cancelRequestedAt",
	"startedAt",
	"completedAt",
	"checkpoint",
	"remoteHandleJson",
	"retryState",
	"heartbeatAt",
	"workerId",
]);

/** Lifecycle columns of an attempts table. A kind's extra columns are not on this list. */
const ATTEMPT_LIFECYCLE_KEYS = new Set([
	"id",
	"jobId",
	"attemptNumber",
	"status",
	"phase",
	"stage",
	"workerId",
	"claimedAt",
	"heartbeatAt",
	"startedAt",
	"finishedAt",
	"errorCode",
	"errorMessage",
	"retryable",
	"diagnosticsJson",
	"createdAt",
	"updatedAt",
]);

/**
 * The kind tables as they stand today, by Drizzle identifier, with the SQL name
 * for raw statements. A table built with the engine's column builders joins them
 * on its own: `discoverKindTables` reads `schema.ts`.
 */
const LEGACY_JOB_TABLES = [
	{ identifier: "fileProductionJobs", sql: "file_production_jobs" },
	{ identifier: "documentExtractionJobs", sql: "document_extraction_jobs" },
	{ identifier: "atlasJobs", sql: "atlas_jobs" },
];
const LEGACY_ATTEMPT_TABLES = [
	{
		identifier: "fileProductionJobAttempts",
		sql: "file_production_job_attempts",
	},
	{
		identifier: "documentExtractionJobAttempts",
		sql: "document_extraction_job_attempts",
	},
	{ identifier: "atlasJobAttempts", sql: "atlas_job_attempts" },
];

interface KindTables {
	jobs: Map<string, string>;
	attempts: Map<string, string>;
}

/** Every table built with `jobColumns()` / `jobAttemptColumns()`, plus the legacy ones. */
function discoverKindTables(schemaSource: string): KindTables {
	const jobs = new Map(LEGACY_JOB_TABLES.map((t) => [t.identifier, t.sql]));
	const attempts = new Map(
		LEGACY_ATTEMPT_TABLES.map((t) => [t.identifier, t.sql]),
	);
	const declaration =
		/export const (\w+) = sqliteTable\(\s*"([^"]+)"([\s\S]*?)(?=\nexport const |$)/g;
	for (const match of schemaSource.matchAll(declaration)) {
		const [, identifier, sqlName, body] = match;
		if (body.includes("...jobColumns(")) jobs.set(identifier, sqlName);
		if (body.includes("...jobAttemptColumns("))
			attempts.set(identifier, sqlName);
	}
	return { jobs, attempts };
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

/** The text between the braces that open at `openAt`, braces balanced. */
function braceBody(source: string, openAt: number): string {
	let depth = 0;
	let quote: string | null = null;
	for (let i = openAt; i < source.length; i += 1) {
		const char = source[i];
		if (quote) {
			if (char === "\\") i += 1;
			else if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") quote = char;
		else if (char === "{") depth += 1;
		else if (char === "}") {
			depth -= 1;
			if (depth === 0) return source.slice(openAt + 1, i);
		}
	}
	return source.slice(openAt + 1);
}

/** An object literal's body cut at its top-level commas. */
function topLevelSegments(body: string): string[] {
	const segments: string[] = [];
	let depth = 0;
	let quote: string | null = null;
	let segment = "";
	const flush = (): void => {
		const text = segment.trim();
		segment = "";
		if (text) segments.push(text);
	};
	for (let i = 0; i < body.length; i += 1) {
		const char = body[i];
		if (quote) {
			segment += char;
			if (char === "\\") {
				i += 1;
				segment += body[i] ?? "";
			} else if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			quote = char;
			segment += char;
		} else if ("({[".includes(char)) {
			depth += 1;
			segment += char;
		} else if (")}]".includes(char)) {
			depth -= 1;
			segment += char;
		} else if (char === "," && depth === 0) flush();
		else segment += char;
	}
	flush();
	return segments;
}

/**
 * The bodies of the object literals a spread expression may spread, at its own
 * level: `(failed ? { status } : {})` gives `status` and nothing.
 */
function literalsIn(expression: string): string[] {
	const bodies: string[] = [];
	let quote: string | null = null;
	for (let i = 0; i < expression.length; i += 1) {
		const char = expression[i];
		if (quote) {
			if (char === "\\") i += 1;
			else if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") quote = char;
		else if (char === "{") {
			const body = braceBody(expression, i);
			bodies.push(body);
			i += body.length + 1;
		}
	}
	return bodies;
}

/**
 * The keys an object literal writes at its top level, those of the literals its
 * spreads may spread included. What a spread of anything else (`...patch`) or a
 * computed key writes cannot be read from the text, so it is `opaque`.
 */
function objectKeys(body: string): { keys: string[]; opaque: string[] } {
	const keys: string[] = [];
	const opaque: string[] = [];
	for (const segment of topLevelSegments(body)) {
		if (segment.startsWith("...")) {
			const literals = literalsIn(segment.slice(3));
			if (literals.length === 0) opaque.push(segment);
			for (const literal of literals) {
				const inner = objectKeys(literal);
				keys.push(...inner.keys);
				opaque.push(...inner.opaque);
			}
			continue;
		}
		if (segment.startsWith("[")) {
			opaque.push(segment);
			continue;
		}
		const key = segment.match(/^(?:"([^"]+)"|'([^']+)'|(\w+))/);
		if (key) keys.push(key[1] ?? key[2] ?? key[3]);
	}
	return { keys, opaque };
}

interface Violation {
	what: string;
}

/** What in `source` writes a kind table outside the engine. */
function findViolations(source: string, tables: KindTables): Violation[] {
	const violations: Violation[] = [];
	const name = (identifier: string) =>
		identifier.split(".").pop() ?? identifier;

	for (const match of source.matchAll(
		/\.update\(\s*([\w.]+)\s*\)\s*\.set\(\s*/g,
	)) {
		const table = name(match[1]);
		const lifecycle = tables.jobs.has(table)
			? JOB_LIFECYCLE_KEYS
			: tables.attempts.has(table)
				? ATTEMPT_LIFECYCLE_KEYS
				: null;
		if (!lifecycle) continue;
		const argumentAt = match.index + match[0].length;
		if (source[argumentAt] !== "{") {
			violations.push({
				what: `update(${table}).set(<not an object literal>): which columns it writes cannot be read`,
			});
			continue;
		}
		const { keys, opaque } = objectKeys(braceBody(source, argumentAt));
		const written = keys.filter((key) => lifecycle.has(key));
		if (written.length > 0) {
			violations.push({
				what: `update(${table}).set({ ${written.join(", ")} })`,
			});
		}
		if (opaque.length > 0) {
			violations.push({
				what: `update(${table}).set({ ${opaque.join(", ")} }): which columns it writes cannot be read`,
			});
		}
	}

	for (const match of source.matchAll(/\.insert\(\s*([\w.]+)\s*\)/g)) {
		const table = name(match[1]);
		if (tables.jobs.has(table) || tables.attempts.has(table)) {
			violations.push({ what: `insert(${table})` });
		}
	}

	const sqlNames = [...tables.jobs.values(), ...tables.attempts.values()];
	for (const sqlName of sqlNames) {
		const raw = new RegExp(
			`\\b(?:UPDATE|INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO)\\s+["\`]?${sqlName}["\`]?\\b`,
			"i",
		);
		const found = source.match(raw);
		if (found) violations.push({ what: `raw SQL: ${found[0]}` });
	}
	return violations;
}

function walk(dir: string, found: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry === ".svelte-kit") continue;
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) {
			if (path === ENGINE_DIR || entry === "testing") continue;
			walk(path, found);
		} else if (
			/\.(ts|svelte)$/.test(entry) &&
			!/\.test\.ts$/.test(entry) &&
			!/\.d\.ts$/.test(entry)
		) {
			found.push(path);
		}
	}
	return found;
}

/**
 * Every file the scan reads, relative to the repository root: the app and the
 * scripts beside it, which open the same database (the backfill, the seeds).
 */
function scannedFiles(): string[] {
	return [...walk(SRC), ...walk(SCRIPTS)].map((path) =>
		relative(ROOT, path).split(sep).join("/"),
	);
}

function scanTree(): Map<string, Violation[]> {
	const tables = discoverKindTables(readFileSync(SCHEMA, "utf8"));
	const result = new Map<string, Violation[]>();
	for (const file of scannedFiles()) {
		const violations = findViolations(
			readFileSync(join(ROOT, file), "utf8"),
			tables,
		);
		if (violations.length > 0) result.set(file, violations);
	}
	return result;
}

// ---------------------------------------------------------------------------
// The list of files that still write, and why
// ---------------------------------------------------------------------------

const ALLOWED: Record<string, string> = {
	"src/lib/server/services/atlas/research-job.ts":
		"Atlas's onTransition clears the pre-engine fence column worker_id and sets heartbeat_at to the transition's time on every transition, so a pre-engine Atlas process can never write but its boot recovery still finds a running row; it goes with the column cleanup.",
	"src/lib/server/services/extraction/job-ledger.ts":
		"Extraction's own ledger: it moves onto the engine in slice S3 and what is left is domain transitions only.",
	"src/lib/server/services/extraction/reextract.ts":
		"Re-extract requeues a settled job with SQL of its own: it becomes a `reopen` in slice S3.",
	"src/lib/server/services/file-production/job-ledger.ts":
		"File production's own ledger: it moves onto the engine in slice S4 and what is left is domain transitions only.",
	"src/lib/server/services/file-production/read-model.ts":
		"The legacy backfill inserts succeeded rows for chat files that predate the ledger: it becomes a born-succeeded `enqueue` in slice S4, or stays here by name if the backfill must keep its files' timestamps.",
	"src/lib/server/services/account-lifecycle/index.ts":
		"Account erasure's quiesce cancels extraction and file-production jobs with raw updates of its own: it becomes `cancelAll` in slices S3 and S4.",
	"src/lib/server/services/conversation-forks.ts":
		"Copies settled file-production job and job-file rows into a fork: a snapshot, not a transition. This one stays.",
	"scripts/seed-campaign-2-2.ts":
		"The 2.2 campaign's demo seed inserts a settled file-production row with fixed timestamps: slice S4 makes it a born-succeeded `enqueue` (its `now` sets the timestamps), or keeps it here by name with the reason.",
};

// ---------------------------------------------------------------------------

describe("the scan itself", () => {
	const tables = discoverKindTables("");

	it("finds a lifecycle write on a jobs table, however the table is reached", () => {
		for (const source of [
			`tx.update(fileProductionJobs).set({ status: "failed" })`,
			`await db.update(schema.documentExtractionJobs).set({ nextAttemptAt: null, updatedAt: now })`,
			`db.update(atlasJobs).set({ completedAt: now, ...rest })`,
			`tx.update(fileProductionJobs)\n\t.set({\n\t\tdismissed: false,\n\t\tstatus,\n\t})`,
		]) {
			expect(findViolations(source, tables), source).not.toEqual([]);
		}
	});

	it("leaves a domain write on a jobs table alone", () => {
		for (const source of [
			`tx.update(fileProductionJobs).set({ dismissed: true, updatedAt: now })`,
			`db.update(atlasJobs).set({ title, stage: "ask", progressPercent: 3 })`,
			`db.update(documentExtractionJobs).set({ hintsJson: null })`,
			`db.update(someOtherTable).set({ status: "x", errorCode: "y" })`,
		]) {
			expect(findViolations(source, tables), source).toEqual([]);
		}
	});

	it("finds a lifecycle write on an attempts table and leaves the kind's own columns alone", () => {
		expect(
			findViolations(
				`tx.update(documentExtractionJobAttempts).set({ heartbeatAt: now })`,
				tables,
			),
		).not.toEqual([]);
		expect(
			findViolations(
				`tx.update(fileProductionJobAttempts).set({ finishedAt: now, mode: "x" })`,
				tables,
			),
		).not.toEqual([]);
		expect(
			findViolations(
				`tx.update(documentExtractionJobAttempts).set({ extractor: "mineru", resumed: true, remoteHandleJson: h, textLength: 4, pageCount: 2 })`,
				tables,
			),
		).toEqual([]);
		expect(
			findViolations(
				`tx.update(fileProductionJobAttempts).set({ mode: "program", renderer: "docx", runtime: "node" })`,
				tables,
			),
		).toEqual([]);
	});

	it("finds an insert into either table, and leaves a delete alone", () => {
		expect(
			findViolations(`tx.insert(fileProductionJobs).values({ id })`, tables),
		).not.toEqual([]);
		expect(
			findViolations(`tx.insert(atlasJobAttempts).values(row)`, tables),
		).not.toEqual([]);
		expect(
			findViolations(`tx.delete(fileProductionJobs).where(eq(a, b))`, tables),
		).toEqual([]);
	});

	it("finds raw SQL that updates or inserts", () => {
		for (const source of [
			`sqlite.prepare("UPDATE document_extraction_jobs SET status = 'canceled'")`,
			"sql`update file_production_jobs set status = 'failed'`",
			`db.run(sql\`INSERT INTO atlas_jobs (id) VALUES (1)\`)`,
			`"INSERT OR IGNORE INTO atlas_job_attempts"`,
		]) {
			expect(findViolations(source, tables), source).not.toEqual([]);
		}
		expect(
			findViolations(
				`"SELECT * FROM atlas_jobs WHERE status = 'running'"`,
				tables,
			),
		).toEqual([]);
	});

	it("learns a table built with the column builders from the schema", () => {
		const discovered = discoverKindTables(`
export const widgetJobs = sqliteTable(
	"widget_jobs",
	{
		...jobColumns({ userId: () => users.id }),
		note: text("note"),
	},
);
export const widgetJobAttempts = sqliteTable(
	"widget_job_attempts",
	{ ...jobAttemptColumns({ jobId: () => widgetJobs.id }) },
);
export const unrelated = sqliteTable("unrelated", { id: text("id") });
`);
		expect(discovered.jobs.get("widgetJobs")).toBe("widget_jobs");
		expect(discovered.attempts.get("widgetJobAttempts")).toBe(
			"widget_job_attempts",
		);
		expect(discovered.jobs.has("unrelated")).toBe(false);
		expect(
			findViolations(`tx.update(widgetJobs).set({ status: "x" })`, discovered),
		).not.toEqual([]);
	});

	it("reads the keys a conditional spread may write", () => {
		// The ledgers write this shape all the time; a lifecycle key inside it is
		// as much a write as one at the top level.
		expect(
			findViolations(
				`tx.update(atlasJobs).set({ updatedAt: now, ...(failed ? { status: "failed" } : {}) })`,
				tables,
			),
		).not.toEqual([]);
		expect(
			findViolations(
				`tx.update(fileProductionJobAttempts).set({ mode: "x", ...(warnings ? { diagnosticsJson: w } : {}) })`,
				tables,
			),
		).not.toEqual([]);
		expect(
			findViolations(
				`tx.update(atlasJobs).set({ title, ...(stage !== undefined ? { stage, meta: { status: 1 } } : {}) })`,
				tables,
			),
		).toEqual([]);
	});

	it("says what it cannot see: a spread of a variable, a computed key, a set of a variable", () => {
		for (const source of [
			`tx.update(fileProductionJobs).set({ ...patch, updatedAt: now })`,
			`tx.update(fileProductionJobs).set({ [column]: value })`,
			`tx.update(documentExtractionJobs).set(patch)`,
			`tx.update(atlasJobs)\n\t.set(\n\t\tbuildPatch(row),\n\t)`,
		]) {
			expect(findViolations(source, tables), source).not.toEqual([]);
		}
	});

	it("reads the scripts as well as the app: a script is a writer too", () => {
		expect(scannedFiles()).toContain("scripts/backfill-extractions.ts");
		expect(scannedFiles()).toContain("src/lib/server/services/projects.ts");
	});

	it("reads the object it is looking at and not what follows it", () => {
		expect(
			findViolations(
				`tx.update(fileProductionJobs).set({ dismissed: true }); other({ status: 1 })`,
				tables,
			),
		).toEqual([]);
		expect(
			findViolations(
				`tx.update(fileProductionJobs).set({ note: \`}status: x\`, dismissed: true })`,
				tables,
			),
		).toEqual([]);
	});
});

describe("one writer of a kind's lifecycle columns", () => {
	const found = scanTree();

	it("is the engine: no file outside services/jobs/ writes one, but those listed", () => {
		const unexpected = [...found.entries()]
			.filter(([file]) => !(file in ALLOWED))
			.map(
				([file, violations]) =>
					`${file}: ${violations.map((v) => v.what).join("; ")}`,
			);

		expect(
			unexpected,
			"These files write a kind's lifecycle columns. Route the write through the engine (src/lib/server/services/jobs), or add the file to ALLOWED with the reason it is an exception.",
		).toEqual([]);
	});

	it("lists only files that still do, so the list can only shrink", () => {
		const stale = Object.keys(ALLOWED).filter((file) => !found.has(file));

		expect(
			stale,
			"These ALLOWED entries no longer write a lifecycle column. Remove them.",
		).toEqual([]);
	});

	it("gives every exception a reason", () => {
		for (const [file, reason] of Object.entries(ALLOWED)) {
			expect(reason.trim().length, file).toBeGreaterThan(10);
		}
	});
});
