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
import { verifyPassword } from "../auth";

// The account lifecycle (erase / clear-memory / clear-workspace mechanics + the
// user-scoped-table registry) lives in one owner: ../account-lifecycle. This
// module is only the self-service, password-confirmed HTTP façade over it.
export { DETACHED_SHARED_CONTENT_OWNER_ID };

export type PrivacyControlPasswordResult =
	| { status: "not_found" }
	| { status: "incorrect_password" };

export type ClearMemoryAndKnowledgeResult =
	| { status: "cleared"; deletedArtifactIds: string[] }
	| PrivacyControlPasswordResult;

export type ClearWorkspaceDataResult =
	| { status: "reset" }
	| PrivacyControlPasswordResult;

export type AccountErasureResult =
	| { status: "deleted" }
	| PrivacyControlPasswordResult;

export async function clearMemoryAndKnowledge(
	userId: string,
	password: string,
): Promise<ClearMemoryAndKnowledgeResult> {
	const [user] = await db.select().from(users).where(eq(users.id, userId));
	if (!user) {
		return { status: "not_found" };
	}

	const valid = await verifyPassword(password, user.passwordHash);
	if (!valid) {
		return { status: "incorrect_password" };
	}

	const deletedArtifactIds = await clearMemoryAndKnowledgeForUser(userId);
	return { status: "cleared", deletedArtifactIds };
}

export async function clearWorkspaceData(
	userId: string,
	password: string,
): Promise<ClearWorkspaceDataResult> {
	const [user] = await db.select().from(users).where(eq(users.id, userId));
	if (!user) {
		return { status: "not_found" };
	}

	const valid = await verifyPassword(password, user.passwordHash);
	if (!valid) {
		return { status: "incorrect_password" };
	}

	await quiesceUserWorkspace(userId);
	await purgeUserData(userId);

	return { status: "reset" };
}

export async function eraseUserAccount(
	userId: string,
	password: string,
): Promise<AccountErasureResult> {
	const [user] = await db.select().from(users).where(eq(users.id, userId));
	if (!user) {
		return { status: "not_found" };
	}

	const valid = await verifyPassword(password, user.passwordHash);
	if (!valid) {
		return { status: "incorrect_password" };
	}

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
