import { json } from "@sveltejs/kit";

export function adminUserErrorResponse(error: unknown, fallback: string) {
	const message = error instanceof Error ? error.message : fallback;

	if (/not found/i.test(message)) {
		return json({ error: message }, { status: 404 });
	}
	if (/already exists/i.test(message)) {
		return json({ error: message }, { status: 409 });
	}
	if (/last admin/i.test(message) || /use your own account/i.test(message)) {
		return json({ error: message }, { status: 400 });
	}
	if (/valid email/i.test(message) || /password/i.test(message)) {
		return json({ error: message }, { status: 400 });
	}

	return json({ error: fallback }, { status: 500 });
}
