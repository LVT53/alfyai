/**
 * What a tool tells the model when it will not open an address (docs/plans/exfil-channels).
 *
 * Model-facing text, in the turn's language like the tool catalogue (English and
 * Hungarian), and never an address: the refused address is the model's own words,
 * and echoing it back would put it into a result the next call could trust. The
 * wording says what happened and what to do instead, so a model that tried an
 * address it made up has a way forward that is not "try again".
 */

export type ProvenanceLanguage = "en" | "hu";

function plural(count: number, one: string, many: string): string {
	return count === 1 ? one : many;
}

/** fetch_url, every address refused: nothing was fetched. */
export function allAddressesRefusedMessage(
	language: ProvenanceLanguage,
	count: number,
): string {
	if (language === "hu") {
		return `Semmi nem lett letöltve: a kért ${count} cím sem a felhasználó saját üzenetéből, sem egy eszköz eredményéből nem származik, a fetch_url pedig csak ilyen címet nyit meg. Oldalak kereséséhez használd a research_web eszközt. Ha a felhasználó megnevezett egy oldalt, a címét úgy használd, ahogy megadta; ha nem adott meg címet, kérdezd meg tőle.`;
	}
	return `Nothing was fetched: the ${count} ${plural(count, "address", "addresses")} you asked for came from neither the user's own messages nor a tool result, and fetch_url opens only those. To find pages on a topic, call research_web. If the user named a page, use its address exactly as they gave it; if they gave none, ask them for it.`;
}

/** fetch_url, some addresses refused: the rest were fetched. */
export function someAddressesRefusedNote(
	language: ProvenanceLanguage,
	count: number,
): string {
	if (language === "hu") {
		return `${count} cím nem lett megnyitva: nem a felhasználó üzenetéből és nem egy eszköz eredményéből származik. A fetch_url csak a felhasználó által beírt vagy egy eszköz által visszaadott címet nyitja meg; oldalak kereséséhez a research_web való.`;
	}
	return `${count} ${plural(count, "address was", "addresses were")} not opened: ${plural(count, "it", "they")} came from neither the user's messages nor a tool result. fetch_url opens only addresses the user typed or a tool returned; research_web finds pages.`;
}

/** produce_file, pictures left out of the document. */
export function imagesLeftOutWarning(
	language: ProvenanceLanguage,
	count: number,
): string {
	if (language === "hu") {
		return `${count} kép kimaradt a dokumentumból: a címe sem a felhasználó üzenetéből, sem egy eszköz eredményéből nem származik, és a szerver csak ilyen képet tölt le. Használj olyan képet, amelyet egy keresés (image_search) adott vissza, vagy mondd el a felhasználónak, hogy kimaradt; ne állítsd, hogy a fájlban benne van.`;
	}
	return `${count} ${plural(count, "image was", "images were")} left out of the document: ${plural(count, "its address", "their addresses")} came from neither the user's messages nor a tool result, and the server fetches only pictures from those. Use a picture a search (image_search) returned, or tell the user ${plural(count, "it was", "they were")} left out; do not say ${plural(count, "it is", "they are")} in the file.`;
}
