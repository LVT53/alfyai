// The queries the embedder is weakest at (an exact phrase, a few rare words) against a library of Hungarian
// news articles (public HunSum text), built the way the ranking lab's sets P and K were. Which older-candidate
// rules find the document? No query embedding is passed, so "real pass" is the quoted-words group alone.
//
//   LAB_DATA=<prep.py output> LAB_OUT=<empty dir> npx vitest run -c docs/plans/document-ranking/lab/candidates/vitest.config.ts keywords

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

function unicodeTokens(query: string): string[] {
	return Array.from(
		new Set(
			query
				.toLowerCase()
				.split(/[^\p{L}\p{N}]+/u)
				.map((token) => token.trim())
				.filter((token) => token.length >= 3)
				.slice(0, 8),
		),
	);
}

describe("keyword and phrase lab", () => {
	it("measures", { timeout: 1_800_000 }, async () => {
		if (!LAB_DATA || !LAB_OUT) throw new Error("LAB_DATA and LAB_OUT are required");
		mkdirSync(LAB_OUT, { recursive: true });
		const dbPath = join(LAB_OUT, "keywords-lab.db");
		for (const suffix of ["", "-wal", "-shm", "-journal"]) {
			rmSync(dbPath + suffix, { force: true });
		}
		process.env.DATABASE_PATH = dbPath;
		const sqlite = new Database(dbPath);
		sqlite.pragma("foreign_keys = ON");
		const db = drizzle(sqlite, { schema });
		migrate(db, { migrationsFolder: "./drizzle" });
		const { findRelevantArtifactsByTypesDetailed } = await import("$lib/server/services/knowledge/store/documents");

		const corpus = readFileSync(join(LAB_DATA, "hunsum/corpus.jsonl"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { id: string; text: string });
		const textById = new Map(corpus.map((doc) => [doc.id, doc.text]));
		const reservoir = corpus
			.filter((doc) => doc.text.length >= 800 && doc.text.length <= 8000)
			.map((doc) => doc.id);

		const lines: string[] = [];
		const out = (line: string) => {
			lines.push(line);
			writeFileSync(join(LAB_OUT, "keywords-results.txt"), `${lines.join("\n")}\n`);
		};
		out(
			"kind       N   queries  newest 120 (SQL)  real pass, no embedding  LIKE-any,Unicode,recency  LIKE-ALL words (SQL), newest 24 of the matches  ... share of library it admits  lexical top24 (scoreMatch, whole library)",
		);

		for (const size of [400, 1500]) {
			const rng = rngFrom(555 + size);
			const golds = shuffled(reservoir, rng).slice(0, 120);
			const goldSet = new Set(golds);
			const rest = shuffled(
				corpus.map((doc) => doc.id).filter((id) => !goldSet.has(id)),
				rng,
			).slice(0, size - golds.length);
			const chosen = [...golds, ...rest];

			const userId = `lab-kw-${size}`;
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
					const at = new Date(now - (1 + rng() * 59) * DAY_MS);
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
			const allDocs = sqlite
				.prepare(
					"SELECT id, name, content_text AS text, updated_at AS updatedAt FROM artifacts WHERE user_id = ?",
				)
				.all(userId) as Array<{ id: string; name: string; text: string; updatedAt: number }>;

			const pairs: Array<{ kind: string; query: string; gold: string }> = [];
			for (const id of golds.slice(0, 60)) {
				const words = (textById.get(id) ?? "").split(/\s+/).filter(Boolean);
				const lo = Math.floor(words.length / 4);
				const hi = Math.max(lo + 1, Math.floor((3 * words.length) / 4) - 6);
				const start = lo + Math.floor(rng() * (hi - lo));
				pairs.push({ kind: "P phrase", query: words.slice(start, start + 6).join(" "), gold: id });
			}
			for (const id of golds.slice(60, 120)) {
				const low = (textById.get(id) ?? "").toLowerCase();
				const strip = (w: string) => w.replace(/^[.,;:!?()"'„”]+|[.,;:!?()"'„”]+$/g, "");
				const candidates = Array.from(
					new Set(
						low
							.split(/\s+/)
							.map(strip)
							.filter((w) => w.length >= 6),
					),
				)
					.sort()
					.slice(0, 80);
				const others = shuffled(reservoir, rng)
					.slice(0, 300)
					.map((x) => (textById.get(x) ?? "").toLowerCase());
				const df = new Map(
					candidates.map((w) => [w, others.reduce((n, o) => n + (o.includes(w) ? 1 : 0), 0)]),
				);
				const rare = candidates.sort((a, b) => (df.get(a) ?? 0) - (df.get(b) ?? 0)).slice(0, 3);
				pairs.push({ kind: "K 3 rare", query: rare.join(" "), gold: id });
			}

			for (const kind of ["P phrase", "K 3 rare"]) {
				const subset = pairs.filter(
					(p) => p.kind === kind && unicodeTokens(p.query).length > 0,
				);
				let inWindow = 0;
				let inRealPass = 0;
				let likeAny = 0;
				let likeAll = 0;
				let likeAllAdmit = 0;
				let lexical = 0;
				for (const pair of subset) {
					const goldId = `${userId}:${pair.gold}`;
					await findRelevantArtifactsByTypesDetailed({
						userId,
						query: pair.query,
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

					const tokens = unicodeTokens(pair.query);
					const frags = tokens.map((t) => `%${t}%`);
					const anySql = `SELECT id FROM artifacts WHERE user_id = ? AND type = 'normalized_document' AND (${frags.map(() => "name LIKE ? OR summary LIKE ? OR content_text LIKE ?").join(" OR ")}) ORDER BY updated_at DESC LIMIT ${WINDOW}`;
					const anyIds = (
						sqlite.prepare(anySql).all(userId, ...frags.flatMap((f) => [f, f, f])) as Array<{ id: string }>
					).map((r) => r.id);
					if (anyIds.includes(goldId)) likeAny += 1;

					const allWhere = frags.map(() => "(name LIKE ? OR summary LIKE ? OR content_text LIKE ?)").join(" AND ");
					const allArgs = frags.flatMap((f) => [f, f, f]);
					const allIds = (
						sqlite
							.prepare(
								`SELECT id FROM artifacts WHERE user_id = ? AND type = 'normalized_document' AND ${allWhere} ORDER BY updated_at DESC LIMIT 24`,
							)
							.all(userId, ...allArgs) as Array<{ id: string }>
					).map((r) => r.id);
					if (allIds.includes(goldId)) likeAll += 1;
					likeAllAdmit +=
						(
							sqlite
								.prepare(
									`SELECT count(*) AS n FROM artifacts WHERE user_id = ? AND type = 'normalized_document' AND ${allWhere}`,
								)
								.get(userId, ...allArgs) as { n: number }
						).n / chosen.length;

					const top = allDocs
						.map((doc) => ({
							id: doc.id,
							updatedAt: doc.updatedAt,
							score: scoreMatch(pair.query, `${doc.name}\n\n${doc.text}`),
						}))
						.filter((e) => e.score > 0)
						.sort((a, b) => (b.score !== a.score ? b.score - a.score : b.updatedAt - a.updatedAt))
						.slice(0, 24)
						.map((e) => e.id);
					if (top.includes(goldId)) lexical += 1;
				}
				const n = subset.length;
				const pct = (v: number) => `${((100 * v) / n).toFixed(1)}%`;
				out(
					[
						kind.padEnd(9),
						String(chosen.length).padStart(5),
						String(n).padStart(6),
						pct(inWindow).padStart(14),
						pct(inRealPass).padStart(18),
						pct(likeAny).padStart(22),
						pct(likeAll).padStart(40),
						`${((100 * likeAllAdmit) / n).toFixed(2)}%`.padStart(26),
						pct(lexical).padStart(30),
					].join("  "),
				);
			}
		}
		sqlite.close();
	});
});
