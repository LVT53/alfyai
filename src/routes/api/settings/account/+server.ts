import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { clearSessionCookie } from "$lib/server/services/auth";
import {
	type DeleteUserAccountResult,
	deleteUserAccountWithCleanup,
	type ResetUserAccountResult,
	resetUserAccountStateWithCleanup,
} from "$lib/server/services/cleanup";
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

export const DELETE: RequestHandler = async (event) => {
	requireAuth(event);
	const userId = event.locals.user?.id;

	const body = await readJsonBody(event);
	if (body instanceof Response) {
		return body;
	}

	const password = parsePasswordBody(body);
	if (!password) {
		return json({ error: "password is required" }, { status: 400 });
	}

	let result: DeleteUserAccountResult;
	try {
		result = await deleteUserAccountWithCleanup(userId, password);
	} catch (error) {
		console.error(
			"[ACCOUNT_DELETE] Failed to fully delete user account:",
			error,
		);
		return json(
			{ error: "Failed to fully delete account data" },
			{ status: 500 },
		);
	}

	if (result.status === "not_found") {
		return json({ error: "User not found" }, { status: 404 });
	}

	if (result.status === "incorrect_password") {
		return json({ error: "Incorrect password" }, { status: 401 });
	}

	clearSessionCookie(event.cookies);

	return json({ success: true });
};

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const userId = event.locals.user?.id;

	const body = await readJsonBody(event);
	if (body instanceof Response) {
		return body;
	}

	const password = parsePasswordBody(body);
	if (!password) {
		return json({ error: "password is required" }, { status: 400 });
	}

	let result: ResetUserAccountResult;
	try {
		result = await resetUserAccountStateWithCleanup(userId, password);
	} catch (error) {
		console.error("[ACCOUNT_RESET] Failed to fully reset user account:", error);
		return json(
			{ error: "Failed to fully reset account data" },
			{ status: 500 },
		);
	}

	if (result.status === "not_found") {
		return json({ error: "User not found" }, { status: 404 });
	}

	if (result.status === "incorrect_password") {
		return json({ error: "Incorrect password" }, { status: 401 });
	}

	clearSessionCookie(event.cookies);

	return json({ success: true });
};
