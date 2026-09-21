import type { RejectReasonKey } from "$lib/shared/file-types";
import {
	admitUpload,
	buildAcceptAttribute,
	fileExtension,
	type UploadSurface,
} from "$lib/shared/file-types";

const INTERNAL_CONVERSATION_DRAG_MIME = "application/x-alfyai-conversation";

type DataTransferLike = {
	types?: Iterable<string> | ArrayLike<string> | null;
	files?: { length: number } | null;
};

export function isOsFileDropDataTransfer(
	dataTransfer: DataTransferLike | null | undefined,
): boolean {
	if (!dataTransfer) return false;
	const types = Array.from(dataTransfer.types ?? []);
	if (types.includes(INTERNAL_CONVERSATION_DRAG_MIME)) return false;
	return types.includes("Files") || (dataTransfer.files?.length ?? 0) > 0;
}

export function isOsFileDropEvent(event: DragEvent): boolean {
	return isOsFileDropDataTransfer(event.dataTransfer);
}

/**
 * Why one file did not make it, in the terms the upload endpoints answer with
 * — so a drop can say "Archives can't be opened on upload. Unpack it…" rather
 * than one generic sentence for four different problems.
 */
export interface UploadTypeRefusal {
	readonly name: string;
	/** Uppercased, for the `{ext}` placeholder the messages carry. */
	readonly ext: string;
	readonly reason: RejectReasonKey;
}

export interface PartitionedUploadFiles {
	/** Files with an accepted extension that are at or under the size limit. */
	valid: File[];
	/** Files whose extension is not in the accepted set. */
	rejectedUnsupportedType: File[];
	/** Files with an accepted extension but exceeding the size limit. */
	rejectedTooLarge: File[];
	/**
	 * One row per `rejectedUnsupportedType` entry, same order, naming the
	 * reason. Reported rather than assumed: the caller decides whether a batch
	 * of four different refusals is worth four sentences.
	 */
	refusals: UploadTypeRefusal[];
}

export interface PartitionUploadOptions {
	/**
	 * A comma-separated list like `".pdf,.docx"`, matching the HTML `accept`
	 * attribute. Omit it and the surface's registry-built accept string is
	 * used instead — which is the same string, built from one table.
	 */
	acceptedTypes?: string;
	/** Which upload surface's accept list to default to. Defaults to knowledge. */
	surface?: UploadSurface;
	/**
	 * Entry ids the MinerU-4 gate refuses (`$lib/stores/upload-format-gate`).
	 * Only consulted when `acceptedTypes` is absent, because an accept string
	 * the caller built itself has already had them removed — this is the same
	 * `buildAcceptAttribute(surface, disabled)` the `<input accept>` publishes,
	 * so the picker and the drop can never offer different sets.
	 */
	disabledEntryIds?: ReadonlySet<string>;
	maxFileSizeBytes: number;
}

/**
 * Partition a batch of dropped/selected files into uploadable vs rejected.
 *
 * A file is uploadable when its extension is accepted AND its byte size is at
 * or under `maxFileSizeBytes`.
 *
 * Unsupported-type and oversized files are reported separately so the caller
 * can surface the right message for each rejection reason without re-scanning.
 * The input order is preserved within each bucket.
 */
export function partitionUploadableFiles(
	files: File[],
	options: PartitionUploadOptions,
): PartitionedUploadFiles {
	const acceptedTypes =
		options.acceptedTypes ??
		buildAcceptAttribute(
			options.surface ?? "knowledge",
			options.disabledEntryIds,
		);
	const accepted = new Set(
		acceptedTypes
			.split(",")
			.map((token) => token.trim().replace(/^\./, "").toLowerCase())
			.filter(Boolean),
	);

	const valid: File[] = [];
	const rejectedUnsupportedType: File[] = [];
	const rejectedTooLarge: File[] = [];
	const refusals: UploadTypeRefusal[] = [];

	for (const file of files) {
		const extension = fileExtension(file.name);
		if (!extension || !accepted.has(extension)) {
			rejectedUnsupportedType.push(file);
			refusals.push({
				name: file.name,
				ext: extension.toUpperCase(),
				reason: refusalReason(file),
			});
			continue;
		}
		if (file.size > options.maxFileSizeBytes) {
			rejectedTooLarge.push(file);
			continue;
		}
		valid.push(file);
	}

	return { valid, rejectedUnsupportedType, rejectedTooLarge, refusals };
}

/**
 * The reason the endpoints would give for a file this surface does not offer.
 *
 * `admitUpload` answers for everything the table rejects outright (media,
 * archives, `.ofd`, an unknown type). A file it ADMITS that is still missing
 * from the accept string is one the MinerU-4 gate removed, and the server
 * answers that with the same `formatNotEnabled` — "save it as PDF or DOCX" is
 * exactly the right advice for an `.epub` on a pre-4.x backend.
 */
function refusalReason(file: File): RejectReasonKey {
	const admission = admitUpload(file.name, file.type || null);
	return admission.allowed ? "formatNotEnabled" : admission.reason;
}
