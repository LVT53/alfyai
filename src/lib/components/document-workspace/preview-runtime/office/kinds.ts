// The office preview kinds and the runtime guard over them.
//
// A leaf module on purpose. `preview-runtime/index.ts` needs the GUARD at
// runtime but loads the renderers with `await import("./office")`, and that
// dynamic import only splits a chunk when nothing imports the module
// statically as well. Taking the guard straight from `./office` made the
// split ineffective — Rollup said so (INEFFECTIVE_DYNAMIC_IMPORT) and folded
// the renderer module plus `$lib/utils/html-sanitizer` into the caller's
// chunk. The npm renderers (mammoth, exceljs, pptxviewjs, jszip) stayed
// behind their own dynamic imports either way, but the preview-performance
// note in `src/lib/server/services/AGENTS.md` says not to revert these paths
// to eager imports.
//
// Nothing heavy may ever be imported here.

import type { PreviewKind } from "$lib/shared/file-types";

/**
 * The preview kinds the office renderer owns, carved out of the registry's
 * `PreviewKind` rather than restated (spec row 38). Adding an office format to
 * the registry therefore does not silently widen this union — the `switch` in
 * `renderOfficePreview` stops compiling until the new kind gets a renderer.
 */
export type OfficePreviewKind = Extract<
	PreviewKind,
	"docx" | "xlsx" | "pptx" | "odt"
>;

/**
 * The runtime half of the union. Typed as a total record so dropping a kind
 * here is a compile error rather than a preview that silently stops opening.
 */
const OFFICE_PREVIEW_KINDS: Record<OfficePreviewKind, true> = {
	docx: true,
	xlsx: true,
	pptx: true,
	odt: true,
};

export function isOfficePreviewKind(
	kind: string | null | undefined,
): kind is OfficePreviewKind {
	return kind != null && Object.hasOwn(OFFICE_PREVIEW_KINDS, kind);
}

export type OfficeRuntimeAdapter = { kind: OfficePreviewKind; blob: Blob };
