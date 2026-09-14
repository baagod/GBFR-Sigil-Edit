package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v3/pkg/application"
)

//go:embed all:frontend/dist
var assets embed.FS

//go:embed assets/GBFR.SkillEdit.dll
var embeddedDll []byte

//go:embed assets/ModConfig.json
var embeddedCfg []byte

// One skill-name table per UI language, each built from that language's own text
// in the game. The hashes are identical across all three.
//
//go:embed assets/skillnames.zh.json
var embeddedNamesZH []byte

//go:embed assets/skillnames.en.json
var embeddedNamesEN []byte

//go:embed assets/skillnames.ja.json
var embeddedNamesJA []byte

//go:embed assets/skilldefaults.json
var embeddedDefaults []byte

// Which stored level each skill's values live on, and what a new edit should
// target. Generated alongside the defaults, same 200 skills.
//
//go:embed assets/skilllevels.json
var embeddedLevels []byte

func main() {
	edits := &EditService{}

	app := application.New(application.Options{
		Name: "GBFRSkillEdits",
		Services: []application.Service{
			application.NewService(edits),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
	})

	// Only known once the app exists: the folder picker needs a window to belong to.
	edits.app = app

	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title: "GBFR Skill Edit",
		/*
			Wails sizes the outer window, and Windows spends 8px per side on the
			resize frame, so 792 here is 776 of *client* area for the frontend to
			lay out in. Measured with GetWindowRect vs GetClientRect at 96 DPI.

			Width is pinned: the row packs a 222px name, the level and ten value
			boxes, and below about 700 of client width the boxes stop fitting four
			digits. Height stays resizable.
		*/
		Width:    792,
		MinWidth: 792,
		MaxWidth: 792,
		Height:   620,
		// Matches the shadcn dark --background token, so the window does not flash
		// a different colour before the frontend paints.
		BackgroundColour: application.NewRGB(10, 10, 10),
		URL:              "/",
	})

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
