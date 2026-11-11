import {
	consumeAiSdkUiStreamFrames,
	encodeAiSdkUiStreamDoneFrame,
	encodeAiSdkUiStreamPart,
	readNormalChatOutputEvent,
	type UiMessageStreamPart,
} from "$lib/services/ai-sdk-ui-stream-contract";

const MAX_BYTES = 200_000;
const MAX_FRAMES = 10_000;
type RetainedFrame = { encode: () => string };

/** Complete compact replay for a fresh consumer; live subscribers receive original deltas. */
export class StreamReplayJournal {
	private frames: RetainedFrame[] = [];
	private bytes = 0;
	private pending = "";
	private complete = true;
	private deltas = new Map<string, { append: (text: string) => void }>();
	private legacyDeltas = new Map<string, { append: (text: string) => void }>();

	private invalidate() {
		this.complete = false;
		this.frames = [];
		this.pending = "";
		this.bytes = 0;
		this.deltas.clear();
		this.legacyDeltas.clear();
	}

	append(chunk: string): void {
		if (!this.complete) return;
		const parsed = consumeAiSdkUiStreamFrames(this.pending + chunk);
		this.pending = parsed.remaining;
		for (const frame of parsed.frames) {
			if (frame.kind === "done") {
				this.frames.push({ encode: encodeAiSdkUiStreamDoneFrame });
				this.bytes += Buffer.byteLength(encodeAiSdkUiStreamDoneFrame());
			} else this.retain(frame.part);
			if (this.bytes > MAX_BYTES || this.frames.length > MAX_FRAMES) {
				this.invalidate();
				return;
			}
		}
		if (this.bytes + Buffer.byteLength(this.pending) > MAX_BYTES)
			this.invalidate();
	}

	private retain(part: UiMessageStreamPart) {
		const event =
			part.type === "data-normal-chat-output"
				? readNormalChatOutputEvent(part.data)
				: null;
		let key: string | undefined;
		let text: string | undefined;
		let append: ((text: string) => void) | undefined;
		let deltas = this.deltas;
		if (event?.type === "block_delta") {
			key = JSON.stringify([
				event.turnId,
				event.segmentId,
				event.attemptId,
				event.stepId,
				event.blockId,
			]);
			text = event.text;
			append = (value) => {
				event.text += value;
			};
		} else if (part.type === "text-delta" || part.type === "reasoning-delta") {
			deltas = this.legacyDeltas;
			const field = typeof part.delta === "string" ? "delta" : "text";
			if (typeof part[field] === "string") {
				key = JSON.stringify([part.type, part.id, field]);
				text = part[field];
				append = (value) => {
					part[field] = String(part[field]) + value;
				};
			}
		} else this.legacyDeltas.clear();
		if (key !== undefined && text !== undefined && append) {
			const prior = deltas.get(key);
			if (prior) {
				prior.append(text);
				// Count only the appended escaped bytes, without rescanning accumulated text.
				this.bytes += Buffer.byteLength(JSON.stringify(text)) - 2;
				return;
			}
			deltas.set(key, { append });
		}
		this.frames.push({ encode: () => encodeAiSdkUiStreamPart(part) });
		this.bytes += Buffer.byteLength(encodeAiSdkUiStreamPart(part));
	}

	read(): { complete: boolean; chunks: readonly string[] } {
		// A partial frame cannot be handed off to a live subscriber mid-frame.
		return {
			complete: this.complete && this.pending.length === 0,
			chunks: this.frames.map((frame) => frame.encode()),
		};
	}
}
