// `defineJobKind`: where a kind's definition meets the engine.
//
// A kind is defined once, in its own folder, and everything else in the engine
// takes the opaque handle this returns. The handle carries the definition and
// the kind's two tables, typed as the lifecycle SHAPE (`columns.ts`): a kind's
// real tables have more columns and other names, so none is assignable to
// another, and the cast from a kind's tables to the shape is made here, once,
// instead of in every query. Drizzle renders SQL from the runtime column
// objects, so the kind's own SQL names are what reaches SQLite.

import { getTableColumns, getTableName } from "drizzle-orm";
import {
	type AttemptShape,
	JOB_ATTEMPT_PROPERTIES,
	JOB_LIFECYCLE_PROPERTIES,
	type JobShape,
} from "./columns";
import type {
	JobAttemptTable,
	JobHandler,
	JobKind,
	JobKindDefinition,
	JobTable,
} from "./types";

/** The definition as the engine reads it: rows typed as the lifecycle shape. */
export type EngineDefinition = JobKindDefinition<JobShape, AttemptShape>;

export interface KindInternals {
	definition: EngineDefinition;
	jobs: JobShape;
	attempts: AttemptShape;
	/** The handler once it has been asked for, so a read path never imports it. */
	handler: Promise<JobHandler<JobShape>> | null;
}

// On the handle under a `Symbol.for` key and not in a module-level map: a
// handle made by one evaluation of this file must be readable by another's.
const INTERNALS = Symbol.for("alfyai.jobs.kind");

/**
 * Which SQL table each kind name was defined over, for the duplicate check.
 * A name belongs to one table. The same name over the same table again is a
 * module being re-evaluated (HMR re-runs the file that defines a kind while this
 * one stays put) and is a redefinition, not a clash.
 */
const tableOfKind = new Map<string, string>();

/** Worker ids are colon-separated, so a colon in a name would shift every field. */
const KIND_NAME = /^[a-z][a-z0-9-]*$/;

function checkProperties(
	kindName: string,
	label: string,
	table: object,
	properties: readonly string[],
): void {
	const columns = getTableColumns(table as JobShape);
	const missing = properties.filter((property) => !(property in columns));
	if (missing.length > 0) {
		throw new Error(
			`Job kind "${kindName}": the ${label} table lacks ${missing.join(", ")}. Build it with ${label === "jobs" ? "jobColumns()" : "jobAttemptColumns()"}.`,
		);
	}
}

export function defineJobKind<J extends JobTable, A extends JobAttemptTable>(
	definition: JobKindDefinition<J, A>,
): JobKind<J> {
	const name = definition.name;
	if (typeof name !== "string" || !KIND_NAME.test(name)) {
		throw new Error(
			`Job kind name "${String(name)}" must be lower-case letters, digits and hyphens: it is part of every worker id.`,
		);
	}
	if (typeof definition.logPrefix !== "string" || !definition.logPrefix) {
		throw new Error(`Job kind "${name}" needs a logPrefix.`);
	}
	if (typeof definition.handler !== "function") {
		throw new Error(`Job kind "${name}" needs a handler.`);
	}
	if (typeof definition.onFailure !== "function") {
		throw new Error(
			`Job kind "${name}" needs onFailure: every failure goes through it.`,
		);
	}
	for (const method of ["enabled", "limits", "lease", "lostAttempt"] as const) {
		if (typeof definition[method] !== "function") {
			throw new Error(`Job kind "${name}" needs ${method}().`);
		}
	}
	if (definition.phases) {
		const seen = new Set<string>();
		for (const phase of definition.phases) {
			if (seen.has(phase)) {
				throw new Error(
					`Job kind "${name}" lists the phase "${phase}" twice (duplicate).`,
				);
			}
			seen.add(phase);
		}
	}

	checkProperties(
		name,
		"jobs",
		definition.tables.jobs,
		JOB_LIFECYCLE_PROPERTIES,
	);
	checkProperties(
		name,
		"attempts",
		definition.tables.attempts,
		JOB_ATTEMPT_PROPERTIES,
	);

	const tableName = getTableName(definition.tables.jobs);
	const existing = tableOfKind.get(name);
	if (existing !== undefined && existing !== tableName) {
		throw new Error(
			`Job kind "${name}" is already defined over ${existing}; it cannot also be ${tableName} (another kind has that name).`,
		);
	}
	tableOfKind.set(name, tableName);

	const internals: KindInternals = {
		// Kept by reference, not copied: the kind's switches are functions the
		// engine calls fresh each time, and a test changes them in place.
		definition: definition as unknown as EngineDefinition,
		jobs: definition.tables.jobs as unknown as JobShape,
		attempts: definition.tables.attempts as unknown as AttemptShape,
		handler: null,
	};

	const kind = { name, logPrefix: definition.logPrefix };
	Object.defineProperty(kind, INTERNALS, { value: internals });
	return kind as JobKind<J>;
}

/** What the engine knows of a kind. Throws for anything `defineJobKind` did not make. */
export function internalsOf(kind: JobKind): KindInternals {
	const internals = (kind as { [INTERNALS]?: KindInternals } | null)?.[
		INTERNALS
	];
	if (!internals) {
		throw new Error("Not a job kind: pass the value defineJobKind returned.");
	}
	return internals;
}

/**
 * The kind's handler, loaded on first use. A load that failed is forgotten, so
 * the next claim tries again instead of failing every job until a restart.
 */
export function loadHandler(
	internals: KindInternals,
): Promise<JobHandler<JobShape>> {
	if (!internals.handler) {
		const loading = Promise.resolve().then(() =>
			internals.definition.handler(),
		);
		internals.handler = loading;
		loading.catch(() => {
			if (internals.handler === loading) internals.handler = null;
		});
	}
	return internals.handler;
}
