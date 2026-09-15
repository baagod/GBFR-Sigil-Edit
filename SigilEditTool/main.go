/*
Command SigilEdit is the desktop tool that edits GBFR.SigilEdit's Config.json.
The mod half patches skill_status in memory and re-applies it when this tool
signals a named event, so the list written here is the list the game ends up
with. The game's own trait names, values and explanations are embedded, so the
tool never needs the game to be up.
*/
package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v3/pkg/application"
)

//go:embed all:frontend/dist
var assets embed.FS

// One trait-name table per UI language, each built from that language's own text
// in the game. The hashes are identical across all three. The files are named
// after the game's own table (skill_status), which is what calls these rows skills.
//
//go:embed assets/skillnames.zh.json
var embeddedNamesZH []byte

//go:embed assets/skillnames.en.json
var embeddedNamesEN []byte

//go:embed assets/skillnames.ja.json
var embeddedNamesJA []byte

// Every trait's vanilla LevelValue1..10 and the levels those values live on, in
// one generated table: both halves describe the same row.
//
//go:embed assets/skillinfo.json
var embeddedSkillInfo []byte

// The game's own explanation of each trait, per language. {N} in these stands for
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
		Name: "GBFRSigilEdits",
		Services: []application.Service{
			application.NewService(edits),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
	})

	// The write waits for the editing to stop, so closing the window can beat it:
	// the list the debounce is still holding goes out on the way down.
	app.OnShutdown(edits.flushNow)

	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title: "GBFR Sigil Edit",
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
