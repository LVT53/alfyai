// The reading source FakeReadAloudBody.svelte hands the panel, shared so a test can
// tell it is the one the header's speaker reads with.
import type { DocumentReadingSource } from "$lib/client/read-aloud/controller";

export const fakeReadAloudSource: DocumentReadingSource = {
	root: () => null,
	version: () => 2,
	revision: () => 0,
	settle: async () => {},
	focus: () => {},
};
