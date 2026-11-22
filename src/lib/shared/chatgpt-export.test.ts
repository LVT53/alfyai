import { describe, expect, it } from "vitest";
import {
	exportedConversationId,
	readExportedConversations,
} from "./chatgpt-export";

describe("exportedConversationId", () => {
	it("names a conversation by its conversation_id", () => {
		expect(
			exportedConversationId({ id: "internal", conversation_id: "exported" }),
		).toBe("exported");
	});

	it("falls back to id when conversation_id is empty or missing", () => {
		expect(exportedConversationId({ id: "only-id", conversation_id: "" })).toBe(
			"only-id",
		);
		expect(exportedConversationId({ id: "only-id" })).toBe("only-id");
	});

	it("names nothing when the entry carries neither", () => {
		expect(exportedConversationId({ title: "No ids" })).toBeNull();
		expect(exportedConversationId({ id: 7, conversation_id: null })).toBeNull();
		expect(exportedConversationId({ id: "", conversation_id: "" })).toBeNull();
	});

	it("names nothing for an entry that is not an object", () => {
		expect(exportedConversationId(null)).toBeNull();
		expect(exportedConversationId(undefined)).toBeNull();
		expect(exportedConversationId("a-string")).toBeNull();
		expect(exportedConversationId(["conv-1"])).toBeNull();
	});
});

describe("readExportedConversations", () => {
	// A stand-in for a JSZip archive: the paths it holds and their text.
	function archive(files: Record<string, unknown>) {
		return {
			file(path: string) {
				if (!(path in files)) return null;
				const value = files[path];
				return {
					async: async () =>
						typeof value === "string" ? value : JSON.stringify(value),
				};
			},
		};
	}

	it("reads the one conversations.json of an older export", async () => {
		const result = await readExportedConversations(
			archive({ "conversations.json": [{ id: "a" }, { id: "b" }] }),
		);
		expect(result).toEqual({ ok: true, entries: [{ id: "a" }, { id: "b" }] });
	});

	it("reads every file the manifest lists for the conversations, in order", async () => {
		const result = await readExportedConversations(
			archive({
				"export_manifest.json": {
					version: 1,
					logical_files: {
						"conversations.json": {
							files: [
								"conversations-0001.json",
								"shards/conversations-0002.json",
							],
							sharded: true,
							shard_count: 2,
						},
					},
				},
				"conversations-0001.json": [{ id: "a" }],
				"shards/conversations-0002.json": [{ id: "b" }, { id: "c" }],
			}),
		);
		expect(result).toEqual({
			ok: true,
			entries: [{ id: "a" }, { id: "b" }, { id: "c" }],
		});
	});

	it("refuses an export whose manifest lists a file the archive does not hold", async () => {
		const result = await readExportedConversations(
			archive({
				"export_manifest.json": {
					logical_files: {
						"conversations.json": {
							files: ["conversations-0001.json", "conversations-0002.json"],
						},
					},
				},
				"conversations-0001.json": [{ id: "a" }],
			}),
		);
		expect(result).toEqual({
			ok: false,
			problem: "missing",
			file: "conversations-0002.json",
		});
	});

	it("falls back to conversations.json when the manifest cannot be used", async () => {
		for (const manifest of [
			"{not json",
			{ version: 1 },
			{ logical_files: { "conversations.json": { files: [] } } },
			{
				logical_files: { "conversations.json": { files: ["../outside.json"] } },
			},
			{ logical_files: { "conversations.json": { files: ["/abs.json"] } } },
			{ logical_files: { "conversations.json": { files: [7] } } },
		])
			expect(
				await readExportedConversations(
					archive({
						"export_manifest.json": manifest,
						"conversations.json": [{ id: "a" }],
					}),
				),
			).toEqual({ ok: true, entries: [{ id: "a" }] });
	});

	it("keeps one entry per conversation, the first, so the list and the import agree", async () => {
		const result = await readExportedConversations(
			archive({
				"export_manifest.json": {
					logical_files: {
						"conversations.json": {
							files: ["conversations-0001.json", "conversations-0002.json"],
						},
					},
				},
				"conversations-0001.json": [
					{ conversation_id: "a", title: "first" },
					{ title: "no id" },
				],
				"conversations-0002.json": [
					{ id: "a", title: "again" },
					{ title: "no id" },
					{ id: "b" },
				],
			}),
		);
		expect(result).toEqual({
			ok: true,
			entries: [
				{ conversation_id: "a", title: "first" },
				{ title: "no id" },
				{ title: "no id" },
				{ id: "b" },
			],
		});
	});

	it("says which file is missing, unreadable or not a list", async () => {
		expect(await readExportedConversations(archive({}))).toEqual({
			ok: false,
			problem: "missing",
			file: "conversations.json",
		});
		expect(
			await readExportedConversations(
				archive({ "conversations.json": "{oops" }),
			),
		).toMatchObject({
			ok: false,
			problem: "unreadable",
			file: "conversations.json",
		});
		expect(
			await readExportedConversations(
				archive({ "conversations.json": { conversations: [] } }),
			),
		).toEqual({ ok: false, problem: "not_a_list", file: "conversations.json" });
	});
});
