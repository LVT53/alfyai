/**
 * Test-only: what `FakeVersionPreview.svelte` reports, so a test can make a
 * kind's preview fail without fetching anything. Not for production code.
 */
export const fakePreviewStatus: { value: "ready" | "error" } = {
	value: "ready",
};
