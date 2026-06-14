export function formatByteSize(
	bytes: number | null | undefined,
	options: { emptyLabel?: string; trimWholeUnits?: boolean } = {},
): string {
	if (!bytes) return options.emptyLabel ?? "0 B";
	if (bytes >= 1024 ** 4) {
		return `${(bytes / 1024 ** 4).toFixed(1)} TB`;
	}

	const unit = 1024;
	const units = ["B", "KB", "MB", "GB"];
	const unitIndex = Math.floor(Math.log(bytes) / Math.log(unit));
	const value = bytes / unit ** unitIndex;
	const formatted =
		options.trimWholeUnits && value % 1 === 0
			? value.toString()
			: value.toFixed(unitIndex === 0 ? 0 : 1);

	return `${formatted} ${units[unitIndex]}`;
}

export function formatRoundedKilobytes(
	bytes: number | null | undefined,
	emptyLabel = "Unknown size",
): string {
	if (!bytes) return emptyLabel;
	return `${Math.ceil(bytes / 1024)} KB`;
}
