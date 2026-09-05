// Compact digest of a tool's model payload, persisted on the tool-call
// record so later turns can replay the call as a native tool result (see
// chat-turn/conversation-history.ts). Bounded, content-only, never shown to
// the user.

export const TOOL_RESULT_DIGEST_MAX_CHARS = 1_500;
const MAX_ITEM_LINES = 5;
const ITEM_LINE_MAX_CHARS = 160;
const PREFERRED_TEXT_KEYS = [
	"answerBriefMarkdown",
	"content",
	"summary",
	"message",
] as const;
const ITEM_LABEL_KEYS = [
	"title",
	"name",
	"subject",
	"summary",
	"label",
	"filename",
	"path",
] as const;

function firstString(
	record: Record<string, unknown>,
	keys: readonly string[],
): string | null {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return null;
}

function describeItem(item: unknown): string | null {
	if (typeof item === "string") return item.trim() || null;
	if (!item || typeof item !== "object") return null;
	const record = item as Record<string, unknown>;
	const label = firstString(record, ITEM_LABEL_KEYS);
	if (!label) return null;
	const url = typeof record.url === "string" ? record.url.trim() : "";
	return `${label}${url ? ` <${url}>` : ""}`;
}

function clip(text: string, max: number): string {
	const collapsed = text.replace(/[ \t]+\n/g, "\n").trim();
	return collapsed.length <= max
		? collapsed
		: `${collapsed.slice(0, max - 1)}…`;
}

export function deriveToolResultDigest(payload: unknown): string | null {
	if (!payload || typeof payload !== "object") return null;
	const record = payload as Record<string, unknown>;
	const parts: string[] = [];
	const text = firstString(record, PREFERRED_TEXT_KEYS);
	if (text) parts.push(text);

	// First array of objects/strings in the payload, rendered as short lines.
	for (const [key, value] of Object.entries(record)) {
		if (!Array.isArray(value) || value.length === 0) continue;
		if (key === "sources" || key === "evidence" || key === "candidates") {
			// Sources are carried separately as candidates on the record.
			continue;
		}
		const lines = value
			.slice(0, MAX_ITEM_LINES)
			.map(describeItem)
			.filter((line): line is string => Boolean(line))
			.map((line) => `- ${clip(line, ITEM_LINE_MAX_CHARS)}`);
		if (lines.length > 0) {
			const more = value.length - lines.length;
			parts.push(
				[`${key}:`, ...lines, ...(more > 0 ? [`- … ${more} more`] : [])].join(
					"\n",
				),
			);
			break;
		}
	}

	if (parts.length === 0) return null;
	return clip(parts.join("\n\n"), TOOL_RESULT_DIGEST_MAX_CHARS);
}
