import { writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { bootEngine } from "../jobs/testing/harness";

// Explicit synthetic-only acceptance. Normal gates do not start external services.
describe.runIf(process.env.HINDSIGHT_NATIVE_ACCEPTANCE === "1")(
	"pinned native service through the actual app job engine",
	() => {
		it("delivers EN/HU source revisions, publishes and recalls, then erases the synthetic bank", async () => {
			const h = await bootEngine("native-live");
			let cleanup: (() => Promise<void>) | undefined;
			try {
				const { db } = await import("$lib/server/db");
				const schema = await import("$lib/server/db/schema");
				const config = await import("$lib/server/config-store");
				vi.spyOn(config, "getConfig").mockReturnValue({
					...config.getConfig(),
					hindsightUrl: "http://127.0.0.1:18890",
					hindsightAllowedUrls: ["http://127.0.0.1:18890"],
					hindsightTenantMasterKeys: JSON.stringify({
						synthetic: "ab".repeat(32),
					}),
					hindsightTenantActiveKey: "synthetic",
					hindsightWorkerEnabled: true,
					hindsightConcurrency: 1,
				});
				const rev = await import("./revisions");
				const jobs = await import("./delivery-job");
				const clientModule = await import("./hindsight-client");
				const bank = rev.ensureMemoryBank(h.userId, { kind: "personal" });
				db.update(schema.memoryAccounts).set({ authority: "hindsight" }).run();
				const account = rev.getMemoryAccount(h.userId);
				if (!account) throw new Error("Synthetic account missing");
				const client = clientModule.nativeMemoryClient(
					bank.id,
					account.tenantId,
				);
				cleanup = () => client.deleteBank();
				for (const [index, text] of [
					"My kayak is purple. I keep it in the garage.",
					"Van egy Mák nevű macskám. Mák fekete.",
				].entries()) {
					const source = rev.recordMemorySource({
						userId: h.userId,
						bankId: bank.id,
						epoch: account.epoch,
						eventId: `event-${index}`,
						lineageId: `message-${index}`,
						text,
						context: "The user explicitly states this about themselves.",
						assertedAt: new Date("2026-11-18T12:00:00Z"),
					});
					await jobs.enqueueMemoryDelivery({
						userId: h.userId,
						bankId: bank.id,
						epoch: account.epoch,
						kind: "source",
						sourceId: source.id,
						requestId: `request-${index}`,
					});
					await h.engine.drain(jobs.memoryDeliveryJob);
				}
				const states = db.select().from(schema.memoryDeliveryJobs).all();
				const { listMemory } = await import("./native-read");
				const published = listMemory(h.userId, { scope: { kind: "personal" } });
				const recalled = await client.recall(
					"What do you know about my kayak and my cat?",
					2048,
				);
				const { createConversation } = await import("../conversations");
				const { recallMemory } = await import("../memory-context/native");
				const conversation = await createConversation(
					h.userId,
					"Synthetic native recall",
				);
				const admitted = await recallMemory(h.userId, {
					conversationId: conversation.id,
					query: "What do you know about my kayak and my cat?",
					tokenBudget: 2048,
				});
				writeFileSync(
					"docs/plans/hindsight-memory/native-acceptance/integrated-source-results.json",
					JSON.stringify({ states, published, recalled, admitted }, null, 2),
				);
				expect(states.map((row) => row.status)).toEqual([
					"succeeded",
					"succeeded",
				]);
				expect(JSON.stringify(published)).toMatch(/purple/i);
				expect(JSON.stringify(published)).toMatch(/Mák/i);
				expect(JSON.stringify(recalled)).toMatch(/purple/i);
				expect(JSON.stringify(recalled)).toMatch(/Mák/i);
				expect(JSON.stringify(admitted)).toMatch(/purple/i);
				expect(JSON.stringify(admitted)).toMatch(/Mák/i);
			} finally {
				try {
					await cleanup?.();
				} finally {
					vi.restoreAllMocks();
					h.cleanup();
				}
			}
		}, 360_000);
	},
);
