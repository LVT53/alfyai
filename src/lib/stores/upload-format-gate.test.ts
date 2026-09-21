import { get } from "svelte/store";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildAcceptAttribute,
	getMineru4GatedFileTypeIds,
} from "$lib/shared/file-types";
import {
	disabledFileTypeIds,
	readShellDisabledFileTypeIds,
	resetDisabledFileTypeIds,
	SHELL_DISABLED_FILE_TYPE_IDS_FIELD,
	setDisabledFileTypeIds,
} from "./upload-format-gate";

afterEach(() => {
	resetDisabledFileTypeIds();
});

describe("upload format gate store", () => {
	it("starts open, which is what an unknown backend means", () => {
		expect([...get(disabledFileTypeIds)]).toEqual([]);
	});

	it("publishes the ids the server named, sorted and deduplicated", () => {
		setDisabledFileTypeIds(["rtf", "epub", "rtf"]);
		expect([...get(disabledFileTypeIds)]).toEqual(["epub", "rtf"]);
	});

	// Fails OPEN (spec OQ9). Every one of these is a payload that could arrive
	// from a half-deployed server or a proxy that mangled the JSON, and not one
	// of them may silently shrink the file picker.
	it.each([
		["undefined", undefined],
		["null", null],
		["a string", "rtf" as unknown as readonly string[]],
		["an object", {} as unknown as readonly string[]],
	])("ignores %s rather than guessing the gate closed", (_label, value) => {
		setDisabledFileTypeIds(["rtf"]);
		setDisabledFileTypeIds(value as readonly string[] | null | undefined);
		expect([...get(disabledFileTypeIds)]).toEqual(["rtf"]);
	});

	it("drops non-string and blank entries from an array it does accept", () => {
		setDisabledFileTypeIds(["rtf", "  ", 42 as unknown as string, " odt "]);
		expect([...get(disabledFileTypeIds)]).toEqual(["odt", "rtf"]);
	});

	it("keeps one Set identity while the answer has not changed", () => {
		setDisabledFileTypeIds(["rtf", "odt"]);
		const first = get(disabledFileTypeIds);
		setDisabledFileTypeIds(["odt", "rtf"]);
		expect(get(disabledFileTypeIds)).toBe(first);
	});

	it("reopens the gate on reset", () => {
		setDisabledFileTypeIds(["rtf"]);
		resetDisabledFileTypeIds();
		expect(get(disabledFileTypeIds).size).toBe(0);
	});
});

describe("readShellDisabledFileTypeIds", () => {
	it("reads the frozen field name off an SSR shell payload", () => {
		expect(
			readShellDisabledFileTypeIds({
				[SHELL_DISABLED_FILE_TYPE_IDS_FIELD]: ["rtf", "epub"],
			}),
		).toEqual(["rtf", "epub"]);
	});

	// P5-B adds the field; this slice ships before it does, and a shell without
	// it must mean "open", not "crash".
	it.each([
		["a shell that predates the field", {}],
		["a null shell", null],
		["a non-object", 7],
		["a non-array field", { [SHELL_DISABLED_FILE_TYPE_IDS_FIELD]: "rtf" }],
	])("answers [] for %s", (_label, shell) => {
		expect(readShellDisabledFileTypeIds(shell)).toEqual([]);
	});
});

describe("the gate and the accept string", () => {
	it("hides exactly the gated formats both pickers offer", () => {
		const open = buildAcceptAttribute("chat");
		setDisabledFileTypeIds([...getMineru4GatedFileTypeIds()]);
		const closed = buildAcceptAttribute("chat", get(disabledFileTypeIds));

		const removed = open
			.split(",")
			.filter((extension) => !closed.split(",").includes(extension));
		expect(removed.sort()).toEqual([".epub", ".odp", ".ods", ".odt", ".rtf"]);
		// HTML is gated too but declares a fallback route, so it stays offered
		// and merely degrades (the amended OQ2).
		expect(closed.split(",")).toContain(".html");
	});
});
