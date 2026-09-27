import { useEffect } from 'react';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { resolveUiLanguage } from '../../api';
import {
  createUiTranslator,
  type UiDictionary,
  type UiTranslator,
} from '../../browser/ui-translator';
import zhCN from '../../browser/zh-CN.json';

declare global {
  interface Window {
    /** The running UI translator, for listing untranslated text from devtools. */
    __emdashUiTranslator?: UiTranslator;
  }
}

/** Applies the interface language setting: translates the page while it is Chinese. */
export function UiLanguage() {
  const { value } = useAppSettingsKey('language');
  const language = resolveUiLanguage(value, navigator.languages);

  useEffect(() => {
    document.documentElement.lang = language;
    if (language !== 'zh-CN') return;
    const translator: UiTranslator = createUiTranslator(zhCN as UiDictionary);
    translator.start();
    window.__emdashUiTranslator = translator;
    return () => {
      translator.stop();
      delete window.__emdashUiTranslator;
    };
  }, [language]);

  return null;
}
