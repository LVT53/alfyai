import { describe, expect, it } from "vitest";
import type { ToolCallEntry } from "$lib/server/services/messages-types";
import {
	artifactCallOf,
	artifactCallsFromSegments,
	artifactVersionMessagesFromMessages,
	markRegenerable,
} from "./artifact-calls";

describe("markRegenerable", () => {
	const rows = [
		{ id: "doc-1", title: "One" },
		{ id: "doc-2", title: "Two", regenerable: true as const },
		{ id: "doc-3", title: "Three" },
	];

	it("marks exactly the rows whose ids are given, and leaves the others as they were", () => {
		const marked = markRegenerable(rows, new Set(["doc-3", "not-a-row"]));
		expect(marked).toEqual([
			{ id: "doc-1", title: "One" },
			{ id: "doc-2", title: "Two", regenerable: true },
			{ id: "doc-3", title: "Three", regenerable: true },
		]);
		// The row it did not mark is the very object it was given.
		expect(marked[0]).toBe(rows[0]);
	});

	it("hands back the same array when nothing needs marking, so a caller's dependents see nothing new", () => {
		expect(markRegenerable(rows, new Set())).toBe(rows);
		// An id that names a row already marked is nothing to do either.
		expect(markRegenerable(rows, new Set(["doc-2"]))).toBe(rows);
	});
});

describe("artifactCallOf", () => {
	const created: ToolCallEntry = {
		callId: "call-1",
		name: "create_artifact",
		input: { artifactType: "document", title: "Weekend plan" },
		status: "done",
		metadata: {
			ok: true,
			artifactId: "doc-1",
			artifactKind: "document",
			artifactTitle: "Weekend plan",
		},
	};

	it("names the item a finished create_artifact or edit_artifact call made or changed", () => {
		expect(artifactCallOf(created)).toEqual({
			name: "create_artifact",
			artifactId: "doc-1",
			input: created.input,
		});
		expect(
			artifactCallOf({ ...created, name: "edit_artifact" })?.artifactId,
		).toBe("doc-1");
	});

	it("names nothing for a refused or failed call, a call with no id, or any other tool", () => {
		const refused = {
			...created,
			metadata: { ok: false, artifactId: "doc-1", artifactKind: "document" },
		};
		expect(artifactCallOf(refused)).toBeNull();
		expect(artifactCallOf({ ...created, status: "failed" })).toBeNull();
		expect(artifactCallOf({ ...created, metadata: { ok: true } })).toBeNull();
		expect(
			artifactCallOf({ ...created, metadata: { ok: true, artifactId: "" } }),
		).toBeNull();
		expect(artifactCallOf({ ...created, name: "read_artifact" })).toBeNull();
		expect(artifactCallOf({ ...created, name: "produce_file" })).toBeNull();
	});

	it("reads a stored thinking segment the way it reads a live tool-call entry", () => {
		const segmentCalls = artifactCallsFromSegments([
			{ type: "text", content: "Making it now." },
			{ type: "tool_call", ...created },
			{ type: "tool_call", ...created, status: "failed" },
		]);
		expect(segmentCalls).toEqual([artifactCallOf(created)]);
	});
});

// Ruling 76: "From the chat" on an Alfy moment scrolls to the message whose tool
// call made that version. The call's own record names the version it made.
describe("artifactVersionMessagesFromMessages", () => {
	const call = (
		name: "create_artifact" | "edit_artifact",
		artifactId: string,
		versionId: string | undefined,
		status: "done" | "failed" = "done",
	): ToolCallEntry => ({
		callId: `call-${artifactId}-${versionId}`,
		name,
		input: {},
		status,
		metadata: {
			ok: true,
			artifactId,
			artifactKind: "document",
			...(versionId === undefined ? {} : { versionId }),
		},
	});
	const message = (id: string, calls: ToolCallEntry[]) => ({
		id,
		thinkingSegments: calls.map((entry) => ({
			type: "tool_call" as const,
			...entry,
		})),
	});

	it("maps each artifact's versions to the message that made them", () => {
		const map = artifactVersionMessagesFromMessages([
			message("m1", [call("create_artifact", "doc-1", "v1")]),
			message("m2", [
				call("edit_artifact", "doc-1", "v2"),
				call("edit_artifact", "doc-2", "w2"),
			]),
		] as never);
		expect(map.get("doc-1")?.get("v1")).toBe("m1");
		expect(map.get("doc-1")?.get("v2")).toBe("m2");
		expect(map.get("doc-2")?.get("w2")).toBe("m2");
	});

	it("leaves out a call that names no version (an older record), a refused one and a message with no calls", () => {
		const map = artifactVersionMessagesFromMessages([
			message("m1", [call("edit_artifact", "doc-1", undefined)]),
			message("m2", [call("edit_artifact", "doc-1", "v3", "failed")]),
			message("m3", []),
		] as never);
		expect(map.size).toBe(0);
	});
});
