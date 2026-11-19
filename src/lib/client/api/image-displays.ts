/** Only the one-way picture key crosses the analytics endpoint, never a signed
 * publisher URL, a query, a caption, or the text of a reply. */
export async function reportImageLoad(
	messageId: string,
	thumbnail: string,
	outcome: "loaded" | "failed",
) {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(thumbnail),
	);
	const imageKey = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	const response = await fetch("/api/analytics/image-displays", {
		method: "POST",
		headers: { "content-type": "application/json" },
		keepalive: true,
		body: JSON.stringify({ messageId, imageKey, outcome }),
	});
	if (!response.ok) throw new Error("Image report was not accepted");
}
