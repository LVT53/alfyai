import type { MemoryKind } from "$lib/memory-types";

/**
 * Whether an entry is current, quiet or Earlier, decided when it is read
 * (design spec, part 2: "never delete on a guess; decide at read time"). Only
 * a new fact moves `lastMentionedAt`, so being recalled or shown never keeps an
 * entry current. Recall and the Memory page share this one rule.
 */
export type MemoryTimeState = "current" | "quiet" | "earlier";

/** Whole days; config-store's `getMemoryAgingThresholds` (admin-overridable). */
export interface MemoryAgingThresholds {
	temporaryEarlierDays: number;
	ongoingQuietDays: number;
	ongoingEarlierDays: number;
}

const DAY_MS = 86_400_000;

function instant(value: string | null): number | null {
	if (value === null) return null;
	const at = Date.parse(value);
	return Number.isNaN(at) ? null : at;
}

/**
 * Lasting, unlabelled and person-written entries are always current. A
 * temporary entry is Earlier `temporaryEarlierDays` after the later of its
 * last mention and its event; an ongoing one is quiet `ongoingQuietDays`
 * after its last mention and Earlier `ongoingEarlierDays` after it. An entry
 * with no usable date never ages.
 */
export function memoryEntryTimeState(
	entry: {
		kind: MemoryKind | null;
		lastMentionedAt: string | null;
		eventAt: string | null;
		authored: boolean;
	},
	now: Date,
	thresholds: MemoryAgingThresholds,
): MemoryTimeState {
	if (entry.authored || entry.kind === null || entry.kind === "lasting")
		return "current";
	const said = instant(entry.lastMentionedAt);
	if (entry.kind === "temporary") {
		const anchors = [said, instant(entry.eventAt)].filter(
			(at): at is number => at !== null,
		);
		if (!anchors.length) return "current";
		const days = Math.floor((now.getTime() - Math.max(...anchors)) / DAY_MS);
		return days >= thresholds.temporaryEarlierDays ? "earlier" : "current";
	}
	if (said === null) return "current";
	const days = Math.floor((now.getTime() - said) / DAY_MS);
	if (days >= thresholds.ongoingEarlierDays) return "earlier";
	if (days >= thresholds.ongoingQuietDays) return "quiet";
	return "current";
}
