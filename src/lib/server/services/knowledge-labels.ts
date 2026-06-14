import { normalizeWhitespace } from "$lib/server/utils/text";

const PLACEHOLDER_CONVERSATION_TITLES = new Set([
	"new conversation",
	"conversation",
]);

function truncateAtWordBoundary(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	const sliced = value.slice(0, maxLength).trim();
	const lastSpace = sliced.lastIndexOf(" ");
	const base =
		lastSpace >= Math.floor(maxLength * 0.6)
			? sliced.slice(0, lastSpace)
			: sliced;
	return `${base.trim()}...`;
}

export function isPlaceholderConversationTitle(
	title: string | null | undefined,
): boolean {
	const normalized = normalizeWhitespace(title).toLowerCase();
	return !normalized || PLACEHOLDER_CONVERSATION_TITLES.has(normalized);
}

export function deriveConversationArtifactBaseName(params: {
	conversationTitle?: string | null;
	fallbackText?: string | null;
	defaultLabel?: string;
	maxLength?: number;
}): string {
	const defaultLabel = params.defaultLabel ?? "Conversation";
	const maxLength = params.maxLength ?? 56;
	const title = normalizeWhitespace(params.conversationTitle);
	if (!isPlaceholderConversationTitle(title)) {
		return title;
	}

	const fallback = normalizeWhitespace(params.fallbackText);
	if (fallback) {
		return truncateAtWordBoundary(fallback, maxLength);
	}

	return defaultLabel;
}
