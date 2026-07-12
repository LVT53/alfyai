import { describe, expect, it } from "vitest";

// C2 safety net — pins the EXACT set of write executors that get registered as
// a side effect of loading the pending-writes module. confirmPendingWrite
// (pending-writes.ts) dispatches confirms purely through the write-executors
// registry, and each provider's registerWriteExecutor(...) runs only because
// pending-writes.ts side-effect-imports that provider's module. Every
// per-provider *.test.ts imports its own provider directly, so if a merged read
// module ever silently dropped off pending-writes.ts's import list, ALL those
// suites would still pass while that provider's confirms broke in prod (the
// only path in prod that loads the executor is via pending-writes.ts). This
// test is the one place that asserts, against the REAL registrations (no
// __resetWriteExecutorsForTest, no direct provider import), that the load path
// wires up exactly the providers we expect.
//
// Deliberately in its own file with NO registry reset and NO direct provider
// imports so the ONLY thing populating the registry is pending-writes.ts's
// side-effect imports — importing ./pending-writes below is what triggers them.
import "./pending-writes";
import { listRegisteredWriteExecutorProviders } from "./write-executors";

describe("pending-writes write-executor registration set", () => {
	it("registers exactly the expected providers as a side effect of loading pending-writes", () => {
		const providers = new Set(listRegisteredWriteExecutorProviders());
		expect(providers).toEqual(
			new Set(["nextcloud", "google", "apple", "imap", "immich"]),
		);
	});
});
