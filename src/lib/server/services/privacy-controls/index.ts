import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { users } from "$lib/server/db/schema";
import {
	clearMemoryAndKnowledgeForUser,
	DETACHED_SHARED_CONTENT_OWNER_ID,
	eraseUserAccountData,
	purgeUserData,
	quiesceUserWorkspace,
} from "../account-lifecycle";
import { checkCurrentPassword } from "../auth";

// The account lifecycle (erase / clear-memory / clear-workspace mechanics + the
// user-scoped-table registry) lives in one owner: ../account-lifecycle. This
// module is only the self-service, password-confirmed HTTP façade over it.
export { DETACHED_SHARED_CONTENT_OWNER_ID };

export type PrivacyControlPasswordResult =
	| { status: "not_found" }
	| { status: "incorrect_password" }
	/** Wrong answers have used up the account's budget (`checkCurrentPassword`). */
	| { status: "throttled"; retryAfterSeconds: number };

export type ClearMemoryAndKnowledgeResult =
	| { status: "cleared"; deletedArtifactIds: string[] }
	| PrivacyControlPasswordResult;

export type ClearWorkspaceDataResult =
	| { status: "reset" }
	| PrivacyControlPasswordResult;

export type AccountErasureResult =
	| { status: "deleted" }
	| PrivacyControlPasswordResult;

/**
 * The password the person typed to confirm one of the three actions below, or
 * why it did not pass. The same check as the email change's
 * (`checkCurrentPassword`): these actions are the ones a hijacked session would
 * guess the password for, so they share the account's budget of wrong answers
 * instead of comparing it bare.
 */
async function confirmPassword(
	userId: string,
	password: string,
): Promise<PrivacyControlPasswordResult | null> {
	const check = await checkCurrentPassword(userId, password);
	switch (check.outcome) {
		case "ok":
			return null;
		case "no_user":
			return { status: "not_found" };
		case "wrong":
			return { status: "incorrect_password" };
		case "throttled":
			return {
				status: "throttled",
				retryAfterSeconds: check.retryAfterSeconds,
			};
	}
}

export async function clearMemoryAndKnowledge(
	userId: string,
	password: string,
): Promise<ClearMemoryAndKnowledgeResult> {
	const refused = await confirmPassword(userId, password);
	if (refused) return refused;

	const deletedArtifactIds = await clearMemoryAndKnowledgeForUser(userId);
	return { status: "cleared", deletedArtifactIds };
}

export async function clearWorkspaceData(
	userId: string,
	password: string,
): Promise<ClearWorkspaceDataResult> {
	const refused = await confirmPassword(userId, password);
	if (refused) return refused;

	await quiesceUserWorkspace(userId);
	await purgeUserData(userId);

	return { status: "reset" };
}

export async function eraseUserAccount(
	userId: string,
	password: string,
): Promise<AccountErasureResult> {
	const refused = await confirmPassword(userId, password);
	if (refused) return refused;

	await eraseUserAccountData(userId);
	return { status: "deleted" };
}

export async function eraseUserAccountAsAdmin(
	userId: string,
): Promise<boolean> {
	const [user] = await db.select().from(users).where(eq(users.id, userId));
	if (!user) {
		return false;
	}

	await eraseUserAccountData(userId);
	return true;
}
