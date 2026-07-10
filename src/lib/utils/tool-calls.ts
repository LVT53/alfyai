import type { I18nKey } from "$lib/i18n";
import type { ThinkingSegment } from "$lib/types";

const FILE_PRODUCTION_TOOL_IDENTIFIERS = [
	"produce_file",
	"producefile",
	"file_production",
];
const URL_OR_FETCH_TOOL_IDENTIFIERS = ["fetch", "url", "browse"];
// The four connection tools (normal-chat-tools/index.ts) that carry a
// write-proposal action alongside their read actions — "files"/"calendar"/
// "email"/"photos". Deliberately coarse: this can't distinguish a write
// action (e.g. files.save) from a read (files.search) from the tool NAME
// alone, so it over-fires on every completed read too. That mirrors
// isFileProductionToolName's own granularity (fires on every produce_file
// completion) — an extra pending-writes snapshot query on a read-only call
// is a negligible cost next to correctly catching every write.
const CONNECTION_WRITE_TOOL_IDENTIFIERS = [
	"files",
	"calendar",
	"email",
	"photos",
];

// The nine connection tools (normal-chat-tools/index.ts) mapped to a clean,
// user-facing capability label key. Deliberately capability-level (not the
// brand): a single tool can serve more than one provider (e.g. "calendar" is
// Google OR Apple), and the resolved provider isn't known at the point the
// activity label is rendered mid-generation. Turns the previously vague
// "list_events" line into e.g. "Calendar: list events".
const CONNECTION_TOOL_LABEL_KEYS: Record<string, I18nKey> = {
	calendar: "toolCalls.calendar",
	contacts: "toolCalls.contacts",
	email: "toolCalls.email",
	files: "toolCalls.files",
	location: "toolCalls.location",
	media: "toolCalls.media",
	photos: "toolCalls.photos",
	repos: "toolCalls.repos",
	tasks: "toolCalls.tasks",
};

export function getConnectionToolLabelKey(name: string): I18nKey | null {
	return (
		CONNECTION_TOOL_LABEL_KEYS[normalizeToolNameForComparison(name)] ?? null
	);
}

export function isConnectionToolName(name: string): boolean {
	return getConnectionToolLabelKey(name) !== null;
}

// Renders a connection tool's `action` input (e.g. "list_events",
// "check_availability") as a human phrase ("list events", "check
// availability") for the mid-generation activity line.
export function formatConnectionToolAction(action: string): string {
	return action.trim().toLowerCase().replace(/_+/g, " ");
}

function normalizeToolNameForComparison(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_");
}

function normalizeForStableJson(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(normalizeForStableJson);
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, entry]) => [key, normalizeForStableJson(entry)]),
		);
	}
	return value;
}

export function toolCallInputKey(input: Record<string, unknown> = {}): string {
	try {
		return JSON.stringify(normalizeForStableJson(input));
	} catch {
		return "";
	}
}

function isToolNameMatch(
	normalizedName: string,
	identifiers: readonly string[],
): boolean {
	return identifiers.some((identifier) => normalizedName === identifier);
}

function isToolNameContains(normalizedName: string, fragment: string): boolean {
	return normalizedName.includes(fragment);
}

function isWebSearchToolName(normalizedName: string): boolean {
	return (
		normalizedName === "research_web" ||
		isToolNameContains(normalizedName, "web_search")
	);
}

function isFetchOrBrowseToolName(normalizedName: string): boolean {
	return URL_OR_FETCH_TOOL_IDENTIFIERS.some((identifier) =>
		isToolNameContains(normalizedName, identifier),
	);
}

export function isFileProductionToolName(name: string): boolean {
	const normalized = normalizeToolNameForComparison(name);
	return (
		isToolNameMatch(normalized, FILE_PRODUCTION_TOOL_IDENTIFIERS) ||
		isToolNameContains(normalized, FILE_PRODUCTION_TOOL_IDENTIFIERS[2])
	);
}

export function isConnectionWriteToolName(name: string): boolean {
	const normalized = normalizeToolNameForComparison(name);
	return isToolNameMatch(normalized, CONNECTION_WRITE_TOOL_IDENTIFIERS);
}

export function isVisibleThinkingToolCall(
	segment: ThinkingSegment,
): segment is ThinkingSegment & { type: "tool_call" } {
	return (
		segment.type === "tool_call" && !isFileProductionToolName(segment.name)
	);
}

export function isVisibleThinkingSegment(segment: ThinkingSegment): boolean {
	if (segment.type === "text") {
		return segment.content.trim().length > 0;
	}
	if (segment.type === "status") {
		return segment.label.trim().length > 0;
	}
	return isVisibleThinkingToolCall(segment);
}

export function getHumanReadableToolNameKey(name: string): I18nKey {
	const normalized = normalizeToolNameForComparison(name);
	if (isWebSearchToolName(normalized)) {
		return "toolCalls.webSearch";
	}
	if (normalized === "image_search") {
		return "toolCalls.imageSearch";
	}
	if (normalized === "memory_context") {
		return "toolCalls.memoryLookup";
	}
	if (isFetchOrBrowseToolName(normalized)) {
		return "toolCalls.fetchPage";
	}
	if (isFileProductionToolName(name)) return "toolCalls.createFile";
	const connectionKey = CONNECTION_TOOL_LABEL_KEYS[normalized];
	if (connectionKey) return connectionKey;
	return "toolCalls.generic";
}
