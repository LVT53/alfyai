// What a take was asked to render, as the job row keeps it (`request_json`).
// The tool and the card actions build a TakeRequest; the runner reads it back
// through `parseTakeRequest`, which trusts nothing: a row written by an older
// or a broken release answers null and the take fails cleanly.

import {
	type ImageMark,
	parseImageMarks,
} from "$lib/shared/artifacts/image-body";
import type { CanvasSize } from "./canvas";
import type { GuardMeasures } from "./guards/guard-edit";

/** What `image_jobs.measures_json` holds: the guard's measures plus the chain the next version copies. */
export type StoredTakeMeasures = GuardMeasures & {
	chainSinceAnchor: number;
	anchorIsResult: boolean;
};

export type MadeFrom = "words" | "photo" | "pictures" | "change";

export type TakeInput = {
	fileId: string;
	role: "base" | "reference" | "marked";
	name: string;
};

export type TakeRequest = {
	v: 1;
	mode: "generate" | "edit";
	prompt: string;
	inputs: TakeInput[];
	/** The picture being changed is the person's upload, so a new item starts with it as version 1. */
	baseFromUpload: boolean;
	canvas: CanvasSize;
	transparent: boolean;
	avoidSeeds: number[];
	anchor: { fileId: string; chainSinceAnchor: number } | null;
	marks: ImageMark[] | null;
	title: string;
	summary: string | null;
};

/** Longest a render may take once submitted. A print-size edit measured ~70 s on the real box; this also covers waiting in ComfyUI's queue. Lives here so the kind and its handler share it without importing each other. */
export const IMAGE_RENDER_DEADLINE_MS = 600_000;

const CANVAS_STEP = 32;
/** An abuse guard, not a product limit: a side beyond this is not a picture size. */
const CANVAS_MAX_SIDE = 8192;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSide(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value > 0 &&
		value <= CANVAS_MAX_SIDE &&
		value % CANVAS_STEP === 0
	);
}

function parseInputs(value: unknown): TakeInput[] | null {
	if (!Array.isArray(value)) return null;
	const inputs: TakeInput[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) return null;
		const { fileId, role, name } = entry;
		if (typeof fileId !== "string" || fileId === "") return null;
		if (role !== "base" && role !== "reference" && role !== "marked") {
			return null;
		}
		if (typeof name !== "string") return null;
		inputs.push({ fileId, role, name });
	}
	return inputs;
}

function parseAnchor(value: unknown): TakeRequest["anchor"] | undefined {
	if (value === null) return null;
	if (!isRecord(value)) return undefined;
	const { fileId, chainSinceAnchor } = value;
	if (typeof fileId !== "string" || fileId === "") return undefined;
	if (
		typeof chainSinceAnchor !== "number" ||
		!Number.isInteger(chainSinceAnchor) ||
		chainSinceAnchor < 0
	) {
		return undefined;
	}
	return { fileId, chainSinceAnchor };
}

/** The request a row holds, or null when it cannot stand. Never throws. */
export function parseTakeRequest(json: string): TakeRequest | null {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return null;
	}
	if (!isRecord(value) || value.v !== 1) return null;
	const { mode, prompt, baseFromUpload, canvas, transparent } = value;
	if (mode !== "generate" && mode !== "edit") return null;
	if (typeof prompt !== "string" || prompt.trim() === "") return null;
	if (typeof baseFromUpload !== "boolean") return null;
	if (typeof transparent !== "boolean") return null;
	if (!isRecord(canvas) || !isSide(canvas.width) || !isSide(canvas.height)) {
		return null;
	}
	const inputs = parseInputs(value.inputs);
	if (!inputs) return null;
	if (mode === "generate" && inputs.length > 0) return null;
	if (mode === "edit" && inputs[0]?.role !== "base") return null;
	if (
		!Array.isArray(value.avoidSeeds) ||
		!value.avoidSeeds.every((seed) => Number.isFinite(seed))
	) {
		return null;
	}
	const anchor = parseAnchor(value.anchor);
	if (anchor === undefined) return null;
	const marks = value.marks === null ? null : parseImageMarks(value.marks);
	if (value.marks !== null && marks === null) return null;
	if (typeof value.title !== "string") return null;
	if (value.summary !== null && typeof value.summary !== "string") return null;
	return {
		v: 1,
		mode,
		prompt,
		inputs,
		baseFromUpload,
		canvas: { width: canvas.width, height: canvas.height },
		transparent,
		avoidSeeds: value.avoidSeeds as number[],
		anchor,
		marks,
		title: value.title,
		summary: value.summary as string | null,
	};
}

/** The prompt id a take's checkpoint holds, or null. Shared by the kind (Stop) and the handler (resume). */
export function promptIdOf(checkpoint: string | null): string | null {
	if (!checkpoint) return null;
	try {
		const parsed: unknown = JSON.parse(checkpoint);
		if (typeof parsed === "object" && parsed !== null && "promptId" in parsed) {
			const id = (parsed as { promptId: unknown }).promptId;
			return typeof id === "string" && id !== "" ? id : null;
		}
	} catch {
		// A checkpoint we cannot read is no checkpoint.
	}
	return null;
}
