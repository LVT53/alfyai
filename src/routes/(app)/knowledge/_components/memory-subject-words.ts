import type { I18nKey } from "$lib/i18n";
import type { MemorySubjectKey } from "$lib/memory-types";

/** The dictionary key of a subject's name; `all` is the Earlier list across subjects. */
export function subjectWordKey(subject: MemorySubjectKey): I18nKey {
	return subject === "all"
		? "memorySubjects.earlier"
		: (`memorySubjects.subject.${subject}` as I18nKey);
}
