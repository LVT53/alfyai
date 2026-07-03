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

export interface PartitionedUploadFiles {
	/** Files with an accepted extension that are at or under the size limit. */
	valid: File[];
	/** Files whose extension is not in the accepted set. */
	rejectedUnsupportedType: File[];
	/** Files with an accepted extension but exceeding the size limit. */
	rejectedTooLarge: File[];
}

function getFileExtension(filename: string): string {
	const dotIndex = filename.lastIndexOf(".");
	if (dotIndex < 0) return "";
	return filename.slice(dotIndex + 1).toLowerCase();
}

/**
 * Partition a batch of dropped/selected files into uploadable vs rejected.
 *
 * A file is uploadable when its extension is in `acceptedTypes` (a
 * comma-separated list like `".pdf,.docx"`, matching the HTML `accept`
 * attribute) AND its byte size is at or under `maxFileSizeBytes`.
 *
 * Unsupported-type and oversized files are reported separately so the caller
 * can surface the right message for each rejection reason without re-scanning.
 * The input order is preserved within each bucket.
 */
export function partitionUploadableFiles(
	files: File[],
	options: { acceptedTypes: string; maxFileSizeBytes: number },
): PartitionedUploadFiles {
	const accepted = new Set(
		options.acceptedTypes
			.split(",")
			.map((token) => token.trim().replace(/^\./, "").toLowerCase())
			.filter(Boolean),
	);

	const valid: File[] = [];
	const rejectedUnsupportedType: File[] = [];
	const rejectedTooLarge: File[] = [];

	for (const file of files) {
		const extension = getFileExtension(file.name);
		if (!extension || !accepted.has(extension)) {
			rejectedUnsupportedType.push(file);
			continue;
		}
		if (file.size > options.maxFileSizeBytes) {
			rejectedTooLarge.push(file);
			continue;
		}
		valid.push(file);
	}

	return { valid, rejectedUnsupportedType, rejectedTooLarge };
}
