import { timingSafeEqual } from "node:crypto";
import { json } from "@sveltejs/kit";
import { getConfig } from "$lib/server/config-store";
import { readForegroundActivity } from "$lib/server/services/chat-turn/request-activity";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ request }) => {
	const secret = getConfig().hindsightAdmissionKey;
	const supplied = request.headers.get("authorization") ?? "";
	const expected = `Bearer ${secret}`;
	const received = Buffer.from(supplied);
	const wanted = Buffer.from(expected);
	if (
		!secret ||
		received.length !== wanted.length ||
		!timingSafeEqual(received, wanted)
	) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}
	try {
		return json(readForegroundActivity(), {
			headers: { "Cache-Control": "no-store" },
		});
	} catch {
		return json(
			{ idle: false, active: true },
			{ status: 503, headers: { "Cache-Control": "no-store" } },
		);
	}
};
