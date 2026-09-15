package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

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

// hotApplyEventName is the win32 event the running mod waits on. The tool sets
// it after writing Config.json, and the mod - which lives inside the game -
// then re-applies the edit list to the game's in-memory table, without a
// restart. The string is shared with HotApply.EventName in the mod's C#
// source; nothing links the two, so a rename has to touch both files.
const hotApplyEventName = "GBFR.SkillEdit.HotApply"

// debounceDelay is how long the edit list has to sit still before it is written:
// a burst of keystrokes ends in one Config.json write and one live apply,
// instead of one per keystroke.
const debounceDelay = 500 * time.Millisecond

// saveFailedEvent carries a failed write to the frontend, which shows it in the
// same dialog an immediate failure gets. The name is mirrored in App.tsx;
// nothing links the two, so a rename has to touch both files.
const saveFailedEvent = "GBFR.SkillEdit.SaveFailed"

// signalHotApply wakes the mod, when one is running to wake. Everything else -
// the game closed, the mod disabled, its event not created yet - is the normal
// save path and not an error, because the mod reads Config.json again on
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
//
// It also holds the list the debounce has not written yet. Every SaveEdits call
// replaces that list and restarts the timer, so what lands on disk is always the
// last state on screen, never a mixture of keystrokes.
type EditService struct {
	mu      sync.Mutex
	pending []SkillEdit
	timer   *time.Timer
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

// configPath is the file the mod loads its edit list from, in the
// %APPDATA%\GBFR.SkillEdit folder that is the tool's and the mod's shared state.
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

// SaveEdits takes the newest edit list and restarts the debounce, so the write
// happens when the editing stops rather than while it is going on: a burst of
// keystrokes ends in one Config.json write and, when the mod is up, one live
// apply.
//
// The write is deliberately not done here. Every call hands over the whole state
// and resets the debounce timer; whatever the timer sees when it finally fires
// is the last state on screen. The frontend stays dumb - it calls this on every
// change and never waits for an answer.
//
// Only "this list cannot be accepted at all" comes back as an error; a write
// that fails when the timer fires has no caller left to return to and is logged.
func (s *EditService) SaveEdits(edits []SkillEdit) (string, error) {
	if configPath() == "" {
		return "", fmt.Errorf("could not resolve the %%APPDATA%% config folder")
	}

	for i := range edits {
		edits[i].Values = padValues(edits[i].Values)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.pending = edits
	if s.timer == nil {
		s.timer = time.AfterFunc(debounceDelay, s.flush)
	} else {
		s.timer.Reset(debounceDelay)
	}

	// Short on purpose: the frontend reports success silently and only the
	// failure gets a dialog.
	return fmt.Sprintf("%d 条改动待写入", len(edits)), nil
}

// writeEdits puts the list where the mod reads it: %APPDATA%\GBFR.SkillEdit\
// Config.json, the folder neither side has to ask the other about.
//
// The mod binary is NOT touched - it ships beside this tool inside
// Reloaded-II\Mods\GBFR.SkillEdit\, and only Config.json changes from editing.
// Putting it there is ship-time packaging, not something a keystroke does.
func writeEdits(edits []SkillEdit) error {
	cfgPath := configPath()
	if cfgPath == "" {
		return fmt.Errorf("could not resolve the %%APPDATA%% config folder")
	}

	cfgBytes, err := json.MarshalIndent(Config{Edits: edits}, "", "  ")
	if err != nil {
		return fmt.Errorf("serialising the edit list: %w", err)
	}

	if err := os.MkdirAll(filepath.Dir(cfgPath), 0o755); err != nil {
		return fmt.Errorf("creating the config folder: %w", err)
	}
	if err := os.WriteFile(cfgPath, cfgBytes, 0o644); err != nil {
		return fmt.Errorf("writing Config.json: %w", err)
	}
	return nil
}

// flush is what the debounce fires: the editing has stopped, so the
// list goes out and the running game is told about it.
func (s *EditService) flush() {
	s.mu.Lock()
	edits := s.pending
	s.mu.Unlock()
	s.publish(edits)
}

// flushNow writes the pending list at once, for shutdown: the window can close
// inside the debounce window, and the edit just typed is the one the user means
// to keep. Nothing has ever been saved when pending is nil, and that is not a
// write.
func (s *EditService) flushNow() {
	s.mu.Lock()
	if s.timer != nil {
		s.timer.Stop()
	}
	edits := s.pending
	s.mu.Unlock()

	if edits == nil {
		return
	}
	s.publish(edits)
}

// publish is the one place the list leaves the tool.
//
// A failure here has no caller to travel back to: the call that handed the list
// over has already returned, and this runs on the timer's goroutine. So it
// is logged - the next edit re-arms the timer with the newest list, and that is
// the retry - and pushed to the frontend, because a list that never reached the
// disk looks exactly like the mod doing nothing.
func (s *EditService) publish(edits []SkillEdit) {
	if err := writeEdits(edits); err != nil {
		log.Printf("GBFR.SkillEdit: %v", err)
		// Get is the app this process is running, and nil in a test, where
		// there is no frontend to tell.
		if app := application.Get(); app != nil {
			app.Event.Emit(saveFailedEvent, err.Error())
		}
		return
	}
	signalHotApply(hotApplyEventName)
}
