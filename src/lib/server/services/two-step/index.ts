/**
 * Two-step sign-in's public server boundary. Routes and the account services
 * (auth's sign-in path, user-admin's list and detail) import from here — not
 * from `store.ts` or `challenges.ts` directly — so the tables stay behind one
 * facade (spec §5.4).
 */

export type { SignInChallenge, SignInChallengeResult } from "./challenges";
export {
	ATTEMPT_TTL_MS,
	clearSignInAttemptCookie,
	consumeSignInChallenge,
	createSignInChallenge,
	findSignInChallengeAccount,
	hashSignInAttemptToken,
	MAX_TRIES,
	SIGN_IN_ATTEMPT_COOKIE,
	setSignInAttemptCookie,
} from "./challenges";
export type {
	DisableResult,
	RegenerateResult,
	SecondFactorInput,
	SecondFactorResult,
	SetupConfirmResult,
	SetupStartResult,
	TwoStepStatus,
} from "./store";
export {
	beginTwoStepSetup,
	confirmTwoStepSetup,
	countBackupCodesLeft,
	disableTwoStep,
	getTwoStepStatus,
	isTwoStepEnabled,
	listTwoStepEnabled,
	listTwoStepStatuses,
	regenerateBackupCodes,
	resetTwoStepForUser,
	sweepTwoStep,
	UNCONFIRMED_FACTOR_TTL_MS,
	verifySecondFactor,
} from "./store";
