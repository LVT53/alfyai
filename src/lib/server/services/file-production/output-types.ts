// The output-type table used to live here, split out of `output-validation.ts`
// so the modules on the REQUEST path — `intake.ts` and the `produce_file` tool —
// could ask "is this a type we can produce?" without pulling
// `output-validation`'s JSZip (and its pako tree) into the chat server bundle.
// Only the worker, which actually unpacks an XLSX, should pay for that.
//
// The table now lives in `$lib/shared/file-types` (Phase 1). This module stays
// as the import path every existing caller already uses, and re-exports the
// registry's production accessors. `$lib/shared/file-types/production` has the
// same zero-heavy-dependency property, so the bundle argument above still
// holds — `output-types.test.ts` asserts it against the registry's own table.

export {
	FILE_PRODUCTION_OUTPUT_TYPE_EXAMPLES,
	getExpectedExtensionForOutputType,
	isSupportedFileProductionOutputType,
	normalizeRequestedOutputType,
} from "$lib/shared/file-types/production";
