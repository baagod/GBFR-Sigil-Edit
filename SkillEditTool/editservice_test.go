package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// fakeReloaded points os.UserHomeDir at a throwaway folder and gives it the two
// directories Reloaded creates, so the whole deploy path can be exercised
// without touching the real installation.
func fakeReloaded(t *testing.T) string {
	t.Helper()
	home := hermeticHome(t)

	root := makeReloaded(t, filepath.Join(home, "Desktop", "Reloaded-II"))
	if err := os.MkdirAll(filepath.Join(root, "User", "Mods"), 0o755); err != nil {
		t.Fatal(err)
	}
	// Nothing is searched for, so an install only counts once it has been chosen.
	saveSettings(settings{ReloadedDir: root})
	return root
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

/*
The mod reads its edit list from %APPDATA%\GBFR.SkillEdit\Config.json, the folder
the tool's own tool.json sits in. Writing anywhere else deploys a config the mod
never reads, which looks exactly like the mod doing nothing.
*/
func TestInstallWritesConfigWhereTheModReadsIt(t *testing.T) {
	root := fakeReloaded(t)

	edits := []SkillEdit{{Enabled: true, Key: "06719232", Level: 15, Values: []float64{30, 1, 20}}}
	if _, err := (&EditService{}).Install(edits); err != nil {
		t.Fatalf("Install: %v", err)
	}

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

	// The mods folder still has to receive the mod itself.
	for _, name := range []string{modDllName, "ModConfig.json"} {
		if _, err := os.Stat(filepath.Join(root, "Mods", modFolder, name)); err != nil {
			t.Fatalf("%s was not deployed: %v", name, err)
		}
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

	loaded := (&EditService{}).LoadEdits()
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

	loaded := (&EditService{}).LoadEdits()
	if len(loaded) != len(defaultEdits()) {
		t.Fatalf("expected the default list, got %+v", loaded)
	}
	for _, edit := range loaded {
		if len(edit.Values) != LevelValueCount {
			t.Fatalf("%s: default values were not padded: %v", edit.Key, edit.Values)
		}
	}
}

// An install is identified by its launcher, so a mod is never written into a
// folder that merely has the right name.
func TestLooksLikeReloaded(t *testing.T) {
	dir := t.TempDir()

	if looksLikeReloaded(dir) {
		t.Fatal("an empty folder was accepted")
	}
	if err := os.MkdirAll(filepath.Join(dir, "Mods"), 0o755); err != nil {
		t.Fatal(err)
	}
	if looksLikeReloaded(dir) {
		t.Fatal("a Mods folder on its own was accepted")
	}
	if err := os.WriteFile(filepath.Join(dir, "Reloaded-II.exe"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !looksLikeReloaded(dir) {
		t.Fatal("a folder with Reloaded-II.exe was rejected")
	}
	if looksLikeReloaded("") {
		t.Fatal("an empty path was accepted")
	}
}

// hermeticHome points every path the discovery consults at a throwaway folder, so
// the tests never see the machine's real Reloaded-II.
func hermeticHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("USERPROFILE", home)
	t.Setenv("HOME", home)
	t.Setenv("APPDATA", filepath.Join(home, "AppData", "Roaming"))
	t.Setenv("LOCALAPPDATA", filepath.Join(home, "AppData", "Local"))
	return home
}

func makeReloaded(t *testing.T, dir string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, "Mods"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "Reloaded-II.exe"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

// A folder chosen earlier wins over searching, and the search skips over to the
// next launch without asking again.
func TestSavedReloadedDirWins(t *testing.T) {
	home := hermeticHome(t)
	saved := makeReloaded(t, filepath.Join(home, "Somewhere", "Reloaded-II"))
	saveSettings(settings{ReloadedDir: saved})

	if got := reloadedDir(); got != saved {
		t.Fatalf("saved folder ignored: got %q, want %q", got, saved)
	}
}

// The chosen folder is used exactly as given, valid or not: an install that has
// moved is reported when something is installed, not silently replaced by
// whatever else happens to be lying around.
func TestSavedDirIsUsedAsGiven(t *testing.T) {
	home := hermeticHome(t)
	chosen := filepath.Join(home, "Somewhere", "Reloaded-II")
	saveSettings(settings{ReloadedDir: chosen})

	// A real-looking install elsewhere must not win over the choice.
	makeReloaded(t, filepath.Join(home, "Desktop", "Reloaded-II"))
	if got := reloadedDir(); got != chosen {
		t.Fatalf("got %q, want the chosen %q", got, chosen)
	}
}

// Nothing chosen, but Reloaded-II sitting in the default place: use it rather
// than making the user pick a folder that is already correct.
func TestDefaultDirIsUsedWhenItIsReal(t *testing.T) {
	home := hermeticHome(t)

	// A folder of that name that is not an install must not be adopted.
	if got := reloadedDir(); got != "" {
		t.Fatalf("expected nothing, got %q", got)
	}
	if err := os.MkdirAll(filepath.Join(home, "Desktop", "Reloaded-II"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got := reloadedDir(); got != "" {
		t.Fatalf("an empty folder of that name was adopted: %q", got)
	}

	// With the launcher present it is the install.
	real := makeReloaded(t, filepath.Join(home, "Desktop", "Reloaded-II"))
	if got := reloadedDir(); got != real {
		t.Fatalf("default install ignored: got %q, want %q", got, real)
	}
}

// The picker's answer is remembered for next time.
func TestSaveSettingsRoundTrip(t *testing.T) {
	hermeticHome(t)
	want := `C:\Somewhere\Reloaded-II`
	saveSettings(settings{ReloadedDir: want})

	path := settingsFile()
	if path == "" {
		t.Fatal("no settings path")
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("settings were not written: %v", err)
	}
	if got := loadSettings().ReloadedDir; got != want {
		t.Fatalf("settings round-trip lost the value: got %q, want %q", got, want)
	}
}

// The name tables and the skill table come from separately generated assets: the
// names are per-language text from the game, the values and levels are one table.
// If their key sets drift, adding a skill silently produces zeros (or a blank
// picker row), so assert every language describes the same set of skills as the
// values - and the same set as each other.
func TestSkillTablesAgree(t *testing.T) {
	if len(skillInfo) == 0 {
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
		if len(names) != len(skillInfo) {
			t.Fatalf("%s: key count differs from the skill table: names %d, skills %d",
				lang, len(names), len(skillInfo))
		}
		for key := range names {
			if _, ok := skillInfo[key]; !ok {
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
	for key, info := range skillInfo {
		if len(info.Values) != LevelValueCount {
			t.Fatalf("skill %s has %d values, want %d", key, len(info.Values), LevelValueCount)
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

// 黑龙的咒印 is the worked example: vanilla is 10/3/20 at level 15, and the mod's
// whole purpose is raising the first value.
func TestKnownSkillDefault(t *testing.T) {
	info, ok := skillInfo["06719232"]
	if !ok {
		t.Fatal("06719232 (黑龙的咒印) missing from skillinfo.json")
	}
	want := []float64{10, 3, 20, 0, 0, 0, 0, 0, 0, 0}
	for i := range want {
		if info.Values[i] != want[i] {
			t.Fatalf("06719232[%d] = %v, want %v", i, info.Values[i], want[i])
		}
	}
}

// A skill's default level has to be one it actually has values on, and the level
// field is only ever clamped to a level that exists.
func TestLevelRangesAreUsable(t *testing.T) {
	if len(skillInfo) == 0 {
		t.Fatal("skillinfo.json did not load")
	}
	for hash, info := range skillInfo {
		if info.Max < 0 || info.Default < 0 {
			t.Fatalf("%s has a negative level: %+v", hash, info)
		}
		if info.Default > info.Max {
			t.Fatalf("%s defaults to Lv%d but its maximum is Lv%d", hash, info.Default, info.Max)
		}
	}

	// The three cases the rule treats differently. Levels are the table's own, so
	// these are the numbers the game shows.
	for _, want := range []struct {
		hash     string
		def, max int
		why      string
	}{
		{"06719232", 15, 15, "15 levels: default to its own maximum"},
		{"70395731", 15, 30, "30 levels: default to the usual 15"},
		{"CAC6AFF2", 1, 1, "1 level: default to it, not to 15"},
	} {
		got, ok := skillInfo[want.hash]
		if !ok {
			t.Fatalf("%s missing from the skill table", want.hash)
		}
		if got.Default != want.def || got.Max != want.max {
			t.Fatalf("%s: got Lv%d/%d, want Lv%d/%d (%s)",
				want.hash, got.Default, got.Max, want.def, want.max, want.why)
		}
	}
}

// The rows that are not really skills must be absent from every table.
func TestExcludedRowsAreGone(t *testing.T) {
	for _, hash := range []string{"9AD8B5E6", "0FBA47E8", "A4D6B880", "CDEB73F6"} {
		if _, ok := skillInfo[hash]; ok {
			t.Fatalf("%s should not be offered", hash)
		}
		for lang, names := range nameTables {
			if _, ok := names[hash]; ok {
				t.Fatalf("%s should not be named in %s", hash, lang)
			}
		}
	}
}
