/**
 * The one rule for the name a download is saved under: it must end in an extension
 * that belongs to the file's own type. A suffix of ANOTHER type ("Intro to Node.js"
 * served as a Word file) is part of the title, not an extension, so the type's own
 * is appended. Browser-safe: the server's Content-Disposition and the client's blob
 * downloads both call it.
 */
import {
	fileExtension,
	getEntryByExtension,
	getEntryByMimeType,
	normalizeMimeType,
} from "./index";

function append(filename: string, extension: string): string {
	return `${filename.replace(/[.\s]+$/, "")}.${extension}`;
}

/** The name with `extension` (no dot) on it, unless it already ends in one of that type's. */
export function withFileExtension(
	filename: string,
	extension: string | null | undefined,
): string {
	const wanted = extension?.trim().replace(/^\./, "").toLowerCase();
	if (!wanted) return filename;
	const own = fileExtension(filename);
	if (own === wanted) return filename;
	const entry = getEntryByExtension(wanted);
	if (own && entry?.extensions.includes(own)) return filename;
	return append(filename, wanted);
}

/** The name with the canonical extension for `contentType`; generic and unknown types leave it alone. */
export function ensureFilenameExtension(
	filename: string,
	contentType: string | null | undefined,
): string {
	const entry = getEntryByMimeType(contentType);
	const canonical = entry?.extensions[0];
	if (!entry || !canonical) return filename;
	// text/plain is what a script or config file is served as, so any known
	// extension is fine there ("script.py" stays); a specific type is strict.
	if (
		normalizeMimeType(contentType) === "text/plain" &&
		getEntryByExtension(fileExtension(filename))
	) {
		return filename;
	}
	return withFileExtension(filename, canonical);
}
