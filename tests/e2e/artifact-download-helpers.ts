import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import {
	artifacts,
	chatGeneratedFiles,
	conversations,
	fileProductionJobFiles,
	fileProductionJobs,
	users,
} from "../../src/lib/server/db/schema";
import {
	createArtifact,
	createDocumentArtifact,
} from "../../src/lib/server/services/artifacts";
import { storeGeneratedFile } from "../../src/lib/server/services/chat-files";

/**
 * What the download specs seed: a Document and an App in a conversation of the
 * admin's own, and the job an App's Download would have run in the sandbox (this
 * Mac, and the gate's server, have no Docker), already succeeded, with its file.
 */

export const TITLE = "Bécsi hétvégi útiterv";
const MARKDOWN = [
	`# ${TITLE}`,
	"",
	"Szombat: Naschmarkt, aztán az Albertina.",
	"",
	"- Schönbrunn",
	"- Belvedere",
].join("\n");
export const APP_HTML =
	'<!doctype html><html><head><title>Tip</title></head><body><p id="x">tip app</p></body></html>';
export const APP_TITLE = "Borravaló-kalkulátor";

async function adminId(): Promise<string> {
	const [user] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, "admin@local"));
	return user.id;
}

async function seedConversation(incognito = false): Promise<string> {
	const conversationId = randomUUID();
	const now = new Date();
	await db.insert(conversations).values({
		id: conversationId,
		userId: await adminId(),
		title: "Download chat",
		memoryIncognito: incognito,
		createdAt: now,
		updatedAt: now,
	});
	return conversationId;
}

export async function seedDocument(incognito = false): Promise<{
	conversationId: string;
	artifactId: string;
}> {
	const conversationId = await seedConversation(incognito);
	const created = await createDocumentArtifact({
		userId: await adminId(),
		conversationId,
		title: TITLE,
		markdown: MARKDOWN,
		author: "alfy",
		summary: "Seeded for E2E",
	});
	return { conversationId, artifactId: created.id };
}

export async function seedApp(): Promise<{ conversationId: string }> {
	const conversationId = await seedConversation();
	const made = await createArtifact({
		userId: await adminId(),
		conversationId,
		kind: "app",
		title: APP_TITLE,
		body: APP_HTML,
		author: "alfy",
		versionSummary: "Seeded for E2E",
	});
	if (!made.ok) throw new Error(`could not seed the App: ${made.reason}`);
	return { conversationId };
}

/** The job an App's Download would have run in the sandbox, already succeeded: a stored file and the rows that say a job made it. */
export async function seedSucceededAppJob(conversationId: string) {
	const userId = await adminId();
	const stored = await storeGeneratedFile(conversationId, userId, {
		filename: "app.html",
		mimeType: "text/html",
		content: Buffer.from(APP_HTML, "utf8"),
		assistantMessageId: null,
	});
	const jobId = randomUUID();
	const now = new Date();
	await db.insert(fileProductionJobs).values({
		id: jobId,
		conversationId,
		assistantMessageId: null,
		userId,
		title: `${APP_TITLE} — app source`,
		status: "succeeded",
		origin: "artifact_export",
		sourceMode: "program",
		createdAt: now,
		updatedAt: now,
		completedAt: now,
	});
	await db.insert(fileProductionJobFiles).values({
		id: randomUUID(),
		jobId,
		chatGeneratedFileId: stored.id,
		sortOrder: 0,
		createdAt: now,
	});
	return { jobId, job: jobDto(jobId, conversationId, "queued") };
}

export function jobDto(
	id: string,
	conversationId: string,
	status: "queued" | "failed",
) {
	return {
		id,
		conversationId,
		assistantMessageId: null,
		title: `${APP_TITLE} — app source`,
		status,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		files: [],
		warnings: [],
		dismissed: false,
		sourceMode: "program",
		error:
			status === "failed"
				? {
						code: "sandbox_unavailable",
						message: "no sandbox",
						retryable: true,
					}
				: null,
	};
}

/** The bytes of a Playwright download. */
export async function bytesOf(download: {
	createReadStream(): Promise<NodeJS.ReadableStream | null>;
}): Promise<Buffer> {
	const stream = await download.createReadStream();
	if (!stream) throw new Error("the download has no body");
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks);
}

/** Takes a seeded conversation and everything the download specs made in it, so the next spec on this worker's database meets none of it. */
export async function cleanUpConversation(
	conversationId: string,
): Promise<void> {
	await db
		.delete(fileProductionJobs)
		.where(eq(fileProductionJobs.conversationId, conversationId));
	await db
		.delete(chatGeneratedFiles)
		.where(eq(chatGeneratedFiles.conversationId, conversationId));
	await db
		.delete(artifacts)
		.where(eq(artifacts.conversationId, conversationId));
	await db.delete(conversations).where(eq(conversations.id, conversationId));
}
