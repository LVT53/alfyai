import { get } from "svelte/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	avatarState,
	initAvatar,
	setAvatarRemoved,
	setAvatarUploaded,
} from "./avatar";

describe("avatar store", () => {
	afterEach(() => {
		vi.useRealTimers();
		initAvatar(null);
	});

	it("does not cache-bust during normal layout initialization", () => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		setAvatarUploaded("user-1");
		const uploaded = get(avatarState);

		vi.setSystemTime(2000);
		initAvatar("user-1");

		expect(get(avatarState)).toEqual({
			profilePicture: "user-1",
			cacheBuster: uploaded.cacheBuster,
		});
	});

	it("updates the visible avatar after upload and removal", () => {
		vi.useFakeTimers();
		vi.setSystemTime(3000);

		setAvatarUploaded("user-2");
		expect(get(avatarState)).toEqual({
			profilePicture: "user-2",
			cacheBuster: 3000,
		});

		setAvatarRemoved();
		expect(get(avatarState)).toEqual({
			profilePicture: null,
			cacheBuster: 3000,
		});
	});
});
