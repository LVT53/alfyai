import { json } from "@sveltejs/kit";
import { verifyFileProductionServiceAssertion } from "$lib/server/auth/hooks";
import {
	getConversation,
	getConversationUserId,
} from "$lib/server/services/conversations";
import {
	type FileProductionIntakeResult,
	getFileProductionIntakeConversationId,
	submitFileProductionIntake,
} from "$lib/server/services/file-production";
import type { RequestHandler } from "./$types";

async function resolveOwnerUserId(
	event: Parameters<RequestHandler>[0],
	conversationId: string,
) {
	const user = event.locals.user ?? null;

	if (!user && !event.request.headers.get("authorization")) {
		return {
			ok: false as const,
			response: json({ error: "Unauthorized" }, { status: 401 }),
		};
	}

	if (user) {
		const conversation = await getConversation(user.id, conversationId);
		if (!conversation) {
			return {
				ok: false as const,
				response: json({ error: "Conversation not found" }, { status: 404 }),
			};
		}
		return { ok: true as const, userId: user.id };
	}

	const serviceAssertion = verifyFileProductionServiceAssertion(
		event.request.headers.get("authorization"),
	);
	if (
		!serviceAssertion?.valid ||
		serviceAssertion.claims.conversationId !== conversationId
	) {
		return {
			ok: false as const,
			response: json({ error: "Unauthorized" }, { status: 401 }),
		};
	}
	const conversationUserId = await getConversationUserId(conversationId);
	if (!conversationUserId) {
		return {
			ok: false as const,
			response: json({ error: "Conversation not found" }, { status: 404 }),
		};
	}
	return { ok: true as const, userId: conversationUserId };
}

function intakeResultResponse(result: FileProductionIntakeResult) {
	if (result.ok) {
		return json(
			{ job: result.job, reused: result.reused },
			{ status: result.status },
		);
	}

	if (result.job) {
		return json(
			{ error: result.error, job: result.job },
			{ status: result.status },
		);
	}

	return json({ error: result.error }, { status: result.status });
}

export const POST: RequestHandler = async (event) => {
	let body: unknown;
	try {
		body = await event.request.json();
	} catch {
		return json({ error: "Invalid JSON body" }, { status: 400 });
	}

	const conversationId = getFileProductionIntakeConversationId(body);
	if (!conversationId.ok) {
		return json(
			{ error: conversationId.error },
			{ status: conversationId.status },
		);
	}

	const owner = await resolveOwnerUserId(event, conversationId.conversationId);
	if (!owner.ok) return owner.response;

	return intakeResultResponse(
		await submitFileProductionIntake({
			userId: owner.userId,
			body,
		}),
	);
};
