/**
 * The Canvas's serializer (Feature 2 · Artifacts, Slice 3), registered against
 * Slice 0's `ArtifactSerializer` registry beside `file` and `document`.
 *
 * A board is stored as its canonical JSON (`boardJson`, ruling 12) and its
 * `body_hash` is the family's one hasher over exactly that string — computed on
 * the canonical form, never on whatever the client sent, so a mere open cannot
 * change a hash and a later diff is not refused as a conflict. The caps are
 * refusals, not silent truncation: a board that will not fit is told so.
 *
 * The canonicaliser and the never-throwing reader are the shared modules
 * (`$lib/shared/artifacts/canvas-body`), because the browser compares with the
 * same one; this file is the server's half — the hash, the caps and the
 * registry entry.
 */
import type { CanvasBody } from "$lib/shared/artifacts/canvas";
import {
	boardJson,
	type CanvasDropReport,
	MAX_BODY_BYTES,
	MAX_NODES_PER_BOARD,
	normalizeCanvasBody,
} from "$lib/shared/artifacts/canvas-body";
import { hashArtifactBody } from "../hash";
import type { ArtifactSerializer } from "./index";

export { MAX_BODY_BYTES, MAX_NODES_PER_BOARD };

/** sha256 hex of the canonical JSON: the family's one body hasher (`hash.ts`), never a second one. */
export function canvasBodyHash(canonicalJson: string): string {
	return hashArtifactBody(canonicalJson);
}

export type CanvasBoardRefusal =
	| "invalid_body"
	| "too_many_nodes"
	| "too_large";

/** A hostile or accidental multi-megabyte payload is refused before it is parsed. */
const MAX_RAW_BYTES = MAX_BODY_BYTES * 4;

function parseBoardJson(
	stored: string,
): { body: CanvasBody; dropped: CanvasDropReport } | null {
	let raw: unknown;
	try {
		raw = JSON.parse(stored);
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return null;
	}
	return normalizeCanvasBody(raw);
}

/**
 * What a board sent by a client becomes before it is stored: read without
 * trust, refused past its caps, written canonically, hashed as written. The one
 * function a save goes through, so no writer can store a board this did not
 * see; `dropped` says what was left out, because a save that quietly loses a
 * block is worse than one that says so.
 */
export function prepareCanvasBoard(raw: string):
	| {
			ok: true;
			body: CanvasBody;
			json: string;
			hash: string;
			dropped: CanvasDropReport;
	  }
	| { ok: false; reason: CanvasBoardRefusal } {
	if (Buffer.byteLength(raw, "utf8") > MAX_RAW_BYTES) {
		return { ok: false, reason: "too_large" };
	}
	const parsed = parseBoardJson(raw);
	if (!parsed) return { ok: false, reason: "invalid_body" };
	if (parsed.body.nodes.length > MAX_NODES_PER_BOARD) {
		return { ok: false, reason: "too_many_nodes" };
	}
	const json = boardJson(parsed.body);
	if (Buffer.byteLength(json, "utf8") > MAX_BODY_BYTES) {
		return { ok: false, reason: "too_large" };
	}
	return {
		ok: true,
		body: parsed.body,
		json,
		hash: canvasBodyHash(json),
		dropped: parsed.dropped,
	};
}

export const canvasSerializer: ArtifactSerializer<CanvasBody> = {
	kind: "canvas",
	serialize: boardJson,
	parse: (stored) => parseBoardJson(stored)?.body ?? null,
};
