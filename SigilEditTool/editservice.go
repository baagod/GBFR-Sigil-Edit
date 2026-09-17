package main

import (
	"encoding/json/jsontext"
	jsonv2 "encoding/json/v2"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"golang.org/x/sys/windows"
)

// LevelValueCount 是 skill_status 一行所带的 LevelValue 槽位数量，
// 也就是描述一次编辑需要多少个数字。
const LevelValueCount = 10

// SigilTrait 对应 mod 的 Config.cs 里的 SigilTrait：对 skill_status 一行的覆写。
// Values 按位置对应 LevelValue1..10，也就是技能自身描述里当作 {0}、{1}、{2}…… 用的那些槽位。
// 每个槽位要么是数字，要么是 nil；nil 表示那一处保留游戏原本的值（由 traits.ts 决定它是什么）。
type SigilTrait struct {
	Enabled bool       `json:"enabled"`
	Key     string     `json:"key"`
	Level   int        `json:"level"`
	Values  []*float64 `json:"values"`
}

// Config 对应 mod 的 Config.cs。mod 反序列化的正是这个形状。
type Config struct {
	Edits []SigilTrait `json:"edits"`
}

// modFolder 既是 Reloaded-II 里的文件夹名，也是 mod 的 ModId。它不是 Go 标识符，
// 所以保留原本的大小写。
const modFolder = "GBFR.SigilEdit"

// hotApplyEventName 是运行中的 mod 等待的 win32 事件。工具写完 Config.json 后设置
// 它，而活在游戏进程里的 mod 随即把编辑列表重新应用到游戏的内存表上，无需重启。
// 这个字符串与 mod 的 C# 源码里 HotApply.EventName 共用；两者之间没有任何关联，
// 所以要改名就得同时改两个文件。
//
// 之所以是变量，只是为了测试能把它指向一个没有真实游戏在监听的名字：测试里若创建
// mod 自己的名字，就会给正在运行的游戏发信号。
var hotApplyEventName = "GBFR.SigilEdit.HotApply"

// debounceDelay 是编辑列表必须静止多久才会被写入：一串连续按键最终只换来一次
// Config.json 写入和一次实时应用，而不是每按一次键就写一次。
const debounceDelay = 500 * time.Millisecond

// saveFailedEvent 把写入失败送到前端，前端用与即时失败相同的对话框显示它。
// 这个名字在 App.tsx 里有镜像；两者之间没有任何关联，所以要改名就得同时改两个文件。
const saveFailedEvent = "GBFR.SigilEdit.SaveFailed"

// signalHotApply 唤醒 mod —— 前提是确实有 mod 在运行可供唤醒。其余情况——
// 游戏已关闭、mod 被禁用、它的事件还没创建——都算正常的保存路径，不算错误，
// 因为 mod 下次启动时反正会重新读一遍 Config.json。
func signalHotApply(name string) bool {
	namePtr, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return false
	}
	event, err := windows.OpenEvent(windows.EVENT_MODIFY_STATE, false, namePtr)
	if err != nil {
		return false
	}
	defer windows.CloseHandle(event)
	return windows.SetEvent(event) == nil
}

// EditService 是 Wails 暴露给前端的后端。
//
// 它还保管着防抖尚未写出的那份列表。每次 SaveEdits 调用都替换这份列表并重启定时器，
// 所以最终落盘的永远是屏幕上最后的状态，绝不会是若干次按键的混合。
type EditService struct {
	mu      sync.Mutex
	pending []SigilTrait
	timer   *time.Timer
}

// LangZH 是工具被问到一个它没有对应表的语言时回退使用的语言。
const LangZH = "zh"

// decode 把一张内嵌表变成以因子哈希为 Key 的 map。没有空表这种情形要处理：
// 表缺失或格式不对时 Unmarshal 会留下一个空 map，而两种情况要的都是这个答案。
func decode[T any](raw []byte) map[string]T {
	decoded := make(map[string]T)
	_ = jsonv2.Unmarshal(raw, &decoded)
	return decoded
}

// ExplainBand 是一段共用同一份说明文案的等级：文案，以及它从哪个等级开始。
// 多数技能只有一个说明分段；少数会在中途换措辞，所以前端挑出覆盖它所显示那一行的分段。
//
// 资产把它写成 [等级, 文案] 这样的一对：一对里的两个数字，而不是命名字段，
// 因为每个分段都只按等级读取，别无所用。
type ExplainBand struct {
	Level int
	Text  string
}

func (b *ExplainBand) UnmarshalJSON(data []byte) error {
	pair, err := pairOf(data, "explanation band")
	if err != nil {
		return err
	}
	if err := jsonv2.Unmarshal(pair[0], &b.Level); err != nil {
		return err
	}
	return jsonv2.Unmarshal(pair[1], &b.Text)
}

// MarshalJSON 把这一对按资产原本的样子写回去：前端按 [等级, 文案] 读取分段，
// 而一个序列化成 {"Level":…,"Text":…} 的结构体会让它读不到任何分段。
func (b ExplainBand) MarshalJSON() ([]byte, error) {
	return jsonv2.Marshal([2]any{b.Level, b.Text})
}

// SkillText 是一种语言对一个因子的说法：它叫什么、做什么，以及游戏自己对它按等级分段
// 给出的说明。说明里的 {N} 代表 LevelValue(N+1)，也就是这个工具所编辑的那些数字，
// 这正是槽位的含义得以被知晓的原因。
type SkillText struct {
	Name    string        `json:"name"`
	Summary string        `json:"summary"`
	Explain []ExplainBand `json:"explain"`
}

// skillTables 把 UI 语言映射到它的文案表。每种语言里的 Key 都是同一批 8 位十六进制
// 哈希；不同的只是词语。
var skillTables = map[string]map[string]SkillText{
	LangZH: decode[SkillText](embeddedSkillZH),
	"en":   decode[SkillText](embeddedSkillEN),
	"ja":   decode[SkillText](embeddedSkillJA),
}

// SkillMap 返回某种语言的整张 哈希 -> 文案 表，好让前端在本地解析名称和说明，
// 而不是每行发一次调用。未知语言会拿到回退语言，而不是一个空列表。
func (s *EditService) SkillMap(lang string) map[string]SkillText {
	if texts, ok := skillTables[lang]; ok {
		return texts
	}
	return skillTables[LangZH]
}

// TraitRow 是一个带数字的因子的某一行 skill_status：等级，以及那一行的十个
// LevelValue 槽位。资产把它写成 [等级, [数值]] 这样的一对。
type TraitRow struct {
	Level  int
	Values []float64
}

func (r *TraitRow) UnmarshalJSON(data []byte) error {
	pair, err := pairOf(data, "skill_status row")
	if err != nil {
		return err
	}
	if err := jsonv2.Unmarshal(pair[0], &r.Level); err != nil {
		return err
	}
	return jsonv2.Unmarshal(pair[1], &r.Values)
}

// MarshalJSON 把这一对按资产原本的样子写回去：前端按 [等级, [数值]] 读取行。
func (r TraitRow) MarshalJSON() ([]byte, error) {
	return jsonv2.Marshal([2]any{r.Level, r.Values})
}

// TraitInfo 是生成的 skill_status.json 里的一行：
// 游戏自己给某个因子记下的数字，只在真正带数字的那些等级上。
//
// 这里只有带数字的等级。每个等级在表里都有一行，但大多数行全是零——万能药在它的 30 行里
// 只有 15 和 30 带数值——而一个指向零行的编辑写下的值，游戏在那里根本不会读。Key 是游戏的
// 其他表拼写这个因子时用的短 id（SKILL_156_00），用于到那些表里查它。
type TraitInfo struct {
	Key  string     `json:"key"`
	Rows []TraitRow `json:"rows"`
}

// traitInfo 把技能哈希——游戏管这些行叫 skills——映射到该因子自己的数字和等级。
// 从内嵌的 skill_status.json 填充一次。
var traitInfo = decode[TraitInfo](embeddedSkillStatus)

// TraitMap 返回整张 哈希 -> 因子 表，好让前端在本地解析某个等级的起始数值，
// 而不是每行发一次调用。
func (s *EditService) TraitMap() map[string]TraitInfo {
	return traitInfo
}

// pairOf 从资产里读出一个 [a, b] 对，好让形状错误能点出它来自哪一行，
// 而不是把零值反序列化进结构体里。
func pairOf(data []byte, what string) ([]jsontext.Value, error) {
	var pair []jsontext.Value
	if err := jsonv2.Unmarshal(data, &pair); err != nil {
		return nil, err
	}
	if len(pair) != 2 {
		return nil, fmt.Errorf("%s needs 2 items, got %d", what, len(pair))
	}
	return pair, nil
}

// padValues 把 Values 切片补齐到正好 LevelValueCount 长，这样无论手工编辑过的文件里
// 有什么，JSON 形状都保持稳定。缺失的槽位留作 nil —— nil 就是 “游戏自己的值”，
// 用 nil 补齐等于什么都没说，而不是说错什么。
func padValues(values []*float64) []*float64 {
	out := make([]*float64, LevelValueCount)
	copy(out, values)
	return out
}

// defaultEdits 是还没有配置文件时工具的起始内容。
func defaultEdits() []SigilTrait {
	return []SigilTrait{
		{Enabled: true, Key: "06719232", Level: 15, Values: padValues([]*float64{new(30.0), new(1.0), new(20.0)})},
		{Enabled: true, Key: "29B07BEB", Level: 15, Values: padValues([]*float64{new(2.0)})},
	}
}

// configDir 是工具与 mod 共用的文件夹：%APPDATA%\GBFR.SigilEdit。
//
// 不用 %TEMP%：编辑列表是用户自己的数据，而磁盘清理会删掉那里的东西。也不用 Mods\ 下
// mod 自己的文件夹：那样取名就意味着要问 Reloaded 每个 mod 的配置目录在哪，还要处理那次
// 查询失败的情况。ApplicationData 两边都能直接算出来，完全没有失败分支——Go 的
// os.UserConfigDir 与 C# 的 SpecialFolder.ApplicationData 解析到同一个文件夹。
func configDir() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, modFolder)
}

// configPath 是 mod 加载编辑列表用的文件，
// 位于 %APPDATA%\GBFR.SigilEdit 这个工具与 mod 共享状态的文件夹里。
func configPath() string {
	dir := configDir()
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, "Config.json")
}

// LoadEdits 从 Config.json 读取当前的编辑列表。
//
// “没东西可读”只指首次运行、文件根本不存在的情形。存在但读不出或解析不了的
// 文件是错误，而不是空列表：空列表是一个真实状态——所有编辑都关掉了——而把坏文件
// 显示成空列表，正是某次误触按键把这份空覆盖回用户自己编辑内容的方式。
func (s *EditService) LoadEdits() ([]SigilTrait, error) {
	path := configPath()
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return defaultEdits(), nil
		}
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}

	var cfg Config
	/*
	  严格按文件被写出来的样子读：成员名精确、不做大小写折叠、写入方不产出的东西一律不接受。
	  来自旧构建的文件——那时 Key 写作 “Edits”/“Enabled”/…… ——匹配不上任何成员，读出来就是
	  空列表，而这就是“从头来过”的既定形状：默认值回来，下一次保存写出当前格式。
	  一种格式、一个读取器，没有需要长期维护的兼容路径。
	*/
	if err := jsonv2.Unmarshal(raw, &cfg); err != nil {
		return nil, fmt.Errorf("parsing %s: %w", path, err)
	}

	// 这里不做任何过滤：哪些记录算编辑由前端决定（见 traits.ts 里的 asEdits），
	// Go 只负责补齐。被清空的列表也保持为空——起始编辑是给“文件根本不存在”准备的。
	edits := cfg.Edits
	for i := range edits {
		edits[i].Values = padValues(edits[i].Values)
	}
	return edits, nil
}

// SaveEdits 接过最新的编辑列表并重启防抖，好让写入发生在编辑停下来之后，
// 而不是编辑正在进行之中（见 debounceDelay）。
//
// 写入刻意不在这里做。每次调用都交出整个状态并重置防抖定时器；定时器最终触发时看到
// 的就是屏幕上最后的状态。前端保持愚笨——每次改动都调用它，从不等待回答——所以没有
// 状态可以回传。
//
// 只有“这份列表根本无法被接受”才会作为错误返回；定时器触发时失败的写入已经没有调用方
// 可以返回，于是改为推给前端（见 publish）。
func (s *EditService) SaveEdits(edits []SigilTrait) error {
	if configPath() == "" {
		return errors.New("could not resolve the %APPDATA% config folder")
	}

	for i := range edits {
		edits[i].Values = padValues(edits[i].Values)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.pending = edits
	if s.timer == nil {
		s.timer = time.AfterFunc(debounceDelay, s.flush)
	} else {
		s.timer.Reset(debounceDelay)
	}
	return nil
}

// writeEdits 把列表放到 mod 读取它的地方：%APPDATA%\GBFR.SigilEdit\Config.json ——
// 一个两边都不必询问对方就知道的文件夹。
//
// mod 的二进制文件绝不触碰——它和这个工具一起放在 Reloaded-II\Mods\GBFR.SigilEdit\ 里，
// 编辑过程中变化的只有 Config.json。把它放到那个位置属于发布时的打包，不是敲一下键盘就会发生的事。
func writeEdits(edits []SigilTrait) error {
	cfgPath := configPath()
	if cfgPath == "" {
		return errors.New("could not resolve the %APPDATA% config folder")
	}

	cfgBytes, err := jsonv2.Marshal(Config{Edits: edits}, jsontext.WithIndent("  "))
	if err != nil {
		return fmt.Errorf("serialising the edit list: %w", err)
	}

	if err := os.MkdirAll(filepath.Dir(cfgPath), 0o755); err != nil {
		return fmt.Errorf("creating the config folder: %w", err)
	}
	if err := os.WriteFile(cfgPath, cfgBytes, 0o644); err != nil {
		return fmt.Errorf("writing Config.json: %w", err)
	}
	return nil
}

// flush 是防抖触发时执行的：编辑已经停止，所以列表发出去，并通知正在运行的游戏。
// 列表是被取走而不是被读取，这样随后的关闭流程再取一次就什么也找不到、不会写第二遍——
// 而在取走之后才触发的定时器也没有东西可发。
func (s *EditService) flush() {
	s.mu.Lock()
	edits := s.pending
	s.pending = nil
	s.mu.Unlock()

	if edits == nil {
		return
	}
	s.publish(edits)
}

// flushNow 立即写出待写的列表，用于关闭流程：窗口可能在防抖窗口内就关掉，
// 而刚敲下的这次编辑才是用户想留下的。
// 防抖已经写过的列表不再处于待写状态，所以这里什么也找不到，也就什么都不会写。
func (s *EditService) flushNow() {
	s.mu.Lock()
	if s.timer != nil {
		s.timer.Stop()
	}
	edits := s.pending
	s.pending = nil
	s.mu.Unlock()

	if edits == nil {
		return
	}
	s.publish(edits)
}

// publish 是列表离开这个工具的唯一出口。
//
// 这里的失败没有调用方可以回溯：交出列表的那次调用早已返回，而这段代码跑在定时器的
// goroutine 上。所以它被记进日志——下一次编辑会用最新的列表重新给定时器上弦，那就是重试 ——
// 同时推给前端，因为一份从未到达磁盘的列表，看起来和 mod 什么都不做一模一样。
func (s *EditService) publish(edits []SigilTrait) {
	if err := writeEdits(edits); err != nil {
		log.Printf("GBFR.SigilEdit: %v", err)
		// Get 就是跑着本进程的这个 app；在测试里它是 nil，那里没有前端可通知。
		if app := application.Get(); app != nil {
			app.Event.Emit(saveFailedEvent, err.Error())
		}
		return
	}
	signalHotApply(hotApplyEventName)
}
