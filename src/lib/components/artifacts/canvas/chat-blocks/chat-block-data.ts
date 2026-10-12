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
	| "mermaid"
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
	/** When the chat made it (epoch milliseconds): what tells two rows of one name apart. */
	at: number;
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

/** The diagram types the section names, by the first word of the source (lower-cased); any other reads as a plain diagram. */
const DIAGRAM_TYPE_KEYS: Readonly<Record<string, I18nKey>> = {
	flowchart: "artifacts.canvas.chat.diagramType.flowchart",
	graph: "artifacts.canvas.chat.diagramType.flowchart",
	sequencediagram: "artifacts.canvas.chat.diagramType.sequence",
	classdiagram: "artifacts.canvas.chat.diagramType.class",
	statediagram: "artifacts.canvas.chat.diagramType.state",
	"statediagram-v2": "artifacts.canvas.chat.diagramType.state",
	erdiagram: "artifacts.canvas.chat.diagramType.er",
	gantt: "artifacts.canvas.chat.diagramType.gantt",
	pie: "artifacts.canvas.chat.diagramType.pie",
};

function diagramName(
	title: string | null,
	diagramType: string | null,
	translate: Translate,
): string {
	if (title) return title;
	const type = diagramType?.toLowerCase() ?? "";
	return translate(
		Object.hasOwn(DIAGRAM_TYPE_KEYS, type)
			? DIAGRAM_TYPE_KEYS[type]
			: "artifacts.canvas.chat.diagramType.other",
	);
}

/**
 * When a row was made, for telling it from another of the same name: the clock
 * time, with the day first when it is not today, and the seconds too when asked
 * (two of them were made in one minute). The reader's own language, never a version
 * number (ruling 76, Q2: that is History's fine print).
 */
function whenMade(at: number, locale: string | undefined, seconds: boolean) {
	const date = new Date(at);
	const sameDay = date.toDateString() === new Date().toDateString();
	return new Intl.DateTimeFormat(locale, {
		...(sameDay ? {} : { month: "short", day: "numeric" }),
		hour: "2-digit",
		minute: "2-digit",
		...(seconds ? { second: "2-digit" } : {}),
	}).format(date);
}

/**
 * Rows that read alike (two Apps called "Tip calculator", two exports of one
 * document, both cut to the same words by the menu's width) are told apart by
 * when each was made, after the type and the size a file already shows. A row that
 * says something of its own (another name, another size, another count) is left as
 * it is: the time is for the rows that need it.
 */
function tellRowsApart(rows: ChatBlockRow[], locale: string | undefined): void {
	const alike = new Map<string, ChatBlockRow[]>();
	for (const row of rows) {
		const key = `${row.name}\u0000${row.meta}`;
		alike.set(key, [...(alike.get(key) ?? []), row]);
	}
	for (const same of alike.values()) {
		if (same.length < 2) continue;
		const minutes = same.map((row) => whenMade(row.at, locale, false));
		same.forEach((row, index) => {
			// Made in one minute as another of them: the seconds say which is which.
			const shared = minutes.filter((m) => m === minutes[index]).length > 1;
			const when = shared ? whenMade(row.at, locale, true) : minutes[index];
			row.meta = row.meta ? `${row.meta}${SEPARATOR}${when}` : when;
		});
	}
}

/** The listing as the section draws it: one group per kind that has something, in a fixed order, each row newest first as the server gave it. */
export function chatBlockGroups(
	listing: CanvasChatBlocks,
	translate: Translate,
	locale?: string,
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
				// No version number: it is History's fine print and nowhere else (ruling 76, Q2).
				meta: [
					file.data.label,
					file.data.bytes > 0 ? formatByteSize(file.data.bytes) : "",
				]
					.filter((part) => part.length > 0)
					.join(SEPARATOR),
				data: file.data,
				at: file.at,
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
				meta: "",
				data: app.data,
				at: app.at,
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
					at: item.at,
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
				at: chart.at,
			})),
		});
	}

	if (listing.diagrams.length > 0) {
		groups.push({
			kind: "mermaid",
			label: translate("artifacts.canvas.chat.diagrams"),
			rows: listing.diagrams.map((diagram) => ({
				key: diagram.key,
				kind: "mermaid",
				name: diagramName(diagram.title, diagram.diagramType, translate),
				meta: formatRelativeTime(diagram.at, { t: translate }),
				data: diagram.data,
				at: diagram.at,
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
				at: search.at,
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
				at: search.at,
			})),
		});
	}

	for (const group of groups) tellRowsApart(group.rows, locale);
	return groups;
}
