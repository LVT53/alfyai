/**
 * What the Insert menu's "From this chat" shows for each thing the chat made, and
 * what a pick puts on the board — pure, so the section component is only markup.
 * The labels are the chat's own: a route reads exactly as its activity row reads
 * it (`buildToolActivityItem`, the one grammar for that), in the reader's
 * language, because the server lists facts and never words.
 */
import type { I18nKey } from "$lib/i18n";
import type { CanvasBlockData } from "$lib/shared/artifacts/canvas-blocks";
import { LABEL_MAX_CHARS } from "$lib/shared/artifacts/canvas-limits";
import type {
	CanvasChatBlocks,
	ChatMapBlock,
} from "$lib/shared/artifacts/chat-blocks";
import { formatByteSize } from "$lib/utils/format";
import { formatRelativeTime } from "$lib/utils/time";
import { buildToolActivityItem } from "$lib/utils/tool-activity";
import type { Translate } from "$lib/utils/tool-evidence-presentation";

export type ChatBlockKind =
	| "file"
	| "app"
	| "map"
	| "chart"
	| "photo"
	| "liveweb";

export interface ChatBlockRow {
	/** Stable, for a list to key on. */
	key: string;
	kind: ChatBlockKind;
	/** What the row says. */
	name: string;
	/** Its quiet second part. Empty when there is none. */
	meta: string;
	/** What a pick puts on the board: exactly one block's data. */
	data: CanvasBlockData;
	/** For a file: its name and type, for the icon the chat shows beside a file. */
	filename?: string;
	mime?: string;
}

export interface ChatBlockGroup {
	kind: ChatBlockKind;
	label: string;
	rows: ChatBlockRow[];
}

const SEPARATOR = " · ";

/**
 * The map block for a route the chat made: its route and its summary read the
 * way the chat's own activity row reads them, cut at the limit the block keeps
 * (a label past it would be dropped with the block on the next save).
 */
export function mapBlockData(
	item: ChatMapBlock,
	translate: Translate,
): Extract<CanvasBlockData, { kind: "map" }> {
	const row = buildToolActivityItem(
		{
			type: "tool_call",
			name: "map_route",
			input: { action: item.action ?? "route" },
			status: "done",
			map: item.map,
		},
		item.key,
		translate,
	);
	const route = (row.object ?? "").slice(0, LABEL_MAX_CHARS);
	const meta = (row.meta ?? "").slice(0, LABEL_MAX_CHARS);
	return {
		kind: "map",
		route,
		...(meta ? { meta } : {}),
		map: item.map,
	};
}

/** Chart.js chart types the section names; any other reads as a plain chart. */
const CHART_TYPE_KEYS: Readonly<Record<string, I18nKey>> = {
	bar: "artifacts.canvas.chat.chartType.bar",
	line: "artifacts.canvas.chat.chartType.line",
	pie: "artifacts.canvas.chat.chartType.pie",
	doughnut: "artifacts.canvas.chat.chartType.doughnut",
	radar: "artifacts.canvas.chat.chartType.radar",
	polarArea: "artifacts.canvas.chat.chartType.polarArea",
	scatter: "artifacts.canvas.chat.chartType.scatter",
	bubble: "artifacts.canvas.chat.chartType.bubble",
};

function chartName(
	title: string | null,
	chartType: string | null,
	translate: Translate,
): string {
	if (title) return title;
	const key =
		chartType && Object.hasOwn(CHART_TYPE_KEYS, chartType)
			? CHART_TYPE_KEYS[chartType]
			: "artifacts.canvas.chat.chartType.other";
	return translate(key);
}

/** The listing as the section draws it: one group per kind that has something, in a fixed order, each row newest first as the server gave it. */
export function chatBlockGroups(
	listing: CanvasChatBlocks,
	translate: Translate,
): ChatBlockGroup[] {
	const groups: ChatBlockGroup[] = [];

	if (listing.files.length > 0) {
		groups.push({
			kind: "file",
			label: translate("artifacts.canvas.chat.files"),
			rows: listing.files.map((file) => ({
				key: file.key,
				kind: "file",
				name: file.data.name,
				meta: [
					file.data.label,
					file.data.bytes > 0 ? formatByteSize(file.data.bytes) : "",
					file.version !== null && file.version > 1
						? translate("artifacts.canvas.chat.version", {
								version: file.version,
							})
						: "",
				]
					.filter((part) => part.length > 0)
					.join(SEPARATOR),
				data: file.data,
				filename: file.data.name,
				mime: file.data.mime,
			})),
		});
	}

	if (listing.apps.length > 0) {
		groups.push({
			kind: "app",
			label: translate("artifacts.canvas.chat.apps"),
			rows: listing.apps.map((app) => ({
				key: app.key,
				kind: "app",
				name: app.data.title,
				meta:
					app.versionNumber > 0
						? translate("artifacts.canvas.chat.version", {
								version: app.versionNumber,
							})
						: "",
				data: app.data,
			})),
		});
	}

	if (listing.maps.length > 0) {
		groups.push({
			kind: "map",
			label: translate("artifacts.canvas.chat.maps"),
			rows: listing.maps.map((item) => {
				const data = mapBlockData(item, translate);
				return {
					key: item.key,
					kind: "map",
					name: data.route || translate("artifacts.canvas.insert.map"),
					meta: data.meta ?? "",
					data,
				};
			}),
		});
	}

	if (listing.charts.length > 0) {
		groups.push({
			kind: "chart",
			label: translate("artifacts.canvas.chat.charts"),
			rows: listing.charts.map((chart) => ({
				key: chart.key,
				kind: "chart",
				name: chartName(chart.title, chart.chartType, translate),
				meta: formatRelativeTime(chart.at, { t: translate }),
				data: chart.data,
			})),
		});
	}

	if (listing.photos.length > 0) {
		groups.push({
			kind: "photo",
			label: translate("artifacts.canvas.chat.photos"),
			rows: listing.photos.map((search) => ({
				key: search.key,
				kind: "photo",
				name: search.query ?? translate("artifacts.canvas.chat.photoSearch"),
				meta: [
					translate("artifacts.canvas.chat.photoCount", {
						count: search.data.items.length,
					}),
					formatRelativeTime(search.at, { t: translate }),
				].join(SEPARATOR),
				data: search.data,
			})),
		});
	}

	if (listing.searches.length > 0) {
		groups.push({
			kind: "liveweb",
			label: translate("artifacts.canvas.chat.searches"),
			rows: listing.searches.map((search) => ({
				key: search.key,
				kind: "liveweb",
				name: search.data.query,
				meta: [
					translate("artifacts.canvas.chat.sourceCount", {
						count: search.data.sources.length,
					}),
					formatRelativeTime(search.at, { t: translate }),
				].join(SEPARATOR),
				data: search.data,
			})),
		});
	}

	return groups;
}
