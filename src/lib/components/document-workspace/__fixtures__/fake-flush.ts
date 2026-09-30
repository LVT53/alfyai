import { vi } from "vitest";

/** The `flush` `FakeFlushingArtifactBody.svelte` registers: one function, so a test can tell it from any other. */
export const fakeFlush = vi.fn(async () => {});
