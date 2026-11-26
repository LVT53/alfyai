import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type MemoryKind,
	type MemoryScope,
	type MemorySubject,
	PERSONAL_MEMORY_SUBJECTS,
	PROJECT_MEMORY_SUBJECTS,
} from "$lib/memory-types";
import { bootEngine, type EngineHarness } from "../jobs/testing/harness";
import type { CurationModel } from "./curation";
import { seedSubjectEntries } from "./subject-read.test-helpers";

let h: EngineHarness;
beforeEach(async () => {
	h = await bootEngine("memory-delivery");
});
afterEach(() => {
	vi.restoreAllMocks();
	h.cleanup();
});

const NOW = new Date("2026-11-26T12:00:00Z");
const DAY = 86_400_000;
/** In every seeded text, so a report that carried any of them would show it. */
const MARKER = "zzquokka";

const plusDays = (iso: string, days: number) =>
	new Date(new Date(iso).getTime() + days * DAY);
const factText = (id: string) => `${MARKER} fact ${id}`;
/**
 * The context the ChatGPT import records for a message (`imported-history.ts`):
 * it always carries `migrationImported: true`.
 */
const importedContext = (said: string) =>
	JSON.stringify({
		migration: true,
		migrationMessageAt: said,
		migrationDefaultHistory: false,
		migrationImported: true,
		messages: [
			{ id: "q7-m", role: "user", sourceId: "$current", textHash: "q7-h" },
		],
	});
/**
 * What preparation (`migration.ts`) records for the person's own earlier chat:
 * the same event ids, and no `migrationImported`.
 */
const historyContext = (said: string) =>
	JSON.stringify({
		migration: true,
		migrationMessageAt: said,
		migrationDefaultHistory: false,
		messages: [
			{ id: "q7-m", role: "user", sourceId: "$current", textHash: "q7-h" },
		],
	});
/** A message of exactly this many characters, marker first. */
const messageText = (characters: number) =>
	`${MARKER} `.padEnd(characters, "x");

/** The cells of a bucket table that are not zero, so an expectation names only what is there. */
function nonZero(record: Record<string, number>): Record<string, number> {
	return Object.fromEntries(Object.entries(record).filter(([, n]) => n > 0));
}
/** A length-by-facts table as `"<100 x 4-5": 1` cells. */
function cells(byLength: Record<string, Record<string, number>>) {
	return nonZero(
		Object.fromEntries(
			Object.entries(byLength).flatMap(([length, facts]) =>
				Object.entries(facts).map(([bucket, n]) => [
					`${length} x ${bucket}`,
					n,
				]),
			),
		),
	);
}

async function world() {
	const { db } = await import("$lib/server/db");
	const s = await import("$lib/server/db/schema");
	const { eq } = await import("drizzle-orm");
	const { ensureMemoryBank } = await import("./revisions");
	const quality = await import("./quality-report");
	/** Every id seeded, to prove none reaches a report. */
	const seeded: string[] = [];

	function project(userId: string, id: string) {
		db.insert(s.projects)
			.values({ id, userId, name: "Synthetic project" })
			.run();
	}
	function bank(
		userId: string,
		scope: MemoryScope = { kind: "personal" },
		status = "ready",
	) {
		const created = ensureMemoryBank(userId, scope);
		db.update(s.memoryAccounts)
			.set({ authority: "hindsight" })
			.where(eq(s.memoryAccounts.userId, userId))
			.run();
		db.update(s.memoryBanks)
			.set({ generation: "g1", status })
			.where(eq(s.memoryBanks.id, created.id))
			.run();
		seeded.push(userId, created.id);
		return created.id;
	}
	function source(input: {
		userId: string;
		bankId: string;
		id: string;
		eventId: string;
		state?: string;
		characters: number;
		said: string;
		facts?: string[];
		epoch?: number;
		context?: string;
	}) {
		const facts = input.facts ?? [];
		seeded.push(input.id, ...facts);
		db.insert(s.memorySourceRevisions)
			.values({
				id: input.id,
				bankId: input.bankId,
				userId: input.userId,
				epoch: input.epoch ?? 0,
				eventId: input.eventId,
				lineageId: `lineage-${input.id}`,
				text: messageText(input.characters),
				context: input.context ?? "",
				textHash: `hash-${input.id}`,
				assertedAt: new Date(input.said),
				acknowledgedFactsJson: JSON.stringify(
					facts.map((id) => ({ id, text: factText(id) })),
				),
				state: input.state ?? "accepted",
			})
			.run();
	}
	function entry(input: {
		bankId: string;
		id: string;
		text: string;
		facts: string[];
	}) {
		seeded.push(input.id);
		db.insert(s.memoryPublishedRows)
			.values({
				id: `row-${input.id}`,
				bankId: input.bankId,
				generation: "g1",
				epoch: 0,
				nativeId: input.id,
				text: input.text,
				nativeText: input.text,
				sourceIdsJson: JSON.stringify(input.facts),
				sourceFingerprintsJson: JSON.stringify(
					input.facts.map((id) => ({ id, text: factText(id) })),
				),
				updatedAt: NOW,
			})
			.run();
	}
	function label(
		bankId: string,
		factId: string,
		fields: { kind?: MemoryKind; subject?: MemorySubject; eventAt?: Date },
	) {
		db.insert(s.memoryFactLabels)
			.values({
				bankId,
				nativeFactId: factId,
				kind: fields.kind ?? null,
				subject: fields.subject ?? null,
				origin: "extraction",
				eventAt: fields.eventAt ?? null,
			})
			.run();
	}
	function job(input: {
		userId: string;
		bankId: string;
		id: string;
		status: string;
		code?: string;
		kind?: string;
		completed?: string;
		attempts?: { start: string; seconds: number | null }[];
	}) {
		seeded.push(input.id);
		db.insert(s.memoryDeliveryJobs)
			.values({
				id: input.id,
				userId: input.userId,
				bankId: input.bankId,
				epoch: 0,
				kind: input.kind ?? "source",
				requestId: `request-${input.id}`,
				status: input.status,
				errorCode: input.code ?? null,
				completedAt: input.completed ? new Date(input.completed) : null,
				createdAt: new Date("2026-11-25T09:00:00Z"),
				updatedAt: new Date("2026-11-25T09:00:00Z"),
			})
			.run();
		(input.attempts ?? []).forEach((attempt, index) => {
			const start = new Date(attempt.start);
			db.insert(s.memoryDeliveryAttempts)
				.values({
					id: `${input.id}-attempt-${index + 1}`,
					jobId: input.id,
					attemptNumber: index + 1,
					status: "succeeded",
					claimedAt: start,
					finishedAt:
						attempt.seconds === null
							? null
							: new Date(start.getTime() + attempt.seconds * 1000),
				})
				.run();
		});
	}
	/**
	 * Succeeded jobs, given in completion order, each with the seconds its
	 * attempts ran. Their ids run the other way and they are written in a third
	 * order, so neither the id nor the row order can pass for completion order.
	 */
	function succeededJobs(
		userId: string,
		bankId: string,
		prefix: string,
		attemptSeconds: number[][],
	) {
		const written = attemptSeconds
			.map((_, index) => index)
			.sort((a, b) => ((a * 7) % 11) - ((b * 7) % 11));
		for (const index of written) {
			const seconds = attemptSeconds[index];
			const completed = new Date(Date.UTC(2026, 10, 25, 10, index));
			job({
				userId,
				bankId,
				id: `${prefix}-${attemptSeconds.length - 1 - index}`,
				status: "succeeded",
				completed: completed.toISOString(),
				attempts: seconds.map((ran, attempt) => ({
					start: new Date(
						completed.getTime() - (attempt + 1) * 3_600_000,
					).toISOString(),
					seconds: ran,
				})),
			});
		}
	}

	/**
	 * The synthetic account every number below is worked out from: a personal
	 * bank with imported, history, live and note messages (accepted and not),
	 * nine entries over their facts, a project bank with two more, and
	 * fourteen source jobs.
	 */
	function seedMain(userId: string) {
		const personal = bank(userId);
		project(userId, "q7-project");
		const projectBank = bank(userId, {
			kind: "project",
			projectId: "q7-project",
		});
		const imported = (
			id: string,
			extra: Partial<Parameters<typeof source>[0]> & { said: string },
		) =>
			source({
				userId,
				bankId: personal,
				id: `q7-s-${id}`,
				eventId: `migration-message:${id}`,
				characters: 100,
				context: importedContext(extra.said),
				...extra,
			});
		imported("ia", {
			characters: 50,
			said: "2026-03-01T00:00:00Z",
			facts: ["q7-f01", "q7-f02", "q7-f03", "q7-f04"],
		});
		imported("ib", {
			characters: 150,
			said: "2026-03-02T00:00:00Z",
			facts: ["q7-f05"],
		});
		imported("ic", {
			characters: 5000,
			said: "2026-03-03T00:00:00Z",
			facts: [
				"q7-f06",
				"q7-f07",
				"q7-f08",
				"q7-f09",
				"q7-f10",
				"q7-f11",
				"q7-f12",
			],
		});
		imported("id", { characters: 20, said: "2026-03-04T00:00:00Z" });
		imported("ie", {
			state: "pending",
			characters: 500,
			said: "2026-03-05T00:00:00Z",
		});
		imported("if", {
			state: "staged",
			characters: 400,
			said: "2026-03-06T00:00:00Z",
			facts: ["q7-f13"],
		});
		imported("ig", {
			state: "revoked",
			characters: 400,
			said: "2026-03-07T00:00:00Z",
			facts: ["q7-f14"],
		});
		// The person's own earlier chats, recorded under the same event ids but
		// without the import's mark: history, not imported.
		const history = (
			id: string,
			extra: Partial<Parameters<typeof source>[0]> & { said: string },
		) =>
			source({
				userId,
				bankId: personal,
				id: `q7-s-${id}`,
				eventId: `migration-message:${id}`,
				characters: 120,
				context: historyContext(extra.said),
				...extra,
			});
		history("ha", {
			said: "2026-03-10T00:00:00Z",
			facts: ["q7-h01", "q7-h02"],
		});
		history("hb", { state: "pending", said: "2026-03-11T00:00:00Z" });
		const live = (
			id: string,
			bankId: string,
			characters: number,
			said: string,
			facts: string[],
		) =>
			source({
				userId,
				bankId,
				id: `q7-s-${id}`,
				eventId: `message:${id}`,
				characters,
				said,
				facts,
			});
		live("la", personal, 99, "2026-11-20T09:00:00Z", ["q7-f20", "q7-f21"]);
		live("lb", personal, 100, "2026-11-21T09:00:00Z", ["q7-f22"]);
		live("lc", personal, 400, "2026-10-10T00:00:00Z", ["q7-f24"]);
		source({
			userId,
			bankId: personal,
			id: "q7-s-na",
			eventId: "manual:na",
			characters: 300,
			said: "2026-01-01T00:00:00Z",
			facts: ["q7-f23"],
		});
		source({
			userId,
			bankId: personal,
			id: "q7-s-da",
			eventId: "dependency:job:da",
			state: "repair_held",
			characters: 80,
			said: "2026-11-23T09:00:00Z",
		});
		live(
			"p1",
			projectBank,
			200,
			"2026-11-24T09:00:00Z",
			Array.from(
				{ length: 10 },
				(_, i) => `q7-p${String(i + 1).padStart(2, "0")}`,
			),
		);
		live("p2", projectBank, 120, "2026-11-25T09:00:00Z", ["q7-p11"]);

		// Each imported fact's event date, a set number of days from its message.
		const ia = "2026-03-01T00:00:00Z";
		const ib = "2026-03-02T00:00:00Z";
		const ic = "2026-03-03T00:00:00Z";
		label(personal, "q7-f01", { kind: "lasting", subject: "about_you" });
		// q7-f02 has no label row at all.
		label(personal, "q7-f03", {
			kind: "ongoing",
			subject: "projects",
			eventAt: plusDays(ia, 1),
		});
		label(personal, "q7-f04", {
			kind: "temporary",
			subject: "health",
			eventAt: plusDays(ia, 2),
		});
		label(personal, "q7-f05", {
			kind: "temporary",
			subject: "health",
			eventAt: plusDays(ib, 31),
		});
		label(personal, "q7-f06", {
			kind: "temporary",
			subject: "health",
			eventAt: plusDays(ic, 366),
		});
		label(personal, "q7-f07", {
			kind: "lasting",
			subject: "home_family",
			eventAt: plusDays(ic, -1),
		});
		for (const [fact, days] of [
			["q7-f08", -2],
			["q7-f09", -31],
			["q7-f10", -366],
			["q7-f11", 30],
			["q7-f12", 365],
		] as const)
			label(personal, fact, {
				kind: "temporary",
				subject: "home_family",
				eventAt: plusDays(ic, days),
			});
		// Facts of messages that are not accepted: never counted.
		label(personal, "q7-f13", {
			eventAt: plusDays("2026-03-06T00:00:00Z", 400),
		});
		label(personal, "q7-f14", {
			eventAt: plusDays("2026-03-07T00:00:00Z", 400),
		});
		// A history fact's date is not an imported fact's: never in the dates.
		label(personal, "q7-h01", {
			kind: "lasting",
			subject: "interests",
			eventAt: plusDays("2026-03-10T00:00:00Z", 400),
		});
		label(personal, "q7-f20", { kind: "lasting", subject: "about_you" });
		label(personal, "q7-f23", { kind: "temporary", subject: "interests" });
		label(personal, "q7-f24", { kind: "ongoing", subject: "work_study" });
		label(projectBank, "q7-p01", { kind: "ongoing", subject: "plans_status" });
		label(projectBank, "q7-p11", { kind: "lasting", subject: "health" });

		const entries: [string, string, string[]][] = [
			[
				"q7-e1",
				"zzquokka plays the cello in an amateur orchestra",
				["q7-f01", "q7-f02"],
			],
			["q7-e2", "zzquokka is building a small budgeting app", ["q7-f03"]],
			[
				"q7-e3",
				"zzquokka has a mild peanut allergy",
				["q7-f04", "q7-f05", "q7-f06"],
			],
			[
				"q7-e4",
				"zzquokka lives in a flat near the river",
				["q7-f07", "q7-f08", "q7-f09", "q7-f10", "q7-f11"],
			],
			// Same words as the next one: exact duplicates.
			[
				"q7-e5",
				"Zzquokka drinks green tea every morning.",
				["q7-f20", "q7-f21"],
			],
			["q7-e6", "zzquokka drinks GREEN tea, every morning", ["q7-f22"]],
			// One word apart: near duplicates.
			[
				"q7-e7",
				"zzquokka keeps a vegetable garden behind the house",
				["q7-f23"],
			],
			[
				"q7-e8",
				"zzquokka keeps a vegetable garden behind the old house",
				["q7-f24"],
			],
			// Rests on history facts only: not an entry from the import.
			[
				"q7-e9",
				"zzquokka reads detective novels on the train",
				["q7-h01", "q7-h02"],
			],
		];
		for (const [id, text, facts] of entries)
			entry({ bankId: personal, id, text, facts });
		entry({
			bankId: projectBank,
			id: "q7-pe1",
			text: "zzquokka project kickoff is planned for spring",
			facts: Array.from(
				{ length: 10 },
				(_, i) => `q7-p${String(i + 1).padStart(2, "0")}`,
			),
		});
		// Two words: too short for the near comparison.
		entry({
			bankId: projectBank,
			id: "q7-pe2",
			text: "zzquokka vegan",
			facts: ["q7-p11"],
		});

		// Ten succeeded jobs in completion order (a job's time is the sum of its
		// attempts), then one of every other kind of source job. A job of another
		// kind is not counted.
		succeededJobs(userId, personal, "q7-j", [
			[10],
			[20],
			[12, 18],
			[40],
			[50],
			[60],
			[70],
			[80],
			[90],
			[60, 40],
		]);
		job({
			userId,
			bankId: personal,
			id: "q7-j-failed",
			status: "failed",
			code: "memory_candidate_unaccepted",
			completed: "2026-11-25T11:00:00Z",
			attempts: [{ start: "2026-11-25T10:55:00Z", seconds: 30 }],
		});
		job({
			userId,
			bankId: personal,
			id: "q7-j-waiting",
			status: "queued",
			code: "native_retain_waiting",
			attempts: [{ start: "2026-11-25T10:50:00Z", seconds: 300 }],
		});
		job({ userId, bankId: personal, id: "q7-j-queued", status: "queued" });
		job({
			userId,
			bankId: personal,
			id: "q7-j-running",
			status: "running",
			attempts: [{ start: "2026-11-25T11:30:00Z", seconds: null }],
		});
		job({
			userId,
			bankId: personal,
			id: "q7-j-action",
			kind: "action",
			status: "succeeded",
			completed: "2026-11-25T11:00:00Z",
			attempts: [{ start: "2026-11-25T10:00:00Z", seconds: 999 }],
		});
		return { personal, projectBank };
	}

	/**
	 * A small native account: `entries` entries each over a fact of its own, the
	 * first `imported` of them from imported messages and the rest from live
	 * ones, and succeeded jobs in the order given.
	 */
	function seedSmall(
		userId: string,
		spec: { imported: number; live: number; jobs: number[] },
	) {
		const personal = bank(userId);
		for (let i = 0; i < spec.imported + spec.live; i++) {
			const imported = i < spec.imported;
			const fact = `q7-${userId}-fact-${i}`;
			source({
				userId,
				bankId: personal,
				id: `q7-${userId}-source-${i}`,
				eventId: `${imported ? "migration-message" : "message"}:${userId}:${i}`,
				characters: 150,
				said: "2026-11-01T00:00:00Z",
				facts: [fact],
				...(imported
					? { context: importedContext("2026-11-01T00:00:00Z") }
					: {}),
			});
			entry({
				bankId: personal,
				id: `q7-${userId}-entry-${i}`,
				text: `${MARKER} ${userId} remembers separate thing number ${"x".repeat(i + 1)}`,
				facts: [fact],
			});
		}
		succeededJobs(
			userId,
			personal,
			`q7-${userId}-job`,
			spec.jobs.map((seconds) => [seconds]),
		);
		return personal;
	}

	return {
		db,
		s,
		eq,
		quality,
		seeded,
		project,
		bank,
		source,
		entry,
		label,
		job,
		seedMain,
		seedSmall,
		importedContext,
		historyContext,
	};
}

describe("the numbers of a seeded account", () => {
	it("counts messages, deliveries, entries, dates and jobs as worked out by hand", async () => {
		const w = await world();
		w.seedMain(h.userId);
		const report = w.quality.measureMemoryQuality({
			userId: h.userId,
			now: NOW,
		});

		expect(report.measuredAt).toBe("2026-11-26T12:00:00.000Z");
		// The time the reads took, in whole milliseconds.
		expect(Number.isInteger(report.readMs)).toBe(true);
		expect(report.readMs).toBeGreaterThanOrEqual(0);
		expect(report.banks).toEqual({ personal: 1, project: 1, skipped: 0 });

		// Messages by origin and state, every bank of the account. The person's
		// own earlier chats share the import's event ids but are history.
		expect(report.messages).toEqual({
			imported: {
				total: 7,
				byState: { accepted: 4, pending: 1, revoked: 1, staged: 1 },
			},
			history: { total: 2, byState: { accepted: 1, pending: 1 } },
			live: { total: 5, byState: { accepted: 5 } },
			note: { total: 1, byState: { accepted: 1 } },
			other: { total: 1, byState: { repair_held: 1 } },
		});

		// Delivered messages: facts per message, crossed with the message's length.
		const { delivered } = report;
		expect(delivered.imported.messages).toBe(4);
		expect(delivered.imported.facts).toBe(12);
		expect(nonZero(delivered.imported.factsPerMessage)).toEqual({
			"0": 1,
			"1": 1,
			"4-5": 1,
			"6+": 1,
		});
		expect(cells(delivered.imported.byLength)).toEqual({
			"<100 x 0": 1,
			"<100 x 4-5": 1,
			"100-299 x 1": 1,
			"3000-7999 x 6+": 1,
		});
		expect(delivered.history.messages).toBe(1);
		expect(delivered.history.facts).toBe(2);
		expect(cells(delivered.history.byLength)).toEqual({ "100-299 x 2": 1 });
		expect(delivered.live.messages).toBe(5);
		expect(delivered.live.facts).toBe(15);
		expect(nonZero(delivered.live.factsPerMessage)).toEqual({
			"1": 3,
			"2": 1,
			"6+": 1,
		});
		// 99 characters is under 100, 100 is not.
		expect(cells(delivered.live.byLength)).toEqual({
			"<100 x 2": 1,
			"100-299 x 1": 2,
			"100-299 x 6+": 1,
			"300-999 x 1": 1,
		});
		expect(delivered.note.messages).toBe(1);
		expect(delivered.note.facts).toBe(1);
		expect(cells(delivered.note.byLength)).toEqual({ "300-999 x 1": 1 });
		expect(delivered.other.messages).toBe(0);

		// Entries per bank kind. The ninth rests on history facts only, which are
		// not the import's, so four of the nine are from the import.
		const personal = report.entries.personal;
		expect(personal.total).toBe(9);
		expect(personal.withImportedFact).toBe(4);
		expect(personal.withoutImportedFact).toBe(5);
		expect(nonZero(personal.supportingFacts)).toEqual({
			"1": 4,
			"2": 3,
			"3-4": 1,
			"5-9": 1,
		});
		expect(personal.kind).toEqual({
			lasting: 4,
			ongoing: 2,
			temporary: 2,
			unlabelled: 1,
		});
		// An ongoing entry last said in March is Earlier, one said in October is
		// quiet, a note never ages, and a temporary entry whose event is still
		// ahead is current.
		expect(personal.timeState).toEqual({ current: 7, quiet: 1, earlier: 1 });
		expect(personal.subject).toEqual({
			about_you: 2,
			home_family: 1,
			work_study: 1,
			health: 1,
			projects: 1,
			interests: 2,
			other: 1,
		});
		expect(personal.duplicates).toEqual({
			exactEntries: 2,
			exactGroups: 1,
			nearPairs: 1,
			nearEntries: 2,
			tooShortToCompare: 0,
		});
		const project = report.entries.project;
		expect(project.total).toBe(2);
		expect(project.withImportedFact).toBe(0);
		expect(project.withoutImportedFact).toBe(2);
		expect(nonZero(project.supportingFacts)).toEqual({ "1": 1, "10+": 1 });
		expect(project.kind).toEqual({
			lasting: 1,
			ongoing: 1,
			temporary: 0,
			unlabelled: 0,
		});
		expect(project.timeState).toEqual({ current: 2, quiet: 0, earlier: 0 });
		// A personal subject on a project entry reads as other.
		expect(project.subject).toEqual({
			goals_decisions: 0,
			people: 0,
			facts_figures: 0,
			plans_status: 1,
			other: 1,
		});
		expect(project.duplicates).toEqual({
			exactEntries: 0,
			exactGroups: 0,
			nearPairs: 0,
			nearEntries: 0,
			tooShortToCompare: 1,
		});

		// Dates of the ChatGPT-imported facts of accepted messages only: a history
		// fact labelled 400 days on (q7-h01) is not among them.
		expect(nonZero(report.importedFactDates)).toEqual({
			no_date: 2,
			within_a_day: 2,
			later_2_30_days: 2,
			later_31_365_days: 2,
			later_over_a_year: 1,
			earlier_2_30_days: 1,
			earlier_31_365_days: 1,
			earlier_over_a_year: 1,
		});

		// The account's source jobs.
		const { process: health } = report;
		expect(health.sourceJobs).toBe(14);
		expect(health.byStatus).toEqual({
			failed: 1,
			queued: 2,
			running: 1,
			succeeded: 10,
		});
		expect(health.byStatusAndCode).toEqual({
			failed: { memory_candidate_unaccepted: 1 },
			queued: { native_retain_waiting: 1, none: 1 },
			running: { none: 1 },
			succeeded: { none: 10 },
		});
		expect(health.deliverySeconds.overall).toEqual({
			jobs: 10,
			medianSeconds: 55,
			p90Seconds: 90,
		});
		expect(health.deliverySeconds.perTenth).toEqual(
			[10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((seconds) => ({
				jobs: 1,
				medianSeconds: seconds,
				p90Seconds: seconds,
			})),
		);
	});

	it("reports the time its reads took, per account and summed over a baseline's accounts, not the counting after them", async () => {
		const w = await world();
		w.seedMain(h.userId);
		// The clock is read twice around an account's reads and nowhere else:
		// a quarter of a second here.
		const clock = vi.spyOn(performance, "now");
		clock.mockReturnValueOnce(1_000).mockReturnValueOnce(1_250);
		const report = w.quality.measureMemoryQuality({
			userId: h.userId,
			now: NOW,
		});
		expect(report.readMs).toBe(250);
		expect(w.quality.summarizeMemoryQuality(report, "Account")[0]).toContain(
			"read in 250 ms",
		);
		clock.mockRestore();

		// Three more accounts: 100, 150 and 50 ms of reads make a baseline's 300.
		for (const id of ["q7-a", "q7-b", "q7-c"]) {
			h.fixture.seedUser(id);
			w.seedSmall(id, { imported: 1, live: 0, jobs: [] });
		}
		const baselineClock = vi.spyOn(performance, "now");
		for (const reading of [0, 100, 200, 350, 400, 450])
			baselineClock.mockReturnValueOnce(reading);
		const baseline = w.quality.measureMemoryBaseline({
			excludeUserIds: [h.userId],
			now: NOW,
		});
		if ("reason" in baseline) throw new Error("three accounts are enough");
		expect(baseline.readMs).toBe(300);
	});

	it("holds a fixed shape: every bucket is there, zero or not", async () => {
		const w = await world();
		w.bank(h.userId);
		const { quality } = w;
		const report = quality.measureMemoryQuality({ userId: h.userId, now: NOW });
		expect(Object.keys(report.delivered.imported.factsPerMessage)).toEqual([
			...quality.FACT_BUCKETS,
		]);
		expect(Object.keys(report.delivered.imported.byLength)).toEqual([
			...quality.LENGTH_BUCKETS,
		]);
		expect(Object.keys(report.entries.personal.supportingFacts)).toEqual([
			...quality.SUPPORT_BUCKETS,
		]);
		expect(Object.keys(report.importedFactDates)).toEqual([
			...quality.DATE_BUCKETS,
		]);
		expect(Object.keys(report.messages)).toEqual([...quality.MESSAGE_ORIGINS]);
		expect(Object.keys(report.delivered)).toEqual([...quality.MESSAGE_ORIGINS]);
		expect(quality.MESSAGE_ORIGINS).toContain("history");
		expect(report.readMs).toBeGreaterThanOrEqual(0);
		expect(report.process.deliverySeconds.perTenth).toHaveLength(10);
		expect(report.process.deliverySeconds.overall).toEqual({
			jobs: 0,
			medianSeconds: null,
			p90Seconds: null,
		});
		expect(report.entries.personal.total).toBe(0);
	});

	it("takes only a JSON true mark on a migration event for the import, whatever else the context holds", async () => {
		const w = await world();
		const personal = w.bank(h.userId);
		const said = "2026-03-01T00:00:00Z";
		// Real contexts first, then the ones that are not: none of them is the import.
		const contexts: [string, string][] = [
			["import", w.importedContext(said)],
			["import-minimal", '{"migrationImported":true}'],
			["history", w.historyContext(said)],
			["not-json", "not json {"],
			["empty", ""],
			["string", '{"migrationImported":"true"}'],
			["number", '{"migrationImported":1}'],
			["false", '{"migrationImported":false}'],
			["array", "[true]"],
			["nested", '{"a":{"migrationImported":true}}'],
		];
		const add = (name: string, eventId: string, context: string) => {
			w.source({
				userId: h.userId,
				bankId: personal,
				id: `q7-s-${name}`,
				eventId,
				characters: 150,
				said,
				facts: [`q7-fact-${name}`],
				context,
			});
			w.entry({
				bankId: personal,
				id: `q7-e-${name}`,
				text: `${MARKER} entry number ${name} rests on a fact of its own`,
				facts: [`q7-fact-${name}`],
			});
		};
		for (const [name, context] of contexts)
			add(name, `migration-message:${name}`, context);
		// A live message that carries the mark is still a live message.
		add("live-marked", "message:live-marked", '{"migrationImported":true}');
		const report = w.quality.measureMemoryQuality({
			userId: h.userId,
			now: NOW,
		});
		expect(report.messages.imported.total).toBe(2);
		expect(report.messages.history.total).toBe(8);
		expect(report.messages.live.total).toBe(1);
		// The entries follow the messages their facts came from, the same way.
		expect(report.entries.personal.total).toBe(11);
		expect(report.entries.personal.withImportedFact).toBe(2);
		expect(report.entries.personal.withoutImportedFact).toBe(9);
		// And only the import's facts have their dates counted.
		expect(nonZero(report.importedFactDates)).toEqual({ no_date: 2 });
	});

	it("holds no transaction of its own around its reads: only the page's read opens one, and only for itself", async () => {
		const w = await world();
		w.seedMain(h.userId);
		// Every statement the connection prepares, and whether it was in a
		// transaction at the time. Drizzle prepares each query as it runs it.
		const seen: { sql: string; open: boolean }[] = [];
		const prepare = h.sqlite.prepare.bind(h.sqlite) as (
			sql: string,
		) => ReturnType<typeof h.sqlite.prepare>;
		vi.spyOn(h.sqlite, "prepare").mockImplementation(((sql: string) => {
			seen.push({ sql, open: h.sqlite.inTransaction });
			return prepare(sql);
		}) as typeof h.sqlite.prepare);
		w.quality.measureMemoryQuality({ userId: h.userId, now: NOW });

		// The report's own reads, told apart by what they select: the messages
		// (their length and the import's mark), the published rows' support (no
		// native text), and the jobs (with their error code) and their attempts.
		// The page's own status query on the jobs table is not one of them.
		const own = seen.filter(
			({ sql }) =>
				(sql.includes("length(") && sql.includes("json_type(")) ||
				(sql.includes("source_ids_json") && !sql.includes("native_text")) ||
				(sql.includes('"memory_delivery_jobs"') &&
					sql.includes('"error_code"')) ||
				sql.includes('"memory_delivery_attempts"'),
		);
		// Messages once, support once for each of the two banks, the attempts and the jobs.
		expect(own.length).toBeGreaterThanOrEqual(5);
		expect(own.filter(({ open }) => open)).toEqual([]);
		// The probe can tell: the page's own read of the published rows (with
		// their native text) runs inside the transaction it opens for itself.
		const page = seen.filter(({ sql }) => sql.includes("native_text"));
		expect(page.length).toBeGreaterThan(0);
		expect(page.some(({ open }) => open)).toBe(true);
	});

	it("never builds a transaction of its own: the module holds none", async () => {
		const { readFileSync } = await import("node:fs");
		const code = readFileSync(
			`${process.cwd()}/src/lib/server/services/memory-profile/quality-report.ts`,
			"utf8",
		)
			// The head of the file says why, in words.
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/\/\/.*$/gm, "");
		expect(code).not.toMatch(/\.transaction\s*\(/);
	});

	it("counts only what the page would show: a bank it will not read is skipped, a retired one is gone", async () => {
		const w = await world();
		w.bank(h.userId);
		w.project(h.userId, "q7-blocked");
		w.project(h.userId, "q7-retired");
		const blocked = w.bank(
			h.userId,
			{ kind: "project", projectId: "q7-blocked" },
			"repair_blocked",
		);
		const retired = w.bank(
			h.userId,
			{ kind: "project", projectId: "q7-retired" },
			"retired",
		);
		// A bank whose project is gone.
		w.db
			.insert(w.s.memoryBanks)
			.values({
				id: "q7-ghost-bank",
				userId: h.userId,
				scopeKey: "project:q7-ghost",
				epoch: 0,
				generation: "g1",
			})
			.run();
		for (const [id, bankId] of [
			["blocked", blocked],
			["retired", retired],
		] as const)
			w.source({
				userId: h.userId,
				bankId,
				id: `q7-s-${id}`,
				eventId: `message:${id}`,
				characters: 200,
				said: "2026-11-20T00:00:00Z",
				facts: [`q7-fact-${id}`],
			});
		const report = w.quality.measureMemoryQuality({
			userId: h.userId,
			now: NOW,
		});
		// Personal read; the repair-blocked bank and the ghost are skipped; the
		// retired bank does not count at all.
		expect(report.banks).toEqual({ personal: 1, project: 0, skipped: 2 });
		// A skipped bank's messages still count, a retired bank's do not.
		expect(report.messages.live.total).toBe(1);
	});

	it("skips a bank that fails with one of Memory's own codes, but lets any other failure through", async () => {
		const w = await world();
		w.bank(h.userId);
		const reader = await import("./subject-read");
		const read = vi.spyOn(reader, "readScopeEntries");
		read.mockImplementation(() => {
			throw new Error("memory_fence_stale");
		});
		expect(
			w.quality.measureMemoryQuality({ userId: h.userId, now: NOW }).banks,
		).toEqual({ personal: 0, project: 0, skipped: 1 });
		// A bug must not read as a bank that could not be read.
		read.mockImplementation(() => {
			throw new TypeError("a bug, not a bank");
		});
		expect(() =>
			w.quality.measureMemoryQuality({ userId: h.userId, now: NOW }),
		).toThrow("a bug, not a bank");
	});

	it("counts a bank the person has switched Memory off for as not read, while its messages and jobs still count", async () => {
		const w = await world();
		w.seedMain(h.userId);
		w.db
			.update(w.s.users)
			.set({ memoryEnabled: false })
			.where(w.eq(w.s.users.id, h.userId))
			.run();
		const report = w.quality.measureMemoryQuality({
			userId: h.userId,
			now: NOW,
		});
		expect(report.banks).toEqual({ personal: 0, project: 0, skipped: 2 });
		expect(report.entries.personal.total).toBe(0);
		expect(report.messages.imported.total).toBe(7);
		expect(report.process.sourceJobs).toBe(14);
	});

	it("counts the account's current epoch only: Clear Memory starts a new count", async () => {
		const w = await world();
		const first = w.bank(h.userId);
		w.source({
			userId: h.userId,
			bankId: first,
			id: "q7-s-old",
			eventId: "message:old",
			characters: 200,
			said: "2026-11-01T00:00:00Z",
			facts: ["q7-fact-old"],
		});
		w.entry({
			bankId: first,
			id: "q7-e-old",
			text: `${MARKER} an entry from before the clear`,
			facts: ["q7-fact-old"],
		});
		w.job({
			userId: h.userId,
			bankId: first,
			id: "q7-j-old",
			status: "failed",
		});
		w.db
			.update(w.s.memoryAccounts)
			.set({ epoch: 1 })
			.where(w.eq(w.s.memoryAccounts.userId, h.userId))
			.run();
		const second = w.bank(h.userId);
		expect(second).not.toBe(first);
		// The new bank is epoch 1 (ensureMemoryBank reads the account's epoch).
		w.source({
			userId: h.userId,
			bankId: second,
			id: "q7-s-new",
			eventId: "message:new",
			epoch: 1,
			characters: 200,
			said: "2026-11-02T00:00:00Z",
			facts: ["q7-fact-new"],
		});
		const report = w.quality.measureMemoryQuality({
			userId: h.userId,
			now: NOW,
		});
		expect(report.banks).toEqual({ personal: 1, project: 0, skipped: 0 });
		expect(report.messages.live.total).toBe(1);
		expect(report.entries.personal.total).toBe(0);
		expect(report.process.sourceJobs).toBe(0);
	});

	it("counts an attempt that seems to end before it began as no time at all", async () => {
		const w = await world();
		const personal = w.bank(h.userId);
		w.job({
			userId: h.userId,
			bankId: personal,
			id: "q7-j-skew",
			status: "succeeded",
			completed: "2026-11-25T10:00:00Z",
			attempts: [{ start: "2026-11-25T09:00:00Z", seconds: -30 }],
		});
		w.job({
			userId: h.userId,
			bankId: personal,
			id: "q7-j-plain",
			status: "succeeded",
			completed: "2026-11-25T10:05:00Z",
			attempts: [
				{ start: "2026-11-25T09:30:00Z", seconds: 5 },
				// An attempt that never finished adds nothing.
				{ start: "2026-11-25T09:40:00Z", seconds: null },
			],
		});
		const report = w.quality.measureMemoryQuality({
			userId: h.userId,
			now: NOW,
		});
		expect(report.process.deliverySeconds.overall).toEqual({
			jobs: 2,
			medianSeconds: 2.5,
			p90Seconds: 5,
		});
	});

	it("keeps text, ids and dates out: every value is a number and every key a code", async () => {
		const w = await world();
		w.seedMain(h.userId);
		for (const id of ["q7-o1", "q7-o2", "q7-o3"]) {
			h.fixture.seedUser(id);
			w.seedSmall(id, { imported: 1, live: 1, jobs: [5] });
		}
		const baseline = w.quality.measureMemoryBaseline({
			excludeUserIds: [],
			now: NOW,
		});
		expect(baseline).toMatchObject({ accounts: 4 });
		const reports = [
			w.quality.measureMemoryQuality({ userId: h.userId, now: NOW }),
			baseline,
		];
		for (const report of reports) {
			const json = JSON.stringify(report);
			expect(json).not.toContain(MARKER);
			for (const id of w.seeded) expect(json).not.toContain(id);
			// Structure: nothing but numbers (and the clock) as values, and keys
			// from a closed vocabulary of buckets, states, codes and slugs.
			const walk = (value: unknown, path: string) => {
				if (value === null || typeof value === "number") return;
				if (typeof value === "string") {
					expect(path).toBe("measuredAt");
					return;
				}
				expect(typeof value).toBe("object");
				for (const [key, child] of Object.entries(value as object)) {
					expect(key).toMatch(/^[A-Za-z0-9_<+-]+$/);
					walk(child, key);
				}
			};
			walk(report, "report");
		}
	});

	it("refuses an account that is unknown or not on native Memory instead of reporting zeros", async () => {
		const w = await world();
		expect(() =>
			w.quality.measureMemoryQuality({ userId: "nobody", now: NOW }),
		).toThrow("memory_quality_account_unknown");
		// A user with no Memory account, and one still on legacy Memory.
		h.fixture.seedUser("q7-legacy");
		expect(() =>
			w.quality.measureMemoryQuality({ userId: "q7-legacy", now: NOW }),
		).toThrow("memory_quality_not_native");
		w.db
			.insert(w.s.memoryAccounts)
			.values({ userId: "q7-legacy", tenantId: "q7-tenant" })
			.run();
		expect(() =>
			w.quality.measureMemoryQuality({ userId: "q7-legacy", now: NOW }),
		).toThrow("memory_quality_not_native");
	});

	it("reads a 3,000-entry bank, near-identical entries and all, in a few seconds", async () => {
		const entries = 3_000;
		await seedSubjectEntries(
			h.userId,
			{ kind: "personal" },
			Array.from({ length: entries }, (_, i) => ({
				id: `q7-scale-${i}`,
				// Ten words, one of them different: every pair is a near-duplicate,
				// the worst case for the comparison.
				text: `${MARKER} remembered detail about one plain everyday thing number n${i}`,
				said: new Date(NOW.getTime() - (i % 400) * DAY).toISOString(),
				kind: i % 2 ? "lasting" : "ongoing",
				subject: "about_you",
			})),
		);
		const { measureMemoryQuality } = await import("./quality-report");
		const started = performance.now();
		const report = measureMemoryQuality({ userId: h.userId, now: NOW });
		const elapsed = performance.now() - started;
		console.info("[MEMORY_QUALITY_SIZE]", {
			entries,
			ms: Math.round(elapsed),
		});
		expect(report.entries.personal.total).toBe(entries);
		expect(report.entries.personal.duplicates).toMatchObject({
			exactEntries: 0,
			nearEntries: entries,
			nearPairs: (entries * (entries - 1)) / 2,
		});
		expect(elapsed).toBeLessThan(15_000);
	}, 60_000);
});

describe("the baseline", () => {
	/** Three small native accounts, the tester and a legacy account, with the measured account's own rich seed. */
	async function others() {
		const w = await world();
		w.seedMain(h.userId);
		for (const id of ["q7-a", "q7-b", "q7-c", "q7-tester", "q7-legacy"])
			h.fixture.seedUser(id);
		const aBank = w.seedSmall("q7-a", { imported: 2, live: 1, jobs: [30, 40] });
		w.job({
			userId: "q7-a",
			bankId: aBank,
			id: "q7-a-failed",
			status: "failed",
			code: "memory_candidate_unaccepted",
		});
		w.seedSmall("q7-b", { imported: 0, live: 2, jobs: [10] });
		w.seedSmall("q7-c", { imported: 1, live: 1, jobs: [50] });
		w.seedSmall("q7-tester", { imported: 5, live: 0, jobs: [999] });
		w.db
			.update(w.s.users)
			.set({ memoryMigrationExcluded: true })
			.where(w.eq(w.s.users.id, "q7-tester"))
			.run();
		w.db
			.insert(w.s.memoryAccounts)
			.values({ userId: "q7-legacy", tenantId: "q7-legacy-tenant" })
			.run();
		return w;
	}

	it("sums the other native accounts, leaving out the measured account, the tester and accounts not on native Memory", async () => {
		const w = await others();
		const baseline = w.quality.measureMemoryBaseline({
			excludeUserIds: [h.userId],
			now: NOW,
		});
		if ("reason" in baseline) throw new Error("three accounts are enough");
		expect(baseline.accounts).toBe(3);
		expect(Number.isInteger(baseline.readMs)).toBe(true);
		expect(baseline.readMs).toBeGreaterThanOrEqual(0);
		expect(baseline.banks).toEqual({ personal: 3, project: 0, skipped: 0 });
		// A has three entries, B two, C two: the measured account's nine and the
		// tester's five are not in it.
		expect(baseline.entries.personal.total).toBe(7);
		expect(baseline.entries.personal.withImportedFact).toBe(3);
		expect(baseline.entries.personal.withoutImportedFact).toBe(4);
		expect(baseline.messages.imported.total).toBe(3);
		expect(baseline.messages.live.total).toBe(4);
		expect(baseline.messages.history.total).toBe(0);
		expect(baseline.delivered.imported.messages).toBe(3);
		expect(baseline.process.sourceJobs).toBe(5);
		expect(baseline.process.byStatus).toEqual({ failed: 1, succeeded: 4 });
		// The accounts' job times are pooled: 10, 30, 40 and 50 seconds.
		expect(baseline.process.deliverySeconds.overall).toEqual({
			jobs: 4,
			medianSeconds: 35,
			p90Seconds: 50,
		});
		// Each account's own tenths stay together: the first job of each lands in
		// the first tenth (30, 10 and 50), the second of A's two in the sixth.
		const tenths = baseline.process.deliverySeconds.perTenth;
		expect(tenths[0]).toEqual({ jobs: 3, medianSeconds: 30, p90Seconds: 50 });
		expect(tenths[5]).toEqual({ jobs: 1, medianSeconds: 40, p90Seconds: 40 });
		expect(tenths.filter(({ jobs }) => jobs === 0)).toHaveLength(8);

		// It is the three accounts' own reports added up, field by field.
		const [a, b, c] = ["q7-a", "q7-b", "q7-c"].map((userId) =>
			w.quality.measureMemoryQuality({ userId, now: NOW }),
		);
		for (const field of [
			"total",
			"withImportedFact",
			"withoutImportedFact",
		] as const)
			expect(baseline.entries.personal[field]).toBe(
				a.entries.personal[field] +
					b.entries.personal[field] +
					c.entries.personal[field],
			);
		expect(baseline.messages.live.byState.accepted).toBe(
			(a.messages.live.byState.accepted ?? 0) +
				(b.messages.live.byState.accepted ?? 0) +
				(c.messages.live.byState.accepted ?? 0),
		);
		expect(baseline.entries.personal.kind.unlabelled).toBe(7);

		// The other accounts' rows never leak into one account's own report.
		const own = w.quality.measureMemoryQuality({ userId: h.userId, now: NOW });
		expect(own.entries.personal.total).toBe(9);
		expect(own.messages.imported.total).toBe(7);
		expect(own.process.sourceJobs).toBe(14);

		// Naming nobody puts the measured account back in; the tester stays out.
		const everyone = w.quality.measureMemoryBaseline({
			excludeUserIds: [],
			now: NOW,
		});
		if ("reason" in everyone) throw new Error("four accounts are enough");
		expect(everyone.accounts).toBe(4);
		expect(everyone.entries.personal.total).toBe(7 + 9);
		expect(everyone.entries.project.total).toBe(2);
	});

	it("gives only how many accounts there are, and reads none of them, when there are fewer than three", async () => {
		const w = await others();
		const reader = await import("./subject-read");
		const read = vi.spyOn(reader, "readScopeEntries");
		// Two accounts are left once the measured one and A are named: too few.
		const two = w.quality.measureMemoryBaseline({
			excludeUserIds: [h.userId, "q7-a"],
			now: NOW,
		});
		expect(two).toEqual({ accounts: 2, reason: "too_few_accounts" });
		// Nobody to compare with: still no numbers, and no read.
		const none = w.quality.measureMemoryBaseline({
			excludeUserIds: [h.userId, "q7-a", "q7-b", "q7-c"],
			now: NOW,
		});
		expect(none).toEqual({ accounts: 0, reason: "too_few_accounts" });
		expect(read).not.toHaveBeenCalled();
		// Exactly three is enough.
		const three = w.quality.measureMemoryBaseline({
			excludeUserIds: [h.userId],
			now: NOW,
		});
		expect(three).toMatchObject({ accounts: 3 });
		expect(read).toHaveBeenCalled();
	});

	it("leaves subject counts out of the baseline and keeps the measured account's own", async () => {
		const w = await others();
		const baseline = w.quality.measureMemoryBaseline({
			excludeUserIds: [],
			now: NOW,
		});
		if ("reason" in baseline) throw new Error("four accounts are enough");
		const own = w.quality.measureMemoryQuality({ userId: h.userId, now: NOW });
		const keys = (value: unknown, found = new Set<string>()): Set<string> => {
			if (value && typeof value === "object")
				for (const [key, child] of Object.entries(value)) {
					found.add(key);
					keys(child, found);
				}
			return found;
		};
		const baselineKeys = keys(baseline);
		const ownKeys = keys(own);
		expect(baselineKeys.has("subject")).toBe(false);
		// Every subject slug but `other`, which is also a message origin.
		for (const slug of [
			...PERSONAL_MEMORY_SUBJECTS,
			...PROJECT_MEMORY_SUBJECTS,
		].filter((slug) => slug !== "other")) {
			expect(baselineKeys.has(slug), slug).toBe(false);
			if (own.entries.personal.subject[slug] !== undefined)
				expect(ownKeys.has(slug), slug).toBe(true);
		}
		expect(own.entries.personal.subject.about_you).toBe(2);
		expect(own.entries.project.subject.plans_status).toBe(1);
		// The rest of an entry's counts are all there.
		expect(Object.keys(baseline.entries.personal).sort()).toEqual(
			[
				"duplicates",
				"kind",
				"supportingFacts",
				"timeState",
				"total",
				"withImportedFact",
				"withoutImportedFact",
			].sort(),
		);
	});

	it("keeps duplicates within each bank, never across accounts", async () => {
		const w = await world();
		w.bank(h.userId);
		for (const id of ["q7-a", "q7-b", "q7-c"]) {
			h.fixture.seedUser(id);
			const bankId = w.bank(id);
			// The same sentence in each account's bank.
			w.source({
				userId: id,
				bankId,
				id: `q7-s-${id}`,
				eventId: `message:${id}`,
				characters: 150,
				said: "2026-11-01T00:00:00Z",
				facts: [`q7-fact-${id}`],
			});
			w.entry({
				bankId,
				id: `q7-entry-${id}`,
				text: `${MARKER} likes the very same sentence in both accounts`,
				facts: [`q7-fact-${id}`],
			});
		}
		const baseline = w.quality.measureMemoryBaseline({
			excludeUserIds: [h.userId],
			now: NOW,
		});
		if ("reason" in baseline) throw new Error("three accounts are enough");
		expect(baseline.accounts).toBe(3);
		expect(baseline.entries.personal.total).toBe(3);
		expect(baseline.entries.personal.duplicates).toEqual({
			exactEntries: 0,
			exactGroups: 0,
			nearPairs: 0,
			nearEntries: 0,
			tooShortToCompare: 0,
		});
	});
});

describe("the judge's consent fence", () => {
	async function fence() {
		const w = await world();
		w.bank(h.userId);
		const setAccount = (values: {
			epoch?: number;
			controlRevision?: number;
			authority?: string;
			lifecycleState?: string;
		}) =>
			w.db
				.update(w.s.memoryAccounts)
				.set(values)
				.where(w.eq(w.s.memoryAccounts.userId, h.userId))
				.run();
		const setMemory = (enabled: boolean) =>
			w.db
				.update(w.s.users)
				.set({ memoryEnabled: enabled })
				.where(w.eq(w.s.users.id, h.userId))
				.run();
		const choose = (id: string, choice: "include" | "decline", at: string) =>
			w.db
				.insert(w.s.memoryHistoryChoices)
				.values({
					id,
					userId: h.userId,
					requestId: `request-${id}`,
					choice,
					cutoff: new Date(at),
					decidedAt: new Date(at),
					policyVersion: "1",
					epoch: 0,
				})
				.run();
		return { w, setAccount, setMemory, choose };
	}

	it("stands while nothing changes and stops at once when Memory, the account, its epoch or its control revision does", async () => {
		const { w, setAccount, setMemory } = await fence();
		const found = w.quality.readJudgeConsent(h.userId);
		expect(found).toEqual({ epoch: 0, controlRevision: 0, history: null });
		if (!found) throw new Error("consent");
		const stands = () => w.quality.assertJudgeConsent(h.userId, found);
		const refused = "memory_quality_consent_changed";
		expect(stands).not.toThrow();

		// Switched off, and on again.
		setMemory(false);
		expect(stands).toThrow(refused);
		setMemory(true);
		expect(stands).not.toThrow();
		// An off and on between two asks moves the control revision
		// (`setMemoryEnabled`), so it shows even though Memory is on again.
		setAccount({ controlRevision: 1 });
		expect(stands).toThrow(refused);
		setAccount({ controlRevision: 0 });
		// Clear Memory starts a new epoch.
		setAccount({ epoch: 1 });
		expect(stands).toThrow(refused);
		setAccount({ epoch: 0 });
		// An account that is no longer native, or is being erased.
		setAccount({ authority: "preparing" });
		expect(stands).toThrow(refused);
		setAccount({ authority: "hindsight", lifecycleState: "erasing" });
		expect(stands).toThrow(refused);
		setAccount({ lifecycleState: "active" });
		expect(stands).not.toThrow();
	});

	it("stops when a history choice is made after the run began, the same choice again included", async () => {
		const { w, choose } = await fence();
		// An earlier choice is part of what the run found.
		choose("q7-choice-1", "include", "2026-11-20T10:00:00Z");
		const found = w.quality.readJudgeConsent(h.userId);
		expect(found?.history).toEqual({ id: "q7-choice-1", choice: "include" });
		if (!found) throw new Error("consent");
		expect(() => w.quality.assertJudgeConsent(h.userId, found)).not.toThrow();

		// The person declines history, which revokes the imported chats: the
		// newest choice is another row.
		choose("q7-choice-2", "decline", "2026-11-26T09:00:00Z");
		expect(() => w.quality.assertJudgeConsent(h.userId, found)).toThrow(
			"memory_quality_consent_changed",
		);
		// A run that starts now finds the decline and stands on it, ...
		const later = w.quality.readJudgeConsent(h.userId);
		expect(later?.history).toEqual({ id: "q7-choice-2", choice: "decline" });
		if (!later) throw new Error("consent");
		expect(() => w.quality.assertJudgeConsent(h.userId, later)).not.toThrow();
		// ... until the same choice is asked for again in the same second (decided_at
		// has whole seconds): the row written last is the newest.
		choose("q7-choice-3", "decline", "2026-11-26T09:00:00Z");
		expect(() => w.quality.assertJudgeConsent(h.userId, later)).toThrow(
			"memory_quality_consent_changed",
		);
		expect(w.quality.readJudgeConsent(h.userId)?.history?.id).toBe(
			"q7-choice-3",
		);
	});

	it("finds no consent for an account that is off, not native, being erased or unknown", async () => {
		const { w, setAccount, setMemory } = await fence();
		expect(w.quality.readJudgeConsent("nobody")).toBeNull();
		setMemory(false);
		expect(w.quality.readJudgeConsent(h.userId)).toBeNull();
		setMemory(true);
		setAccount({ authority: "legacy" });
		expect(w.quality.readJudgeConsent(h.userId)).toBeNull();
		setAccount({ authority: "hindsight", lifecycleState: "erasing" });
		expect(w.quality.readJudgeConsent(h.userId)).toBeNull();
		// An account that never had Memory.
		h.fixture.seedUser("q7-plain");
		expect(w.quality.readJudgeConsent("q7-plain")).toBeNull();
		// Run against a withdrawn account: the fence refuses whatever the run found.
		expect(() =>
			w.quality.assertJudgeConsent(h.userId, {
				epoch: 0,
				controlRevision: 0,
				history: null,
			}),
		).toThrow("memory_quality_consent_changed");
	});

	/**
	 * A person's bank with three entries, and another person's with one. The
	 * judge's ids are published row ids (`row-q7-pub-N`); the observation behind
	 * each is its native id (`q7-pub-N`).
	 */
	async function published() {
		const w = await world();
		h.fixture.seedUser("q7-b");
		const mine = w.bank(h.userId);
		const theirs = w.bank("q7-b");
		for (const [userId, bankId, id] of [
			[h.userId, mine, "q7-pub-1"],
			[h.userId, mine, "q7-pub-2"],
			[h.userId, mine, "q7-pub-3"],
			["q7-b", theirs, "q7-pub-9"],
		] as const) {
			w.source({
				userId,
				bankId,
				id: `q7-s-${id}`,
				eventId: `message:${id}`,
				characters: 150,
				said: "2026-11-01T00:00:00Z",
				facts: [`q7-fact-${id}`],
			});
			w.entry({
				bankId,
				id,
				text: `${MARKER} entry ${id} says something plain`,
				facts: [`q7-fact-${id}`],
			});
		}
		/** A delivery lands: a new generation, its rows new rows (new row ids) over the same observations, minus these. */
		const publishAgain = (without: string[] = []) => {
			w.db
				.update(w.s.memoryBanks)
				.set({ generation: "g2", previousGeneration: "g1" })
				.where(w.eq(w.s.memoryBanks.id, mine))
				.run();
			for (const id of ["q7-pub-1", "q7-pub-2", "q7-pub-3"])
				if (!without.includes(id))
					w.db
						.insert(w.s.memoryPublishedRows)
						.values({
							id: `row-g2-${id}`,
							bankId: mine,
							generation: "g2",
							epoch: 0,
							nativeId: id,
							text: `${MARKER} entry ${id} says something plain`,
							nativeText: `${MARKER} entry ${id} says something plain`,
							sourceIdsJson: "[]",
							sourceFingerprintsJson: "[]",
							updatedAt: NOW,
						})
						.run();
		};
		return { w, mine, publishAgain };
	}

	it("keeps what the batch names that is still published: its entries and their candidates alike, none of anyone else's", async () => {
		const { w } = await published();
		const ids = [
			"row-q7-pub-1",
			"row-q7-pub-2",
			"row-q7-pub-3",
			// Another person's entry, and an id nothing has.
			"row-q7-pub-9",
			"q7-nothing",
		];
		const fence = w.quality.publishedEntryFence(h.userId, ids);
		// An entry with its candidates, as the judge asks: all of them are answered.
		expect(fence(["row-q7-pub-1", "row-q7-pub-2", "row-q7-pub-3"])).toEqual(
			new Set(["row-q7-pub-1", "row-q7-pub-2", "row-q7-pub-3"]),
		);
		expect(fence(["row-q7-pub-1", "row-q7-pub-9", "q7-nothing"])).toEqual(
			new Set(["row-q7-pub-1"]),
		);
		expect(fence([])).toEqual(new Set());
		// An id that is Hindsight's own names the observation as well.
		expect(
			w.quality.publishedEntryFence(h.userId, ["q7-pub-2"])(["q7-pub-2"]),
		).toEqual(new Set(["q7-pub-2"]));
		expect(
			w.quality.publishedEntryFence(h.userId, [])(["row-q7-pub-1"]),
		).toEqual(new Set());
	});

	it("is not shaken by a delivery that lands during the run, and withdraws an entry whose observation is gone", async () => {
		const { w, publishAgain } = await published();
		const fence = w.quality.publishedEntryFence(h.userId, [
			"row-q7-pub-1",
			"row-q7-pub-2",
			"row-q7-pub-3",
		]);
		// A publication: every row is a new row, the observations are the same.
		publishAgain();
		expect(fence(["row-q7-pub-1", "row-q7-pub-2", "row-q7-pub-3"])).toEqual(
			new Set(["row-q7-pub-1", "row-q7-pub-2", "row-q7-pub-3"]),
		);
		// The person removes an entry: the next publication holds no observation for it.
		w.db
			.delete(w.s.memoryPublishedRows)
			.where(w.eq(w.s.memoryPublishedRows.id, "row-g2-q7-pub-2"))
			.run();
		expect(fence(["row-q7-pub-1", "row-q7-pub-2", "row-q7-pub-3"])).toEqual(
			new Set(["row-q7-pub-1", "row-q7-pub-3"]),
		);
	});

	it("places the ids as the run starts, a publication since the entries were read included, and never allows one it could not place", async () => {
		const { w, publishAgain } = await published();
		// A delivery landed after the entries were read and before the run starts:
		// the rows the judge read are the previous generation's, still held.
		publishAgain();
		const bridged = w.quality.publishedEntryFence(h.userId, [
			"row-q7-pub-1",
			"row-g2-q7-pub-1",
		]);
		expect(bridged(["row-q7-pub-1", "row-g2-q7-pub-1"])).toEqual(
			new Set(["row-q7-pub-1", "row-g2-q7-pub-1"]),
		);
		// Once the first generation's rows are gone (a second publication), the
		// entries of an old read can no longer be placed.
		w.db
			.delete(w.s.memoryPublishedRows)
			.where(w.eq(w.s.memoryPublishedRows.generation, "g1"))
			.run();
		const late = w.quality.publishedEntryFence(h.userId, [
			"row-q7-pub-1",
			"row-g2-q7-pub-1",
		]);
		expect(late(["row-q7-pub-1", "row-g2-q7-pub-1"])).toEqual(
			new Set(["row-g2-q7-pub-1"]),
		);
		// A fence built before that keeps what it placed.
		expect(bridged(["row-q7-pub-1"])).toEqual(new Set(["row-q7-pub-1"]));
	});

	it("allows nothing in a bank that is not ready or an epoch the account has left", async () => {
		const { w, mine } = await published();
		const ids = ["row-q7-pub-1", "row-q7-pub-2"];
		const fence = w.quality.publishedEntryFence(h.userId, ids);
		w.db
			.update(w.s.memoryBanks)
			.set({ status: "repair_blocked" })
			.where(w.eq(w.s.memoryBanks.id, mine))
			.run();
		expect(fence(ids)).toEqual(new Set());
		w.db
			.update(w.s.memoryBanks)
			.set({ status: "ready" })
			.where(w.eq(w.s.memoryBanks.id, mine))
			.run();
		expect(fence(ids)).toEqual(new Set(ids));
		w.db
			.update(w.s.memoryAccounts)
			.set({ epoch: 1 })
			.where(w.eq(w.s.memoryAccounts.userId, h.userId))
			.run();
		expect(fence(ids)).toEqual(new Set());
		// A fence built after Clear Memory places nothing of the old epoch either.
		expect(w.quality.publishedEntryFence(h.userId, ids)(ids)).toEqual(
			new Set(),
		);
	});

	it("places thousands of ids, in chunks, and answers a batch from any part of them", async () => {
		const entries = 1_300;
		const bank = await seedSubjectEntries(
			h.userId,
			{ kind: "personal" },
			Array.from({ length: entries }, (_, i) => ({
				id: `q7-long-${i}`,
				text: `${MARKER} long list entry ${i} says something plain`,
				said: "2026-11-01T00:00:00Z",
				kind: "lasting" as const,
				subject: "about_you" as const,
			})),
		);
		const { publishedEntryFence } = await import("./quality-report");
		// The helper's row ids are `r-<bank>-<entry>`.
		const rowId = (i: number) => `r-${bank.id}-q7-long-${i}`;
		const all = Array.from({ length: entries }, (_, i) => rowId(i));
		const fence = publishedEntryFence(h.userId, all);
		const edges = [0, 1, 499, 500, 501, 999, 1000, 1299].map(rowId);
		expect(fence([...edges, "q7-nothing"])).toEqual(new Set(edges));
	});

	it("throws the error the judge recognises", async () => {
		const { w } = await fence();
		const judge = await import("./quality-judge");
		expect(judge.MEMORY_QUALITY_CONSENT_CHANGED).toBe(
			"memory_quality_consent_changed",
		);
		let thrown: unknown;
		try {
			w.quality.assertJudgeConsent(h.userId, {
				epoch: 9,
				controlRevision: 0,
				history: null,
			});
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toBe(
			judge.MEMORY_QUALITY_CONSENT_CHANGED,
		);
	});
});

describe("a judge run under the fence", () => {
	const ENTRIES = 25;

	/**
	 * A personal bank of entries that share many words (so each has candidates),
	 * the judge's entries read as the command reads them, and the fence and the
	 * consent check wired the way `scripts/memory-quality-report.ts` wires them.
	 */
	async function run() {
		const w = await world();
		const bank = await seedSubjectEntries(
			h.userId,
			{ kind: "personal" },
			Array.from({ length: ENTRIES }, (_, i) => ({
				id: `q7-run-${i}`,
				text: `${MARKER} remembers the plain everyday thing number ${i} of the list`,
				said: new Date(NOW.getTime() - i * DAY).toISOString(),
				kind: "lasting" as const,
				subject: "about_you" as const,
			})),
		);
		const judge = await import("./quality-judge");
		const found = w.quality.readJudgeConsent(h.userId);
		if (!found) throw new Error("consent");
		const stillAllowed = () => w.quality.assertJudgeConsent(h.userId, found);
		const judgeEntries = judge.judgeEntriesFor(h.userId, NOW);
		const published = w.quality.publishedEntryFence(
			h.userId,
			judgeEntries.flatMap((entry) => [
				entry.id,
				...entry.candidates.map(({ id }) => id),
			]),
		);
		/** What the model was shown, call by call. */
		const shown: string[] = [];
		const answering = (during: (call: number) => void = () => {}) =>
			vi.fn<CurationModel>(async (_prompt, input) => {
				shown.push(JSON.stringify(input));
				during(shown.length);
				return {
					verdicts: (input as { entries: { id: string }[] }).entries.map(
						(entry) => ({
							id: entry.id,
							quality: "useful",
							kind: "lasting",
							date: "no_date",
							duplicate_of: "none",
						}),
					),
				};
			});
		const options = {
			beforeBatch: (ids: readonly string[]) => {
				stillAllowed();
				return published(ids);
			},
		};
		/** The person's bank is published again, without these entries: new rows, the same observations. */
		const publishAgain = (without: string[]) => {
			w.db
				.update(w.s.memoryBanks)
				.set({ generation: "g2", previousGeneration: "g" })
				.where(w.eq(w.s.memoryBanks.id, bank.id))
				.run();
			for (const entry of judgeEntries) {
				const row = w.db
					.select()
					.from(w.s.memoryPublishedRows)
					.where(w.eq(w.s.memoryPublishedRows.id, entry.id))
					.get();
				if (!row || without.includes(entry.id)) continue;
				w.db
					.insert(w.s.memoryPublishedRows)
					.values({ ...row, id: `g2-${row.id}`, generation: "g2" })
					.run();
			}
		};
		return { w, judge, judgeEntries, answering, options, publishAgain };
	}

	it("judges every entry when nothing changes, and answers for the candidates it shows too", async () => {
		const { judge, judgeEntries, answering, options } = await run();
		expect(judgeEntries).toHaveLength(ENTRIES);
		// The entries share words, so each is shown its candidates.
		expect(judgeEntries.every((entry) => entry.candidates.length > 0)).toBe(
			true,
		);
		const model = answering();
		const result = await judge.judgeMemoryEntries(judgeEntries, model, options);
		expect(result.withdrawn).toBe(0);
		expect(result.verdicts.size).toBe(ENTRIES);
		// Ten entries a call.
		expect(model).toHaveBeenCalledTimes(3);
	});

	it("keeps judging what is left when a delivery lands mid-run, and never shows an entry the person removed after that", async () => {
		const { w, judge, judgeEntries, answering, options, publishAgain } =
			await run();
		// An entry of the second batch, which the person removes during the first.
		const removed = judgeEntries[15];
		const model = answering((call) => {
			if (call === 1) publishAgain([removed.id]);
		});
		const result = await judge.judgeMemoryEntries(judgeEntries, model, options);
		// Every row is a new row after the publication, yet only the removed
		// entry is withdrawn: the other twenty-four are judged.
		expect(result.withdrawn).toBe(1);
		expect(result.verdicts.size).toBe(ENTRIES - 1);
		expect(result.verdicts.has(removed.id)).toBe(false);
		expect(judge.judgeTotals(judgeEntries, result)).toMatchObject({
			entries: ENTRIES,
			judged: ENTRIES - 1,
			withdrawn: 1,
			notJudged: 0,
		});
		// Nothing sent after its removal mentions it, as an entry or as a candidate.
		expect(model).toHaveBeenCalledTimes(3);
		for (const call of model.mock.calls.slice(1))
			expect(JSON.stringify(call[1])).not.toContain(removed.text);
		// And the person's rows are still the ones the test made.
		expect(w.db.select().from(w.s.memoryPublishedRows).all().length).toBe(
			ENTRIES * 2 - 1,
		);
	});

	it("stops at once, and sends nothing more, when the person turns Memory off mid-run", async () => {
		const { w, judge, judgeEntries, answering, options } = await run();
		const model = answering((call) => {
			if (call === 1)
				w.db
					.update(w.s.users)
					.set({ memoryEnabled: false })
					.where(w.eq(w.s.users.id, h.userId))
					.run();
		});
		await expect(
			judge.judgeMemoryEntries(judgeEntries, model, options),
		).rejects.toThrow(judge.MEMORY_QUALITY_CONSENT_CHANGED);
		expect(model).toHaveBeenCalledTimes(1);
	});

	it("stops at once when the person declines history mid-run", async () => {
		const { w, judge, judgeEntries, answering, options } = await run();
		const model = answering((call) => {
			if (call === 2)
				w.db
					.insert(w.s.memoryHistoryChoices)
					.values({
						id: "q7-decline",
						userId: h.userId,
						requestId: "request-q7-decline",
						choice: "decline",
						cutoff: NOW,
						decidedAt: NOW,
						policyVersion: "1",
						epoch: 0,
					})
					.run();
		});
		await expect(
			judge.judgeMemoryEntries(judgeEntries, model, options),
		).rejects.toThrow(judge.MEMORY_QUALITY_CONSENT_CHANGED);
		// Two batches went out, the third never did.
		expect(model).toHaveBeenCalledTimes(2);
	});
});

describe("the buckets at their edges", () => {
	it("puts a message's facts and length in the right bucket at each edge", async () => {
		const { factsBucket, lengthBucket, supportBucket } = await import(
			"./quality-report"
		);
		expect([0, 1, 2, 3, 4, 5, 6, 40].map(factsBucket)).toEqual([
			"0",
			"1",
			"2",
			"3",
			"4-5",
			"4-5",
			"6+",
			"6+",
		]);
		expect(
			[0, 99, 100, 299, 300, 999, 1000, 2999, 3000, 7999, 8000, 90_000].map(
				lengthBucket,
			),
		).toEqual([
			"<100",
			"<100",
			"100-299",
			"100-299",
			"300-999",
			"300-999",
			"1000-2999",
			"1000-2999",
			"3000-7999",
			"3000-7999",
			"8000+",
			"8000+",
		]);
		expect([0, 1, 2, 3, 4, 5, 9, 10, 11].map(supportBucket)).toEqual([
			"0",
			"1",
			"2",
			"3-4",
			"3-4",
			"5-9",
			"5-9",
			"10+",
			"10+",
		]);
	});

	it("measures a message's length in characters, 99 against 100", async () => {
		const w = await world();
		const personal = w.bank(h.userId);
		for (const characters of [
			99, 100, 299, 300, 999, 1000, 2999, 3000, 7999, 8000,
		])
			w.source({
				userId: h.userId,
				bankId: personal,
				id: `q7-s-${characters}`,
				eventId: `message:${characters}`,
				characters,
				said: "2026-11-01T00:00:00Z",
				facts: [`q7-fact-${characters}`],
			});
		const report = w.quality.measureMemoryQuality({
			userId: h.userId,
			now: NOW,
		});
		expect(
			Object.fromEntries(
				Object.entries(report.delivered.live.byLength).map(
					([length, facts]) => [length, facts["1"]],
				),
			),
		).toEqual({
			"<100": 1,
			"100-299": 2,
			"300-999": 2,
			"1000-2999": 2,
			"3000-7999": 2,
			"8000+": 1,
		});
	});

	it("counts characters, not bytes", async () => {
		const w = await world();
		const personal = w.bank(h.userId);
		// 90 two-byte letters and 5 four-byte emoji is 95 characters and 200 bytes.
		w.db
			.insert(w.s.memorySourceRevisions)
			.values({
				id: "q7-s-wide",
				bankId: personal,
				userId: h.userId,
				epoch: 0,
				eventId: "message:wide",
				lineageId: "lineage-wide",
				text: `${"é".repeat(90)}${"😀".repeat(5)}`,
				context: "",
				textHash: "hash-wide",
				assertedAt: new Date("2026-11-01T00:00:00Z"),
				acknowledgedFactsJson: "[]",
				state: "accepted",
			})
			.run();
		const report = w.quality.measureMemoryQuality({
			userId: h.userId,
			now: NOW,
		});
		expect(cells(report.delivered.live.byLength)).toEqual({ "<100 x 0": 1 });
	});

	it("places an event date against its message's day, at every edge", async () => {
		const { dateBucket } = await import("./quality-report");
		const said = Date.parse("2026-03-01T00:00:00Z");
		const at = (days: number, extraHours = 0) =>
			said + days * DAY + extraHours * 3_600_000;
		const cases: [number | null, string][] = [
			[null, "no_date"],
			[at(0), "within_a_day"],
			[at(1), "within_a_day"],
			[at(-1), "within_a_day"],
			// 1 day and 23 hours is still 1 whole day.
			[at(1, 23), "within_a_day"],
			[at(-1, -23), "within_a_day"],
			[at(2), "later_2_30_days"],
			[at(30), "later_2_30_days"],
			[at(31), "later_31_365_days"],
			[at(365), "later_31_365_days"],
			[at(366), "later_over_a_year"],
			[at(2000), "later_over_a_year"],
			[at(-2), "earlier_2_30_days"],
			[at(-30), "earlier_2_30_days"],
			[at(-31), "earlier_31_365_days"],
			[at(-365), "earlier_31_365_days"],
			[at(-366), "earlier_over_a_year"],
			[at(-2000), "earlier_over_a_year"],
		];
		for (const [eventAt, bucket] of cases)
			expect(dateBucket(eventAt, said), `${eventAt}`).toBe(bucket);
	});

	it("says where a message came from by its source's event and the import's mark", async () => {
		const { originOf } = await import("./quality-report");
		// Preparation records both kinds under `migration-message:`; the mark
		// tells the ChatGPT import from the person's own earlier chats.
		expect(originOf("migration-message:abc:def:0", true)).toBe("imported");
		expect(originOf("migration-message:abc:def:0", false)).toBe("history");
		expect(originOf("message:abc", false)).toBe("live");
		expect(originOf("manual:abc", false)).toBe("note");
		expect(originOf("dependency:job:abc", false)).toBe("other");
		expect(originOf("authored:bank:0:abc", false)).toBe("other");
		expect(originOf("abc", false)).toBe("other");
		// The mark only matters on a migration event.
		expect(originOf("message:abc", true)).toBe("live");
		expect(originOf("manual:abc", true)).toBe("note");
	});
});

describe("duplicates", () => {
	it("counts exact copies after lower-casing and dropping everything but letters and numbers", async () => {
		const { countDuplicates } = await import("./quality-report");
		expect(
			countDuplicates([
				"Alex drinks green tea, every morning.",
				"alex  DRINKS green-tea every   morning",
				// Another spelling of the same accented word: composed and decomposed.
				"Éva lives in Győr",
				"éva lives in Győr",
				"Something else entirely goes here",
			]),
		).toMatchObject({
			exactEntries: 4,
			exactGroups: 2,
			nearPairs: 0,
			nearEntries: 0,
		});
	});

	it("counts three copies as one group of three", async () => {
		const { countDuplicates } = await import("./quality-report");
		expect(
			countDuplicates([
				"a b c d",
				"A B C D",
				"a, b, c, d!",
				"other words go here",
			]),
		).toMatchObject({ exactEntries: 3, exactGroups: 1 });
	});

	it("counts near-duplicates at four fifths of the words, and not below", async () => {
		const { countDuplicates } = await import("./quality-report");
		// Four of five words shared: 4/5 = 0.8, a near-duplicate.
		expect(
			countDuplicates([
				"alpha beta gamma delta",
				"alpha beta gamma delta epsilon",
			]),
		).toMatchObject({
			exactEntries: 0,
			nearPairs: 1,
			nearEntries: 2,
		});
		// Three of five shared: 0.6.
		expect(
			countDuplicates([
				"alpha beta gamma delta",
				"alpha beta gamma epsilon zeta",
			]),
		).toMatchObject({ nearPairs: 0, nearEntries: 0 });
		// Nine of eleven: 0.818, near. Eight of eleven: 0.727, not.
		expect(
			countDuplicates([
				"w1 w2 w3 w4 w5 w6 w7 w8 w9 w10",
				"w1 w2 w3 w4 w5 w6 w7 w8 w9 x10",
			]),
		).toMatchObject({ nearPairs: 1 });
		expect(
			countDuplicates([
				"w1 w2 w3 w4 w5 w6 w7 w8 w9 w10",
				"w1 w2 w3 w4 w5 w6 w7 w8 x9 x10",
			]),
		).toMatchObject({ nearPairs: 0 });
	});

	it("leaves an exact pair out of the near count, and counts an entry once however many pairs it is in", async () => {
		const { countDuplicates } = await import("./quality-report");
		expect(
			countDuplicates([
				"keeps a vegetable garden behind the house",
				"Keeps a vegetable garden behind the house.",
			]),
		).toMatchObject({ exactEntries: 2, nearPairs: 0, nearEntries: 0 });
		// The first is near both of the others, which are near each other.
		expect(
			countDuplicates([
				"one two three four five six seven eight nine",
				"one two three four five six seven eight ten",
				"one two three four five six seven eight eleven",
			]),
		).toMatchObject({ nearPairs: 3, nearEntries: 3 });
		// Two copies and a near one: the copies are exact, each is near the third.
		expect(
			countDuplicates([
				"one two three four five six seven eight nine",
				"One two three four five six seven eight nine!",
				"one two three four five six seven eight ten",
			]),
		).toMatchObject({
			exactEntries: 2,
			exactGroups: 1,
			nearPairs: 2,
			nearEntries: 3,
		});
	});

	it("leaves entries under three words out of the near comparison but not the exact one", async () => {
		const { countDuplicates } = await import("./quality-report");
		expect(
			countDuplicates(["likes tea", "Likes tea!", "likes tea a lot"]),
		).toEqual({
			exactEntries: 2,
			exactGroups: 1,
			nearPairs: 0,
			nearEntries: 0,
			tooShortToCompare: 2,
		});
		// Nothing but punctuation says nothing: not a duplicate of another such.
		expect(countDuplicates(["...", "!!!", ""])).toMatchObject({
			exactEntries: 0,
			tooShortToCompare: 3,
		});
	});

	it("does not mistake size alone for similarity: sets of very different size are never near", async () => {
		const { countDuplicates } = await import("./quality-report");
		expect(
			countDuplicates(["a b c", "a b c d e f g h i j k l m n o p q r s t"]),
		).toMatchObject({ nearPairs: 0 });
	});

	it("finds every planted pair among 3,000 distinct entries, quickly", async () => {
		const { countDuplicates } = await import("./quality-report");
		const sentence = (i: number, width = 12) =>
			Array.from({ length: width }, (_, k) => `w${i * 13 + k}`).join(" ");
		// 3,000 entries sharing no word, 40 exact copies and 30 near copies (one
		// word of twelve replaced).
		const texts = Array.from({ length: 3_000 }, (_, i) => sentence(i));
		for (let i = 0; i < 40; i++) texts.push(sentence(i).toUpperCase());
		for (let i = 100; i < 130; i++)
			texts.push(
				`${sentence(i).split(" ").slice(0, 11).join(" ")} replaced${i}`,
			);
		const started = performance.now();
		const found = countDuplicates(texts);
		const elapsed = performance.now() - started;
		expect(found).toEqual({
			exactEntries: 80,
			exactGroups: 40,
			nearPairs: 30,
			nearEntries: 60,
			tooShortToCompare: 0,
		});
		// A few seconds is the aim; this is a hundredth of the bound.
		expect(elapsed).toBeLessThan(5_000);
	});

	it("handles the worst case, 3,000 entries that are all near each other, in a few seconds", async () => {
		const { countDuplicates } = await import("./quality-report");
		const entries = 3_000;
		const started = performance.now();
		const found = countDuplicates(
			Array.from(
				{ length: entries },
				(_, i) => `one two three four five six seven eight nine n${i}`,
			),
		);
		const elapsed = performance.now() - started;
		expect(found).toEqual({
			exactEntries: 0,
			exactGroups: 0,
			nearPairs: (entries * (entries - 1)) / 2,
			nearEntries: entries,
			tooShortToCompare: 0,
		});
		expect(elapsed).toBeLessThan(5_000);
	});
});

describe("the readable summary", () => {
	it("works the percentages out from the counts and says nothing but numbers", async () => {
		const w = await world();
		w.seedMain(h.userId);
		const report = w.quality.measureMemoryQuality({
			userId: h.userId,
			now: NOW,
		});
		const text = w.quality
			.summarizeMemoryQuality(report, "Synthetic account")
			.join("\n");
		// 4 of 7 imported messages were accepted.
		expect(text).toContain("imported messages: 7, accepted 57.1%");
		// 4 of the 9 personal entries are lasting.
		expect(text).toContain("lasting 44.4%");
		// 2 of the 9 are exact duplicates.
		expect(text).toContain("exact 2 entries (22.2%) in 1 groups");
		// 2 of the 12 imported facts have no date.
		expect(text).toContain("no date 16.7%");
		expect(text).toContain("median 55, p90 90");
		expect(text).not.toContain(MARKER);
		for (const id of w.seeded) expect(text).not.toContain(id);
	});

	it("labels a baseline with its account count and the time the reads took, and leaves its subjects out", async () => {
		const w = await world();
		for (const id of ["q7-a", "q7-b", "q7-c"]) {
			h.fixture.seedUser(id);
			w.seedSmall(id, { imported: 1, live: 0, jobs: [] });
		}
		const baseline = w.quality.measureMemoryBaseline({
			excludeUserIds: [],
			now: NOW,
		});
		const lines = w.quality.summarizeMemoryQuality(baseline, "Baseline");
		expect(lines[0]).toMatch(
			/^Baseline \(measured 2026-11-26T12:00:00\.000Z, 3 accounts, read in \d+ ms\)$/,
		);
		expect(lines.join("\n")).not.toContain("subjects:");
		// The measured account's own summary has them.
		w.seedMain(h.userId);
		const own = w.quality.summarizeMemoryQuality(
			w.quality.measureMemoryQuality({ userId: h.userId, now: NOW }),
			"Account",
		);
		expect(own[0]).toMatch(/, read in \d+ ms\)$/);
		expect(own.join("\n")).toContain("subjects: ");
	});

	it("says a withheld baseline is not reported, and how many accounts there are", async () => {
		const { summarizeMemoryQuality } = await import("./quality-report");
		expect(
			summarizeMemoryQuality(
				{ accounts: 2, reason: "too_few_accounts" },
				"Baseline",
			),
		).toEqual([
			"Baseline: not reported, 2 other native accounts (it needs at least 3, so that no one's numbers are the baseline)",
		]);
	});
});
