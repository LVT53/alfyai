import { decodeAiSdkUiStreamPayloads } from "$lib/services/ai-sdk-ui-stream-contract";
/** One ordered wire journal. After prefix loss only saved-state recovery is safe. */
export class StreamReplayJournal {
	private chunks: string[] = [];
	private bytes = 0;
	private complete = true;
	append(chunk: string): void {
		if (!this.complete || !decodeAiSdkUiStreamPayloads(chunk).length) return;
		const bytes = Buffer.byteLength(chunk, "utf8");
		if (this.bytes + bytes > 200_000 || this.chunks.length >= 10_000) {
			this.complete = false;
			this.chunks = [];
			this.bytes = 0;
			return;
		}
		this.bytes += bytes;
		this.chunks.push(chunk);
	}
	read(): { complete: boolean; chunks: readonly string[] } {
		return { complete: this.complete, chunks: this.chunks.slice() };
	}
}
