/**
 * The address the panel frames a standard report by (`DocumentPreviewRenderer.svelte`).
 *
 * A preview is cached for an hour (`Cache-Control: private, max-age=3600`), so a
 * browser could frame a copy of a report it kept from before read aloud's bridge
 * (`report-bridge.ts`, which the server adds to a report's preview), or from before
 * the bridge changed, and read aloud would find no bridge, or an old one, in it. So
 * the frame asks by the preview's own address plus the bridge's version, which the
 * preview routes ignore (they read the item from the path alone): no copy cached under
 * another address is used.
 */

/** The bridge's version. Bump it with any change to what `report-bridge.ts` says or takes. */
export const REPORT_BRIDGE_VERSION = 1;

/** A preview's address with the bridge's version (`rb`); a relative address stays relative. */
export function reportFrameAddress(previewAddress: string): string {
	const absolute = /^[a-z][a-z0-9+.-]*:/iu.test(previewAddress);
	const url = new URL(previewAddress, "http://preview.invalid");
	url.searchParams.set("rb", String(REPORT_BRIDGE_VERSION));
	return absolute ? url.href : `${url.pathname}${url.search}${url.hash}`;
}
