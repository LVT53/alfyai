// What does a search cost, and what does looking at every older document's stored vector cost on its own?
//
// A real migrated SQLite file with N documents of about 20 KB each (public HunSum text) and one stored
// vector per document, written the way the app writes them (TEI's shortest float32 decimals, JSON text).
// The app's own modules run unmodified: `findRelevantArtifactsByTypesDetailed` for the whole search (which
// now includes the older-candidates pass whenever N is over 120; N = 120 is the window alone), and
// `shortlistSemanticMatchesBySubject` over the older documents for the vector scan by itself, step by
// step. The query vector is passed in, so no embedder is needed. Times are wall-clock milliseconds on the
// machine it runs on.
//
//   LAB_DATA=<prep.py output> LAB_OUT=<empty dir> npx vitest run -c docs/plans/document-ranking/lab/candidates/vitest.config.ts cost

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, it } from "vitest";
import * as schema from "$lib/server/db/schema";
import { cosineSimilarity } from "$lib/server/utils/math";

const LAB_DATA = process.env.LAB_DATA ?? "";
const LAB_OUT = process.env.LAB_OUT ?? "";
const DAY_MS = 86_400_000;
const WINDOW = 120;
const MODEL = "lab-embedder";

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

/** TEI prints a float32 as its shortest decimal; the app stores what it parsed from that. */
function float32Decimal(x: number): number {
	const f = Math.fround(x);
	for (let digits = 1; digits <= 9; digits += 1) {
		const candidate = Number(f.toPrecision(digits));
		if (Math.fround(candidate) === f) return candidate;
	}
	return f;
}

function randomUnitVector(dimensions: number, rng: () => number): number[] {
	const raw: number[] = [];
	for (let i = 0; i < dimensions; i += 1) {
		const u = Math.max(rng(), 1e-12);
		const v = rng();
		raw.push(Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
	}
	const norm = Math.sqrt(raw.reduce((sum, x) => sum + x * x, 0));
	return raw.map((x) => float32Decimal(x / norm));
}

function median(values: number[]): number {
	const sorted = values.slice().sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}
function p95(values: number[]): number {
	const sorted = values.slice().sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}

describe("older-document scan cost lab", () => {
	it("measures", { timeout: 3_000_000 }, async () => {
		if (!LAB_DATA || !LAB_OUT) throw new Error("LAB_DATA and LAB_OUT are required");
		mkdirSync(LAB_OUT, { recursive: true });
		const dbPath = join(LAB_OUT, "timing-lab.db");
		for (const suffix of ["", "-wal", "-shm", "-journal"]) {
			rmSync(dbPath + suffix, { force: true });
		}
		process.env.DATABASE_PATH = dbPath;
		process.env.TEI_EMBEDDER_URL = "http://127.0.0.1:9";
		process.env.TEI_EMBEDDER_MODEL = MODEL;
		process.env.TEI_EMBEDDER_DIMENSIONS = "0";
		const sqlite = new Database(dbPath);
		sqlite.pragma("foreign_keys = ON");
		const db = drizzle(sqlite, { schema });
		migrate(db, { migrationsFolder: "./drizzle" });

		const { findRelevantArtifactsByTypesDetailed } = await import("$lib/server/services/knowledge/store/documents");
		const { shortlistSemanticMatchesBySubject } = await import(
			"$lib/server/services/semantic-ranking"
		);
		const { listSemanticEmbeddingsBySubject } = await import(
			"$lib/server/services/semantic-embeddings"
		);
		const { scoreMatch } = await import("$lib/server/services/working-set");

		const articles = readFileSync(join(LAB_DATA, "hunsum/corpus.jsonl"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => (JSON.parse(line) as { text: string }).text);

		const lines: string[] = [];
		const out = (line: string) => {
			lines.push(line);
			writeFileSync(join(LAB_OUT, "timing-results.txt"), `${lines.join("\n")}\n`);
		};
		out(
			"dims    N   whole search | vector scan alone: ids  read(SQL)  JSON.parse  cosine+sort  TOTAL(app code) | vector scan as a share of the search | AND-LIKE rare words (SQL)  full-text scan in JS",
		);

		const REPS = 15;
		for (const dimensions of [1024, 2560]) {
			for (const size of [120, 400, 1500, 5000]) {
				const rng = rngFrom(99 + size + dimensions);
				const userId = `lab-timing-${dimensions}-${size}`;
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

				// 300 distinct vectors reused round-robin: parse time does not depend on the values.
				const vectorJson = Array.from({ length: 300 }, () =>
					JSON.stringify(randomUnitVector(dimensions, rng)),
				);
				const queryVector = randomUnitVector(dimensions, rng);
				const ids: string[] = [];
				db.transaction((tx) => {
					for (let i = 0; i < size; i += 1) {
						const id = `${userId}:${i}`;
						ids.push(id);
						const at = new Date(now - (1 + rng() * 59) * DAY_MS);
						let text = "";
						while (text.length < 20_000) {
							text += `${articles[Math.floor(rng() * articles.length)]}\n\n`;
						}
						tx.insert(schema.artifacts)
							.values({
								id,
								userId,
								conversationId: null,
								type: "normalized_document",
								retrievalClass: "durable",
								name: `doc-${i}.md`,
								mimeType: "text/markdown",
								sizeBytes: text.length,
								contentText: text,
								createdAt: at,
								updatedAt: at,
							})
							.run();
						tx.insert(schema.semanticEmbeddings)
							.values({
								id: `${id}:e`,
								userId,
								subjectType: "artifact",
								subjectId: id,
								modelName: MODEL,
								sourceTextHash: "x",
								dimensions,
								embeddingJson: vectorJson[i % vectorJson.length],
								createdAt: new Date(now),
								updatedAt: new Date(now),
							})
							.run();
					}
				});

				const newest = sqlite
					.prepare(
						"SELECT id FROM artifacts WHERE user_id = ? AND type = 'normalized_document' ORDER BY updated_at DESC LIMIT ?",
					)
					.all(userId, WINDOW) as Array<{ id: string }>;
				const newestIds = new Set(newest.map((row) => row.id));

				const times = {
					today: [] as number[],
					ids: [] as number[],
					read: [] as number[],
					parse: [] as number[],
					cosine: [] as number[],
					total: [] as number[],
					like: [] as number[],
					jsScan: [] as number[],
				};
				const query = "what does the contract say about the notice period for renewal";
				const rare = ["használatba", "különböző", "megjegyezték"];

				for (let rep = -3; rep < REPS; rep += 1) {
					const record = rep >= 0;
					let t0 = performance.now();
					await findRelevantArtifactsByTypesDetailed({
						userId,
						query,
						types: ["normalized_document"],
						limit: 5,
						queryEmbedding: queryVector,
					});
					if (record) times.today.push(performance.now() - t0);

					// --- the widened scan, step by step ---
					t0 = performance.now();
					const allIds = db
						.select({ id: schema.artifacts.id })
						.from(schema.artifacts)
						.all()
						.map((row) => row.id)
						.filter((id) => id.startsWith(`${userId}:`));
					const olderIds = allIds.filter((id) => !newestIds.has(id));
					if (record) times.ids.push(performance.now() - t0);

					t0 = performance.now();
					const placeholders = olderIds.map(() => "?").join(",") || "NULL";
					const rows = sqlite
						.prepare(
							`SELECT subject_id AS id, embedding_json AS json FROM semantic_embeddings WHERE user_id = ? AND subject_type = 'artifact' AND model_name = ? AND subject_id IN (${placeholders})`,
						)
						.all(userId, MODEL, ...olderIds) as Array<{ id: string; json: string }>;
					if (record) times.read.push(performance.now() - t0);

					t0 = performance.now();
					const parsed = rows.map((row) => JSON.parse(row.json) as number[]);
					if (record) times.parse.push(performance.now() - t0);

					t0 = performance.now();
					const scored = parsed
						.map((vector, i) => ({ i, s: cosineSimilarity(queryVector, vector) }))
						.sort((a, b) => b.s - a.s)
						.slice(0, 24);
					if (record) times.cosine.push(performance.now() - t0);
					void scored;

					// --- the same scan through the app's own code ---
					t0 = performance.now();
					await shortlistSemanticMatchesBySubject({
						userId,
						subjectType: "artifact",
						query,
						items: olderIds.map((id) => ({ id })),
						getSubjectId: (item) => item.id,
						limit: 24,
						queryEmbedding: queryVector,
					});
					if (record) times.total.push(performance.now() - t0);
					void listSemanticEmbeddingsBySubject;

					// --- the lexical alternatives: all of a few rare words, in SQL; and a full scan in JS ---
					t0 = performance.now();
					sqlite
						.prepare(
							`SELECT id FROM artifacts WHERE user_id = ? AND type = 'normalized_document' AND content_text LIKE ? AND content_text LIKE ? AND content_text LIKE ? LIMIT 24`,
						)
						.all(userId, `%${rare[0]}%`, `%${rare[1]}%`, `%${rare[2]}%`);
					if (record) times.like.push(performance.now() - t0);

					t0 = performance.now();
					const texts = sqlite
						.prepare(
							"SELECT name, content_text AS text FROM artifacts WHERE user_id = ? AND type = 'normalized_document'",
						)
						.all(userId) as Array<{ name: string; text: string }>;
					let best = 0;
					for (const doc of texts) {
						const score = scoreMatch(query, `${doc.name}\n${doc.text}`);
						if (score > best) best = score;
					}
					if (record) times.jsScan.push(performance.now() - t0);
				}

				const fmt = (values: number[]) => `${median(values).toFixed(1)}`.padStart(7);
				const extra = median(times.total);
				out(
					[
						String(dimensions).padEnd(5),
						String(size).padStart(5),
						fmt(times.today),
						"|",
						fmt(times.ids),
						fmt(times.read),
						fmt(times.parse),
						fmt(times.cosine),
						`${fmt(times.total)} (p95 ${p95(times.total).toFixed(1)})`,
						"|",
						`${((100 * extra) / median(times.today)).toFixed(0)}%`,
						"|",
						fmt(times.like),
						fmt(times.jsScan),
					].join("  "),
				);
			}
		}
		sqlite.close();
	});
});
