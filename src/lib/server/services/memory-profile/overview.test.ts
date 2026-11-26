// @always-run: scans the source tree for disallowed imports.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryKind, MemoryScope, MemorySubject } from "$lib/memory-types";
import { bootEngine, type EngineHarness } from "../jobs/testing/harness";
import type { CurationCallOptions, CurationModel } from "./curation";
import {
	type SyntheticEntry,
	seedSubjectEntries,
} from "./subject-read.test-helpers";

let h: EngineHarness;
beforeEach(async () => {
	h = await bootEngine("memory-overview");
});
afterEach(() => {
	vi.restoreAllMocks();
	h.cleanup();
});

const NOW = new Date("2026-11-24T12:00:00Z");
const PERSONAL: MemoryScope = { kind: "personal" };

function entry(
	id: string,
	text: string,
	said: string,
	kind: MemoryKind | null,
	subject: MemorySubject | null,
): SyntheticEntry {
	return { id, text, said, kind, subject };
}

interface Call {
	prompt: string;
	input: {
		entries: Array<{ text: string; subject?: string }>;
	} & Record<string, unknown>;
	call?: CurationCallOptions;
}
function recordingModel(
	answer: (calls: Call[]) => string | Promise<string> = () =>
		"A short synthetic overview.",
) {
	const calls: Call[] = [];
	const model: CurationModel = async (
		prompt,
		input,
		_schema,
		_thinking,
		_assertCurrent,
		call,
	) => {
		calls.push({ prompt, input: input as Call["input"], call });
		return { overview: await answer(calls) };
	};
	return { calls, model };
}

async function modules() {
	const { db } = await import("$lib/server/db");
	const s = await import("$lib/server/db/schema");
	const overview = await import("./overview");
	return { db, s, overview };
}

const BASICS = [
	entry(
		"lang",
		"Speaks three languages.",
		"2026-11-20",
		"lasting",
		"about_you",
	),
	entry(
		"shed",
		"Is building a garden shed.",
		"2026-11-18",
		"ongoing",
		"projects",
	),
	entry(
		"choir",
		"Sings in a choir on Thursdays.",
		"2026-10-25T12:00:00Z",
		"ongoing",
		"interests",
	),
	entry("cold", "Had a cold.", "2026-09-01", "temporary", "health"),
];

async function storedRows() {
	const { db, s } = await modules();
	return db.select().from(s.memoryOverviews).all();
}

describe("writing the Overview", () => {
	it("writes only from the entries the page shows as current", async () => {
		await seedSubjectEntries(h.userId, PERSONAL, BASICS);
		const { overview } = await modules();
		const { calls, model } = recordingModel();
		const written = await overview.writeMemoryOverview(h.userId, PERSONAL, {
			rewrite: false,
			model,
			now: NOW,
		});
		expect(calls).toHaveLength(1);
		const texts = calls[0].input.entries.map(({ text }) => text);
		expect(texts).toEqual([
			"Speaks three languages.",
			"Is building a garden shed.",
			"Sings in a choir on Thursdays.",
		]);
		expect(JSON.stringify(calls[0].input)).not.toContain("cold");
		expect(written).toMatchObject({
			state: "written",
			text: "A short synthetic overview.",
			currentCount: 3,
			writtenFrom: 3,
		});
		expect(calls[0].call).toEqual({ readBy: "person" });
	});

	it("keeps a written Overview until something changes, without another call", async () => {
		await seedSubjectEntries(h.userId, PERSONAL, BASICS);
		const { overview } = await modules();
		const { calls, model } = recordingModel();
		await overview.writeMemoryOverview(h.userId, PERSONAL, {
			rewrite: false,
			model,
			now: NOW,
		});
		const again = await overview.writeMemoryOverview(h.userId, PERSONAL, {
			rewrite: false,
			model,
			now: NOW,
		});
		expect(calls).toHaveLength(1);
		expect(again.state).toBe("written");
		expect(overview.readMemoryOverview(h.userId, PERSONAL, NOW)).toMatchObject({
			state: "written",
			text: "A short synthetic overview.",
		});
	});

	it("a rewrite replaces the stored text and keeps no earlier one", async () => {
		await seedSubjectEntries(h.userId, PERSONAL, BASICS);
		const { overview } = await modules();
		const { model } = recordingModel(
			(calls) => `Overview number ${calls.length}.`,
		);
		await overview.writeMemoryOverview(h.userId, PERSONAL, {
			rewrite: false,
			model,
			now: NOW,
		});
		const rewritten = await overview.writeMemoryOverview(h.userId, PERSONAL, {
			rewrite: true,
			model,
			now: NOW,
		});
		expect(rewritten.text).toBe("Overview number 2.");
		expect((await storedRows()).map(({ text }) => text)).toEqual([
			"Overview number 2.",
		]);
	});

	it("after a removal the stored Overview is gone and a rewrite never sees the removed text", async () => {
		const bank = await seedSubjectEntries(h.userId, PERSONAL, BASICS);
		const { db, s, overview } = await modules();
		const { calls, model } = recordingModel();
		await overview.writeMemoryOverview(h.userId, PERSONAL, {
			rewrite: false,
			model,
			now: NOW,
		});
		expect(await storedRows()).toHaveLength(1);
		db.insert(s.memoryRevocations)
			.values({
				id: "remove-shed",
				userId: h.userId,
				bankId: bank.id,
				epoch: bank.epoch,
				sourceId: `s-${bank.id}-shed`,
			})
			.run();
		expect(await storedRows()).toHaveLength(0);
		expect(overview.readMemoryOverview(h.userId, PERSONAL, NOW)).toMatchObject({
			state: "none",
			currentCount: 2,
		});
		await overview.writeMemoryOverview(h.userId, PERSONAL, {
			rewrite: true,
			model,
			now: NOW,
		});
		expect(JSON.stringify(calls[1].input)).not.toContain("garden shed");
	});

	it("a big scope is written from its most recent entries that fit and says so", async () => {
		const long = "Remembers one detail about a plain everyday matter. ".repeat(
			8,
		);
		await seedSubjectEntries(
			h.userId,
			PERSONAL,
			Array.from({ length: 300 }, (_, i) =>
				entry(
					`e${i}`,
					`${i}: ${long}`,
					new Date(NOW.getTime() - i * 3_600_000).toISOString(),
					"lasting",
					"other",
				),
			),
		);
		const { overview } = await modules();
		const { calls, model } = recordingModel();
		const written = await overview.writeMemoryOverview(h.userId, PERSONAL, {
			rewrite: false,
			model,
			now: NOW,
		});
		expect(written.currentCount).toBe(300);
		expect(written.writtenFrom).toBeGreaterThan(0);
		expect(written.writtenFrom).toBeLessThan(300);
		const texts = calls[0].input.entries.map(({ text }) => text);
		expect(texts).toHaveLength(written.writtenFrom ?? -1);
		// The most recently mentioned ones, newest first.
		expect(texts[0].startsWith("0: ")).toBe(true);
		expect(texts.at(-1)?.startsWith(`${texts.length - 1}: `)).toBe(true);
		// What fits is measured on the entries as the model receives them.
		const { estimateTokenCount } = await import("$lib/utils/tokens");
		expect(
			estimateTokenCount(JSON.stringify(calls[0].input.entries)),
		).toBeLessThanOrEqual(overview.OVERVIEW_INPUT_TOKEN_BUDGET);
	});

	it("writes in the account's language and names no other", async () => {
		await seedSubjectEntries(h.userId, PERSONAL, BASICS);
		const { db, s, overview } = await modules();
		const { calls, model } = recordingModel();
		await overview.writeMemoryOverview(h.userId, PERSONAL, {
			rewrite: true,
			model,
			now: NOW,
		});
		db.update(s.users)
			.set({ uiLanguage: "hu" })
			.where(eq(s.users.id, h.userId))
			.run();
		await overview.writeMemoryOverview(h.userId, PERSONAL, {
			rewrite: true,
			model,
			now: NOW,
		});
		expect(calls[0].prompt).toContain("Write the paragraph in English.");
		expect(calls[0].prompt).not.toContain("Hungarian");
		expect(calls[1].prompt).toContain("Write the paragraph in Hungarian.");
		expect(calls[1].prompt).not.toContain("English");
	});

	// The person waits for the sheet, so the call must overtake background work
	// in the gateway's queue and wait in the account's own lane.
	it("asks the memory model as the person's interactive call, in the account's own lane", async () => {
		await seedSubjectEntries(h.userId, PERSONAL, BASICS);
		const cfg = await import("$lib/server/config-store");
		vi.spyOn(cfg, "getConfig").mockReturnValue({
			...cfg.getConfig(),
			hindsightCurationGatewayModel: "qwen3-6-27b",
			hindsightInferenceKey: "private-gateway-key",
		});
		const endpoints = await import("./private-endpoint");
		const transport = vi
			.spyOn(endpoints, "fetchPrivateMemory")
			.mockImplementation(async () =>
				Response.json({
					id: "synthetic",
					model: "qwen3-6-27b",
					choices: [
						{
							index: 0,
							message: {
								role: "assistant",
								content: JSON.stringify({ overview: "A synthetic overview." }),
							},
							finish_reason: "stop",
						},
					],
				}),
			);
		const { db, s, overview } = await modules();
		const { memoryAdmissionHeaders } = await import("./admission");
		const account = db
			.select({ tenantId: s.memoryAccounts.tenantId })
			.from(s.memoryAccounts)
			.where(eq(s.memoryAccounts.userId, h.userId))
			.get();
		expect(account?.tenantId).toBeTruthy();
		const written = await overview.writeMemoryOverview(h.userId, PERSONAL, {
			rewrite: true,
			now: NOW,
		});
		expect(written.text).toBe("A synthetic overview.");
		expect(transport).toHaveBeenCalledOnce();
		const headers = new Headers(transport.mock.calls[0]?.[1]?.headers);
		const expected = memoryAdmissionHeaders({
			priority: "interactive",
			tenantId: account?.tenantId ?? null,
		});
		expect(headers.get("x-alfyai-admission-priority")).toBe("interactive");
		expect(headers.get("x-alfyai-admission-wait-ms")).toBe("120000");
		expect(headers.get("x-alfyai-admission-lane")).toBe(
			expected["X-AlfyAI-Admission-Lane"],
		);
	});

	// The prompt for each scope kind and language, as the model receives it.
	async function overviewPrompts() {
		const { overview } = await modules();
		const prompts: Array<{
			scopeKind: "personal" | "project";
			language: "en" | "hu";
			prompt: string;
		}> = [];
		for (const scopeKind of ["personal", "project"] as const)
			for (const language of ["en", "hu"] as const) {
				const { calls, model } = recordingModel();
				await overview.composeMemoryOverview(
					{ scopeKind, name: "Kata", language, entries: [] },
					model,
				);
				prompts.push({ scopeKind, language, prompt: calls[0].prompt });
			}
		return prompts;
	}

	it("names the language once, in plain ASCII, for every scope and language", async () => {
		for (const { language, prompt } of await overviewPrompts()) {
			expect(prompt.match(/English|Hungarian/g)).toHaveLength(1);
			expect(prompt).toContain(
				`Write the paragraph in ${language === "hu" ? "Hungarian" : "English"}.`,
			);
			expect(prompt).toMatch(/^[\x20-\x7e\n]+$/);
		}
	});

	// From the 2026-11-24 Hungarian probe (docs/plans/hindsight-memory/
	// overview-hungarian-2026-11-24.md): a time moved between entries, and a
	// name lost its accent.
	it("keeps every name as written and each detail with its entry", async () => {
		for (const { prompt } of await overviewPrompts()) {
			expect(prompt).toContain(
				"translate any term in the entries into it, but keep every name exactly as written, accents included",
			);
			expect(prompt).toContain(
				"never move a time, place, name or number to another entry",
			);
		}
	});

	// The probe's "freelance" stayed in 14 of 15 Hungarian paragraphs under a
	// line that named it as an example, so the rule is general: no word of any
	// language is named, only what makes a word borrowed (it is spelt the way
	// another language spells it) and that common use does not excuse it.
	it("asks for the language's own word in place of a borrowed one, however common, and names no example word", async () => {
		for (const { prompt } of await overviewPrompts()) {
			const rule = prompt
				.split("\n")
				.find((line) => /another language/.test(line));
			expect(rule).toBeDefined();
			expect(rule).toContain("however common it has become");
			expect(rule).toContain("spelt the way");
			expect(rule).toContain(
				"this language's own everyday word for the same thing",
			);
			expect(rule).toContain("only when there is none");
			expect(rule).not.toMatch(/such as|for example|e\.g\./i);
			expect(prompt).not.toMatch(/freelance|deadline|boulder|sci-fi/i);
			expect(prompt).not.toContain("gets the paragraph's own word");
		}
	});

	// The first Overview left entries out on purpose ("the least important
	// ones"); the owner wants none dropped (Config 3 round of the probe note).
	it("asks to cover every subject and leave no entry out, in as many sentences as that takes up to ten", async () => {
		for (const { prompt } of await overviewPrompts()) {
			expect(prompt).toContain(
				"Cover every subject the entries are filed under, with at least one short, plain sentence for each",
			);
			expect(prompt).toContain(
				"leave no entry out: when a subject has several small entries, name each in a few words within one sentence rather than dropping any",
			);
			expect(prompt).toContain(
				"Use as many sentences as that takes, never more than ten, each one simple, with no fact twice",
			);
			expect(prompt).toContain(
				"no headings, lists, quotation marks or emphasis",
			);
			expect(prompt).toContain(
				"Never mention memory, entries, lists or this task.",
			);
			expect(prompt).not.toMatch(
				/least important|need not mention every entry/,
			);
			expect(prompt).not.toMatch(/three to six|never more than six/);
		}
	});

	// With no entry left out, a big scope's paragraph is long: 104 synthetic
	// entries gave 1,800 to 2,750 characters (Config 3 round of the probe note),
	// so a guard of 3,000 would refuse the sheet's write at about 110 entries.
	it("accepts the long paragraph of a big scope and still refuses a runaway one", async () => {
		const { overview } = await modules();
		const input = {
			scopeKind: "personal",
			name: "Kata",
			language: "en",
			entries: [],
		} as const;
		const big = recordingModel(() => "x".repeat(6_000));
		await expect(
			overview.composeMemoryOverview(input, big.model),
		).resolves.toHaveLength(6_000);
		const runaway = recordingModel(() => "x".repeat(6_001));
		await expect(
			overview.composeMemoryOverview(input, runaway.model),
		).rejects.toMatchObject({
			code: "memory_overview_invalid",
			retryable: true,
		});
	});

	it("gives the model each entry's subject, which the rule to cover every subject reads", async () => {
		await seedSubjectEntries(h.userId, PERSONAL, BASICS);
		const { overview } = await modules();
		const { calls, model } = recordingModel();
		await overview.writeMemoryOverview(h.userId, PERSONAL, {
			rewrite: false,
			model,
			now: NOW,
		});
		expect(calls[0].input.entries.map(({ subject }) => subject)).toEqual([
			"About the person",
			"Projects",
			"Interests",
		]);
	});

	it("the prompt the app writes is ASCII English", async () => {
		await seedSubjectEntries(h.userId, PERSONAL, BASICS);
		const { db, s, overview } = await modules();
		db.update(s.users)
			.set({ uiLanguage: "hu" })
			.where(eq(s.users.id, h.userId))
			.run();
		const { calls, model } = recordingModel();
		await overview.writeMemoryOverview(h.userId, PERSONAL, {
			rewrite: true,
			model,
			now: NOW,
		});
		expect(calls[0].prompt).toMatch(/^[\x20-\x7e\n]+$/);
		const keys = JSON.stringify(Object.keys(calls[0].input));
		expect(keys).toMatch(/^[\x20-\x7e]+$/);
	});

	it("two writes at once share one model call", async () => {
		await seedSubjectEntries(h.userId, PERSONAL, BASICS);
		const { overview } = await modules();
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { calls, model } = recordingModel(async () => {
			await held;
			return "Written once.";
		});
		const first = overview.writeMemoryOverview(h.userId, PERSONAL, {
			rewrite: true,
			model,
			now: NOW,
		});
		const second = overview.writeMemoryOverview(h.userId, PERSONAL, {
			rewrite: true,
			model,
			now: NOW,
		});
		release();
		expect((await first).text).toBe("Written once.");
		expect((await second).text).toBe("Written once.");
		expect(calls).toHaveLength(1);
	});

	it("an entry removed while writing is never stored or shown", async () => {
		const bank = await seedSubjectEntries(h.userId, PERSONAL, BASICS);
		const { db, s, overview } = await modules();
		const { calls, model } = recordingModel((made) => {
			if (made.length === 1)
				db.insert(s.memoryRevocations)
					.values({
						id: "remove-shed-mid-write",
						userId: h.userId,
						bankId: bank.id,
						epoch: bank.epoch,
						sourceId: `s-${bank.id}-shed`,
					})
					.run();
			return `Written from ${made.at(-1)?.input.entries.length} entries.`;
		});
		const written = await overview.writeMemoryOverview(h.userId, PERSONAL, {
			rewrite: true,
			model,
			now: NOW,
		});
		expect(calls).toHaveLength(2);
		expect(JSON.stringify(calls[1].input)).not.toContain("garden shed");
		expect(written).toMatchObject({
			text: "Written from 2 entries.",
			writtenFrom: 2,
		});
		expect((await storedRows()).map(({ text }) => text)).toEqual([
			"Written from 2 entries.",
		]);
	});

	it("refuses an empty scope without a model call", async () => {
		const { overview } = await modules();
		const { calls, model } = recordingModel();
		await expect(
			overview.writeMemoryOverview(h.userId, PERSONAL, {
				rewrite: false,
				model,
				now: NOW,
			}),
		).rejects.toMatchObject({ code: "overview_empty", status: 409 });
		expect(calls).toHaveLength(0);
	});
});

describe("nothing is stored after an entry changes", () => {
	async function written() {
		const bank = await seedSubjectEntries(h.userId, PERSONAL, BASICS);
		const { db, s, overview } = await modules();
		await overview.writeMemoryOverview(h.userId, PERSONAL, {
			rewrite: false,
			model: recordingModel().model,
			now: NOW,
		});
		expect(await storedRows()).toHaveLength(1);
		return { bank, db, s };
	}

	it("a new publication", async () => {
		const { bank, db, s } = await written();
		db.update(s.memoryBanks)
			.set({ generation: "g2" })
			.where(eq(s.memoryBanks.id, bank.id))
			.run();
		expect(await storedRows()).toHaveLength(0);
	});

	it("a source withdrawn", async () => {
		const { bank, db, s } = await written();
		db.update(s.memorySourceRevisions)
			.set({ state: "revoked" })
			.where(eq(s.memorySourceRevisions.id, `s-${bank.id}-lang`))
			.run();
		expect(await storedRows()).toHaveLength(0);
	});

	it("a label changed", async () => {
		const { bank, db, s } = await written();
		db.update(s.memoryFactLabels)
			.set({ kind: "temporary" })
			.where(eq(s.memoryFactLabels.bankId, bank.id))
			.run();
		expect(await storedRows()).toHaveLength(0);
	});

	it("Clear Memory or erasure (a new epoch)", async () => {
		const { db, s } = await written();
		db.update(s.memoryAccounts)
			.set({ epoch: 1 })
			.where(eq(s.memoryAccounts.userId, h.userId))
			.run();
		expect(await storedRows()).toHaveLength(0);
	});

	it("Memory switched off", async () => {
		const { db, s } = await written();
		db.update(s.users)
			.set({ memoryEnabled: false })
			.where(eq(s.users.id, h.userId))
			.run();
		expect(await storedRows()).toHaveLength(0);
	});

	it("the bank deleted", async () => {
		const { bank, db, s } = await written();
		db.delete(s.memoryBanks).where(eq(s.memoryBanks.id, bank.id)).run();
		expect(await storedRows()).toHaveLength(0);
	});

	// The model is given each entry's kind and subject, so the read-time check
	// covers them too, whichever way a label changed (the trigger is set aside
	// here to show the check alone).
	it.each([
		["kind", { kind: "lasting" }],
		["subject", { subject: "health" }],
	] as const)(
		"an entry whose %s changed under the same text is discarded when the Overview is next read",
		async (_name, change) => {
			const { bank, db, s } = await written();
			const { and, eq, sql } = await import("drizzle-orm");
			db.run(sql`DROP TRIGGER memory_overview_label_update`);
			db.update(s.memoryFactLabels)
				.set(change)
				.where(
					and(
						eq(s.memoryFactLabels.bankId, bank.id),
						eq(s.memoryFactLabels.nativeFactId, "f-shed"),
					),
				)
				.run();
			expect(await storedRows()).toHaveLength(1);
			const { overview } = await modules();
			expect(
				overview.readMemoryOverview(h.userId, PERSONAL, NOW),
			).toMatchObject({ state: "none", currentCount: 3 });
			expect(await storedRows()).toHaveLength(0);
		},
	);

	it("an entry aged into Earlier is discarded when the Overview is next read", async () => {
		await written();
		const { overview } = await modules();
		const later = new Date(NOW.getTime() + 120 * 86_400_000);
		expect(
			overview.readMemoryOverview(h.userId, PERSONAL, later),
		).toMatchObject({ state: "none" });
		expect(await storedRows()).toHaveLength(0);
	});
});

it("only the Overview's own module reads its table, so it never reaches a chat", () => {
	const root = join(process.cwd(), "src");
	const allowed = new Set([
		"lib/server/db/schema.ts",
		"lib/server/services/memory-profile/overview.ts",
		"lib/server/services/account-lifecycle/user-scoped-tables.ts",
	]);
	const readers: string[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path);
			else if (
				/\.(ts|svelte)$/.test(name) &&
				!/\.test(-helpers)?\.ts$/.test(name) &&
				/\bmemoryOverviews\b|\bmemory_overviews\b/.test(
					readFileSync(path, "utf8"),
				)
			)
				readers.push(relative(root, path));
		}
	};
	walk(root);
	expect(readers.filter((file) => !allowed.has(file))).toEqual([]);
});
