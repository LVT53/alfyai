// How each kind's body travels between the stored string and its structured
// form. One registry, one entry per kind: slice 1 adds `document` (Markdown ⇄
// blocks, with ids minted immediately after parse), slice 3 `canvas` (board ⇄
// JSON with stable key order), slice 4 `slides`. Slice 0 ships the `file`
// entry only.
//
// A kind with no entry resolves to `null`, never a throw, so a caller that
// meets a kind whose slice has not landed can say so instead of crashing.
import type { ArtifactKind } from "$lib/shared/artifacts/kinds";

export interface ArtifactSerializer<TBody> {
	readonly kind: ArtifactKind;
	/** The stored string for a structured body. Equal bodies give equal strings. */
	serialize(body: TBody): string;
	/** The structured body for a stored string, or `null` when it does not parse. */
	parse(stored: string): TBody | null;
}

/**
 * What a File is in the family's terms: the produced files it stands for.
 * The bytes stay where file production put them (`chat_generated_files`); this
 * names them, which is all the family ever needs to say about a File.
 */
export interface FileArtifactDescriptor {
	files: Array<{
		chatFileId: string;
		filename: string;
		mimeType: string | null;
	}>;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

const fileArtifactSerializer: ArtifactSerializer<FileArtifactDescriptor> = {
	kind: "file",
	serialize(descriptor) {
		// Rebuilt field by field so the key order is the serializer's, not the
		// caller's: equal descriptors always serialise to equal strings.
		return JSON.stringify({
			files: descriptor.files.map((file) => ({
				chatFileId: file.chatFileId,
				filename: file.filename,
				mimeType: file.mimeType,
			})),
		});
	},
	parse(stored) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(stored);
		} catch {
			return null;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return null;
		}
		const files = (parsed as { files?: unknown }).files;
		if (!Array.isArray(files)) return null;
		const descriptor: FileArtifactDescriptor = { files: [] };
		for (const entry of files) {
			const file = entry as Record<string, unknown> | null;
			if (
				!file ||
				!isNonEmptyString(file.chatFileId) ||
				!isNonEmptyString(file.filename) ||
				!(file.mimeType === null || typeof file.mimeType === "string")
			) {
				return null;
			}
			descriptor.files.push({
				chatFileId: file.chatFileId,
				filename: file.filename,
				mimeType: file.mimeType,
			});
		}
		return descriptor;
	},
};

const SERIALIZERS: Partial<Record<ArtifactKind, ArtifactSerializer<unknown>>> =
	{
		file: fileArtifactSerializer as ArtifactSerializer<unknown>,
	};

export function getArtifactSerializer(
	kind: ArtifactKind,
): ArtifactSerializer<unknown> | null {
	return SERIALIZERS[kind] ?? null;
}
