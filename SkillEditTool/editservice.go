package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"
	"golang.org/x/sys/windows"
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

// logFileName is the log the mod writes beside its own files. Kept here so an
// install can clear it: the mod starts the file over each launch, so a leftover
// one is only ever yesterday's.
const logFileName = "GBFR.SkillEdit.log"

// hotApplyEventName is the win32 event the running mod waits on. Install sets
// it after writing Config.json, and the mod - which lives inside the game -
// then re-applies the edit list to the game's in-memory table, without a
// restart. The string is shared with HotApply.EventName in the mod's C#
// source; nothing links the two, so a rename has to touch both files.
const hotApplyEventName = "GBFR.SkillEdit.HotApply"

// signalHotApply wakes the mod, when one is running to wake. Everything else -
// the game closed, the mod disabled, its event not created yet - is the normal
// install path and not an error, because the mod reads Config.json again on
// its next launch anyway.
func signalHotApply(name string) bool {
	namePtr, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return false
	}
	event, err := windows.OpenEvent(windows.EVENT_MODIFY_STATE, false, namePtr)
	if err != nil {
		return false
	}
	defer windows.CloseHandle(event)
	return windows.SetEvent(event) == nil
}

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
var pickerText = map[string]struct{ Title, Button string }{
	LangZH: {"选择 Reloaded-II 目录", "选择"},
	"en":   {"Select the Reloaded-II folder", "Select"},
	"ja":   {"Reloaded-II のフォルダを選ぶ", "選択"},
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
		// Closing the dialog is not a failure. Wails reports it as an error and
		// the wording is the only signal it gives, so treat that as "nothing
		// chosen" and let the UI carry on.
		if strings.Contains(strings.ToLower(err.Error()), "cancel") {
			return "", nil
		}
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
	LangZH: decodeStrings(embeddedNamesZH),
	"en":   decodeStrings(embeddedNamesEN),
	"ja":   decodeStrings(embeddedNamesJA),
}

// decodeStrings turns one embedded string table into a map. There is no empty
// case to handle: Unmarshal leaves the map empty when the table is absent or
// malformed, which is the answer either way.
func decodeStrings(raw []byte) map[string]string {
	decoded := make(map[string]string)
	_ = json.Unmarshal(raw, &decoded)
	return decoded
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

// SkillInfo is one row of the generated skillinfo.json: every level of a skill the
// tool offers, so a newly added edit starts from the game's own numbers instead of
// zeros, and so the value shown for a slot - and the one an emptied box writes back
// - is the game's number for the level the edit names.
//
// Levels is indexed by level - 1: Levels[3] is the row whose Level field is 4.
//
// Default is the level a new edit should start on: the skill's own maximum when
// that is a normal 20 or less, otherwise the usual 15, except for the few skills
// whose values only exist higher up. Min and Max are what the level field is
// clamped to - Min is the lowest level carrying numbers, so a skill whose numbers
// exist on one level only cannot be moved off it.
type SkillInfo struct {
	Levels  [][]float64 `json:"Levels"`
	Default int         `json:"Default"`
	Max     int         `json:"Max"`
	Min     int         `json:"Min"`
}

// skillInfo maps a skill_status Key to that skill's own numbers and levels.
// Populated once from the embedded skillinfo.json.
var skillInfo = loadSkillInfo()

func loadSkillInfo() map[string]SkillInfo {
	info := make(map[string]SkillInfo)
	_ = json.Unmarshal(embeddedSkillInfo, &info)
	return info
}

// SkillMap returns the whole hash -> skill table, so the frontend can resolve a
// new edit's starting values and its level bound locally instead of one call per
// row.
func (s *EditService) SkillMap() map[string]SkillInfo {
	return skillInfo
}

// explainTables holds, per language, the game's own explanation of each skill.
// The text contains {N} placeholders standing for LevelValue(N+1) - the numbers
// this tool edits - which is what makes a slot's meaning knowable at all.
var explainTables = map[string]map[string]string{
	LangZH: decodeStrings(embeddedExplainZH),
	"en":   decodeStrings(embeddedExplainEN),
	"ja":   decodeStrings(embeddedExplainJA),
}

// ExplainMap returns the whole hash -> explanation table for a language, with the
// same fallback as NameMap.
func (s *EditService) ExplainMap(lang string) map[string]string {
	if texts, ok := explainTables[lang]; ok {
		return texts
	}
	return explainTables[LangZH]
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
		{Enabled: true, Key: "06719232", Level: 15, Values: padValues([]float64{30, 1, 20})},
		{Enabled: true, Key: "29B07BEB", Level: 15, Values: padValues([]float64{2})},
	}
}

// reloadedDir is the folder to install into: the one the user picked, or the
// default location when Reloaded-II is genuinely there.
//
// Only that one place is ever considered. Reloaded-II is portable, so scanning
// would risk writing a mod into an unrelated folder that happens to share the
// name - but the default is where it lands when it is unpacked and run without
// being moved, and stopping to ask when it is sitting right there would be silly.
func reloadedDir() string {
	if saved := loadSettings().ReloadedDir; saved != "" {
		return saved
	}
	if fallback := defaultReloadedDir(); looksLikeReloaded(fallback) {
		return fallback
	}
	return ""
}

// defaultReloadedDir is where Reloaded-II ends up when it is unpacked and run
// without moving it.
func defaultReloadedDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, "Desktop", "Reloaded-II")
}

// DefaultReloadedDir is the path the UI shows before anything is picked.
func (s *EditService) DefaultReloadedDir() string {
	return defaultReloadedDir()
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

// configDir is the folder the tool and the mod share: %APPDATA%\GBFR.SkillEdit.
//
// Not %TEMP%: the edit list is the user's own data, and a disk cleanup deletes
// what lives there. Not the mod's own folder under Mods\ either: naming that
// means asking Reloaded where the per-mod config directory is and handling the
// case where that lookup fails. ApplicationData is computable on both sides with
// no failure branch at all - Go's os.UserConfigDir and C#'s
// SpecialFolder.ApplicationData resolve to the same folder.
func configDir() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, modFolder)
}

// settingsFile is under %APPDATA%; "" when we cannot work out where that is.
func settingsFile() string {
	dir := configDir()
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, "tool.json")
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

// configPath is the file the mod loads its edit list from: the same
// %APPDATA%\GBFR.SkillEdit folder the tool's own tool.json lives in.
func configPath() string {
	dir := configDir()
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, "Config.json")
}

// LoadEdits reads the current edit list from Config.json, falling back to the
// built-in defaults when there is nothing to read.
func (s *EditService) LoadEdits() []SkillEdit {
	edits := defaultEdits()
	if raw, err := os.ReadFile(configPath()); err == nil {
		var cfg Config
		if json.Unmarshal(raw, &cfg) == nil && len(cfg.Edits) > 0 {
			edits = cfg.Edits
		}
	}
	for i := range edits {
		edits[i].Values = padValues(edits[i].Values)
	}
	return edits
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

	for i := range edits {
		edits[i].Values = padValues(edits[i].Values)
	}

	cfgBytes, err := json.MarshalIndent(Config{Edits: edits}, "", "  ")
	if err != nil {
		return "", fmt.Errorf("serialising the edit list: %w", err)
	}

	// The mod itself: the DLL and the manifest that tells Reloaded how to load it.
	//
	// A running game keeps the DLL open, and the very point of the hot apply is
	// clicking here while a game is up - so a copy that already holds exactly
	// these bytes is skipped rather than rewritten. A rebuilt DLL still goes
	// through, and a locked one fails loudly: those edits cannot land in a
	// running game until it is restarted with the new mod anyway.
	modFiles := map[string][]byte{
		"ModConfig.json": embeddedCfg,
		modDllName:       embeddedDll,
	}
	for name, data := range modFiles {
		if len(data) == 0 {
			return "", fmt.Errorf("embedded asset %s is empty", name)
		}
		if deployed, err := os.ReadFile(filepath.Join(target, name)); err == nil && bytes.Equal(deployed, data) {
			continue
		}
		if err := os.WriteFile(filepath.Join(target, name), data, 0o644); err != nil {
			return "", fmt.Errorf("writing %s: %w", name, err)
		}
	}

	// The edit list goes to the %APPDATA% folder the mod also reads, so neither
	// side has to resolve anything about the other.
	if err := os.MkdirAll(filepath.Dir(cfgPath), 0o755); err != nil {
		return "", fmt.Errorf("creating the config folder: %w", err)
	}
	if err := os.WriteFile(cfgPath, cfgBytes, 0o644); err != nil {
		return "", fmt.Errorf("writing Config.json: %w", err)
	}

	// An install is a fresh start, so the previous run's log goes with it: the mod
	// starts the file over on its next launch anyway, and until then a stale log
	// sitting beside the files is worse than none.
	_ = os.Remove(filepath.Join(target, logFileName))

	// Short on purpose: the frontend shows this on a single fixed-height line and
	// appends the enabled count. Where the files went is in its hover tooltip.
	if signalHotApply(hotApplyEventName) {
		return fmt.Sprintf("已部署 %d 条改动（已通知游戏实时应用）", len(edits)), nil
	}
	return fmt.Sprintf("已部署 %d 条改动", len(edits)), nil
}
