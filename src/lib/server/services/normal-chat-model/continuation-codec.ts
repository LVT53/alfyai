import type { NormalChatContinuationSnapshot } from "./completion";

// Every container is tagged, so user/tool objects cannot collide with codec tags.
type Encoded =
	| null
	| string
	| number
	| boolean
	| { tag: "undefined" }
	| { tag: "bytes" | "url" | "date"; value: string }
	| { tag: "array"; value: Encoded[] }
	| { tag: "object"; value: Array<[string, Encoded]> };
function encode(value: unknown): Encoded {
	if (value === undefined) return { tag: "undefined" };
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (value instanceof URL) return { tag: "url", value: value.href };
	if (value instanceof Date) return { tag: "date", value: value.toISOString() };
	if (value instanceof Uint8Array)
		return { tag: "bytes", value: Buffer.from(value).toString("base64") };
	if (value instanceof ArrayBuffer)
		return { tag: "bytes", value: Buffer.from(value).toString("base64") };
	if (Array.isArray(value)) return { tag: "array", value: value.map(encode) };
	if (
		typeof value === "object" &&
		(Object.getPrototypeOf(value) === Object.prototype ||
			Object.getPrototypeOf(value) === null)
	)
		return {
			tag: "object",
			value: Object.entries(value).map(([k, v]) => [k, encode(v)]),
		};
	throw new Error("Unsupported continuation context value");
}
function decode(value: Encoded): unknown {
	if (value === null || typeof value !== "object") return value;
	switch (value.tag) {
		case "undefined":
			return undefined;
		case "bytes":
			return new Uint8Array(Buffer.from(value.value, "base64"));
		case "url":
			return new URL(value.value);
		case "date":
			return new Date(value.value);
		case "array":
			return value.value.map(decode);
		case "object":
			return Object.fromEntries(value.value.map(([k, v]) => [k, decode(v)]));
	}
	throw new Error("Unknown continuation context encoding");
}
export function cloneNormalChatContextValue<T>(value: T): T {
	return decode(encode(value)) as T;
}
export function serializeNormalChatContinuation(
	snapshot: NormalChatContinuationSnapshot,
): string {
	return JSON.stringify({
		version: 1,
		encoding: "normal-chat-context-v1",
		value: encode(snapshot),
	});
}
export function parseNormalChatContinuation(
	serialized: string,
): NormalChatContinuationSnapshot {
	const wire = JSON.parse(serialized);
	if (wire.version !== 1 || wire.encoding !== "normal-chat-context-v1")
		throw new Error("Unsupported continuation snapshot");
	const value = decode(wire.value) as NormalChatContinuationSnapshot;
	if (
		value?.version !== 1 ||
		value.fidelity !== "exact" ||
		typeof value.turnId !== "string" ||
		typeof value.segmentId !== "string" ||
		!Array.isArray(value.steps) ||
		!Array.isArray(value.executions) ||
		!Array.isArray(value.events) ||
		!Array.isArray(value.usage)
	)
		throw new Error("Invalid continuation snapshot");
	return value;
}
