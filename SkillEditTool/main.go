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

// Every skill's vanilla LevelValue1..10 and the levels those values live on, in
// one generated table: both halves describe the same row.
//
//go:embed assets/skillinfo.json
var embeddedSkillInfo []byte

// The game's own explanation of each skill, per language. {N} in these stands for
// LevelValue(N+1), so the tool can label the slots it edits.
//
//go:embed assets/skillexplain.zh.json
var embeddedExplainZH []byte

//go:embed assets/skillexplain.en.json
var embeddedExplainEN []byte

//go:embed assets/skillexplain.ja.json
var embeddedExplainJA []byte

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
			resize frame, so 816 here is 800 of *client* area for the frontend to
			lay out in. Measured with GetWindowRect vs GetClientRect at 96 DPI.

			Width is pinned so the ten value boxes in a row keep a usable size; the
			height is still worth resizing.
		*/
		Width:    816,
		MinWidth: 816,
		MaxWidth: 816,
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
