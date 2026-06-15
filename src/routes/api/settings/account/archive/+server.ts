import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { createAccountDataArchive } from "$lib/server/services/account-data-archive";
import type { RequestHandler } from "./$types";

function parsePasswordBody(body: unknown): string | null {
	if (!body || typeof body !== "object") return null;
	const password = (body as { password?: unknown }).password;
	return typeof password === "string" ? password : null;
}

async function readJsonBody(
	event: Parameters<RequestHandler>[0],
): Promise<unknown | Response> {
	try {
		return await event.request.json();
	} catch {
		return json({ error: "Invalid JSON" }, { status: 400 });
	}
}

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const userId = event.locals.user?.id;

	const body = await readJsonBody(event);
	if (body instanceof Response) return body;

	const password = parsePasswordBody(body);
	if (!password) {
		return json({ error: "password is required" }, { status: 400 });
	}

	let result: Awaited<ReturnType<typeof createAccountDataArchive>>;
	try {
		result = await createAccountDataArchive(userId, { password });
	} catch (error) {
		console.error("[ACCOUNT_DATA_ARCHIVE] Failed to create archive:", error);
		return json(
			{ error: "Failed to create account data archive" },
			{ status: 500 },
		);
	}

	if (result.status === "not_found") {
		return json({ error: "User not found" }, { status: 404 });
	}
	if (result.status === "incorrect_password") {
		return json({ error: "Incorrect password" }, { status: 401 });
	}

	return new Response(new Uint8Array(result.zipBytes), {
		status: 200,
		headers: {
			"Content-Type": "application/zip",
			"Content-Disposition": `attachment; filename="${result.filename}"`,
			"Cache-Control": "no-store",
		},
	});
};
