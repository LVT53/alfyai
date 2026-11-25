import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
	CONVERSATIONS_PER_FILE,
	exportedConversationId,
	exportedConversationProjectId,
	readExportedConversations,
	writeExportedConversations,
} from "./chatgpt-export";

// A project's id as a late-2026 export writes it: "g-p-" and 32 hex digits.
const PROJECT_A = "g-p-0123456789abcdef0123456789abcdef";
const PROJECT_B = "g-p-fedcba9876543210fedcba9876543210";

describe("exportedConversationProjectId", () => {
	it("names the project a newer export records as the chat's template", () => {
		expect(
			exportedConversationProjectId({
				conversation_id: "c",
				conversation_template_id: PROJECT_A,
			}),
		).toBe(PROJECT_A);
	});

	it("reads the gizmo_id an older export records it in", () => {
		expect(
			exportedConversationProjectId({
				gizmo_id: PROJECT_B,
				conversation_template_id: null,
			}),
		).toBe(PROJECT_B);
	});

	it("does not take a custom GPT for a project", () => {
		expect(
			exportedConversationProjectId({ conversation_template_id: "g-abc123" }),
		).toBeNull();
		expect(exportedConversationProjectId({ gizmo_id: "g-abc123" })).toBeNull();
	});

	it("names none for a chat in no project, or for an entry that is not a chat", () => {
		for (const entry of [
			{ conversation_template_id: null },
			{ conversation_template_id: "g-p-" },
			{ conversation_template_id: 7 },
			{},
			null,
			"g-p-abc",
			[PROJECT_A],
		])
			expect(exportedConversationProjectId(entry)).toBeNull();
	});
});

describe("writeExportedConversations", () => {
	// A stand-in for a JSZip archive being written: the paths and their text.
	function writer() {
		const files = new Map<string, string>();
		return {
			files,
			file(path: string, data: string) {
				files.set(path, data);
			},
			// The same archive read back, as `readExportedConversations` reads one.
			reader() {
				return {
					file(path: string) {
						const text = files.get(path);
						return text === undefined ? null : { async: async () => text };
					},
				};
			},
		};
	}

	it("writes conversations that readExportedConversations reads back, in order", async () => {
		const entries = [
			{ conversation_id: "a", conversation_template_id: PROJECT_A },
			{ id: "b", title: "Ünnep és ő" },
		];
		const zip = writer();

		writeExportedConversations(entries, zip);

		expect(await readExportedConversations(zip.reader())).toEqual({
			ok: true,
			entries,
		});
	});

	it("splits them into files of 100, as ChatGPT's own exports do, and lists the files in the manifest", async () => {
		const entries = Array.from(
			{ length: 2 * CONVERSATIONS_PER_FILE + 50 },
			(_, i) => ({
				id: `c-${i}`,
			}),
		);
		const zip = writer();

		writeExportedConversations(entries, zip);

		const manifest = JSON.parse(
			zip.files.get("export_manifest.json") ?? "null",
		);
		expect(manifest.logical_files["conversations.json"]).toEqual({
			files: [
				"conversations-000.json",
				"conversations-001.json",
				"conversations-002.json",
			],
			sharded: true,
			shard_count: 3,
		});
		expect(
			JSON.parse(zip.files.get("conversations-002.json") ?? "[]"),
		).toHaveLength(50);
		expect(await readExportedConversations(zip.reader())).toEqual({
			ok: true,
			entries,
		});
	});

	it("makes a ZIP the server's reader takes, with JSZip itself", async () => {
		const entries = [{ id: "a", conversation_template_id: PROJECT_B }];
		const zip = new JSZip();

		writeExportedConversations(entries, zip);
		const read = await readExportedConversations(
			await JSZip.loadAsync(
				await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }),
			),
		);

		expect(read).toEqual({ ok: true, entries });
	});
});

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
