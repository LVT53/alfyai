<script lang="ts">
/**
 * Shared brand icon for the Connections UI (ADR 0044).
 *
 * Renders a vendored, monochrome `currentColor` brand glyph for a
 * connection provider — Lucide dropped brand glyphs, so real brand SVGs
 * (sourced from the `simple-icons` devDependency, see
 * ./brand-icon-data.ts) are vendored/inlined here rather than pulled in
 * as a runtime dependency. Deliberately neutral/monochrome to match the
 * app's calm aesthetic — the ONE place brand color is used is
 * GoogleSignInButton.svelte, per Google's sign-in branding guidelines.
 *
 * Providers without a Simple Icons glyph (or better served by a neutral
 * glyph) fall back to a Lucide icon: owntracks -> MapPin, imap/email ->
 * Mail, anything else unknown -> Plug.
 *
 * Usage:
 * ```svelte
 * <BrandIcon provider="google" />
 * <BrandIcon provider="nextcloud" size={24} title="My Nextcloud" />
 * <BrandIcon provider="apple" ariaHidden />
 * ```
 */
import { Cloud, Mail, MapPin, Plug } from "@lucide/svelte";
import { BRAND_GLYPHS, isBrandIconProvider } from "./brand-icon-data";

const DISPLAY_NAMES: Record<string, string> = {
	google: "Google",
	gmail: "Gmail",
	nextcloud: "Nextcloud",
	immich: "Immich",
	apple: "Apple",
	plex: "Plex",
	owntracks: "OwnTracks",
	imap: "Email",
	email: "Email",
	contacts: "Contacts",
	github: "GitHub",
	onedrive: "OneDrive",
};

// Simple Icons (the source of BRAND_GLYPHS, see ./brand-icon-data) has no
// Microsoft OneDrive glyph in the pinned package version — "onedrive" falls
// back to a neutral Lucide cloud icon here rather than a vendored brand
// mark, per the task brief's explicit "Lucide fallback if needed".
const FALLBACK_ICONS: Record<string, typeof Mail> = {
	owntracks: MapPin,
	imap: Mail,
	email: Mail,
	onedrive: Cloud,
};

function humanize(provider: string): string {
	if (!provider) return "Connection";
	return provider.charAt(0).toUpperCase() + provider.slice(1);
}

let {
	provider,
	size = 20,
	title,
	ariaHidden = false,
}: {
	provider: string;
	size?: number;
	title?: string;
	ariaHidden?: boolean;
} = $props();

let glyph = $derived(
	isBrandIconProvider(provider) ? BRAND_GLYPHS[provider] : undefined,
);
let FallbackIcon = $derived(FALLBACK_ICONS[provider] ?? Plug);
let label = $derived(title ?? DISPLAY_NAMES[provider] ?? humanize(provider));
</script>

{#if glyph}
	<svg
		viewBox={glyph.viewBox}
		width={size}
		height={size}
		fill="currentColor"
		role={ariaHidden ? undefined : "img"}
		aria-label={ariaHidden ? undefined : label}
		aria-hidden={ariaHidden ? "true" : undefined}
		xmlns="http://www.w3.org/2000/svg"
	>
		<path d={glyph.path} />
	</svg>
{:else}
	<span
		class="brand-icon-fallback"
		role={ariaHidden ? undefined : "img"}
		aria-label={ariaHidden ? undefined : label}
		aria-hidden={ariaHidden ? "true" : undefined}
	>
		<FallbackIcon {size} strokeWidth={2} aria-hidden="true" />
	</span>
{/if}

<style>
	.brand-icon-fallback {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		line-height: 0;
	}
</style>
