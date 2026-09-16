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
	"errors"
	"log"
	"os"
	"syscall"
	"unsafe"

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

// The window/taskbar icon. Embedding it here rather than leaning on the exe's own
// icon resource is deliberate: Wails on Windows asks for icon resource ID 3 and
// silently disables the icon when it is not there - and this exe's resource is
// named, not numbered, so ID 3 is empty and the title bar came up blank.
//
//go:embed appicon.png
var appIcon []byte

// mutexName is the single-instance lock's name. A Local\ name, so the lock is
// per logon session rather than per machine.
const mutexName = "Local\\GBFRSigilEditTool"

// toolWindowTitle is the tool window's title, and the name a second launch finds
// that window by.
const toolWindowTitle = "GBFR Sigil Edit"

// swRestore is ShowWindow's SW_RESTORE: a minimised window comes back at its
// previous size and position.
const swRestore = 9

var (
	user32                  = syscall.NewLazyDLL("user32.dll")
	procFindWindowW         = user32.NewProc("FindWindowW")
	procShowWindow          = user32.NewProc("ShowWindow")
	procSetForegroundWindow = user32.NewProc("SetForegroundWindow")
	kernel32                = syscall.NewLazyDLL("kernel32.dll")
	procCreateMutexW        = kernel32.NewProc("CreateMutexW")
)

// ensureSingleInstance takes the named mutex and brings the window of the
// instance already holding it to the front, so the tool is never open twice over
// one Config.json. A mutex that cannot be created at all falls through, and the
// tool then starts without a lock the way it did before.
func ensureSingleInstance() {
	name, _ := syscall.UTF16PtrFromString(mutexName)
	handle, _, cerr := procCreateMutexW.Call(0, 0, uintptr(unsafe.Pointer(name)))
	if handle != 0 && errors.Is(cerr, syscall.ERROR_ALREADY_EXISTS) {
		if hwnd := findToolWindow(); hwnd != 0 {
			procShowWindow.Call(hwnd, swRestore)
			procSetForegroundWindow.Call(hwnd)
		}
		os.Exit(0)
	}
}

// findToolWindow returns the tool's main window handle (0 = not found).
func findToolWindow() uintptr {
	title, _ := syscall.UTF16PtrFromString(toolWindowTitle)
	hwnd, _, _ := procFindWindowW.Call(0, uintptr(unsafe.Pointer(title)))
	return hwnd
}

func main() {
	ensureSingleInstance()

	edits := &EditService{}

	app := application.New(application.Options{
		Name: "GBFRSigilEdits",
		Icon: appIcon,
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
		Title: toolWindowTitle,
		/*
			Both dimensions are written as a client size plus what Windows adds around
			it, so the numbers to change are the ones the frontend lays out in: 8px per
			side of resize frame for the width (16), and the title bar plus borders for
			the height (39). Measured with GetWindowRect vs GetClientRect at 96 DPI.
			888 by 581 is also the shape the list was laid out in - about nine rows and
			the band - which is why the height's minimum is the same number: the window
			can grow, and neither dimension can shrink below what the rows need.
		*/
		Width:     888 + 16,
		MinWidth:  888 + 16,
		Height:    581 + 39,
		MinHeight: 581 + 39,
		// Matches the shadcn dark --background token, so the window does not flash
		// a different colour before the frontend paints.
		BackgroundColour: application.NewRGB(10, 10, 10),
		URL:              "/",
	})

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
