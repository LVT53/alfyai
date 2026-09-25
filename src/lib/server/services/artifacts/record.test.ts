import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";
import { NOW, seedConversation, seedUser } from "./artifacts.test-helpers";
import type { CreatableArtifactKind } from "./types";

let memory: InMemoryDatabase;

vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));

const {
	createArtifact,
	deleteArtifact,
	getArtifact,
	hashArtifactBody,
	kindForArtifactRow,
	updateArtifactBody,
} = await import("./index");
const { ARTIFACT_BODY_MAX_BYTES, ARTIFACT_TITLE_MAX_CHARS } = await import(
	"./limits"
);

const OWNER = "user-owner";
const STRANGER = "user-stranger";
const CONVERSATION = "conv-owner";
const INCOGNITO = "conv-incognito";
const STRANGER_CONVERSATION = "conv-stranger";

function artifactRow(id: string) {
	return memory.db
		.select()
		.from(schema.artifacts)
		.where(eq(schema.artifacts.id, id))
		.get();
}

function versionRows(artifactId: string) {
	return memory.db
		.select()
		.from(schema.artifactVersions)
		.where(eq(schema.artifactVersions.artifactId, artifactId))
		.all();
}

async function createDocument(
	overrides: Partial<Parameters<typeof createArtifact>[0]> = {},
) {
	const result = await createArtifact({
		userId: OWNER,
		conversationId: CONVERSATION,
		kind: "document",
		title: "Saturday plan",
		body: "- [ ] Book museum tickets",
		author: "alfy",
		versionSummary: "Alfy wrote the first draft",
		...overrides,
	});
	if (!result.ok) throw new Error(`create refused: ${result.reason}`);
	return result.artifact;
}

beforeEach(() => {
	memory = createInMemoryDatabase();
	seedUser(memory, OWNER);
	seedUser(memory, STRANGER);
	seedConversation(memory, { id: CONVERSATION, userId: OWNER });
	seedConversation(memory, {
		id: INCOGNITO,
		userId: OWNER,
		memoryIncognito: true,
	});
	seedConversation(memory, { id: STRANGER_CONVERSATION, userId: STRANGER });
});

afterEach(() => {
	memory.close();
});

describe("hashArtifactBody", () => {
	it("is the sha256 hex of the exact stored string", () => {
		const body = "Szombat: Naschmarkt, then the Secession\n";
		expect(hashArtifactBody(body)).toBe(
			createHash("sha256").update(body, "utf8").digest("hex"),
		);
		// Bytes, not a canonical form: slice 1 canonicalises its INPUT.
		expect(hashArtifactBody(`${body} `)).not.toBe(hashArtifactBody(body));
	});
});

describe("createArtifact", () => {
	it("writes an 'artifact' row carrying its kind in metadata, with the first version already present", async () => {
		const artifact = await createDocument();

		const row = artifactRow(artifact.id);
		expect(row).toMatchObject({
			type: "artifact",
			retrievalClass: "durable",
			userId: OWNER,
			conversationId: CONVERSATION,
			name: "Saturday plan",
			contentText: "- [ ] Book museum tickets",
		});
		expect(JSON.parse(row?.metadataJson ?? "null")).toMatchObject({
			artifactType: "document",
			title: "Saturday plan",
		});

		const versions = versionRows(artifact.id);
		expect(versions).toHaveLength(1);
		expect(versions[0]).toMatchObject({
			versionNumber: 1,
			author: "alfy",
			summary: "Alfy wrote the first draft",
			body: "- [ ] Book museum tickets",
			bodyHash: hashArtifactBody("- [ ] Book museum tickets"),
			userId: OWNER,
		});

		expect(artifact).toMatchObject({
			kind: "document",
			title: "Saturday plan",
			conversationId: CONVERSATION,
			versionNumber: 1,
			bodyHash: hashArtifactBody("- [ ] Book museum tickets"),
		});
	});

	it("writes no version for an artifact created without a body", async () => {
		const artifact = await createDocument({ kind: "canvas", body: null });

		expect(versionRows(artifact.id)).toEqual([]);
		expect(artifact.versionNumber).toBe(0);
		expect(artifact.bodyHash).toBeNull();
	});

	it("clamps a long title instead of refusing the artifact", async () => {
		const longTitle = "Vienna ".repeat(80);
		const artifact = await createDocument({ title: longTitle });

		expect(Array.from(artifact.title)).toHaveLength(ARTIFACT_TITLE_MAX_CHARS);
		expect(artifactRow(artifact.id)?.name).toBe(artifact.title);
	});

	it("refuses another user's conversation with the same reason as a missing one, and writes nothing", async () => {
		for (const conversationId of [STRANGER_CONVERSATION, "conv-missing"]) {
			const result = await createArtifact({
				userId: OWNER,
				conversationId,
				kind: "document",
				title: "Probe",
				body: "x",
			});
			expect(result).toEqual({ ok: false, reason: "conversation_not_found" });
		}
		expect(memory.db.select().from(schema.artifacts).all()).toEqual([]);
	});

	it("refuses a body over the byte cap and writes nothing", async () => {
		const result = await createArtifact({
			userId: OWNER,
			conversationId: CONVERSATION,
			kind: "document",
			title: "Too big",
			body: "a".repeat(ARTIFACT_BODY_MAX_BYTES + 1),
		});

		expect(result).toEqual({ ok: false, reason: "too_large" });
		expect(memory.db.select().from(schema.artifacts).all()).toEqual([]);
		expect(memory.db.select().from(schema.artifactVersions).all()).toEqual([]);
	});

	// Runtime validation, not just the compile-time CreatableArtifactKind
	// union: slice 5's tools hand this a model-supplied string, so "file" (a
	// produced file stays generated_output — ruling 18) and any other
	// unrecognised value must be refused at runtime, the same as a caller who
	// never went through TypeScript at all.
	it("refuses a kind outside the four creatable ones, and writes nothing", async () => {
		for (const kind of ["file", "spreadsheet", ""]) {
			const result = await createArtifact({
				userId: OWNER,
				conversationId: CONVERSATION,
				kind: kind as CreatableArtifactKind,
				title: "Probe",
				body: "x",
			});
			expect(result).toEqual({ ok: false, reason: "invalid_kind" });
		}
		expect(memory.db.select().from(schema.artifacts).all()).toEqual([]);
	});

	it("refuses a title that is empty after trimming, and writes nothing", async () => {
		for (const title of ["", "   ", "\n\t "]) {
			const result = await createArtifact({
				userId: OWNER,
				conversationId: CONVERSATION,
				kind: "document",
				title,
				body: "x",
			});
			expect(result).toEqual({ ok: false, reason: "invalid_title" });
		}
		expect(memory.db.select().from(schema.artifacts).all()).toEqual([]);
	});

	it("stores the trimmed title, not the raw one", async () => {
		const artifact = await createDocument({ title: "  Saturday plan  " });
		expect(artifact.title).toBe("Saturday plan");
		expect(artifactRow(artifact.id)?.name).toBe("Saturday plan");
	});
});

describe("getArtifact", () => {
	it("returns the owner's artifact and null — not a throw — for anyone else", async () => {
		const artifact = await createDocument();

		const owned = await getArtifact({ userId: OWNER, artifactId: artifact.id });
		expect(owned).toMatchObject({
			id: artifact.id,
			kind: "document",
			title: "Saturday plan",
			body: "- [ ] Book museum tickets",
			bodyHash: hashArtifactBody("- [ ] Book museum tickets"),
			versionNumber: 1,
			commentCount: 0,
		});

		await expect(
			getArtifact({ userId: STRANGER, artifactId: artifact.id }),
		).resolves.toBeNull();
		await expect(
			getArtifact({ userId: OWNER, artifactId: "missing" }),
		).resolves.toBeNull();
	});

	it("hides an incognito conversation's artifact from the default scope, and shows it to its own conversation and to administration", async () => {
		const artifact = await createDocument({ conversationId: INCOGNITO });

		await expect(
			getArtifact({ userId: OWNER, artifactId: artifact.id }),
		).resolves.toBeNull();
		await expect(
			getArtifact({
				userId: OWNER,
				artifactId: artifact.id,
				conversationId: CONVERSATION,
			}),
		).resolves.toBeNull();

		await expect(
			getArtifact({
				userId: OWNER,
				artifactId: artifact.id,
				conversationId: INCOGNITO,
			}),
		).resolves.toMatchObject({ id: artifact.id });
		await expect(
			getArtifact({
				userId: OWNER,
				artifactId: artifact.id,
				includeIncognito: true,
			}),
		).resolves.toMatchObject({ id: artifact.id });
	});

	it("does not answer for a row outside the family (an uploaded document is not an artifact)", async () => {
		memory.db
			.insert(schema.artifacts)
			.values({
				id: "upload-1",
				userId: OWNER,
				conversationId: CONVERSATION,
				type: "source_document",
				name: "contract.pdf",
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();

		await expect(
			getArtifact({ userId: OWNER, artifactId: "upload-1" }),
		).resolves.toBeNull();
	});
});

describe("updateArtifactBody", () => {
	it("writes the body and appends exactly one version numbered max + 1, hashed from what it stored", async () => {
		const artifact = await createDocument();

		const result = await updateArtifactBody({
			userId: OWNER,
			artifactId: artifact.id,
			body: "- [x] Book museum tickets",
			author: "user",
			summary: "Ticked the tickets",
		});

		expect(result).toEqual({
			ok: true,
			versionId: expect.any(String),
			bodyHash: hashArtifactBody("- [x] Book museum tickets"),
		});
		expect(artifactRow(artifact.id)?.contentText).toBe(
			"- [x] Book museum tickets",
		);
		const versions = versionRows(artifact.id).sort(
			(a, b) => a.versionNumber - b.versionNumber,
		);
		expect(versions.map((row) => row.versionNumber)).toEqual([1, 2]);
		expect(versions[1]).toMatchObject({
			author: "user",
			summary: "Ticked the tickets",
			body: "- [x] Book museum tickets",
			bodyHash: hashArtifactBody("- [x] Book museum tickets"),
		});
	});

	it("refuses a stale base hash and writes nothing", async () => {
		const artifact = await createDocument();

		const result = await updateArtifactBody({
			userId: OWNER,
			artifactId: artifact.id,
			body: "overwritten",
			author: "alfy",
			summary: "Alfy rewrote it",
			baseHash: hashArtifactBody("what Alfy read an hour ago"),
		});

		expect(result).toEqual({ ok: false, reason: "stale" });
		expect(artifactRow(artifact.id)?.contentText).toBe(
			"- [ ] Book museum tickets",
		);
		expect(versionRows(artifact.id)).toHaveLength(1);
	});

	it("accepts the base hash it last handed out", async () => {
		const artifact = await createDocument();
		const read = await getArtifact({ userId: OWNER, artifactId: artifact.id });

		const result = await updateArtifactBody({
			userId: OWNER,
			artifactId: artifact.id,
			body: "- [ ] Book museum tickets\n- [ ] Tell the neighbour",
			author: "alfy",
			summary: "Alfy added a line",
			baseHash: read?.bodyHash ?? undefined,
		});

		expect(result.ok).toBe(true);
	});

	it("refuses a body over the byte cap and writes nothing", async () => {
		const artifact = await createDocument();

		const result = await updateArtifactBody({
			userId: OWNER,
			artifactId: artifact.id,
			body: "a".repeat(ARTIFACT_BODY_MAX_BYTES + 1),
			author: "alfy",
			summary: "Alfy wrote too much",
		});

		expect(result).toEqual({ ok: false, reason: "too_large" });
		expect(versionRows(artifact.id)).toHaveLength(1);
	});

	it("answers not_found for another user's artifact and for an incognito one outside its conversation", async () => {
		const artifact = await createDocument();
		const hidden = await createDocument({ conversationId: INCOGNITO });

		await expect(
			updateArtifactBody({
				userId: STRANGER,
				artifactId: artifact.id,
				body: "hijack",
				author: "user",
				summary: "x",
			}),
		).resolves.toEqual({ ok: false, reason: "not_found" });
		await expect(
			updateArtifactBody({
				userId: OWNER,
				artifactId: hidden.id,
				body: "from outside",
				author: "user",
				summary: "x",
			}),
		).resolves.toEqual({ ok: false, reason: "not_found" });
		expect(versionRows(artifact.id)).toHaveLength(1);
		expect(versionRows(hidden.id)).toHaveLength(1);
	});
});

// Concurrency: each write's version-number read and its insert happen inside
// the SAME db.transaction() call (record.ts), and better-sqlite3 runs that
// callback to completion before yielding back to the event loop — so two
// `Promise.all`-launched writers can race up to the transaction boundary, but
// never inside it. These tests pin that guarantee; ruling 47 depends on it.
describe("updateArtifactBody concurrency", () => {
	it("numbers four concurrent appends consecutively, with no duplicate or gap", async () => {
		const artifact = await createDocument();

		const results = await Promise.all(
			[1, 2, 3, 4].map((n) =>
				updateArtifactBody({
					userId: OWNER,
					artifactId: artifact.id,
					body: `edit ${n}`,
					author: "user",
					summary: `Edit ${n}`,
				}),
			),
		);

		expect(results.every((result) => result.ok)).toBe(true);
		const numbers = versionRows(artifact.id)
			.map((row) => row.versionNumber)
			.sort((a, b) => a - b);
		// Version 1 is the document's own creation; four concurrent edits must
		// land on 2..5 — no duplicate, no gap.
		expect(numbers).toEqual([1, 2, 3, 4, 5]);
	});

	it("lets exactly one of two writers quoting the same baseHash win; the other gets stale", async () => {
		const artifact = await createDocument();
		const read = await getArtifact({ userId: OWNER, artifactId: artifact.id });
		const baseHash = read?.bodyHash ?? undefined;

		const [first, second] = await Promise.all([
			updateArtifactBody({
				userId: OWNER,
				artifactId: artifact.id,
				body: "writer A",
				author: "user",
				summary: "Writer A",
				baseHash,
			}),
			updateArtifactBody({
				userId: OWNER,
				artifactId: artifact.id,
				body: "writer B",
				author: "user",
				summary: "Writer B",
				baseHash,
			}),
		]);

		const outcomes = [first, second];
		expect(outcomes.filter((result) => result.ok)).toHaveLength(1);
		const stale = outcomes.find((result) => !result.ok);
		expect(stale).toMatchObject({ ok: false, reason: "stale" });
		// The winner appended one version onto the document's own version 1.
		expect(versionRows(artifact.id)).toHaveLength(2);
	});
});

describe("deleteArtifact", () => {
	it("removes the artifact and its versions, comments and key-value rows; a second call answers false", async () => {
		const artifact = await createDocument();
		memory.db
			.insert(schema.artifactComments)
			.values({
				id: "comment-1",
				artifactId: artifact.id,
				userId: OWNER,
				anchorJson: JSON.stringify({ kind: "node", nodeId: "n1" }),
				author: "user",
				body: "Too early?",
				createdAt: NOW,
			})
			.run();
		memory.db
			.insert(schema.artifactKv)
			.values({
				id: "kv-1",
				artifactId: artifact.id,
				key: "k",
				valueJson: "1",
				updatedAt: NOW,
			})
			.run();

		await expect(
			deleteArtifact({ userId: STRANGER, artifactId: artifact.id }),
		).resolves.toBe(false);
		await expect(
			deleteArtifact({ userId: OWNER, artifactId: artifact.id }),
		).resolves.toBe(true);

		expect(artifactRow(artifact.id)).toBeUndefined();
		expect(versionRows(artifact.id)).toEqual([]);
		expect(memory.db.select().from(schema.artifactComments).all()).toEqual([]);
		expect(memory.db.select().from(schema.artifactKv).all()).toEqual([]);
		await expect(
			deleteArtifact({ userId: OWNER, artifactId: artifact.id }),
		).resolves.toBe(false);
	});
});

describe("kindForArtifactRow", () => {
	it("reads an 'artifact' row's kind from its metadata", () => {
		expect(
			kindForArtifactRow({
				type: "artifact",
				metadataJson: JSON.stringify({ artifactType: "app", title: "Split" }),
			}),
		).toBe("app");
	});

	it("reads a produced file as kind 'file'", () => {
		expect(
			kindForArtifactRow({
				type: "generated_output",
				metadataJson: JSON.stringify({ originalChatFileId: "file-1" }),
			}),
		).toBe("file");
	});

	it("falls back to 'file' for malformed or unknown metadata instead of throwing", () => {
		for (const metadataJson of [
			"{not json",
			"[]",
			"null",
			JSON.stringify({ artifactType: "spreadsheet", title: "x" }),
			null,
		]) {
			expect(kindForArtifactRow({ type: "artifact", metadataJson })).toBe(
				"file",
			);
		}
	});
});
