package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
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
type EditService struct{}

// SkillNames maps a skill_status Key (8-hex hash) to its display name.
// Populated once from the embedded skillnames.json.
var skillNames = loadSkillNames()

func loadSkillNames() map[string]string {
	names := make(map[string]string)
	if len(embeddedNames) == 0 {
		return names
	}
	_ = json.Unmarshal(embeddedNames, &names)
	return names
}

// NameOf returns the display name for a skill key, or "" when unknown.
func (s *EditService) NameOf(key string) string {
	return skillNames[strings.ToUpper(strings.TrimSpace(key))]
}

// NameMap returns the whole key -> name table so the frontend can resolve
// names locally instead of one call per row.
func (s *EditService) NameMap() map[string]string {
	return skillNames
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

// reloadedDir is the Reloaded-II installation this tool deploys into, or "" when
// it is not where we expect it.
func reloadedDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	candidate := filepath.Join(home, "Desktop", "Reloaded-II")
	if info, err := os.Stat(candidate); err != nil || !info.IsDir() {
		return ""
	}
	return candidate
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
	if mods == "" || cfgPath == "" {
		return "", fmt.Errorf("could not find the Reloaded-II folder")
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
