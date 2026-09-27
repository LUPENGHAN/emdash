import { z } from 'zod';

/** The interface language: follow the system, or a fixed one. */
export const UI_LANGUAGES = ['system', 'en', 'zh-CN'] as const;
export type UiLanguage = (typeof UI_LANGUAGES)[number];

export const uiLanguageSchema = z.enum(UI_LANGUAGES).catch('system').default('system');

/** The language to show for a setting, given the system's preferred languages. */
export function resolveUiLanguage(
  setting: UiLanguage | undefined,
  systemLanguages: readonly string[]
): 'en' | 'zh-CN' {
  if (setting === 'en' || setting === 'zh-CN') return setting;
  return systemLanguages.some((language) => language.toLowerCase().startsWith('zh'))
    ? 'zh-CN'
    : 'en';
}
