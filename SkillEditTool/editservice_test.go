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

/*
The mod loads its edit list from IModLoaderV3.GetModConfigDirectory, which is
User\Mods\<ModId> - not the mod's own folder. Writing anywhere else deploys a
config the mod never reads, which looks exactly like the mod doing nothing.
*/
func TestInstallWritesConfigWhereTheModReadsIt(t *testing.T) {
	root := fakeReloaded(t)

	edits := []SkillEdit{{Enabled: true, Key: "06719232", Level: 14, Values: []float64{30, 1, 20}}}
	if _, err := (&EditService{}).Install(edits); err != nil {
		t.Fatalf("Install: %v", err)
	}

	wantCfg := filepath.Join(root, "User", "Mods", modFolder, "Config.json")
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

// A list left at the old location must survive the move, and the stale copy must
// not be left behind for someone to edit in vain.
func TestInstallMigratesLegacyConfig(t *testing.T) {
	root := fakeReloaded(t)

	legacy := filepath.Join(root, "Mods", modFolder)
	if err := os.MkdirAll(legacy, 0o755); err != nil {
		t.Fatal(err)
	}
	legacyPath := filepath.Join(legacy, "Config.json")
	body := []byte(`{"Edits":[{"Enabled":true,"Key":"B064A634","Level":14,"Values":[300,10,300,10]}]}`)
	if err := os.WriteFile(legacyPath, body, 0o644); err != nil {
		t.Fatal(err)
	}

	service := &EditService{}
	loaded := service.LoadEdits()
	if len(loaded) != 1 || loaded[0].Key != "B064A634" || loaded[0].Values[0] != 300 {
		t.Fatalf("legacy config was not picked up: %+v", loaded)
	}
	if len(loaded[0].Values) != LevelValueCount {
		t.Fatalf("loaded values were not padded: %v", loaded[0].Values)
	}

	if _, err := service.Install(loaded); err != nil {
		t.Fatalf("Install: %v", err)
	}
	if _, err := os.Stat(legacyPath); !os.IsNotExist(err) {
		t.Fatalf("stale Config.json still sits in the mod folder (err=%v)", err)
	}
	if _, err := os.Stat(filepath.Join(root, "User", "Mods", modFolder, "Config.json")); err != nil {
		t.Fatalf("migrated config missing: %v", err)
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

// Nothing is chosen and nothing is searched for, so the UI can ask.
func TestNoDirChosen(t *testing.T) {
	home := hermeticHome(t)
	// Even a perfect candidate on the desktop is left alone.
	makeReloaded(t, filepath.Join(home, "Desktop", "Reloaded-II"))
	if got := reloadedDir(); got != "" {
		t.Fatalf("expected nothing to be chosen, got %q", got)
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

// The name tables and the default-value table come from separately generated
// assets. If their key sets drift, adding a skill silently produces zeros (or a
// blank picker row), so assert every language describes the same set of skills as
// the defaults - and the same set as each other.
func TestSkillTablesAgree(t *testing.T) {
	if len(skillDefaults) == 0 {
		t.Fatal("skilldefaults.json did not load")
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
		if len(names) != len(skillDefaults) {
			t.Fatalf("%s: key count differs from the defaults: names %d, defaults %d",
				lang, len(names), len(skillDefaults))
		}
		for key := range names {
			if _, ok := skillDefaults[key]; !ok {
				t.Fatalf("%s: skill %s has a name but no default values", lang, key)
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
	for key, values := range skillDefaults {
		if len(values) != LevelValueCount {
			t.Fatalf("skill %s has %d default values, want %d", key, len(values), LevelValueCount)
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

// 黑龙的咒印 is the worked example: vanilla is 10/3/20 at stored level 14, and
// the mod's whole purpose is raising the first value.
func TestKnownSkillDefault(t *testing.T) {
	values, ok := skillDefaults["06719232"]
	if !ok {
		t.Fatal("06719232 (黑龙的咒印) missing from skilldefaults.json")
	}
	want := []float64{10, 3, 20, 0, 0, 0, 0, 0, 0, 0}
	for i := range want {
		if values[i] != want[i] {
			t.Fatalf("06719232[%d] = %v, want %v", i, values[i], want[i])
		}
	}
}

// The level table has to describe exactly the skills the picker offers, and its
// default has to be a level the skill actually has values on.
func TestLevelTableAgrees(t *testing.T) {
	if len(levelRanges) == 0 {
		t.Fatal("skilllevels.json did not load")
	}
	if len(levelRanges) != len(skillDefaults) {
		t.Fatalf("level table has %d skills, defaults have %d", len(levelRanges), len(skillDefaults))
	}
	for hash := range skillDefaults {
		r, ok := levelRanges[hash]
		if !ok {
			t.Fatalf("%s has default values but no level range", hash)
		}
		if r.Max < 0 || r.Default < 0 {
			t.Fatalf("%s has a negative level: %+v", hash, r)
		}
		if r.Default > r.Max {
			t.Fatalf("%s defaults to Lv%d but its maximum is Lv%d", hash, r.Default+1, r.Max+1)
		}
	}

	// The three cases the rule treats differently.
	for _, want := range []struct {
		hash     string
		def, max int
		why      string
	}{
		{"06719232", 14, 14, "15 levels: default to its own maximum"},
		{"70395731", 14, 29, "30 levels: default to the usual 15"},
		{"CAC6AFF2", 0, 0, "1 level: default to it, not to 15"},
	} {
		got, ok := levelRanges[want.hash]
		if !ok {
			t.Fatalf("%s missing from the level table", want.hash)
		}
		if got.Default != want.def || got.Max != want.max {
			t.Fatalf("%s: got Lv%d/%d, want Lv%d/%d (%s)",
				want.hash, got.Default+1, got.Max+1, want.def+1, want.max+1, want.why)
		}
	}
}

// The rows that are not really skills must be absent from every table.
func TestExcludedRowsAreGone(t *testing.T) {
	for _, hash := range []string{"9AD8B5E6", "0FBA47E8", "A4D6B880", "CDEB73F6"} {
		if _, ok := skillDefaults[hash]; ok {
			t.Fatalf("%s should not be offered", hash)
		}
		if _, ok := levelRanges[hash]; ok {
			t.Fatalf("%s should not have a level range", hash)
		}
		for lang, names := range nameTables {
			if _, ok := names[hash]; ok {
				t.Fatalf("%s should not be named in %s", hash, lang)
			}
		}
	}
}
