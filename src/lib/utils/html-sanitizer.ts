import DOMPurify from "isomorphic-dompurify";

export function sanitizeHtml(
	html: string,
	options: { allowStyleAttributes?: boolean; allowStyleTags?: boolean } = {},
): string {
	if (!html) return "";

	return DOMPurify.sanitize(html, {
		USE_PROFILES: { html: true },
		FORBID_TAGS: options.allowStyleTags ? ["script"] : ["script", "style"],
		FORBID_ATTR: options.allowStyleAttributes ? [] : ["style"],
		// A3 rich blocks: <details>/<summary> back the accordion block (raw-HTML
		// passthrough syntax). They are part of DOMPurify's default HTML profile,
		// but listing them explicitly makes the rich-block contract intentional
		// and immune to a future default-profile change. No wildcards — every
		// rich-block tag is named. DOMPurify still strips event handlers,
		// javascript: URLs, and (unless opted in) style on these tags.
		ADD_TAGS: options.allowStyleTags
			? ["style", "details", "summary"]
			: ["details", "summary"],
		ADD_ATTR: ["target", "rel"],
		ALLOW_DATA_ATTR: false,
		ALLOW_UNKNOWN_PROTOCOLS: false,
	});
}

export function escapeHtml(
	value: string,
	options: { apostropheEntity?: "&#39;" | "&#039;" } = {},
): string {
	const apostropheEntity = options.apostropheEntity ?? "&#39;";

	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", apostropheEntity);
}
