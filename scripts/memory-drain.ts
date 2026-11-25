#!/usr/bin/env tsx
/**
 * Drain one account's Memory jobs to the end: first takes back the account's
 * own jobs whose worker died (a drain stopped mid-attempt leaves one `running`
 * and holding the box's one Memory slot), retries each retryable failure once,
 * runs the account's jobs, waits out holds and waits on Hindsight instead of
 * stopping, and ends with a summary of every job it did not finish and why.
 * --max-minutes (default 60) ends the starting of work, not the finishing of
 * it: past it no job that was never attempted is started, but a job the drain
 * put back mid-flight is still resumed until it is done (at most both of
 * Hindsight's waits more), so none is left holding its bank. A dry run (counts
 * only) unless --execute; refuses the tester account (the permanent tester
 * rule). Leaves every other account's jobs to their workers. Run from this
 * release's checkout with the app's environment loaded.
 *
 *   npx tsx scripts/memory-drain.ts --user <id> [--max-minutes 60] [--execute]
 */
import { drainMemory } from "../src/lib/server/services/memory-profile/operator-tools";
import { runOperatorCli } from "./memory-operator-cli";

await runOperatorCli(
	"drain",
	"usage: npx tsx scripts/memory-drain.ts --user <id> [--max-minutes 60] [--execute]",
	(args) =>
		drainMemory({
			userId: args.user,
			maxMinutes: args.maxMinutes,
			execute: args.execute,
		}),
);
