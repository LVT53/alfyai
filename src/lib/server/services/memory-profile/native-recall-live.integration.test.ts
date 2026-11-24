import { writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { bootEngine } from "../jobs/testing/harness";
import { isTerminalJobStatus, JOB_STATUSES } from "../jobs/types";
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
// It writes counts and timings only, never an entry's text. Run it with
// `--reporter=verbose` to see its progress lines.
const RESULTS =
	"docs/plans/hindsight-memory/native-acceptance/recall-part-1-live-results.json";
/** How long deliveries still waiting on a retry get to finish. */
const SETTLE_MS = 2 * 60 * 60 * 1_000;
const SETTLE_POLL_MS = 30_000;
const HALF_DAY_MS = 12 * 60 * 60 * 1_000;

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
				for (const [scope, bank] of Object.entries(banks)) {
					const client = clientModule.nativeMemoryClient(
						bank.id,
						memoryAccount.tenantId,
					);
					cleanups.push(async () => {
						try {
							await client.deleteBank();
						} catch (error) {
							// One bank that cannot be erased must not keep the others.
							console.error(
								`[recall-live] could not erase the synthetic ${scope} bank`,
								error instanceof Error ? error.name : "unknown error",
							);
						}
					});
				}

				// Delivered through the app's own job engine, ten facts a source.
				// The date probes say "Last March I told you", so every source is
				// dated in March 2026, twelve hours apart.
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
						assertedAt: new Date(Date.UTC(2026, 2, 1) + index * HALF_DAY_MS),
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
					console.log(
						`[recall-live] delivered source ${index + 1} of ${account.sources.length}`,
					);
				}
				// A delivery waiting on a retry is not claimable when drain runs,
				// so give the retries their time before judging delivery.
				const statuses = () =>
					db
						.select({ status: schema.memoryDeliveryJobs.status })
						.from(schema.memoryDeliveryJobs)
						.all()
						.map(({ status }) => status);
				const settleBy = Date.now() + SETTLE_MS;
				for (
					let pending = statuses().filter(
						(s) => !isTerminalJobStatus(s),
					).length;
					pending > 0 && Date.now() < settleBy;
					pending = statuses().filter((s) => !isTerminalJobStatus(s)).length
				) {
					console.log(
						`[recall-live] ${pending} deliveries still pending; waiting for their retries`,
					);
					await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
					await h.engine.drain(jobs.memoryDeliveryJob);
				}
				const deliveries = Object.fromEntries(
					JOB_STATUSES.map((status) => [
						status,
						statuses().filter((s) => s === status).length,
					]),
				) as Record<(typeof JOB_STATUSES)[number], number>;

				// Recall is probed whatever delivery did: a fact that was never
				// published counts against "reachable", not against recall.
				const published = {
					personal: readPublishedMemory(h.userId, banks.personal.id),
					alpha: readPublishedMemory(h.userId, banks.alpha.id),
					beta: readPublishedMemory(h.userId, banks.beta.id),
				};
				// Half the person's published tokens, so their entries alone
				// would fill it twice over.
				const budget = Math.floor(
					published.personal.reduce(
						(sum, row) =>
							sum +
							// An unlabelled row said today: the most part 1 budgeted per row.
							recallLineTokens(
								{
									ref: {
										scope: { kind: "personal" },
										generation: row.generation,
										rowId: row.nativeId,
									},
									text: row.text,
									sources: [],
									lastMentionedAt: new Date().toISOString(),
								},
								new Date(),
							),
						0,
					) / 2,
				);
				const info = vi.spyOn(console, "info");
				const counts = (): Record<LiveProbeCategory, number> => ({
					exact: 0,
					project_topic: 0,
					personal_topic: 0,
					cross_language: 0,
					follow_up: 0,
					date: 0,
					long: 0,
				});
				const asked = counts();
				const reachable = counts();
				const found = counts();
				const holds = (text: string, marker: string) =>
					text.toLowerCase().includes(marker.toLowerCase());
				for (const [index, probe] of account.probes.entries()) {
					asked[probe.category] += 1;
					if (
						published[probe.scope].some((row) =>
							probe.targets.some((marker) => holds(row.text, marker)),
						)
					)
						reachable[probe.category] += 1;
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
					if (
						recalled.some((entry) =>
							probe.targets.some((marker) => holds(entry.text, marker)),
						)
					)
						found[probe.category] += 1;
					console.log(
						`[recall-live] probe ${index + 1} of ${account.probes.length} done`,
					);
				}
				// A message quoting an entry's exact text brings that entry back.
				for (const exact of account.exactMarkers) {
					asked.exact += 1;
					const entry = published[exact.scope].find((row) =>
						holds(row.text, exact.marker),
					);
					if (!entry) continue;
					reachable.exact += 1;
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
							reachable: reachable[category],
							found: found[category],
							bar: LIVE_PROBE_BARS[category],
							pass: found[category] >= LIVE_PROBE_BARS[category],
						},
					]),
				);
				// Counts and timings only, written before anything is judged.
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
							deliveries,
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

				// Delivery and recall are judged apart, and every verdict is
				// reported, not just the first that fails.
				expect
					.soft(deliveries.succeeded, "every delivery succeeded")
					.toBe(account.sources.length);
				for (const [category, result] of Object.entries(categories))
					expect
						.soft(result.found, category)
						.toBeGreaterThanOrEqual(result.bar);
				expect.soft(timeouts, "no search timed out").toBe(0);
				for (const [bank, result] of Object.entries(latency))
					expect.soft(result.p95Ms, bank).toBeLessThan(2_000);
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
