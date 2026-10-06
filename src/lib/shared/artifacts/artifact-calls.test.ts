import { describe, expect, it } from "vitest";
import type { ToolCallEntry } from "$lib/server/services/messages-types";
import {
	artifactCallOf,
	artifactCallsFromSegments,
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
