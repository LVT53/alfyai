// How often is the right document outside the 120 newest, and what would other candidate rules find?
//
// Public text only (LAB_DATA = the output of ../prep.py: Belebele and WebFAQ questions with the one passage or
// answer that answers each). A library of N documents with random ages sits in a real migrated SQLite file;
// every question runs through the app's own `findRelevantArtifactsByTypesDetailed`, whose semantic shortlist is
// replaced by a recorder, so the candidate list that reaches the ranker is read off directly. No query
// embedding is passed, so the vector group of older candidates is off and only the quoted-words group works;
// the window itself is read straight from SQL.
//
//   LAB_DATA=<prep.py output> LAB_OUT=<empty dir> npx vitest run -c docs/plans/document-ranking/lab/candidates/vitest.config.ts cutoff

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import { scoreMatch } from "$lib/server/services/working-set";

const hoisted = vi.hoisted(() => ({ candidateIds: [] as string[] }));

vi.mock("$lib/server/services/semantic-ranking", () => ({
	shortlistSemanticMatchesBySubject: async (params: {
		items: Array<{ id: string }>;
	}) => {
		hoisted.candidateIds = params.items.map((item) => item.id);
		return [];
	},
}));
vi.mock("$lib/server/services/tei-reranker", () => ({
	canUseTeiReranker: () => false,
	rerankItems: async () => null,
}));

const LAB_DATA = process.env.LAB_DATA ?? "";
const LAB_OUT = process.env.LAB_OUT ?? "";
const DAY_MS = 86_400_000;
const WINDOW = 120;
const QUERIES_PER_LIBRARY = 200;

function rngFrom(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function shuffled<T>(items: T[], rng: () => number): T[] {
	const out = items.slice();
	for (let i = out.length - 1; i > 0; i -= 1) {
		const j = Math.floor(rng() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

type Doc = { id: string; text: string };
type Query = { id: string; text: string };

function readJsonl<T>(path: string): T[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as T);
}

const SPECS = [
	{
		key: "belebele-eng",
		corpus: "belebele/corpus-eng.jsonl",
		queries: "belebele/queries-eng.jsonl",
		qrels: "belebele/qrels.json",
		sizes: [400],
	},
	{
		key: "belebele-hun",
		corpus: "belebele/corpus-hun.jsonl",
		queries: "belebele/queries-hun.jsonl",
		qrels: "belebele/qrels.json",
		sizes: [400],
	},
	{
		key: "webfaq-eng",
		corpus: "webfaq-eng/corpus.jsonl",
		queries: "webfaq-eng/queries.jsonl",
		qrels: "webfaq-eng/qrels.json",
		sizes: [400, 1500],
	},
	{
		key: "webfaq-hun",
		corpus: "webfaq-hun/corpus.jsonl",
		queries: "webfaq-hun/queries.jsonl",
		qrels: "webfaq-hun/qrels.json",
		sizes: [400, 1500],
	},
] as const;

/** The pre-`preferSemanticBreadth` tokenizer, copied verbatim, to show what its LIKE filter does. */
function oldTokens(query: string): string[] {
	return Array.from(
		new Set(
			query
				.toLowerCase()
				.split(/[^a-z0-9]+/i)
				.map((token) => token.trim())
				.filter((token) => token.length >= 2)
				.slice(0, 8),
		),
	);
}

function unicodeTokens(query: string): string[] {
	return Array.from(
		new Set(
			query
				.toLowerCase()
				.split(/[^\p{L}\p{N}]+/u)
				.map((token) => token.trim())
				.filter((token) => token.length >= 2)
				.slice(0, 8),
		),
	);
}

describe("candidate cut-off lab", () => {
	it("measures", { timeout: 1_800_000 }, async () => {
		if (!LAB_DATA || !LAB_OUT) throw new Error("LAB_DATA and LAB_OUT are required");
		mkdirSync(LAB_OUT, { recursive: true });
		const dbPath = join(LAB_OUT, "cutoff-lab.db");
		for (const suffix of ["", "-wal", "-shm", "-journal"]) {
			rmSync(dbPath + suffix, { force: true });
		}
		process.env.DATABASE_PATH = dbPath;
		const sqlite = new Database(dbPath);
		sqlite.pragma("foreign_keys = ON");
		const db = drizzle(sqlite, { schema });
		migrate(db, { migrationsFolder: "./drizzle" });

		const { findRelevantArtifactsByTypesDetailed } = await import("$lib/server/services/knowledge/store/documents");

		const lines: string[] = [];
		const out = (line: string) => {
			lines.push(line);
			writeFileSync(join(LAB_OUT, "cutoff-results.txt"), `${lines.join("\n")}\n`);
		};
		out(
			"set        N     queries  newest 120 (SQL)  expected(1-120/N)  real pass, no embedding  LIKE-any,ASCII,recency  LIKE-any,Unicode,recency  LIKE admits (mean share of library)  lexical top24 + newest120  lexical top24 alone",
		);

		for (const spec of SPECS) {
			const corpus = readJsonl<Doc>(join(LAB_DATA, spec.corpus));
			const queries = readJsonl<Query>(join(LAB_DATA, spec.queries));
			const qrels = JSON.parse(
				readFileSync(join(LAB_DATA, spec.qrels), "utf8"),
			) as Record<string, string[]>;
			const textById = new Map(corpus.map((doc) => [doc.id, doc.text]));

			for (const size of spec.sizes) {
				const rng = rngFrom(20261112 + size);
				const eligible = queries.filter((q) => {
					const gold = qrels[q.id]?.[0];
					return gold !== undefined && textById.has(gold);
				});

				let chosen: string[];
				let picked: Query[];
				if (corpus.length <= size * 1.3) {
					chosen = shuffled(
						corpus.map((doc) => doc.id),
						rng,
					).slice(0, size);
					const inLibrary = new Set(chosen);
					picked = shuffled(
						eligible.filter((q) => inLibrary.has(qrels[q.id][0])),
						rng,
					).slice(0, QUERIES_PER_LIBRARY);
				} else {
					picked = shuffled(eligible, rng).slice(0, QUERIES_PER_LIBRARY);
					const goldIds = new Set(picked.map((q) => qrels[q.id][0]));
					const rest = shuffled(
						corpus.map((doc) => doc.id).filter((id) => !goldIds.has(id)),
						rng,
					).slice(0, size - goldIds.size);
					chosen = [...goldIds, ...rest];
				}

				const userId = `lab-${spec.key}-${size}`;
				const now = Date.now();
				db.insert(schema.users)
					.values({
						id: userId,
						email: `${userId}@example.com`,
						passwordHash: "hash",
						createdAt: new Date(now),
						updatedAt: new Date(now),
					})
					.run();
				db.transaction((tx) => {
					for (const id of chosen) {
						const ageDays = 1 + rng() * 59;
						const at = new Date(now - ageDays * DAY_MS);
						tx.insert(schema.artifacts)
							.values({
								id: `${userId}:${id}`,
								userId,
								conversationId: null,
								type: "normalized_document",
								retrievalClass: "durable",
								name: `doc-${id}.md`,
								mimeType: "text/markdown",
								sizeBytes: (textById.get(id) ?? "").length,
								contentText: textById.get(id) ?? "",
								createdAt: at,
								updatedAt: at,
							})
							.run();
					}
				});

				const total = chosen.length;
				let inWindow = 0;
				let inRealPass = 0;
				let likeAscii = 0;
				let likeUnicode = 0;
				let likeShare = 0;
				let lexicalPlusNewest = 0;
				let lexicalAlone = 0;
				const likeSql = (tokens: string[], count: boolean) => {
					const frags = tokens.map((t) => `%${t}%`);
					const where = frags.length
						? ` AND (${frags.map(() => "name LIKE ? OR summary LIKE ? OR content_text LIKE ?").join(" OR ")})`
						: "";
					const args = [userId, ...frags.flatMap((f) => [f, f, f])];
					const sql = count
						? `SELECT count(*) AS n FROM artifacts WHERE user_id = ? AND type = 'normalized_document'${where}`
						: `SELECT id FROM artifacts WHERE user_id = ? AND type = 'normalized_document'${where} ORDER BY updated_at DESC LIMIT ${WINDOW}`;
					return { sql, args };
				};

				const allDocs = sqlite
					.prepare(
						"SELECT id, name, content_text AS text, updated_at AS updatedAt FROM artifacts WHERE user_id = ?",
					)
					.all(userId) as Array<{ id: string; name: string; text: string; updatedAt: number }>;

				for (const q of picked) {
					const goldId = `${userId}:${qrels[q.id][0]}`;

					await findRelevantArtifactsByTypesDetailed({
						userId,
						query: q.text,
						types: ["normalized_document"],
						limit: 5,
					});
					if (hoisted.candidateIds.includes(goldId)) inRealPass += 1;
					const windowIds = (
						sqlite
							.prepare(
								`SELECT id FROM artifacts WHERE user_id = ? AND type = 'normalized_document' ORDER BY updated_at DESC LIMIT ${WINDOW}`,
							)
							.all(userId) as Array<{ id: string }>
					).map((r) => r.id);
					if (windowIds.includes(goldId)) inWindow += 1;

					const ascii = likeSql(oldTokens(q.text), false);
					const asciiIds = (sqlite.prepare(ascii.sql).all(...ascii.args) as Array<{ id: string }>).map((r) => r.id);
					if (asciiIds.includes(goldId)) likeAscii += 1;
					const uni = likeSql(unicodeTokens(q.text), false);
					const uniIds = (sqlite.prepare(uni.sql).all(...uni.args) as Array<{ id: string }>).map((r) => r.id);
					if (uniIds.includes(goldId)) likeUnicode += 1;
					const admit = likeSql(unicodeTokens(q.text), true);
					const admitted = (sqlite.prepare(admit.sql).get(...admit.args) as { n: number }).n;
					likeShare += admitted / total;

					// The lexical top 24 over the WHOLE library, by the app's own scoreMatch.
					const scored = allDocs
						.map((doc) => ({
							id: doc.id,
							updatedAt: doc.updatedAt,
							score: scoreMatch(q.text, `${doc.name}\n\n${doc.text}`),
						}))
						.filter((entry) => entry.score > 0)
						.sort((a, b) =>
							b.score !== a.score ? b.score - a.score : b.updatedAt - a.updatedAt,
						)
						.slice(0, 24)
						.map((entry) => entry.id);
					if (scored.includes(goldId)) lexicalAlone += 1;
					if (scored.includes(goldId) || windowIds.includes(goldId)) {
						lexicalPlusNewest += 1;
					}
				}

				const n = picked.length;
				const pct = (value: number) => `${((100 * value) / n).toFixed(1)}%`;
				out(
					[
						spec.key.padEnd(12),
						String(total).padStart(5),
						String(n).padStart(7),
						pct(inWindow).padStart(12),
						`${(100 * Math.min(1, WINDOW / total)).toFixed(1)}%`.padStart(18),
						pct(inRealPass).padStart(18),
						pct(likeAscii).padStart(20),
						pct(likeUnicode).padStart(22),
						`${((100 * likeShare) / n).toFixed(1)}%`.padStart(30),
						pct(lexicalPlusNewest).padStart(22),
						pct(lexicalAlone).padStart(18),
					].join("  "),
				);
			}
		}
		sqlite.close();
	});
});
