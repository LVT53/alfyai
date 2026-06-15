import type { I18nKey } from "$lib/i18n";
import type { ThinkingSegment } from "$lib/types";

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

export function isFileProductionToolName(name: string): boolean {
	const normalized = normalizeToolNameForComparison(name);
	return (
		normalized === "produce_file" ||
		normalized === "producefile" ||
		normalized.includes("file_production")
	);
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
	if (normalized === "research_web" || normalized.includes("web_search")) {
		return "toolCalls.webSearch";
	}
	if (normalized === "image_search") return "toolCalls.imageSearch";
	if (normalized === "memory_context") return "toolCalls.memoryLookup";
	if (
		normalized.includes("fetch") ||
		normalized.includes("url") ||
		normalized.includes("browse")
	) {
		return "toolCalls.fetchPage";
	}
	if (isFileProductionToolName(name)) return "toolCalls.createFile";
	return "toolCalls.generic";
}
