// What a chat turn is doing to an App, for the open panel (F2, ruling 77). An App
// is changed by `edit_artifact` with an `instruction`: the whole App is rebuilt as
// one new Alfy version, which takes tens of seconds. The panel veils the frame the
// way its own "Change this app" does while that runs, and loads the stored App
// when it lands, so the reader sees the new version in the panel they have open.
//
// The shape is `DocumentAlfyActivity` (what `alfyActivity` carries to every body):
// there is no block or op in a rebuild, so it carries none, and `appliedCount` is
// 0 (the chat page's pending pill and the Document's change marks count blocks).
// Only the `instruction` identifies a rebuild: it is the one field no other kind's
// `edit_artifact` call has, so the input says what the call is while it is still
// running, before the server has said what the item is.
import type {
	DocumentAlfyActivity,
	RawAlfyToolCallSegment,
} from "$lib/components/artifacts/document/alfy-activity";

function stringField(
	record: Record<string, unknown> | undefined,
	key: string,
): string | null {
	const value = record?.[key];
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function buildAppRebuildActivity(
	segment: RawAlfyToolCallSegment,
): DocumentAlfyActivity | null {
	if (segment.name !== "edit_artifact") return null;
	if (stringField(segment.input, "instruction") === null) return null;
	const metadata = segment.metadata ?? {};
	const artifactId =
		stringField(segment.input, "artifactId") ??
		(typeof metadata.artifactId === "string" ? metadata.artifactId : null);
	if (!artifactId) return null;

	const base = {
		key: segment.callId ?? `edit_artifact-${artifactId}`,
		artifactId,
		toolName: "edit_artifact" as const,
		label: stringField(segment.input, "summary"),
		patches: [],
		refusedBlocks: [],
		appliedCount: 0,
	};
	if (segment.status === "running") return { ...base, status: "running" };
	if (segment.status === "failed" || metadata.ok === false) {
		return { ...base, status: "failed" };
	}
	return {
		...base,
		status: "applied",
		...(typeof metadata.versionId === "string" && metadata.versionId !== ""
			? { versionId: metadata.versionId }
			: {}),
	};
}
