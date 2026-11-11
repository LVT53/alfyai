import {
	consumeAiSdkUiStreamFrames,
	createNormalChatWireDecoder,
	encodeAiSdkUiStreamDoneFrame,
	encodeAiSdkUiStreamPart,
} from "$lib/services/ai-sdk-ui-stream-contract";
import type { NormalChatOutputEvent } from "$lib/shared/normal-chat-output";
import { streamDataPartEvent, streamNormalChatOutputEvent } from "./stream";

/** Transport adapter; persisted/audit events are owned by the engine. */
export function createOutputEventWriter(
	write: (frame: string) => boolean,
	{ compact = false }: { compact?: boolean } = {},
) {
	let pending:
		| Extract<NormalChatOutputEvent, { type: "block_delta" }>
		| undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let activeKey: string | undefined;
	const refs = new Map<string, number>();
	const blockKey = (event: NormalChatOutputEvent & { blockId: string }) =>
		JSON.stringify([
			event.turnId,
			event.segmentId,
			event.attemptId,
			event.stepId,
			event.blockId,
		]);
	const emit = (event: NormalChatOutputEvent) => {
		const ref =
			event.type === "block_delta" ? refs.get(blockKey(event)) : undefined;
		write(
			compact && event.type === "block_delta" && ref !== undefined
				? streamDataPartEvent("data-normal-chat-delta", {
						ref,
						sequence: event.sequence,
						text: event.text,
					})
				: streamNormalChatOutputEvent(event),
		);
	};
	const flush = () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		if (!pending) return;
		const event = pending;
		pending = undefined;
		emit(event);
	};
	return {
		write(event: NormalChatOutputEvent) {
			if (event.type !== "block_delta") {
				flush();
				activeKey = undefined;
				if (event.type === "block_start")
					refs.set(blockKey(event), event.sequence);
				emit(event);
				if (event.type === "block_end") refs.delete(blockKey(event));
				if (event.type === "completion") refs.clear();
				return;
			}
			const key = blockKey(event);
			if (activeKey !== key) {
				flush();
				activeKey = key;
				emit(event);
				return;
			}
			pending = pending
				? { ...event, text: pending.text + event.text }
				: { ...event };
			if (pending.text.length >= 4096) flush();
			else if (!timer) {
				timer = setTimeout(flush, 25);
				timer.unref?.();
			}
		},
		flush,
	};
}

/** Reconnect subscribers may be an older browser: broadcast canonical frames. */
export function createCanonicalOutputRelay() {
	const decoder = createNormalChatWireDecoder();
	return (chunk: string): string => {
		const { frames, remaining } = consumeAiSdkUiStreamFrames(chunk);
		if (remaining) throw new Error("Output relay requires complete frames");
		if (frames.length === 0) return chunk;
		return frames
			.map((frame) => {
				if (frame.kind === "done") return encodeAiSdkUiStreamDoneFrame();
				const event = decoder.consume(frame.part);
				return encodeAiSdkUiStreamPart(
					frame.part.type === "data-normal-chat-delta" && event
						? { type: "data-normal-chat-output", data: event, transient: true }
						: frame.part,
				);
			})
			.join("");
	};
}
