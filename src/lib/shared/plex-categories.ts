// Each Plex server has its own content controls under the shared media tool.
export const PLEX_CATEGORIES = ["movies", "tv", "music"] as const;
export type PlexCategory = (typeof PLEX_CATEGORIES)[number];

export function isPlexCategory(value: unknown): value is PlexCategory {
	return PLEX_CATEGORIES.some((category) => category === value);
}

export function enabledPlexCategories(connection: {
	capabilities: readonly string[];
	plexCategories?: readonly PlexCategory[];
}): PlexCategory[] {
	if (!connection.capabilities.includes("media")) return [];
	if (connection.plexCategories) return [...connection.plexCategories];
	// Existing rows and older public DTOs used a single "media" switch.
	if (connection.capabilities.length === 1) return [...PLEX_CATEGORIES];
	return connection.capabilities.filter(isPlexCategory);
}

export function plexCategoryForType(type: string): PlexCategory | undefined {
	switch (type) {
		case "movie":
			return "movies";
		case "show":
		case "season":
		case "episode":
			return "tv";
		case "artist":
		case "album":
		case "track":
			return "music";
	}
}
