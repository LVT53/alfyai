import { getConfig } from "../config-store";

export interface ImageSearchResult {
	url: string;
	title: string;
	source: string;
	thumbnail?: string;
	width?: number;
	height?: number;
}

export async function searchImages(
	query: string,
): Promise<ImageSearchResult[]> {
	const config = getConfig();
	const apiKey = config.braveSearchApiKey;

	if (!apiKey) {
		throw new Error("BRAVE_SEARCH_API_KEY is not configured");
	}

	const url = new URL("https://api.search.brave.com/res/v1/images/search");
	url.searchParams.set("q", query);
	url.searchParams.set("count", "5");

	const response = await fetch(url.toString(), {
		method: "GET",
		headers: {
			Accept: "application/json",
			"Accept-Encoding": "gzip",
			"X-Subscription-Token": apiKey,
		},
	});

	if (!response.ok) {
		const errorText = await response.text().catch(() => "");
		throw new Error(
			`Brave Search API error: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ""}`,
		);
	}

	const data = await response.json();
	const results: ImageSearchResult[] = [];

	if (data.results && Array.isArray(data.results)) {
		for (const item of data.results.slice(0, 5)) {
			results.push({
				url: item.properties?.url || item.url || "",
				title: item.title || "",
				source: item.properties?.host || item.url || "",
				thumbnail: item.properties?.thumbnail?.url || item.thumbnail?.url,
				width: item.properties?.width,
				height: item.properties?.height,
			});
		}
	}

	return results;
}
