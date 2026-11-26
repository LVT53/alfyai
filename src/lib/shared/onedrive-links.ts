// OneDrive personal and Microsoft 365 document links can leave Graph only on these hosts.
export function oneDriveDocumentUrl(value: unknown): string | undefined {
	if (typeof value !== "string") return;
	const url = URL.parse(value);
	if (url?.protocol !== "https:" || url.port || url.username || url.password)
		return;
	const host = url.hostname;
	if (
		host === "1drv.ms" ||
		host === "onedrive.live.com" ||
		host.endsWith(".sharepoint.com")
	)
		return url.href;
}
