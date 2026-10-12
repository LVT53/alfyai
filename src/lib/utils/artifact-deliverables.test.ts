import { get } from "svelte/store";
import { describe, expect, it } from "vitest";
import { t } from "$lib/i18n";
import { foldArtifactDeliverables } from "./artifact-deliverables";
import { buildToolActivityItem } from "./tool-activity";
import type { ToolCallSegment } from "./tool-evidence-presentation";

const translate = get(t);

function call(overrides: Partial<ToolCallSegment>): ToolCallSegment {
	return {
		type: "tool_call",
		name: "create_artifact",
		input: {},
		status: "done",
		...overrides,
	} as ToolCallSegment;
}

const made = (id: string, title: string, name = "create_artifact") =>
	call({
		name,
		callId: `${name}-${id}-${title}`,
		metadata: {
			ok: true,
			artifactId: id,
			artifactKind: "document",
			artifactTitle: title,
		},
	});

const refusedEdit = (id: string, callId: string) =>
	call({
		name: "edit_artifact",
		callId,
		input: { artifactId: id, patches: [{ op: "replace" }] },
		outputSummary: "One or more patch ops were malformed.",
		metadata: {
			ok: false,
			artifactId: id,
			artifactKind: "document",
			artifactTitle: "Bécsi hétvége",
		},
	});

/** Builds the rows the way a reply does and folds them: `shown` by key, `retried` by call id. */
function fold(segments: ToolCallSegment[]) {
	const entries = segments.map((segment, index) => ({
		segment,
		item: buildToolActivityItem(
			segment,
			segment.callId ?? `call-${index}`,
			translate,
		),
	}));
	const { shown, retried } = foldArtifactDeliverables(entries);
	return {
		shown,
		keys: shown.map((item) => item.key),
		retried: retried.map((segment) => segment.callId),
	};
}

describe("foldArtifactDeliverables", () => {
	it("shows one card for an item the turn made and then changed, as the last call left it", () => {
		const { shown } = fold([
			made("doc-1", "Bécsi hétvége"),
			made("doc-1", "Bécsi hétvége — szombat", "edit_artifact"),
			made("doc-1", "Bécsi hétvége — szombat és vasárnap", "edit_artifact"),
		]);

		expect(shown).toHaveLength(1);
		expect(shown[0].body).toMatchObject({
			kind: "artifact",
			artifactId: "doc-1",
			artifactTitle: "Bécsi hétvége — szombat és vasárnap",
		});
		expect(shown[0].verb).toBe("Edited");
	});

	it("keeps the card where the item first appeared and its key, so nothing re-mounts", () => {
		const first = made("doc-1", "A");
		const { keys, shown } = fold([
			first,
			made("doc-2", "B"),
			made("doc-1", "A, changed", "edit_artifact"),
		]);

		expect(keys).toEqual([first.callId, "create_artifact-doc-2-B"]);
		expect(shown.map((item) => item.object)).toEqual(["A, changed", "B"]);
	});

	it("shows one card per item for several items", () => {
		const { shown } = fold([
			made("doc-1", "A"),
			made("doc-2", "B"),
			made("doc-1", "A", "edit_artifact"),
			made("doc-2", "B", "edit_artifact"),
		]);

		expect(shown.map((item) => item.body)).toEqual([
			expect.objectContaining({ artifactId: "doc-1" }),
			expect.objectContaining({ artifactId: "doc-2" }),
		]);
	});

	it("leaves out an attempt that failed and was then made good, and hands it back for the rail", () => {
		const { shown, retried } = fold([
			made("doc-1", "Bécsi hétvége"),
			refusedEdit("doc-1", "bad-1"),
			refusedEdit("doc-1", "bad-2"),
			made("doc-1", "Bécsi hétvége", "edit_artifact"),
		]);

		expect(shown).toHaveLength(1);
		expect(shown[0].artifact).toEqual({ id: "doc-1", failed: false });
		expect(retried).toEqual(["bad-1", "bad-2"]);
	});

	it("shows what the turn ended on: the card, and one row for the last failure", () => {
		const { shown, retried } = fold([
			made("doc-1", "Bécsi hétvége"),
			refusedEdit("doc-1", "bad-1"),
			refusedEdit("doc-1", "bad-2"),
		]);

		expect(shown).toHaveLength(2);
		expect(shown[0].body?.kind).toBe("artifact");
		expect(shown[1]).toMatchObject({
			key: "bad-2",
			status: "failed",
			verb: "Couldn't edit:",
			object: "Bécsi hétvége",
		});
		expect(retried).toEqual(["bad-1"]);
	});

	it("shows a failure on an item the turn never made a card of", () => {
		const { shown, retried } = fold([refusedEdit("doc-9", "bad-1")]);

		expect(shown.map((item) => item.key)).toEqual(["bad-1"]);
		expect(retried).toEqual([]);
	});

	it("keeps failures of different items apart", () => {
		const { shown } = fold([
			refusedEdit("doc-1", "bad-1"),
			refusedEdit("doc-2", "bad-2"),
		]);

		expect(shown.map((item) => item.key)).toEqual(["bad-1", "bad-2"]);
	});

	it("passes through what is not a card or a failed attempt of an item", () => {
		const running = call({
			name: "edit_artifact",
			callId: "running",
			input: { artifactId: "doc-1" },
			status: "running",
		});
		const refusedCreate = call({
			name: "create_artifact",
			callId: "refused-create",
			input: { artifactType: "app", title: "Tip splitter" },
			outputSummary: "The brief was empty.",
			metadata: { ok: false, artifactKind: "app" },
		});
		const { keys, retried } = fold([
			made("doc-1", "A"),
			running,
			refusedCreate,
		]);

		expect(keys).toEqual([
			"create_artifact-doc-1-A",
			"running",
			"refused-create",
		]);
		expect(retried).toEqual([]);
	});

	it("changes nothing for a turn with a single call", () => {
		const { shown } = fold([made("doc-1", "A")]);

		expect(shown).toHaveLength(1);
		expect(shown[0].key).toBe("create_artifact-doc-1-A");
	});
});
