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

// The report source FakeReportPreview.svelte hands the panel, in place of the
// preview's ReportReadAloud.svelte.
import type { ReportReadingSource } from "$lib/client/read-aloud/controller";

export const fakeReportSource: ReportReadingSource = {
	root: () => null,
	skip: ".source-chip",
	revision: () => 0,
	focus: () => {},
};
