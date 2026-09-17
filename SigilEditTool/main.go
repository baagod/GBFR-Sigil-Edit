/*
Command SigilEdit 是编辑 GBFR.SigilEdit 的 Config.json 的桌面工具。
mod 那一半在内存里给 skill_status 打补丁，
并在本工具发出一个具名事件时重新应用，所以这里写下的列表就是游戏最终采用的列表。
游戏自己的因子名称、数值和说明都已内嵌，因此工具从不需要游戏处于运行状态。
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

// 生成的资产，分成两半。skill_status.json 是游戏自己的行：一个因子的哪些等级带数字，
// 以及每个等级上的十个值。skill.<lang>.json 是一种语言对这个因子的说法——它叫什么、
// 做什么，以及游戏自己对它的说明——这些文件是按游戏自己那张管这些行叫 skills 的表命名的。
//
//go:embed assets/skill_status.json
var embeddedSkillStatus []byte

//go:embed assets/skill.zh.json
var embeddedSkillZH []byte

//go:embed assets/skill.en.json
var embeddedSkillEN []byte

//go:embed assets/skill.ja.json
var embeddedSkillJA []byte

// 窗口/任务栏图标。在这里内嵌它、而不是依赖 exe 自带的图标资源是刻意的：
// Windows 上的Wails 会去找图标资源 ID 3，找不到时就默默禁用图标——而本 exe 的资源是具名的、不是编号的，
// 所以 ID 3 是空的，标题栏就一片空白。
//
// build.ps1 在构建前会从 icon/sigiledit-256.png 复制一份到这里；
// 直接跑 `go build` 则用这里已经躺着的任意一份。
//
//go:embed appicon.png
var appIcon []byte

// mutexName 是单实例锁的名字。用 Local\ 前缀，所以这把锁按登录会话隔离，而不是按机器。
const mutexName = "Local\\GBFRSigilEditTool"

// toolWindowTitle 是工具窗口的标题，也是第二次启动时用来找到那个窗口的名字。
const toolWindowTitle = "GBFR Sigil Edit"

// swRestore 是 ShowWindow 的 SW_RESTORE：最小化的窗口会恢复到它先前的大小和位置。
const swRestore = 9

var (
	user32                  = syscall.NewLazyDLL("user32.dll")
	procFindWindowW         = user32.NewProc("FindWindowW")
	procShowWindow          = user32.NewProc("ShowWindow")
	procSetForegroundWindow = user32.NewProc("SetForegroundWindow")
	kernel32                = syscall.NewLazyDLL("kernel32.dll")
	procCreateMutexW        = kernel32.NewProc("CreateMutexW")
)

// ensureSingleInstance 取得那个具名互斥体，并把已持有它的那个实例的窗口带到最前面，
// 这样工具就不会在同一份 Config.json 上开两次。完全创建不出互斥体时就直接往下走，
// 工具于是像以前那样在没有锁的情况下启动。
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

// findToolWindow 返回工具主窗口的句柄（0 表示没找到）。
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

	// 写入要等编辑停下来，所以关窗口可能抢在它前面：防抖仍握着的列表会在退出途中发出。
	app.OnShutdown(edits.flushNow)

	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title: toolWindowTitle,
		/*
			两个尺寸都写成客户端尺寸加上 Windows 在其四周加的东西，所以需要改的数字就是
			前端用来布局的那些：宽度两侧各 8px 的调整边框（16），高度则是标题栏加边框（39）。
			在 96 DPI 下用 GetWindowRect 对比 GetClientRect 实测得到。
			888 x 581 也正是这份列表被排版出来的形状——大约九行加上说明分段——所以高度的最小值
			就是同一个数字：窗口可以变大，而两个方向都不能缩到比这些行所需的更小。
		*/
		Width:     888 + 16,
		MinWidth:  888 + 16,
		Height:    581 + 39,
		MinHeight: 581 + 39,
		// 与 shadcn 深色主题的 --background 令牌一致，这样窗口就不会在前端绘制之前闪出另一种颜色。
		BackgroundColour: application.NewRGB(10, 10, 10),
		URL:              "/",
	})

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
