package main

import (
	"bytes"
	jsonv2 "encoding/json/v2"
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
  openModEvent stands in for the running mod: the write signals an event by name, so the
  test holds that name open and watches it. TestMain has already pointed the name away from
  any event a game up on this machine would be waiting on, and the object is started clean
  because CreateEvent may have opened one that was already signalled.
*/
func openModEvent(t *testing.T) windows.Handle {
	t.Helper()
	ptr, err := windows.UTF16PtrFromString(hotApplyEventName)
	if err != nil {
		t.Fatal(err)
	}
	event, err := windows.CreateEvent(nil, 0, 0, ptr)
	if err != nil {
		t.Fatalf("creating the test event: %v", err)
	}
	t.Cleanup(func() { windows.CloseHandle(event) })
	_ = windows.ResetEvent(event)
	return event
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
	edits := []SigilTrait{{Enabled: true, Key: "06719232", Level: 15, Values: padValues([]*float64{value(30), value(1), value(20)})}}
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
	if err := jsonv2.Unmarshal(raw, &cfg); err != nil {
		t.Fatalf("Config.json is not valid JSON: %v", err)
	}
	if len(cfg.Edits) != 1 || cfg.Edits[0].Key != "06719232" || *cfg.Edits[0].Values[0] != 30 {
		t.Fatalf("Config.json round-trip lost data: %+v", cfg.Edits)
	}
	// The slots nobody typed into are the word null in the file, which is what tells the
	// mod to leave that part of the row alone. The record here sets three of the ten.
	if cfg.Edits[0].Values[3] != nil {
		t.Fatalf("an untouched slot came back as %v, want nil", *cfg.Edits[0].Values[3])
	}
	if !strings.Contains(string(raw), "null") {
		t.Fatalf("untouched slots are not spelled null in the file: %s", raw)
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

		first := []SigilTrait{{Enabled: true, Key: "06719232", Level: 15, Values: padValues([]*float64{value(30)})}}
		if err := service.SaveEdits(first); err != nil {
			t.Fatalf("SaveEdits: %v", err)
		}
		time.Sleep(debounceDelay / 4)
		if _, err := os.Stat(cfgPath); err == nil {
			t.Fatal("Config.json was written while the debounce window was still open")
		}

		// A second keystroke restarts the window: the first one must not have left a
		// write behind it, and neither may this one yet.
		last := []SigilTrait{{Enabled: true, Key: "06719232", Level: 15, Values: padValues([]*float64{value(300)})}}
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
		if err := jsonv2.Unmarshal(raw, &cfg); err != nil {
			t.Fatalf("Config.json is not valid JSON: %v", err)
		}
		if len(cfg.Edits) != 1 || *cfg.Edits[0].Values[0] != 300 {
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
	edits := []SigilTrait{{Enabled: true, Key: "06719232", Level: 15, Values: padValues([]*float64{value(30)})}}
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
	body := []byte(`{"edits":[{"enabled":true,"key":"B064A634","level":14,"values":[300,10,300,10]}]}`)
	if err := os.WriteFile(current, body, 0o644); err != nil {
		t.Fatal(err)
	}

	loaded, err := (&EditService{}).LoadEdits()
	if err != nil {
		t.Fatalf("LoadEdits: %v", err)
	}
	if len(loaded) != 1 || loaded[0].Key != "B064A634" || *loaded[0].Values[0] != 300 {
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

/*
  A file that exists and cannot be parsed is an error that names the file.

  What the screen shows is the point of the distinction: "cannot be parsed" says the file
  is broken and which one, while an empty list looks exactly like "nothing is switched on"
  - and the next keystroke would write that empty list back over the user's own edits.
*/
func TestLoadEditsRejectsAFileItCannotParse(t *testing.T) {
	hermeticHome(t)

	current := appDataConfig(t, "Config.json")
	if err := os.MkdirAll(filepath.Dir(current), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(current, []byte("not json"), 0o644); err != nil {
		t.Fatal(err)
	}

	loaded, err := (&EditService{}).LoadEdits()
	if err == nil {
		t.Fatalf("a file that cannot be parsed was accepted as %+v", loaded)
	}
	if !strings.Contains(err.Error(), "Config.json") {
		t.Fatalf("the error does not say which file: %v", err)
	}
}

// An empty list is a state, not a starting point: it is what switching every edit off
// leaves behind, so it stays empty instead of coming back as the built-in defaults the
// user just turned off.
func TestLoadEditsKeepsAnEmptyList(t *testing.T) {
	hermeticHome(t)

	current := appDataConfig(t, "Config.json")
	if err := os.MkdirAll(filepath.Dir(current), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(current, []byte(`{"edits":[]}`), 0o644); err != nil {
		t.Fatal(err)
	}

	loaded, err := (&EditService{}).LoadEdits()
	if err != nil {
		t.Fatalf("LoadEdits: %v", err)
	}
	if len(loaded) != 0 {
		t.Fatalf("an empty list came back as %+v", loaded)
	}
}

/*
  There is one format and one reader: a file from a build whose keys were capitalised is not
  read, and not rewritten either. It reads as an empty list - which is what the user asked for
  at the format change: "it reads an Edits, and if it cannot, it is an empty config" - and the
  next save writes the current format. This test states that on purpose, so the behaviour is a
  decision rather than an accident.
*/
func TestLoadEditsDoesNotReadAFileFromTheOldKeySpelling(t *testing.T) {
	hermeticHome(t)

	current := appDataConfig(t, "Config.json")
	if err := os.MkdirAll(filepath.Dir(current), 0o755); err != nil {
		t.Fatal(err)
	}
	old := []byte(`{"Edits":[{"Enabled":true,"Key":"B064A634","Level":14,"Values":[300]}]}`)
	if err := os.WriteFile(current, old, 0o644); err != nil {
		t.Fatal(err)
	}

	loaded, err := (&EditService{}).LoadEdits()
	if err != nil {
		t.Fatalf("LoadEdits: %v", err)
	}
	if len(loaded) != 0 {
		t.Fatalf("an old-spelling file should read as an empty list: %+v", loaded)
	}

	untouched, err := os.ReadFile(current)
	if err != nil {
		t.Fatal(err)
	}
	if string(untouched) != string(old) {
		t.Fatalf("the file was rewritten; loading does not write: %s", untouched)
	}
}

/*
  padValues is what holds the "exactly ten slots" invariant whatever the file contains: a
  short list is padded with nil, a long one is cut, because the table row it feeds has ten
  LevelValue slots and the mod reads them in order. nil is the slot nobody typed into - the
  game's own value - so padding with it writes nothing rather than writing a zero.
*/
func TestPadValuesAlwaysGivesTenSlots(t *testing.T) {
	short := padValues([]*float64{value(1), value(2), value(3)})
	if len(short) != LevelValueCount || *short[0] != 1 || short[3] != nil {
		t.Fatalf("a short list was not padded to %d: %v", LevelValueCount, short)
	}

	long := padValues([]*float64{
		value(1), value(2), value(3), value(4), value(5), value(6),
		value(7), value(8), value(9), value(10), value(11), value(12),
	})
	if len(long) != LevelValueCount {
		t.Fatalf("a long list was not cut to %d: %v", LevelValueCount, long)
	}
	if *long[0] != 1 || *long[LevelValueCount-1] != 10 {
		t.Fatalf("a long list kept the wrong values: %v", long)
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
		if len(info.Levels) == 0 {
			t.Fatalf("skill %s has no level rows", key)
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

// The picker offers a skill's real levels - the ones that carry values - and the
// default is one of them.
func TestLevelRangesAreUsable(t *testing.T) {
	if len(traitInfo) == 0 {
		t.Fatal("skillinfo.json did not load")
	}
	carries := func(levels [][]float64, level int) bool {
		for _, value := range levels[level-1] {
			if value != 0 {
				return true
			}
		}
		return false
	}
	for hash, info := range traitInfo {
		if len(info.Rows) == 0 {
			t.Fatalf("%s offers no level at all", hash)
		}
		offered := make(map[int]bool, len(info.Rows))
		for i, level := range info.Rows {
			if level < 1 || level > len(info.Levels) {
				t.Fatalf("%s offers Lv%d, outside its %d level rows", hash, level, len(info.Levels))
			}
			if i > 0 && info.Rows[i-1] >= level {
				t.Fatalf("%s offers levels out of order: %v", hash, info.Rows)
			}
			if !carries(info.Levels, level) {
				t.Fatalf("%s offers Lv%d, which carries no values", hash, level)
			}
			offered[level] = true
		}
		if !offered[info.Default] {
			t.Fatalf("%s defaults to Lv%d but offers %v", hash, info.Default, info.Rows)
		}

		// Nothing left out may carry values either, or the picker would hide a level
		// the game defines.
		for level := 1; level <= len(info.Levels); level++ {
			if !offered[level] && carries(info.Levels, level) {
				t.Fatalf("%s: Lv%d carries values but is not offered", hash, level)
			}
		}
	}

	// The three defaults the rule treats differently, and one skill for each. The numbers
	// are the game's own: 穷寇心 has 30 levels and does take the usual 15; 浩劫 has none
	// below 25, so 15 would name a level it does not have; 相扑斗力 has 5 levels, so its
	// own maximum is what it gets - the case that would catch a hardcoded 15.
	for _, want := range []struct {
		name string
		hash string
		def  int
		why  string
	}{
		{"the trait's own max below 15", "89C66ACB", 5, "5 levels: the usual 15 does not exist, so its own max does"},
		{"free across 30 levels", "70395731", 15, "30 levels: default to the usual 15"},
		{"single-level skill", "40223C28", 25, "its only level is 25: default to it, not to 15"},
	} {
		t.Run(want.name, func(t *testing.T) {
			got, ok := traitInfo[want.hash]
			if !ok {
				t.Fatalf("%s missing from the skill table", want.hash)
			}
			if got.Default != want.def {
				t.Fatalf("%s: default is Lv%d, want Lv%d (%s)", want.hash, got.Default, want.def, want.why)
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
// land in a live game without a restart. The test simulates the mod with the event
// openModEvent holds for it.
func TestSaveEditsSignalsTheRunningMod(t *testing.T) {
	hermeticHome(t)
	event := openModEvent(t)

	service := &EditService{}
	edits := []SigilTrait{{Enabled: true, Key: "06719232", Level: 15, Values: padValues([]*float64{value(30), value(1), value(20)})}}
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

// Nothing waiting to be written means nothing written and nothing signalled: one burst of
// edits is one write and one wake-up, however many times the flush is called.
func TestFlushWithNothingPendingDoesNothing(t *testing.T) {
	hermeticHome(t)
	event := openModEvent(t)

	service := &EditService{}
	edits := []SigilTrait{{Enabled: true, Key: "06719232", Level: 15, Values: padValues([]*float64{value(30)})}}
	if err := service.SaveEdits(edits); err != nil {
		t.Fatalf("SaveEdits: %v", err)
	}
	service.flushNow()
	_ = windows.ResetEvent(event)

	service.flushNow()

	state, err := windows.WaitForSingleObject(event, 0)
	if err != nil {
		t.Fatalf("waiting on the mod's event: %v", err)
	}
	if state != uint32(windows.WAIT_TIMEOUT) {
		t.Fatalf("a flush with nothing pending signalled the mod (wait state %#x)", state)
	}
}
