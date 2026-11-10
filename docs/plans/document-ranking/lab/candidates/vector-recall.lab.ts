// @vitest-environment node
//
// How often is the right document among the 24 older documents closest to the question by stored vector?
// MEASURED with the production embedder (Qwen3-Embedding-4B cut to 1024 dimensions, through TEI), on public text
// only (LAB_PLAN = the output of vector-recall-prep.py: five corpora, twelve libraries of 400 to 1,500 documents,
// nine question sets). Replaces the estimate of cosine-recall.py, which extrapolated from 119 competitors a query.
//
// Two phases, so that only the first one needs the embedder:
//
//   embed    The app's own code embeds every document once and every question once: the libraries' texts become
//            artifacts in a real migrated SQLite file, `backfillSemanticEmbeddingsForUser` builds the source text
//            of each (`buildArtifactEmbeddingSourceText`: name, summary, text) and stores the vector the way a
//            library upload does; a question is embedded as a chat turn embeds it, `embedText(question, { promptName:
//            "query" })`. Needs TEI_EMBEDDER_URL (+ TEI_EMBEDDER_API_KEY) of the 4B embedder. Use a fresh output
//            directory: reusing a cache after changing its texts or embedder could mix incompatible vectors.
//   measure  No network. Each library is rebuilt as its own user (the stored vectors are copied, the documents get
//            random distinct ages of 1 to 60 days) and every question runs through the app's own
//            `findRelevantArtifactsByTypesDetailed` with its query embedding passed in, as `context.ts` does. The
//            semantic shortlist is wrapped, not replaced, so the older-document pass runs for real and its two calls
//            are read off: the 24 closest older documents, and the candidate list the ranker gets. Independently the
//            cosine of the question against every document of the library is computed, and the two must agree.
//
//   LAB_PHASE=embed   LAB_PLAN=<prep out> LAB_OUT=<dir> TEI_EMBEDDER_URL=... TEI_EMBEDDER_API_KEY=... \
//     npx vitest run -c docs/plans/document-ranking/lab/candidates/vitest.config.ts vector-recall
//   LAB_PHASE=measure LAB_PLAN=<prep out> LAB_OUT=<same dir> \
//     npx vitest run -c docs/plans/document-ranking/lab/candidates/vitest.config.ts vector-recall
//
// Output (LAB_OUT): embedded.db + query-vectors.json (embed), libraries.db + vector-recall-questions.jsonl +
// vector-recall-results.txt (measure). `vector-recall-report.py` turns the jsonl into the table.

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import { cosineSimilarity } from "$lib/server/utils/math";

const hoisted = vi.hoisted(() => ({
	calls: [] as Array<{ itemIds: string[]; matchIds: string[] }>,
}));

// The real shortlist, observed: the older-document pass calls it first (items = the older documents, result = the
// 24 closest), the ranker calls it second (items = every candidate).
vi.mock("$lib/server/services/semantic-ranking", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("$lib/server/services/semantic-ranking")
		>();
	type Params = {
		items: unknown[];
		getSubjectId: (item: never) => string;
	};
	const real = actual.shortlistSemanticMatchesBySubject as unknown as (
		params: Params,
	) => Promise<Array<{ subjectId: string }> | null>;
	return {
		...actual,
		shortlistSemanticMatchesBySubject: async (params: Params) => {
			const result = await real(params);
			hoisted.calls.push({
				itemIds: params.items.map((item) => params.getSubjectId(item as never)),
				matchIds: (result ?? []).map((match) => match.subjectId),
			});
			return result;
		},
	};
});
vi.mock("$lib/server/services/tei-reranker", () => ({
	canUseTeiReranker: () => false,
	rerankItems: async () => null,
}));

const PHASE = process.env.LAB_PHASE ?? "";
const LAB_PLAN = process.env.LAB_PLAN ?? "";
const LAB_OUT = process.env.LAB_OUT ?? "";
const MODEL = process.env.TEI_EMBEDDER_MODEL || "Qwen/Qwen3-Embedding-4B";
const DIMENSIONS = process.env.TEI_EMBEDDER_DIMENSIONS || "1024";
const WINDOW = 120; // SEMANTIC_ARTIFACT_CANDIDATE_LIMIT
const TOP = 24; // SEMANTIC_ARTIFACT_SHORTLIST_LIMIT
const SAMPLES = 30; // random 119-document pools a question, for re-applying the estimate (cosine-recall.py)
const POOL = 119;

type PlanDoc = { gid: string; corpus: string; id: string; text: string };
type PlanQuery = { qid: string; text: string; gold: string; libs: string[] };
type Plan = {
	seed: number;
	libraries: Record<
		string,
		{ family: string; size: number; members: string[] }
	>;
	sets: Record<
		string,
		{ label: string; family: string; queries: PlanQuery[] }
	>;
};

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

function hashOf(text: string): number {
	let h = 2166136261;
	for (let i = 0; i < text.length; i += 1) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

function readJsonl<T>(path: string): T[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as T);
}

function requireEnv(): { plan: Plan; docs: PlanDoc[] } {
	if (!LAB_PLAN || !LAB_OUT)
		throw new Error("LAB_PLAN and LAB_OUT are required");
	mkdirSync(LAB_OUT, { recursive: true });
	return {
		plan: JSON.parse(readFileSync(join(LAB_PLAN, "plan.json"), "utf8")) as Plan,
		docs: readJsonl<PlanDoc>(join(LAB_PLAN, "docs.jsonl")),
	};
}

function insertUser(
	db: ReturnType<typeof drizzle<typeof schema>>,
	userId: string,
) {
	const now = new Date();
	db.insert(schema.users)
		.values({
			id: userId,
			email: `${userId}@example.com`,
			passwordHash: "hash",
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoNothing()
		.run();
}

describe("vector recall lab", () => {
	it.skipIf(PHASE !== "embed")(
		"embeds the libraries' documents and questions with the real embedder",
		{ timeout: 12 * 3_600_000 },
		async () => {
			const { plan, docs } = requireEnv();
			if (!process.env.TEI_EMBEDDER_URL)
				throw new Error("TEI_EMBEDDER_URL is required in the embed phase");
			const dbPath = join(LAB_OUT, "embedded.db");
			if (existsSync(dbPath) || existsSync(join(LAB_OUT, "query-vectors.json"))) {
				throw new Error("Embed phase requires a fresh LAB_OUT; preserve existing vectors and choose another directory");
			}
			const progress = join(LAB_OUT, "embed-progress.log");
			const log = (line: string) =>
				appendFileSync(progress, `${new Date().toISOString()} ${line}\n`);
			process.env.DATABASE_PATH = dbPath;
			process.env.TEI_EMBEDDER_MODEL = MODEL;
			process.env.TEI_EMBEDDER_DIMENSIONS = DIMENSIONS;
			process.env.TEI_EMBEDDER_BATCH_SIZE =
				process.env.TEI_EMBEDDER_BATCH_SIZE || "8";

			const sqlite = new Database(dbPath);
			sqlite.pragma("journal_mode = WAL");
			sqlite.pragma("busy_timeout = 10000");
			sqlite.pragma("foreign_keys = ON");
			const db = drizzle(sqlite, { schema });
			migrate(db, { migrationsFolder: "./drizzle" });

			const { backfillSemanticEmbeddingsForUser } = await import(
				"$lib/server/services/semantic-embedding-refresh"
			);
			const { embedText } = await import("$lib/server/services/tei-embedder");

			// One user a corpus, one artifact a document: name `doc-<id>.md`, no summary, the text as the content.
			const byCorpus = new Map<string, PlanDoc[]>();
			for (const doc of docs) {
				const list = byCorpus.get(doc.corpus) ?? [];
				list.push(doc);
				byCorpus.set(doc.corpus, list);
			}
			const at = new Date();
			for (const [corpus, list] of byCorpus) {
				const userId = `emb-${corpus}`;
				insertUser(db, userId);
				db.transaction((tx) => {
					for (const doc of list) {
						tx.insert(schema.artifacts)
							.values({
								id: `emb:${doc.gid}`,
								userId,
								conversationId: null,
								type: "normalized_document",
								retrievalClass: "durable",
								name: `doc-${doc.id}.md`,
								mimeType: "text/markdown",
								sizeBytes: doc.text.length,
								contentText: doc.text,
								createdAt: at,
								updatedAt: at,
							})
							.onConflictDoNothing()
							.run();
					}
				});
			}
			log(
				`start: ${docs.length} documents in ${byCorpus.size} corpora, model ${MODEL}, ${DIMENSIONS} dimensions, batch ${process.env.TEI_EMBEDDER_BATCH_SIZE}`,
			);

			const countFor = (userId: string) =>
				(
					sqlite
						.prepare(
							"SELECT count(*) AS n FROM semantic_embeddings WHERE user_id = ? AND model_name = ?",
						)
						.get(userId, MODEL) as { n: number }
				).n;

			for (const [corpus, list] of byCorpus) {
				const userId = `emb-${corpus}`;
				const startedAt = Date.now();
				const timer = setInterval(
					() =>
						log(
							`${corpus}: ${countFor(userId)}/${list.length} embedded, ${Math.round((Date.now() - startedAt) / 1000)} s`,
						),
					30_000,
				);
				try {
					for (let attempt = 1; attempt <= 8; attempt += 1) {
						try {
							await backfillSemanticEmbeddingsForUser(userId);
						} catch (error) {
							log(
								`${corpus}: attempt ${attempt} failed: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
							);
						}
						if (countFor(userId) >= list.length) break;
						await new Promise((resolve) => setTimeout(resolve, 3000));
					}
				} finally {
					clearInterval(timer);
				}
				log(
					`${corpus}: done, ${countFor(userId)}/${list.length} embedded, ${Math.round((Date.now() - startedAt) / 1000)} s`,
				);
				expect(countFor(userId)).toBe(list.length);
			}

			// The questions, one request each as a chat turn sends them.
			const queryPath = join(LAB_OUT, "query-vectors.json");
			const vectors: Record<string, number[]> = {};
			const texts = Array.from(
				new Set(
					Object.values(plan.sets).flatMap((set) =>
						set.queries.map((query) => query.text.trim()),
					),
				),
			).sort();
			const queryStart = Date.now();
			let done = 0;
			for (const text of texts) {
				if (!vectors[text]) {
					let vector: number[] | null = null;
					for (let attempt = 1; attempt <= 6 && !vector; attempt += 1) {
						try {
							vector = await embedText(text, { promptName: "query" });
						} catch (error) {
							log(
								`question attempt ${attempt} failed: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
							);
							await new Promise((resolve) => setTimeout(resolve, 3000));
						}
					}
					if (!vector) throw new Error("a question could not be embedded");
					vectors[text] = vector;
				}
				done += 1;
				if (done % 250 === 0) {
					writeFileSync(queryPath, JSON.stringify(vectors));
					log(
						`questions: ${done}/${texts.length}, ${Math.round((Date.now() - queryStart) / 1000)} s`,
					);
				}
			}
			writeFileSync(queryPath, JSON.stringify(vectors));
			log(`questions: ${done}/${texts.length} done`);

			// Sanity: size and norm of every vector (TEI normalizes, so ~1).
			const lines: string[] = [];
			let minNorm = Number.POSITIVE_INFINITY;
			let maxNorm = 0;
			const dimsSeen = new Set<number>();
			const norm = (vector: number[]) =>
				Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
			const rows = sqlite
				.prepare(
					"SELECT embedding_json AS json FROM semantic_embeddings WHERE model_name = ?",
				)
				.all(MODEL) as Array<{ json: string }>;
			for (const row of rows) {
				const vector = JSON.parse(row.json) as number[];
				dimsSeen.add(vector.length);
				const n = norm(vector);
				minNorm = Math.min(minNorm, n);
				maxNorm = Math.max(maxNorm, n);
			}
			for (const vector of Object.values(vectors)) {
				dimsSeen.add(vector.length);
				const n = norm(vector);
				minNorm = Math.min(minNorm, n);
				maxNorm = Math.max(maxNorm, n);
			}
			lines.push(
				`embedded ${rows.length} documents and ${texts.length} questions with ${MODEL}; vector sizes ${Array.from(dimsSeen).join(",")}; norms ${minNorm.toFixed(5)} to ${maxNorm.toFixed(5)}`,
			);
			writeFileSync(
				join(LAB_OUT, "embed-summary.txt"),
				`${lines.join("\n")}\n`,
			);
			log(lines.join(" | "));
			sqlite.pragma("wal_checkpoint(TRUNCATE)");
			sqlite.close();
		},
	);

	it.skipIf(PHASE !== "measure")(
		"runs every question through the real search over the stored vectors",
		{ timeout: 6 * 3_600_000 },
		async () => {
			const { plan, docs } = requireEnv();
			const dbPath = join(LAB_OUT, "libraries.db");
			for (const suffix of ["", "-wal", "-shm", "-journal"]) {
				rmSync(dbPath + suffix, { force: true });
			}
			process.env.DATABASE_PATH = dbPath;
			// Never called: every search is handed its query vector. A connection error here means one was not.
			process.env.TEI_EMBEDDER_URL = "http://127.0.0.1:9";
			process.env.TEI_EMBEDDER_MODEL = MODEL;
			process.env.TEI_EMBEDDER_DIMENSIONS = DIMENSIONS;
			const sqlite = new Database(dbPath);
			sqlite.pragma("journal_mode = WAL");
			sqlite.pragma("foreign_keys = ON");
			const db = drizzle(sqlite, { schema });
			migrate(db, { migrationsFolder: "./drizzle" });
			const { findRelevantArtifactsByTypesDetailed } = await import(
				"$lib/server/services/knowledge/store/documents"
			);

			// The stored vectors and the query vectors of the embed phase.
			const embedded = new Database(join(LAB_OUT, "embedded.db"), {
				readonly: true,
			});
			const stored = new Map<
				string,
				{ hash: string; dims: number; json: string }
			>();
			for (const row of embedded
				.prepare(
					"SELECT subject_id AS id, source_text_hash AS hash, dimensions AS dims, embedding_json AS json FROM semantic_embeddings WHERE subject_type = 'artifact' AND model_name = ?",
				)
				.iterate(MODEL) as Iterable<{
				id: string;
				hash: string;
				dims: number;
				json: string;
			}>) {
				stored.set(row.id.replace(/^emb:/, ""), row);
			}
			embedded.close();
			const queryVectors = JSON.parse(
				readFileSync(join(LAB_OUT, "query-vectors.json"), "utf8"),
			) as Record<string, number[]>;
			const textOf = new Map(docs.map((doc) => [doc.gid, doc]));

			const resultsPath = join(LAB_OUT, "vector-recall-results.txt");
			const recordsPath = join(LAB_OUT, "vector-recall-questions.jsonl");
			rmSync(recordsPath, { force: true });
			const header = [
				"VECTOR RECALL LAB (measured), public text only. The real search over a real SQLite file, stored vectors from the embedder, 24 closest older documents.",
				"lib            N   set  questions  older  in-vector-group(app)  agree-with-own-cosines  candidates(app)  window",
			];
			writeFileSync(resultsPath, `${header.join("\n")}\n`);
			const note = (line: string) =>
				appendFileSync(resultsPath, `${line}\n`);

			let totalRecords = 0;
			let totalMismatches = 0;
			const DAY = 86_400;
			const now = Math.floor(Date.now() / 1000);

			for (const [libName, lib] of Object.entries(plan.libraries).sort(
				([a], [b]) => a.localeCompare(b),
			)) {
				const userId = `lab-${libName}`;
				insertUser(db, userId);
				const rng = rngFrom(plan.seed + hashOf(libName));

				// Distinct ages (seconds), 1 to 60 days: the window is then unambiguous.
				const seen = new Set<number>();
				const ageSeconds = new Map<string, number>();
				for (const gid of lib.members) {
					let age: number;
					do {
						age = DAY + Math.floor(rng() * 59 * DAY);
					} while (seen.has(age));
					seen.add(age);
					ageSeconds.set(gid, age);
				}

				db.transaction((tx) => {
					for (const gid of lib.members) {
						const doc = textOf.get(gid);
						const vector = stored.get(gid);
						if (!doc || !vector) throw new Error(`no document or vector for ${gid}`);
						const at = new Date((now - (ageSeconds.get(gid) ?? 0)) * 1000);
						const artifactId = `${userId}:${gid}`;
						tx.insert(schema.artifacts)
							.values({
								id: artifactId,
								userId,
								conversationId: null,
								type: "normalized_document",
								retrievalClass: "durable",
								name: `doc-${doc.id}.md`,
								mimeType: "text/markdown",
								sizeBytes: doc.text.length,
								contentText: doc.text,
								createdAt: at,
								updatedAt: at,
							})
							.run();
						tx.insert(schema.semanticEmbeddings)
							.values({
								id: `${artifactId}:e`,
								userId,
								subjectType: "artifact",
								subjectId: artifactId,
								modelName: MODEL,
								sourceTextHash: vector.hash,
								dimensions: vector.dims,
								embeddingJson: vector.json,
								createdAt: new Date(now * 1000),
								updatedAt: new Date(now * 1000),
							})
							.run();
					}
				});

				// The window, as the app reads it, against our own ages.
				const windowIds = new Set(
					(
						sqlite
							.prepare(
								"SELECT id FROM artifacts WHERE user_id = ? AND type = 'normalized_document' ORDER BY updated_at DESC LIMIT ?",
							)
							.all(userId, WINDOW) as Array<{ id: string }>
					).map((row) => row.id),
				);
				const ownWindow = new Set(
					lib.members
						.slice()
						.sort(
							(a, b) => (ageSeconds.get(a) ?? 0) - (ageSeconds.get(b) ?? 0),
						)
						.slice(0, WINDOW)
						.map((gid) => `${userId}:${gid}`),
				);
				expect(windowIds.size).toBe(WINDOW);
				for (const id of ownWindow) expect(windowIds.has(id)).toBe(true);

				const vectors = lib.members.map(
					(gid) => JSON.parse(stored.get(gid)?.json ?? "[]") as number[],
				);
				const olderMask = lib.members.map(
					(gid) => !windowIds.has(`${userId}:${gid}`),
				);
				const cosines = new Float64Array(lib.members.length);
				const indexOf = new Map(lib.members.map((gid, i) => [gid, i]));

				const perSet = new Map<
					string,
					{
						n: number;
						older: number;
						app: number;
						agree: number;
						cand: number;
						win: number;
					}
				>();
				const queries = Object.entries(plan.sets).flatMap(([letter, set]) =>
					set.queries
						.filter((query) => query.libs.includes(libName))
						.map((query) => ({ letter, query })),
				);

				for (const { letter, query } of queries) {
					const queryVector = queryVectors[query.text.trim()];
					if (!queryVector) throw new Error(`no vector for ${query.qid}`);
					const goldIndex = indexOf.get(query.gold);
					if (goldIndex === undefined)
						throw new Error(`${query.qid}: gold not in ${libName}`);

					hoisted.calls = [];
					const startedAt = performance.now();
					await findRelevantArtifactsByTypesDetailed({
						userId,
						query: query.text,
						types: ["normalized_document"],
						limit: 5,
						queryEmbedding: queryVector,
					});
					const searchMs = performance.now() - startedAt;
					expect(hoisted.calls.length).toBe(2);
					const [olderCall, rankCall] = hoisted.calls;
					const goldId = `${userId}:${query.gold}`;
					const appVector = olderCall.matchIds.includes(goldId);
					const appCandidate = rankCall.itemIds.includes(goldId);

					// Our own cosines: the same function the app uses.
					for (let i = 0; i < vectors.length; i += 1) {
						cosines[i] = cosineSimilarity(queryVector, vectors[i]);
					}
					const goldCos = cosines[goldIndex];
					let c = 0;
					let ties = 0;
					let olderAbove = 0;
					for (let i = 0; i < cosines.length; i += 1) {
						if (i === goldIndex) continue;
						if (cosines[i] > goldCos) {
							c += 1;
							if (olderMask[i]) olderAbove += 1;
						} else if (cosines[i] === goldCos) {
							ties += 1;
						}
					}
					const goldOlder = olderMask[goldIndex];
					const rankOlder = goldOlder ? olderAbove + 1 : null;
					const ownVector = goldOlder && (rankOlder ?? 0) <= TOP;
					const inWindow = windowIds.has(goldId);

					// 30 random pools of 119 other documents: the sample the old estimate was built from.
					const others: number[] = [];
					for (let i = 0; i < cosines.length; i += 1) {
						if (i !== goldIndex) others.push(i);
					}
					const sampler = rngFrom(plan.seed + hashOf(query.qid + libName));
					const c119: number[] = [];
					for (let s = 0; s < SAMPLES; s += 1) {
						let above = 0;
						for (let k = 0; k < POOL; k += 1) {
							const j = k + Math.floor(sampler() * (others.length - k));
							[others[k], others[j]] = [others[j], others[k]];
							if (cosines[others[k]] > goldCos) above += 1;
						}
						c119.push(above);
					}

					const record = {
						set: letter,
						lib: libName,
						family: lib.family,
						N: lib.members.length,
						qid: query.qid,
						inWindow,
						rankOlder,
						c,
						ties,
						c119,
						appVector,
						appCandidate,
						nCandidates: rankCall.itemIds.length,
						nVectorGroup: olderCall.matchIds.length,
						ms: Math.round(searchMs),
					};
					appendFileSync(recordsPath, `${JSON.stringify(record)}\n`);
					totalRecords += 1;
					if (appVector !== ownVector) totalMismatches += 1;

					const entry = perSet.get(letter) ?? {
						n: 0,
						older: 0,
						app: 0,
						agree: 0,
						cand: 0,
						win: 0,
					};
					entry.n += 1;
					if (goldOlder) entry.older += 1;
					if (appVector) entry.app += 1;
					if (appVector === ownVector) entry.agree += 1;
					if (appCandidate) entry.cand += 1;
					if (inWindow) entry.win += 1;
					perSet.set(letter, entry);
				}

				for (const [letter, entry] of Array.from(perSet).sort(([a], [b]) =>
					a.localeCompare(b),
				)) {
					note(
						[
							libName.padEnd(13),
							String(lib.members.length).padStart(5),
							letter.padStart(4),
							String(entry.n).padStart(9),
							String(entry.older).padStart(6),
							String(entry.app).padStart(21),
							`${entry.agree}/${entry.n}`.padStart(22),
							String(entry.cand).padStart(16),
							String(entry.win).padStart(7),
						].join("  "),
					);
				}
			}
			note(
				`records ${totalRecords}; the app's vector group differed from our own cosines in ${totalMismatches}`,
			);
			sqlite.pragma("wal_checkpoint(TRUNCATE)");
			sqlite.close();
			expect(totalMismatches).toBe(0);
		},
	);
});
