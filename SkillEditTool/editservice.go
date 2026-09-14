package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// LevelValueCount is how many LevelValue slots skill_status carries, and therefore
// how many numbers describe one edit.
const LevelValueCount = 10

// SkillEdit mirrors the mod's Config.cs SkillEdit: one skill_status row override.
// Values maps positionally onto LevelValue1..10, which is what the skill's own
// description uses as {0}, {1}, {2} ...
type SkillEdit struct {
	Enabled bool      `json:"Enabled"`
	Key     string    `json:"Key"`
	Level   int       `json:"Level"`
	Values  []float64 `json:"Values"`
}

// Config mirrors the mod's Config.cs. The mod deserialises exactly this shape.
type Config struct {
	Edits []SkillEdit `json:"Edits"`
}

// modFolder is both the Reloaded-II folder name and the mod's ModId, matching
// this project's convention (GBFR.PreEquippedSigils does the same). It is not a
// Go identifier so it keeps its original casing.
const modFolder = "GBFR.SkillEdit"

// modDllName must match the assembly shipped in assets/.
const modDllName = "GBFR.SkillEdit.dll"

// EditService is the Wails-exposed backend.
type EditService struct {
	// app is only needed for the folder picker, which has to belong to a window.
	app *application.App
}

// ReloadedDir is the Reloaded-II folder the tool deploys into, or "" when one has
// not been found or picked yet.
func (s *EditService) ReloadedDir() string {
	return reloadedDir()
}

// pickerText is the folder dialog's own copy. The OS draws that dialog, so these
// strings have to cross into Go rather than live in the frontend's dictionary.
var pickerText = map[string]struct{ Title, Button, NoMods string }{
	LangZH: {"选择 Reloaded-II 目录", "选择", "%s 里没有 Mods 文件夹，这看起来不是 Reloaded-II 的安装目录"},
	"en":   {"Select the Reloaded-II folder", "Select", "%s has no Mods folder, so it does not look like a Reloaded-II install"},
	"ja":   {"Reloaded-II のフォルダを選ぶ", "選択", "%s に Mods フォルダがないため、Reloaded-II のインストール先ではないようです"},
}

// ChooseReloadedDir asks the user for the Reloaded-II folder and remembers it.
// An empty result means they cancelled.
func (s *EditService) ChooseReloadedDir(lang string) (string, error) {
	if s.app == nil {
		return "", fmt.Errorf("no window available for a folder picker")
	}
	text, ok := pickerText[lang]
	if !ok {
		text = pickerText[LangZH]
	}
	chosen, err := s.app.Dialog.OpenFileWithOptions(&application.OpenFileDialogOptions{
		CanChooseDirectories: true,
		CanChooseFiles:       false,
		Title:                text.Title,
		ButtonText:           text.Button,
	}).PromptForSingleSelection()
	if err != nil {
		return "", err
	}
	if chosen == "" {
		return "", nil
	}
	// Accepted as-is: whether it is really a Reloaded-II install is settled when
	// something is actually installed there, so a wrong pick fails loudly then
	// rather than silently here.
	absolute, err := filepath.Abs(chosen)
	if err != nil {
		absolute = chosen
	}
	saveSettings(settings{ReloadedDir: absolute})
	return absolute, nil
}

// LangZH is the language the tool falls back to when asked for one it has no
// table for.
const LangZH = "zh"

// nameTables maps a UI language to its skill-name table. The keys are the same
// 8-hex hashes in every language; only the display names differ.
var nameTables = map[string]map[string]string{
	LangZH: decodeNames(embeddedNamesZH),
	"en":   decodeNames(embeddedNamesEN),
	"ja":   decodeNames(embeddedNamesJA),
}

func decodeNames(raw []byte) map[string]string {
	names := make(map[string]string)
	if len(raw) == 0 {
		return names
	}
	_ = json.Unmarshal(raw, &names)
	return names
}

// NameMap returns the whole key -> name table for a language, so the frontend can
// resolve names locally instead of one call per row. An unknown language gets the
// fallback rather than an empty picker.
func (s *EditService) NameMap(lang string) map[string]string {
	if names, ok := nameTables[lang]; ok {
		return names
	}
	return nameTables[LangZH]
}

// skillDefaults maps a skill_status Key to that skill's vanilla LevelValue1..10,
// so a newly added edit starts from the game's own numbers instead of zeros.
// Populated once from the embedded skilldefaults.json.
var skillDefaults = loadSkillDefaults()

func loadSkillDefaults() map[string][]float64 {
	defaults := make(map[string][]float64)
	if len(embeddedDefaults) == 0 {
		return defaults
	}
	_ = json.Unmarshal(embeddedDefaults, &defaults)
	return defaults
}

// LevelRange is where a skill's numbers live, in stored levels (the game shows
// stored + 1).
//
// Default is the level a new edit should start on: the skill's own maximum when
// that is a normal 20 or less, otherwise the usual 15, except for the few skills
// whose values only exist higher up. Max is what the level field is clamped to.
type LevelRange struct {
	Default int `json:"Default"`
	Max     int `json:"Max"`
}

// levelRanges maps a skill hash to its levels. Populated once from the embedded
// skilllevels.json.
var levelRanges = loadLevelRanges()

func loadLevelRanges() map[string]LevelRange {
	ranges := make(map[string]LevelRange)
	if len(embeddedLevels) == 0 {
		return ranges
	}
	_ = json.Unmarshal(embeddedLevels, &ranges)
	return ranges
}

// LevelMap returns the whole hash -> levels table.
func (s *EditService) LevelMap() map[string]LevelRange {
	return levelRanges
}

// explainTables holds, per language, the game's own explanation of each skill.
// The text contains {N} placeholders standing for LevelValue(N+1) - the numbers
// this tool edits - which is what makes a slot's meaning knowable at all.
var explainTables = map[string]map[string]string{
	LangZH: decodeTexts(embeddedExplainZH),
	"en":   decodeTexts(embeddedExplainEN),
	"ja":   decodeTexts(embeddedExplainJA),
}

func decodeTexts(raw []byte) map[string]string {
	texts := make(map[string]string)
	if len(raw) == 0 {
		return texts
	}
	_ = json.Unmarshal(raw, &texts)
	return texts
}

// ExplainMap returns the whole hash -> explanation table for a language, with the
// same fallback as NameMap.
func (s *EditService) ExplainMap(lang string) map[string]string {
	if texts, ok := explainTables[lang]; ok {
		return texts
	}
	return explainTables[LangZH]
}

// DefaultMap returns the whole key -> vanilla values table.
func (s *EditService) DefaultMap() map[string][]float64 {
	return skillDefaults
}

// padValues makes a Values slice exactly LevelValueCount long, so the JSON shape
// is stable no matter what a hand-edited file contains.
func padValues(values []float64) []float64 {
	out := make([]float64, LevelValueCount)
	copy(out, values)
	return out
}

// defaultEdits is what the tool starts from when no config exists yet.
func defaultEdits() []SkillEdit {
	return []SkillEdit{
		{Enabled: true, Key: "06719232", Level: 14, Values: padValues([]float64{30, 1, 20})},
		{Enabled: true, Key: "29B07BEB", Level: 14, Values: padValues([]float64{2})},
	}
}

// reloadedDir is the Reloaded-II folder the user picked, or "" until they pick
// one.
//
// Nothing is searched for. Reloaded-II is a portable folder that people keep
// wherever they unpacked it, and guessing wrong means writing a mod into some
// unrelated directory; asking once is both safer and clearer.
func reloadedDir() string {
	return loadSettings().ReloadedDir
}

// DefaultReloadedDir is the path to show as a hint before anything is picked -
// where Reloaded-II ends up when it is unpacked and run without moving it.
func (s *EditService) DefaultReloadedDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, "Desktop", "Reloaded-II")
}

// looksLikeReloaded is what an install is checked against: the launcher has to be
// there, so a mod is never written into a folder that merely has the right name.
func looksLikeReloaded(dir string) bool {
	if dir == "" {
		return false
	}
	info, err := os.Stat(filepath.Join(dir, "Reloaded-II.exe"))
	return err == nil && !info.IsDir()
}

// settings is the tool's own state, kept outside the mod so that it survives
// reinstalls. Losing it only costs one folder pick.
type settings struct {
	ReloadedDir string `json:"ReloadedDir"`
}

// settingsFile is under %APPDATA%; "" when we cannot work out where that is.
func settingsFile() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "GBFR.SkillEdit", "tool.json")
}

func loadSettings() settings {
	var loaded settings
	path := settingsFile()
	if path == "" {
		return loaded
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return loaded
	}
	_ = json.Unmarshal(raw, &loaded)
	return loaded
}

// saveSettings is best effort: failing to remember the folder costs the user one
// extra pick next launch, which is not worth interrupting them for.
func saveSettings(value settings) {
	path := settingsFile()
	if path == "" {
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	if raw, err := json.MarshalIndent(value, "", "  "); err == nil {
		_ = os.WriteFile(path, raw, 0o644)
	}
}

// ModsDir returns the Reloaded-II mods folder, or "" when it cannot be found.
func (s *EditService) ModsDir() string {
	root := reloadedDir()
	if root == "" {
		return ""
	}
	return filepath.Join(root, "Mods")
}

// configPath is the file the mod loads its edit list from.
//
// This is deliberately NOT the mod's own folder under Mods\. The mod asks
// Reloaded for IModLoaderV3.GetModConfigDirectory, which resolves to
// User\Mods\<ModId> - the same directory Reloaded keeps every other mod's
// Config.json and this mod's own ModUserConfig.json in. Writing next to the DLL
// instead leaves the mod reading a file that does not exist, which applies
// nothing at all and looks exactly like the mod being broken.
func configPath() string {
	root := reloadedDir()
	if root == "" {
		return ""
	}
	return filepath.Join(root, "User", "Mods", modFolder, "Config.json")
}

// legacyConfigPath is where earlier builds of this tool wrote Config.json,
// before the path above was corrected. Read so an existing list survives the
// move; never written.
func legacyConfigPath() string {
	root := reloadedDir()
	if root == "" {
		return ""
	}
	return filepath.Join(root, "Mods", modFolder, "Config.json")
}

// LoadEdits reads the current edit list from the mod's Config.json, falling
// back to the pre-move location and then to defaults.
func (s *EditService) LoadEdits() []SkillEdit {
	fallback := func() []SkillEdit {
		edits := defaultEdits()
		for i := range edits {
			edits[i].Values = padValues(edits[i].Values)
		}
		return edits
	}

	for _, path := range []string{configPath(), legacyConfigPath()} {
		if path == "" {
			continue
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var cfg Config
		if err := json.Unmarshal(raw, &cfg); err != nil || len(cfg.Edits) == 0 {
			continue
		}
		for i := range cfg.Edits {
			cfg.Edits[i].Values = padValues(cfg.Edits[i].Values)
		}
		return cfg.Edits
	}
	return fallback()
}

// Install writes the mod binary into the Reloaded-II mods folder and the edit
// list into the mod's user config directory.
func (s *EditService) Install(edits []SkillEdit) (string, error) {
	mods := s.ModsDir()
	cfgPath := configPath()
	current := reloadedDir()
	if mods == "" || cfgPath == "" {
		return "", fmt.Errorf("no Reloaded-II folder has been chosen yet")
	}
	// Checked here, not when the folder was picked: this is the moment it matters.
	if !looksLikeReloaded(current) {
		return "", fmt.Errorf("%s has no Reloaded-II.exe, so it is not a Reloaded-II folder", current)
	}
	target := filepath.Join(mods, modFolder)

	if err := os.MkdirAll(target, 0o755); err != nil {
		return "", fmt.Errorf("creating the mod folder: %w", err)
	}

	// Earlier versions shipped a static .tbl under GBFR\data\..., so an install
	// may have left empty folders behind. The table is patched at runtime now, so
	// drop them rather than leave a confusing skeleton in the mod.
	_ = os.RemoveAll(filepath.Join(target, "GBFR"))

	for i := range edits {
		edits[i].Values = padValues(edits[i].Values)
	}

	cfgBytes, err := json.MarshalIndent(Config{Edits: edits}, "", "  ")
	if err != nil {
		return "", fmt.Errorf("serialising the edit list: %w", err)
	}

	// The mod itself: the DLL and the manifest that tells Reloaded how to load it.
	modFiles := map[string][]byte{
		"ModConfig.json": embeddedCfg,
		modDllName:       embeddedDll,
	}
	for name, data := range modFiles {
		if len(data) == 0 {
			return "", fmt.Errorf("embedded asset %s is empty", name)
		}
		if err := os.WriteFile(filepath.Join(target, name), data, 0o644); err != nil {
			return "", fmt.Errorf("writing %s: %w", name, err)
		}
	}

	// The edit list is mod *user* config, which the mod reads from Reloaded's
	// per-mod config directory rather than from its own folder.
	if err := os.MkdirAll(filepath.Dir(cfgPath), 0o755); err != nil {
		return "", fmt.Errorf("creating the config folder: %w", err)
	}
	if err := os.WriteFile(cfgPath, cfgBytes, 0o644); err != nil {
		return "", fmt.Errorf("writing Config.json: %w", err)
	}

	// Anything still at the old location has just been copied here; leaving it
	// behind would mean an edit to a file the mod never reads.
	_ = os.Remove(legacyConfigPath())

	// Short on purpose: the frontend shows this on a single fixed-height line and
	// appends the enabled count. Where the files went is in its hover tooltip.
	return fmt.Sprintf("已部署 %d 条改动", len(edits)), nil
}
