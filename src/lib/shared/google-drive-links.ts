/** A click-through link for a Drive file, folder, or Docs editor. Never a download or redirect endpoint. */
export function googleDriveDocumentUrl(value: unknown): string | undefined {
	if (typeof value !== "string") return;
	const url = URL.parse(value);
	if (url?.protocol !== "https:" || url.username || url.password || url.port)
		return;
	if (url.hostname === "drive.google.com") {
		if (
			/^\/(?:file\/d|drive\/(?:u\/\d+\/)?folders)\/[A-Za-z0-9_-]+(?:\/(?:view|edit|preview))?\/?$/.test(
				url.pathname,
			)
		)
			return url.href;
		if (
			url.pathname === "/open" &&
			/^[A-Za-z0-9_-]+$/.test(url.searchParams.get("id") ?? "")
		)
			return url.href;
	}
	if (
		url.hostname === "docs.google.com" &&
		/^\/(?:document|spreadsheets|presentation|forms|drawings)\/(?:u\/\d+\/)?d\/(?:e\/)?[A-Za-z0-9_-]+(?:\/(?:view|edit|preview|viewform))?\/?$/.test(
			url.pathname,
		)
	)
		return url.href;
}
