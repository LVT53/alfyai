// src/lib/server/security-headers.ts
//
// The response headers src/hooks.server.ts adds to everything the app serves.
// Pure and table-driven on purpose: the interesting part of a header policy is
// the set of cases (document vs API, http vs https, dev vs production, and
// whichever CSP mode is configured), and those are only reviewable if they can
// be enumerated in a test rather than reasoned about across a request.
//
// Two rules hold throughout:
//
//  1. NOTHING here overwrites a header the route already set. The generated-file
//     preview responses deliberately ship a much tighter policy of their own
//     (src/lib/server/services/file-serving-response-policy.ts: `Referrer-Policy:
//     no-referrer`, a `default-src 'none'` CSP), and the preview runtime's trust
//     check matches that CSP string exactly. Widening or double-setting it would
//     silently downgrade every generated HTML report to the no-script renderer.
//  2. The document-only headers are additionally scoped away from `/api/`, the
//     same predicate the pre-existing Cache-Control rule uses, so the file
//     routes cannot be reached by rule 1 failing.

export type CspMode = "off" | "report-only" | "enforce";

/**
 * Anything other than an explicit "off" or "enforce" leaves the deployment in
 * report-only, so a typo can never flip production onto an enforcing policy
 * nobody has watched a console for. Same shape as `parseAtlasPipelineEnv`.
 */
export function parseCspModeEnv(value: string | undefined): CspMode {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "off") return "off";
	if (normalized === "enforce") return "enforce";
	return "report-only";
}

/**
 * Features the app does not use, denied outright. Verified against the source:
 * there is no getUserMedia, MediaRecorder, SpeechRecognition, AudioContext or
 * navigator.geolocation anywhere in src/ — no voice input, no camera, no
 * location. Clipboard is used (MessageBubble, CodeBlock) and is deliberately
 * NOT listed, so it keeps its permissive default.
 */
const PERMISSIONS_POLICY = [
	"accelerometer=()",
	"autoplay=()",
	"camera=()",
	"display-capture=()",
	"encrypted-media=()",
	"gyroscope=()",
	"geolocation=()",
	"magnetometer=()",
	"microphone=()",
	"midi=()",
	"payment=()",
	"usb=()",
	"xr-spatial-tracking=()",
	// The PDF and map previews may go fullscreen; same-origin only.
	"fullscreen=(self)",
].join(", ");

/** Two years, with subdomains. Only ever emitted over HTTPS in production. */
const STRICT_TRANSPORT_SECURITY = "max-age=63072000; includeSubDomains";

export interface SecurityHeaderInput {
	/** Request path, used only to keep document headers off `/api/`. */
	pathname: string;
	/** The response's own Content-Type, or null. */
	contentType: string | null;
	/** Was this request actually served over TLS? */
	isSecureRequest: boolean;
	isProduction: boolean;
	cspMode: CspMode;
	/**
	 * The policy SvelteKit built for this page, if it built one.
	 *
	 * MUST be null for anything that is not a SvelteKit page response. A CSP
	 * that a route set for itself is that route's, and handing it in here would
	 * put it through the CSP_MODE rewrite below — which in report-only mode
	 * deletes the enforcing header. See `applySecurityHeaders` in
	 * src/hooks.server.ts for how the two are told apart.
	 */
	csp: string | null;
	/**
	 * Origins to add to `connect-src`. In practice the Sentry DSN's origin,
	 * resolved at runtime so the DSN does not have to be known at build time.
	 */
	extraConnectSources?: readonly string[];
	/** Header names the route has already set; these are never touched. */
	existingHeaders?: ReadonlySet<string>;
}

export interface SecurityHeaderPlan {
	/** Headers to set, lowercase names. */
	set: Record<string, string>;
	/** Headers to delete, lowercase names. */
	remove: string[];
}

function isDocumentResponse(pathname: string, contentType: string | null) {
	return (
		Boolean(contentType?.includes("text/html")) && !pathname.startsWith("/api/")
	);
}

/**
 * Adds sources to one directive of an existing policy.
 *
 * Only ever appends to a directive that is already present. Falling back to
 * `default-src` would be wrong — a source list on `default-src` applies to
 * every directive that is not otherwise specified, so "let Sentry connect"
 * would quietly become "let Sentry be a script source too".
 */
export function appendCspSources(
	policy: string,
	directive: string,
	sources: readonly string[],
): string {
	if (sources.length === 0) return policy;

	let found = false;
	const rewritten = policy
		.split(";")
		.map((segment) => {
			const trimmed = segment.trim();
			if (trimmed === "") return null;
			const [name] = trimmed.split(/\s+/);
			if (name?.toLowerCase() !== directive) return trimmed;
			found = true;
			const missing = sources.filter(
				(source) => !trimmed.split(/\s+/).includes(source),
			);
			return missing.length === 0 ? trimmed : `${trimmed} ${missing.join(" ")}`;
		})
		.filter((segment): segment is string => segment !== null);

	return found ? rewritten.join("; ") : policy;
}

/**
 * The origin a browser would POST Sentry envelopes to, derived from a DSN, or
 * null when there is no usable DSN. Only the origin is taken: a DSN carries a
 * public key in its userinfo, and that has no business in a response header.
 */
export function sentryConnectSource(dsn: string | undefined): string | null {
	const trimmed = dsn?.trim();
	if (!trimmed) return null;
	try {
		return new URL(trimmed).origin;
	} catch {
		return null;
	}
}

export function buildSecurityHeaders(
	input: SecurityHeaderInput,
): SecurityHeaderPlan {
	const {
		pathname,
		contentType,
		isSecureRequest,
		isProduction,
		cspMode,
		csp,
		extraConnectSources = [],
		existingHeaders = new Set<string>(),
	} = input;

	const set: Record<string, string> = {};
	const remove: string[] = [];
	const claim = (name: string, value: string) => {
		// Rule 1: a route that has already spoken about this header knows more
		// about its own response than this function does.
		if (existingHeaders.has(name)) return;
		set[name] = value;
	};

	// Everything, documents and API alike. `nosniff` matters most on the API,
	// where a JSON error body must never be sniffed into something executable,
	// and the referrer policy matters most on documents — but neither has a
	// downside on the other, and a blanket rule has no gaps.
	claim("x-content-type-options", "nosniff");
	claim("referrer-policy", "strict-origin-when-cross-origin");

	if (isProduction && isSecureRequest) {
		// Only over TLS: HSTS on a plain-HTTP response is ignored by browsers,
		// and only in production so a local http dev server can never pin a
		// developer's browser to https for two years.
		claim("strict-transport-security", STRICT_TRANSPORT_SECURITY);
	}

	if (isDocumentResponse(pathname, contentType)) {
		// SAMEORIGIN rather than DENY: the CSP's `frame-ancestors 'self'` is the
		// directive browsers actually honour here, and SAMEORIGIN is its
		// equivalent for anything old enough not to.
		claim("x-frame-options", "SAMEORIGIN");
		claim("permissions-policy", PERMISSIONS_POLICY);
		// `same-origin` rather than `same-origin-allow-popups`: OAuth for Google
		// and OneDrive is a full-page redirect, not a popup, and every
		// `window.open` in the app passes `noopener` — which already severs the
		// handle COOP would sever. The Nextcloud login-flow tab only checks the
		// return value for truthiness to detect a popup blocker, and a
		// COOP-severed open still returns a stub rather than null.
		claim("cross-origin-opener-policy", "same-origin");
	}

	// The CSP itself. SvelteKit has already put an enforcing policy on the
	// response; CSP_MODE decides what the browser actually receives.
	if (csp !== null) {
		const policy = appendCspSources(csp, "connect-src", extraConnectSources);
		if (cspMode === "off") {
			remove.push("content-security-policy");
		} else if (cspMode === "report-only") {
			remove.push("content-security-policy");
			set["content-security-policy-report-only"] = policy;
		} else {
			set["content-security-policy"] = policy;
		}
	}

	return { set, remove };
}

/**
 * Was the request served over TLS?
 *
 * adapter-node defaults `url.protocol` to https when PROTOCOL_HEADER is unset,
 * which it is here — so behind Apache (which terminates TLS) that default is
 * right, and on a local http dev server it is wrong. An explicit
 * `x-forwarded-proto` is therefore preferred when present.
 *
 * Reading that header without it being a configured trust anchor is safe in
 * BOTH directions here, which is not true of the rate limiter's address
 * handling: forging it to "http" only withholds HSTS from yourself, and
 * forging it to "https" only adds a header that browsers ignore on a
 * plain-HTTP response. There is nothing to gain either way.
 */
export function isSecureRequest(url: URL, headers: Headers): boolean {
	const forwarded = headers
		.get("x-forwarded-proto")
		?.split(",")[0]
		?.trim()
		.toLowerCase();
	if (forwarded) return forwarded === "https";
	return url.protocol === "https:";
}
