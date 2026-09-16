/*
  The tool's own copy, in each language it ships.

  Kept as a plain object rather than an i18n library: a handful of strings in three
  languages, so a dependency would be more machinery than the problem.

  Trait names are NOT here - those come from the game's own text tables, one per
  language, and are fetched from the Go side.

  The wording differs per language on purpose: the thing being edited is a trait a
  sigil carries, which the game's own data calls a "skill" (table `skill_status`),
  so Japanese calls it シジル and the asset names stay as the game spells them. The
  search box's placeholder says what typing in it does, so the band above the list
  needs no label of its own.
*/

export const LANGS = ["zh", "en", "ja"] as const;
export type Lang = (typeof LANGS)[number];

/*
  Kept as short as it can be, and as text rather than flag emoji: Windows ships no
  flag glyphs, so a flag renders as two letters there anyway.
*/
export const LANG_LABEL: Record<Lang, string> = {
  zh: "中",
  en: "EN",
  ja: "JA",
};

type Dict = {
  searchTrait: string;
  clearSearch: string;
  noMatch: string;
  ok: string;
  enable: (name: string) => string;
  readFailed: string;
  writeFailed: string;
};

export const MESSAGES: Record<Lang, Dict> = {
  zh: {
    searchTrait: "搜索因子 | Hex",
    clearSearch: "清除",
    noMatch: "没有匹配的因子",
    ok: "确定",
    enable: (name) => `启用 ${name}`,
    readFailed: "读取失败",
    writeFailed: "写入失败",
  },
  en: {
    searchTrait: "Search sigil | Hex",
    clearSearch: "Clear",
    noMatch: "No matching sigil",
    ok: "OK",
    enable: (name) => `Enable ${name}`,
    readFailed: "Could not read",
    writeFailed: "Could not write",
  },
  ja: {
    searchTrait: "シジル | Hex で検索",
    clearSearch: "クリア",
    noMatch: "一致するシジルがありません",
    ok: "OK",
    enable: (name) => `${name} を有効にする`,
    readFailed: "読み込みに失敗しました",
    writeFailed: "書き込みに失敗しました",
  },
};

const STORAGE_KEY = "lang";

/** What the OS asks for, narrowed to the languages we actually ship. */
export function initialLang(): Lang {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && (LANGS as readonly string[]).includes(saved)) {
    return saved as Lang;
  }
  const preferred = navigator.language.toLowerCase();
  if (preferred.startsWith("ja")) return "ja";
  if (preferred.startsWith("zh")) return "zh";
  return "en";
}

export function rememberLang(lang: Lang) {
  localStorage.setItem(STORAGE_KEY, lang);
}
