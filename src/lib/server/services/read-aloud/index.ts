// The read-aloud service's public surface for routes. Routes import from here,
// never from the files behind it.

export { wordsFitReply } from "./containment";
export {
	createPersonalVoice,
	deletePersonalVoice,
	type PersonalVoice,
	type ReadAloudSettings,
	readAloudSettingsFor,
	resolveReadingVoices,
	setReadAloudPreferences,
	TooManyVoices,
	UnknownVoice,
	updatePersonalVoice,
	type VoiceChoice,
	type VoiceDraft,
} from "./personal-voices";
export {
	attachAudio,
	attachEvents,
	closeReading,
	currentReading,
	openReading,
	type Reading,
	reportPosition,
	takeOpenTicket,
} from "./readings";
export {
	charsPerSecondByLanguage,
	positionRequestSchema,
	type ReadingRequest,
	readingRequestSchema,
	speechSentencesFor,
} from "./request";
export {
	ReadingSuperseded,
	SpeechRefused,
	SpeechUnavailable,
} from "./speech-client";
export {
	knobsSchema,
	preferencesSchema,
	previewRequestSchema,
	readJsonBody,
	voiceDraftSchema,
	voicePatchSchema,
} from "./voice-requests";
export { listBuiltInVoices } from "./voices";
