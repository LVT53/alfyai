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
		ADD_TAGS: options.allowStyleTags ? ["style"] : [],
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
