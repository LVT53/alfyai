#!/usr/bin/env tsx
/**
 * Resend one chat's Memory delivery under a new operation: for a delivery that
 * failed for good because its retain never landed in Hindsight. A dry run
 * unless --execute; refuses the tester account (the permanent tester rule).
 * Prints every step's result and the report (counts and ids only). Run from
 * this release's checkout with the app's environment loaded.
 *
 * --delete-landed also takes a chat whose retain did land (its operation
 * completed and its document holds facts, which hold up the bank's later
 * deliveries): it deletes that document in Hindsight, waits for the bank to go
 * quiet, checks that no fact is left under it, then sends the chat again as
 * a new, unacknowledged delivery. The dry run reports the facts it would delete.
 *
 *   npx tsx scripts/memory-resend.ts --user <id> --job <delivery job id> [--delete-landed] [--execute]
 */
import { resendDelivery } from "../src/lib/server/services/memory-profile/operator-tools";
import { runOperatorCli } from "./memory-operator-cli";

// The shared parser knows no switch but --execute: this one is the tool's own.
const deleteLanded = process.argv.includes("--delete-landed");
process.argv = process.argv.filter((arg) => arg !== "--delete-landed");

await runOperatorCli(
	"job",
	"usage: npx tsx scripts/memory-resend.ts --user <id> --job <id> [--delete-landed] [--execute]",
	(args) =>
		resendDelivery({
			userId: args.user,
			jobId: args.job as string,
			execute: args.execute,
			deleteLanded,
		}),
);
