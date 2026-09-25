/**
 * The five kinds of artifact (ADR-0066). The UI names them Document, App,
 * Canvas, Slides and File — never "artifact" — through `artifacts.type.*`.
 *
 * The union alone, with no runtime imports: the panel, the card and the body
 * registry are browser components, and importing the union from a
 * `$lib/server/services/**` module would pull a server path into the client
 * graph for five strings. Server code imports it through
 * `$lib/server/services/artifacts/types`, which re-exports it.
 *
 * `file` is today's `produce_file` output, read from the existing
 * `generated_output` rows (ruling 18); the other four are `type: "artifact"`
 * rows carrying their kind in `metadata_json.artifactType`.
 */
export type ArtifactKind = "document" | "app" | "canvas" | "slides" | "file";
