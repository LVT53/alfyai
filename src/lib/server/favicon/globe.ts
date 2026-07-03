/**
 * Generic globe favicon fallback (ADR 0043, Slice 12).
 *
 * Returned when a domain has no discoverable icon, or when validation rejects
 * the input. Kept tiny and dependency-free.
 */

const encoder = new TextEncoder();

export const GLOBE_FALLBACK_SVG =
	`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="link">` +
	`<circle cx="32" cy="32" r="28" fill="none" stroke="currentColor" stroke-width="3"/>` +
	`<ellipse cx="32" cy="32" rx="12" ry="28" fill="none" stroke="currentColor" stroke-width="2.5"/>` +
	`<line x1="4" y1="32" x2="60" y2="32" stroke="currentColor" stroke-width="2.5"/>` +
	`</svg>`;

export const GLOBE_FALLBACK_SVG_BYTES: Uint8Array =
	encoder.encode(GLOBE_FALLBACK_SVG);
