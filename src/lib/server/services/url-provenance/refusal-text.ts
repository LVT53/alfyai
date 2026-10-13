/**
 * What a tool tells the model when it will not open an address (docs/plans/exfil-channels).
 *
 * Model-facing text, English like the tool catalogue (whatever language the
 * person writes), and never an address: the refused address is the model's own words,
 * and echoing it back would put it into a result the next call could trust. The
 * wording says what happened and what to do instead, so a model that tried an
 * address it made up has a way forward that is not "try again".
 */

function plural(count: number, one: string, many: string): string {
	return count === 1 ? one : many;
}

/** fetch_url, every address refused: nothing was fetched. */
export function allAddressesRefusedMessage(count: number): string {
	return `Nothing was fetched: the ${count} ${plural(count, "address", "addresses")} you asked for came from neither the user's own messages nor a tool result, and fetch_url opens only those. To find pages on a topic, call research_web. If the user named a page, use its address exactly as they gave it; if they gave none, ask them for it.`;
}

/** fetch_url, some addresses refused: the rest were fetched. */
export function someAddressesRefusedNote(count: number): string {
	return `${count} ${plural(count, "address was", "addresses were")} not opened: ${plural(count, "it", "they")} came from neither the user's messages nor a tool result. fetch_url opens only addresses the user typed or a tool returned; research_web finds pages.`;
}

/** produce_file, pictures left out of the document. */
export function imagesLeftOutWarning(count: number): string {
	return `${count} ${plural(count, "image was", "images were")} left out of the document: ${plural(count, "its address", "their addresses")} came from neither the user's messages nor a tool result, and the server fetches only pictures from those. Use a picture a search (image_search) returned, or tell the user ${plural(count, "it was", "they were")} left out; do not say ${plural(count, "it is", "they are")} in the file.`;
}
