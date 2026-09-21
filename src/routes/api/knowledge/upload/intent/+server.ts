import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { createAttachmentTraceId } from "$lib/server/services/attachment-trace";
// Imported from the config module rather than the extraction façade on
// purpose: the façade statically re-exports the read model, and a handshake
// endpoint that touches no rows should not open the ledger to ask what a
// number is.
import { getExtractionConfig } from "$lib/server/services/extraction/config";
import {
	getUploadFormatGate,
	resolveEffectiveIntakeRoute,
} from "$lib/server/services/knowledge/format-availability";
import {
	isKnowledgeUploadConversationError,
	resolveKnowledgeUploadLimits,
	validateKnowledgeUploadConversation,
} from "$lib/server/services/knowledge/upload-intake";
import {
	formatUploadRejectMessageEn,
	UPLOAD_REJECT_I18N_KEYS,
	UPLOAD_UNSUPPORTED_TYPE_CODE,
} from "$lib/server/services/knowledge/upload-signature";
import { admitUpload, fileExtension } from "$lib/shared/file-types";
import type { RequestHandler } from "./$types";

function formatBytes(value: number | null): string {
	if (value === null || !Number.isFinite(value)) return "unlimited";
	const mb = value / (1024 * 1024);
	return `${Number.isInteger(mb) ? mb : mb.toFixed(1)}MB`;
}

function parseUploadIntent(value: unknown): {
	fileName: string | null;
	fileSize: number | null;
	mimeType: string | null;
	conversationId: string | null;
} {
	const input =
		typeof value === "object" && value !== null
			? (value as Record<string, unknown>)
			: {};
	const fileName =
		typeof input.fileName === "string" && input.fileName.trim()
			? input.fileName.trim().slice(0, 240)
			: null;
	const fileSize =
		typeof input.fileSize === "number" &&
		Number.isFinite(input.fileSize) &&
		input.fileSize >= 0
			? Math.floor(input.fileSize)
			: null;
	const mimeType =
		typeof input.mimeType === "string" && input.mimeType.trim()
			? input.mimeType.trim().slice(0, 120)
			: null;
	const conversationId =
		typeof input.conversationId === "string" && input.conversationId.trim()
			? input.conversationId.trim().slice(0, 120)
			: null;
	return { fileName, fileSize, mimeType, conversationId };
}

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	const traceId = createAttachmentTraceId("upload");
	const limits = resolveKnowledgeUploadLimits();
	const requestBodyLimit = limits.multipartBodyLimit;
	const rawUploadLimit = limits.storedFileLimit;
	const chunkBodyLimit = limits.chunkBodyLimit;

	let payload: unknown;
	try {
		payload = await event.request.json();
	} catch {
		return json({ error: "Invalid upload intent payload" }, { status: 400 });
	}

	const intent = parseUploadIntent(payload);
	console.info("[KNOWLEDGE] Upload intent received", {
		traceId,
		userId: user.id,
		fileName: intent.fileName,
		fileSize: intent.fileSize,
		mimeType: intent.mimeType,
		conversationId: intent.conversationId,
		maxFileUploadSize: limits.maxFileUploadSize,
		adapterBodySizeLimit: limits.adapterBodySizeLimit,
		requestBodyLimit,
		rawUploadLimit,
		chunkBodyLimit,
	});

	if (intent.fileSize === null) {
		return json(
			{
				error: "Upload size is required before sending the file.",
				code: "upload_size_required",
				traceId,
			},
			{ status: 400 },
		);
	}

	if (intent.fileSize > limits.maxFileUploadSize) {
		return json(
			{
				error: `File too large. Maximum size is ${formatBytes(limits.maxFileUploadSize)}.`,
				code: "upload_file_too_large",
				errorKey: "knowledge.uploadFileTooLarge",
				traceId,
				details: {
					fileName: intent.fileName,
					fileSize: intent.fileSize,
					maxFileUploadSize: limits.maxFileUploadSize,
				},
			},
			{ status: 413 },
		);
	}

	// The type allowlist. Deliberately AFTER the two size checks: an oversized
	// file with no usable name must still answer 413, not 415
	// (`upload-intent.test.ts`), and a file the server will never read is worth
	// refusing before a conversation lookup.
	const admission = admitUpload(intent.fileName ?? "", intent.mimeType);
	if (!admission.allowed) {
		const extension = fileExtension(intent.fileName ?? "") || null;
		console.info("[KNOWLEDGE] Upload intent refused an unsupported type", {
			traceId,
			userId: user.id,
			fileName: intent.fileName,
			mimeType: intent.mimeType,
			extension,
			reason: admission.reason,
		});
		return json(
			{
				error: formatUploadRejectMessageEn(admission.reason, {
					fileName: intent.fileName,
					extension,
				}),
				code: UPLOAD_UNSUPPORTED_TYPE_CODE,
				errorKey: UPLOAD_REJECT_I18N_KEYS[admission.reason],
				traceId,
				details: {
					fileName: intent.fileName,
					extension,
					reason: admission.reason,
				},
			},
			{ status: 415 },
		);
	}

	// The MinerU-4 availability gate (phase5-6 spec §3.5). Never a network call
	// on this hot path — `getUploadFormatGate` reads the capabilities module's
	// own cache and fails open when it is cold or the probe errored.
	const gate = await getUploadFormatGate();
	if (admission.entry && gate.disabledEntryIds.has(admission.entry.id)) {
		const extension = fileExtension(intent.fileName ?? "") || null;
		console.info("[KNOWLEDGE] Upload intent refused a MinerU-4-gated type", {
			traceId,
			userId: user.id,
			fileName: intent.fileName,
			mimeType: intent.mimeType,
			extension,
			backendVersion: gate.backendVersion,
		});
		return json(
			{
				// Identical envelope to the admitUpload refusal above: same 415,
				// same code, same errorKey. A gated format on an old backend is
				// indistinguishable from a not-yet-enabled one, which is exactly
				// what it is.
				error: formatUploadRejectMessageEn("formatNotEnabled", {
					fileName: intent.fileName,
					extension,
				}),
				code: UPLOAD_UNSUPPORTED_TYPE_CODE,
				errorKey: UPLOAD_REJECT_I18N_KEYS.formatNotEnabled,
				traceId,
				details: {
					fileName: intent.fileName,
					extension,
					reason: "formatNotEnabled",
				},
			},
			{ status: 415 },
		);
	}

	// Bug B5. A `direct-text` file is read whole into memory, chunked and
	// embedded, so a 100 MB `.log` is thousands of chunk rows and as many
	// embedding calls from a single upload. Refuse it here, before any byte
	// moves; `directTextExtractor` enforces the same cap again for the raw and
	// chunk routes, which never call this handshake.
	//
	// The route consulted is the EFFECTIVE one: on a gate-closed pre-4 backend,
	// `html`/`htm` fall back to `direct-text` (§3.2.4) and the cap applies to
	// them again exactly as it did before Phase 5.
	const directTextCap = getExtractionConfig().maxDirectTextBytes;
	if (
		resolveEffectiveIntakeRoute(
			intent.fileName ?? "",
			intent.mimeType,
			gate,
		) === "direct-text" &&
		intent.fileSize > directTextCap
	) {
		console.info("[KNOWLEDGE] Upload intent refused an oversized text file", {
			traceId,
			userId: user.id,
			fileName: intent.fileName,
			fileSize: intent.fileSize,
			maxBytes: directTextCap,
		});
		return json(
			{
				error: `Text files are limited to ${formatBytes(directTextCap)}. Split the file or upload it as a document.`,
				code: "upload_direct_text_too_large",
				errorKey: "knowledge.uploadDirectTextTooLarge",
				traceId,
				details: {
					fileName: intent.fileName,
					fileSize: intent.fileSize,
					maxBytes: directTextCap,
				},
			},
			{ status: 413 },
		);
	}

	try {
		await validateKnowledgeUploadConversation({
			userId: user.id,
			conversationId: intent.conversationId,
		});
	} catch (error) {
		if (isKnowledgeUploadConversationError(error)) {
			return json(
				{
					error: "Conversation not found or access denied",
					code: "conversation_not_found",
					traceId,
				},
				{ status: 400 },
			);
		}
		throw error;
	}

	return json({
		traceId,
		maxFileUploadSize: limits.maxFileUploadSize,
		adapterBodySizeLimit: limits.adapterBodySizeLimit,
		requestBodyLimit,
		rawUploadLimit,
		chunkBodyLimit,
		// Authoritative, and lands before any other upload on the page: the
		// client republishes this into `$disabledFileTypeIds`
		// (`$lib/client/api/knowledge.ts`) next to `maxFileUploadSize`, so the
		// picker's accept string and drag-drop partitioning reflect the live
		// gate even when the SSR shell payload is stale.
		disabledFileTypeIds: [...gate.disabledEntryIds],
	});
};
