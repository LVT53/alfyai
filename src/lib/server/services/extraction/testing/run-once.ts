// Runs the extraction kind over a test's database and says which job ran.
//
// The worker this replaced had `executeNextExtractionJob`, which took its
// extractor and its indexing step as arguments and answered `{ jobId, status }`
// for the one job it ran, or null for none. The job engine runs every claimable
// job (`drain`) and answers nothing, so a test that wants the old shape asks here:
// the seams are laid over the real modules for the length of the run
// (`runner-seams.ts`), and the job that ran is the one whose attempt count grew.
//
// The status is the DTO's word for the job as it ended: the engine stores five
// (`running` is a phase, `cancelled` has two l's) and every test of the sequences a
// user lives through reads the browser's vocabulary.

import type Database from "better-sqlite3";
import type { DocumentExtractionStatus } from "$lib/shared/extraction-status";
import type { DocumentExtractor } from "../contracts";
import type { DocumentExtractionIntakeRoute } from "../types";
import { installSeams, type RunnerSeams, seams } from "./runner-seams";

export interface RunOnceOptions {
	resolveExtractor?: (
		route: DocumentExtractionIntakeRoute,
	) => DocumentExtractor;
	/** The indexing step; the real one when omitted. */
	persistResult?: NonNullable<RunnerSeams["persist"]>;
	/** Config laid over the real one for this run (`heartbeatMs`, `maxConcurrency`…). */
	config?: Record<string, unknown>;
}

export interface RunOnceResult {
	jobId: string;
	status: DocumentExtractionStatus;
}

interface JobRow {
	id: string;
	status: string;
	phase: string | null;
	attempt_count: number;
}

function dtoWord(row: JobRow): DocumentExtractionStatus {
	if (row.status === "cancelled") return "canceled";
	if (row.status === "running") {
		return (row.phase ?? "uploading") as DocumentExtractionStatus;
	}
	return row.status as DocumentExtractionStatus;
}

export async function runExtractionOnce(
	sqlite: Database.Database,
	options: RunOnceOptions = {},
): Promise<RunOnceResult | null> {
	await installSeams();
	const jobs = () =>
		sqlite
			.prepare(
				"SELECT id, status, phase, attempt_count FROM document_extraction_jobs",
			)
			.all() as JobRow[];
	const before = new Map(jobs().map((row) => [row.id, row.attempt_count]));

	const saved = {
		resolveExtractor: seams.resolveExtractor,
		persist: seams.persist,
		config: seams.config,
	};
	if (options.resolveExtractor)
		seams.resolveExtractor = options.resolveExtractor;
	if (options.persistResult) seams.persist = options.persistResult;
	if (options.config) seams.config = { ...seams.config, ...options.config };
	try {
		const { drain } = await import("$lib/server/services/jobs");
		const { extractionJob } = await import("../extraction-job");
		await drain(extractionJob);
	} finally {
		seams.resolveExtractor = saved.resolveExtractor;
		seams.persist = saved.persist;
		seams.config = saved.config;
	}

	const ran = jobs().filter(
		(row) => row.attempt_count > (before.get(row.id) ?? 0),
	);
	if (ran.length === 0) return null;
	if (ran.length > 1) {
		throw new Error(
			`runExtractionOnce: ${ran.length} jobs ran where the test expected one.`,
		);
	}
	return { jobId: ran[0].id, status: dtoWord(ran[0]) };
}
