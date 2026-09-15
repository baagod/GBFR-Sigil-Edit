/*
  The tool's own copy, in each language it ships.

  Kept as a plain object rather than an i18n library: there are twenty strings and
  three languages, so a dependency would be more machinery than the problem.

  Trait names are NOT here - those come from the game's own text tables, one per
  language, and are fetched from the Go side.

  The wording differs per language on purpose: the thing being edited is a trait a
  sigil carries, which the game's own data calls a "skill" (table `skill_status`),
  so Japanese keeps スキル and English says sigil traits; Chinese labels the list
  因子选择. The picker's own placeholder is just "..." in every language - the
  label beside it already says what it is for.
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
  title: (enabled: number, total: number) => string;
  empty: string;
  add: string;
  pickTrait: string;
  searchTrait: string;
  noMatch: string;
  ok: string;
  enable: (name: string) => string;
  remove: (name: string) => string;
  level: string;
  readFailed: string;
  writeFailed: string;
};

export const MESSAGES: Record<Lang, Dict> = {
  zh: {
    title: (enabled, total) => `因子选择（${enabled}/${total}）：`,
    empty: "没有改动条目。",
    add: "添加",
    pickTrait: "...",
    searchTrait: "搜索因子",
    noMatch: "没有匹配的因子",
    ok: "确定",
    enable: (name) => `启用 ${name}`,
    remove: (name) => `删除 ${name}`,
    level: "等级",
    readFailed: "读取失败",
    writeFailed: "写入失败",
  },
  en: {
    title: (enabled, total) => `Sigil traits (${enabled}/${total}):`,
    empty: "No edits yet.",
    add: "Add",
    pickTrait: "...",
    searchTrait: "Search traits",
    noMatch: "No matching trait",
    ok: "OK",
    enable: (name) => `Enable ${name}`,
    remove: (name) => `Remove ${name}`,
    level: "Level",
    readFailed: "Could not read",
    writeFailed: "Could not write",
  },
  ja: {
    title: (enabled, total) => `スキル（${enabled}/${total}）：`,
    empty: "変更はまだありません。",
    add: "追加",
    pickTrait: "...",
    searchTrait: "スキル名で検索",
    noMatch: "一致するスキルがありません",
    ok: "OK",
    enable: (name) => `${name} を有効にする`,
    remove: (name) => `${name} を削除`,
    level: "レベル",
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
