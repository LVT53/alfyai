#!/usr/bin/env tsx
/**
 * Drain one account's Memory jobs to the end: retries each retryable failure
 * once, runs the account's jobs, waits out holds and waits on Hindsight
 * instead of stopping, for at most --max-minutes (default 60), and ends with a
 * summary of every job it did not finish and why. A dry run (counts only)
 * unless --execute; refuses the tester account (the permanent tester rule).
 * Leaves every other account's jobs to their workers. Run from this release's
 * checkout with the app's environment loaded.
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
