import { randomUUID } from "node:crypto";
import {
	access,
	mkdir,
	readFile,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { and, desc, eq, inArray, isNotNull, notInArray } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	artifacts,
	chatGeneratedFiles,
	conversations,
} from "$lib/server/db/schema";
import {
	isGeneratedFileMemoryWrapper,
	readGeneratedFileExtractedText,
} from "$lib/server/services/extraction/generated-file-memory-format";
import {
	buildGeneratedFileExtractedContentSection,
	ensureGeneratedFileReadbackSinkRegistered,
} from "$lib/server/services/extraction/readback";
import { decodeTextBuffer } from "$lib/server/services/extraction/text-decode";
import { GENERATED_DOCUMENT_RENDERED_CHAT_FILE_IDS_KEY } from "$lib/server/services/file-production/source-persistence";
import {
	getArtifactOwnershipScope,
	mapArtifact,
} from "$lib/server/services/knowledge/store/core";
import {
	buildGeneratedOutputDocumentMetadata,
	parseWorkingDocumentMetadata,
	resolveGeneratedDocumentFamilyContext,
} from "$lib/server/services/knowledge/store/document-metadata";
import type { Artifact } from "$lib/server/services/knowledge/types";
import { recordMemoryBehaviorEvent } from "$lib/server/services/memory-behavior-log";
import { parseJsonRecord } from "$lib/server/utils/json";
import { previewText } from "$lib/server/utils/text";
import {
	fileExtension,
	getIntakeRoute,
	resolveEntry,
} from "$lib/shared/file-types";

const chatGeneratedFileSelection = {
	id: chatGeneratedFiles.id,
	conversationId: chatGeneratedFiles.conversationId,
	assistantMessageId: chatGeneratedFiles.assistantMessageId,
	userId: chatGeneratedFiles.userId,
	filename: chatGeneratedFiles.filename,
	mimeType: chatGeneratedFiles.mimeType,
	sizeBytes: chatGeneratedFiles.sizeBytes,
	storagePath: chatGeneratedFiles.storagePath,
	createdAt: chatGeneratedFiles.createdAt,
} as const;

export interface ChatFile {
	id: string;
	conversationId: string;
	assistantMessageId: string | null;
	artifactId: string | null;
	documentFamilyId?: string | null;
	documentFamilyStatus?: "active" | "historical" | null;
	documentLabel?: string | null;
	documentRole?: string | null;
	versionNumber?: number | null;
	originConversationId?: string | null;
	originAssistantMessageId?: string | null;
	sourceChatFileId?: string | null;
	userId: string;
	filename: string;
	mimeType: string | null;
	sizeBytes: number;
	storagePath: string;
	createdAt: number;
}

export interface FileInput {
	filename: string;
	mimeType?: string;
	content: Buffer | Uint8Array;
	assistantMessageId?: string | null;
}

interface GeneratedFileVersionRecord {
	artifactId: string;
	version: number;
	updatedAt: number;
	/**
	 * The version's stored text. There is deliberately no `summary` beside it:
	 * a generated file's summary IS its memory wrapper's head, ids and all, and
	 * a field that exists is a field the next excerpt builder will reach for.
	 */
	contentText: string | null;
	conversationId: string | null;
	documentFamilyId: string | null;
	documentFamilyStatus: "active" | "historical" | null;
	documentLabel: string | null;
	documentRole: string | null;
}

function buildGeneratedFileArtifactName(filename: string): string {
	return filename;
}

/**
 * What a prior version's line says about that version, beyond the structured
 * facts around it (its number, its date, the family's filename).
 *
 * The file's own CONTENT, and nothing else. It used to prefer the stored
 * SUMMARY, which for a generated file is `guessSummary` over that version's
 * own memory wrapper — so it began with `Chat file id: <uuid>` and
 * `Generated in conversation: <uuid>`, and flattening it onto this one line
 * carried both ids into the wrapper being written now. The read-back redaction
 * strips those two lines BY PREFIX, which a nested copy on a `- v1 from …`
 * line never matches, and live an incognito conversation's chat-file id
 * reached the model that way.
 *
 * So the ids are removed structurally rather than textually: a version line is
 * built from fields that cannot contain one. A wrapper's extracted section is
 * the file's text; anything else stored here is already the text itself.
 */
function buildGeneratedFileVersionExcerpt(
	version: GeneratedFileVersionRecord,
): string | null {
	const stored = version.contentText;
	const fileText = isGeneratedFileMemoryWrapper(stored)
		? readGeneratedFileExtractedText(stored)
		: stored;
	return previewText(fileText, 320);
}

function buildGeneratedFileMemoryContent(params: {
	file: ChatFile;
	extractedText: string | null;
	assistantResponse: string;
	versionNumber: number;
	recentVersions: GeneratedFileVersionRecord[];
}): string {
	const lines = [
		`Generated file: ${params.file.filename}`,
		`File type: ${params.file.mimeType ?? "application/octet-stream"}`,
		`Chat file id: ${params.file.id}`,
		`Generated in conversation: ${params.file.conversationId}`,
		`Generated file version: v${params.versionNumber}`,
	];

	if (params.recentVersions.length > 0) {
		lines.push("", "Recent prior versions:");
		for (const version of params.recentVersions) {
			const timestamp = new Date(version.updatedAt).toISOString();
			const location =
				version.conversationId &&
				version.conversationId !== params.file.conversationId
					? ` in conversation ${version.conversationId}`
					: "";
			const excerpt = buildGeneratedFileVersionExcerpt(version);
			lines.push(
				excerpt
					? `- v${version.version} from ${timestamp}${location}: ${excerpt}`
					: `- v${version.version} from ${timestamp}${location}`,
			);
		}
	}

	const responseSnippet = previewText(params.assistantResponse, 900);
	if (responseSnippet) {
		lines.push("", "Assistant response context:", responseSnippet);
	}

	// The last section is the only one a readback rewrites later, which is why
	// it is built by the module that rewrites it.
	lines.push(
		"",
		buildGeneratedFileExtractedContentSection(params.extractedText),
	);

	return lines.join("\n");
}

/**
 * The earlier versions of this filename, which decide the new file's document
 * family, its version number and its label.
 *
 * A generated file's family is per user and per filename ACROSS
 * conversations, which is what makes "continue the release notes" work in a
 * fresh chat — and is why this scan has to go through the ownership scope. An
 * incognito conversation's output seeding a family here would put its
 * filename, its label and its excerpt into the next NORMAL conversation's
 * memory wrapper, and its version into the count that conversation is told.
 * The scope is asked for the conversation being written into, so a file
 * produced in an incognito chat still continues that chat's own family.
 */
async function listRecentGeneratedFileVersions(
	userId: string,
	conversationId: string,
	filename: string,
	limit = 4,
): Promise<GeneratedFileVersionRecord[]> {
	const ownershipScope = await getArtifactOwnershipScope(userId, {
		conversationId,
	});
	const rows = await db
		.select({
			id: artifacts.id,
			name: artifacts.name,
			conversationId: artifacts.conversationId,
			contentText: artifacts.contentText,
			metadataJson: artifacts.metadataJson,
			updatedAt: artifacts.updatedAt,
		})
		.from(artifacts)
		.where(
			and(eq(artifacts.userId, userId), eq(artifacts.type, "generated_output")),
		)
		.orderBy(desc(artifacts.updatedAt))
		.limit(Math.max(limit * 12, 24));

	const parsedRows = rows
		// The scope's answer, applied to the rows rather than in the `where`:
		// this is the one question asked of it here — is that conversation
		// reachable from this one — and an artifact whose conversation is gone
		// keeps being considered, exactly as it was before.
		.filter(
			(row) =>
				!row.conversationId ||
				ownershipScope.conversationIds.has(row.conversationId),
		)
		.map((row) => {
			const metadata = parseJsonRecord(row.metadataJson ?? null);
			return {
				row,
				metadata,
			};
		});
	const familyContext = resolveGeneratedDocumentFamilyContext({
		filename,
		candidates: parsedRows.map(({ row, metadata }) => ({
			artifactId: row.id,
			artifactName: row.name,
			updatedAt: row.updatedAt.getTime(),
			metadata,
		})),
	});

	const matchingRows = parsedRows
		.filter(({ row, metadata }) => {
			if (familyContext.matchingArtifactIds.length > 0) {
				return familyContext.matchingArtifactIds.includes(row.id);
			}

			const generatedFilename =
				typeof metadata?.generatedFilename === "string"
					? metadata.generatedFilename.trim()
					: null;
			const documentMetadata = parseWorkingDocumentMetadata(metadata);
			return (
				generatedFilename === filename ||
				documentMetadata.documentLabel === filename ||
				row.name === buildGeneratedFileArtifactName(filename)
			);
		})
		.slice(0, limit);

	return matchingRows.map(({ row, metadata }, index) => {
		const documentMetadata = parseWorkingDocumentMetadata(metadata);
		const storedVersion =
			typeof documentMetadata.versionNumber === "number" &&
			Number.isFinite(documentMetadata.versionNumber)
				? Math.trunc(documentMetadata.versionNumber)
				: typeof metadata?.generatedFileVersion === "number" &&
						Number.isFinite(metadata.generatedFileVersion)
					? Math.trunc(metadata.generatedFileVersion)
					: null;

		return {
			artifactId: row.id,
			version:
				storedVersion && storedVersion > 0
					? storedVersion
					: matchingRows.length - index,
			updatedAt: row.updatedAt.getTime(),
			contentText: row.contentText ?? null,
			conversationId: row.conversationId ?? null,
			documentFamilyId: documentMetadata.documentFamilyId ?? null,
			documentFamilyStatus: documentMetadata.documentFamilyStatus ?? null,
			documentLabel: documentMetadata.documentLabel ?? null,
			documentRole: documentMetadata.documentRole ?? null,
		};
	});
}

function mapRowToChatFile(
	row: typeof chatGeneratedFiles.$inferSelect,
): ChatFile {
	return {
		id: row.id,
		conversationId: row.conversationId,
		assistantMessageId: row.assistantMessageId ?? null,
		artifactId: null,
		userId: row.userId,
		filename: row.filename,
		mimeType: row.mimeType ?? null,
		sizeBytes: row.sizeBytes,
		storagePath: row.storagePath,
		createdAt: row.createdAt.getTime(),
	};
}

function readStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter(Boolean);
}

async function listGeneratedOutputArtifactIdsByChatFile(
	conversationId: string,
): Promise<
	Map<
		string,
		{
			artifactId: string;
			documentFamilyId: string | null;
			documentFamilyStatus: "active" | "historical" | null;
			documentLabel: string | null;
			documentRole: string | null;
			versionNumber: number | null;
			originConversationId: string | null;
			originAssistantMessageId: string | null;
			sourceChatFileId: string | null;
			sourceArtifact: Artifact | null;
			isGeneratedDocumentSource: boolean;
		}
	>
> {
	const rows = await db
		.select()
		.from(artifacts)
		.where(
			and(
				eq(artifacts.conversationId, conversationId),
				eq(artifacts.type, "generated_output"),
			),
		)
		.orderBy(desc(artifacts.updatedAt));

	const artifactIdsByChatFile = new Map<
		string,
		{
			artifactId: string;
			documentFamilyId: string | null;
			documentFamilyStatus: "active" | "historical" | null;
			documentLabel: string | null;
			documentRole: string | null;
			versionNumber: number | null;
			originConversationId: string | null;
			originAssistantMessageId: string | null;
			sourceChatFileId: string | null;
			sourceArtifact: Artifact | null;
			isGeneratedDocumentSource: boolean;
		}
	>();
	for (const row of rows) {
		const metadata = parseJsonRecord(row.metadataJson ?? null);
		const chatFileId =
			typeof metadata?.originalChatFileId === "string" &&
			metadata.originalChatFileId.trim()
				? metadata.originalChatFileId.trim()
				: null;
		const renderedChatFileIds = readStringArray(
			metadata?.[GENERATED_DOCUMENT_RENDERED_CHAT_FILE_IDS_KEY],
		);
		const chatFileIds = Array.from(
			new Set(
				[chatFileId, ...renderedChatFileIds].filter((id): id is string =>
					Boolean(id),
				),
			),
		);
		if (chatFileIds.length === 0) continue;

		const documentMetadata = parseWorkingDocumentMetadata(metadata);
		const isGeneratedDocumentSource =
			metadata?.generatedDocumentSource !== undefined ||
			metadata?.generatedDocumentSourceVersion !== undefined;
		const sourceArtifact = isGeneratedDocumentSource ? mapArtifact(row) : null;
		for (const id of chatFileIds) {
			if (artifactIdsByChatFile.has(id)) {
				continue;
			}
			artifactIdsByChatFile.set(id, {
				artifactId: row.id,
				documentFamilyId: documentMetadata.documentFamilyId ?? null,
				documentFamilyStatus: documentMetadata.documentFamilyStatus ?? null,
				documentLabel: documentMetadata.documentLabel ?? null,
				documentRole: documentMetadata.documentRole ?? null,
				versionNumber:
					typeof documentMetadata.versionNumber === "number" &&
					Number.isFinite(documentMetadata.versionNumber)
						? Math.trunc(documentMetadata.versionNumber)
						: null,
				originConversationId: documentMetadata.originConversationId ?? null,
				originAssistantMessageId:
					documentMetadata.originAssistantMessageId ?? null,
				sourceChatFileId: renderedChatFileIds.includes(id)
					? id
					: (documentMetadata.sourceChatFileId ?? null),
				sourceArtifact,
				isGeneratedDocumentSource,
			});
		}
	}

	return artifactIdsByChatFile;
}

function getChatFilesDir(): string {
	return join(process.cwd(), "data", "chat-files");
}

function getConversationDir(conversationId: string): string {
	return join(getChatFilesDir(), conversationId);
}

// Storage-path extension. The parser is the shared registry one (spec row
// 54); it agrees with the old extname-based copy on every ordinary name and
// differs only for a dotfile: ".env" used to fall back to "bin" and now
// stores as "env".
function getFileExtension(filename: string): string {
	return fileExtension(filename) || "bin";
}

/**
 * Store a generated file for a conversation.
 * Saves to data/chat-files/{conversationId}/{fileId}.{ext}
 */
export async function storeGeneratedFile(
	conversationId: string,
	userId: string,
	file: FileInput,
): Promise<ChatFile> {
	const id = randomUUID();
	const ext = getFileExtension(file.filename);
	const storagePath = join(conversationId, `${id}.${ext}`);
	const fullPath = join(getChatFilesDir(), storagePath);
	const buffer = Buffer.isBuffer(file.content)
		? file.content
		: Buffer.from(file.content);

	try {
		// Ensure directory exists
		const conversationDir = getConversationDir(conversationId);
		await mkdir(conversationDir, { recursive: true });

		// Write file to disk
		await writeFile(fullPath, buffer);

		// Create database record
		const [row] = await db
			.insert(chatGeneratedFiles)
			.values({
				id,
				conversationId,
				assistantMessageId: file.assistantMessageId ?? null,
				userId,
				filename: file.filename,
				mimeType: file.mimeType ?? null,
				sizeBytes: buffer.length,
				storagePath,
			})
			.returning();

		const storedFile = mapRowToChatFile(row);
		return storedFile;
	} catch (error) {
		console.error("[CHAT_FILES] Failed to store generated file", {
			conversationId,
			userId,
			fileId: id,
			filename: file.filename,
			storagePath,
			error,
		});
		throw error;
	}
}

/**
 * Get all files for a conversation.
 * Returns only files belonging to the specified conversation.
 */
export async function getChatFiles(
	conversationId: string,
): Promise<ChatFile[]> {
	try {
		const [rows, artifactIdsByChatFile] = await Promise.all([
			db
				.select(chatGeneratedFileSelection)
				.from(chatGeneratedFiles)
				.where(
					and(
						eq(chatGeneratedFiles.conversationId, conversationId),
						isNotNull(chatGeneratedFiles.assistantMessageId),
					),
				)
				.orderBy(desc(chatGeneratedFiles.createdAt)),
			listGeneratedOutputArtifactIdsByChatFile(conversationId),
		]);

		return rows.map((row) => ({
			...mapRowToChatFile(row),
			artifactId: artifactIdsByChatFile.get(row.id)?.artifactId ?? null,
			documentFamilyId:
				artifactIdsByChatFile.get(row.id)?.documentFamilyId ?? null,
			documentFamilyStatus:
				artifactIdsByChatFile.get(row.id)?.documentFamilyStatus ?? null,
			documentLabel: artifactIdsByChatFile.get(row.id)?.documentLabel ?? null,
			documentRole: artifactIdsByChatFile.get(row.id)?.documentRole ?? null,
			versionNumber: artifactIdsByChatFile.get(row.id)?.versionNumber ?? null,
			originConversationId:
				artifactIdsByChatFile.get(row.id)?.originConversationId ?? null,
			originAssistantMessageId:
				artifactIdsByChatFile.get(row.id)?.originAssistantMessageId ?? null,
			sourceChatFileId:
				artifactIdsByChatFile.get(row.id)?.sourceChatFileId ?? null,
		}));
	} catch (error) {
		console.error("[CHAT_FILES] Failed to list generated files", {
			conversationId,
			error,
		});
		throw error;
	}
}

export async function getChatFilesForAssistantMessage(
	conversationId: string,
	assistantMessageId: string,
): Promise<ChatFile[]> {
	try {
		const [rows, artifactIdsByChatFile] = await Promise.all([
			db
				.select(chatGeneratedFileSelection)
				.from(chatGeneratedFiles)
				.where(
					and(
						eq(chatGeneratedFiles.conversationId, conversationId),
						eq(chatGeneratedFiles.assistantMessageId, assistantMessageId),
					),
				)
				.orderBy(desc(chatGeneratedFiles.createdAt)),
			listGeneratedOutputArtifactIdsByChatFile(conversationId),
		]);

		return rows.map((row) => ({
			...mapRowToChatFile(row),
			artifactId: artifactIdsByChatFile.get(row.id)?.artifactId ?? null,
			documentFamilyId:
				artifactIdsByChatFile.get(row.id)?.documentFamilyId ?? null,
			documentFamilyStatus:
				artifactIdsByChatFile.get(row.id)?.documentFamilyStatus ?? null,
			documentLabel: artifactIdsByChatFile.get(row.id)?.documentLabel ?? null,
			documentRole: artifactIdsByChatFile.get(row.id)?.documentRole ?? null,
			versionNumber: artifactIdsByChatFile.get(row.id)?.versionNumber ?? null,
			originConversationId:
				artifactIdsByChatFile.get(row.id)?.originConversationId ?? null,
			originAssistantMessageId:
				artifactIdsByChatFile.get(row.id)?.originAssistantMessageId ?? null,
			sourceChatFileId:
				artifactIdsByChatFile.get(row.id)?.sourceChatFileId ?? null,
		}));
	} catch (error) {
		console.error(
			"[CHAT_FILES] Failed to list assistant-scoped generated files",
			{
				conversationId,
				assistantMessageId,
				error,
			},
		);
		throw error;
	}
}

export async function getChatFilesByIdsForConversation(
	conversationId: string,
	fileIds: string[],
): Promise<ChatFile[]> {
	const uniqueFileIds = Array.from(new Set(fileIds.filter(Boolean)));
	if (uniqueFileIds.length === 0) {
		return [];
	}

	try {
		const fileIdSet = new Set(uniqueFileIds);
		const [rows, artifactIdsByChatFile] = await Promise.all([
			db
				.select(chatGeneratedFileSelection)
				.from(chatGeneratedFiles)
				.where(eq(chatGeneratedFiles.conversationId, conversationId))
				.orderBy(desc(chatGeneratedFiles.createdAt)),
			listGeneratedOutputArtifactIdsByChatFile(conversationId),
		]);

		return rows
			.filter((row) => fileIdSet.has(row.id))
			.map((row) => ({
				...mapRowToChatFile(row),
				artifactId: artifactIdsByChatFile.get(row.id)?.artifactId ?? null,
				documentFamilyId:
					artifactIdsByChatFile.get(row.id)?.documentFamilyId ?? null,
				documentFamilyStatus:
					artifactIdsByChatFile.get(row.id)?.documentFamilyStatus ?? null,
				documentLabel: artifactIdsByChatFile.get(row.id)?.documentLabel ?? null,
				documentRole: artifactIdsByChatFile.get(row.id)?.documentRole ?? null,
				versionNumber: artifactIdsByChatFile.get(row.id)?.versionNumber ?? null,
				originConversationId:
					artifactIdsByChatFile.get(row.id)?.originConversationId ?? null,
				originAssistantMessageId:
					artifactIdsByChatFile.get(row.id)?.originAssistantMessageId ?? null,
				sourceChatFileId:
					artifactIdsByChatFile.get(row.id)?.sourceChatFileId ?? null,
			}));
	} catch (error) {
		console.error("[CHAT_FILES] Failed to list generated files by id", {
			conversationId,
			fileIds: uniqueFileIds,
			error,
		});
		throw error;
	}
}

export async function assignGeneratedFilesToAssistantMessage(
	conversationId: string,
	assistantMessageId: string,
	fileIds: string[],
): Promise<void> {
	if (fileIds.length === 0) {
		return;
	}

	await db
		.update(chatGeneratedFiles)
		.set({ assistantMessageId })
		.where(
			and(
				eq(chatGeneratedFiles.conversationId, conversationId),
				inArray(chatGeneratedFiles.id, fileIds),
			),
		);
}

/**
 * Text for a generated file that is already text.
 *
 * Decoded from the bytes this function has already read rather than routed
 * through the ledger: a markdown, delimited-text or HTML output never needed a
 * parser, and making the user wait for a worker to hand back what is already in
 * memory would be a regression dressed up as an improvement.
 *
 * Delegates to the shared `decodeTextBuffer` (`extraction/text-decode.ts`) —
 * the same decoder `extraction/extractors/direct-text.ts` uses — so an
 * uploaded Markdown file and a generated one decode identically, and the same
 * bytes chunk the same way. `null` on a failed decode (binary content or an
 * unsupported encoding) is this function's contract; CRLF normalisation and
 * trim happen inside the shared decoder, exactly as they did here before.
 */
function decodeTextLikeGeneratedFile(content: Buffer): string | null {
	const result = decodeTextBuffer(content);
	return result.ok ? result.text || null : null;
}

/**
 * Where a generated file's readable text comes from.
 *
 * Three answers, decided once, from the registry rather than from a list:
 *
 *  - `inline`: the bytes ARE text (`textLike`), so they are decoded here and
 *    now. Every `inline_text` output is in this set — Markdown, plain text,
 *    delimited text, JSON and the code extensions — and so is HTML, which
 *    matters: HTML routes to MinerU for UPLOADS (Phase 5 D3, where MinerU
 *    strips a real page's nav, scripts and ads), but HTML this app generated
 *    is our own markup, already clean, and making it wait on a backend to
 *    read back what we just wrote would be a regression with no upside.
 *  - `ledger`: a binary a parser has to open — PDF, DOCX, XLSX, PPTX, ODT.
 *  - `none`: an image, an archive, an SVG. No backend can find text in them,
 *    so they get no job rather than a permanently failed ledger row each.
 */
export type GeneratedFileTextSource = "inline" | "ledger" | "none";

/**
 * Exported because a second module asks the same question and must not answer
 * it differently: `conversation-forks.ts` decides whether a copied generated
 * file is still waiting for a readback, and it currently asks
 * `getIntakeRoute(…) !== "mineru"`, which now misreads a generated HTML file
 * as one that needs a backend. The fix is to call this — INTEGRATOR
 * FOLLOW-UP, since that file belongs to no slice of this wave.
 */
export function generatedFileTextSource(
	filename: string,
	mimeType: string | null,
): GeneratedFileTextSource {
	if (resolveEntry(filename, mimeType)?.textLike === true) return "inline";
	const route = getIntakeRoute(filename, mimeType);
	if (route === "direct-text") return "inline";
	return route === "mineru" ? "ledger" : "none";
}

/**
 * Queues the binary's text for later, and never lets that queueing break the
 * sync.
 *
 * The artifact already exists and is already usable at this point; a ledger
 * that refuses the job leaves the file exactly as an extraction failure leaves
 * it today, which is the whole reason extraction failure has always been
 * non-fatal here.
 */
async function enqueueGeneratedFileReadback(params: {
	userId: string;
	conversationId: string;
	assistantMessageId: string;
	file: ChatFile;
}): Promise<void> {
	try {
		ensureGeneratedFileReadbackSinkRegistered();
		const { startGeneratedFileReadback } = await import(
			"$lib/server/services/extraction"
		);
		await startGeneratedFileReadback({
			userId: params.userId,
			conversationId: params.conversationId,
			assistantMessageId: params.assistantMessageId,
			chatGeneratedFileId: params.file.id,
			fileName: params.file.filename,
			mimeType: params.file.mimeType,
			sizeBytes: params.file.sizeBytes,
			// D10. Everything that reaches this line is a file this app just
			// produced: a DOCX/XLSX/PPTX executes at flash server-side anyway, and
			// a generated PDF came out of a renderer or a sandbox library, so it
			// is born-digital and OCR is pure waste on it. Flash parses it in
			// 811 ms against 1 126 ms warm and 18 600 ms COLD at basic — and
			// readback queues behind every user upload, so the cold start is
			// exactly the one worth avoiding.
			//
			// `preferredTier`, never `tier`: this is a preference, not the
			// re-extract button. A server without flash parses the file at
			// whatever tier it has (`decideTier` rule 1½) instead of failing the
			// job permanently with `tier_unavailable`.
			hints: { preferredTier: "flash" },
		});
	} catch (error) {
		console.warn(
			"[CHAT_FILES] Could not queue generated file text extraction; the file keeps its metadata",
			{
				conversationId: params.conversationId,
				fileId: params.file.id,
				filename: params.file.filename,
				error,
			},
		);
	}
}

/**
 * The one case where a source-first document still needs a parser.
 *
 * `persistGeneratedDocumentSourceArtifact` writes the rendered Markdown as the
 * artifact's text, so this is close to unreachable — it takes a renderer throw
 * on an already-validated source. When it does happen the file exists, the
 * artifact exists, and only the text is missing, which is exactly the shape
 * the readback path was built for. The job is queued for the file the sink can
 * find (`metadata.originalChatFileId`), and only when a backend could read it
 * at all.
 */
async function enqueueSourceFirstFallbackReadback(params: {
	userId: string;
	conversationId: string;
	assistantMessageId: string;
	fileId: string;
	sourceArtifact: Artifact;
}): Promise<void> {
	const originalChatFileId = params.sourceArtifact.metadata?.originalChatFileId;
	if (originalChatFileId !== params.fileId) {
		return;
	}
	const file = await getChatFile(params.conversationId, params.fileId);
	if (!file) return;
	if (generatedFileTextSource(file.filename, file.mimeType) !== "ledger") {
		return;
	}
	console.warn(
		"[CHAT_FILES] Generated document source has no text; reading the rendered file back instead",
		{
			conversationId: params.conversationId,
			fileId: params.fileId,
			artifactId: params.sourceArtifact.id,
		},
	);
	await enqueueGeneratedFileReadback({
		userId: params.userId,
		conversationId: params.conversationId,
		assistantMessageId: params.assistantMessageId,
		file,
	});
}

/**
 * Turns freshly stored generated files into memory artifacts.
 *
 * Extraction is no longer part of that: a binary's text is queued on the
 * document-extraction ledger at readback priority and written into the artifact
 * by `extraction/readback.ts` when it arrives, so the file-production job that
 * called this is finished the moment the bookkeeping is. Until the text lands
 * the artifact reads exactly as it does today when extraction fails — the
 * version metadata, the family link and the wrapper are all there, only the
 * extracted-content section says it has nothing yet.
 */
export async function syncGeneratedFilesToMemory(params: {
	userId: string;
	conversationId: string;
	assistantMessageId: string;
	fileIds: string[];
	assistantResponse: string;
}): Promise<void> {
	if (params.fileIds.length === 0) {
		return;
	}

	const { createArtifactLink, createGeneratedOutputArtifact } = await import(
		"$lib/server/services/knowledge"
	);

	const uniqueFileIds = Array.from(new Set(params.fileIds));
	const artifactIdsByChatFile = await listGeneratedOutputArtifactIdsByChatFile(
		params.conversationId,
	);

	for (const fileId of uniqueFileIds) {
		try {
			const existingArtifact = artifactIdsByChatFile.get(fileId);
			const sourceArtifact = existingArtifact?.isGeneratedDocumentSource
				? existingArtifact.sourceArtifact
				: null;
			if (sourceArtifact) {
				// A source-first render — the PDF, DOCX, HTML or MD of a
				// `document_source` job. Its text is the source artifact's, written
				// by `renderStandardReportMarkdown` when the job persisted the
				// source (ADR-0005, D9), so it is readable the moment the job
				// succeeds and it never reaches the ledger: round-tripping our own
				// PDF through a parser could only ever lose what we already hold.
				if ((sourceArtifact.contentText ?? "").trim()) {
					continue;
				}
				// Unless the render failed and left no text. Then this binary is
				// the only copy of the document, and the ledger is the way to read
				// it — onto this same artifact, which is the one the readback sink
				// looks up by `originalChatFileId`. Any other rendered file of the
				// same job has nowhere to be written, so it is left alone.
				await enqueueSourceFirstFallbackReadback({
					userId: params.userId,
					conversationId: params.conversationId,
					assistantMessageId: params.assistantMessageId,
					fileId,
					sourceArtifact,
				});
				continue;
			}
			if (existingArtifact) {
				// This chat file already has its memory artifact. Syncing it again —
				// two callers racing the same assistant message, a retry after a
				// partial failure — used to mint a second artifact and call it v2 of
				// itself; it would now also race the ledger for the same file id.
				// One stored file, one artifact, one extraction job.
				continue;
			}

			const file = await getChatFile(params.conversationId, fileId);
			if (!file) {
				continue;
			}

			const content = await readStoredChatFile(file);
			if (!content) {
				continue;
			}

			const textSource = generatedFileTextSource(file.filename, file.mimeType);
			const extractedText =
				textSource === "inline" ? decodeTextLikeGeneratedFile(content) : null;
			const needsReadback = textSource === "ledger";

			const recentVersions = await listRecentGeneratedFileVersions(
				params.userId,
				params.conversationId,
				file.filename,
				4,
			);
			const previousVersion = recentVersions[0] ?? null;
			const previousVersionNumbers = recentVersions
				.map((version) => version.version)
				.filter((version) => Number.isFinite(version) && version > 0);
			const versionNumber =
				previousVersionNumbers.length > 0
					? Math.max(...previousVersionNumbers) + 1
					: 1;
			const documentFamilyId =
				previousVersion?.documentFamilyId ?? randomUUID();
			const documentLabel = previousVersion?.documentLabel ?? file.filename;
			const documentRole = previousVersion?.documentRole ?? null;
			const workingDocumentMetadata = buildGeneratedOutputDocumentMetadata({
				familyId: documentFamilyId,
				familyStatus: "active",
				label: documentLabel,
				role: documentRole,
				versionNumber,
				supersedesArtifactId: previousVersion?.artifactId ?? null,
				originConversationId: params.conversationId,
				originAssistantMessageId: params.assistantMessageId,
				sourceChatFileId: file.id,
			});

			const memoryArtifact = await createGeneratedOutputArtifact({
				userId: params.userId,
				conversationId: params.conversationId,
				messageId: params.assistantMessageId,
				content: buildGeneratedFileMemoryContent({
					file,
					extractedText,
					assistantResponse: params.assistantResponse,
					versionNumber,
					recentVersions,
				}),
				sourceArtifactIds: [],
				nameOverride: buildGeneratedFileArtifactName(file.filename),
				metadata: {
					generatedFile: true,
					originalChatFileId: file.id,
					generatedFilename: file.filename,
					generatedMimeType: file.mimeType,
					assistantMessageId: params.assistantMessageId,
					generatedFileVersion: versionNumber,
					previousGeneratedArtifactId: previousVersion?.artifactId ?? null,
					recentGeneratedVersionIds: recentVersions.map(
						(version) => version.artifactId,
					),
					...workingDocumentMetadata,
				},
			});

			if (!memoryArtifact) {
				continue;
			}

			if (previousVersion) {
				await createArtifactLink({
					userId: params.userId,
					artifactId: memoryArtifact.id,
					relatedArtifactId: previousVersion.artifactId,
					conversationId: params.conversationId,
					messageId: params.assistantMessageId,
					linkType: "supersedes",
				});

				await recordMemoryBehaviorEvent({
					eventKey: `document_superseded:${previousVersion.artifactId}:${memoryArtifact.id}`,
					userId: params.userId,
					conversationId: params.conversationId,
					messageId: params.assistantMessageId,
					domain: "document",
					eventType: "document_superseded",
					subjectId: memoryArtifact.id,
					relatedId: previousVersion.artifactId,
					payload: {
						documentFamilyId,
						documentLabel,
						documentRole,
						versionNumber,
						previousVersion: previousVersion.version,
						currentFilename: file.filename,
					},
				});
			}

			// Last, so the artifact and its links exist before any worker can
			// claim the job and patch the artifact's text.
			if (needsReadback) {
				await enqueueGeneratedFileReadback({
					userId: params.userId,
					conversationId: params.conversationId,
					assistantMessageId: params.assistantMessageId,
					file,
				});
			}
		} catch (error) {
			console.error("[CHAT_FILES] Failed to sync generated file to memory", {
				conversationId: params.conversationId,
				assistantMessageId: params.assistantMessageId,
				fileId,
				error,
			});
		}
	}
}

/**
 * Get a specific file by ID within a conversation.
 * Verifies the file belongs to the conversation.
 */
export async function getChatFile(
	conversationId: string,
	fileId: string,
): Promise<ChatFile | null> {
	const [row] = await db
		.select(chatGeneratedFileSelection)
		.from(chatGeneratedFiles)
		.where(
			and(
				eq(chatGeneratedFiles.id, fileId),
				eq(chatGeneratedFiles.conversationId, conversationId),
			),
		)
		.limit(1);

	return row ? mapRowToChatFile(row) : null;
}

/**
 * Get a specific file by ID for a user, regardless of conversation.
 * Used by routes that already authenticate the current user.
 */
export async function getChatFileByUser(
	fileId: string,
	userId: string,
): Promise<ChatFile | null> {
	const [row] = await db
		.select(chatGeneratedFileSelection)
		.from(chatGeneratedFiles)
		.where(
			and(
				eq(chatGeneratedFiles.id, fileId),
				eq(chatGeneratedFiles.userId, userId),
			),
		)
		.limit(1);

	return row ? mapRowToChatFile(row) : null;
}

export async function getChatFileByConversationOwner(
	fileId: string,
	userId: string,
): Promise<ChatFile | null> {
	const [row] = await db
		.select({
			id: chatGeneratedFiles.id,
			conversationId: chatGeneratedFiles.conversationId,
			assistantMessageId: chatGeneratedFiles.assistantMessageId,
			userId: chatGeneratedFiles.userId,
			filename: chatGeneratedFiles.filename,
			mimeType: chatGeneratedFiles.mimeType,
			sizeBytes: chatGeneratedFiles.sizeBytes,
			storagePath: chatGeneratedFiles.storagePath,
			createdAt: chatGeneratedFiles.createdAt,
		})
		.from(chatGeneratedFiles)
		.innerJoin(
			conversations,
			eq(chatGeneratedFiles.conversationId, conversations.id),
		)
		.where(
			and(eq(chatGeneratedFiles.id, fileId), eq(conversations.userId, userId)),
		)
		.limit(1);

	return row ? mapRowToChatFile(row) : null;
}

async function readStoredChatFile(file: ChatFile): Promise<Buffer | null> {
	const fullPath = join(getChatFilesDir(), file.storagePath);
	try {
		await access(fullPath);
		return await readFile(fullPath);
	} catch {
		return null;
	}
}

/**
 * Read the actual file content from disk.
 * Returns null if file doesn't exist in database or on disk.
 */
export async function readChatFileContent(
	conversationId: string,
	fileId: string,
): Promise<Buffer | null> {
	const file = await getChatFile(conversationId, fileId);
	if (!file) return null;

	return readStoredChatFile(file);
}

/**
 * Read the actual file content from disk for a user-owned file.
 * Returns null if the file doesn't exist in database or on disk.
 */
export async function readChatFileContentByUser(
	fileId: string,
	userId: string,
): Promise<Buffer | null> {
	const file = await getChatFileByUser(fileId, userId);
	if (!file) return null;

	return readStoredChatFile(file);
}

export async function readChatFileContentByConversationOwner(
	fileId: string,
	userId: string,
): Promise<Buffer | null> {
	const file = await getChatFileByConversationOwner(fileId, userId);
	if (!file) return null;

	return readStoredChatFile(file);
}

/**
 * Delete a chat file.
 * Removes both the database record and the file from disk.
 */
export async function deleteChatFile(
	conversationId: string,
	fileId: string,
): Promise<boolean> {
	const file = await getChatFile(conversationId, fileId);
	if (!file) return false;

	// Delete from database
	await db
		.delete(chatGeneratedFiles)
		.where(
			and(
				eq(chatGeneratedFiles.id, fileId),
				eq(chatGeneratedFiles.conversationId, conversationId),
			),
		);

	// Delete from disk
	const fullPath = join(getChatFilesDir(), file.storagePath);
	try {
		await unlink(fullPath);
	} catch {
		// File may not exist on disk, that's ok
	}

	return true;
}

/**
 * Delete all files for a conversation.
 * Used when a conversation is deleted.
 */
export async function deleteAllChatFilesForConversation(
	conversationId: string,
): Promise<number> {
	let files: Array<typeof chatGeneratedFiles.$inferSelect> = [];
	try {
		files = await db
			.select()
			.from(chatGeneratedFiles)
			.where(eq(chatGeneratedFiles.conversationId, conversationId))
			.orderBy(desc(chatGeneratedFiles.createdAt));
	} catch (error) {
		console.error(
			"[CHAT_FILES] Failed to list files for conversation cleanup",
			{
				conversationId,
				error,
			},
		);
	}

	try {
		await db
			.delete(chatGeneratedFiles)
			.where(eq(chatGeneratedFiles.conversationId, conversationId));
	} catch (error) {
		console.error(
			"[CHAT_FILES] Failed to delete file rows for conversation cleanup",
			{
				conversationId,
				error,
			},
		);
	}

	// Delete files from disk
	let deletedCount = 0;
	for (const file of files) {
		const fullPath = join(getChatFilesDir(), file.storagePath);
		try {
			await unlink(fullPath);
			deletedCount++;
		} catch {
			// File may not exist on disk
		}
	}

	try {
		await rm(getConversationDir(conversationId), {
			recursive: true,
			force: true,
		});
	} catch {
		// Directory cleanup is best-effort
	}

	return deletedCount;
}

export async function deleteAllChatFilesForUser(
	userId: string,
): Promise<number> {
	const files = await db
		.select(chatGeneratedFileSelection)
		.from(chatGeneratedFiles)
		.where(eq(chatGeneratedFiles.userId, userId));

	await db
		.delete(chatGeneratedFiles)
		.where(eq(chatGeneratedFiles.userId, userId));

	let deletedCount = 0;
	const conversationIds = new Set<string>();
	for (const file of files) {
		conversationIds.add(file.conversationId);
		const fullPath = join(getChatFilesDir(), file.storagePath);
		try {
			await unlink(fullPath);
			deletedCount++;
		} catch {
			// File may not exist on disk
		}
	}

	for (const conversationId of conversationIds) {
		try {
			await rm(getConversationDir(conversationId), {
				recursive: true,
				force: true,
			});
		} catch {
			// Directory cleanup is best-effort
		}
	}

	return deletedCount;
}

/**
 * Delete chat-generated file rows whose parent conversation no longer exists.
 * Uses a subquery to find orphan rows efficiently without pulling all IDs into memory.
 */
export async function deleteOrphanChatFiles(): Promise<number> {
	try {
		const orphanRows = await db
			.select({
				id: chatGeneratedFiles.id,
				conversationId: chatGeneratedFiles.conversationId,
				storagePath: chatGeneratedFiles.storagePath,
			})
			.from(chatGeneratedFiles)
			.where(
				notInArray(
					chatGeneratedFiles.conversationId,
					db.select({ id: conversations.id }).from(conversations),
				),
			)
			.orderBy(desc(chatGeneratedFiles.createdAt));

		if (orphanRows.length === 0) return 0;

		await db.delete(chatGeneratedFiles).where(
			inArray(
				chatGeneratedFiles.id,
				orphanRows.map((r) => r.id),
			),
		);

		for (const row of orphanRows) {
			const fullPath = join(getChatFilesDir(), row.storagePath);
			try {
				await unlink(fullPath);
			} catch {
				// File may not exist on disk
			}
		}

		const orphanConvIds = new Set(orphanRows.map((r) => r.conversationId));
		for (const convId of orphanConvIds) {
			try {
				await rm(getConversationDir(convId), { recursive: true, force: true });
			} catch {
				// Directory cleanup is best-effort
			}
		}

		return orphanRows.length;
	} catch (error) {
		console.error("[CHAT_FILES] Failed to delete orphan chat files", { error });
		throw error;
	}
}
