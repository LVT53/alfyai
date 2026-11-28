// Project Plex's metadata onto a bounded, read-only catalog. Raw Media/Part
// records contain server file paths and playback keys and must never leave here.
import type { PlexCategory } from "$lib/shared/plex-categories";

export const plexTypeId = {
	movie: 1,
	show: 2,
	season: 3,
	episode: 4,
	artist: 8,
	album: 9,
	track: 10,
} as const;
export type CatalogType = keyof typeof plexTypeId;

export type CatalogItem = {
	title: string;
	type: string;
	section: string;
	id?: string;
	year?: number;
	artist?: string;
	album?: string;
	show?: string;
	season?: number;
	episode?: number;
	track?: number;
	disc?: number;
	durationMs?: number;
	addedAt?: number;
	metadata?: Record<string, string | number | boolean | string[]>;
};

type Row = Record<string, unknown>;
const record = (v: unknown): v is Row =>
	!!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown) =>
	typeof v === "number" && Number.isFinite(v) ? v : undefined;
const str = (v: unknown) =>
	typeof v === "string" ? v.slice(0, 2048) : undefined;
export const validPlexId = (v: unknown): v is string =>
	typeof v === "string" && /^\d{1,20}$/.test(v);

export function parseCatalogPage(body: unknown) {
	if (!record(body) || !record(body.MediaContainer)) return null;
	const container = body.MediaContainer;
	if (container.Metadata !== undefined && !Array.isArray(container.Metadata))
		return null;
	const entries: Row[] = (container.Metadata ?? []).filter(record);
	return {
		entries,
		total: num(container.totalSize) ?? num(container.size) ?? entries.length,
		section: str(container.librarySectionTitle) ?? "",
		sectionId: String(container.librarySectionID ?? ""),
	};
}

export function playlistAllowed(row: Row, categories: readonly PlexCategory[]) {
	return row.playlistType === "audio"
		? categories.includes("music")
		: row.playlistType === "video" &&
				categories.includes("movies") &&
				categories.includes("tv");
}

function detailedMetadata(row: Row) {
	const metadata: NonNullable<CatalogItem["metadata"]> = {};
	for (const key of [
		"summary",
		"tagline",
		"studio",
		"originalTitle",
		"originallyAvailableAt",
		"contentRating",
		"rating",
		"audienceRating",
		"leafCount",
		"childCount",
		"playlistType",
		"smart",
		"editionTitle",
		"extraType",
		"loudnessAnalysisVersion",
	]) {
		const value = row[key];
		if (typeof value === "string") metadata[key] = value.slice(0, 2048);
		else if (
			typeof value === "boolean" ||
			(typeof value === "number" && Number.isFinite(value))
		)
			metadata[key] = value;
	}
	for (const key of [
		"Genre",
		"Style",
		"Mood",
		"Collection",
		"Country",
		"Director",
		"Writer",
		"Role",
		"Similar",
		"Producer",
	]) {
		const tags = row[key];
		if (!Array.isArray(tags)) continue;
		const labels = tags
			.filter(record)
			.slice(0, 25)
			.map((tag) => str(tag.tag))
			.filter((s): s is string => !!s);
		if (labels.length) metadata[key] = labels;
	}
	const first = Array.isArray(row.Media) && row.Media.find(record);
	if (first) {
		for (const key of [
			"audioCodec",
			"videoCodec",
			"videoResolution",
			"container",
			"audioChannels",
			"bitrate",
			"width",
			"height",
		]) {
			const value = first[key];
			if (
				typeof value === "string" ||
				(typeof value === "number" && Number.isFinite(value))
			)
				metadata[key] = typeof value === "string" ? value.slice(0, 64) : value;
		}
		const tracks = new Set<string>();
		for (const part of (Array.isArray(first.Part) ? first.Part : [])
			.filter(record)
			.slice(0, 10)) {
			for (const stream of (Array.isArray(part.Stream) ? part.Stream : [])
				.filter(record)
				.slice(0, 80)) {
				const language = str(stream.language) ?? str(stream.languageCode);
				if (language && (stream.streamType === 2 || stream.streamType === 3))
					tracks.add(
						(stream.streamType === 2 ? "Audio: " : "Subtitles: ") + language,
					);
			}
		}
		if (tracks.size) metadata.languages = [...tracks];
	}
	return metadata;
}

export function catalogItem(
	row: Row,
	section: string,
	detailed = false,
): CatalogItem | null {
	const title = str(row.title),
		type = str(row.type);
	if (!title || !type) return null;
	const item: CatalogItem = {
		title,
		type,
		section: section || str(row.librarySectionTitle) || "",
	};
	if (validPlexId(String(row.ratingKey))) item.id = String(row.ratingKey);
	if (num(row.year) !== undefined) item.year = num(row.year);
	if (num(row.duration) !== undefined) item.durationMs = num(row.duration);
	if (num(row.addedAt) !== undefined) item.addedAt = num(row.addedAt);
	if (type === "album") item.artist = str(row.parentTitle);
	if (type === "track") {
		item.artist = str(row.originalTitle) || str(row.grandparentTitle);
		item.album = str(row.parentTitle);
		item.track = num(row.index);
		item.disc = num(row.parentIndex);
	}
	if (type === "episode") {
		item.show = str(row.grandparentTitle);
		item.season = num(row.parentIndex);
		item.episode = num(row.index);
	}
	if (type === "season") {
		item.show = str(row.parentTitle);
		item.season = num(row.index);
	}
	if (detailed) item.metadata = detailedMetadata(row);
	return item;
}
