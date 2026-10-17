import { json } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import { currentPasswordRefusal } from "$lib/server/api/current-password";
import {
	runGuardedSecondFactor,
	secondFactorFailureResponse,
} from "$lib/server/api/second-factor";
import { requireAdmin } from "$lib/server/auth/hooks";
import { db } from "$lib/server/db";
import { users } from "$lib/server/db/schema";
import { checkCurrentPassword } from "$lib/server/services/auth";
import {
	isTwoStepEnabled,
	resetTwoStepForUser,
	verifySecondFactor,
} from "$lib/server/services/two-step";
import type { RequestHandler } from "./$types";

/**
 * An admin turns another person's two-step sign-in off: the factor, the
 * backup codes and every session of that person, in one transaction (R10).
 *
 * The admin proves who they are with their own password through
 * `checkCurrentPassword` (R12: the shared `account:` budget, not a bare
 * bcrypt comparison), and with their own code when they have a factor. The
 * action is never offered — and here refused — on the admin's own account:
 * that person turns it off in Settings with their own code.
 */
export const POST: RequestHandler = async (event) => {
	requireAdmin(event);
	const adminId = event.locals.user.id;
	const targetUserId = event.params.id;

	if (adminId === targetUserId) {
		return json(
			{
				error:
					"Use your own account settings to change your own two-step sign-in.",
				errorKey: "admin.users.twoStepSelfReset",
			},
			{ status: 400 },
		);
	}

	let body: {
		password?: unknown;
		code?: unknown;
		backupCode?: unknown;
	};
	try {
		body = await event.request.json();
	} catch {
		return json({ error: "Invalid JSON" }, { status: 400 });
	}

	if (typeof body.password !== "string" || !body.password) {
		return json(
			{
				error: "Your password is required.",
				errorKey: "admin.users.twoStepPasswordRequired",
			},
			{ status: 400 },
		);
	}

	const [target] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.id, targetUserId))
		.limit(1);
	if (!target) {
		return json({ error: "User not found" }, { status: 404 });
	}

	// When the admin has a factor, the reset asks for one of their codes too:
	// a stolen admin session plus the password must not be enough to strip
	// somebody else's second factor.
	if (await isTwoStepEnabled(adminId)) {
		const code = typeof body.code === "string" ? body.code.trim() : "";
		const backupCode =
			typeof body.backupCode === "string" ? body.backupCode.trim() : "";
		if (!code && !backupCode) {
			return json(
				{
					error: "Your code is required.",
					errorKey: "admin.users.twoStepCodeRequired",
				},
				{ status: 400 },
			);
		}

		const guarded = await runGuardedSecondFactor(adminId, () =>
			verifySecondFactor(adminId, code ? { code } : { backupCode }, new Date()),
		);
		if ("response" in guarded) return guarded.response;
		if (!guarded.result.ok) {
			return secondFactorFailureResponse(guarded.result.reason);
		}
	}

	const check = await checkCurrentPassword(adminId, body.password);
	if (check.outcome !== "ok") return currentPasswordRefusal(check);

	await resetTwoStepForUser(targetUserId);
	console.info("[AUTH] two-step reset by admin", {
		adminId,
		userId: targetUserId,
	});

	return json({ success: true });
};
