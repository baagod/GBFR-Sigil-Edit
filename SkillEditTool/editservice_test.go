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
	home := t.TempDir()
	t.Setenv("USERPROFILE", home)
	t.Setenv("HOME", home)

	root := filepath.Join(home, "Desktop", "Reloaded-II")
	for _, dir := range []string{"Mods", filepath.Join("User", "Mods")} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0o755); err != nil {
			t.Fatal(err)
		}
	}
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

// The picker and the default-value fill come from two separately generated
// assets. If their key sets drift, adding a skill silently produces zeros, so
// assert the two tables describe the same set of skills.
func TestSkillTablesAgree(t *testing.T) {
	if len(skillNames) == 0 {
		t.Fatal("skillnames.json did not load")
	}
	if len(skillDefaults) == 0 {
		t.Fatal("skilldefaults.json did not load")
	}
	if len(skillNames) != len(skillDefaults) {
		t.Fatalf("key count differs: names %d, defaults %d", len(skillNames), len(skillDefaults))
	}
	for key := range skillNames {
		if _, ok := skillDefaults[key]; !ok {
			t.Fatalf("skill %s has a name but no default values", key)
		}
	}
	for key, values := range skillDefaults {
		if len(values) != LevelValueCount {
			t.Fatalf("skill %s has %d default values, want %d", key, len(values), LevelValueCount)
		}
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
