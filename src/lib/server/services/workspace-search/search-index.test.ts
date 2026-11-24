import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";

// The index's upkeep on a real, fully migrated database: the triggers keep it,
// these functions check it against the tables, refill it and compact it.
let memory: InMemoryDatabase;

vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));

const { checkSearchIndex, compactSearchIndex, rebuildSearchIndex } =
	await import("./search-index");

const AT = 1_790_000_000;

function addUser(id: string): void {
	memory.sqlite
		.prepare(
			"INSERT INTO users (id, email, password_hash, created_at, updated_at) VALUES (?, ?, 'hash', ?, ?)",
		)
		.run(id, `${id}@example.com`, AT, AT);
}

function addChat(id: string, userId: string, messages: string[]): void {
	memory.sqlite
		.prepare(
			"INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
		)
		.run(id, userId, id, AT, AT);
	messages.forEach((content, index) => {
		memory.sqlite
			.prepare(
				"INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)",
			)
			.run(`${id}-m${index}`, id, content, AT + index);
	});
}

function addArtifact(
	id: string,
	type: string,
	contentText: string | null,
	kind?: string,
): void {
	memory.sqlite
		.prepare(
			"INSERT INTO artifacts (id, user_id, type, name, content_text, metadata_json, created_at, updated_at) VALUES (?, 'u1', ?, ?, ?, ?, ?, ?)",
		)
		.run(
			id,
			type,
			id,
			contentText,
			kind ? JSON.stringify({ artifactType: kind }) : null,
			AT,
			AT,
		);
}

function indexRowIds(index: "messages_fts" | "artifacts_fts"): number[] {
	return memory.sqlite
		.prepare(`SELECT rowid FROM ${index} ORDER BY rowid`)
		.pluck()
		.all() as number[];
}

/** Index pages whose bytes still hold a trigram, deleted or not. */
function pagesHolding(
	index: "messages_fts" | "artifacts_fts",
	trigram: string,
) {
	return memory.sqlite
		.prepare(
			`SELECT count(*) FROM ${index}_data WHERE instr(block, CAST(? AS BLOB)) > 0`,
		)
		.pluck()
		.get(trigram) as number;
}

function seedEveryKind(): void {
	addUser("u1");
	addChat("c1", "u1", ["a garden plan", "", "the kitchen budget"]);
	addChat("c2", "u1", ["Árvíztűrő tükörfúrógép"]);
	addArtifact("doc", "artifact", "a Document's text", "document");
	addArtifact("untyped", "artifact", "an untyped artifact's text");
	addArtifact("app", "artifact", "const x = useState();", "app");
	addArtifact("picture", "artifact", '{"prompt":"a timber house"}', "image");
	addArtifact("canvas", "artifact", '{"nodes":[]}', "canvas");
	addArtifact("video", "artifact", '{"prompt":"a turntable"}', "video");
	addArtifact("upload", "normalized_document", "extracted text");
	addArtifact("file", "generated_output", "a generated report");
	addArtifact("note", "skill_note", "a Skill Note");
	addArtifact("capsule", "work_capsule", "internal summary");
	addArtifact("empty", "source_document", null);
}

describe("the search index's upkeep", () => {
	beforeEach(() => {
		memory = createInMemoryDatabase();
	});

	afterEach(() => {
		memory.close();
	});

	it("a refilled index equals the one the triggers keep", () => {
		seedEveryKind();
		const byTriggers = {
			messages: indexRowIds("messages_fts"),
			artifacts: indexRowIds("artifacts_fts"),
		};
		expect(byTriggers.messages).toHaveLength(3);
		expect(byTriggers.artifacts).toHaveLength(5);

		const report = rebuildSearchIndex();

		expect(indexRowIds("messages_fts")).toEqual(byTriggers.messages);
		expect(indexRowIds("artifacts_fts")).toEqual(byTriggers.artifacts);
		expect(report).toEqual({
			messages: { indexed: 3, expected: 3, missing: 0, extra: 0 },
			artifacts: { indexed: 5, expected: 5, missing: 0, extra: 0 },
		});
		// The refilled index still answers by folded words.
		expect(
			memory.sqlite
				.prepare(
					"SELECT count(*) FROM messages_fts WHERE messages_fts MATCH '\"arviz\"'",
				)
				.pluck()
				.get(),
		).toBe(1);
	});

	it("the check finds a lost row and a stray one, and a refill mends both", () => {
		seedEveryKind();
		const [lost] = indexRowIds("messages_fts");
		memory.sqlite.prepare("DELETE FROM messages_fts WHERE rowid = ?").run(lost);
		memory.sqlite
			.prepare(
				"INSERT INTO artifacts_fts(rowid, content_text) VALUES (9999, 'stray')",
			)
			.run();

		expect(checkSearchIndex()).toEqual({
			messages: { indexed: 2, expected: 3, missing: 1, extra: 0 },
			artifacts: { indexed: 6, expected: 5, missing: 0, extra: 1 },
		});

		expect(rebuildSearchIndex()).toEqual({
			messages: { indexed: 3, expected: 3, missing: 0, extra: 0 },
			artifacts: { indexed: 5, expected: 5, missing: 0, extra: 0 },
		});
	});

	it("compaction leaves none of a deleted message's words in the index", () => {
		addUser("u1");
		addChat(
			"c1",
			"u1",
			Array.from({ length: 30 }, (_, index) => `ordinary words ${index}`),
		);
		addChat("c2", "u1", ["qxzvbn is the secret"]);
		expect(pagesHolding("messages_fts", "qxz")).toBe(1);

		memory.sqlite.prepare("DELETE FROM conversations WHERE id = 'c2'").run();
		// Deleted, so no search finds it, but its bytes stay until a merge.
		expect(
			memory.sqlite
				.prepare(
					"SELECT count(*) FROM messages_fts WHERE messages_fts MATCH '\"qxzv\"'",
				)
				.pluck()
				.get(),
		).toBe(0);
		expect(pagesHolding("messages_fts", "qxz")).toBe(1);

		expect(compactSearchIndex()).toBe(true);

		expect(pagesHolding("messages_fts", "qxz")).toBe(0);
		expect(indexRowIds("messages_fts")).toHaveLength(30);
	});
});
