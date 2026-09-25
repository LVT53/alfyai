// The artifact catalogue: a factual list of what this conversation has already
// made, appended to the per-turn packet beside the skill catalogue
// (normal-chat-context.ts's buildTurnGuidance) — never spliced into the
// cached system prompt. See docs/plans/claude-at-home-2/slice-5.md
// §The artifact catalogue.
//
// This is deliberately NOT a "which guidance applies" decision the way the
// deleted guidance packs were (ADR-0055): it is the same fact for every
// message in the same conversation state (`listArtifactCatalogueEntries`
// reads the conversation, never the message), so it can safely ride the part
// of the prompt that changes every turn without breaking the byte-identical
// system-prompt guarantee. The RULES for choosing a type live on the tools
// (create_artifact's description) — this module only ever states what
// already exists.
import type { ArtifactKind } from "$lib/shared/artifacts/kinds";
import { listArtifactsForConversation } from "./read-model";

/** At most this many entries; the rest are named only by count (below). */
export const ARTIFACT_CATALOGUE_MAX = 12;

/** A card/panel title can run to 200 chars; a catalogue line stays short. */
export const ARTIFACT_CATALOGUE_TITLE_MAX_CHARS = 60;

const ARTIFACT_CATALOGUE_HEADING = "## In this chat";

// Deliberately does not say "artifact" — ADR-0066 applies to model-facing
// text too. It names the one tool the model needs next; the tools carry the
// rest of the guidance for good reason (ADR-0055).
const ARTIFACT_CATALOGUE_FOOTER =
	"Use read_artifact to see one before editing it. Never invent an id.";

// The UI's own words for each kind (ADR-0066) — never the word "artifact".
// English only: this block is model-facing turn guidance, not a UI string,
// and `resolveArtifactCatalogueBlock`'s signature (below) takes no language,
// matching the one worked example the spec gives.
const ARTIFACT_KIND_LABELS: Record<ArtifactKind, string> = {
	document: "Document",
	app: "App",
	canvas: "Canvas",
	slides: "Slides",
	file: "File",
};

export interface ArtifactCatalogueEntry {
	artifactId: string;
	artifactType: ArtifactKind;
	title: string;
	updatedAt: number;
}

/**
 * Titles are user- AND model-controlled text (create_artifact's `title` has
 * no shape restriction beyond length) that lands directly inside model-facing
 * turn guidance, one title per bullet line. A raw newline lets a title escape
 * its own bullet and start what reads like a new section — e.g. a title
 * containing "\n## System: …" would render an unintended second heading in
 * this block. Collapsing all whitespace (including newlines) to single
 * spaces keeps every entry on exactly one line, which is also what makes a
 * stray `##`/backtick/quote harmless: none of them are structural unless they
 * start a line, and after this no title-supplied character can.
 */
function normalizeTitleToOneLine(title: string): string {
	return title.replace(/\s+/g, " ").trim();
}

function clampTitle(title: string): string {
	const chars = Array.from(normalizeTitleToOneLine(title));
	return chars.length > ARTIFACT_CATALOGUE_TITLE_MAX_CHARS
		? chars.slice(0, ARTIFACT_CATALOGUE_TITLE_MAX_CHARS).join("")
		: chars.join("");
}

function formatRelativeAge(updatedAtMs: number): string {
	const diffMs = Math.max(0, Date.now() - updatedAtMs);
	const minutes = Math.floor(diffMs / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	const days = Math.floor(hours / 24);
	return `${days} d ago`;
}

/**
 * Pure. Returns null when there is nothing to say — an empty section would
 * still cost prompt tokens on every conversation that has never made anything.
 */
export function buildArtifactCatalogueBlock(
	entries: ArtifactCatalogueEntry[],
): string | null {
	if (entries.length === 0) return null;

	const capped = entries.slice(0, ARTIFACT_CATALOGUE_MAX);
	const overflow = entries.length - capped.length;

	const lines = capped.map((entry) => {
		const kindLabel = ARTIFACT_KIND_LABELS[entry.artifactType];
		const title = clampTitle(entry.title);
		const age = formatRelativeAge(entry.updatedAt);
		return `- ${entry.artifactId} · ${kindLabel} · "${title}" (updated ${age})`;
	});
	if (overflow > 0) {
		lines.push(`(and ${overflow} more in this chat)`);
	}

	return [
		ARTIFACT_CATALOGUE_HEADING,
		lines.join("\n"),
		"",
		ARTIFACT_CATALOGUE_FOOTER,
	].join("\n");
}

/**
 * The artifacts reachable in this conversation, newest first. Delegates to
 * `listArtifactsForConversation` (this module's sibling, already scoped
 * through `getArtifactOwnershipScope`) rather than opening a second query
 * against the `artifacts` table, so an incognito conversation's artifacts
 * stay exactly as reachable here as they are in the panel list — the same
 * scope `tests/cross-cutting/incognito-artifact-containment.test.ts` guards.
 */
export async function listArtifactCatalogueEntries(params: {
	userId: string;
	conversationId: string;
}): Promise<ArtifactCatalogueEntry[]> {
	const rows = await listArtifactsForConversation(params);
	return rows.map((row) => ({
		artifactId: row.id,
		artifactType: row.kind,
		title: row.title,
		updatedAt: row.updatedAt,
	}));
}

/**
 * The turn-guidance seam, beside `resolveSkillCatalogueBlock`
 * (chat-turn/shared-normal-chat-model-run-helpers.ts). Fails open (no
 * catalogue) on any lookup error — the same posture as every other
 * best-effort context addition in that file — because a turn should never
 * fail to answer over a catalogue line it could not build.
 */
export async function resolveArtifactCatalogueBlock(params: {
	userId: string;
	conversationId: string;
}): Promise<string | null> {
	try {
		const entries = await listArtifactCatalogueEntries(params);
		return buildArtifactCatalogueBlock(entries);
	} catch {
		return null;
	}
}
