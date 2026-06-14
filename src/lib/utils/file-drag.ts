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
