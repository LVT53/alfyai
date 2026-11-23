import { writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { bootEngine } from "../jobs/testing/harness";
import {
	buildLiveAccount,
	LIVE_PROBE_BARS,
	LIVE_PROJECT_NAMES,
	type LiveProbeCategory,
	type LiveScope,
} from "./native-recall-live.test-helpers";

// Explicit synthetic-only acceptance, like native-live: the normal gates skip
// it. Against the pinned non-production Hindsight (an SSH tunnel on
// 127.0.0.1:18890, which reaches Flash-Next through the admission gateway), it
// builds a sales-shaped invented account through the app's own job engine,
// runs every probe message through the per-turn recall, and erases its banks.
// It writes counts and timings only, never an entry's text.
const RESULTS =
	"docs/plans/hindsight-memory/native-acceptance/recall-part-1-live-results.json";

/** The nearest-rank percentile of a list of timings. */
function percentile(values: number[], q: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? 0;
}

describe.runIf(process.env.HINDSIGHT_NATIVE_ACCEPTANCE === "1")(
	"fair, message-aware recall on the pinned native service",
	() => {
		it("finds the probes' entries within each bar, in time, then erases the synthetic banks", async () => {
			const h = await bootEngine("native-recall-live");
			const cleanups: (() => Promise<void>)[] = [];
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
				const { readPublishedMemory } = await import("./publication");
				const { createProject } = await import("../projects");
				const { createConversation } = await import("../conversations");
				const { recallMemory } = await import("../memory-context/native");
				const { recallLineTokens } = await import(
					"../memory-context/recall-format"
				);
				const account = buildLiveAccount();
				const projectIds = {
					alpha: (await createProject(h.userId, LIVE_PROJECT_NAMES.alpha)).id,
					beta: (await createProject(h.userId, LIVE_PROJECT_NAMES.beta)).id,
				};
				const projectOf = (scope: LiveScope) =>
					scope === "personal" ? {} : { projectId: projectIds[scope] };
				const banks = {
					personal: rev.ensureMemoryBank(h.userId, { kind: "personal" }),
					alpha: rev.ensureMemoryBank(h.userId, {
						kind: "project",
						projectId: projectIds.alpha,
					}),
					beta: rev.ensureMemoryBank(h.userId, {
						kind: "project",
						projectId: projectIds.beta,
					}),
				};
				db.update(schema.memoryAccounts).set({ authority: "hindsight" }).run();
				const memoryAccount = rev.getMemoryAccount(h.userId);
				if (!memoryAccount) throw new Error("Synthetic account missing");
				for (const bank of Object.values(banks)) {
					const client = clientModule.nativeMemoryClient(
						bank.id,
						memoryAccount.tenantId,
					);
					cleanups.push(() => client.deleteBank());
				}

				// Delivered through the app's own job engine, ten facts a source.
				for (const [index, source] of account.sources.entries()) {
					const bank = banks[source.scope];
					const recorded = rev.recordMemorySource({
						userId: h.userId,
						bankId: bank.id,
						epoch: memoryAccount.epoch,
						eventId: `recall-live-${index}`,
						lineageId: `recall-live-message-${index}`,
						text: source.text,
						context:
							source.scope === "personal"
								? "The user explicitly states this about themselves."
								: "The user states this about a project they are working on.",
						assertedAt: new Date(Date.UTC(2026, 5, 1) + index * 86_400_000),
					});
					await jobs.enqueueMemoryDelivery({
						userId: h.userId,
						bankId: bank.id,
						epoch: memoryAccount.epoch,
						kind: "source",
						sourceId: recorded.id,
						requestId: `recall-live-request-${index}`,
					});
					await h.engine.drain(jobs.memoryDeliveryJob);
				}
				const deliveries = db.select().from(schema.memoryDeliveryJobs).all();
				const published = {
					personal: readPublishedMemory(h.userId, banks.personal.id),
					alpha: readPublishedMemory(h.userId, banks.alpha.id),
					beta: readPublishedMemory(h.userId, banks.beta.id),
				};
				// Half the person's published tokens, so their entries alone
				// would fill it twice over.
				const budget = Math.floor(
					published.personal.reduce(
						(sum, row) => sum + recallLineTokens(row.text),
						0,
					) / 2,
				);

				const info = vi.spyOn(console, "info");
				const found: Record<LiveProbeCategory, number> = {
					exact: 0,
					project_topic: 0,
					personal_topic: 0,
					cross_language: 0,
					follow_up: 0,
					date: 0,
					long: 0,
				};
				const asked: Record<LiveProbeCategory, number> = { ...found };
				const holds = (text: string, marker: string) =>
					text.toLowerCase().includes(marker.toLowerCase());
				for (const probe of account.probes) {
					const chat = await createConversation(
						h.userId,
						probe.title,
						projectOf(probe.scope),
					);
					const recalled = await recallMemory(h.userId, {
						conversationId: chat.id,
						query: probe.message,
						tokenBudget: budget,
						core: true,
					});
					asked[probe.category] += 1;
					if (
						recalled.some((entry) =>
							probe.targets.some((marker) => holds(entry.text, marker)),
						)
					)
						found[probe.category] += 1;
				}
				// A message quoting an entry's exact text brings that entry back.
				for (const exact of account.exactMarkers) {
					asked.exact += 1;
					const entry = published[exact.scope].find((row) =>
						holds(row.text, exact.marker),
					);
					if (!entry) continue;
					const chat = await createConversation(
						h.userId,
						"Synthetic recall check",
						projectOf(exact.scope),
					);
					const recalled = await recallMemory(h.userId, {
						conversationId: chat.id,
						query: entry.text,
						tokenBudget: budget,
						core: true,
					});
					if (recalled.some(({ ref }) => ref.rowId === entry.nativeId))
						found.exact += 1;
				}

				const lines = info.mock.calls
					.filter(([tag]) => tag === "[KNOWLEDGE_MEMORY] Recall")
					.map(
						([, summary]) =>
							summary as { bank: string; timedOut: number; slowestMs: number },
					);
				const timeouts = lines.reduce((sum, line) => sum + line.timedOut, 0);
				const latency = Object.fromEntries(
					["personal", "project"].map((bank) => {
						const timings = lines
							.filter((line) => line.bank === bank)
							.map((line) => line.slowestMs);
						return [
							bank,
							{
								recalls: timings.length,
								medianMs: percentile(timings, 0.5),
								p95Ms: percentile(timings, 0.95),
							},
						];
					}),
				);
				const categories = Object.fromEntries(
					(Object.keys(found) as LiveProbeCategory[]).map((category) => [
						category,
						{
							asked: asked[category],
							found: found[category],
							bar: LIVE_PROBE_BARS[category],
							pass: found[category] >= LIVE_PROBE_BARS[category],
						},
					]),
				);
				// Counts and timings only.
				writeFileSync(
					RESULTS,
					`${JSON.stringify(
						{
							at: new Date().toISOString(),
							facts: {
								personal: account.facts.filter((f) => f.scope === "personal")
									.length,
								alpha: account.facts.filter((f) => f.scope === "alpha").length,
								beta: account.facts.filter((f) => f.scope === "beta").length,
							},
							deliveries: {
								total: deliveries.length,
								succeeded: deliveries.filter(
									(row) => row.status === "succeeded",
								).length,
							},
							published: {
								personal: published.personal.length,
								alpha: published.alpha.length,
								beta: published.beta.length,
							},
							budgetTokens: budget,
							categories,
							timeouts,
							latency,
						},
						null,
						2,
					)}\n`,
				);

				expect(deliveries.every((row) => row.status === "succeeded")).toBe(
					true,
				);
				for (const [category, result] of Object.entries(categories))
					expect(result.found, category).toBeGreaterThanOrEqual(result.bar);
				expect(timeouts).toBe(0);
				for (const [bank, result] of Object.entries(latency))
					expect(result.p95Ms, bank).toBeLessThan(2_000);
			} finally {
				try {
					for (const cleanup of cleanups) await cleanup();
				} finally {
					vi.restoreAllMocks();
					h.cleanup();
				}
			}
		}, 28_800_000);
	},
);
