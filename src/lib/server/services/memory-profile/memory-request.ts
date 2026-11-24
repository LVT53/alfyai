import type { MemoryAction, MemoryRef, MemoryScope } from "$lib/memory-types";
import { isJsonRecord } from "./internal-json";

export class MemoryRequestError extends Error {
	constructor(
		public code: string,
		public status = 400,
	) {
		super(code);
		this.name = "MemoryRequestError";
	}
}
/**
 * The one log line of a Memory read that failed for a reason the person is not
 * told: the error's kind and code only, never its message, which can quote a
 * row's text or a model's (a JSON parse error does). `what` names the read.
 */
export function logMemoryReadFailure(what: string, error: unknown): void {
	const code =
		typeof error === "object" &&
		error !== null &&
		typeof (error as { code?: unknown }).code === "string"
			? (error as { code: string }).code
			: null;
	console.error(`[KNOWLEDGE_MEMORY] ${what} unavailable`, {
		error: error instanceof Error ? error.name : "unknown",
		code,
	});
}
export function parseMemoryScope(value: unknown): MemoryScope {
	if (!isJsonRecord(value)) throw new MemoryRequestError("invalid_scope");
	if (value.kind === "personal") return { kind: "personal" };
	if (
		value.kind === "project" &&
		typeof value.projectId === "string" &&
		value.projectId.length > 0 &&
		value.projectId.length <= 200
	)
		return { kind: "project", projectId: value.projectId };
	throw new MemoryRequestError("invalid_scope");
}
export function parseMemoryRef(value: unknown): MemoryRef {
	if (
		!isJsonRecord(value) ||
		typeof value.generation !== "string" ||
		!value.generation ||
		value.generation.length > 200 ||
		typeof value.rowId !== "string" ||
		!value.rowId ||
		value.rowId.length > 200
	)
		throw new MemoryRequestError("invalid_reference");
	return {
		scope: parseMemoryScope(value.scope),
		generation: value.generation,
		rowId: value.rowId,
	};
}

export function parseMemoryAction(value: unknown): MemoryAction {
	if (
		!isJsonRecord(value) ||
		typeof value.requestId !== "string" ||
		!/^[-0-9a-f]{36}$/i.test(value.requestId)
	)
		throw new MemoryRequestError("invalid_action");
	if (value.kind === "remove")
		return {
			kind: "remove",
			ref: parseMemoryRef(value.ref),
			requestId: value.requestId,
		};
	if (
		(value.kind !== "add" && value.kind !== "edit") ||
		typeof value.text !== "string" ||
		!value.text.trim() ||
		value.text.length > 16000
	)
		throw new MemoryRequestError("invalid_action");
	return value.kind === "add"
		? {
				kind: "add",
				scope: parseMemoryScope(value.scope),
				text: value.text.trim(),
				requestId: value.requestId,
			}
		: {
				kind: "edit",
				ref: parseMemoryRef(value.ref),
				text: value.text.trim(),
				requestId: value.requestId,
			};
}
