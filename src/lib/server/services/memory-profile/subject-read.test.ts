import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MemoryKind, MemoryScope, MemorySubject } from "$lib/memory-types";
import { bootEngine, type EngineHarness } from "../jobs/testing/harness";
import {
	type SyntheticEntry,
	seedSubjectEntries,
} from "./subject-read.test-helpers";

let h: EngineHarness;
beforeEach(async () => {
	h = await bootEngine("memory-subject-read");
});
afterEach(() => h.cleanup());

const NOW = new Date("2026-11-24T12:00:00Z");
const PERSONAL: MemoryScope = { kind: "personal" };

function entry(
	id: string,
	said: string,
	kind: MemoryKind | null,
	subject: MemorySubject | null,
	extra: Partial<SyntheticEntry> = {},
): SyntheticEntry {
	return {
		id,
		text: `Synthetic entry ${id}.`,
		said,
		kind,
		subject,
		...extra,
	};
}

async function read() {
	return import("./subject-read");
}

describe("the subject index", () => {
	it("groups current entries by subject in list order and hides empty subjects", async () => {
		await seedSubjectEntries(h.userId, PERSONAL, [
			entry("c", "2026-11-01", "lasting", "work_study"),
			entry("a", "2026-11-20", "lasting", "about_you"),
			entry("b", "2026-11-10", "lasting", "about_you"),
			entry("d", "2026-09-01", "temporary", "health"),
		]);
		const index = (await read()).readMemorySubjectIndex(
			h.userId,
			PERSONAL,
			NOW,
		);
		expect(
			index.subjects.map(({ subject, count }) => [subject, count]),
		).toEqual([
			["about_you", 2],
			["work_study", 1],
		]);
		expect(index.currentCount).toBe(3);
		expect(index).toMatchObject({ authority: "hindsight", status: "ready" });
	});

	it("previews the most recently mentioned current entry", async () => {
		await seedSubjectEntries(h.userId, PERSONAL, [
			entry("old", "2026-11-01", "lasting", "about_you"),
			entry("new", "2026-11-20", "lasting", "about_you"),
		]);
		const [about] = (await read()).readMemorySubjectIndex(
			h.userId,
			PERSONAL,
			NOW,
		).subjects;
		expect(about.preview).toBe("Synthetic entry new.");
	});

	it("folds Earlier entries into the subject and the index", async () => {
		await seedSubjectEntries(h.userId, PERSONAL, [
			entry("thesis", "2026-11-20", "ongoing", "work_study"),
			entry("exam", "2026-10-01", "temporary", "work_study"),
			entry("flu", "2026-09-01", "temporary", "health"),
		]);
		const index = (await read()).readMemorySubjectIndex(
			h.userId,
			PERSONAL,
			NOW,
		);
		expect(index.subjects).toHaveLength(1);
		expect(index.subjects[0]).toMatchObject({
			subject: "work_study",
			count: 1,
			earlierCount: 1,
			earlierPreview: ["Synthetic entry exam"],
		});
		expect(index.earlier).toEqual({
			count: 2,
			preview: ["Synthetic entry exam", "Synthetic entry flu"],
		});
	});

	it("marks Projects active only for a current ongoing entry", async () => {
		await seedSubjectEntries(h.userId, PERSONAL, [
			entry("app", "2026-11-20", "ongoing", "projects"),
			entry("garden", "2026-11-20", "ongoing", "interests"),
		]);
		const { readMemorySubjectIndex } = await read();
		const index = readMemorySubjectIndex(h.userId, PERSONAL, NOW);
		expect(
			index.subjects.map(({ subject, active }) => [subject, active]),
		).toEqual([
			["projects", true],
			["interests", false],
		]);
	});

	it("does not mark Projects active when its ongoing entry has gone quiet", async () => {
		await seedSubjectEntries(h.userId, PERSONAL, [
			entry("app", "2026-10-25", "ongoing", "projects"),
		]);
		const [projects] = (await read()).readMemorySubjectIndex(
			h.userId,
			PERSONAL,
			NOW,
		).subjects;
		expect(projects).toMatchObject({ count: 1, active: false });
	});

	it("an unlabelled entry sits under Other and stays current", async () => {
		await seedSubjectEntries(h.userId, PERSONAL, [
			entry("u", "2020-01-01", null, null),
		]);
		const index = (await read()).readMemorySubjectIndex(
			h.userId,
			PERSONAL,
			NOW,
		);
		expect(index.subjects).toMatchObject([{ subject: "other", count: 1 }]);
		expect(index.earlier.count).toBe(0);
	});

	it("a project bank uses the project subjects", async () => {
		const { db } = await import("$lib/server/db");
		const { projects } = await import("$lib/server/db/schema");
		db.insert(projects)
			.values({ id: "garden", userId: h.userId, name: "Garden" })
			.run();
		const scope: MemoryScope = { kind: "project", projectId: "garden" };
		await seedSubjectEntries(h.userId, scope, [
			entry("plan", "2026-11-20", "lasting", "plans_status"),
			entry("stray", "2026-11-19", "lasting", "health"),
		]);
		const index = (await read()).readMemorySubjectIndex(h.userId, scope, NOW);
		expect(index.subjects.map(({ subject }) => subject)).toEqual([
			"plans_status",
			"other",
		]);
	});

	it("memory off returns an empty index with status off", async () => {
		await seedSubjectEntries(h.userId, PERSONAL, [
			entry("a", "2026-11-20", "lasting", "about_you"),
		]);
		const { db } = await import("$lib/server/db");
		const { users } = await import("$lib/server/db/schema");
		db.update(users).set({ memoryEnabled: false }).run();
		const index = (await read()).readMemorySubjectIndex(
			h.userId,
			PERSONAL,
			NOW,
		);
		expect(index).toMatchObject({
			status: "off",
			subjects: [],
			currentCount: 0,
			earlier: { count: 0, preview: [] },
		});
	});
});

describe("an opened subject", () => {
	it("lists current entries most recently mentioned first, each with its last mention", async () => {
		await seedSubjectEntries(h.userId, PERSONAL, [
			entry("older", "2026-11-14", "lasting", "work_study"),
			entry("newer", "2026-11-21", "ongoing", "work_study"),
			entry("past", "2026-10-01", "temporary", "work_study"),
		]);
		const page = (await read()).listMemorySubject(
			h.userId,
			{ scope: PERSONAL, subject: "work_study", state: "current" },
			NOW,
		);
		expect(
			page.entries.map(({ text, lastMentionedAt }) => [text, lastMentionedAt]),
		).toEqual([
			["Synthetic entry newer.", new Date("2026-11-21").toISOString()],
			["Synthetic entry older.", new Date("2026-11-14").toISOString()],
		]);
		expect(page.total).toBe(2);
	});

	it("an ongoing entry quiet for 30 days says 4 weeks", async () => {
		await seedSubjectEntries(h.userId, PERSONAL, [
			entry("app", "2026-10-25T12:00:00Z", "ongoing", "projects"),
		]);
		const [app] = (await read()).listMemorySubject(
			h.userId,
			{ scope: PERSONAL, subject: "projects", state: "current" },
			NOW,
		).entries;
		expect(app).toMatchObject({ timeState: "quiet", quietWeeks: 4 });
	});

	it("an entry shows only dated earlier states and keeps its own text", async () => {
		await seedSubjectEntries(h.userId, PERSONAL, [
			entry("moved", "2026-11-20", "lasting", "home_family", {
				text: "Lives in Lisbon.",
				nativeText: "Lives in Lisbon. (2025-03-14 09:30: Lives in Budapest)",
			}),
			entry("prose", "2026-11-19", "lasting", "home_family", {
				text: "Lives in Graz, formerly in Vienna.",
			}),
		]);
		const page = (await read()).listMemorySubject(
			h.userId,
			{ scope: PERSONAL, subject: "home_family", state: "current" },
			NOW,
		);
		expect(
			page.entries.map(({ text, earlierStates }) => [text, earlierStates]),
		).toEqual([
			[
				"Lives in Lisbon.",
				[{ text: "Lives in Budapest", saidAt: "2025-03-14T09:30:00.000Z" }],
			],
			["Lives in Graz, formerly in Vienna.", []],
		]);
	});

	it("lists a subject's Earlier entries, and every Earlier entry", async () => {
		await seedSubjectEntries(h.userId, PERSONAL, [
			entry("exam", "2026-10-01", "temporary", "work_study"),
			entry("flu", "2026-09-01", "temporary", "health"),
			entry("thesis", "2026-11-20", "ongoing", "work_study"),
		]);
		const { listMemorySubject } = await read();
		expect(
			listMemorySubject(
				h.userId,
				{ scope: PERSONAL, subject: "work_study", state: "earlier" },
				NOW,
			).entries.map(({ text }) => text),
		).toEqual(["Synthetic entry exam."]);
		expect(
			listMemorySubject(
				h.userId,
				{ scope: PERSONAL, subject: "all", state: "earlier" },
				NOW,
			).entries.map(({ text, subject }) => [text, subject]),
		).toEqual([
			["Synthetic entry exam.", "work_study"],
			["Synthetic entry flu.", "health"],
		]);
	});

	it("pages a subject by 100 and refuses a cursor from another generation", async () => {
		await seedSubjectEntries(
			h.userId,
			PERSONAL,
			Array.from({ length: 150 }, (_, i) =>
				entry(
					`e${i}`,
					new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(),
					"lasting",
					"other",
				),
			),
		);
		const { listMemorySubject } = await read();
		const first = listMemorySubject(
			h.userId,
			{ scope: PERSONAL, subject: "other", state: "current" },
			NOW,
		);
		expect(first.entries).toHaveLength(100);
		expect(first.total).toBe(150);
		const second = listMemorySubject(
			h.userId,
			{
				scope: PERSONAL,
				subject: "other",
				state: "current",
				cursor: first.nextCursor ?? undefined,
			},
			NOW,
		);
		expect(second.entries).toHaveLength(50);
		expect(second.nextCursor).toBeNull();
		expect(
			new Set([...first.entries, ...second.entries].map((e) => e.ref.rowId))
				.size,
		).toBe(150);
		const { db } = await import("$lib/server/db");
		const { memoryBanks } = await import("$lib/server/db/schema");
		db.update(memoryBanks).set({ generation: "g2" }).run();
		expect(() =>
			listMemorySubject(
				h.userId,
				{
					scope: PERSONAL,
					subject: "other",
					state: "current",
					cursor: first.nextCursor ?? undefined,
				},
				NOW,
			),
		).toThrow(expect.objectContaining({ code: "stale_memory", status: 409 }));
	});

	it("refuses a subject the bank kind does not have", async () => {
		const { listMemorySubject } = await read();
		expect(() =>
			listMemorySubject(
				h.userId,
				{
					scope: PERSONAL,
					subject: "plans_status" as MemorySubject,
					state: "current",
				},
				NOW,
			),
		).toThrow(
			expect.objectContaining({ code: "invalid_subject", status: 400 }),
		);
	});
});
