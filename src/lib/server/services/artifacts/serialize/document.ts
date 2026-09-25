/**
 * The Document's serializer (Feature 2 · Artifacts, Slice 1), registered
 * against Slice 0's `ArtifactSerializer` registry beside its `file` entry.
 *
 * `DocumentBody.tabs` is structure, not text: it is persisted in
 * `metadata_json.tabs` (through `updateArtifactBody`'s `metadataPatch`), never
 * inside the Markdown a version stores. `serialize` therefore returns exactly
 * `body.markdown` — a version is text (spec §3) — and a caller that needs the
 * tab strip reads it from the artifact's metadata, not from this module.
 */
import { randomUUID } from "node:crypto";
import { parseDocument } from "$lib/shared/artifact-document/blocks";
import { hashArtifactBody } from "../hash";
import type { ArtifactSerializer } from "./index";

export interface DocumentTab {
	id: string;
	title: string;
	/** The first block of this section. Re-pointed on read if the block it once named is gone (Contracts). */
	startBlockId: string;
}

export interface DocumentBody {
	markdown: string;
	tabs: DocumentTab[];
}

/**
 * A brand-new Document: one tab (spec's "Plan, Budget, Packing" strip starts
 * at one section, so a single-tab document hides the strip — T9.3), and text
 * that has already been through `parseDocument` — mint-before-hash applies to
 * a document's very first write, not only to edits.
 */
export function createBody(input: { title: string; markdown?: string }): DocumentBody {
	const parsed = parseDocument(input.markdown ?? "");
	return {
		markdown: parsed.markdown,
		tabs: [
			{
				id: randomUUID(),
				title: input.title,
				startBlockId: parsed.blocks[0]?.id ?? "",
			},
		],
	};
}

/**
 * `stored` is parsed, not trusted: even a string that already looks fully
 * marked is run back through `parseDocument` (mint-before-hash again), so a
 * hand-edited or partially-marked row still comes back addressable rather
 * than silently missing ids. `tabs` is always `[]` here — this function has
 * only the stored text, never the artifact's metadata, so a caller that needs
 * the tab strip reads `metadata_json.tabs` itself (`document-ops.ts` does).
 */
export function parse(stored: string): DocumentBody | null {
	if (typeof stored !== "string") return null;
	const parsed = parseDocument(stored);
	return { markdown: parsed.markdown, tabs: [] };
}

/** The stored form: a version is text (spec §3), so the tab strip never enters it. */
export function serialize(body: DocumentBody): string {
	return body.markdown;
}

/** The family's one body hasher (`hash.ts`), never a second one for this kind. */
export function hashBody(body: DocumentBody): string {
	return hashArtifactBody(serialize(body));
}

export const documentSerializer: ArtifactSerializer<DocumentBody> = {
	kind: "document",
	serialize,
	parse,
};
