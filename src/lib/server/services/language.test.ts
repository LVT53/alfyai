import { describe, expect, it } from 'vitest';
import { detectLanguage } from './language';

describe('detectLanguage', () => {
	it('defaults empty input to English', () => {
		expect(detectLanguage('')).toBe('en');
	});

	it('uses the old short-input fallback for Hungarian short words', () => {
		expect(detectLanguage('Szia')).toBe('hu');
		expect(detectLanguage('igen')).toBe('hu');
		expect(detectLanguage('hello')).toBe('en');
	});

	it('detects accented Hungarian text as Hungarian', () => {
		expect(detectLanguage('Kérlek írj egy rövid emailt.')).toBe('hu');
	});

	it('detects mixed Hungarian prompts without accents', () => {
		expect(detectLanguage('Irj egy angol emailt')).toBe('hu');
		expect(detectLanguage('Valaszolj angolul egy rovid levelben')).toBe('hu');
	});

	it('keeps plain English prompts as English', () => {
		expect(detectLanguage('Write a short email in English')).toBe('en');
		expect(detectLanguage('Hello, tell me about artificial intelligence')).toBe('en');
	});

	it('detects mixed Hungarian-English prompts as Hungarian', () => {
		expect(detectLanguage('Szeretnék egy CSV fájlt generálni az adatokból')).toBe('hu');
		expect(detectLanguage('Kérlek készíts egy reportot a Q4 eredményekről')).toBe('hu');
		expect(detectLanguage('Írj egy Python scriptet ami letölti a fájlokat')).toBe('hu');
	});

	it('detects short Hungarian inputs without diacritics as Hungarian when they contain Hungarian function words', () => {
		expect(detectLanguage('Irj egy emailt')).toBe('hu');
		expect(detectLanguage('Mondd el mi a helyzet')).toBe('hu');
		expect(detectLanguage('Valaszolj angolul')).toBe('hu');
	});

	it('detects real-world Hungarian sentences as Hungarian', () => {
		expect(detectLanguage('Hogyan tudom beállítani a környezeti változókat Linux alatt?')).toBe('hu');
		expect(detectLanguage('Mi a legjobb gyakorlat React komponensek tesztelésére?')).toBe('hu');
		expect(detectLanguage('Kérlek magyarázd el a különbséget a REST és GraphQL között')).toBe('hu');
	});

	it('keeps plain English prompts as English even with Hungarian-like substrings', () => {
		expect(detectLanguage('Write a report about the Hungarian parliament')).toBe('en');
		expect(detectLanguage('How do I configure the environment variables?')).toBe('en');
	});
});
