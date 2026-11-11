// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
	assertRepairDatabasePath,
	repairNormalChatMetadata,
} from "./compact-normal-chat-metadata";

let sqlite: Database.Database;
const scope = { userId: "synthetic", conversationId: "c", messageId: "m" };
const eventScope = {
	version: 1,
	turnId: "t",
	segmentId: "s",
	attemptId: "a",
	stepId: "step",
	phase: "working",
};
let original: string;
beforeEach(() => {
	sqlite = new Database(":memory:");
	sqlite.exec(
		"CREATE TABLE conversations(id TEXT PRIMARY KEY,user_id TEXT); CREATE TABLE messages(id TEXT PRIMARY KEY,conversation_id TEXT,role TEXT,content TEXT,metadata_json TEXT); INSERT INTO conversations VALUES ('c','synthetic'),('foreign','other');",
	);
	const events = [
		{
			...eventScope,
			sequence: 1,
			type: "block_start",
			blockId: "b",
			nativeId: "n",
			kind: "text",
			role: "answer",
		},
		...Array.from({ length: 1000 }, (_, i) => ({
			...eventScope,
			sequence: i + 2,
			type: "block_delta",
			blockId: "b",
			text: "hello ",
		})),
		{ ...eventScope, sequence: 1002, type: "block_end", blockId: "b" },
	];
	original = JSON.stringify({
		keep: { value: [1, "unchanged"] },
		normalChatOutput: { version: 1, custom: "preserved", events },
	});
	sqlite
		.prepare("INSERT INTO messages VALUES (?,?,?,?,?)")
		.run("m", "c", "assistant", "hello ".repeat(1000), original);
});
afterEach(() => sqlite.close());
it("dry-runs old oversized metadata, applies only exact selected rows and is idempotent", () => {
	const before = sqlite.prepare("SELECT * FROM messages").get() as Record<
		string,
		unknown
	>;
	const dry = repairNormalChatMetadata(sqlite, [scope], false);
	expect(dry.changed).toBe(1);
	expect(dry.afterBytes).toBeLessThan(dry.beforeBytes / 10);
	expect(sqlite.prepare("SELECT * FROM messages").get()).toEqual(before);
	expect(repairNormalChatMetadata(sqlite, [scope], true)).toEqual(dry);
	const after = sqlite.prepare("SELECT * FROM messages").get() as Record<
		string,
		unknown
	>;
	expect({ ...after, metadata_json: original }).toEqual(before);
	const metadata = JSON.parse(String(after.metadata_json));
	expect(metadata.keep).toEqual({ value: [1, "unchanged"] });
	expect(metadata.normalChatOutput.custom).toBe("preserved");
	expect(metadata.normalChatOutput.events).toHaveLength(3);
	const rerun = repairNormalChatMetadata(sqlite, [scope], true);
	expect(rerun.changed).toBe(0);
	expect(rerun.beforeBytes).toBe(rerun.afterBytes);
});
it("rejects wrong ownership, non-assistant and missing IDs without partial writes", () => {
	for (const bad of [
		{ ...scope, userId: "other" },
		{ ...scope, conversationId: "foreign" },
		{ ...scope, messageId: "missing" },
	]) {
		expect(() =>
			repairNormalChatMetadata(sqlite, [scope, bad], true),
		).toThrow();
		expect(
			sqlite
				.prepare("SELECT metadata_json FROM messages WHERE id='m'")
				.pluck()
				.get(),
		).toBe(original);
	}
	sqlite.prepare("UPDATE messages SET role='user'").run();
	expect(() => repairNormalChatMetadata(sqlite, [scope], true)).toThrow();
});
it("refuses malformed events and oversized/duplicate manifests", () => {
	expect(() => repairNormalChatMetadata(sqlite, [], true)).toThrow();
	expect(() =>
		repairNormalChatMetadata(sqlite, [scope, scope], true),
	).toThrow();
	expect(() =>
		repairNormalChatMetadata(
			sqlite,
			Array.from({ length: 101 }, (_, i) => ({
				...scope,
				messageId: String(i),
			})),
			true,
		),
	).toThrow();
	sqlite.prepare("UPDATE messages SET metadata_json=?").run(
		JSON.stringify({
			normalChatOutput: { version: 1, events: [{ type: "unknown" }] },
		}),
	);
	expect(() => repairNormalChatMetadata(sqlite, [scope], true)).toThrow();
});
it("refuses production apply even when the caller supplies a production-looking database directly", () => {
	expect(() =>
		assertRepairDatabasePath(
			"/home/alfydesign/apps/langflow-chat/shared/data/chat.db",
			true,
		),
	).toThrow();
	expect(() => assertRepairDatabasePath("/tmp/scratch.db", true)).toThrow();
	expect(() =>
		assertRepairDatabasePath("/tmp/scratch.db", false),
	).not.toThrow();
	expect(() =>
		assertRepairDatabasePath(
			"/home/alfydesign/apps/langflow-chat-dev/shared/data/chat.db",
			true,
		),
	).not.toThrow();
});

it("rolls back earlier compaction when a later selected row is invalid", () => {
	sqlite.prepare("INSERT INTO messages VALUES (?,?,?,?,?)").run(
		"bad",
		"c",
		"assistant",
		"unchanged",
		JSON.stringify({
			normalChatOutput: { version: 1, events: [{ type: "bad" }] },
		}),
	);
	expect(() =>
		repairNormalChatMetadata(
			sqlite,
			[scope, { ...scope, messageId: "bad" }],
			true,
		),
	).toThrow("Invalid output event");
	expect(
		sqlite
			.prepare("SELECT metadata_json FROM messages WHERE id='m'")
			.pluck()
			.get(),
	).toBe(original);
});
it("refuses over 32 MiB before loading/rewriting the selected metadata", () => {
	sqlite
		.prepare("UPDATE messages SET metadata_json=?")
		.run(" ".repeat(32 * 1024 * 1024 + 1));
	expect(() => repairNormalChatMetadata(sqlite, [scope], true)).toThrow(
		/32 MiB/,
	);
});
it("standalone tsx dry-run needs no server imports, writes no row and refuses scratch apply", () => {
	const dir = mkdtempSync(join(tmpdir(), "completion-repair-"));
	const path = join(dir, "scratch.sqlite");
	const manifest = join(dir, "manifest.json");
	const disk = new Database(path);
	try {
		disk.exec(
			"CREATE TABLE conversations(id TEXT PRIMARY KEY,user_id TEXT); CREATE TABLE messages(id TEXT PRIMARY KEY,conversation_id TEXT,role TEXT,content TEXT,metadata_json TEXT); INSERT INTO conversations VALUES ('c','synthetic');",
		);
		disk
			.prepare("INSERT INTO messages VALUES (?,?,?,?,?)")
			.run("m", "c", "assistant", "hello ".repeat(1000), original);
		writeFileSync(manifest, JSON.stringify([scope]));
		const args = [
			"--import",
			"tsx",
			"scripts/compact-normal-chat-metadata.ts",
			"--database",
			path,
			"--manifest",
			manifest,
		];
		const report = JSON.parse(
			execFileSync(process.execPath, args, {
				encoding: "utf8",
				env: { PATH: process.env.PATH },
			}),
		);
		expect(report).toMatchObject({ mode: "dry-run", selected: 1, changed: 1 });
		expect(
			disk.prepare("SELECT metadata_json FROM messages").pluck().get(),
		).toBe(original);
		expect(() =>
			execFileSync(process.execPath, [...args, "--apply"], {
				stdio: "pipe",
				env: { PATH: process.env.PATH },
			}),
		).toThrow();
		expect(
			disk.prepare("SELECT metadata_json FROM messages").pluck().get(),
		).toBe(original);
	} finally {
		disk.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
