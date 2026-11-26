#!/usr/bin/env tsx
/**
 * Workspace Search Stage B's speed check, on synthetic data only (never a real
 * database): the acceptance line is a search over 50,000 messages answering
 * within 200 ms on the owner's Mac.
 *
 *   npx tsx scripts/workspace-search-speed.ts [--messages 50000] [--users 5]
 *   npx tsx scripts/workspace-search-speed.ts --fill
 *
 * The first builds a scratch database under the OS temp folder, writes chats,
 * messages and documents for several people with row ids interleaved by time
 * (as a shared database grows), and times `searchWorkspace` for one person:
 * a common word, a rare word, two words, a word typed without accents, a
 * two-letter word (which keeps Stage A's LIKE) and the empty view; three
 * warm-ups, twenty runs each, median and p95.
 *
 * `--fill` builds a database at migration 144 holding about 15 MB of text over
 * about 7,000 rows (production's shape, 24 November 2026) and times migration
 * 145, which creates the indexes and fills them, as `npm run db:prepare` does
 * during a deploy while the previous release still serves.
 */

import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

const INDEX_MIGRATION = "1777140000145_workspace_search_index";

function argument(name: string, fallback: number): number {
	const at = process.argv.indexOf(name);
	const value = at === -1 ? Number.NaN : Number(process.argv[at + 1]);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** A seeded generator (mulberry32, in 32-bit integers), so every run writes the same text. */
function generator(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let mixed = Math.imul(state ^ (state >>> 15), state | 1);
		mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
		return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
	};
}

const SYLLABLES = [
	"ár",
	"víz",
	"tű",
	"rő",
	"kert",
	"ház",
	"ajánl",
	"szál",
	"lás",
	"kony",
	"ha",
	"terv",
	"the",
	"and",
	"for",
	"plan",
	"kitch",
	"en",
	"gar",
	"den",
	"pro",
	"jekt",
	"mun",
	"ka",
	"dove",
	"tail",
	"joint",
	"tér",
	"kép",
	"kód",
	"app",
	"data",
	"mo",
	"del",
	"hét",
	"év",
	"nap",
	"ban",
	"ben",
	"ról",
	"ing",
	"tion",
	"ment",
	"er",
	"ly",
	"sze",
	"rel",
	"fo",
	"gal",
	"om",
];

function writer(random: () => number) {
	const word = () => {
		let text = "";
		const parts = 1 + Math.floor(random() * 3);
		for (let index = 0; index < parts; index++) {
			text += SYLLABLES[Math.floor(random() * SYLLABLES.length)];
		}
		return random() < 0.08 ? text[0].toUpperCase() + text.slice(1) : text;
	};
	return (chars: number) => {
		let text = "";
		while (text.length < chars)
			text += `${word()}${random() < 0.1 ? ". " : " "}`;
		return text.slice(0, chars);
	};
}

function scratchFolder(): string {
	return mkdtempSync(join(tmpdir(), "alfyai-search-speed-"));
}

/** The migrations folder as it stood before the index. */
function migrationsBefore(folder: string): string {
	const out = join(folder, "drizzle-before");
	mkdirSync(join(out, "meta"), { recursive: true });
	const journal = JSON.parse(
		readFileSync("./drizzle/meta/_journal.json", "utf8"),
	) as { entries: Array<{ tag: string }> };
	const cutoff = journal.entries.findIndex(
		(entry) => entry.tag === INDEX_MIGRATION,
	);
	const kept = journal.entries.slice(0, cutoff);
	const tags = new Set(kept.map((entry) => entry.tag));
	writeFileSync(
		join(out, "meta", "_journal.json"),
		JSON.stringify({ ...journal, entries: kept }),
	);
	for (const file of readdirSync("./drizzle")) {
		if (file.endsWith(".sql") && tags.has(file.slice(0, -4))) {
			copyFileSync(join("./drizzle", file), join(out, file));
		}
	}
	return out;
}

interface SeedShape {
	users: number;
	messages: number;
	/** Characters of an ordinary message: from, to. */
	messageChars: [number, number];
	longMessageChars: number;
	artifacts: number;
	artifactChars: [number, number];
	longArtifactChars: number;
}

/**
 * People's chats, messages and text documents, written in time order so each
 * person's row ids interleave with everyone else's. A few planted words give
 * the timed queries known answers.
 */
function seed(sqlite: Database.Database, shape: SeedShape): number {
	const random = generator(42);
	const text = writer(random);
	const at = 1_790_000_000;
	let bytes = 0;
	const addUser = sqlite.prepare(
		"INSERT INTO users (id, email, password_hash, created_at, updated_at) VALUES (?, ?, 'hash', ?, ?)",
	);
	const addChat = sqlite.prepare(
		"INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
	);
	const addMessage = sqlite.prepare(
		"INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
	);
	const addArtifact = sqlite.prepare(
		"INSERT INTO artifacts (id, user_id, conversation_id, type, name, content_text, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
	);
	const touchChat = sqlite.prepare(
		"UPDATE conversations SET updated_at = ? WHERE id = ?",
	);
	const messagesPerChat = 25;
	sqlite.transaction(() => {
		for (let user = 0; user < shape.users; user++) {
			addUser.run(`u${user}`, `u${user}@example.com`, at, at);
		}
		for (let index = 0; index < shape.messages; index++) {
			const user = index % shape.users;
			const chatNumber = Math.floor(index / (shape.users * messagesPerChat));
			const chat = `u${user}-c${chatNumber}`;
			const time = at + index;
			if (index % (shape.users * messagesPerChat) < shape.users) {
				addChat.run(chat, `u${user}`, `${text(24)}`, time, time);
			}
			const [from, to] = shape.messageChars;
			let content = text(
				random() < 0.01
					? shape.longMessageChars
					: from + Math.floor(random() * (to - from)),
			);
			if (index % 997 === 0) content += " a zebrafinch was seen";
			if (index % 251 === 0) content += " Az Árvíztűrő tükörfúrógép";
			if (index % 101 === 0) content += " the AI said so";
			bytes += Buffer.byteLength(content);
			addMessage.run(
				`m${index}`,
				chat,
				index % 2 === 0 ? "user" : "assistant",
				content,
				time,
			);
			touchChat.run(time, chat);
		}
		for (let index = 0; index < shape.artifacts; index++) {
			const user = index % shape.users;
			const [from, to] = shape.artifactChars;
			const content = text(
				random() < 0.02
					? shape.longArtifactChars
					: from + Math.floor(random() * (to - from)),
			);
			bytes += Buffer.byteLength(content);
			const generated = index % 3 === 0;
			addArtifact.run(
				`a${index}`,
				`u${user}`,
				`u${user}-c0`,
				generated ? "generated_output" : "normalized_document",
				`${text(16)}.md`,
				content,
				generated
					? JSON.stringify({ sourceChatFileId: `file-${index}` })
					: null,
				at + index,
				at + index,
			);
		}
	})();
	return bytes;
}

function indexBytes(sqlite: Database.Database): number {
	return ["messages_fts", "artifacts_fts"].reduce(
		(total, index) =>
			total +
			(sqlite
				.prepare(`SELECT coalesce(sum(length(block)), 0) FROM ${index}_data`)
				.pluck()
				.get() as number),
		0,
	);
}

const megabytes = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

async function speed(): Promise<void> {
	const shape: SeedShape = {
		users: argument("--users", 5),
		messages: argument("--messages", 50_000),
		messageChars: [200, 2_000],
		longMessageChars: 40_000,
		artifacts: 3_000,
		artifactChars: [500, 4_000],
		longArtifactChars: 120_000,
	};
	const folder = scratchFolder();
	const path = join(folder, "speed.db");
	try {
		const sqlite = new Database(path);
		sqlite.pragma("journal_mode = WAL");
		sqlite.pragma("foreign_keys = ON");
		migrate(drizzle(sqlite), { migrationsFolder: "./drizzle" });
		const started = performance.now();
		const bytes = seed(sqlite, shape);
		console.log(
			`seeded ${shape.messages} messages and ${shape.artifacts} documents for ${shape.users} people: ${megabytes(bytes)} of text, index ${megabytes(indexBytes(sqlite))}, ${Math.round(performance.now() - started)} ms`,
		);
		sqlite.close();

		process.env.DATABASE_PATH = path;
		const { searchWorkspace } = await import(
			"../src/lib/server/services/workspace-search"
		);
		const queries: Array<[string, string, string?]> = [
			["a common word", "kert"],
			["a rare word", "zebrafinch"],
			["two words", "kert terv"],
			["typed without accents", "arvizturo"],
			["a two-letter word (LIKE)", "ai"],
			["a chip's page", "kert", "chats"],
			["the empty view", ""],
		];
		console.log("query | median ms | p95 ms | chats | documents");
		for (const [label, query, scope] of queries) {
			const times: number[] = [];
			let last: Awaited<ReturnType<typeof searchWorkspace>> | null = null;
			for (let run = 0; run < 23; run++) {
				const start = performance.now();
				last = await searchWorkspace("u0", {
					query,
					scope: (scope ?? "all") as "all",
				});
				if (run >= 3) times.push(performance.now() - start);
			}
			times.sort((left, right) => left - right);
			const median = times[Math.floor(times.length / 2)];
			const p95 = times[Math.floor(times.length * 0.95)];
			console.log(
				`${label} "${query}" | ${median.toFixed(1)} | ${p95.toFixed(1)} | ${last?.totals.chats} | ${last?.totals.documents}`,
			);
		}
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
}

function fill(): void {
	const folder = scratchFolder();
	const path = join(folder, "fill.db");
	try {
		const sqlite = new Database(path);
		sqlite.pragma("journal_mode = WAL");
		sqlite.pragma("foreign_keys = ON");
		migrate(drizzle(sqlite), { migrationsFolder: migrationsBefore(folder) });
		const bytes = seed(sqlite, {
			users: 5,
			messages: 4_300,
			messageChars: [300, 1_700],
			longMessageChars: 55_000,
			artifacts: 2_700,
			artifactChars: [500, 4_200],
			longArtifactChars: 60_000,
		});
		sqlite.pragma("wal_checkpoint(TRUNCATE)");
		const before = statSync(path).size;
		const started = performance.now();
		migrate(drizzle(sqlite), { migrationsFolder: "./drizzle" });
		const elapsed = performance.now() - started;
		sqlite.pragma("wal_checkpoint(TRUNCATE)");
		console.log(
			`migration 145 over ${megabytes(bytes)} of text in 7,000 rows: ${Math.round(elapsed)} ms; index ${megabytes(indexBytes(sqlite))}; database ${megabytes(before)} -> ${megabytes(statSync(path).size)}`,
		);
		const started2 = performance.now();
		const check = sqlite.prepare("PRAGMA integrity_check").pluck().get();
		console.log(
			`integrity_check: ${check} in ${Math.round(performance.now() - started2)} ms`,
		);
		sqlite.close();
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
}

if (process.argv.includes("--fill")) {
	fill();
} else {
	void speed();
}
