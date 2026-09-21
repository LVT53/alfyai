// Paste-to-attach: deciding whether a paste is an attachment or a text paste
// (phase5-6 spec §3.6).
//
// There was no paste handler anywhere in `src/` before this slice. The thing
// that must be protected is therefore the browser's OWN native text paste into
// the composer `<textarea>` — not `insertQuoteAtCursor`, which is an in-app
// outline pick and never touches the clipboard.
//
// Pure and DOM-free apart from the `DataTransfer` it is handed, so the rule
// below is unit-testable without a browser and the composer holds none of it.

import type { RejectReasonKey } from "$lib/shared/file-types";
import {
	admitUpload,
	fileExtension,
	getEntryByMimeType,
} from "$lib/shared/file-types";

/**
 * Reason → i18n key, the client-side twin of `UPLOAD_REJECT_I18N_KEYS` in
 * `$lib/server/services/knowledge/upload-signature.ts`. It cannot be imported
 * from there: `$lib/server/**` is server-only and importing it into a
 * component would fail the build.
 *
 * The `Record<RejectReasonKey, …>` type is what keeps the two in step — a new
 * reason in the registry is a compile error here, not a missing message at
 * runtime.
 */
export const UPLOAD_REJECT_I18N_KEYS: Readonly<
	Record<RejectReasonKey, string>
> = {
	unknownType: "knowledge.uploadUnsupportedType",
	media: "knowledge.uploadRejectedMedia",
	archive: "knowledge.uploadRejectedArchive",
	formatNotEnabled: "knowledge.uploadRejectedFormatNotEnabled",
	convertImage: "knowledge.uploadRejectedConvertImage",
};

export interface ClipboardAttachmentRefusal {
	readonly name: string;
	/** A key in the `knowledge.uploadRejected*` family, ready for `$t`. */
	readonly errorKey: string;
	/** Uppercased, for the `{ext}` placeholder those messages carry. */
	readonly ext: string;
}

export interface ClipboardAttachmentDecision {
	/** Files to hand to `uploadFiles`. Empty ⇒ do nothing. */
	readonly files: readonly File[];
	/** True only when `files` is non-empty. */
	readonly preventDefault: boolean;
	/** Registry refusals, already keyed for `$t`. */
	readonly refused: readonly ClipboardAttachmentRefusal[];
}

export interface ClipboardAttachmentOptions {
	/** Injected in tests so the generated name is deterministic. */
	readonly now?: Date;
	/**
	 * Entry ids the MinerU-4 gate currently refuses
	 * (`$lib/stores/upload-format-gate`). Empty ⇒ the gate is open, which is
	 * its default and its failure mode.
	 */
	readonly disabledEntryIds?: ReadonlySet<string>;
}

const NOTHING: ClipboardAttachmentDecision = Object.freeze({
	files: [],
	preventDefault: false,
	refused: [],
});

/**
 * Names a browser invents for a clipboard image, which are worth replacing
 * with something a user can recognise in a list of five. Chrome and Safari
 * hand a screenshot over as `image.png`; Firefox sometimes gives `""`.
 *
 * Deliberately short: a file the user really did name `photo.png` in Finder
 * keeps its name, because only these three placeholders and a name with no
 * extension at all are renamed.
 */
const PLACEHOLDER_BASENAMES: ReadonlySet<string> = new Set([
	"image",
	"blob",
	"unknown",
]);

function pad(value: number, length = 2): string {
	return String(value).padStart(length, "0");
}

/** `20260921-041500`, local time — the user's clock, not UTC. */
function timestamp(now: Date): string {
	return (
		`${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
		`-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
	);
}

function needsGeneratedName(name: string): boolean {
	const trimmed = name.trim();
	if (!trimmed) return true;
	const extension = fileExtension(trimmed);
	if (!extension) return true;
	const base = trimmed.slice(0, trimmed.length - extension.length - 1);
	return PLACEHOLDER_BASENAMES.has(base.toLowerCase());
}

/**
 * `pasted-20260921-041500.png`. The extension comes from the registry's view
 * of the MIME, so a clipboard PNG is named `.png` and a JPEG `.jpg` — the
 * canonical extension, not whatever alias the browser declared.
 *
 * When the MIME names nothing the ORIGINAL extension is kept. Renaming must
 * never make a file less acceptable than it was: `getEntryByMimeType`
 * deliberately answers null for a generic MIME and for an empty one, and
 * `admitUpload` resolves the extension FIRST, so `image.png` with
 * `application/octet-stream` — which is what several engines hand over — is
 * admitted through the picker and the drop zone and would have been refused
 * here as `pasted-….bin`. `bin` stays the honest answer when neither the MIME
 * nor the name names a type; `admitUpload` refuses it a line later, which is
 * the right outcome.
 */
function generatedName(file: File, now: Date, ordinal: number): string {
	const extension =
		getEntryByMimeType(file.type)?.extensions[0] ||
		fileExtension(file.name) ||
		"bin";
	const suffix = ordinal > 0 ? `-${ordinal + 1}` : "";
	return `pasted-${timestamp(now)}${suffix}.${extension}`;
}

function renamed(file: File, name: string): File {
	if (name === file.name) return file;
	return new File([file], name, {
		type: file.type,
		lastModified: file.lastModified,
	});
}

function refusalFor(
	name: string,
	reason: RejectReasonKey,
): ClipboardAttachmentRefusal {
	return {
		name,
		errorKey: UPLOAD_REJECT_I18N_KEYS[reason],
		ext: fileExtension(name).toUpperCase(),
	};
}

/**
 * Decides whether a paste is an attachment or a text paste.
 *
 * The rule is deliberately conservative: a clipboard that carries ANY
 * `text/plain` flavour is a text paste, full stop. Copying a cell range from
 * Excel, a paragraph from Word or a figure from a web page all put an image on
 * the clipboard ALONGSIDE the text, and hijacking those would make the
 * composer unusable. A screenshot (Cmd-Shift-4, Print Screen) and a file
 * copied in Finder/Explorer carry files and no `text/plain`, which is exactly
 * the case worth handling.
 *
 * The size limit is NOT checked here: `uploadFiles` already owns it, against
 * the one number the server reports, and duplicating it would be the fifth
 * copy of a limit this migration spent a phase removing.
 */
export function decideClipboardAttachment(
	data: DataTransfer | null,
	options: ClipboardAttachmentOptions = {},
): ClipboardAttachmentDecision {
	if (!data) return NOTHING;

	const candidates = Array.from(data.files ?? []);
	if (candidates.length === 0) return NOTHING;

	// `types` is a live `DOMStringList` in some engines and a frozen array in
	// others; both iterate.
	const types = Array.from(data.types ?? []);
	if (types.includes("text/plain")) return NOTHING;

	const now = options.now ?? new Date();
	const disabled = options.disabledEntryIds;
	const files: File[] = [];
	const refused: ClipboardAttachmentRefusal[] = [];
	let generated = 0;

	for (const candidate of candidates) {
		const name = needsGeneratedName(candidate.name)
			? generatedName(candidate, now, generated++)
			: candidate.name;

		const admission = admitUpload(name, candidate.type || null);
		if (!admission.allowed) {
			refused.push(refusalFor(name, admission.reason));
			continue;
		}
		// A gated format on a backend that has POSITIVELY probed as pre-4.x is
		// refused with the same reason the server will answer with, so pasting
		// one reads exactly like picking one through the OS "All files" escape
		// hatch. An empty set (the default, and the failure mode) skips this.
		if (admission.entry && disabled?.has(admission.entry.id)) {
			refused.push(refusalFor(name, "formatNotEnabled"));
			continue;
		}

		files.push(renamed(candidate, name));
	}

	return { files, preventDefault: files.length > 0, refused };
}
