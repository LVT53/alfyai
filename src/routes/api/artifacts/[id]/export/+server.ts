import { randomUUID } from "node:crypto";
import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import {
	buildGeneratedDocumentSource,
	getArtifact,
	sanitizeDocumentFilename,
} from "$lib/server/services/artifacts";
import { submitFileProductionIntake } from "$lib/server/services/file-production";
import { parseDocument } from "$lib/shared/artifact-document/blocks";
import type { RequestHandler } from "./$types";

type ExportFormat = "pdf" | "docx" | "markdown";

function isExportFormat(value: unknown): value is ExportFormat {
	return value === "pdf" || value === "docx" || value === "markdown";
}

/**
 * The document-source output type each format asks the renderers for.
 * Markdown never goes through documentSource (T12.4 — isInlineTextOutputType
 * makes a document_source request for "md" impossible at the schema level;
 * see file-production/output-types.ts, table.ts), so it has its own branch.
 */
const DOCUMENT_SOURCE_OUTPUT_TYPE: Record<"pdf" | "docx", string> = {
	pdf: "pdf",
	docx: "docx",
};

// POST /api/artifacts/[id]/export — { format: "pdf" | "docx" | "markdown" }.
// Produce_file stays the only file-production path (AGENTS.md): this route
// builds the source/inline-text request from the artifact's OWN current
// stored body — never a client-sent one — and hands it to
// submitFileProductionIntake in-process, exactly as
// api/chat/files/produce/+server.ts does. The resulting job is an ordinary
// produced file, so the panel and the File card need nothing export-specific.
export const POST: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const artifactId = event.params.id;
	const conversationId = event.url.searchParams.get("conversationId");

	const payload = (await event.request.json().catch(() => null)) as {
		format?: unknown;
	} | null;
	if (!isExportFormat(payload?.format)) {
		return json({ ok: false, reason: "invalid_format" }, { status: 400 });
	}
	const format = payload.format;

	const artifact = await getArtifact({
		userId: user.id,
		artifactId,
		conversationId,
	});
	if (!artifact || artifact.kind !== "document") {
		return json({ ok: false, reason: "not_found" }, { status: 404 });
	}
	// createArtifact allows conversationId: null (slice-0.md §The boundary);
	// the intake requires one. Unreachable through this slice's own creation
	// paths, which is exactly why it needs its own answer rather than a 500.
	if (!artifact.conversationId) {
		return json({ ok: false, reason: "no_conversation" }, { status: 409 });
	}

	const blocks = parseDocument(artifact.body ?? "", { mint: false }).blocks;
	const filename = sanitizeDocumentFilename(artifact.title);
	const idempotencyKey = randomUUID();

	const body =
		format === "markdown"
			? {
					conversationId: artifact.conversationId,
					idempotencyKey,
					requestTitle: artifact.title,
					sourceMode: "inline_text" as const,
					inlineText: {
						// The stored body already IS canonical Markdown with
						// `<!--b:id-->` markers (spec §3) — strip them; they are
						// addressing, never content (T12.4), the same rule T12.3
						// pins for the document_source path below.
						content: (artifact.body ?? "")
							.split("\n")
							.filter((line) => !line.startsWith("<!--b:"))
							.join("\n")
							.trim(),
						files: [{ filename: `${filename}.md`, outputType: "md" }],
					},
				}
			: {
					conversationId: artifact.conversationId,
					idempotencyKey,
					requestTitle: artifact.title,
					sourceMode: "document_source" as const,
					documentSource: buildGeneratedDocumentSource({
						title: artifact.title,
						blocks,
					}),
					requestedOutputs: [{ type: DOCUMENT_SOURCE_OUTPUT_TYPE[format] }],
				};

	const result = await submitFileProductionIntake({ userId: user.id, body });
	if (!result.ok) {
		return json({ ok: false, reason: result.code }, { status: result.status });
	}
	return json({ ok: true, job: result.job }, { status: result.status });
};
