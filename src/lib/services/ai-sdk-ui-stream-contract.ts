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

export function findNextAiSdkUiStreamBlockDelimiter(
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

export function decodeAiSdkUiStreamFrameBlock(
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

export function decodeAiSdkUiStreamFrames(value: string): AiSdkUiStreamFrame[] {
	return consumeAiSdkUiStreamFrames(value).frames;
}

export function decodeAiSdkUiStreamPayloads(
	value: string,
): AiSdkUiStreamPayload[] {
	return decodeAiSdkUiStreamFrames(value).map((frame) =>
		frame.kind === "done" ? AI_SDK_UI_STREAM_DONE : frame.part,
	);
}

export function isTerminalAiSdkUiStreamPayload(
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
