import type {
	NormalChatCompletion,
	NormalChatFinalizationFailure,
} from "$lib/shared/normal-chat-completion";
import type { NormalChatOutputEvent } from "$lib/shared/normal-chat-output";

/** Scoped observe-only truth carried by data-stream-metadata.observation. */
export type NormalChatTurnObservation = {
	version: 1;
	streamId: string;
	conversationId: string;
} & (
	| {
			state: "pending";
			turnId: string;
			segmentId: string;
			/** Absolute working + closing model deadline. */
			deadlineAt?: number;
	  }
	| {
			state: "terminal";
			completion: NormalChatCompletion;
			modelCompletion?: NormalChatCompletion;
			normalChatFinalization?: NormalChatFinalizationFailure;
			assistantMessageId: string | null;
	  }
	| { state: "unavailable" }
);

export const AI_SDK_UI_STREAM_DONE = "[DONE]" as const;

export type AiSdkUiStreamDone = typeof AI_SDK_UI_STREAM_DONE;

export type KnownUiMessageStreamPart =
	| { type: "text-start"; id: string }
	| { type: "text-delta"; id: string; delta?: string; text?: string }
	| { type: "text-end"; id: string }
	| { type: "reasoning-start"; id: string }
	| { type: "reasoning-delta"; id: string; delta?: string; text?: string }
	| { type: "reasoning-end"; id: string }
	| {
			type: `data-${string}`;
			data?: unknown;
			id?: string;
			transient?: boolean;
	  }
	| {
			type: "finish";
			finishReason?:
				| "stop"
				| "error"
				| "length"
				| "content-filter"
				| "tool-calls"
				| "other";
	  }
	| { type: "error"; errorText?: string; error?: string };

export type UiMessageStreamPart = KnownUiMessageStreamPart & {
	[key: string]: unknown;
};

export type AiSdkUiStreamPayload = UiMessageStreamPart | AiSdkUiStreamDone;

export type AiSdkUiStreamFrame =
	| { kind: "done"; rawData: AiSdkUiStreamDone }
	| { kind: "part"; part: UiMessageStreamPart; rawData: string };

export interface AiSdkUiStreamConsumeResult {
	frames: AiSdkUiStreamFrame[];
	remaining: string;
}

export function encodeAiSdkUiStreamPart(part: UiMessageStreamPart): string {
	return `data: ${JSON.stringify(part)}\n\n`;
}

export function encodeAiSdkUiStreamDoneFrame(): string {
	return `data: ${AI_SDK_UI_STREAM_DONE}\n\n`;
}

function findNextAiSdkUiStreamBlockDelimiter(
	value: string,
): { index: number; length: number } | null {
	const delimiters = ["\r\n\r\n", "\n\n", "\r\r"] as const;
	let next: { index: number; length: number } | null = null;

	for (const delimiter of delimiters) {
		const index = value.indexOf(delimiter);
		if (index === -1) {
			continue;
		}
		if (!next || index < next.index) {
			next = { index, length: delimiter.length };
		}
	}

	return next;
}

function decodeAiSdkUiStreamFrameBlock(
	block: string,
): AiSdkUiStreamFrame | null {
	const dataLines: string[] = [];
	let namedEventSeen = false;

	for (const line of block
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.split("\n")) {
		if (!line || line.startsWith(":")) {
			continue;
		}

		const separatorIndex = line.indexOf(":");
		const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
		if (field === "event") {
			namedEventSeen = true;
			continue;
		}
		if (field !== "data") {
			continue;
		}

		let value = separatorIndex === -1 ? "" : line.slice(separatorIndex + 1);
		if (value.startsWith(" ")) {
			value = value.slice(1);
		}
		dataLines.push(value);
	}

	if (namedEventSeen || dataLines.length === 0) {
		return null;
	}

	const rawData = dataLines.join("\n").trim();
	if (rawData === AI_SDK_UI_STREAM_DONE) {
		return { kind: "done", rawData };
	}

	try {
		const parsed = JSON.parse(rawData);
		if (
			!parsed ||
			typeof parsed !== "object" ||
			typeof parsed.type !== "string"
		) {
			return null;
		}
		return {
			kind: "part",
			part: parsed as UiMessageStreamPart,
			rawData,
		};
	} catch {
		return null;
	}
}

export function consumeAiSdkUiStreamFrames(
	value: string,
): AiSdkUiStreamConsumeResult {
	const frames: AiSdkUiStreamFrame[] = [];
	let remaining = value;
	let delimiter = findNextAiSdkUiStreamBlockDelimiter(remaining);

	while (delimiter) {
		const block = remaining.slice(0, delimiter.index);
		remaining = remaining.slice(delimiter.index + delimiter.length);
		const frame = decodeAiSdkUiStreamFrameBlock(block);
		if (frame) {
			frames.push(frame);
		}
		delimiter = findNextAiSdkUiStreamBlockDelimiter(remaining);
	}

	return { frames, remaining };
}

function decodeAiSdkUiStreamFrames(value: string): AiSdkUiStreamFrame[] {
	return consumeAiSdkUiStreamFrames(value).frames;
}

export function decodeAiSdkUiStreamPayloads(
	value: string,
): AiSdkUiStreamPayload[] {
	return decodeAiSdkUiStreamFrames(value).map((frame) =>
		frame.kind === "done" ? AI_SDK_UI_STREAM_DONE : frame.part,
	);
}

function isTerminalAiSdkUiStreamPayload(
	payload: AiSdkUiStreamPayload,
): boolean {
	if (payload === AI_SDK_UI_STREAM_DONE) {
		return true;
	}
	return (
		payload.type === "finish" ||
		payload.type === "data-stream-error" ||
		payload.type === "error"
	);
}

export function containsTerminalAiSdkUiStreamPayload(value: string): boolean {
	return decodeAiSdkUiStreamPayloads(value).some(
		isTerminalAiSdkUiStreamPayload,
	);
}

export function extractAiSdkUiStreamMetadataData(
	payload: AiSdkUiStreamPayload,
): Record<string, unknown> | undefined {
	if (
		payload === AI_SDK_UI_STREAM_DONE ||
		payload.type !== "data-stream-metadata"
	) {
		return undefined;
	}

	const data = payload.data;
	return data && typeof data === "object"
		? (data as Record<string, unknown>)
		: undefined;
}

/** Decode the direct versioned data payload; role policy belongs to the shared reducer. */
export function readNormalChatOutputEvent(
	value: unknown,
): NormalChatOutputEvent | null {
	if (!value || typeof value !== "object") return null;
	const e = value as Record<string, unknown>;
	if (
		e.version !== 1 ||
		!Number.isSafeInteger(e.sequence) ||
		Number(e.sequence) < 0 ||
		![e.turnId, e.segmentId, e.attemptId, e.stepId].every(
			(v) => typeof v === "string",
		) ||
		(e.phase !== "working" && e.phase !== "closing")
	)
		return null;
	const block = typeof e.blockId === "string";
	const finish = e.finishReason === null || typeof e.finishReason === "string";
	switch (e.type) {
		case "step_start":
			break;
		case "block_start":
			if (
				!block ||
				typeof e.nativeId !== "string" ||
				!["text", "reasoning"].includes(String(e.kind)) ||
				!["provisional", "activity", "answer"].includes(String(e.role))
			)
				return null;
			break;
		case "block_delta":
			if (!block || typeof e.text !== "string") return null;
			break;
		case "block_end":
			if (!block) return null;
			break;
		case "step_end":
			if (!finish || typeof e.toolAttempted !== "boolean") return null;
			break;
		case "step_settled":
			if (!finish || (e.role !== "activity" && e.role !== "answer"))
				return null;
			break;
		case "completion": {
			const c = e.completion as Record<string, unknown> | null;
			if (
				!c ||
				c.version !== 1 ||
				c.turnId !== e.turnId ||
				c.segmentId !== e.segmentId ||
				![
					"answered",
					"delivered",
					"paused",
					"stopped",
					"incomplete",
					"failed",
				].includes(String(c.outcome))
			)
				return null;
			break;
		}
		default:
			return null;
	}
	return value as NormalChatOutputEvent;
}

/**
 * One dictionary per connection. The engine's event sequence is monotonic across
 * attempts, so a start sequence is a compact reference, never an implicit scope.
 * We bind and validate the complete identity and fail closed on collisions.
 * Canonical replay starts prime this same dictionary before a compact live tail.
 */
export function createNormalChatWireDecoder() {
	const blocks = new Map<
		number,
		Extract<NormalChatOutputEvent, { type: "block_start" }>
	>();
	let segment: string | undefined;
	const identity = (event: NormalChatOutputEvent) =>
		JSON.stringify([
			event.turnId,
			event.segmentId,
			event.attemptId,
			event.stepId,
			event.phase,
			"blockId" in event ? event.blockId : null,
		]);
	return {
		consume(part: UiMessageStreamPart): NormalChatOutputEvent | null {
			if (part.type === "data-normal-chat-output") {
				const event = readNormalChatOutputEvent(part.data);
				if (!event) return null;
				const nextSegment = JSON.stringify([event.turnId, event.segmentId]);
				if (segment !== nextSegment) {
					blocks.clear();
					segment = nextSegment;
				}
				if (event.type === "block_start") {
					const prior = blocks.get(event.sequence);
					if (prior && identity(prior) !== identity(event))
						throw new Error("output_reference_collision");
					if (!prior && blocks.size >= 10_000)
						throw new Error("output_reference_capacity");
					blocks.set(event.sequence, event);
				} else if (event.type === "block_end") {
					for (const [ref, block] of blocks)
						if (identity(block) === identity(event)) blocks.delete(ref);
				}
				return event;
			}
			if (part.type !== "data-normal-chat-delta") return null;
			const data = part.data as {
				ref?: unknown;
				sequence?: unknown;
				text?: unknown;
			} | null;
			if (
				!data ||
				!Number.isSafeInteger(data.ref) ||
				Number(data.ref) < 0 ||
				!Number.isSafeInteger(data.sequence) ||
				Number(data.sequence) < 0 ||
				typeof data.text !== "string"
			)
				throw new Error("invalid_output_delta");
			const block = blocks.get(Number(data.ref));
			if (!block) throw new Error("unknown_output_reference");
			const { nativeId: _nativeId, kind: _kind, role: _role, ...scope } = block;
			return {
				...scope,
				type: "block_delta",
				sequence: Number(data.sequence),
				text: data.text,
			};
		},
	};
}
