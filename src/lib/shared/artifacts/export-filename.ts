/**
 * The name an item's export carries: the title the reader wrote, safe as a file's name
 * (Unicode kept, as Markdown has always done). Browser-safe and dependency-free, so the
 * export route, the storage adapter that names the files and the board's picture all
 * ask the one function.
 */

const MAX_FILENAME_LENGTH = 100;

/**
 * A safe bare basename for a produced file (T12.1): path separators cannot
 * escape the storage directory, a leading dot cannot make a hidden file, a
 * trailing dot or space cannot leave the extension looking doubled ("Plan..pdf"),
 * and an empty result (nothing left after stripping, or the source was blank)
 * falls back to "document" rather than shipping an unusable filename.
 */
export function sanitizeDocumentFilename(title: string): string {
	const withoutSeparators = title.trim().replace(/[\\/]+/g, "-");
	const withoutLeadingDots = withoutSeparators.replace(/^\.+/, "");
	const capped = withoutLeadingDots
		.slice(0, MAX_FILENAME_LENGTH)
		.replace(/[.\s]+$/, "");
	return capped.length > 0 ? capped : "document";
}
