// `getLogicalDocumentsForArtifacts` is `getLogicalDocumentForArtifact` for many
// ids at once. Search is about to materialise up to 400 candidates per kind, and
// each single read re-read the person's chats (the ownership scope), so the batch
// reads them once. What it returns, per id, must be exactly what the single
// reader returns. A real migrated in-memory database, so the actual queries run.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";
import type { KnowledgeDocumentItem } from "$lib/server/services/knowledge/types";
import { serializeImageVersionBody } from "$lib/shared/artifacts/image-body";
import { seedUser } from "../../artifacts/artifacts.test-helpers";

let memory: InMemoryDatabase;

vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));

const { getLogicalDocumentForArtifact } = await import("./documents");
const { attachImagePreviews, getLogicalDocumentsForArtifacts } = await import(
	"../store"
);

const OWNER = "owner";
const STRANGER = "stranger";
const CHAT = "chat-owner";
const INCOGNITO_CHAT = "chat-incognito";
const THEIR_CHAT = "chat-theirs";
const NOW = new Date("2026-09-20T10:00:00.000Z");

function minutesAfter(minutes: number): Date {
	return new Date(NOW.getTime() + minutes * 60_000);
}

type ArtifactSeed = {
	id: string;
	type: string;
	name: string;
	userId?: string;
	conversationId?: string | null;
	metadata?: Record<string, unknown>;
	contentText?: string | null;
	summary?: string | null;
	mimeType?: string | null;
	sizeBytes?: number | null;
	updatedAt?: Date;
};

function addArtifact(seed: ArtifactSeed): void {
	memory.db
		.insert(schema.artifacts)
		.values({
			id: seed.id,
			userId: seed.userId ?? OWNER,
			conversationId:
				seed.conversationId === undefined ? CHAT : seed.conversationId,
			type: seed.type,
			retrievalClass: "durable",
			name: seed.name,
			mimeType: seed.mimeType ?? null,
			sizeBytes: seed.sizeBytes ?? null,
			contentText: seed.contentText ?? null,
			summary: seed.summary ?? null,
			metadataJson: seed.metadata ? JSON.stringify(seed.metadata) : null,
			createdAt: NOW,
			updatedAt: seed.updatedAt ?? NOW,
		})
		.run();
}

function addFamilyArtifact(id: string, kind: string, name: string): void {
	addArtifact({
		id,
		type: "artifact",
		name,
		contentText: `${name} body`,
		metadata: { artifactType: kind, title: name },
	});
}

function addDerivedLink(normalizedId: string, sourceId: string): void {
	memory.db
		.insert(schema.artifactLinks)
		.values({
			id: `link-${normalizedId}-${sourceId}`,
			userId: OWNER,
			artifactId: normalizedId,
			relatedArtifactId: sourceId,
			linkType: "derived_from",
			createdAt: NOW,
		})
		.run();
}

function addVersions(artifactId: string, count: number): void {
	for (let versionNumber = 1; versionNumber <= count; versionNumber++) {
		memory.db
			.insert(schema.artifactVersions)
			.values({
				id: `${artifactId}-v${versionNumber}`,
				artifactId,
				userId: OWNER,
				versionNumber,
				author: versionNumber === 1 ? "alfy" : "user",
				summary: versionNumber === 1 ? "Created" : "Edited",
				body: `body ${versionNumber}`,
				bodyHash: `hash-${artifactId}-${versionNumber}`,
				createdAt: minutesAfter(versionNumber),
			})
			.run();
	}
}

function addGeneratedOutput(
	id: string,
	params: {
		family?: string;
		version?: number;
		minutes: number;
		withFile?: boolean;
		export?: boolean;
	},
): void {
	addArtifact({
		id,
		type: "generated_output",
		name: `${id}.pdf`,
		mimeType: "application/pdf",
		updatedAt: minutesAfter(params.minutes),
		metadata: {
			...(params.withFile === false ? {} : { sourceChatFileId: `file-${id}` }),
			...(params.family
				? {
						documentFamilyId: params.family,
						documentLabel: "Quarterly report",
						documentRole: "Atlas research report",
						versionNumber: params.version,
						originConversationId: CHAT,
						originAssistantMessageId: `message-${id}`,
					}
				: {}),
			...(params.export ? { artifactExport: true } : {}),
		},
	});
}

/** Every id the fixture holds, in a fixed order, with the ones that must stay hidden last. */
const VISIBLE_IDS = [
	"doc-1",
	"doc-2",
	"slides-1",
	"canvas-1",
	"app-1",
	"image-1",
	"video-1",
	"src-1",
	"norm-1",
	"src-2",
	"norm-2",
	"src-3",
	"norm-3",
	"src-4",
	"src-5",
	"src-6",
	"gen-a1",
	"gen-a2",
	"gen-a3",
	"gen-b",
	"note-1",
	"note-2",
	"library-upload",
	"src-dup-a",
	"src-dup-b",
	"norm-dup",
] as const;

const HIDDEN_IDS = [
	"gen-process",
	"gen-export",
	"incognito-doc",
	"their-doc",
	"their-upload",
	"orphan-gen",
	"missing-id",
] as const;

beforeEach(() => {
	memory = createInMemoryDatabase();
	seedUser(memory, OWNER);
	seedUser(memory, STRANGER);
	for (const [id, userId, memoryIncognito] of [
		[CHAT, OWNER, false],
		[INCOGNITO_CHAT, OWNER, true],
		[THEIR_CHAT, STRANGER, false],
	] as const) {
		memory.db
			.insert(schema.conversations)
			.values({
				id,
				userId,
				title: id,
				memoryIncognito,
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
	}

	addFamilyArtifact("doc-1", "document", "Trip plan");
	addVersions("doc-1", 3);
	addFamilyArtifact("doc-2", "document", "Packing list");
	addFamilyArtifact("slides-1", "slides", "Pitch deck");
	addFamilyArtifact("canvas-1", "canvas", "Route board");
	addFamilyArtifact("app-1", "app", "Countdown");
	addFamilyArtifact("image-1", "image", "Lamplight");
	addFamilyArtifact("video-1", "video", "Turntable");

	for (const index of [1, 2, 3]) {
		addArtifact({
			id: `src-${index}`,
			type: "source_document",
			name: `Contract ${index}.pdf`,
			mimeType: "application/pdf",
			sizeBytes: 1000 + index,
			updatedAt: minutesAfter(index),
		});
		addArtifact({
			id: `norm-${index}`,
			type: "normalized_document",
			name: `Contract ${index}.pdf`,
			summary: `Summary of contract ${index}`,
			contentText: `Normalized text of contract ${index}`,
			updatedAt: minutesAfter(index + 10),
		});
		addDerivedLink(`norm-${index}`, `src-${index}`);
	}
	for (const index of [4, 5, 6]) {
		addArtifact({
			id: `src-${index}`,
			type: "source_document",
			name: `Notes ${index}.txt`,
			mimeType: "text/plain",
			updatedAt: minutesAfter(index),
		});
	}
	addArtifact({
		id: "library-upload",
		type: "source_document",
		name: "Library.pdf",
		conversationId: null,
		mimeType: "application/pdf",
	});

	// One normalized text two uploads were both read into: it belongs to two
	// records, and the record shown is the newest, as the single reader picks it.
	addArtifact({
		id: "src-dup-a",
		type: "source_document",
		name: "Same file, newer.pdf",
		updatedAt: minutesAfter(50),
	});
	addArtifact({
		id: "src-dup-b",
		type: "source_document",
		name: "Same file, older.pdf",
		updatedAt: minutesAfter(5),
	});
	addArtifact({
		id: "norm-dup",
		type: "normalized_document",
		name: "Same file.pdf",
		contentText: "Shared text",
		updatedAt: minutesAfter(30),
	});
	addDerivedLink("norm-dup", "src-dup-a");
	addDerivedLink("norm-dup", "src-dup-b");

	addGeneratedOutput("gen-a1", { family: "fam-a", version: 1, minutes: 20 });
	addGeneratedOutput("gen-a2", { family: "fam-a", version: 2, minutes: 21 });
	addGeneratedOutput("gen-a3", { family: "fam-a", version: 3, minutes: 22 });
	addGeneratedOutput("gen-b", { minutes: 23 });
	addGeneratedOutput("gen-process", { minutes: 24, withFile: false });
	addGeneratedOutput("gen-export", { minutes: 25, export: true });
	addArtifact({
		id: "orphan-gen",
		type: "generated_output",
		name: "orphan.pdf",
		conversationId: null,
		metadata: { sourceChatFileId: "file-orphan" },
	});
	for (const index of [1, 2]) {
		addArtifact({
			id: `note-${index}`,
			type: "skill_note",
			name: `Skill note ${index}`,
			summary: "How to do it",
			contentText: "Steps",
			updatedAt: minutesAfter(30 + index),
		});
	}

	addArtifact({
		id: "incognito-doc",
		type: "artifact",
		name: "Private plan",
		conversationId: INCOGNITO_CHAT,
		metadata: { artifactType: "document" },
	});
	addArtifact({
		id: "their-doc",
		type: "artifact",
		name: "Their plan",
		userId: STRANGER,
		conversationId: THEIR_CHAT,
		metadata: { artifactType: "document" },
	});
	addArtifact({
		id: "their-upload",
		type: "source_document",
		name: "Theirs.pdf",
		userId: STRANGER,
		conversationId: THEIR_CHAT,
	});
});

afterEach(() => {
	memory.close();
});

describe("getLogicalDocumentsForArtifacts", () => {
	it("returns what the single reader returns, for every id", async () => {
		// A generated family's versions are listed in the order they were met, and
		// a single read meets the id it was asked for first; the set is what counts.
		const settled = (item: KnowledgeDocumentItem | null | undefined) =>
			item
				? { ...item, familyArtifactIds: [...item.familyArtifactIds].sort() }
				: null;
		const ids = [...VISIBLE_IDS, ...HIDDEN_IDS];
		const batch = await getLogicalDocumentsForArtifacts(OWNER, ids);
		let present = 0;
		for (const id of ids) {
			const single = await getLogicalDocumentForArtifact(OWNER, id);
			if (single) present++;
			expect(settled(batch.get(id)), id).toEqual(settled(single));
		}
		// The comparison above is only worth something if most ids are real.
		expect(present).toBeGreaterThanOrEqual(20);
	});

	it("reads each kind the way the single reader does", async () => {
		const batch = await getLogicalDocumentsForArtifacts(OWNER, [
			...VISIBLE_IDS,
			...HIDDEN_IDS,
		]);
		expect(batch.get("doc-1")).toMatchObject({
			kind: "document",
			name: "Trip plan",
			artifactVersionNumber: 3,
		});
		for (const [id, kind] of [
			["slides-1", "slides"],
			["canvas-1", "canvas"],
			["app-1", "app"],
			["image-1", "image"],
			["video-1", "video"],
		] as const) {
			expect(batch.get(id)?.kind, id).toBe(kind);
		}
		// A source and its normalized text are one document, found by either id.
		expect(batch.get("norm-dup")?.displayArtifactId).toBe("src-dup-a");
		expect(batch.get("src-1")?.displayArtifactId).toBe("src-1");
		expect(batch.get("norm-1")?.displayArtifactId).toBe("src-1");
		expect(batch.get("norm-1")?.promptArtifactId).toBe("norm-1");
		// A generated document's versions are one family, found by any of them.
		for (const id of ["gen-a1", "gen-a2", "gen-a3"]) {
			expect(batch.get(id)?.familyArtifactIds.sort(), id).toEqual([
				"gen-a1",
				"gen-a2",
				"gen-a3",
			]);
			expect(batch.get(id)?.displayArtifactId, id).toBe("gen-a3");
		}
		expect(batch.get("note-1")?.documentOrigin).toBe("skill_note");
		expect(batch.get("library-upload")?.name).toBe("Library.pdf");
	});

	it("leaves out what the person cannot open", async () => {
		const batch = await getLogicalDocumentsForArtifacts(OWNER, [
			...VISIBLE_IDS,
			...HIDDEN_IDS,
		]);
		for (const id of HIDDEN_IDS) {
			expect(batch.has(id), id).toBe(false);
		}
		// Another person's own ids answer nothing for this one.
		const theirs = await getLogicalDocumentsForArtifacts(STRANGER, [
			"doc-1",
			"src-1",
			"their-doc",
		]);
		expect([...theirs.keys()]).toEqual(["their-doc"]);
	});

	it("answers an empty map for no ids, without a query", async () => {
		const prepare = vi.spyOn(memory.sqlite, "prepare");
		expect((await getLogicalDocumentsForArtifacts(OWNER, [])).size).toBe(0);
		expect(
			(await getLogicalDocumentsForArtifacts(OWNER, ["", "   "])).size,
		).toBe(0);
		expect(prepare).not.toHaveBeenCalled();
	});

	it("takes a padded or repeated id once, under its trimmed name", async () => {
		const batch = await getLogicalDocumentsForArtifacts(OWNER, [
			"  doc-1  ",
			"doc-1",
			"doc-2",
		]);
		expect([...batch.keys()].sort()).toEqual(["doc-1", "doc-2"]);
	});

	it("reads the person's chats once, however many ids it is given", async () => {
		const prepare = vi.spyOn(memory.sqlite, "prepare");
		const chatReads = () =>
			prepare.mock.calls.filter(([sql]) =>
				/from "conversations"/.test(String(sql)),
			).length;

		await getLogicalDocumentsForArtifacts(OWNER, [
			...VISIBLE_IDS,
			...HIDDEN_IDS,
		]);
		expect(chatReads()).toBe(1);

		// What each single read costs, so the one above is a saving and not luck.
		prepare.mockClear();
		await getLogicalDocumentForArtifact(OWNER, "src-1");
		await getLogicalDocumentForArtifact(OWNER, "doc-1");
		await getLogicalDocumentForArtifact(OWNER, "gen-a1");
		expect(chatReads()).toBe(3);
	});

	it("runs a fixed number of queries, not one set per id", async () => {
		const prepare = vi.spyOn(memory.sqlite, "prepare");
		await getLogicalDocumentsForArtifacts(OWNER, ["src-1"]);
		const forOne = prepare.mock.calls.length;
		prepare.mockClear();
		await getLogicalDocumentsForArtifacts(OWNER, [
			...VISIBLE_IDS,
			...HIDDEN_IDS,
		]);
		expect(prepare.mock.calls.length).toBeLessThanOrEqual(forOne + 8);
		expect(prepare.mock.calls.length).toBeLessThan(VISIBLE_IDS.length);
	});
});

describe("attachImagePreviews", () => {
	it("puts a picture's own thumbnail on its item, and never another person's", async () => {
		const body = (fileId: string) =>
			serializeImageVersionBody({
				v: 1,
				fileId,
				width: 1248,
				height: 832,
				hasAlpha: false,
				baseFileId: null,
				sources: [],
				marks: null,
				prompt: "a timber house",
				takeId: null,
				seed: 1,
				anchorFileId: null,
				chainSinceAnchor: 0,
			});
		addArtifact({
			id: "pic-mine",
			type: "artifact",
			name: "Mine",
			metadata: { artifactType: "image" },
			contentText: body("file-mine"),
		});
		addArtifact({
			id: "pic-theirs",
			type: "artifact",
			name: "Theirs",
			userId: STRANGER,
			conversationId: THEIR_CHAT,
			metadata: { artifactType: "image" },
			contentText: body("file-theirs"),
		});
		const item = (id: string) =>
			({ id, kind: "image" }) as KnowledgeDocumentItem;

		const [mine, theirs] = await attachImagePreviews(OWNER, [
			item("pic-mine"),
			item("pic-theirs"),
		]);

		expect(mine.imagePreview).toMatchObject({
			fileId: "file-mine",
			width: 1248,
			height: 832,
		});
		expect(theirs.imagePreview).toBeUndefined();
	});
});
