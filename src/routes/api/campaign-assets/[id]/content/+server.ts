import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { getCampaignAssetForServing } from "$lib/server/services/campaign-assets";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	try {
		requireAuth(event);
	} catch {
		return json({ error: "Unauthorized" }, { status: 401 });
	}

	const result = await getCampaignAssetForServing(event.params.id, {
		id: event.locals.user?.id,
		role: event.locals.user?.role,
	});

	if (!result.ok) {
		return json({ error: result.error }, { status: result.status });
	}

	const headers = new Headers({
		"Content-Type": result.asset.mimeType,
		"Content-Length": result.content.length.toString(),
		"Cache-Control": "private, max-age=300",
		"X-Content-Type-Options": "nosniff",
	});
	if (result.asset.mimeType === "image/svg+xml") {
		headers.set(
			"Content-Security-Policy",
			"sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
		);
	}

	return new Response(new Uint8Array(result.content), {
		status: 200,
		headers,
	});
};
