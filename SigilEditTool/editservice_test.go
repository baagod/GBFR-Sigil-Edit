package main

import (
	"bytes"
	jsonv2 "encoding/json/v2"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"golang.org/x/sys/windows"
)

/*
任何测试都不允许给真实游戏正在监听的那个事件发信号。写入路径发的是包里持有的那个
名字，所以整个测试运行都把它指向本进程自己的名字：这台机器上开着的游戏永远不会收到
测试的信号，测试也不必再借那个名字来避开它。
*/
func TestMain(m *testing.M) {
	hotApplyEventName = fmt.Sprintf("GBFR.SigilEdit.HotApply.Test.Run.%d", os.Getpid())
	os.Exit(m.Run())
}

// appDataConfig 是 mod 读取的路径：Environment.SpecialFolder.ApplicationData 就是
// %APPDATA%，也正是 os.UserConfigDir 在 Windows 上给出的答案。这里直接写出来而不是走
// configPath，是为了让测试陈述这个位置，而不是把实现原样背回去。
func appDataConfig(t *testing.T, name string) string {
	t.Helper()
	appData := os.Getenv("APPDATA")
	if appData == "" {
		t.Fatal("APPDATA is unset")
	}
	return filepath.Join(appData, modFolder, name)
}

// hermeticHome 把 %APPDATA%——工具与 mod 唯一共用的那条路径——指向一个一次性文件夹，
// 这样测试永远不会写进真实的那个。
func hermeticHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("USERPROFILE", home)
	t.Setenv("HOME", home)
	t.Setenv("APPDATA", filepath.Join(home, "AppData", "Roaming"))
	t.Setenv("LOCALAPPDATA", filepath.Join(home, "AppData", "Local"))
	return home
}

/*
openModEvent 代替运行中的 mod：写入是按名字给事件发信号，所以测试按那个名字把事件持有
起来并盯着它。TestMain 已经把那个名字指离了这台机器上任何游戏会等待的事件，而且对象是
在干净状态下创建的，因为 CreateEvent 可能打开了一个已经被置位的对象。
*/
func openModEvent(t *testing.T) windows.Handle {
	t.Helper()
	ptr, err := windows.UTF16PtrFromString(hotApplyEventName)
	if err != nil {
		t.Fatal(err)
	}
	event, err := windows.CreateEvent(nil, 0, 0, ptr)
	if err != nil {
		t.Fatalf("creating the test event: %v", err)
	}
	t.Cleanup(func() { windows.CloseHandle(event) })
	_ = windows.ResetEvent(event)
	return event
}

// flushNow 在这里代替防抖的定时器，所以断言关心的是列表落到哪里，而不是等上一秒。
func TestSaveEditsWritesConfigWhereTheModReadsIt(t *testing.T) {
	hermeticHome(t)

	service := &EditService{}
	edits := []SigilTrait{{Enabled: true, Key: "06719232", Level: 15, Values: padValues([]*float64{new(30.0), new(1.0), new(20.0)})}}
	if err := service.SaveEdits(edits); err != nil {
		t.Fatalf("SaveEdits: %v", err)
	}
	service.flushNow()

	wantCfg := appDataConfig(t, "Config.json")
	raw, err := os.ReadFile(wantCfg)
	if err != nil {
		t.Fatalf("Config.json is not where the mod looks for it: %v", err)
	}
	var cfg Config
	if err := jsonv2.Unmarshal(raw, &cfg); err != nil {
		t.Fatalf("Config.json is not valid JSON: %v", err)
	}
	if len(cfg.Edits) != 1 || cfg.Edits[0].Key != "06719232" || *cfg.Edits[0].Values[0] != 30 {
		t.Fatalf("Config.json round-trip lost data: %+v", cfg.Edits)
	}
	// 没人输入过的槽位在文件里是 null 这个词，而正是它告诉 mod 那一部分保持原样。
	// 这条记录设置了十个槽位里的三个。
	if len(cfg.Edits[0].Values) < LevelValueCount {
		t.Fatalf("Config.json came back with %d slots, want %d", len(cfg.Edits[0].Values), LevelValueCount)
	}
	if cfg.Edits[0].Values[3] != nil {
		t.Fatalf("an untouched slot came back as %v, want nil", cfg.Edits[0].Values)
	}
	if !strings.Contains(string(raw), "null") {
		t.Fatalf("untouched slots are not spelled null in the file: %s", raw)
	}
}

/*
防抖是尾沿触发，这既是在说什么时候不写，也一样是在说什么时候写：编辑还在进行时，
mod 读取的那个文件必须仍是旧的那份——而且每次调用都必须重启那段安静期，所以真正发生的
那次写入带的是最后的状态，而不是第一个状态。

气泡把这件事从关于时钟的陈述变成关于代码的陈述：半秒瞬间过去，一个不再重启定时器的实现
会在这里失败，而不是在一台只是碰巧很慢的机器上蒙混过关。
*/
func TestSaveEditsWaitsForTheEditingToStop(t *testing.T) {
	hermeticHome(t)

	synctest.Test(t, func(t *testing.T) {
		service := &EditService{}
		cfgPath := appDataConfig(t, "Config.json")

		first := []SigilTrait{{Enabled: true, Key: "06719232", Level: 15, Values: padValues([]*float64{new(30.0)})}}
		if err := service.SaveEdits(first); err != nil {
			t.Fatalf("SaveEdits: %v", err)
		}
		time.Sleep(debounceDelay / 4)
		if _, err := os.Stat(cfgPath); err == nil {
			t.Fatal("Config.json was written while the debounce window was still open")
		}

		// 第二次按键重启了那段窗口：第一次不能已经留下一次写入，这一次同样还不能。
		last := []SigilTrait{{Enabled: true, Key: "06719232", Level: 15, Values: padValues([]*float64{new(300.0)})}}
		if err := service.SaveEdits(last); err != nil {
			t.Fatalf("SaveEdits: %v", err)
		}
		time.Sleep(debounceDelay / 4)
		if _, err := os.Stat(cfgPath); err == nil {
			t.Fatal("a second edit did not restart the debounce window")
		}

		// 从这里开始安静下来：最后的状态落地，且只落一次。不用轮询：气泡已经把定时器的回调跑到结束了。
		time.Sleep(debounceDelay * 2)
		synctest.Wait()

		raw, err := os.ReadFile(cfgPath)
		if err != nil {
			t.Fatalf("the debounce never wrote Config.json: %v", err)
		}
		var cfg Config
		if err := jsonv2.Unmarshal(raw, &cfg); err != nil {
			t.Fatalf("Config.json is not valid JSON: %v", err)
		}
		if len(cfg.Edits) != 1 || *cfg.Edits[0].Values[0] != 300 {
			t.Fatalf("the write is not the last state on screen: %+v", cfg.Edits)
		}
	})
}

/*
做不成的写入会被记进日志并推给前端，而这两件事都不能把工具一起带走：失败发生在防抖
定时器的 goroutine 上，那里没有调用方可以接住 panic。测试里没有窗口，
所以这里也覆盖了 “没有 app 可通知” 那条分支。
*/
func TestSaveEditsSurvivesAWriteItCannotMake(t *testing.T) {
	home := hermeticHome(t)

	// 一个占着配置文件夹位置的普通文件：它下面每一次 mkdir 和写入都必然失败，
	// 这正是一个被锁住或只读的 %APPDATA% 的真实模样。
	blocked := filepath.Join(home, "AppData", "Roaming", modFolder)
	if err := os.MkdirAll(filepath.Dir(blocked), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(blocked, []byte("not a folder"), 0o644); err != nil {
		t.Fatal(err)
	}

	service := &EditService{}
	edits := []SigilTrait{{Enabled: true, Key: "06719232", Level: 15, Values: padValues([]*float64{new(30.0)})}}
	if err := service.SaveEdits(edits); err != nil {
		t.Fatalf("SaveEdits: %v", err)
	}

	// 失败必须在某处可见。这里没有窗口可推，所以日志是这条故事里本测试抓得住的那一半。
	var logged bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&logged)
	defer log.SetOutput(previous)

	// 接受这份列表不依赖磁盘，所以失败的是写入——而 flushNow 正是防抖定时器本该落地的地方。
	service.flushNow()

	if !strings.Contains(logged.String(), "creating the config folder") {
		t.Fatalf("a write that could not be made went unrecorded: %q", logged.String())
	}
}

// 工具编辑的那份列表就是 mod 读取的那份，所以它必须从同一个 %APPDATA% 文件里读回来：
// 读别处的实现会给用户看一份并非正在部署的列表。
func TestLoadEditsReadsTheAppDataConfig(t *testing.T) {
	hermeticHome(t)

	current := appDataConfig(t, "Config.json")
	if err := os.MkdirAll(filepath.Dir(current), 0o755); err != nil {
		t.Fatal(err)
	}
	body := []byte(`{"edits":[{"enabled":true,"key":"B064A634","level":14,"values":[300,10,300,10]}]}`)
	if err := os.WriteFile(current, body, 0o644); err != nil {
		t.Fatal(err)
	}

	loaded, err := (&EditService{}).LoadEdits()
	if err != nil {
		t.Fatalf("LoadEdits: %v", err)
	}
	if len(loaded) != 1 || loaded[0].Key != "B064A634" || *loaded[0].Values[0] != 300 {
		t.Fatalf("Config.json was not read back: %+v", loaded)
	}
	if len(loaded[0].Values) != LevelValueCount {
		t.Fatalf("loaded values were not padded: %v", loaded[0].Values)
	}
}

// 没东西可读时，工具从自己的默认值出发，而不是一块空白屏幕。
func TestLoadEditsFallsBackToDefaults(t *testing.T) {
	hermeticHome(t)

	loaded, err := (&EditService{}).LoadEdits()
	if err != nil {
		t.Fatalf("LoadEdits: %v", err)
	}
	if len(loaded) != len(defaultEdits()) {
		t.Fatalf("expected the default list, got %+v", loaded)
	}
	for _, edit := range loaded {
		if len(edit.Values) != LevelValueCount {
			t.Fatalf("%s: default values were not padded: %v", edit.Key, edit.Values)
		}
	}
}

/*
存在但解析不了的文件是一个会点出文件名的错误。

这个区分的要点在于屏幕上显示什么：“解析不了”说的是文件坏了、坏的是哪一个，而空列表
看起来就和“什么都没打开”一模一样——下一次按键就会把这份空列表覆盖回用户自己的编辑。
*/
func TestLoadEditsRejectsAFileItCannotParse(t *testing.T) {
	hermeticHome(t)

	current := appDataConfig(t, "Config.json")
	if err := os.MkdirAll(filepath.Dir(current), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(current, []byte("not json"), 0o644); err != nil {
		t.Fatal(err)
	}

	loaded, err := (&EditService{}).LoadEdits()
	if err == nil {
		t.Fatalf("a file that cannot be parsed was accepted as %+v", loaded)
	}
	if !strings.Contains(err.Error(), "Config.json") {
		t.Fatalf("the error does not say which file: %v", err)
	}
}

// 空列表是一个状态，不是起点：它是把所有编辑都关掉之后留下的东西，所以它就保持为空，
// 而不会变回用户刚刚关掉的那些内置默认值。
func TestLoadEditsKeepsAnEmptyList(t *testing.T) {
	hermeticHome(t)

	current := appDataConfig(t, "Config.json")
	if err := os.MkdirAll(filepath.Dir(current), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(current, []byte(`{"edits":[]}`), 0o644); err != nil {
		t.Fatal(err)
	}

	loaded, err := (&EditService{}).LoadEdits()
	if err != nil {
		t.Fatalf("LoadEdits: %v", err)
	}
	if len(loaded) != 0 {
		t.Fatalf("an empty list came back as %+v", loaded)
	}
}

/*
只有一种格式、一个读取器：来自 Key 还写作大写那个构建的文件既不会被读取，也不会被改写。
它读作空列表——这正是用户在格式变更时要的行为：“它读一个 Edits，读不到就是一个空配置” ——
而下一次保存写出当前格式。这个测试特意把这个行为钉下来，好让它是一个决定，而不是一次意外。
*/
func TestLoadEditsDoesNotReadAFileFromTheOldKeySpelling(t *testing.T) {
	hermeticHome(t)

	current := appDataConfig(t, "Config.json")
	if err := os.MkdirAll(filepath.Dir(current), 0o755); err != nil {
		t.Fatal(err)
	}
	old := []byte(`{"Edits":[{"Enabled":true,"Key":"B064A634","Level":14,"Values":[300]}]}`)
	if err := os.WriteFile(current, old, 0o644); err != nil {
		t.Fatal(err)
	}

	loaded, err := (&EditService{}).LoadEdits()
	if err != nil {
		t.Fatalf("LoadEdits: %v", err)
	}
	if len(loaded) != 0 {
		t.Fatalf("an old-spelling file should read as an empty list: %+v", loaded)
	}

	untouched, err := os.ReadFile(current)
	if err != nil {
		t.Fatal(err)
	}
	if string(untouched) != string(old) {
		t.Fatalf("the file was rewritten; loading does not write: %s", untouched)
	}
}

/*
padValues 是“正好十个槽位”这条不变量的守门人，无论文件里装的是什么：短列表用 nil 补齐，
长列表被截断，因为它喂的那张表只有十个 LevelValue 槽位，而 mod 按顺序读取它们。nil 就是
没人输入过的那个槽位——游戏自己的值——所以用它补齐等于什么都没写，而不是写一个零。
*/
func TestPadValuesAlwaysGivesTenSlots(t *testing.T) {
	short := padValues([]*float64{new(1.0), new(2.0), new(3.0)})
	if len(short) != LevelValueCount || *short[0] != 1 || short[3] != nil {
		t.Fatalf("a short list was not padded to %d: %v", LevelValueCount, short)
	}

	long := padValues([]*float64{
		new(1.0), new(2.0), new(3.0), new(4.0), new(5.0), new(6.0),
		new(7.0), new(8.0), new(9.0), new(10.0), new(11.0), new(12.0),
	})
	if len(long) != LevelValueCount {
		t.Fatalf("a long list was not cut to %d: %v", LevelValueCount, long)
	}
	if *long[0] != 1 || *long[LevelValueCount-1] != 10 {
		t.Fatalf("a long list kept the wrong values: %v", long)
	}
}

// 资产是一起生成的，但仍然分成两个文件：数值与语言无关，文案不是。如果它们的 Key 集合
// 发生漂移，新增一个技能会悄悄产出一个空名字（或一行没有数值的行），
// 所以这里断言每种语言描述的技能集合与数值一致——并且互相之间也一致。
func TestSkillTablesAgree(t *testing.T) {
	if len(traitInfo) == 0 {
		t.Fatal("skill_status.json did not load")
	}
	if len(skillTables) != 3 {
		t.Fatalf("expected a table each for zh, en and ja, got %d", len(skillTables))
	}
	var reference map[string]SkillText
	for _, lang := range []string{"zh", "en", "ja"} {
		texts, ok := skillTables[lang]
		if !ok {
			t.Fatalf("no text table for %s", lang)
		}
		if len(texts) == 0 {
			t.Fatalf("the %s text table is empty", lang)
		}
		if len(texts) != len(traitInfo) {
			t.Fatalf("%s: key count differs from the values table: texts %d, skills %d",
				lang, len(texts), len(traitInfo))
		}
		for key := range texts {
			if _, ok := traitInfo[key]; !ok {
				t.Fatalf("%s: skill %s has text but no values", lang, key)
			}
		}
		if reference == nil {
			reference = texts
			continue
		}
		for key := range reference {
			if _, ok := texts[key]; !ok {
				t.Fatalf("%s is missing skill %s, which other languages have", lang, key)
			}
		}
	}
	for hash, info := range traitInfo {
		// 一次编辑可能点到的每个等级都有自己的一行，且带齐十个槽位：
		// 否则一个槽位的占位符（以及清空输入框后写回的值）就会来自另一个等级。
		if len(info.Rows) == 0 {
			t.Fatalf("skill %s has no level rows", hash)
		}
		for _, row := range info.Rows {
			if len(row.Values) != LevelValueCount {
				t.Fatalf("skill %s level %d has %d values, want %d",
					hash, row.Level, len(row.Values), LevelValueCount)
			}
		}
	}
}

// 线格式合同：资产里的 [等级, 数值] / [等级, 文案] 元组，Go 侧解码后必须原样编码回去。
//
// 这是手写契约，没有别的机械校验：MarshalJSON 一旦丢失、或退回成结构体字段语义，Go 测试与
// 前端 tsc 都会全绿，而 App.tsx 里 `as Record<string, SkillText>` 会静默收下
// {Level, Text}，用户看到的只是空 tooltip 与 0 占位。所以这里按字节把它钉住。
func TestWireShapeStaysTuples(t *testing.T) {
	status, err := jsonv2.Marshal(map[string]TraitInfo{
		"06719232": {
			Key:  "SKILL_156_00",
			Rows: []TraitRow{{Level: 15, Values: []float64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10}}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"06719232":{"key":"SKILL_156_00","rows":[[15,[1,2,3,4,5,6,7,8,9,10]]]}}`; string(status) != want {
		t.Fatalf("skill_status.json 的线格式变了:\n got %s\nwant %s", status, want)
	}

	text, err := jsonv2.Marshal(map[string]SkillText{
		"06719232": {
			Name:    "万能药",
			Summary: "一句简介",
			Explain: []ExplainBand{{Level: 1, Text: "第一段"}, {Level: 30, Text: "第二段"}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"06719232":{"name":"万能药","summary":"一句简介","explain":[[1,"第一段"],[30,"第二段"]]}}`; string(text) != want {
		t.Fatalf("skill.<lang>.json 的线格式变了:\n got %s\nwant %s", text, want)
	}
}

// 同一个技能在每种语言里都必须还是同一个技能——按哈希认，名字则是翻译过的。
func TestSkillTablesAreTranslated(t *testing.T) {
	zh := skillTables["zh"]["06719232"].Name
	en := skillTables["en"]["06719232"].Name
	ja := skillTables["ja"]["06719232"].Name
	if zh == "" || en == "" || ja == "" {
		t.Fatalf("06719232 is missing a name in some language: zh=%q en=%q ja=%q", zh, en, ja)
	}
	if zh == en || zh == ja || en == ja {
		t.Fatalf("the tables are not actually translated: zh=%q en=%q ja=%q", zh, en, ja)
	}
}

// 未知语言会回退，而不是交回一个空列表。
func TestSkillMapFallsBack(t *testing.T) {
	service := &EditService{}
	if got := len(service.SkillMap("ko")); got == 0 {
		t.Fatal("an unknown language produced an empty text map")
	}
	if got := len(service.SkillMap("en")); got == 0 {
		t.Fatal("en produced an empty text map")
	}
}

// 黑龙的咒印 是那个现成的例子：原版在等级 15 是 10/3/20，而 mod 的全部用意就是把第一个值提上去。
//
// 它也是说明为什么只有带数字的等级会进资产的例子：
// 这个技能的等级 1 到 14 全是零，所以它们根本不在资产里——编辑只能点到一个游戏真正会读到值的行。
func TestKnownSkillRows(t *testing.T) {
	info, ok := traitInfo["06719232"]
	if !ok {
		t.Fatal("06719232 (黑龙的咒印) missing from skill_status.json")
	}
	if info.Key == "" {
		t.Fatal("06719232 has no short id to look it up by")
	}

	want := []float64{10, 3, 20, 0, 0, 0, 0, 0, 0, 0}
	at15 := -1
	for i, row := range info.Rows {
		if row.Level == 15 {
			at15 = i
		}
		if row.Level == 14 {
			t.Fatalf("level 14 is all zeros, so it should not be in the asset: %v", info.Rows)
		}
	}
	if at15 < 0 {
		t.Fatal("06719232 has no level 15 row")
	}
	for i := range want {
		if got := info.Rows[at15].Values[i]; got != want[i] {
			t.Fatalf("06719232 level 15[%d] = %v, want %v", i, got, want[i])
		}
	}
}

// 一个因子提供的每个等级都带数字，一个都不漏，而且按顺序排列。
func TestLevelRangesAreUsable(t *testing.T) {
	if len(traitInfo) == 0 {
		t.Fatal("skill_status.json did not load")
	}
	for hash, info := range traitInfo {
		if len(info.Rows) == 0 {
			t.Fatalf("%s offers no level at all", hash)
		}
		for i, row := range info.Rows {
			if row.Level < 1 {
				t.Fatalf("%s offers Lv%d", hash, row.Level)
			}
			if i > 0 && info.Rows[i-1].Level >= row.Level {
				t.Fatalf("%s offers levels out of order: %v", hash, info.Rows)
			}
			carries := false
			for _, value := range row.Values {
				if value != 0 {
					carries = true
				}
			}
			if !carries {
				t.Fatalf("%s offers Lv%d, which carries no values", hash, row.Level)
			}
		}
	}
}

// 那些并非真正技能的行必须从每张表里都不见。
func TestExcludedRowsAreGone(t *testing.T) {
	for _, hash := range []string{"9AD8B5E6", "0FBA47E8", "A4D6B880", "CDEB73F6"} {
		if _, ok := traitInfo[hash]; ok {
			t.Fatalf("%s should not be offered", hash)
		}
		for lang, texts := range skillTables {
			if _, ok := texts[hash]; ok {
				t.Fatalf("%s should not be named in %s", hash, lang)
			}
		}
	}
}

func TestSignalHotApplyWithoutTheGame(t *testing.T) {
	name := fmt.Sprintf("GBFR.SigilEdit.HotApply.Test.Absent.%d", os.Getpid())
	if signalHotApply(name) {
		t.Fatal("signalled an event that should not exist")
	}
}

// SaveEdits 必须在写完配置后唤醒正在运行的 mod，好让数值落进一个活着的游戏而不必重启。
// 测试用 openModEvent 为它持有的那个事件来模拟 mod。
func TestSaveEditsSignalsTheRunningMod(t *testing.T) {
	hermeticHome(t)
	event := openModEvent(t)

	service := &EditService{}
	edits := []SigilTrait{{Enabled: true, Key: "06719232", Level: 15, Values: padValues([]*float64{new(30.0), new(1.0), new(20.0)})}}
	if err := service.SaveEdits(edits); err != nil {
		t.Fatalf("SaveEdits: %v", err)
	}
	service.flushNow()

	state, err := windows.WaitForSingleObject(event, 0)
	if err != nil {
		t.Fatalf("waiting on the mod's event: %v", err)
	}
	if state != windows.WAIT_OBJECT_0 {
		t.Fatal("the write did not signal the mod's event, so a running game would not hot-apply")
	}
}

// 没有东西待写，就什么都不写、什么都不发信号：一串编辑就是一次写入和一次唤醒，
// 无论 flush 被调用多少次。
func TestFlushWithNothingPendingDoesNothing(t *testing.T) {
	hermeticHome(t)
	event := openModEvent(t)

	service := &EditService{}
	edits := []SigilTrait{{Enabled: true, Key: "06719232", Level: 15, Values: padValues([]*float64{new(30.0)})}}
	if err := service.SaveEdits(edits); err != nil {
		t.Fatalf("SaveEdits: %v", err)
	}
	service.flushNow()
	_ = windows.ResetEvent(event)

	service.flushNow()

	state, err := windows.WaitForSingleObject(event, 0)
	if err != nil {
		t.Fatalf("waiting on the mod's event: %v", err)
	}
	if state != uint32(windows.WAIT_TIMEOUT) {
		t.Fatalf("a flush with nothing pending signalled the mod (wait state %#x)", state)
	}
}
