import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { artifacts } from "$lib/server/db/schema";
import {
	createArtifact,
	mapArtifact,
} from "$lib/server/services/knowledge/store/core";
import type { Artifact } from "$lib/server/services/knowledge/types";
import { parseJsonRecord } from "$lib/server/utils/json";
import { renderStandardReportMarkdown } from "./renderers/standard-report-markdown";
import {
	type GeneratedDocumentSource,
	validateGeneratedDocumentSource,
} from "./source-schema";

export interface PersistGeneratedDocumentSourceInput {
	userId: string;
	conversationId: string;
	assistantMessageId?: string | null;
	fileProductionJobId: string;
	title: string;
	documentIntent?: string | null;
	source: unknown;
	/**
	 * The already-rendered Markdown, when the job requested `markdown` among its
	 * outputs and the worker therefore rendered it anyway. Omitted ⇒ this
	 * function renders it once itself. Either way the renderer runs exactly once
	 * per job: it is a pure, synchronous function of the validated source
	 * object, with no image loader and no favicon resolution.
	 */
	readonly renderedMarkdown?: string;
}

export const GENERATED_DOCUMENT_RENDERED_CHAT_FILE_IDS_KEY =
	"generatedDocumentRenderedChatFileIds";
export const GENERATED_DOCUMENT_SOURCE_STATUS_KEY =
	"generatedDocumentSourceStatus";

type GeneratedDocumentSourceStatus = "pending" | "succeeded" | "failed";

/**
 * An inline image's bytes, as the Markdown renderer writes them into a file
 * meant to be opened on its own.
 *
 * Correct in a download, wrong in an artifact: this text is chunked, embedded
 * and handed back to the model through `read_generated_file`, where up to
 * 2 MiB of base64 (the static `maxSourceJsonBytes` ceiling) would fill the
 * window with something no reader can use. Only the payload is replaced — the
 * alt text, the caption and the attribution stay exactly where the renderer
 * put them.
 */
const DATA_URI_IMAGE_PATTERN = /\(data:([^;,)]+);base64,[^)]*\)/g;

/**
 * The document's text, as one renderer (D9).
 *
 * It used to be `buildGeneratedDocumentProjection`, a third rendering of the
 * same source beside the Markdown and HTML/PDF/DOCX renderers, which meant the
 * text the model read back was never quite the file the user downloaded.
 * `renderStandardReportMarkdown` is now the only source→text path, so the two
 * agree by construction.
 *
 * Returns `null` when there is no text to write, which is the caller's signal
 * to leave the readback path to fill the gap rather than store an empty
 * document.
 */
function buildGeneratedDocumentSourceText(
	source: GeneratedDocumentSource,
	renderedMarkdown: string | undefined,
	/** Ids for the log line below; the document's own words never go in it. */
	logContext?: { fileProductionJobId?: string | null },
): string | null {
	let markdown = renderedMarkdown;
	if (markdown === undefined) {
		try {
			markdown = renderStandardReportMarkdown(source).content.toString("utf8");
		} catch (error) {
			// Pure, synchronous and fed an already-validated source, so this is
			// close to unreachable — and if it ever fires, the file still exists
			// and `chat-files.ts` falls through to a readback for the rendered
			// binaries, which is exactly what a non-source generated file does.
			//
			// The title used to be in this line. A document title is chosen by the
			// user or the model and is the document's content, which log lines do
			// not carry: they carry ids, counts, codes and durations. The job id
			// finds the document; its shape says what failed to render.
			console.warn(
				"[FILE_PRODUCTION] Generated document markdown render failed; the rendered files keep their own readback",
				{
					fileProductionJobId: logContext?.fileProductionJobId ?? null,
					titleLength: source.title.length,
					blockCount: source.blocks.length,
					error,
				},
			);
			return null;
		}
	}
	const text = markdown.replace(DATA_URI_IMAGE_PATTERN, "(embedded $1)");
	return text.trim() ? text : null;
}

/**
 * The readable text of a stored document source, for a caller that holds the
 * source object but not the artifact's text.
 *
 * `read_generated_file` needs exactly what the memory sync stores — the same
 * renderer, the same data-URI replacement — for a document-source file whose
 * artifact text is missing (a render that threw at persist time). Re-deriving
 * it there would be a second source→text path, which is the thing D9 removed.
 * Returns `null` when the source is not a valid document source or renders to
 * nothing, which is the caller's signal to fall back.
 */
export function renderGeneratedDocumentSourceText(
	source: unknown,
): string | null {
	const validation = validateGeneratedDocumentSource(source);
	if (!validation.ok) return null;
	return buildGeneratedDocumentSourceText(validation.source, undefined);
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

async function findGeneratedDocumentSourceArtifactForJob(input: {
	userId: string;
	conversationId: string;
	fileProductionJobId: string;
}): Promise<Artifact | null> {
	const rows = await db
		.select()
		.from(artifacts)
		.where(
			and(
				eq(artifacts.userId, input.userId),
				eq(artifacts.conversationId, input.conversationId),
				eq(artifacts.type, "generated_output"),
			),
		);

	const existing = rows.find((row) => {
		const metadata = parseJsonRecord(row.metadataJson ?? null);
		return metadata?.fileProductionJobId === input.fileProductionJobId;
	});

	return existing ? mapArtifact(existing) : null;
}

async function updateGeneratedDocumentSourceArtifactStatus(input: {
	artifactId: string;
	status: GeneratedDocumentSourceStatus;
	errorCode?: string | null;
	errorMessage?: string | null;
}): Promise<Artifact | null> {
	const [row] = await db
		.select()
		.from(artifacts)
		.where(eq(artifacts.id, input.artifactId))
		.limit(1);
	if (!row) {
		return null;
	}

	const metadata = parseJsonRecord(row.metadataJson ?? null) ?? {};
	const {
		generatedDocumentSourceErrorCode: _previousErrorCode,
		generatedDocumentSourceErrorMessage: _previousErrorMessage,
		...baseMetadata
	} = metadata;
	const nextMetadata: Record<string, unknown> = {
		...baseMetadata,
		[GENERATED_DOCUMENT_SOURCE_STATUS_KEY]: input.status,
	};

	if (input.status === "failed") {
		nextMetadata.generatedDocumentSourceErrorCode = input.errorCode ?? null;
		nextMetadata.generatedDocumentSourceErrorMessage =
			input.errorMessage ?? null;
	}

	const [updated] = await db
		.update(artifacts)
		.set({
			retrievalClass:
				input.status === "succeeded" ? "durable" : "ephemeral_followup",
			metadataJson: JSON.stringify(nextMetadata),
			updatedAt: new Date(),
		})
		.where(eq(artifacts.id, input.artifactId))
		.returning();

	return updated ? mapArtifact(updated) : null;
}

export async function markGeneratedDocumentSourceArtifactFailed(input: {
	artifactId: string;
	errorCode: string;
	errorMessage: string;
}): Promise<Artifact | null> {
	return updateGeneratedDocumentSourceArtifactStatus({
		...input,
		status: "failed",
	});
}

export async function persistGeneratedDocumentSourceArtifact(
	input: PersistGeneratedDocumentSourceInput,
): Promise<Artifact> {
	const validation = validateGeneratedDocumentSource(input.source);
	if (!validation.ok) {
		throw new Error(validation.message);
	}

	const source: GeneratedDocumentSource = validation.source;
	const documentText = buildGeneratedDocumentSourceText(
		source,
		input.renderedMarkdown,
		{ fileProductionJobId: input.fileProductionJobId },
	);
	const existing = await findGeneratedDocumentSourceArtifactForJob({
		userId: input.userId,
		conversationId: input.conversationId,
		fileProductionJobId: input.fileProductionJobId,
	});
	if (existing) {
		const existingRenderedIds = readStringArray(
			existing.metadata?.[GENERATED_DOCUMENT_RENDERED_CHAT_FILE_IDS_KEY],
		);
		if (
			existing.metadata?.[GENERATED_DOCUMENT_SOURCE_STATUS_KEY] ===
				"succeeded" ||
			typeof existing.metadata?.sourceChatFileId === "string" ||
			existingRenderedIds.length > 0
		) {
			return existing;
		}
		return (
			(await updateGeneratedDocumentSourceArtifactStatus({
				artifactId: existing.id,
				status: "pending",
			})) ?? existing
		);
	}

	const artifactId = randomUUID();

	return createArtifact({
		id: artifactId,
		userId: input.userId,
		conversationId: input.conversationId,
		type: "generated_output",
		retrievalClass: "ephemeral_followup",
		name: input.title,
		mimeType: "application/vnd.alfyai.generated-document+json",
		extension: "alfyidoc.json",
		contentText: documentText ?? "",
		summary: source.subtitle ?? source.title,
		metadata: {
			generatedDocumentSourceVersion: source.version,
			[GENERATED_DOCUMENT_SOURCE_STATUS_KEY]: "pending",
			generatedDocumentSource: source,
			fileProductionJobId: input.fileProductionJobId,
			originConversationId: input.conversationId,
			originAssistantMessageId: input.assistantMessageId ?? null,
			documentOrigin: "generated",
			documentFamilyId: artifactId,
			documentFamilyStatus: "active",
			documentLabel: source.title,
			documentRole: input.documentIntent ?? null,
			versionNumber: 1,
			template: source.template,
		},
	});
}

export async function attachGeneratedDocumentSourceArtifactToRenderedFiles(input: {
	artifactId: string;
	renderedChatFileIds: string[];
}): Promise<Artifact | null> {
	const renderedChatFileIds = Array.from(
		new Set(input.renderedChatFileIds.map((id) => id.trim()).filter(Boolean)),
	);
	if (renderedChatFileIds.length === 0) {
		return null;
	}

	const [row] = await db
		.select()
		.from(artifacts)
		.where(eq(artifacts.id, input.artifactId))
		.limit(1);
	if (!row) {
		return null;
	}

	const metadata = parseJsonRecord(row.metadataJson ?? null) ?? {};
	const {
		generatedDocumentSourceErrorCode: _previousErrorCode,
		generatedDocumentSourceErrorMessage: _previousErrorMessage,
		...baseMetadata
	} = metadata;
	const existingRenderedIds = readStringArray(
		metadata[GENERATED_DOCUMENT_RENDERED_CHAT_FILE_IDS_KEY],
	);
	const nextRenderedIds = Array.from(
		new Set([...existingRenderedIds, ...renderedChatFileIds]),
	);
	const firstRenderedChatFileId =
		typeof metadata.originalChatFileId === "string" &&
		metadata.originalChatFileId.trim()
			? metadata.originalChatFileId.trim()
			: nextRenderedIds[0];
	const sourceChatFileId =
		typeof metadata.sourceChatFileId === "string" &&
		metadata.sourceChatFileId.trim()
			? metadata.sourceChatFileId.trim()
			: firstRenderedChatFileId;

	const [updated] = await db
		.update(artifacts)
		.set({
			retrievalClass: "durable",
			metadataJson: JSON.stringify({
				...baseMetadata,
				[GENERATED_DOCUMENT_SOURCE_STATUS_KEY]: "succeeded",
				originalChatFileId: firstRenderedChatFileId,
				sourceChatFileId,
				[GENERATED_DOCUMENT_RENDERED_CHAT_FILE_IDS_KEY]: nextRenderedIds,
			}),
			updatedAt: new Date(),
		})
		.where(eq(artifacts.id, input.artifactId))
		.returning();

	return updated ? mapArtifact(updated) : null;
}
