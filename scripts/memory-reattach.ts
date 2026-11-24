#!/usr/bin/env tsx
/**
 * Reattach a delivered document to its Memory job: for a delivery that failed
 * although Hindsight holds its chat's facts. The job is reopened and goes on
 * to consolidation and publication without sending the chat again. A dry run
 * unless --execute; refuses the tester account (the permanent tester rule).
 * Prints every step's result and the report (counts and ids only). Run from
 * this release's checkout with the app's environment loaded.
 *
 *   npx tsx scripts/memory-reattach.ts --user <id> --job <delivery job id> [--execute]
 */
import { reattachDelivery } from "../src/lib/server/services/memory-profile/operator-tools";
import { runOperatorCli } from "./memory-operator-cli";

await runOperatorCli(
	"job",
	"usage: npx tsx scripts/memory-reattach.ts --user <id> --job <id> [--execute]",
	(args) =>
		reattachDelivery({
			userId: args.user,
			jobId: args.job as string,
			execute: args.execute,
		}),
);
