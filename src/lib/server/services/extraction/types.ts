// Row shapes, named once so every module in the slice (and every slice that
// codes against it) refers to the same thing rather than re-deriving
// `$inferSelect` in four places.

import type {
	documentExtractionJobAttempts,
	documentExtractionJobs,
} from "$lib/server/db/schema";

export type DocumentExtractionJobRow =
	typeof documentExtractionJobs.$inferSelect;
export type DocumentExtractionAttemptRow =
	typeof documentExtractionJobAttempts.$inferSelect;

export type DocumentExtractionOrigin = "upload" | "generated_file_readback";

export type DocumentExtractionIntakeRoute = "direct-text" | "mineru";

/** Ascending = sooner. */
export const EXTRACTION_PRIORITY_UPLOAD = 0;
export const EXTRACTION_PRIORITY_READBACK = 10;
