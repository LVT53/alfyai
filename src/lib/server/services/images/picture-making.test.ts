import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createImageFixture, type ImageFixture } from "./testing/fixture";

let fixture: ImageFixture;
let pictureMaking: typeof import("./picture-making");

beforeAll(async () => {
	fixture = createImageFixture("picture-making");
	process.env.DATABASE_PATH = fixture.dbPath;
	vi.resetModules();
	pictureMaking = await import("./picture-making");
	fixture.seedUser("keeps-it-on");
	fixture.seedUser("switched-off");
	fixture.sqlite
		.prepare(
			"update users set pictures_and_videos_enabled = 0 where id = 'switched-off'",
		)
		.run();
});

afterAll(() => fixture.cleanup());

describe("whether Alfy may make pictures and videos for a person", () => {
	it("may for a person who never touched the switch", async () => {
		expect(await pictureMaking.isPictureMakingOnFor("keeps-it-on")).toBe(true);
	});

	it("may not for a person who switched it off", async () => {
		expect(await pictureMaking.isPictureMakingOnFor("switched-off")).toBe(
			false,
		);
	});

	it("reads each person's own switch: one person's off changes nothing for another", async () => {
		const [first, second] = await Promise.all([
			pictureMaking.isPictureMakingOnFor("switched-off"),
			pictureMaking.isPictureMakingOnFor("keeps-it-on"),
		]);
		expect(first).toBe(false);
		expect(second).toBe(true);
	});

	it("keeps the default (on) for a person it cannot read", async () => {
		expect(await pictureMaking.isPictureMakingOnFor("nobody")).toBe(true);
	});
});
