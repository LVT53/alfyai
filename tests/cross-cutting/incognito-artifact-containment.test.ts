// What an incognito conversation's output is allowed to reach: nothing.
//
// The promise is made in the composer's own words — "Incognito · nothing here
// is remembered", "Nothing in this chat is remembered" — and in the privacy
// policy, which calls it "saved-but-untracked": the chat is kept so the user
// can revisit it, and it is "never tracked or used to personalize future
// replies". Until this suite existed the promise was enforced on the MEMORY
// pipeline only. Files were a second, undeclared channel: a file produced in
// an incognito chat became a durable `generated_output` artifact, was listed
// in the Knowledge library, and was picked by the evidence selector of a
// later, ordinary conversation, which quoted its text and its chat-file id
// back to the user.
//
// The boundary is enforced in ONE place — `getArtifactOwnershipScope`, which
// every user-scoped artifact query derives its answer from — so this file has
// two halves:
//
//   PART A, behaviour: produce and upload inside an incognito conversation,
//   then try to reach it from a normal one through every path that exists.
//   And the two directions that must keep working: inside the incognito
//   conversation itself, and a normal conversation's own files.
//
//   PART B, a guard: every file in `src/lib/server` that queries `artifacts`,
//   `artifact_chunks` or `chat_generated_files` by user goes through that
//   scope, or is named here with the reason it does not. `project_knowledge_links`
//   is covered by the same rule since Workspaces Slice E added it: a link row
//   names an artifact, so an unscoped user-level read of links is a second way
//   to enumerate files a user's chats hold — whose names then reach a prompt
//   through the project file list.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative as relativePath } from "node:path";
import { eq, getTableColumns } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";

let memory: InMemoryDatabase;

vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));

vi.mock("$lib/server/services/tei-reranker", () => ({
	canUseTeiReranker: vi.fn(() => false),
	rerankItems: vi.fn(),
}));

vi.mock("$lib/server/services/tei-embedder", () => ({
	canUseTeiEmbedder: vi.fn(() => false),
	embedTexts: vi.fn(),
	embedText: vi.fn(),
}));

vi.mock("$lib/server/services/task-state/control-model", () => ({
	canUseContextSummarizer: vi.fn(() => false),
	requestContextSummarizer: vi.fn(),
}));

const { listKnowledgeArtifacts } = await import(
	"$lib/server/services/knowledge"
);
// Slice 7: the artifact-family merge this suite's PART A now covers.
const { listLogicalDocumentsPage } = await import(
	"$lib/server/services/knowledge/store"
);
const { findRelevantKnowledgeArtifacts, getConversationWorkingSet } =
	await import("$lib/server/services/knowledge/context");
const { readGeneratedFileContent } = await import(
	"$lib/server/services/normal-chat-tools/read-generated-file"
);
const { searchWorkspace } = await import(
	"$lib/server/services/workspace-search"
);
const { deleteConversationWithCleanup } = await import(
	"$lib/server/services/cleanup/conversation-cleanup"
);

const USER = "user-1";
const INCOGNITO = "conv-incognito";
const NORMAL = "conv-normal";
const NOW = new Date("2026-09-20T10:00:00.000Z");

/** A word that exists ONLY inside the incognito conversation's output. */
const SECRET_WORD = "zalophus";
const SECRET_FILENAME = "severance-plan.md";
const SECRET_UPLOAD = "severance-contract.md";

function seedUser(id: string) {
	memory.db
		.insert(schema.users)
		.values({
			id,
			email: `${id}@example.com`,
			passwordHash: "hash",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

function seedConversation(id: string, memoryIncognito: boolean) {
	memory.db
		.insert(schema.conversations)
		.values({
			id,
			userId: USER,
			title: id,
			memoryIncognito,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

function seedArtifact(params: {
	conversationId: string | null;
	type: "generated_output" | "normalized_document" | "source_document";
	name: string;
	contentText: string;
	metadata?: Record<string, unknown>;
}): string {
	const id = `artifact-${params.type}-${params.name}-${params.conversationId}`;
	memory.db
		.insert(schema.artifacts)
		.values({
			id,
			userId: USER,
			conversationId: params.conversationId,
			type: params.type,
			retrievalClass: "durable",
			name: params.name,
			mimeType: "text/markdown",
			extension: "md",
			sizeBytes: params.contentText.length,
			contentText: params.contentText,
			summary: params.contentText.slice(0, 240),
			metadataJson: params.metadata ? JSON.stringify(params.metadata) : null,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	memory.db
		.insert(schema.artifactChunks)
		.values({
			id: `${id}:0`,
			artifactId: id,
			userId: USER,
			conversationId: params.conversationId,
			chunkIndex: 0,
			contentText: params.contentText,
			tokenEstimate: 10,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	return id;
}

/**
 * An upload as ingestion leaves it: the stored source document and the
 * normalized text derived from it, joined by the `derived_from` link the
 * library pairs them with.
 */
function seedUpload(conversationId: string, name: string, text: string) {
	const sourceId = seedArtifact({
		conversationId,
		type: "source_document",
		name,
		contentText: text,
	});
	const normalizedId = seedArtifact({
		conversationId,
		type: "normalized_document",
		name: `${name.replace(/\.[^.]+$/, "")}.md`,
		contentText: text,
		metadata: { normalizedFrom: name },
	});
	memory.db
		.insert(schema.artifactLinks)
		.values({
			id: `link-${normalizedId}`,
			userId: USER,
			artifactId: normalizedId,
			relatedArtifactId: sourceId,
			conversationId,
			linkType: "derived_from",
			createdAt: NOW,
		})
		.run();
	return { sourceId, normalizedId };
}

function seedChatFile(conversationId: string, filename: string) {
	const id = `file-${filename}-${conversationId}`;
	memory.db
		.insert(schema.chatGeneratedFiles)
		.values({
			id,
			conversationId,
			userId: USER,
			filename,
			mimeType: "text/markdown",
			sizeBytes: 64,
			storagePath: `${conversationId}/${filename}`,
			createdAt: NOW,
		})
		.run();
	return id;
}

/**
 * What an incognito conversation leaves behind: a produced file with its
 * durable artifact, and an uploaded document indexed under its own name.
 */
function seedIncognitoWork() {
	const fileId = seedChatFile(INCOGNITO, SECRET_FILENAME);
	const artifactId = seedArtifact({
		conversationId: INCOGNITO,
		type: "generated_output",
		name: SECRET_FILENAME,
		contentText: [
			`Generated file: ${SECRET_FILENAME}`,
			"File type: text/markdown",
			`Chat file id: ${fileId}`,
			`Generated in conversation: ${INCOGNITO}`,
			"Generated file version: v1",
			"",
			"Extracted file content:",
			`The ${SECRET_WORD} severance schedule.`,
		].join("\n"),
		metadata: {
			generatedFile: true,
			originalChatFileId: fileId,
			generatedFilename: SECRET_FILENAME,
			documentFamilyId: "family-secret",
			documentLabel: SECRET_FILENAME,
			versionNumber: 1,
		},
	});
	const { normalizedId: uploadId, sourceId } = seedUpload(
		INCOGNITO,
		SECRET_UPLOAD,
		`A ${SECRET_WORD} contract, uploaded in an incognito chat.`,
	);
	return { fileId, artifactId, uploadId, sourceId };
}

beforeEach(() => {
	memory = createInMemoryDatabase();
	seedUser(USER);
	seedConversation(INCOGNITO, true);
	seedConversation(NORMAL, false);
});

afterEach(() => {
	memory.close();
});

describe("an incognito conversation's output, from a NORMAL conversation", () => {
	beforeEach(() => {
		seedIncognitoWork();
	});

	it("is not offered to evidence selection", async () => {
		const picked = await findRelevantKnowledgeArtifacts({
			userId: USER,
			query: `${SECRET_WORD} severance schedule`,
			excludeConversationId: NORMAL,
			currentConversationId: NORMAL,
			limit: 10,
		});

		expect(JSON.stringify(picked)).not.toContain(SECRET_WORD);
		expect(picked.map((artifact) => artifact.name)).not.toContain(
			SECRET_FILENAME,
		);
	});

	it("is not in the Knowledge library", async () => {
		const library = await listKnowledgeArtifacts(USER);

		expect(JSON.stringify(library)).not.toContain(SECRET_WORD);
		expect(JSON.stringify(library)).not.toContain(SECRET_FILENAME);
		expect(JSON.stringify(library)).not.toContain(SECRET_UPLOAD);
	});

	it("is not in workspace search", async () => {
		// A normal conversation's upload carrying the SAME word, so a document
		// that should be found proves the search path is live and the one that
		// must not be found is being excluded rather than merely missed.
		seedUpload(
			NORMAL,
			"public-notes.md",
			`A ${SECRET_WORD} note from an ordinary chat.`,
		);

		const found = await searchWorkspace(USER, { query: SECRET_WORD });

		const names = found.documents.map((document) => document.name);
		expect(names).toContain("public-notes.md");
		expect(names).not.toContain(SECRET_UPLOAD);
	});

	// Ruling 60: the Documents tab's second-tier file-family filter. Both of
	// `seedIncognitoWork`'s rows (the generated "severance-plan.md" and the
	// uploaded "severance-contract.md") are Markdown, so a containment break
	// would land them in "textMarkdown" beside the normal upload below.
	it("is not counted in listLogicalDocumentsPage's countsByFileFamily", async () => {
		seedUpload(
			NORMAL,
			"public-notes.md",
			`A ${SECRET_WORD} note from an ordinary chat.`,
		);

		const page = await listLogicalDocumentsPage(USER, {
			includeGeneratedOutputs: true,
			limit: 50,
		});

		expect(page.countsByFileFamily.textMarkdown).toBe(1);
		// The NORMAL upload's own text legitimately contains SECRET_WORD (that
		// is what makes it findable at all) — the two incognito filenames are
		// what must never surface, same as the sibling "workspace search" test.
		expect(JSON.stringify(page)).not.toContain(SECRET_FILENAME);
		expect(JSON.stringify(page)).not.toContain(SECRET_UPLOAD);
	});

	it("is not in the working set, even if something linked it there", async () => {
		memory.db
			.insert(schema.conversationWorkingSetItems)
			.values({
				id: "working-set-1",
				userId: USER,
				conversationId: NORMAL,
				artifactId: `artifact-generated_output-${SECRET_FILENAME}-${INCOGNITO}`,
				artifactType: "generated_output",
				score: 100,
				state: "active",
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();

		const workingSet = await getConversationWorkingSet(USER, NORMAL);

		expect(workingSet).toEqual([]);
	});

	it("cannot be read back by name, and is not named as a candidate", async () => {
		const result = await readGeneratedFileContent({
			userId: USER,
			conversationId: NORMAL,
			filename: SECRET_FILENAME,
		});

		expect(result.notFound).toBe(true);
		expect(JSON.stringify(result)).not.toContain(SECRET_WORD);
		expect(
			result.candidates.map((candidate) => candidate.filename),
		).not.toContain(SECRET_FILENAME);
	});

	it("cannot be read back as an uploaded document either", async () => {
		const result = await readGeneratedFileContent({
			userId: USER,
			conversationId: NORMAL,
			filename: SECRET_UPLOAD,
		});

		expect(result.notFound).toBe(true);
		expect(JSON.stringify(result)).not.toContain(SECRET_WORD);
	});

	it("is not counted as a version of a family a normal conversation continues", async () => {
		const normalFileId = seedChatFile(NORMAL, SECRET_FILENAME);
		seedArtifact({
			conversationId: NORMAL,
			type: "generated_output",
			name: SECRET_FILENAME,
			contentText:
				"Generated file: severance-plan.md\n\nExtracted file content:\nA fresh plan.",
			metadata: {
				generatedFile: true,
				originalChatFileId: normalFileId,
				documentFamilyId: "family-secret",
				documentLabel: SECRET_FILENAME,
				versionNumber: 2,
			},
		});

		const result = await readGeneratedFileContent({
			userId: USER,
			conversationId: NORMAL,
			filename: SECRET_FILENAME,
		});

		expect(result.conversation).toBe("this");
		// v2 of a family whose v1 lives in an incognito chat: one reachable
		// version, never "of 2".
		expect(result.versionCount).toBe(1);
	});
});

describe("inside the incognito conversation, everything still works", () => {
	beforeEach(() => {
		seedIncognitoWork();
	});

	it("reads its own produced file back", async () => {
		const result = await readGeneratedFileContent({
			userId: USER,
			conversationId: INCOGNITO,
			filename: SECRET_FILENAME,
		});

		expect(result.notFound).toBe(false);
		expect(result.conversation).toBe("this");
		expect(result.contentText).toContain(SECRET_WORD);
	});

	it("reads its own uploaded document back", async () => {
		const result = await readGeneratedFileContent({
			userId: USER,
			conversationId: INCOGNITO,
			filename: SECRET_UPLOAD,
		});

		expect(result.notFound).toBe(false);
		expect(result.source).toBe("document");
		expect(result.contentText).toContain(SECRET_WORD);
	});

	it("keeps its own working set", async () => {
		memory.db
			.insert(schema.conversationWorkingSetItems)
			.values({
				id: "working-set-own",
				userId: USER,
				conversationId: INCOGNITO,
				artifactId: `artifact-generated_output-${SECRET_FILENAME}-${INCOGNITO}`,
				artifactType: "generated_output",
				score: 100,
				state: "active",
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();

		const workingSet = await getConversationWorkingSet(USER, INCOGNITO);

		expect(workingSet.map((item) => item.name)).toEqual([SECRET_FILENAME]);
	});
});

describe("a normal conversation's own files are unaffected", () => {
	it("still reads back, and still shows in the library", async () => {
		seedIncognitoWork();
		const normalFileId = seedChatFile(NORMAL, "quarterly.md");
		seedArtifact({
			conversationId: NORMAL,
			type: "generated_output",
			name: "quarterly.md",
			contentText:
				"Generated file: quarterly.md\n\nExtracted file content:\nOrdinary quarterly numbers.",
			metadata: {
				generatedFile: true,
				originalChatFileId: normalFileId,
				documentLabel: "quarterly.md",
			},
		});

		const result = await readGeneratedFileContent({
			userId: USER,
			conversationId: NORMAL,
			filename: "quarterly.md",
		});
		expect(result.notFound).toBe(false);
		expect(result.contentText).toContain("Ordinary quarterly numbers");

		const library = await listKnowledgeArtifacts(USER);
		expect(JSON.stringify(library)).toContain("quarterly.md");
	});
});

describe("deleting an incognito conversation", () => {
	it("takes its artifacts and its files with it", async () => {
		const { artifactId, uploadId, sourceId, fileId } = seedIncognitoWork();

		await deleteConversationWithCleanup(USER, INCOGNITO);

		const remaining = memory.db
			.select({ id: schema.artifacts.id })
			.from(schema.artifacts)
			.all()
			.map((row) => row.id);
		expect(remaining).not.toContain(artifactId);
		expect(remaining).not.toContain(uploadId);
		expect(remaining).not.toContain(sourceId);

		const files = memory.db
			.select({ id: schema.chatGeneratedFiles.id })
			.from(schema.chatGeneratedFiles)
			.where(eq(schema.chatGeneratedFiles.id, fileId))
			.all();
		expect(files).toEqual([]);
	});
});

// ── PART A, continued: the artifact family (Feature 2, slice 0) ──────────
//
// A Document, App, Canvas or Slides row is an `artifacts` row of type
// `artifact`, and three child tables hang off it: `artifact_versions`,
// `artifact_comments` and `artifact_kv`. A version, a comment and a stored
// App value are as sensitive as the artifact itself, so each is checked here
// through the service a caller would use — with the positive half beside the
// negative one, so a test that passes is measuring the scope rather than a
// broken accessor.

const {
	createArtifact,
	createComment,
	getKv,
	getVersionBody,
	listArtifactCatalogueEntries,
	listArtifactsForConversation,
	listComments,
	listKv,
	listVersions,
	resolveArtifactCatalogueBlock,
	setKv,
	createDocumentArtifact,
	readDocumentForAlfy,
	applyDocumentPatch,
	saveDocumentBody,
	runAlfyCommentReply,
} = await import("$lib/server/services/artifacts");
const { parseDocument } = await import("$lib/shared/artifact-document/blocks");

const SECRET_DOCUMENT_TITLE = "Severance checklist";

/** An incognito chat's Document (with a comment) and App (with stored data). */
async function seedIncognitoArtifactFamily() {
	const document = await createArtifact({
		userId: USER,
		conversationId: INCOGNITO,
		kind: "document",
		title: SECRET_DOCUMENT_TITLE,
		body: `- [ ] Sign the ${SECRET_WORD} agreement`,
		author: "alfy",
		versionSummary: "Alfy wrote the first draft",
	});
	const app = await createArtifact({
		userId: USER,
		conversationId: INCOGNITO,
		kind: "app",
		title: "Severance calculator",
		body: "<!doctype html><title>Calculator</title>",
	});
	if (!document.ok || !app.ok) throw new Error("seeding refused");
	const comment = await createComment({
		userId: USER,
		artifactId: document.artifact.id,
		conversationId: INCOGNITO,
		anchor: { kind: "node", nodeId: "block-1" },
		author: "user",
		body: `Ask about the ${SECRET_WORD} clause`,
	});
	const stored = await setKv({
		userId: USER,
		artifactId: app.artifact.id,
		conversationId: INCOGNITO,
		key: "salary",
		valueJson: JSON.stringify({ note: SECRET_WORD }),
	});
	if (!comment || !stored) throw new Error("seeding refused");
	return { documentId: document.artifact.id, appId: app.artifact.id };
}

describe("an incognito conversation's artifact family, from outside it", () => {
	it("is not in another conversation's panel list", async () => {
		await seedIncognitoArtifactFamily();

		const listed = await listArtifactsForConversation({
			userId: USER,
			conversationId: NORMAL,
		});

		expect(listed).toEqual([]);
	});

	// slice-5.md's file table names this suite as gaining "the catalogue
	// read" (the "## In this chat" turn-guidance block Slice 5a built on top
	// of listArtifactsForConversation). It is a thin passthrough with no
	// query of its own, so it inherits the scope above mechanically — but
	// that is exactly the kind of claim this suite exists to prove rather
	// than assume.
	it("is not in another conversation's model-facing catalogue, and never reaches the prompt from there", async () => {
		await seedIncognitoArtifactFamily();

		const entries = await listArtifactCatalogueEntries({
			userId: USER,
			conversationId: NORMAL,
		});
		expect(entries).toEqual([]);

		const block = await resolveArtifactCatalogueBlock({
			userId: USER,
			conversationId: NORMAL,
		});
		expect(block).toBeNull();
	});

	it("has no readable versions or comments with the default scope", async () => {
		const { documentId } = await seedIncognitoArtifactFamily();
		const [version] = await listVersions({
			userId: USER,
			artifactId: documentId,
			includeIncognito: true,
		});

		await expect(
			listVersions({ userId: USER, artifactId: documentId }),
		).resolves.toEqual([]);
		await expect(
			getVersionBody({
				userId: USER,
				artifactId: documentId,
				versionId: version.id,
			}),
		).resolves.toBeNull();
		await expect(
			listVersions({
				userId: USER,
				artifactId: documentId,
				conversationId: NORMAL,
			}),
		).resolves.toEqual([]);
		await expect(
			listComments({ userId: USER, artifactId: documentId }),
		).resolves.toEqual([]);
		await expect(
			listComments({
				userId: USER,
				artifactId: documentId,
				conversationId: NORMAL,
			}),
		).resolves.toEqual([]);
	});

	it("keeps an App's stored data unreadable from outside, and readable to administration", async () => {
		const { appId } = await seedIncognitoArtifactFamily();

		await expect(
			getKv({ userId: USER, artifactId: appId, key: "salary" }),
		).resolves.toBeNull();
		await expect(
			listKv({ userId: USER, artifactId: appId, conversationId: NORMAL }),
		).resolves.toEqual([]);
		// The positive half: the same call, with the administration scope, does
		// reach the row — so the refusal above is the scope, not a broken read.
		await expect(
			getKv({
				userId: USER,
				artifactId: appId,
				key: "salary",
				includeIncognito: true,
			}),
		).resolves.toBe(JSON.stringify({ note: SECRET_WORD }));
	});

	// Slice 2's three App-specific readers: the served route and the kv route
	// both resolve through `getArtifact`/`storage.ts` before touching anything,
	// and the download path reads the same artifact row a third time. Each is
	// tested here through the exact service function its route calls, not a
	// re-derived stand-in, so a scope regression in any of the three is caught
	// in the one file that already holds this feature's incognito promise.
	it("refuses the App storage bridge's read/write from outside — the kv route's own engine", async () => {
		const { appId } = await seedIncognitoArtifactFamily();
		const { readAppValue, writeAppValue } = await import(
			"$lib/server/services/artifacts/app/storage"
		);

		await expect(
			readAppValue({ userId: USER, artifactId: appId, key: "salary" }),
		).resolves.toEqual({ ok: false, reason: "not_found" });
		await expect(
			writeAppValue({
				userId: USER,
				artifactId: appId,
				key: "salary",
				value: "leaked",
			}),
		).resolves.toEqual({ ok: false, reason: "not_found" });

		// The positive half: from inside the incognito conversation itself, the
		// same functions read the real stored value.
		await expect(
			readAppValue({
				userId: USER,
				artifactId: appId,
				key: "salary",
				conversationId: INCOGNITO,
			}),
		).resolves.toEqual({ ok: true, value: { note: SECRET_WORD } });
	});

	it("refuses the served App route and the download path's underlying read — getArtifact, kind app", async () => {
		const { getArtifact } = await import("$lib/server/services/artifacts");
		const { appId } = await seedIncognitoArtifactFamily();

		await expect(
			getArtifact({ userId: USER, artifactId: appId }),
		).resolves.toBeNull();
		await expect(
			getArtifact({ userId: USER, artifactId: appId, conversationId: NORMAL }),
		).resolves.toBeNull();

		await expect(
			getArtifact({
				userId: USER,
				artifactId: appId,
				conversationId: INCOGNITO,
			}),
		).resolves.toMatchObject({ id: appId, kind: "app" });
	});

	it("is not in the Knowledge library or workspace search", async () => {
		await seedIncognitoArtifactFamily();
		// A normal upload with the same word, so the search is seen to find
		// something rather than to find nothing at all.
		seedUpload(
			NORMAL,
			"public-notes.md",
			`A ${SECRET_WORD} note from an ordinary chat.`,
		);

		const library = await listKnowledgeArtifacts(USER);
		expect(JSON.stringify(library)).not.toContain(SECRET_DOCUMENT_TITLE);
		expect(JSON.stringify(library)).not.toContain("agreement");

		const found = await searchWorkspace(USER, { query: SECRET_WORD });
		const names = found.documents.map((document) => document.name);
		expect(names).toContain("public-notes.md");
		expect(JSON.stringify(found)).not.toContain(SECRET_DOCUMENT_TITLE);
		expect(JSON.stringify(found)).not.toContain("agreement");
	});

	// Slice 7: the merged listing (Documents tab) and the typed-query search
	// path (Workspace Search) are two separate new code paths onto the same
	// artifact-family row — each needs its own proof, not just the read
	// above (`listKnowledgeArtifacts`, which does not exercise either).
	it("is not in listLogicalDocumentsPage's merged listing, nor found by name in a typed search query", async () => {
		await seedIncognitoArtifactFamily();
		seedUpload(
			NORMAL,
			"public-notes.md",
			`A ${SECRET_WORD} note from an ordinary chat.`,
		);

		const page = await listLogicalDocumentsPage(USER, {
			includeGeneratedOutputs: true,
			limit: 50,
		});
		expect(JSON.stringify(page)).not.toContain(SECRET_DOCUMENT_TITLE);
		expect(page.documents.map((document) => document.name)).toContain(
			"public-notes.md",
		);

		// A typed query for the DOCUMENT'S OWN NAME (not the shared secret word,
		// which the earlier assertion already covers via content) must not
		// resolve it either. The response echoes the query string itself, so
		// this checks the actual results rather than the raw JSON.
		const byTitle = await searchWorkspace(USER, {
			query: SECRET_DOCUMENT_TITLE,
		});
		expect(byTitle.documents).toEqual([]);
	});
});

// Slice 1's Document reads and writes (RV-1A): Alfy's read (which writes the
// last-read snapshot), a patch, a body save and the @Alfy hook each resolve
// the artifact through the same scope, and the card preview travels only in
// the conversation's own list. Negative half from outside, positive half
// from inside, so a pass measures the scope, not a broken accessor.
describe("an incognito conversation's Document, through the Document's own reads and writes", () => {
	async function seedIncognitoDocument() {
		const document = await createDocumentArtifact({
			userId: USER,
			conversationId: INCOGNITO,
			title: SECRET_DOCUMENT_TITLE,
			markdown: `- [ ] Sign the ${SECRET_WORD} agreement`,
			author: "alfy",
			summary: "Alfy wrote the first draft",
		});
		const body = document.body ?? "";
		const [task] = parseDocument(body, { mint: false }).blocks;
		const comment = await createComment({
			userId: USER,
			artifactId: document.id,
			conversationId: INCOGNITO,
			anchor: {
				kind: "text",
				blockId: task.id,
				quote: "agreement",
				prefix: `Sign the ${SECRET_WORD} `,
				suffix: "",
			},
			author: "user",
			body: "@Alfy is this final?",
		});
		if (!comment) throw new Error("seeding refused");
		return { documentId: document.id, body, task, commentId: comment.id };
	}

	function snapshotRows(artifactId: string) {
		return memory.db
			.select({ id: schema.artifactKv.id })
			.from(schema.artifactKv)
			.where(eq(schema.artifactKv.artifactId, artifactId))
			.all();
	}

	it("answers not_found from outside and writes nothing: Alfy's read, a patch, a save, @Alfy", async () => {
		const { documentId, body, task, commentId } = await seedIncognitoDocument();

		for (const outside of [{}, { conversationId: NORMAL }]) {
			const scope = { userId: USER, artifactId: documentId, ...outside };
			await expect(readDocumentForAlfy(scope)).rejects.toMatchObject({
				reason: "not_found",
			});
			await expect(
				applyDocumentPatch({
					...scope,
					patch: {
						patchId: "p",
						label: "Alfy",
						ops: [
							{
								opId: "o",
								kind: "toggleTask",
								blockId: task.id,
								baseHash: task.hash,
								blockLabel: task.label,
								checked: true,
							},
						],
					},
				}),
			).resolves.toEqual({ ok: false, reason: "not_found" });
			await expect(
				saveDocumentBody({
					...scope,
					body: { markdown: "Overwritten.", tabs: [] },
					author: "user",
					summary: "Edited",
				}),
			).resolves.toEqual({ ok: false, reason: "not_found" });
			await expect(
				runAlfyCommentReply({
					...scope,
					commentId,
					abortSignal: new AbortController().signal,
				}),
			).resolves.toEqual({ ok: false, reason: "not_found" });
		}

		expect(snapshotRows(documentId)).toEqual([]);
		const stored = memory.db
			.select({ contentText: schema.artifacts.contentText })
			.from(schema.artifacts)
			.where(eq(schema.artifacts.id, documentId))
			.get();
		expect(stored?.contentText).toBe(body);
	});

	it("works from inside: Alfy's read writes its snapshot, a patch lands, and the card preview is in its own list only", async () => {
		const { documentId, task } = await seedIncognitoDocument();
		const inside = {
			userId: USER,
			artifactId: documentId,
			conversationId: INCOGNITO,
		};

		const read = await readDocumentForAlfy(inside);
		expect(read.blocks.map((block) => block.blockId)).toEqual([task.id]);
		expect(snapshotRows(documentId)).toHaveLength(1);
		const patched = await applyDocumentPatch({
			...inside,
			patch: {
				patchId: "p",
				label: "Alfy",
				ops: [
					{
						opId: "o",
						kind: "toggleTask",
						blockId: task.id,
						baseHash: task.hash,
						blockLabel: task.label,
						checked: true,
					},
				],
			},
		});
		expect(patched.ok && patched.result.applied).toBe(1);

		const [own] = await listArtifactsForConversation({
			userId: USER,
			conversationId: INCOGNITO,
		});
		expect(own.documentPreview?.tasks).toEqual([
			{
				blockId: task.id,
				text: `Sign the ${SECRET_WORD} agreement`,
				checked: true,
			},
		]);
		const elsewhere = await listArtifactsForConversation({
			userId: USER,
			conversationId: NORMAL,
		});
		expect(JSON.stringify(elsewhere)).not.toContain(SECRET_WORD);
	});
});

describe("inside the incognito conversation, its artifact family still works", () => {
	it("lists its artifacts and reads their versions, comments and stored data", async () => {
		const { documentId, appId } = await seedIncognitoArtifactFamily();
		const inside = { userId: USER, conversationId: INCOGNITO };

		const listed = await listArtifactsForConversation(inside);
		expect(listed.map((row) => row.id).sort()).toEqual(
			[documentId, appId].sort(),
		);
		await expect(
			listVersions({ ...inside, artifactId: documentId }),
		).resolves.toHaveLength(1);
		const threads = await listComments({ ...inside, artifactId: documentId });
		expect(threads.map((thread) => thread.body)).toEqual([
			`Ask about the ${SECRET_WORD} clause`,
		]);
		await expect(
			getKv({ ...inside, artifactId: appId, key: "salary" }),
		).resolves.toBe(JSON.stringify({ note: SECRET_WORD }));
	});

	it("still builds its own model-facing catalogue", async () => {
		const { documentId } = await seedIncognitoArtifactFamily();

		const entries = await listArtifactCatalogueEntries({
			userId: USER,
			conversationId: INCOGNITO,
		});
		expect(entries.map((entry) => entry.artifactId)).toContain(documentId);

		const block = await resolveArtifactCatalogueBlock({
			userId: USER,
			conversationId: INCOGNITO,
		});
		expect(block).toContain(SECRET_DOCUMENT_TITLE);
	});
});

describe("a normal conversation's own artifact family is unaffected", () => {
	it("reads its own versions, comments and stored data", async () => {
		await seedIncognitoArtifactFamily();
		const document = await createArtifact({
			userId: USER,
			conversationId: NORMAL,
			kind: "document",
			title: "Weekend plan",
			body: "- [ ] Naschmarkt",
		});
		const app = await createArtifact({
			userId: USER,
			conversationId: NORMAL,
			kind: "app",
			title: "Trip cost splitter",
			body: "<!doctype html>",
		});
		if (!document.ok || !app.ok) throw new Error("create refused");
		await createComment({
			userId: USER,
			artifactId: document.artifact.id,
			anchor: { kind: "point", x: 10, y: 20 },
			author: "user",
			body: "Too early?",
		});
		await setKv({
			userId: USER,
			artifactId: app.artifact.id,
			key: "expenses",
			valueJson: "[42]",
		});

		await expect(
			listVersions({ userId: USER, artifactId: document.artifact.id }),
		).resolves.toHaveLength(1);
		await expect(
			listComments({ userId: USER, artifactId: document.artifact.id }),
		).resolves.toHaveLength(1);
		await expect(
			getKv({ userId: USER, artifactId: app.artifact.id, key: "expenses" }),
		).resolves.toBe("[42]");
		const listed = await listArtifactsForConversation({
			userId: USER,
			conversationId: NORMAL,
		});
		expect(listed.map((row) => row.title).sort()).toEqual([
			"Trip cost splitter",
			"Weekend plan",
		]);
	});

	// The positive half of the exclusion proven above: the same merge and
	// search paths must still surface a normal conversation's own row, so the
	// incognito refusal is the scope working, not a broken query.
	it("is found in listLogicalDocumentsPage and by name in Workspace Search", async () => {
		await seedIncognitoArtifactFamily();
		const document = await createArtifact({
			userId: USER,
			conversationId: NORMAL,
			kind: "canvas",
			title: "Weekend plan board",
			body: "- [ ] Naschmarkt",
		});
		if (!document.ok) throw new Error("create refused");

		const page = await listLogicalDocumentsPage(USER, {
			includeGeneratedOutputs: true,
			limit: 50,
		});
		expect(page.documents.map((item) => item.id)).toContain(
			document.artifact.id,
		);

		const found = await searchWorkspace(USER, { query: "Weekend plan" });
		expect(found.documents.map((item) => item.displayArtifactId)).toContain(
			document.artifact.id,
		);
	});
});

// Slice 5a: read_artifact/edit_artifact must treat an id from a DIFFERENT
// (still normal, still the same user's) conversation exactly like an id that
// does not exist at all — the catalogue that hands out ids is scoped to ONE
// conversation (listArtifactsForConversation's `eq(artifacts.conversationId,
// …)`), so the tools that consume those ids must refuse just as tightly.
// getArtifact/readScopedArtifactRow is deliberately WIDER for its other
// caller (GET /api/artifacts/[id], which opens any of the user's own
// artifacts by id regardless of which conversation is being served) — see
// that route's own comment — so this scoping has to be the tool layer's own
// responsibility, not something to fix in getArtifact.
describe("the model tool layer (read_artifact / edit_artifact), across two normal conversations of the same user", () => {
	const OTHER_NORMAL = "conv-normal-other";
	const OTHER_SECRET_TITLE = "Severance negotiation notes";

	beforeEach(() => {
		seedConversation(OTHER_NORMAL, false);
	});

	it("read_artifact answers an id from a different normal conversation as not found, with only the calling conversation's candidates", async () => {
		const created = await createArtifact({
			userId: USER,
			conversationId: OTHER_NORMAL,
			kind: "document",
			title: OTHER_SECRET_TITLE,
			body: `- [ ] Ask about the ${SECRET_WORD} clause`,
		});
		if (!created.ok) throw new Error("seed refused");
		const ownDocument = await createArtifact({
			userId: USER,
			conversationId: NORMAL,
			kind: "document",
			title: "Weekend plan",
			body: "- [ ] Naschmarkt",
		});
		if (!ownDocument.ok) throw new Error("seed refused");

		const { runReadArtifactTool } = await import(
			"$lib/server/services/normal-chat-tools/artifact-tools/read"
		);
		const result = await runReadArtifactTool({
			userId: USER,
			conversationId: NORMAL,
			artifactId: created.artifact.id,
		});

		expect(result.modelPayload.success).toBe(false);
		const serialized = JSON.stringify(result.modelPayload);
		expect(serialized).not.toContain(SECRET_WORD);
		expect(serialized).not.toContain(OTHER_SECRET_TITLE);
		expect(serialized).not.toContain(created.artifact.id);
		if (!result.modelPayload.success) {
			expect(result.modelPayload.candidates).toEqual([
				{ artifactId: ownDocument.artifact.id, title: "Weekend plan" },
			]);
		}
	});

	it("edit_artifact refuses an id from a different normal conversation as not found, and applies nothing", async () => {
		const created = await createArtifact({
			userId: USER,
			conversationId: OTHER_NORMAL,
			kind: "document",
			title: OTHER_SECRET_TITLE,
			body: `- [ ] Ask about the ${SECRET_WORD} clause`,
		});
		if (!created.ok) throw new Error("seed refused");

		const { runEditArtifactTool } = await import(
			"$lib/server/services/normal-chat-tools/artifact-tools/edit"
		);
		const result = await runEditArtifactTool({
			userId: USER,
			conversationId: NORMAL,
			turnId: "turn-1",
			artifactId: created.artifact.id,
			patches: [
				{ op: "replace_text", blockId: "b1", baseHash: "x", text: "y" },
			],
		});

		expect(result.modelPayload.success).toBe(false);
		const serialized = JSON.stringify(result.modelPayload);
		expect(serialized).not.toContain(SECRET_WORD);
		expect(serialized).not.toContain(OTHER_SECRET_TITLE);
		// The "not found" path (buildNotFoundResult) never sets `refused`, only
		// `candidates`; the "found but this kind can't be edited yet" path
		// (unsupported_kind) sets `refused` and reveals the kind in metadata.
		// A cross-conversation id must take the FIRST path — existence and kind
		// are exactly what "must look exactly like not found" rules out.
		if (!result.modelPayload.success) {
			expect(result.modelPayload.refused).toBeUndefined();
			expect(result.modelPayload).toHaveProperty("candidates");
		}
		expect(result.metadata).not.toHaveProperty("artifactKind");
		expect(result.outputSummary).toBe("Not found");

		// Nothing was applied: the other conversation's document is untouched.
		const stillThere = await getVersionBody({
			userId: USER,
			artifactId: created.artifact.id,
			versionId: (
				await listVersions({
					userId: USER,
					artifactId: created.artifact.id,
					conversationId: OTHER_NORMAL,
				})
			)[0].id,
		});
		expect(stillThere).toBe(`- [ ] Ask about the ${SECRET_WORD} clause`);
	});
});

describe("deleting an incognito conversation, with artifacts", () => {
	it("takes its artifacts and their versions, comments and key-value rows with it", async () => {
		const { documentId, appId } = await seedIncognitoArtifactFamily();

		await deleteConversationWithCleanup(USER, INCOGNITO);

		const remaining = memory.db
			.select({ id: schema.artifacts.id })
			.from(schema.artifacts)
			.all()
			.map((row) => row.id);
		expect(remaining).not.toContain(documentId);
		expect(remaining).not.toContain(appId);
		expect(memory.db.select().from(schema.artifactVersions).all()).toEqual([]);
		expect(memory.db.select().from(schema.artifactComments).all()).toEqual([]);
		expect(memory.db.select().from(schema.artifactKv).all()).toEqual([]);

		// Slice 7: gone from the merged listing and search too, not just the
		// raw table — the two new surfaces this slice adds.
		const page = await listLogicalDocumentsPage(USER, {
			includeGeneratedOutputs: true,
			limit: 50,
		});
		expect(page.documents.map((item) => item.id)).not.toContain(documentId);
		expect(page.documents.map((item) => item.id)).not.toContain(appId);
	});
});

// Slice 7, Review Focus #2: "an artifact whose owning conversation has been
// deleted must become invisible, exactly like a generated_output row does
// today" — verified here against a NORMAL (non-incognito) conversation, since
// this is the general lifecycle rule, not an incognito-specific one.
describe("deleting a normal conversation's artifact family (Review Focus #2)", () => {
	it("removes the row from listLogicalDocumentsPage and Workspace Search once its conversation is gone", async () => {
		const document = await createArtifact({
			userId: USER,
			conversationId: NORMAL,
			kind: "document",
			title: "Doomed plan",
			body: "- [ ] Nothing",
		});
		if (!document.ok) throw new Error("create refused");

		await deleteConversationWithCleanup(USER, NORMAL);

		const page = await listLogicalDocumentsPage(USER, {
			includeGeneratedOutputs: true,
			limit: 50,
		});
		expect(page.documents.map((item) => item.id)).not.toContain(
			document.artifact.id,
		);

		const found = await searchWorkspace(USER, { query: "Doomed plan" });
		expect(found.documents.map((item) => item.displayArtifactId)).not.toContain(
			document.artifact.id,
		);
	});
});

// RV-7: the gap the two deletion tests above do not cover. Both seed an
// artifact with NO outside reference, so `deleteConversationWithCleanup`
// (cleanup/conversation-cleanup.ts) hard-deletes it via
// `hardDeleteArtifactsForUser` and it is gone from the `artifacts` table
// entirely — trivially absent from every read. But that same function's own
// branch for a `type: "artifact"` row checks
// `artifactHasReferencesOutsideConversation` first and, when true, PRESERVES
// the row instead — exactly like it already does for
// `source_document`/`normalized_document` — whenever something outside the
// conversation still names it (a fork's copied `artifact_links` row, a
// cross-conversation evidence link, ...). Preserving does not keep the link
// alive: `artifacts.conversation_id` is `ON DELETE SET NULL`, so the instant
// the conversation row itself is deleted a few lines later in the same
// function, the preserved row's `conversation_id` goes to `null`.
// `isArtifactCanonicallyOwned` (knowledge/store/core.ts) gives
// `generated_output` / `work_capsule` no `userId` fallback for exactly this
// reason ("a working artifact whose conversation is gone must never come back
// as retrieval context" — detached-artifact-delete.test.ts's own header). A
// `type: "artifact"` row falls through to the generic
// `artifact.userId === userId` branch instead, so a preserved incognito
// artifact comes back through the front door the moment its conversation is
// gone — the exact containment failure this suite exists to catch.
describe("an incognito artifact preserved by an outside reference, after its conversation is deleted", () => {
	it("must not resurface through listLogicalDocumentsPage or Workspace Search once its own conversation link is cleared", async () => {
		const { documentId } = await seedIncognitoArtifactFamily();

		// The outside reference that makes cleanup PRESERVE rather than
		// hard-delete the row: some other, still-alive conversation names it —
		// the same shape a fork's copied `artifact_links` row would leave.
		memory.db
			.insert(schema.artifactLinks)
			.values({
				id: "link-outside-reference",
				userId: USER,
				artifactId: documentId,
				conversationId: NORMAL,
				linkType: "attached_to_conversation",
				createdAt: NOW,
			})
			.run();

		await deleteConversationWithCleanup(USER, INCOGNITO);

		// Sanity check on the setup itself: the row must still exist (preserved,
		// not hard-deleted) with its conversation link cleared — otherwise this
		// test would be proving nothing.
		const stored = memory.db
			.select({
				id: schema.artifacts.id,
				conversationId: schema.artifacts.conversationId,
			})
			.from(schema.artifacts)
			.where(eq(schema.artifacts.id, documentId))
			.all();
		expect(stored).toEqual([{ id: documentId, conversationId: null }]);

		const page = await listLogicalDocumentsPage(USER, {
			includeGeneratedOutputs: true,
			limit: 50,
		});
		expect(page.documents.map((item) => item.id)).not.toContain(documentId);

		const found = await searchWorkspace(USER, {
			query: SECRET_DOCUMENT_TITLE,
		});
		expect(found.documents.map((item) => item.displayArtifactId)).not.toContain(
			documentId,
		);
	});
});

// ── PART A, continued: the Canvas (Feature 2, slice 3) ───────────────────
//
// A board is a second place a user's content can live, and it has more ways in
// than a Document: the ops route (an id-addressed change), the body route (the
// reader's own save), the comment route, the version list, the model's read and
// edit tools. Each is driven here through what a caller would use — the route
// handlers themselves, on a real in-memory database — from outside the board's
// conversation and as another user, beside the positive half from inside, so a
// pass measures the scope and not a broken route.
//
// The account archive and the erasure paths are kind-agnostic tables walks with
// their own suites (`account-data-archive`, `account-lifecycle`); the Canvas
// cases for those live there.

const { boardJson } = await import("$lib/shared/artifacts/canvas-body");
const { applyArtifactOps } = await import("$lib/server/services/artifacts");
const { runReadArtifactTool } = await import(
	"$lib/server/services/normal-chat-tools/artifact-tools/read"
);
const { runEditArtifactTool } = await import(
	"$lib/server/services/normal-chat-tools/artifact-tools/edit"
);
const artifactRoutes = {
	detail: await import("../../src/routes/api/artifacts/[id]/+server"),
	ops: await import("../../src/routes/api/artifacts/[id]/ops/+server"),
	body: await import("../../src/routes/api/artifacts/[id]/body/+server"),
	comments: await import(
		"../../src/routes/api/artifacts/[id]/comments/+server"
	),
	versions: await import(
		"../../src/routes/api/artifacts/[id]/versions/+server"
	),
	export: await import("../../src/routes/api/artifacts/[id]/export/+server"),
};

const STRANGER = "user-stranger";
const STRANGER_CONVERSATION = "conv-stranger";
const SECRET_BOARD_TITLE = "Severance floor plan";
const SECRET_BOARD_NOTE = `Move the ${SECRET_WORD} desk`;
const SECRET_NODE_ID = "note-secret";

function secretBoard(text = SECRET_BOARD_NOTE) {
	return {
		version: 1 as const,
		nodes: [
			{
				id: SECRET_NODE_ID,
				type: "sticky" as const,
				position: { x: 40, y: 40 },
				width: 190,
				data: { kind: "sticky" as const, text, tone: "yellow" as const },
			},
		],
		edges: [],
		viewport: { x: 0, y: 0, zoom: 1 },
		annotations: [],
	};
}

async function seedBoard(
	conversationId: string,
	title = SECRET_BOARD_TITLE,
): Promise<{ boardId: string; commentId: string }> {
	const created = await createArtifact({
		userId: USER,
		conversationId,
		kind: "canvas",
		title,
		body: boardJson(secretBoard()),
		author: "user",
		versionSummary: "Created",
	});
	if (!created.ok) throw new Error(`seeding refused: ${created.reason}`);
	const comment = await createComment({
		userId: USER,
		artifactId: created.artifact.id,
		conversationId,
		anchor: { kind: "node", nodeId: SECRET_NODE_ID },
		author: "user",
		body: `Ask about the ${SECRET_WORD} desk`,
	});
	if (!comment) throw new Error("seeding refused: comment");
	return { boardId: created.artifact.id, commentId: comment.id };
}

/** What a board holds right now: its versions, its comments, its stored body. */
function boardRows(artifactId: string) {
	return {
		versions: memory.db
			.select({ id: schema.artifactVersions.id })
			.from(schema.artifactVersions)
			.where(eq(schema.artifactVersions.artifactId, artifactId))
			.all().length,
		comments: memory.db
			.select({ id: schema.artifactComments.id })
			.from(schema.artifactComments)
			.where(eq(schema.artifactComments.artifactId, artifactId))
			.all().length,
		body: memory.db
			.select({ contentText: schema.artifacts.contentText })
			.from(schema.artifacts)
			.where(eq(schema.artifacts.id, artifactId))
			.get()?.contentText,
	};
}

type Caller = { userId: string; conversationId?: string | null };

/** One artifact route, driven the way SvelteKit drives it. */
type RouteCall = {
	name: string;
	run: (
		caller: Caller,
		artifactId: string,
		baseVersionId: string,
	) => Promise<Response>;
};

function routeEvent(
	caller: Caller,
	artifactId: string,
	path: string,
	body?: unknown,
) {
	const query = caller.conversationId
		? `?conversationId=${encodeURIComponent(caller.conversationId)}`
		: "";
	return {
		params: { id: artifactId },
		url: new URL(`http://localhost/api/artifacts/${artifactId}${path}${query}`),
		locals: { user: { id: caller.userId, role: "user" } },
		request: {
			json: async () => {
				if (body === undefined) throw new SyntaxError("no body");
				return body;
			},
			headers: new Headers(),
		},
	} as never;
}

const CANVAS_ROUTE_CALLS: RouteCall[] = [
	{
		name: "GET the board",
		run: (caller, id) => artifactRoutes.detail.GET(routeEvent(caller, id, "")),
	},
	{
		name: "GET its versions",
		run: (caller, id) =>
			artifactRoutes.versions.GET(routeEvent(caller, id, "/versions")),
	},
	{
		name: "POST ops (an id-addressed change)",
		run: (caller, id, baseVersionId) =>
			artifactRoutes.ops.POST(
				routeEvent(caller, id, "/ops", {
					baseVersionId,
					diff: {
						id: "diff-1",
						summary: "Moved",
						ops: [{ op: "move", id: SECRET_NODE_ID, to: { x: 400, y: 200 } }],
					},
				}),
			),
	},
	{
		name: "PATCH the body (the reader's own save)",
		run: (caller, id) =>
			artifactRoutes.body.PATCH(
				routeEvent(caller, id, "/body", {
					body: boardJson(secretBoard("Overwritten.")),
					expectVersion: 1,
				}),
			),
	},
	{
		name: "POST a comment",
		run: (caller, id) =>
			artifactRoutes.comments.POST(
				routeEvent(caller, id, "/comments", {
					anchor: { kind: "node", nodeId: SECRET_NODE_ID },
					body: "Injected.",
				}),
			),
	},
	{
		name: "POST an export",
		run: (caller, id) =>
			artifactRoutes.export.POST(
				routeEvent(caller, id, "/export", { format: "markdown" }),
			),
	},
	{
		name: "DELETE the board",
		run: (caller, id) =>
			artifactRoutes.detail.DELETE(routeEvent(caller, id, "")),
	},
];

/** Everything a route says about a board that is not there — the same bytes whether it is missing, someone else's, or out of reach. */
async function answerOf(response: Response) {
	return { status: response.status, text: await response.text() };
}

describe("an incognito conversation's Canvas, from outside it", () => {
	beforeEach(() => {
		seedUser(STRANGER);
		memory.db
			.insert(schema.conversations)
			.values({
				id: STRANGER_CONVERSATION,
				userId: STRANGER,
				title: STRANGER_CONVERSATION,
				memoryIncognito: false,
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
	});

	it("is in no other conversation's panel list, catalogue, library, search or evidence", async () => {
		await seedBoard(INCOGNITO);
		// A normal upload with the same word, so each search is seen to find
		// something rather than to find nothing at all.
		seedUpload(
			NORMAL,
			"public-notes.md",
			`A ${SECRET_WORD} note from an ordinary chat.`,
		);

		await expect(
			listArtifactsForConversation({ userId: USER, conversationId: NORMAL }),
		).resolves.toEqual([]);
		await expect(
			listArtifactCatalogueEntries({ userId: USER, conversationId: NORMAL }),
		).resolves.toEqual([]);
		await expect(
			resolveArtifactCatalogueBlock({ userId: USER, conversationId: NORMAL }),
		).resolves.toBeNull();

		const library = await listKnowledgeArtifacts(USER);
		expect(JSON.stringify(library)).not.toContain(SECRET_BOARD_TITLE);
		expect(JSON.stringify(library)).not.toContain(SECRET_BOARD_NOTE);

		const merged = await listLogicalDocumentsPage(USER, {
			includeGeneratedOutputs: true,
			limit: 50,
		});
		expect(JSON.stringify(merged)).not.toContain(SECRET_BOARD_TITLE);
		expect(merged.documents.map((document) => document.name)).toContain(
			"public-notes.md",
		);

		const byWord = await searchWorkspace(USER, { query: SECRET_WORD });
		expect(byWord.documents.map((document) => document.name)).toContain(
			"public-notes.md",
		);
		expect(JSON.stringify(byWord)).not.toContain(SECRET_BOARD_TITLE);
		const byTitle = await searchWorkspace(USER, { query: SECRET_BOARD_TITLE });
		expect(byTitle.documents).toEqual([]);

		const picked = await findRelevantKnowledgeArtifacts({
			userId: USER,
			query: `${SECRET_WORD} desk ${SECRET_BOARD_TITLE}`,
			excludeConversationId: NORMAL,
			currentConversationId: NORMAL,
			limit: 10,
		});
		expect(JSON.stringify(picked)).not.toContain(SECRET_BOARD_TITLE);
		expect(JSON.stringify(picked)).not.toContain(SECRET_BOARD_NOTE);
	});

	it("answers every route, named by no conversation or by another, as one plain not-found, and writes nothing", async () => {
		const { boardId } = await seedBoard(INCOGNITO);
		const before = boardRows(boardId);
		const [version] = await listVersions({
			userId: USER,
			artifactId: boardId,
			conversationId: INCOGNITO,
		});

		for (const outside of [
			{ userId: USER },
			{ userId: USER, conversationId: NORMAL },
		]) {
			for (const call of CANVAS_ROUTE_CALLS) {
				const answer = await answerOf(
					await call.run(outside, boardId, version.id),
				);
				const missing = await answerOf(
					await call.run(outside, "no-such-board", version.id),
				);
				expect(answer, `${call.name} as ${JSON.stringify(outside)}`).toEqual(
					missing,
				);
				expect(answer.status, call.name).toBe(404);
				expect(answer.text, call.name).not.toContain(SECRET_WORD);
				expect(answer.text, call.name).not.toContain(SECRET_BOARD_TITLE);
			}
		}

		expect(boardRows(boardId)).toEqual(before);
	});

	it("answers another user's board through every route as the same not-found a missing id gets — even when that user names the board's own conversation", async () => {
		const { boardId } = await seedBoard(INCOGNITO);
		const { boardId: normalBoardId } = await seedBoard(NORMAL, "Weekend board");
		const beforeIncognito = boardRows(boardId);
		const beforeNormal = boardRows(normalBoardId);
		const [version] = await listVersions({
			userId: USER,
			artifactId: normalBoardId,
			conversationId: NORMAL,
		});

		for (const stranger of [
			{ userId: STRANGER },
			{ userId: STRANGER, conversationId: STRANGER_CONVERSATION },
			// Naming the victim's conversation reaches nothing: ownership starts from
			// the caller's own conversations.
			{ userId: STRANGER, conversationId: INCOGNITO },
			{ userId: STRANGER, conversationId: NORMAL },
		]) {
			for (const id of [boardId, normalBoardId]) {
				for (const call of CANVAS_ROUTE_CALLS) {
					const answer = await answerOf(
						await call.run(stranger, id, version.id),
					);
					const missing = await answerOf(
						await call.run(stranger, "no-such-board", version.id),
					);
					expect(
						answer,
						`${call.name} as ${JSON.stringify(stranger)} on ${id}`,
					).toEqual(missing);
					expect(answer.status).toBe(404);
				}
			}
		}

		expect(boardRows(boardId)).toEqual(beforeIncognito);
		expect(boardRows(normalBoardId)).toEqual(beforeNormal);
	});

	it("is not found by the model's read and edit tools from another conversation, and nothing is applied", async () => {
		const { boardId } = await seedBoard(INCOGNITO);
		const before = boardRows(boardId);

		const read = await runReadArtifactTool({
			userId: USER,
			conversationId: NORMAL,
			artifactId: boardId,
			abortSignal: new AbortController().signal,
		});
		expect(read.modelPayload.success).toBe(false);
		expect(JSON.stringify(read.modelPayload)).not.toContain(SECRET_WORD);
		expect(JSON.stringify(read.modelPayload)).not.toContain(SECRET_BOARD_TITLE);
		expect(JSON.stringify(read.modelPayload)).not.toContain(boardId);

		const edit = await runEditArtifactTool({
			userId: USER,
			conversationId: NORMAL,
			turnId: "turn-1",
			artifactId: boardId,
			ops: [{ op: "move", id: SECRET_NODE_ID, to: { x: 1, y: 1 } }],
			abortSignal: new AbortController().signal,
		});
		expect(edit.modelPayload.success).toBe(false);
		expect(JSON.stringify(edit.modelPayload)).not.toContain(SECRET_WORD);
		// It looks exactly like an id that does not exist: no kind, no refusal.
		expect(edit.metadata).not.toHaveProperty("artifactKind");
		expect(edit.outputSummary).toBe("Not found");

		expect(boardRows(boardId)).toEqual(before);
	});
});

describe("inside the incognito conversation, its Canvas still works", () => {
	it("opens, changes, saves, is commented on and read by Alfy when the request names the conversation", async () => {
		const { boardId } = await seedBoard(INCOGNITO);
		const inside = { userId: USER, conversationId: INCOGNITO };
		const [first] = await listVersions({
			userId: USER,
			artifactId: boardId,
			conversationId: INCOGNITO,
		});

		const detail = await artifactRoutes.detail.GET(
			routeEvent(inside, boardId, ""),
		);
		expect(detail.status).toBe(200);
		const opened = (await detail.json()) as {
			artifact: { body: string };
			comments: unknown[];
		};
		expect(opened.artifact.body).toContain(SECRET_WORD);
		expect(opened.comments).toHaveLength(1);

		const ops = await artifactRoutes.ops.POST(
			routeEvent(inside, boardId, "/ops", {
				baseVersionId: first.id,
				diff: {
					id: "diff-1",
					summary: "Moved",
					ops: [{ op: "move", id: SECRET_NODE_ID, to: { x: 400, y: 200 } }],
				},
			}),
		);
		expect(ops.status).toBe(200);
		expect(await ops.json()).toMatchObject({
			ok: true,
			version: 2,
			applied: 1,
		});

		const save = await artifactRoutes.body.PATCH(
			routeEvent(inside, boardId, "/body", {
				body: boardJson(secretBoard(`Kept the ${SECRET_WORD} desk`)),
				expectVersion: 2,
			}),
		);
		expect(save.status).toBe(200);

		const comment = await artifactRoutes.comments.POST(
			routeEvent(inside, boardId, "/comments", {
				anchor: { kind: "node", nodeId: SECRET_NODE_ID },
				body: "One more thing.",
			}),
		);
		expect(comment.status).toBe(200);

		const versions = await artifactRoutes.versions.GET(
			routeEvent(inside, boardId, "/versions"),
		);
		expect(versions.status).toBe(200);

		const read = await runReadArtifactTool({
			userId: USER,
			conversationId: INCOGNITO,
			artifactId: boardId,
			abortSignal: new AbortController().signal,
		});
		expect(read.modelPayload.success).toBe(true);
		const edited = await runEditArtifactTool({
			userId: USER,
			conversationId: INCOGNITO,
			turnId: "turn-2",
			artifactId: boardId,
			ops: [{ op: "move", id: SECRET_NODE_ID, to: { x: 10, y: 10 } }],
			abortSignal: new AbortController().signal,
		});
		expect(edited.modelPayload.success).toBe(true);

		const rows = boardRows(boardId);
		expect(rows.comments).toBe(2);
		expect(rows.versions).toBeGreaterThanOrEqual(3);
	});

	it("records no behavior event when it is opened in the panel", async () => {
		const { boardId } = await seedBoard(INCOGNITO);
		const { POST: recordBehavior } = await import(
			"../../src/routes/api/knowledge/documents/behavior/+server"
		);
		const behaviorEvent = (artifactId: string) =>
			({
				locals: { user: { id: USER, role: "user" } },
				request: {
					json: async () => ({ action: "workspace_opened", artifactId }),
				},
			}) as never;

		// The panel of a normal chat opens a board it made and this is recorded...
		const { boardId: normalBoardId } = await seedBoard(NORMAL, "Weekend board");
		const recorded = await recordBehavior(behaviorEvent(normalBoardId));
		expect(recorded.status).toBe(200);
		expect(memory.db.select().from(schema.memoryEvents).all()).toHaveLength(1);

		// ...and the incognito chat's is not: the call answers as it always does,
		// and the log drops the event, so nothing is learned from the visit.
		const answer = await recordBehavior(behaviorEvent(boardId));
		expect(answer.status).toBe(200);
		expect(memory.db.select().from(schema.memoryEvents).all()).toHaveLength(1);
	});

	it("goes, with its versions and comments, when its conversation is deleted", async () => {
		const { boardId } = await seedBoard(INCOGNITO);

		await deleteConversationWithCleanup(USER, INCOGNITO);

		expect(boardRows(boardId)).toEqual({
			versions: 0,
			comments: 0,
			body: undefined,
		});
		const page = await listLogicalDocumentsPage(USER, {
			includeGeneratedOutputs: true,
			limit: 50,
		});
		expect(page.documents.map((item) => item.id)).not.toContain(boardId);
	});
});

// The promise covers what the server says about a board, not only who can read
// it: a board's text must not turn up in a log line or in any table that is not
// the family's own or the conversation's (telemetry, usage, events, embeddings
// of the wrong subject). Driven through a whole life of a board, with the
// console spied and every other table read back.
describe("a Canvas's content, in logs and in telemetry", () => {
	const OWN_TABLES = new Set([
		"artifacts",
		"artifact_versions",
		"artifact_comments",
		"artifact_kv",
	]);

	it("never reaches a console line or a table outside the family's own, across create, save, ops, comment, read, edit and delete", async () => {
		const spies = (["log", "info", "warn", "error", "debug"] as const).map(
			(method) => vi.spyOn(console, method).mockImplementation(() => {}),
		);
		try {
			const { boardId } = await seedBoard(NORMAL);
			const [first] = await listVersions({
				userId: USER,
				artifactId: boardId,
				conversationId: NORMAL,
			});
			await applyArtifactOps({
				userId: USER,
				artifactId: boardId,
				conversationId: NORMAL,
				payload: {
					baseVersionId: first.id,
					diff: {
						id: "diff-1",
						summary: `Added the ${SECRET_WORD} note`,
						ops: [
							{
								op: "add_node",
								id: "note-two",
								type: "sticky",
								position: { x: 300, y: 40 },
								data: {
									kind: "sticky",
									text: `Also ${SECRET_WORD}`,
									tone: "mint",
								},
							},
						],
					},
				},
			});
			await runReadArtifactTool({
				userId: USER,
				conversationId: NORMAL,
				artifactId: boardId,
				abortSignal: new AbortController().signal,
			});
			await runEditArtifactTool({
				userId: USER,
				conversationId: NORMAL,
				turnId: "turn-1",
				artifactId: boardId,
				ops: [{ op: "move", id: SECRET_NODE_ID, to: { x: 5, y: 5 } }],
				abortSignal: new AbortController().signal,
			});
			await deleteConversationWithCleanup(USER, NORMAL);

			const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
			expect(logged).not.toContain(SECRET_WORD);
			expect(logged).not.toContain(SECRET_BOARD_TITLE);
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
	});

	it("has no console line in any module that is the Canvas's own", () => {
		// A log line is the cheapest way for a board's text to leave the database,
		// and a runtime spy only sees the paths a test happens to drive. The
		// Canvas's own server and shared modules (every non-test file named for the
		// board) write no log at all; a new one that needs to says so here, with
		// what it logs.
		const canvasModules: string[] = [];
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (
					entry.name.endsWith(".ts") &&
					!entry.name.includes(".test") &&
					/canvas|board/i.test(entry.name)
				) {
					canvasModules.push(full);
				}
			}
		};
		walk(join(process.cwd(), "src", "lib", "server"));
		walk(join(process.cwd(), "src", "lib", "shared"));
		// The check sees the modules it is meant to (a rename cannot empty it).
		expect(
			canvasModules.map((file) => relativePath(process.cwd(), file)),
		).toEqual(
			expect.arrayContaining([
				"src/lib/server/services/artifacts/canvas-ops.ts",
				"src/lib/server/services/artifacts/serialize/canvas.ts",
				"src/lib/shared/artifacts/canvas-body.ts",
				"src/lib/shared/artifacts/board-ops.ts",
			]),
		);

		const logging = canvasModules.filter((file) =>
			/\bconsole\s*\.\s*(log|info|warn|error|debug|trace)\b/.test(
				readFileSync(file, "utf8"),
			),
		);
		expect(logging.map((file) => relativePath(process.cwd(), file))).toEqual(
			[],
		);
	});

	it("leaves the board's text in no other table while it lives", async () => {
		const { boardId } = await seedBoard(NORMAL);
		const [first] = await listVersions({
			userId: USER,
			artifactId: boardId,
			conversationId: NORMAL,
		});
		await applyArtifactOps({
			userId: USER,
			artifactId: boardId,
			conversationId: NORMAL,
			payload: {
				baseVersionId: first.id,
				diff: {
					id: "diff-1",
					summary: "Moved",
					ops: [{ op: "move", id: SECRET_NODE_ID, to: { x: 5, y: 5 } }],
				},
			},
		});

		const tables = memory.sqlite
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'",
			)
			.all() as { name: string }[];
		const holdingIt: string[] = [];
		for (const { name } of tables) {
			const rows = memory.sqlite.prepare(`SELECT * FROM "${name}"`).all();
			if (JSON.stringify(rows).includes(SECRET_WORD)) holdingIt.push(name);
		}
		// Exactly the family's own tables: the board, its versions, its comment.
		// (Were the read blind, this would be empty; were a table beside them
		// holding the text, it would name it.)
		expect(holdingIt.sort()).toEqual(
			["artifact_comments", "artifact_versions", "artifacts"].sort(),
		);
		expect(holdingIt.every((name) => OWN_TABLES.has(name))).toBe(true);
	});
});

// ── PART B: the guard ──────────────────────────────────────────
//
// `getArtifactOwnershipScope` is the boundary. A query that reads `artifacts`
// or `chat_generated_files` for a USER without going through it — or without
// pinning itself to one conversation, which is the same boundary spelled
// directly — is a new way out of an incognito chat, and the point of this
// guard is that it fails on the day it is written rather than in a live
// check months later.

const SERVER_ROOT = join(process.cwd(), "src", "lib", "server");

/** Any of these in a file means it has thought about the boundary. */
const SCOPE_MARKERS = [
	"getArtifactOwnershipScope",
	"buildArtifactCanonicalOwnershipCondition",
	"isArtifactCanonicallyOwned",
	"isArtifactDeletableByUser",
	"ownershipScope",
	"memoryIncognito",
	// A query pinned to one conversation cannot cross the boundary at all.
	"artifacts.conversationId",
	"chatGeneratedFiles.conversationId",
	// The artifact family's one scoped read (services/artifacts/record.ts): it
	// takes getArtifactOwnershipScope and the canonical ownership condition, and
	// every reader of versions, comments and key-value rows resolves its artifact
	// through it before touching a child row.
	"readScopedArtifactRow",
];

/**
 * Files that read these tables and go through none of the above, each with
 * the reason it is allowed to. Every entry is either an id-scoped read whose
 * id came from a query that IS scoped, or an administrative sweep that must
 * see every row the user owns — a deletion, an export, an erasure. Adding a
 * line here is a decision about the incognito promise; make it deliberately.
 *
 * A line here is only allowed to be a line the guard can REACH, which the
 * second test below enforces: the file must read one of the guarded tables,
 * select by user, and carry no scope marker. An entry for a file that is
 * already scoped, or that never reads these tables in the first place, is an
 * exemption nobody consults — until somebody writes the unscoped query that
 * makes it live, and then it silences that query without a decision having been
 * made. Two files whose reasoning is real but whose exemption is not: the
 * orphan sweep (`knowledge/store/orphan-artifacts.ts`, about rows no
 * conversation holds at all) and `evidence-family.ts` (family-key resolution
 * over ids already chosen). Both take the scope themselves, so the marker check
 * passes them before this list is ever read.
 */
const ALLOWED_WITHOUT_SCOPE: Record<string, string> = {
	"services/account-data-archive/index.ts":
		"the user's own data export — incognito conversations are saved to the account and are exported with it",
	"services/memory-maintenance.ts":
		"maintenance over the user's own rows (chunk GC, retrieval-class repair); nothing it reads reaches a prompt",
	"services/semantic-embedding-refresh.ts":
		"embedding backfill; what the embeddings are then USED for is scoped at selection time",
	"services/task-state/artifacts.ts":
		"chunk and full-content reads BY ARTIFACT ID; the ids come from the scoped candidate pool, which is why this module needs no incognito term of its own",
	"services/extraction/job-ledger.ts": "legacy job hydration, by artifact id",
	"services/extraction/read-model.ts": "legacy DTO synthesis, by artifact id",
	"services/extraction/worker-runner.ts":
		"resolves the source of one extraction job, by id",
	"services/file-production/image-loader.ts":
		"loads one image artifact by id for the renderer",
	"services/knowledge/store/attachments.ts":
		"`findExistingArtifactByName` asks only whether a NAME is taken, and returns a boolean; the rest is conversation-scoped",
};

function listSourceFiles(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			found.push(...listSourceFiles(full));
		} else if (entry.name.endsWith(".ts") && !entry.name.includes(".test")) {
			found.push(relativePath(SERVER_ROOT, full));
		}
	}
	return found;
}

function readsGuardedTables(source: string): boolean {
	return (
		source.includes(".from(artifacts)") ||
		source.includes(".from(artifactChunks)") ||
		source.includes(".from(chatGeneratedFiles)") ||
		source.includes(".from(projectKnowledgeLinks)") ||
		// The artifact family's child tables (Feature 2): a version, a comment
		// and a stored App value are as private as the artifact they hang off.
		source.includes(".from(artifactVersions)") ||
		source.includes(".from(artifactComments)") ||
		source.includes(".from(artifactKv)")
	);
}

/**
 * Only a query that selects by USER can cross a conversation boundary; one
 * that does not is already narrower than this rule. The canonical-condition
 * helpers count as selecting by user — they ARE the boundary, and taking one is
 * the thing this guard asks for — so a file that scopes artifacts that way is
 * checked here rather than skipped for spelling its filter as a helper call
 * (`buildArtifactCanonicalOwnershipCondition({ userId, ownershipScope })`)
 * instead of a literal column comparison.
 */
function selectsByUser(source: string): boolean {
	return (
		source.includes("artifacts.userId") ||
		source.includes("artifactChunks.userId") ||
		source.includes("chatGeneratedFiles.userId") ||
		source.includes("projectKnowledgeLinks.userId") ||
		source.includes("buildArtifactCanonicalOwnershipCondition") ||
		source.includes("isArtifactCanonicallyOwned") ||
		source.includes("buildArtifactVisibilityCondition") ||
		source.includes("artifactVersions.userId") ||
		source.includes("artifactComments.userId") ||
		// A version or a comment DOES have a user column, but a reader can still
		// select it by `artifactId` alone (the shape a "resolve the id, then read
		// the child table" bug takes — no `.userId` in sight to trip the checks
		// above). Counting `artifactId` as "selects by user" here too is what
		// forces that reader to carry a scope marker instead of slipping out
		// through `if (!selectsByUser(source)) continue;` unseen. Same reasoning
		// as `artifactKv.artifactId` below; do not delete either because the
		// column name "looks wrong" for a by-user check.
		source.includes("artifactVersions.artifactId") ||
		source.includes("artifactComments.artifactId") ||
		// `artifact_kv` has NO user column: a key-value row is keyed to its
		// artifact alone, so every read of it is a read by artifact id — and an
		// artifact id can come from anywhere. Counting `artifactKv.artifactId` as
		// "selects by user" is what makes the guard ask every reader of the
		// table for its scope marker, which is the whole point: a key-value
		// reader that did not resolve its artifact through the scoped read first
		// is exactly the query this guard exists to catch. Do not delete this
		// line because the column name "looks wrong" here.
		source.includes("artifactKv.artifactId")
	);
}

function carriesScopeMarker(source: string): boolean {
	return SCOPE_MARKERS.some((marker) => source.includes(marker));
}

describe("every user-scoped artifact query goes through the ownership scope", () => {
	it("has no unscoped reader of artifacts or chat_generated_files", () => {
		const offenders: string[] = [];
		for (const relative of listSourceFiles(SERVER_ROOT).sort()) {
			const source = readFileSync(join(SERVER_ROOT, relative), "utf8");
			if (!readsGuardedTables(source)) continue;
			if (!selectsByUser(source)) continue;
			if (carriesScopeMarker(source)) continue;
			const key = relative.replace(/\\/g, "/");
			if (key in ALLOWED_WITHOUT_SCOPE) continue;
			offenders.push(key);
		}

		expect(
			offenders,
			[
				"These files read artifacts / artifact_chunks / chat_generated_files /",
				"project_knowledge_links by user without going through",
				"getArtifactOwnershipScope (or pinning the query to one conversation).",
				"Either scope the query, or add the file to ALLOWED_WITHOUT_SCOPE with",
				"the reason it is safe:",
				offenders.join("\n  "),
			].join("\n"),
		).toEqual([]);
	});

	it("keeps the allow-list honest", () => {
		// An entry that no longer matches a real file is a stale exemption, and
		// a stale exemption is how the next unscoped query gets in unnoticed.
		// The same goes for an entry the guard can never consult: it is a
		// decision that was never made, waiting to silence the query that makes
		// it live.
		const stale: string[] = [];
		for (const relative of Object.keys(ALLOWED_WITHOUT_SCOPE)) {
			let text: string | null = null;
			try {
				text = readFileSync(join(SERVER_ROOT, relative), "utf8");
			} catch {
				text = null;
			}
			if (text === null) {
				stale.push(`${relative} — exempt, but the file does not exist`);
				continue;
			}
			if (!readsGuardedTables(text)) {
				stale.push(
					`${relative} — exempt, but reads none of the guarded tables, so the entry is never consulted`,
				);
				continue;
			}
			if (!selectsByUser(text)) {
				stale.push(
					`${relative} — exempt, but does not select by user, so the entry is never consulted`,
				);
				continue;
			}
			if (carriesScopeMarker(text)) {
				stale.push(
					`${relative} — exempt, but already carries a scope marker, so the marker check passes it first and the entry is dead weight`,
				);
			}
		}

		expect(
			stale,
			[
				"Every ALLOWED_WITHOUT_SCOPE entry must be one this guard can reach: a",
				"file that reads a guarded table, selects by user, and carries no scope",
				"marker. Scope the file, or delete the entry so the next unscoped query",
				"has to be decided rather than inherited:",
				stale.join("\n  "),
			].join("\n"),
		).toEqual([]);
	});

	// A reader that never mentions `.userId` — say, a raw
	// `db.select().from(artifactVersions).where(eq(artifactVersions.artifactId, id))`
	// dropped into a new file with no scope marker — used to pass this guard
	// silently: `selectsByUser` only recognised artifact_versions and
	// artifact_comments through their `userId` column, so a reader that selects
	// by `artifactId` alone (exactly the shape a "resolve the id, then read the
	// child table" bug would take) never even reached the offender check. This
	// synthetic snippet is the guard's own self-test: it must be seen as a
	// by-user-equivalent read, the same way artifactKv.artifactId already is
	// (kv has no user column at all, so every kv read is by artifact id).
	it("flags a synthetic reader that selects artifact_versions or artifact_comments by artifact id alone", () => {
		const offendingReads = [
			"db.select().from(artifactVersions).where(eq(artifactVersions.artifactId, id))",
			"db.select().from(artifactComments).where(eq(artifactComments.artifactId, id))",
		];
		for (const source of offendingReads) {
			expect(readsGuardedTables(source)).toBe(true);
			expect(carriesScopeMarker(source)).toBe(false);
			expect(selectsByUser(source)).toBe(true);
		}
	});

	// The artifact family (Feature 2) added three tables. A guard that cannot
	// SEE a reader passes it silently — a renamed table variable, or a reader
	// that selects by a column the helpers do not name, would drop out of the
	// check without a sound. So the family's own readers are named here and must
	// be reachable: each reads a guarded table, selects by user (or, for the
	// key-value table, by artifact), and carries its scope marker.
	it("reaches every reader of the artifact family's tables", () => {
		const familyReaders = [
			"services/artifacts/record.ts",
			"services/artifacts/read-model.ts",
			"services/artifacts/versions.ts",
			"services/artifacts/comments.ts",
			"services/artifacts/kv.ts",
		];
		const unreached: string[] = [];
		for (const relative of familyReaders) {
			const source = readFileSync(join(SERVER_ROOT, relative), "utf8");
			if (
				!readsGuardedTables(source) ||
				!selectsByUser(source) ||
				!carriesScopeMarker(source)
			) {
				unreached.push(relative);
			}
		}
		expect(unreached).toEqual([]);

		// Each new table is named by the helpers, so a file reading only that
		// table is checked too — not just files that also happen to read
		// `artifacts`.
		for (const table of [
			"artifactVersions",
			"artifactComments",
			"artifactKv",
		]) {
			expect(readsGuardedTables(`db.select().from(${table})`)).toBe(true);
		}
	});

	// Ruling 31 and the slice-0 gate: the family went green WITHOUT a single new
	// exemption. The list may shrink — the test above makes a stale entry fail —
	// but it may not grow or swap an entry for another. Adding a line here is a
	// decision about the incognito promise, and it has to be made in this list
	// as well as in the one above, in plain sight.
	it("has not grown its exemption list", () => {
		const exemptionsAsOf20260925 = [
			"services/account-data-archive/index.ts",
			"services/memory-maintenance.ts",
			"services/semantic-embedding-refresh.ts",
			"services/task-state/artifacts.ts",
			"services/extraction/job-ledger.ts",
			"services/extraction/read-model.ts",
			"services/extraction/worker-runner.ts",
			"services/file-production/image-loader.ts",
			"services/knowledge/store/attachments.ts",
		];
		expect(
			Object.keys(ALLOWED_WITHOUT_SCOPE).filter(
				(entry) => !exemptionsAsOf20260925.includes(entry),
			),
		).toEqual([]);
	});
});

// ─── First-open tours (Feature 2, Slice 6, ruling 33) ───────────────────────
//
// A tour's seen state is a write, and an incognito chat promises none. The
// panel never asks for a tour inside an incognito chat (that half is the
// panel's trigger, pinned in its own suite); this half is what the SERVER
// guarantees however it is asked. The state names a user, a kind and a content
// key and nothing else — no conversation, no artifact — so there is no row an
// incognito chat's open could leave, and no path from a row back to a chat. And
// no tour code path reads an artifact table, so the tours cannot become a way
// to enumerate what a chat holds.
//
// There is NO `ALLOWED_WITHOUT_SCOPE` entry for any of it, and adding one
// would be a bug: the guard above fires only on files that read the artifact
// tables, a tour file reads none, and an entry the guard can never consult is
// dead weight that "keeps the allow-list honest" fails — and that teaches the
// next reader the guard is decorative. The assertions below are the coverage;
// nothing is exempted.

const tourRoutes = {
	read: await import("../../src/routes/api/artifact-tours/[type]/+server"),
	seen: await import("../../src/routes/api/artifact-tours/[type]/seen/+server"),
};

/** Every module a tour is served, recorded, seeded or fetched through. */
const TOUR_CODE_PATHS = [
	"lib/server/services/artifact-tours.ts",
	"lib/server/artifact-tour-defaults.ts",
	"lib/shared/artifacts/tours.ts",
	"lib/client/api/artifact-tours.ts",
	"routes/api/artifact-tours/[type]/+server.ts",
	"routes/api/artifact-tours/[type]/seen/+server.ts",
	"routes/api/admin/campaigns/seed-artifact-tours/+server.ts",
];

/** The only tables a tour code path may name: the campaigns it overrides from, and its own state. */
const TOUR_TABLES = new Set(["announcementCampaigns", "artifactTourStates"]);

/** The names a module imports from the schema, `type` and `as` stripped. */
function schemaImportNames(source: string): string[] {
	const names: string[] = [];
	for (const match of source.matchAll(
		/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']\$lib\/server\/db\/schema["']/g,
	)) {
		for (const part of (match[1] ?? "").split(",")) {
			const name = part
				.trim()
				.replace(/^type\s+/, "")
				.split(/\s+as\s+/)[0]
				?.trim();
			if (name) names.push(name);
		}
	}
	return names;
}

/** Services whose job is artifacts, chats or files: a tour has no business in any. */
const ARTIFACT_SIDE_SPECIFIER =
	/\/(?:services\/(?:artifacts|knowledge|chat-files|file-production|working-set|document-resolution|task-state|workspace-search|conversation-detail|conversations|messages)|client\/api\/(?:artifacts|conversations|knowledge))(?:\/|["']|$)/;

function importedSpecifiers(source: string): string[] {
	return [
		...source.matchAll(/from\s+["']([^"']+)["']/g),
		...source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g),
	].map((match) => match[1] ?? "");
}

describe("a first-open tour's seen state, beside an incognito conversation", () => {
	function tourGetEvent(type: string, search = "") {
		return {
			params: { type },
			url: new URL(`http://localhost/api/artifact-tours/${type}${search}`),
			locals: { user: { id: USER, role: "user" } },
		} as never;
	}

	function tourSeenEvent(type: string, body: unknown, search = "") {
		return {
			params: { type },
			url: new URL(`http://localhost/api/artifact-tours/${type}/seen${search}`),
			locals: { user: { id: USER, role: "user" } },
			request: { json: async () => body },
		} as never;
	}

	it("has a row of a user, a kind, a content key, a status and slide counters, and nowhere to put a conversation or an artifact", () => {
		const columns = Object.values(getTableColumns(schema.artifactTourStates))
			.map((column) => column.name)
			.sort();

		expect(columns).toEqual([
			"artifact_type",
			"completed_at",
			"content_key",
			"created_at",
			"dismissed_at",
			"id",
			"last_slide",
			"slide_count",
			"status",
			"updated_at",
			"user_id",
		]);
		// The only references the row holds are its own id and its user.
		expect(
			columns.filter((name) => name === "id" || name.endsWith("_id")),
		).toEqual(["id", "user_id"]);
	});

	it("is written by an ordinary reader while an incognito chat holds work, and the row names neither the chat nor anything in it", async () => {
		const secret = seedIncognitoWork();
		const needles = [
			INCOGNITO,
			NORMAL,
			secret.artifactId,
			secret.fileId,
			secret.uploadId,
			secret.sourceId,
			SECRET_FILENAME,
			SECRET_WORD,
		];
		const familyBefore = {
			artifacts: memory.db.select().from(schema.artifacts).all(),
			chunks: memory.db.select().from(schema.artifactChunks).all(),
			links: memory.db.select().from(schema.artifactLinks).all(),
			files: memory.db.select().from(schema.chatGeneratedFiles).all(),
		};

		// A client that names the incognito conversation and its artifact
		// everywhere it can: in the query string and in the body.
		const query = `?conversationId=${INCOGNITO}&artifactId=${secret.artifactId}`;
		const read = await tourRoutes.read.GET(tourGetEvent("document", query));
		const readBody = await read.json();
		expect(readBody).toMatchObject({ ok: true, seen: false });
		for (const needle of needles) {
			expect(JSON.stringify(readBody)).not.toContain(needle);
		}

		const wrote = await tourRoutes.seen.POST(
			tourSeenEvent(
				"document",
				{
					contentKey: readBody.tour.contentKey,
					status: "completed",
					lastSlide: 2,
					conversationId: INCOGNITO,
					artifactId: secret.artifactId,
				},
				query,
			),
		);
		expect(await wrote.json()).toEqual({ ok: true, alreadyRecorded: false });

		const rows = memory.db.select().from(schema.artifactTourStates).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.userId).toBe(USER);
		for (const needle of needles) {
			expect(JSON.stringify(rows[0])).not.toContain(needle);
		}
		// And the tour left the artifact family exactly as it found it.
		expect({
			artifacts: memory.db.select().from(schema.artifacts).all(),
			chunks: memory.db.select().from(schema.artifactChunks).all(),
			links: memory.db.select().from(schema.artifactLinks).all(),
			files: memory.db.select().from(schema.chatGeneratedFiles).all(),
		}).toEqual(familyBefore);
	});

	it("runs the tour routes without one statement against an artifact, chat or file table", async () => {
		seedIncognitoWork();
		const statements: string[] = [];
		const realPrepare = memory.sqlite.prepare.bind(memory.sqlite);
		memory.sqlite.prepare = ((sql: string) => {
			statements.push(sql);
			return realPrepare(sql);
		}) as never;

		const read = await tourRoutes.read.GET(tourGetEvent("canvas"));
		const readBody = await read.json();
		await tourRoutes.seen.POST(
			tourSeenEvent("canvas", {
				contentKey: readBody.tour.contentKey,
				status: "dismissed",
				lastSlide: 1,
			}),
		);
		await tourRoutes.read.GET(tourGetEvent("canvas"));

		expect(statements.length).toBeGreaterThan(0);
		const artifactSide =
			/\b(?:from|join|into|update)\s+"?(?:artifacts|artifact_chunks|artifact_links|artifact_versions|artifact_comments|artifact_kv|chat_generated_files|project_knowledge_links|conversations|messages)"?(?![\w])/i;
		expect(statements.filter((sql) => artifactSide.test(sql))).toEqual([]);
		// Sanity: the spy saw the tour's own table, so it is looking.
		expect(statements.some((sql) => sql.includes("artifact_tour_states"))).toBe(
			true,
		);
	});

	it("reads no artifact table on any tour code path, by what each module imports and queries", () => {
		const offenders: string[] = [];
		for (const relative of TOUR_CODE_PATHS) {
			const source = readFileSync(join(process.cwd(), "src", relative), "utf8");
			if (readsGuardedTables(source)) {
				offenders.push(`${relative} — reads a guarded table`);
			}
			for (const name of schemaImportNames(source)) {
				if (!TOUR_TABLES.has(name)) {
					offenders.push(`${relative} — imports the table ${name}`);
				}
			}
			for (const specifier of importedSpecifiers(source)) {
				if (ARTIFACT_SIDE_SPECIFIER.test(`${specifier}"`)) {
					offenders.push(`${relative} — imports ${specifier}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	it("lists the modules it checks, so a tour module that moved cannot slip out of the check", () => {
		for (const relative of TOUR_CODE_PATHS) {
			expect(
				() => readFileSync(join(process.cwd(), "src", relative), "utf8"),
				relative,
			).not.toThrow();
		}
	});

	it("flags a tour module that did import an artifact table or an artifact-side service (the check's own self-test)", () => {
		expect(
			schemaImportNames(
				'import { artifactTourStates, type artifacts as a, artifactVersions } from "$lib/server/db/schema";',
			),
		).toEqual(["artifactTourStates", "artifacts", "artifactVersions"]);
		expect(readsGuardedTables("db.select().from(artifacts)")).toBe(true);
		for (const specifier of [
			"$lib/server/services/artifacts",
			"$lib/server/services/artifacts/index",
			"$lib/server/services/knowledge/store",
			"$lib/client/api/artifacts",
		]) {
			expect(ARTIFACT_SIDE_SPECIFIER.test(`${specifier}"`), specifier).toBe(
				true,
			);
		}
		// Its own neighbours are not the artifact side.
		for (const specifier of [
			"$lib/server/services/artifact-tours",
			"$lib/client/api/artifact-tours",
			"$lib/server/artifact-tour-defaults",
		]) {
			expect(ARTIFACT_SIDE_SPECIFIER.test(`${specifier}"`), specifier).toBe(
				false,
			);
		}
	});

	it("needs no exemption from the ownership guard, and has none", () => {
		expect(
			Object.keys(ALLOWED_WITHOUT_SCOPE).filter((entry) => /tour/i.test(entry)),
		).toEqual([]);
		// The reason an exemption would be dead weight: the guard's own test for
		// "a file that reads a guarded table" never fires on a tour module, so
		// there is nothing for an entry to excuse.
		for (const relative of TOUR_CODE_PATHS.filter((path) =>
			path.startsWith("lib/server/"),
		)) {
			const source = readFileSync(join(process.cwd(), "src", relative), "utf8");
			expect(readsGuardedTables(source), relative).toBe(false);
		}
	});
});

// FU-1: a board's poster files go with it from Knowledge -> Documents' Delete as
// they do from the panel's, and only from the board's own chat. The library's
// delete reaches an incognito chat's board (a delete must always be possible, and
// the library never lists it), so what it takes must be exactly that chat's files
// named for that board: not a same-named file in another chat of the same user,
// not another board's, and nothing at all when the caller is not the owner.
const { deleteLibraryArtifact } = await import(
	"$lib/server/services/artifacts"
);
const { posterFileName } = await import("$lib/shared/artifacts/poster-file");

describe("a board deleted from Knowledge -> Documents, with its poster files", () => {
	const fileRow = (
		id: string,
		filename: string,
		conversationId: string,
		userId = USER,
	) => ({
		id,
		conversationId,
		assistantMessageId: null,
		userId,
		filename,
		mimeType: "image/png",
		sizeBytes: 100,
		storagePath: `${conversationId}/${id}.png`,
		createdAt: NOW,
	});
	const fileIds = () =>
		memory.db
			.select()
			.from(schema.chatGeneratedFiles)
			.all()
			.map((row) => row.id)
			.sort();

	beforeEach(() => {
		seedUser(STRANGER);
	});

	it("takes an incognito chat's own posters and no other chat's, and a stranger's delete takes nothing", async () => {
		const { boardId } = await seedBoard(INCOGNITO);
		const other = await seedBoard(NORMAL, "Another board");
		memory.db
			.insert(schema.chatGeneratedFiles)
			.values([
				fileRow("own-poster", posterFileName(boardId, "app-1"), INCOGNITO),
				// The same name in another chat of the same user: not this board's chat.
				fileRow("same-name", posterFileName(boardId, "app-2"), NORMAL),
				// Another board's poster, in the normal chat.
				fileRow("other-poster", posterFileName(other.boardId, "app-1"), NORMAL),
			])
			.run();

		// Not the owner's to delete: the library answers null and takes nothing.
		await expect(deleteLibraryArtifact(STRANGER, boardId)).resolves.toBeNull();
		expect(fileIds()).toEqual(["other-poster", "own-poster", "same-name"]);
		expect(boardRows(boardId).body).toBeDefined();

		await expect(deleteLibraryArtifact(USER, boardId)).resolves.toMatchObject({
			deletedArtifactIds: [boardId],
		});

		expect(boardRows(boardId).body).toBeUndefined();
		expect(fileIds()).toEqual(["other-poster", "same-name"]);
		expect(boardRows(other.boardId).body).toBeDefined();
	});
});
