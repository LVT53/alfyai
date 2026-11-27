import { createHash } from "node:crypto";
import { resolveWorkingDocumentFileServing } from "../../knowledge/store/working-document-file-serving";
import { OneDriveError } from "./onedrive";

const limit = 25 * 1024 * 1024;
export async function teamsUploadSource(
	userId: string,
	sourceId: string,
	selected: readonly string[],
) {
	const id =
		sourceId === "selected" && selected.length === 1 ? selected[0] : sourceId;
	if (!selected.includes(id))
		throw new OneDriveError(
			"Choose a file attached to this message.",
			"invalid_path",
		);
	const result = await resolveWorkingDocumentFileServing({
		userId,
		artifactId: id,
		mode: "download",
		rangeHeader: `bytes=0-${limit}`,
	});
	if (!result.ok)
		throw new OneDriveError(
			"The selected attachment is unavailable.",
			"not_found",
		);
	const range = result.headers["Content-Range"];
	const total = Number(range?.split("/").at(-1) ?? result.body.byteLength);
	if (
		!Number.isSafeInteger(total) ||
		total < 0 ||
		total > limit ||
		total !== result.body.byteLength
	)
		throw new OneDriveError(
			"This attachment exceeds the Teams upload limit.",
			"too_large",
		);
	const encoded = /filename\*=UTF-8''([^;]+)/i.exec(
		result.headers["Content-Disposition"] ?? "",
	)?.[1];
	if (!encoded)
		throw new OneDriveError(
			"The attachment filename is unavailable.",
			"invalid_path",
		);
	const name = decodeURIComponent(encoded);
	const contentType =
		result.headers["Content-Type"] ?? "application/octet-stream";
	const source = {
		id,
		name,
		size: total,
		contentType,
		sha256: createHash("sha256").update(result.body).digest("hex"),
	};
	return { source, bytes: result.body };
}
