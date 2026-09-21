// How a knowledge upload gets refused: the vocabulary of the type allowlist
// (spec section 4.1) and the completion-time content check (spec section 4.2).
//
// Both gates answer 415 and both are keyed on the shared registry, so they
// live together. Nothing here touches the database or the config store — the
// upload routes mock `upload-intake` wholesale, and a refusal must stay
// testable without it.
//
// The registry owns the signature DATA (`entry.signatures`, with `null` for a
// wildcard byte); this module is only the matcher plus the two call shapes the
// upload routes need. It reads the first `SIGNATURE_WINDOW_BYTES` of the file,
// never the whole thing — an upload may be 100 MB.
//
// Byte comparison follows `file-production/image-loader.ts:55`
// `detectImageMimeType`: index into the buffer and compare, no dependency.
// `file-type`/`mmmagic` are deliberately NOT added; see spec section 4.2.

import { open, unlink } from "node:fs/promises";
import {
	FILE_TYPE_ENTRIES,
	type FileTypeEntry,
	fileExtension,
	type RejectReasonKey,
	resolveEntry,
} from "$lib/shared/file-types";

/**
 * The one machine code every type refusal carries; `details.reason`
 * discriminates between the four reasons (spec section 4.1).
 */
export const UPLOAD_UNSUPPORTED_TYPE_CODE = "upload_unsupported_type" as const;

/**
 * English fallback text for a type refusal, word for word the EN half of the
 * `knowledge.uploadRejected*` / `knowledge.uploadUnsupportedType` family in
 * `src/lib/i18n/knowledge.ts` — placeholders included, so the two cannot
 * drift. The endpoint is not locale-aware: the client renders `$t(errorKey)`
 * when it has one and falls back to this string.
 *
 * Phase 5 P5-B reject-copy audit: `unknownType` is re-frozen to match
 * `knowledge.uploadUnsupportedType` byte for byte, after P5-C's reject-copy
 * pass gave every refusal a next thing to try. The other three were already
 * identical.
 */
export const UPLOAD_REJECT_MESSAGES_EN: Readonly<
	Record<RejectReasonKey, string>
> = {
	unknownType:
		"We can't read {name} — that file type isn't supported. Save it as PDF, DOCX or plain text and upload that.",
	media:
		"Audio and video files can't be read yet. Upload a document or an image instead.",
	archive:
		"Archives can't be opened on upload. Unpack it and upload the files inside.",
	formatNotEnabled:
		"{ext} files aren't supported yet. Save it as PDF or DOCX and upload that.",
	convertImage:
		"{ext} images can't be read yet. Save it as PNG or JPG and upload that.",
};

export const UPLOAD_REJECT_I18N_KEYS: Readonly<
	Record<RejectReasonKey, string>
> = {
	unknownType: "knowledge.uploadUnsupportedType",
	media: "knowledge.uploadRejectedMedia",
	archive: "knowledge.uploadRejectedArchive",
	formatNotEnabled: "knowledge.uploadRejectedFormatNotEnabled",
	convertImage: "knowledge.uploadRejectedConvertImage",
};

/** Fills `{name}` / `{ext}` the way `$t` does on the client. */
export function formatUploadRejectMessageEn(
	reason: RejectReasonKey,
	params: { fileName: string | null; extension: string | null },
): string {
	return UPLOAD_REJECT_MESSAGES_EN[reason]
		.replaceAll("{name}", params.fileName ?? "that file")
		.replaceAll("{ext}", params.extension?.toUpperCase() ?? "These");
}

/**
 * How many leading bytes the check reads. Derived from the table rather than
 * hardcoded, so a new signature cannot land outside the window a reader looks
 * at: today `pdf`'s 1024-byte search dominates, where every other entry needs
 * at most 16 (`heic`/`mp4` read `ftyp` at offset 4; OLE2's 8-byte run is the
 * longest). Never the whole file — an upload may be 100 MB.
 */
export const SIGNATURE_WINDOW_BYTES = Math.max(
	16,
	...FILE_TYPE_ENTRIES.flatMap((entry) =>
		(entry.signatures ?? []).map(
			(signature) =>
				signature.offset +
				(signature.searchWithinBytes ?? 0) +
				signature.bytes.length,
		),
	),
);

export class KnowledgeUploadContentMismatchError extends Error {
	readonly code = "upload_content_mismatch" as const;
	readonly errorKey = "knowledge.uploadContentMismatch" as const;
	readonly status = 415 as const;
	readonly fileName: string;
	readonly extension: string | null;

	constructor(params: { fileName: string; extension: string | null }) {
		super(
			`${params.fileName} does not look like a real ${
				params.extension ?? "file"
			} file — its contents do not match its extension.`,
		);
		this.name = "KnowledgeUploadContentMismatchError";
		this.fileName = params.fileName;
		this.extension = params.extension;
	}
}

export function isKnowledgeUploadContentMismatchError(
	error: unknown,
): error is KnowledgeUploadContentMismatchError {
	return (
		error instanceof KnowledgeUploadContentMismatchError ||
		(typeof error === "object" &&
			error !== null &&
			"name" in error &&
			(error as { name?: unknown }).name ===
				"KnowledgeUploadContentMismatchError")
	);
}

/** True when one declared run sits at `at`. */
function runMatchesAt(
	bytes: readonly (number | null)[],
	head: Buffer,
	at: number,
): boolean {
	for (let index = 0; index < bytes.length; index += 1) {
		const expected = bytes[index];
		// `null` is a wildcard byte (WebP's 4-byte length field).
		if (expected === null) continue;
		if (head[at + index] !== expected) return false;
	}
	return true;
}

/**
 * True when `head` carries one declared run at its declared offset — or, for a
 * signature with `searchWithinBytes`, anywhere in that window past it.
 */
function matchesSignature(entry: FileTypeEntry, head: Buffer): boolean {
	for (const signature of entry.signatures ?? []) {
		const lastStart = signature.offset + (signature.searchWithinBytes ?? 0);
		for (let at = signature.offset; at <= lastStart; at += 1) {
			if (runMatchesAt(signature.bytes, head, at)) return true;
		}
	}
	return false;
}

/**
 * The pure decision. `ok` when the resolved entry declares no signatures —
 * text and code types are never sniffed, because any byte sequence is a legal
 * text file — or when one of them matches.
 */
export function verifyUploadSignature(params: {
	fileName: string;
	mimeType: string | null;
	head: Buffer;
}): { ok: true } | { ok: false; entry: FileTypeEntry } {
	const entry = resolveEntry(params.fileName, params.mimeType);
	if (!entry?.signatures?.length) return { ok: true };
	return matchesSignature(entry, params.head)
		? { ok: true }
		: { ok: false, entry };
}

function mismatchError(fileName: string): KnowledgeUploadContentMismatchError {
	return new KnowledgeUploadContentMismatchError({
		fileName,
		extension: fileExtension(fileName) || null,
	});
}

/**
 * Check a file that is already on disk. On mismatch the temp file is removed
 * before throwing, so a refused upload leaves nothing behind.
 */
export async function assertUploadSignatureForStoredFile(params: {
	fileName: string;
	mimeType: string | null;
	tempPathAbsolute: string;
}): Promise<void> {
	const head = Buffer.alloc(SIGNATURE_WINDOW_BYTES);
	const handle = await open(params.tempPathAbsolute, "r");
	try {
		await handle.read(head, 0, SIGNATURE_WINDOW_BYTES, 0);
	} finally {
		await handle.close().catch(() => undefined);
	}

	const result = verifyUploadSignature({
		fileName: params.fileName,
		mimeType: params.mimeType,
		head,
	});
	if (result.ok) return;

	await unlink(params.tempPathAbsolute).catch(() => undefined);
	throw mismatchError(params.fileName);
}

/**
 * Check a multipart `File` that has not been stored yet. Nothing is written
 * before this runs, so there is nothing to clean up on mismatch.
 */
export async function assertUploadSignatureForFile(file: File): Promise<void> {
	const head = Buffer.from(
		await file.slice(0, SIGNATURE_WINDOW_BYTES).arrayBuffer(),
	);
	const result = verifyUploadSignature({
		fileName: file.name,
		mimeType: file.type || null,
		head,
	});
	if (result.ok) return;
	throw mismatchError(file.name);
}
