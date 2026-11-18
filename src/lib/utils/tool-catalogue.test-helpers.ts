import { readFileSync } from "node:fs";

// The model's tool catalogue, as the frozen snapshot holds it
// (`normal-chat-tools/index.test.ts` writes the file). A test that needs "every tool
// the model can call" reads the names from it, so a new tool fails the test that
// owns its words the day it is added to the catalogue.
const CATALOGUE_SNAPSHOT = `${process.cwd()}/src/lib/server/services/normal-chat-tools/tool-catalogue.en.snapshot.txt`;

function readSnapshot(): string {
	return readFileSync(CATALOGUE_SNAPSHOT, "utf8");
}

/** The names of the tools the model is offered, in the order its request sends them. */
export function catalogueToolNames(): string[] {
	return [...readSnapshot().matchAll(/^ {6}"name": "([a-z_]+)"/gm)].map(
		(match) => match[1],
	);
}
