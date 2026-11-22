import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { createImageFixture, type ImageFixture } from "../testing/fixture";

let fixture: ImageFixture;
let db: typeof import("$lib/server/db").db;
let policy: typeof import("./policy");
let configStore: typeof import("$lib/server/config-store");

beforeAll(async () => {
	fixture = createImageFixture("picture-check-policy");
	process.env.DATABASE_PATH = fixture.dbPath;
	vi.resetModules();
	db = (await import("$lib/server/db")).db;
	policy = await import("./policy");
	configStore = await import("$lib/server/config-store");
	fixture.seedUser("filtered");
	fixture.seedUser("exempt");
	fixture.sqlite
		.prepare(
			"update users set explicit_picture_filter_exempt = 1 where id = 'exempt'",
		)
		.run();
});

afterAll(() => fixture.cleanup());

beforeEach(() => {
	configStore.getConfig().imageExplicitFilterEnabled = true;
});

describe("whose pictures are checked", () => {
	it("checks everyone by default", async () => {
		expect(await policy.isExplicitFilterOnFor("filtered")).toBe(true);
	});

	it("leaves a person an admin exempted alone", async () => {
		expect(await policy.isExplicitFilterOnFor("exempt")).toBe(false);
	});

	it("checks nobody once the filter is off for the whole install", async () => {
		configStore.getConfig().imageExplicitFilterEnabled = false;
		expect(await policy.isExplicitFilterOnFor("filtered")).toBe(false);
		expect(await policy.isExplicitFilterOnFor("exempt")).toBe(false);
	});

	it("checks a person it cannot find (fails closed)", async () => {
		expect(await policy.isExplicitFilterOnFor("nobody")).toBe(true);
	});
});

describe("the second engine variant", () => {
	it("grants the second variant to an exempt person while the filter is on", async () => {
		// explicitPictureFilterExempt = true, imageExplicitFilterEnabled = true
		expect(await policy.isUserExplicitExempt("exempt")).toBe(true);
		expect(await policy.isExplicitVariantAllowedFor("exempt")).toBe(true);
		expect(await policy.isExplicitFilterOnFor("exempt")).toBe(false);
	});

	it("keeps the second variant off when the install filter is disabled", async () => {
		// imageExplicitFilterEnabled = false, person NOT exempt
		configStore.getConfig().imageExplicitFilterEnabled = false;
		expect(await policy.isExplicitVariantAllowedFor("filtered")).toBe(false);
	});

	it("fails closed to the first variant when the person cannot be read", async () => {
		// force the db read to throw
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const unreadable = vi.spyOn(db, "select").mockImplementation(() => {
			throw new Error("read failed");
		});
		expect(await policy.isExplicitVariantAllowedFor("exempt")).toBe(false);
		expect(await policy.isExplicitFilterOnFor("exempt")).toBe(true);
		unreadable.mockRestore();
		warn.mockRestore();
	});
});
