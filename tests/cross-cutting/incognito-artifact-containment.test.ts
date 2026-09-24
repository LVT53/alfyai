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
import { eq } from "drizzle-orm";
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
		source.includes(".from(projectKnowledgeLinks)")
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
		source.includes("buildArtifactVisibilityCondition")
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
});
