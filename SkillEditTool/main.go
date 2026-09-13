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

//go:embed assets/skillnames.json
var embeddedNames []byte

//go:embed assets/skilldefaults.json
var embeddedDefaults []byte

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
			resize frame, so 616 here is 600 of *client* area for the frontend to
			lay out in. Measured with GetWindowRect vs GetClientRect at 96 DPI.

			Width is pinned so the ten value boxes in a row keep a usable size; the
			height is still worth resizing.
		*/
		Width:    616,
		MinWidth: 616,
		MaxWidth: 616,
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
