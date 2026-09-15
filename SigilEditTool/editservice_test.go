package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"golang.org/x/sys/windows"
)

/*
No test may signal the event a real game is listening on. The write path signals
whatever name the package holds, so the whole run points it at this process's own
name: a game up on this machine never sees the tests, and the tests no longer have
to borrow the name to avoid it.
*/
func TestMain(m *testing.M) {
	hotApplyEventName = fmt.Sprintf("GBFR.SigilEdit.HotApply.Test.Run.%d", os.Getpid())
	os.Exit(m.Run())
}

// appDataConfig is the path the mod reads: Environment.SpecialFolder.ApplicationData
// is %APPDATA%, which is also what os.UserConfigDir answers on Windows. Spelled
// out here rather than via configPath so the test states the location instead of
// echoing the implementation back at itself.
func appDataConfig(t *testing.T, name string) string {
	t.Helper()
	appData := os.Getenv("APPDATA")
	if appData == "" {
		t.Fatal("APPDATA is unset")
	}
	return filepath.Join(appData, modFolder, name)
}

// hermeticHome points %APPDATA% - the one path the tool and the mod share - at a
// throwaway folder, so the tests never write into the real one.
func hermeticHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("USERPROFILE", home)
	t.Setenv("HOME", home)
	t.Setenv("APPDATA", filepath.Join(home, "AppData", "Roaming"))
	t.Setenv("LOCALAPPDATA", filepath.Join(home, "AppData", "Local"))
	return home
}

/*
SaveEdits is the whole write path now: the mod ships inside
Reloaded-II\Mods\GBFR.SigilEdit\ beside this tool, so editing only ever writes
the config the mod reads. Writing anywhere else hands the running game a list
that is not the one on screen, which looks exactly like the mod doing nothing.

flushNow stands in for the debounce's timer here, so the assertions are about
where the list lands rather than about waiting a second for it.
*/
func TestSaveEditsWritesConfigWhereTheModReadsIt(t *testing.T) {
	hermeticHome(t)

	service := &EditService{}
	edits := []SigilTrait{{Enabled: true, Key: "06719232", Level: 15, Values: []float64{30, 1, 20}}}
	if err := service.SaveEdits(edits); err != nil {
		t.Fatalf("SaveEdits: %v", err)
	}
	service.flushNow()

	wantCfg := appDataConfig(t, "Config.json")
	raw, err := os.ReadFile(wantCfg)
	if err != nil {
		t.Fatalf("Config.json is not where the mod looks for it: %v", err)
	}
	var cfg Config
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatalf("Config.json is not valid JSON: %v", err)
	}
	if len(cfg.Edits) != 1 || cfg.Edits[0].Key != "06719232" || cfg.Edits[0].Values[0] != 30 {
		t.Fatalf("Config.json round-trip lost data: %+v", cfg.Edits)
	}
}

/*
The debounce is trailing-edge, which is a statement about when nothing is written
as much as about when something is: while the editing goes on, the file the mod
reads must still be the old one - and every call has to restart the quiet second,
so the write that does happen carries the last state and not the first.

The bubble turns that from a statement about the clock into one about the code:
the half-second passes instantly, and a run that stopped restarting the timer
fails here rather than passing on a machine that was merely slow.
*/
func TestSaveEditsWaitsForTheEditingToStop(t *testing.T) {
	hermeticHome(t)

	synctest.Test(t, func(t *testing.T) {
		service := &EditService{}
		cfgPath := appDataConfig(t, "Config.json")

		first := []SigilTrait{{Enabled: true, Key: "06719232", Level: 15, Values: []float64{30}}}
		if err := service.SaveEdits(first); err != nil {
			t.Fatalf("SaveEdits: %v", err)
		}
		time.Sleep(debounceDelay / 4)
		if _, err := os.Stat(cfgPath); err == nil {
			t.Fatal("Config.json was written while the debounce window was still open")
		}

		// A second keystroke restarts the window: the first one must not have left a
		// write behind it, and neither may this one yet.
		last := []SigilTrait{{Enabled: true, Key: "06719232", Level: 15, Values: []float64{300}}}
		if err := service.SaveEdits(last); err != nil {
			t.Fatalf("SaveEdits: %v", err)
		}
		time.Sleep(debounceDelay / 4)
		if _, err := os.Stat(cfgPath); err == nil {
			t.Fatal("a second edit did not restart the debounce window")
		}

		// Quiet from here on: the last state is what lands, once. No polling: the
		// bubble has already run the timer's callback to completion.
		time.Sleep(debounceDelay * 2)
		synctest.Wait()

		raw, err := os.ReadFile(cfgPath)
		if err != nil {
			t.Fatalf("the debounce never wrote Config.json: %v", err)
		}
		var cfg Config
		if err := json.Unmarshal(raw, &cfg); err != nil {
			t.Fatalf("Config.json is not valid JSON: %v", err)
		}
		if len(cfg.Edits) != 1 || cfg.Edits[0].Values[0] != 300 {
			t.Fatalf("the write is not the last state on screen: %+v", cfg.Edits)
		}
	})
}

/*
A write that cannot be made is logged and pushed to the frontend, and neither of
those may take the tool with it: the failure happens on the debounce timer's
goroutine, where a panic has no caller to catch it. There is no window in a test,
so this also covers the "no app to tell" branch.
*/
func TestSaveEditsSurvivesAWriteItCannotMake(t *testing.T) {
	home := hermeticHome(t)

	// A file where the config folder belongs: every mkdir and write under it has
	// to fail, which is the real shape of a locked or read-only %APPDATA%.
	blocked := filepath.Join(home, "AppData", "Roaming", modFolder)
	if err := os.MkdirAll(filepath.Dir(blocked), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(blocked, []byte("not a folder"), 0o644); err != nil {
		t.Fatal(err)
	}

	service := &EditService{}
	edits := []SigilTrait{{Enabled: true, Key: "06719232", Level: 15, Values: []float64{30}}}
	if err := service.SaveEdits(edits); err != nil {
		t.Fatalf("SaveEdits: %v", err)
	}

	// The failure has to be visible somewhere. There is no window to push it to
	// here, so the log is the half of the story this test can hold on to.
	var logged bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&logged)
	defer log.SetOutput(previous)

	// Accepting the list does not depend on the disk, so the write is what fails -
	// and flushNow is where the debounce's timer would have landed.
	service.flushNow()

	if !strings.Contains(logged.String(), "creating the config folder") {
		t.Fatalf("a write that could not be made went unrecorded: %q", logged.String())
	}
}

// The list the tool edits is the one the mod reads, so it has to come back out of
// the same %APPDATA% file: a read that went anywhere else would show the user a
// list that is not the one being deployed.
func TestLoadEditsReadsTheAppDataConfig(t *testing.T) {
	hermeticHome(t)

	current := appDataConfig(t, "Config.json")
	if err := os.MkdirAll(filepath.Dir(current), 0o755); err != nil {
		t.Fatal(err)
	}
	body := []byte(`{"Edits":[{"Enabled":true,"Key":"B064A634","Level":14,"Values":[300,10,300,10]}]}`)
	if err := os.WriteFile(current, body, 0o644); err != nil {
		t.Fatal(err)
	}

	loaded, err := (&EditService{}).LoadEdits()
	if err != nil {
		t.Fatalf("LoadEdits: %v", err)
	}
	if len(loaded) != 1 || loaded[0].Key != "B064A634" || loaded[0].Values[0] != 300 {
		t.Fatalf("Config.json was not read back: %+v", loaded)
	}
	if len(loaded[0].Values) != LevelValueCount {
		t.Fatalf("loaded values were not padded: %v", loaded[0].Values)
	}
}

// With nothing to read the tool starts from its own defaults rather than an empty
// screen.
func TestLoadEditsFallsBackToDefaults(t *testing.T) {
	hermeticHome(t)

	loaded, err := (&EditService{}).LoadEdits()
	if err != nil {
		t.Fatalf("LoadEdits: %v", err)
	}
	if len(loaded) != len(defaultEdits()) {
		t.Fatalf("expected the default list, got %+v", loaded)
	}
	for _, edit := range loaded {
		if len(edit.Values) != LevelValueCount {
			t.Fatalf("%s: default values were not padded: %v", edit.Key, edit.Values)
		}
	}
}

// The name tables and the skill table come from separately generated assets: the
// names are per-language text from the game, the values and levels are one table.
// If their key sets drift, adding a skill silently produces zeros (or a blank
// picker row), so assert every language describes the same set of skills as the
// values - and the same set as each other.
func TestSkillTablesAgree(t *testing.T) {
	if len(traitInfo) == 0 {
		t.Fatal("skillinfo.json did not load")
	}
	if len(nameTables) != 3 {
		t.Fatalf("expected a table each for zh, en and ja, got %d", len(nameTables))
	}
	var reference map[string]string
	for _, lang := range []string{"zh", "en", "ja"} {
		names, ok := nameTables[lang]
		if !ok {
			t.Fatalf("no name table for %s", lang)
		}
		if len(names) == 0 {
			t.Fatalf("the %s name table is empty", lang)
		}
		if len(names) != len(traitInfo) {
			t.Fatalf("%s: key count differs from the skill table: names %d, skills %d",
				lang, len(names), len(traitInfo))
		}
		for key := range names {
			if _, ok := traitInfo[key]; !ok {
				t.Fatalf("%s: skill %s has a name but no values", lang, key)
			}
		}
		if reference == nil {
			reference = names
			continue
		}
		for key := range reference {
			if _, ok := names[key]; !ok {
				t.Fatalf("%s is missing skill %s, which other languages have", lang, key)
			}
		}
	}
	for key, info := range traitInfo {
		// One row per level, each carrying the ten LevelValue slots: the level an
		// edit names has to have a row of its own, or a slot's placeholder (and the
		// value an emptied box writes back) would come from a different level.
		if len(info.Levels) != info.Max {
			t.Fatalf("skill %s has %d level rows, want %d", key, len(info.Levels), info.Max)
		}
		for level, row := range info.Levels {
			if len(row) != LevelValueCount {
				t.Fatalf("skill %s level %d has %d values, want %d", key, level+1, len(row), LevelValueCount)
			}
		}
	}
}

// The same skill has to be the same skill in every language - by hash, with a
// translated name.
func TestNameTablesAreTranslated(t *testing.T) {
	zh := nameTables["zh"]["06719232"]
	en := nameTables["en"]["06719232"]
	ja := nameTables["ja"]["06719232"]
	if zh == "" || en == "" || ja == "" {
		t.Fatalf("06719232 is missing a name in some language: zh=%q en=%q ja=%q", zh, en, ja)
	}
	if zh == en || zh == ja || en == ja {
		t.Fatalf("the tables are not actually translated: zh=%q en=%q ja=%q", zh, en, ja)
	}
}

// An unknown language falls back rather than handing back an empty picker.
func TestNameMapFallsBack(t *testing.T) {
	service := &EditService{}
	if got := len(service.NameMap("ko")); got == 0 {
		t.Fatal("an unknown language produced an empty name map")
	}
	if got := len(service.NameMap("en")); got == 0 {
		t.Fatal("en produced an empty name map")
	}
}

// 黑龙的咒印 is the worked example: vanilla is 10/3/20 on level 15, and the mod's
// whole purpose is raising the first value.
//
// It is also the example that shows why every level needs its own row: levels 1 to
// 14 of this skill are all zeros, so reading level 15's numbers while the edit names
// level 14 would put a placeholder - and a written-back value - of 10/3/20 on a row
// the game says is empty.
func TestKnownSkillDefault(t *testing.T) {
	info, ok := traitInfo["06719232"]
	if !ok {
		t.Fatal("06719232 (黑龙的咒印) missing from skillinfo.json")
	}
	want := []float64{10, 3, 20, 0, 0, 0, 0, 0, 0, 0}
	for i := range want {
		if got := info.Levels[info.Default-1][i]; got != want[i] {
			t.Fatalf("06719232 level %d[%d] = %v, want %v", info.Default, i, got, want[i])
		}
	}

	below := info.Levels[info.Default-2]
	for i, value := range below {
		if value != 0 {
			t.Fatalf("06719232 level %d[%d] = %v, want the zeros the table holds there", info.Default-1, i, value)
		}
	}
}

// A skill's default level has to be one it actually has values on, and the level
// field is only ever clamped to a level that exists.
func TestLevelRangesAreUsable(t *testing.T) {
	if len(traitInfo) == 0 {
		t.Fatal("skillinfo.json did not load")
	}
	for hash, info := range traitInfo {
		if info.Min < 1 || info.Default < 1 {
			t.Fatalf("%s has a level below 1: %+v", hash, info)
		}
		if info.Default > info.Max || info.Min > info.Default {
			t.Fatalf("%s range is Lv%d..%d with default Lv%d", hash, info.Min, info.Max, info.Default)
		}

		// The clamped range is only honest if Min is the first level that carries
		// numbers: every row below it has to be all zeros, or the field would be
		// refusing levels the game does define.
		carries := func(level int) bool {
			for _, value := range info.Levels[level-1] {
				if value != 0 {
					return true
				}
			}
			return false
		}
		if !carries(info.Min) {
			t.Fatalf("%s: level %d carries no values, so it is not a lower bound", hash, info.Min)
		}
		for level := 1; level < info.Min; level++ {
			if carries(level) {
				t.Fatalf("%s: level %d carries values below the minimum %d", hash, level, info.Min)
			}
		}
	}

	// The three cases the rule treats differently. Levels are the table's own, so
	// these are the numbers the game shows. 黑龙的咒印 keeps its numbers on level 15
	// alone, which is why its field is pinned there; 穷寇心 ramps from level 1.
	for _, want := range []struct {
		name          string
		hash          string
		min, def, max int
		why           string
	}{
		{"pinned to its only level", "06719232", 15, 15, 15, "numbers on level 15 only: the field is pinned there"},
		{"free across 30 levels", "70395731", 1, 15, 30, "30 levels: default to the usual 15, free from 1 to 30"},
		{"single-level skill", "CAC6AFF2", 1, 1, 1, "1 level: default to it, not to 15"},
	} {
		t.Run(want.name, func(t *testing.T) {
			got, ok := traitInfo[want.hash]
			if !ok {
				t.Fatalf("%s missing from the skill table", want.hash)
			}
			if got.Min != want.min || got.Default != want.def || got.Max != want.max {
				t.Fatalf("%s: got Lv%d..%d (default %d), want Lv%d..%d (default %d) (%s)",
					want.hash, got.Min, got.Max, got.Default, want.min, want.max, want.def, want.why)
			}
		})
	}
}

// The rows that are not really skills must be absent from every table.
func TestExcludedRowsAreGone(t *testing.T) {
	for _, hash := range []string{"9AD8B5E6", "0FBA47E8", "A4D6B880", "CDEB73F6"} {
		if _, ok := traitInfo[hash]; ok {
			t.Fatalf("%s should not be offered", hash)
		}
		for lang, names := range nameTables {
			if _, ok := names[hash]; ok {
				t.Fatalf("%s should not be named in %s", hash, lang)
			}
		}
	}
}

func TestSignalHotApplyWithoutTheGame(t *testing.T) {
	name := fmt.Sprintf("GBFR.SigilEdit.HotApply.Test.Absent.%d", os.Getpid())
	if signalHotApply(name) {
		t.Fatal("signalled an event that should not exist")
	}
}

// SaveEdits has to wake the running mod after writing its config, so the values
// land in a live game without a restart. The test simulates the mod by holding an
// event open under the name the write signals; TestMain has already pointed that
// name away from any event a game up on this machine would be waiting on.
func TestSaveEditsSignalsTheRunningMod(t *testing.T) {
	hermeticHome(t)

	ptr, err := windows.UTF16PtrFromString(hotApplyEventName)
	if err != nil {
		t.Fatal(err)
	}
	event, err := windows.CreateEvent(nil, 0, 0, ptr)
	if err != nil {
		t.Fatalf("creating the test event: %v", err)
	}
	defer windows.CloseHandle(event)
	// CreateEvent may have opened an already-signalled object; start clean.
	_ = windows.ResetEvent(event)

	service := &EditService{}
	edits := []SigilTrait{{Enabled: true, Key: "06719232", Level: 15, Values: []float64{30, 1, 20}}}
	if err := service.SaveEdits(edits); err != nil {
		t.Fatalf("SaveEdits: %v", err)
	}
	service.flushNow()

	state, err := windows.WaitForSingleObject(event, 0)
	if err != nil {
		t.Fatalf("waiting on the mod's event: %v", err)
	}
	if state != windows.WAIT_OBJECT_0 {
		t.Fatal("the write did not signal the mod's event, so a running game would not hot-apply")
	}
}
