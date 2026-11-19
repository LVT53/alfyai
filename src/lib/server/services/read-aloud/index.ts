// The read-aloud service's public surface for routes. Routes import from here,
// never from the files behind it.

export { wordsFitReply, wordsFitReport } from "./containment";
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
export { PreviewSuperseded, renderPreview } from "./preview";
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
export { readReportHtml } from "./report-html";
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
export { builtInVoice, listBuiltInVoices, resolvedVoice } from "./voices";
