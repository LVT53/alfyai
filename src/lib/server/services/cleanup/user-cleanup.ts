import { rm } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	artifacts,
	browserPushSubscriptions,
	chatGeneratedFiles,
	conversationContextStatus,
	conversationDrafts,
	conversations,
	conversationTaskStates,
	conversationWorkingSetItems,
	memoryEvents,
	memoryProjects,
	memoryProjectTaskLinks,
	projects,
	semanticEmbeddings,
	sessions,
	taskCheckpoints,
	taskStateEvidenceLinks,
	users,
} from "$lib/server/db/schema";
import { cancelActiveAtlasJobsForUser, deleteAtlasJobsForUser } from "../atlas";
import { verifyPassword } from "../auth";
import { deleteAllChatFilesForUser } from "../chat-files";
import {
	buildArtifactVisibilityCondition,
	getArtifactOwnershipScope,
	hardDeleteArtifactsForUser,
} from "../knowledge";

export type DeleteUserAccountResult =
	| { status: "deleted" }
	| { status: "not_found" }
	| { status: "incorrect_password" };

export type ResetUserAccountResult =
	| { status: "reset" }
	| { status: "not_found" }
	| { status: "incorrect_password" };

export async function purgeUserData(userId: string): Promise<void> {
	await cancelActiveAtlasJobsForUser(userId);
	await deleteAllChatFilesForUser(userId);
	await deleteAtlasJobsForUser(userId);

	const ownershipScope = await getArtifactOwnershipScope(userId);
	const artifactRows = await db
		.select({ id: artifacts.id })
		.from(artifacts)
		.where(buildArtifactVisibilityCondition({ userId, ownershipScope }));
	const artifactIds = artifactRows.map((row) => row.id);
	if (artifactIds.length > 0) {
		await hardDeleteArtifactsForUser(userId, artifactIds);
	}

	await rm(join(process.cwd(), "data", "knowledge", userId), {
		recursive: true,
		force: true,
	});

	await db.transaction((tx) => {
		tx.delete(sessions).where(eq(sessions.userId, userId)).run();
		tx.delete(browserPushSubscriptions)
			.where(eq(browserPushSubscriptions.userId, userId))
			.run();
		tx.delete(chatGeneratedFiles)
			.where(eq(chatGeneratedFiles.userId, userId))
			.run();
		tx.delete(conversationDrafts)
			.where(eq(conversationDrafts.userId, userId))
			.run();
		tx.delete(taskStateEvidenceLinks)
			.where(eq(taskStateEvidenceLinks.userId, userId))
			.run();
		tx.delete(taskCheckpoints).where(eq(taskCheckpoints.userId, userId)).run();
		tx.delete(memoryProjectTaskLinks)
			.where(eq(memoryProjectTaskLinks.userId, userId))
			.run();
		tx.delete(conversationTaskStates)
			.where(eq(conversationTaskStates.userId, userId))
			.run();
		tx.delete(memoryProjects).where(eq(memoryProjects.userId, userId)).run();
		tx.delete(memoryEvents).where(eq(memoryEvents.userId, userId)).run();
		tx.delete(semanticEmbeddings)
			.where(eq(semanticEmbeddings.userId, userId))
			.run();
		tx.delete(conversationWorkingSetItems)
			.where(eq(conversationWorkingSetItems.userId, userId))
			.run();
		tx.delete(conversationContextStatus)
			.where(eq(conversationContextStatus.userId, userId))
			.run();
		tx.delete(projects).where(eq(projects.userId, userId)).run();
		tx.delete(conversations).where(eq(conversations.userId, userId)).run();
	});
}

export async function deleteUserAccountWithCleanup(
	userId: string,
	password: string,
): Promise<DeleteUserAccountResult> {
	const [user] = await db.select().from(users).where(eq(users.id, userId));
	if (!user) {
		return { status: "not_found" };
	}

	const valid = await verifyPassword(password, user.passwordHash);
	if (!valid) {
		return { status: "incorrect_password" };
	}

	await purgeUserData(userId);
	await rm(join(process.cwd(), "data", "avatars", `${userId}.webp`), {
		force: true,
	});

	await db.delete(users).where(eq(users.id, userId));
	return { status: "deleted" };
}

export async function deleteUserAccountAsAdminWithCleanup(
	userId: string,
): Promise<boolean> {
	const [user] = await db.select().from(users).where(eq(users.id, userId));
	if (!user) {
		return false;
	}

	await purgeUserData(userId);
	await rm(join(process.cwd(), "data", "avatars", `${userId}.webp`), {
		force: true,
	});

	await db.delete(users).where(eq(users.id, userId));
	return true;
}

export async function resetUserAccountStateWithCleanup(
	userId: string,
	password: string,
): Promise<ResetUserAccountResult> {
	const [user] = await db.select().from(users).where(eq(users.id, userId));
	if (!user) {
		return { status: "not_found" };
	}

	const valid = await verifyPassword(password, user.passwordHash);
	if (!valid) {
		return { status: "incorrect_password" };
	}

	await purgeUserData(userId);

	return { status: "reset" };
}
