import { writable } from "svelte/store";

// Tracks whether the current user has a profile picture, and a cache-buster
// timestamp so AvatarCircle always fetches the latest version after upload.
interface AvatarState {
	profilePicture: string | null; // userId string when set, null when unset
	cacheBuster: number;
}

const _avatar = writable<AvatarState>({ profilePicture: null, cacheBuster: 0 });

export const avatarState = { subscribe: _avatar.subscribe };

export function initAvatar(profilePicture: string | null) {
	_avatar.update((state) => ({ ...state, profilePicture }));
}

export function setAvatarUploaded(userId: string) {
	_avatar.set({ profilePicture: userId, cacheBuster: Date.now() });
}

export function setAvatarRemoved() {
	_avatar.update((s) => ({ ...s, profilePicture: null }));
}
