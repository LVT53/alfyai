/**
 * The five kinds of artifact (ADR-0066). The UI names them Document, App,
 * Canvas, Slides and File — never "artifact" — through `artifacts.type.*`.
 *
 * The union and the list of kinds that ship, with no imports: the panel, the
 * card and the body registry are browser components, and importing the union
 * from a `$lib/server/services/**` module would pull a server path into the
 * client graph for five strings. Server code imports it through
 * `$lib/server/services/artifacts/types`, which re-exports it.
 *
 * `file` is today's `produce_file` output, read from the existing
 * `generated_output` rows (ruling 18); the other four are `type: "artifact"`
 * rows carrying their kind in `metadata_json.artifactType`.
 */
export type ArtifactKind = "document" | "app" | "canvas" | "slides" | "file";

/**
 * The kinds the artifact tools make that ship — the ONE list of them (ruling
 * 69: Slides is shelved, so three kinds ship until it comes back). What a
 * surface may name, draw or open as an item of the family reads THIS list, not
 * a list that happens to have the same members today: the evidence panel's
 * "Made in this chat" rows (`finalize-steps.ts` writes them, the Sources row
 * draws them) used to ask the tours' list, so a kind that shipped without a
 * tour, or whose tour was shelved, would have lost its rows without a word.
 *
 * File is not on it: it is the produced-file kind (ruling 18), made by
 * `produce_file` and never by `create_artifact` / `edit_artifact`, so no item
 * of the family names it. A kind's tour is a separate fact —
 * `SHIPPED_ARTIFACT_TOUR_TYPES` (`./tours`) is checked against this list, so a
 * tour cannot exist for a kind that does not ship, and a kind may ship with
 * none.
 *
 * Bringing Slides back starts here, in the same commit as Slides itself.
 */
export const SHIPPED_ARTIFACT_KINDS = [
	"document",
	"app",
	"canvas",
] as const satisfies readonly ArtifactKind[];

export type ShippedArtifactKind = (typeof SHIPPED_ARTIFACT_KINDS)[number];

/**
 * Narrows an untyped value (a stamp on a stored tool call or evidence row, a
 * path segment) to a kind that ships. A membership test on the list, never a
 * property lookup on an object: `"toString"` and `"__proto__"` are keys of
 * every object and must not read as kinds.
 */
export function isShippedArtifactKind(
	value: unknown,
): value is ShippedArtifactKind {
	return (
		typeof value === "string" &&
		(SHIPPED_ARTIFACT_KINDS as readonly string[]).includes(value)
	);
}
