/**
 * Provider-agnostic hygiene for source/result titles.
 *
 * Trims residual search-engine echoes, date prefixes, and platform
 * navigation/footer suffixes that occasionally survive in a page/result
 * title, leaving a clean human-readable title. Shared by the search stage
 * (title normalization) and the renderer (source chips).
 */
export function sanitizeSourceTitle(title: string): string {
	let result = title.trim();
	if (!result) return result;

	// Strip search-engine language filter echoes (combined then single)
	result = result.replace(
		/^Nem tartalmazza:[^|]*\|\s*Tartalmaznia kell:[^|]*\|\s*/i,
		"",
	);
	result = result.replace(/^Nem tartalmazza:[^|]*\|\s*/i, "");
	result = result.replace(/^Tartalmaznia kell:[^|]*\|\s*/i, "");
	result = result.replace(/^Excluding:[^|]*\|\s*Must include:[^|]*\|\s*/i, "");
	result = result.replace(/^Excluding:[^|]*\|\s*/i, "");
	result = result.replace(/^Must include:[^|]*\|\s*/i, "");

	// Strip Hungarian date prefix (e.g. "2024. jan. 26. · ")
	result = result.replace(
		/^\d{4}\.\s*(?:jan\.|febr\.|márc\.|ápr\.|máj\.|jún\.|júl\.|aug\.|szept\.|okt\.|nov\.|dec\.|január|február|március|április|május|június|július|augusztus|szeptember|október|november|december)\s+\d{1,2}\.\s*·\s*/,
		"",
	);

	// Strip navigation/footer suffixes
	result = result.replace(/\s*-\s*Please wait for verification\s*$/i, "");
	result = result.replace(/\s*-\s*YouTube\s*$/i, "");
	result = result.replace(/\s*\|\s*(Instagram|Facebook|TikTok)\s*$/i, "");

	return result.trim();
}
