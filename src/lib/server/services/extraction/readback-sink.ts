// The slot a generated-file readback result is written through.
//
// Readback does not create a normalized artifact: the generated document already
// has an artifact, and what the extraction produces is its `contentText`. The
// module that owns readback (`readback.ts`, which knows how to patch and re-chunk
// that artifact) registers its sink here, once, when it is imported; the
// extraction handler reads it when a readback job succeeds.
//
// It is a module of its own, and not part of the handler, so that registering
// costs nothing: `readback.ts` is on the boot import path (through `chat-files.ts`)
// and must not pull the extractor registry, the MinerU client and `node:fs` in
// with it. The handler is loaded on the first claim.

export type ReadbackExtractionSink = (input: {
	userId: string;
	conversationId: string | null;
	chatGeneratedFileId: string;
	text: string;
	pageCount: number | null;
	structured?: unknown;
}) => Promise<{ artifactId: string; chunksTruncated?: boolean }>;

let registeredReadbackSink: ReadbackExtractionSink | null = null;

/** Registers the readback sink once per process. Passing null unregisters it. */
export function setGeneratedFileReadbackSink(
	sink: ReadbackExtractionSink | null,
): void {
	registeredReadbackSink = sink;
}

export function getGeneratedFileReadbackSink(): ReadbackExtractionSink | null {
	return registeredReadbackSink;
}
