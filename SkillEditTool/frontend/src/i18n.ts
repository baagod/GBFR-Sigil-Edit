/*
  The tool's own copy, in each language it ships.

  Kept as a plain object rather than an i18n library: there are twenty strings and
  three languages, so a dependency would be more machinery than the problem.

  Skill names are NOT here - those come from the game's own text tables, one per
  language, and are fetched from the Go side.
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
  pickSkill: string;
  searchSkill: string;
  noMatch: string;
  install: string;
  chooseReloaded: string;
  ok: string;
  enable: (name: string) => string;
  remove: (name: string) => string;
  level: string;
  readFailed: string;
  writeFailed: string;
  chooseFailed: string;
};

export const MESSAGES: Record<Lang, Dict> = {
  zh: {
    title: (enabled, total) => `技能（${enabled}/${total}）：`,
    empty: "没有改动条目。",
    add: "添加",
    pickSkill: "选择技能…",
    searchSkill: "搜索技能名",
    noMatch: "没有匹配的技能",
    install: "安装 Mod",
    chooseReloaded: "选择 Reloaded-II 目录",
    ok: "确定",
    enable: (name) => `启用 ${name}`,
    remove: (name) => `删除 ${name}`,
    level: "等级",
    readFailed: "读取失败",
    writeFailed: "写入失败",
    chooseFailed: "选择目录失败",
  },
  en: {
    title: (enabled, total) => `Skills (${enabled}/${total}):`,
    empty: "No edits yet.",
    add: "Add",
    pickSkill: "Pick a skill…",
    searchSkill: "Search skills",
    noMatch: "No matching skill",
    install: "Install mod",
    chooseReloaded: "Select Reloaded-II folder",
    ok: "OK",
    enable: (name) => `Enable ${name}`,
    remove: (name) => `Remove ${name}`,
    level: "Level",
    readFailed: "Could not read",
    writeFailed: "Could not write",
    chooseFailed: "Could not use that folder",
  },
  ja: {
    title: (enabled, total) => `スキル（${enabled}/${total}）：`,
    empty: "変更はまだありません。",
    add: "追加",
    pickSkill: "スキルを選択…",
    searchSkill: "スキル名で検索",
    noMatch: "一致するスキルがありません",
    install: "Mod をインストール",
    chooseReloaded: "Reloaded-II のフォルダを選ぶ",
    ok: "OK",
    enable: (name) => `${name} を有効にする`,
    remove: (name) => `${name} を削除`,
    level: "レベル",
    readFailed: "読み込みに失敗しました",
    writeFailed: "書き込みに失敗しました",
    chooseFailed: "フォルダを設定できませんでした",
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
