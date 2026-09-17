// 生成工具要内嵌的资产，以及用来看 "生成进去了什么" 的审阅表。
//
// 用法：
//
//	cd tools/build-assets && go run . assets            只写资产
//	cd tools/build-assets && go run . sheet             只写审阅表
//
// 标志必须写在阶段之前，这是 Go 的 flag 包的要求：
//
//	go run . -xlsx <路径> sheet
//
// 写出：
//
//	../../SigilEditTool/assets/skill_status.json     哪几个等级带着哪些数值
//	../../SigilEditTool/assets/skill.<lang>.json     名字、简介、分段说明
//	../../../texts.xlsx                              审阅表，10 种语言
//	                                                 （落在仓库的上一层）
//
// 两个阶段分开，是因为只有资产会被内嵌、被提交：写审阅表不该碰发布包里的文件。
// 两者读的是同一份游戏拷贝。
//
// 需要一份解包好的游戏，放在本仓库隔壁（上一层）：
// 表（缺库时用 GBFRDataTools 转成SQLite）与文本目录。资产是提交进仓库的，
// 所以构建与发布都不跑这个程序——只有重新生成资产才跑。Go 1.27，用到 encoding/json/v2。
package main

import (
	"bytes"
	"cmp"
	"database/sql"
	jsonv2 "encoding/json/v2"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"

	"github.com/xuri/excelize/v2"
	_ "modernc.org/sqlite"
)

// 工具要出的界面语言，以及游戏自己的目录名。中文表决定了工具提供哪些因子，所以它排第一。
var uiLangs = []struct{ code, dir string }{
	{"zh", "cs"}, {"en", "en"}, {"ja", "jp"},
}

// 审阅表带游戏有的全部语言，不只是工具出的那三种。
var sheetLangs = []struct{ code, dir string }{
	{"zh", "cs"}, {"en", "en"}, {"ja", "jp"}, {"es", "es"}, {"fr", "fr"},
	{"de", "ge"}, {"it", "it"}, {"ko", "ko"}, {"ct", "ct"}, {"bp", "bp"},
}

// 不是任何人会去改的因子——碰巧有名字的残留行。只有这一份清单，不按阶段各存一份：
// "工具提供不提供某个因子" 和 "它叫什么" 必须一致，两份只会在日后各走各的。
var excluded = map[string]bool{
	"9AD8B5E6": true, // 7net
	"0FBA47E8": true, // 强健甘露
	"A4D6B880": true, // 修炼甘露
	"CDEB73F6": true, // 幸运甘露
}

const (
	gdtVersion = "2.0.5"

	// 审阅表自己的样子，沿用工具表格一直用的那套样式。哈希列固定宽度，
	// 因为哈希恒为八个字符，而没有哈希的那些单元格是空的。
	sheetFont      = "鸿蒙黑体"
	sheetSize      = 10
	sheetRowHeight = 20
	sheetLangWidth = 16
	sheetHashWidth = 12
)

// Band 是一段共用同一句说明的等级：文案，以及它从哪一级开始。它按 [等级, 文案] 这个二元组传递。
type Band struct {
	Level int
	Text  string
}

func (b Band) MarshalJSON() ([]byte, error) { return jsonv2.Marshal([]any{b.Level, b.Text}) }

// Row 是 skill_status 的一行：等级、它的十个数值，以及这一行自己声明的说明文本 ID。
// 它按 [等级, [数值]] 这个二元组传递——desc 只用来拼分段说明，别处不读，所以不进 JSON。
type Row struct {
	Level  int
	Values []float64
	desc   string
}

func (r Row) MarshalJSON() ([]byte, error) { return jsonv2.Marshal([]any{r.Level, r.Values}) }

// traitRows 是 skill_status.json 里的一条，按因子哈希索引。
type traitRows struct {
	Key  string `json:"key"`
	Rows []Row  `json:"rows"`
}

// traitText 是 skill.<lang>.json 里的一条，按因子哈希索引。
type traitText struct {
	Name    string `json:"name"`
	Summary string `json:"summary"`
	Explain []Band `json:"explain"`
}

func main() {
	_, self, _, _ := runtime.Caller(0)
	repo := filepath.Join(filepath.Dir(self), "..", "..")
	shared := filepath.Dir(repo)
	assets := filepath.Join(repo, "SigilEditTool", "assets")

	xlsx := flag.String("xlsx", filepath.Join(shared, "texts.xlsx"), "where the sheet goes, when the stage is sheet")
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "usage: %s [-xlsx <path>] [assets|sheet]\n", filepath.Base(os.Args[0]))
		fmt.Fprintln(os.Stderr, "  assets  write the embedded assets (running the tool needs them)")
		fmt.Fprintln(os.Stderr, "  sheet   write the review sheet (not used at runtime)")
	}
	flag.Parse()

	stage := "assets"
	if flag.NArg() > 0 {
		stage = flag.Arg(0)
	}
	// 两个阶段是刻意分开的：不被内嵌的审阅表，不许碰工具要发布的那些文件 —— 这正是它们做成两条命令的全部理由。
	if stage != "assets" && stage != "sheet" {
		flag.Usage()
		os.Exit(2)
	}

	texts := make(map[string]map[string]string, len(sheetLangs))
	for _, l := range sheetLangs {
		messages, err := parseTextMessages(filepath.Join(shared, "extracted/system/table/text", l.dir))
		if err != nil {
			fail(err)
		}
		texts[l.code] = messages
	}

	idToHash, err := loadIDs(filepath.Join(shared, "GBFRDataTools/Data/ids.txt"))
	if err != nil {
		fail(err)
	}
	// gem 的列存短 ID（SKILL_127_00），而 skill_status 存 8 位十六进制哈希，
	// 所以两种写法必须收敛到同一个查找键。ids.txt 不认识的写法，本身就是哈希。
	normalize := func(value string) string {
		key := strings.TrimSpace(value)
		if hash, ok := idToHash[key]; ok {
			return hash
		}
		return key
	}

	db, err := openGameDB(shared)
	if err != nil {
		fail(err)
	}
	defer db.Close()

	// skill 才是给"工具要改的那一行"命名的表，所以名字与简介都取自它。
	// gem 只是把同一个因子改了个名字（还带个"＋"）。
	nameID := make(map[string]string)
	summaryID := make(map[string]string)
	for _, r := range mustQuery(db, "select Key, Name, Summary from skill") {
		hash := normalize(r[0])
		nameID[hash] = strings.TrimSpace(r[1])
		summaryID[hash] = strings.TrimSpace(r[2])
	}

	// 每个因子的每一行 skill_status，连同它自己的说明 ID：两个资产由同一遍扫描产出。
	// 短 ID 和行放在一起，因为它们本来就是这个表同一行的两半。
	type trait struct {
		key  string
		rows []Row
	}
	traits := make(map[string]*trait)
	for _, r := range mustQuery(db, "select Key, Level, LevelDescription, LevelValue1, LevelValue2, LevelValue3, LevelValue4, LevelValue5, LevelValue6, LevelValue7, LevelValue8, LevelValue9, LevelValue10 from skill_status") {
		hash := normalize(r[0])
		if excluded[hash] {
			continue
		}
		t := traits[hash]
		if t == nil {
			t = &trait{key: strings.TrimSpace(r[0])}
			traits[hash] = t
		}
		t.rows = append(t.rows, Row{
			Level:  atoi(r[1]),
			Values: numbers(r[3:]),
			desc:   strings.TrimSpace(r[2]),
		})
	}

	status := make(map[string]traitRows, len(traits))
	perLang := make(map[string]map[string]traitText, len(uiLangs))
	for _, l := range uiLangs {
		perLang[l.code] = make(map[string]traitText, len(traits))
	}

	for hash, t := range traits {
		// 工具提供哪些因子，只在一个地方决定——工具回退到的那种语言（中文）。这样每个资产
		// 带的是同一批因子，任何语言都不会各自跑偏。
		if texts["zh"][nameID[hash]] == "" {
			continue
		}
		slices.SortFunc(t.rows, func(a, b Row) int { return cmp.Compare(a.Level, b.Level) })

		// 只有 "带着数值" 的等级会进资产：指向全零行的编辑，写进去的值游戏根本不会读。
		// 绝大多数因子的绝大多数等级都是零——万能药的 30 行里只有 15、30 行有值。
		var carrying []Row
		for _, row := range t.rows {
			if anyNonZero(row.Values) {
				carrying = append(carrying, row)
			}
		}
		status[hash] = traitRows{Key: t.key, Rows: carrying}

		for _, l := range uiLangs {
			// 只有措辞变了才开一段新说明；与上一段相同的，并进上一段。
			var bands []Band
			for _, row := range t.rows {
				text := texts[l.code][row.desc]
				if text == "" {
					continue
				}
				if len(bands) > 0 && bands[len(bands)-1].Text == text {
					continue
				}
				bands = append(bands, Band{Level: row.Level, Text: text})
			}
			if len(bands) == 0 {
				continue
			}
			perLang[l.code][hash] = traitText{
				Name:    texts[l.code][nameID[hash]],
				Summary: texts[l.code][summaryID[hash]],
				Explain: bands,
			}
		}
	}

	if stage == "assets" {
		// 写盘之前，每种语言都必须与数值表对上：
		// 写到一半失败会在磁盘上留下半新半旧的资产，而工具内嵌的是它当时找到的那一份。
		for _, l := range uiLangs {
			if n := len(perLang[l.code]); n != len(status) {
				fail(fmt.Errorf("skill.%s.json 会带 %d 个因子，而 skill_status.json 带 %d 个", l.code, n, len(status)))
			}
		}

		out := filepath.Join(assets, "skill_status.json")
		if err := writeJSON(out, status); err != nil {
			fail(err)
		}
		fmt.Printf("skill_status.json: %d traits\n", len(status))
		for _, l := range uiLangs {
			out := filepath.Join(assets, "skill."+l.code+".json")
			if err := writeJSON(out, perLang[l.code]); err != nil {
				fail(err)
			}
			fmt.Printf("skill.%s.json: %d traits\n", l.code, len(perLang[l.code]))
		}
	}

	if stage == "sheet" {
		if err := writeSheet(*xlsx, db, texts, idToHash); err != nil {
			fail(err)
		}
		fmt.Println("sheet:", *xlsx)
	}
}

// loadIDs 把工具箱的 "哈希 <-> 短 ID" 清单读成 id -> 哈希。
func loadIDs(path string) (map[string]string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	out := make(map[string]string)
	for _, line := range strings.Split(string(raw), "\n") {
		parts := strings.Split(strings.TrimRight(line, "\r"), "|")
		if len(parts) >= 3 {
			out[parts[2]] = parts[0]
		}
	}
	return out, nil
}

// openGameDB 打开游戏表的 SQLite 副本，缺了就先用 GBFRDataTools 转一份。
func openGameDB(shared string) (*sql.DB, error) {
	const (
		table = "extracted/system/table"
		dbRel = "extracted/gbfr.db"
	)
	file := filepath.Join(shared, dbRel)
	if !hasSkillStatus(file) {
		tool := filepath.Join(shared, "GBFRDataTools/GBFRDataTools.exe")
		if _, err := os.Stat(tool); err != nil {
			return nil, fmt.Errorf("missing %s: the tables have not been converted", tool)
		}
		_ = os.Remove(file)
		cmd := exec.Command(tool, "tbl-to-sqlite", "-i", filepath.Join(shared, table), "-o", file, "-v", gdtVersion)
		cmd.Stdout, cmd.Stderr = nil, nil
		if err := cmd.Run(); err != nil {
			return nil, fmt.Errorf("converting the tables: %w", err)
		}
	}
	return sql.Open("sqlite", "file:"+file+"?mode=ro")
}

// hasSkillStatus 不只看文件在不在，还看它里面有没有 skill_status 表：
// 一个存在但没有表的库比没有库更糟——后面每一步检查都会看到一个 "在那儿" 的文件。
func hasSkillStatus(dbFile string) bool {
	if _, err := os.Stat(dbFile); err != nil {
		return false
	}
	db, err := sql.Open("sqlite", "file:"+dbFile+"?mode=ro")
	if err != nil {
		return false
	}
	defer db.Close()
	var name string
	return db.QueryRow("select name from sqlite_master where name = 'skill_status'").Scan(&name) == nil
}

// mustQuery 把每个单元格都当文本取回来：
// 这个程序只从游戏表里读 ID、等级和数值，而转换工具把它们全都写成了文本。
func mustQuery(db *sql.DB, query string) [][]string {
	sqlRows, err := db.Query(query)
	if err != nil {
		fail(err)
	}
	defer sqlRows.Close()

	cols, err := sqlRows.Columns()
	if err != nil {
		fail(err)
	}
	var out [][]string
	for sqlRows.Next() {
		scan := make([]sql.NullString, len(cols))
		dest := make([]any, len(cols))
		for i := range scan {
			dest[i] = &scan[i]
		}
		if err := sqlRows.Scan(dest...); err != nil {
			fail(err)
		}
		row := make([]string, len(cols))
		for i := range scan {
			row[i] = scan[i].String
		}
		out = append(out, row)
	}
	if err := sqlRows.Err(); err != nil {
		fail(err)
	}
	return out
}

func numbers(cells []string) []float64 {
	out := make([]float64, len(cells))
	for i, c := range cells {
		v, _ := strconv.ParseFloat(strings.TrimSpace(c), 64)
		out[i] = v
	}
	return out
}

// anyNonZero 判断一行是否至少有一个槽有数值——没有的行不进资产。
func anyNonZero(values []float64) bool {
	for _, v := range values {
		if v != 0 {
			return true
		}
	}
	return false
}

// atoi 读等级：单元格是文本，转换工具写坏了就是 0。
func atoi(s string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(s))
	return n
}

// parseTextMessages 读一个语言目录。游戏把 `id_hash_`<ID> 和 `text_`<文本> 两种记录交错存放，
// 每个字符串有自己的长度前缀，所以按"成对"的方式走文件。
func parseTextMessages(dir string) (map[string]string, error) {
	out := make(map[string]string)
	idMarker := []byte("id_hash_")
	textMarker := []byte("text_")

	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".msg") {
			return err
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for p := 0; ; {
			i := bytes.Index(b[p:], idMarker)
			if i < 0 {
				break
			}
			i += p
			id, next, ok := pstring(b, i+8)
			if !ok {
				p = i + 8
				continue
			}
			// 游戏用 NUL 补齐字符串；ID 里不会含 NUL。
			id = strings.ReplaceAll(id, "\x00", "")
			if id == "" {
				p = next
				continue
			}
			t := -1
			if j := bytes.Index(b[next:], textMarker); j >= 0 {
				t = next + j
			}
			if t >= 0 {
				if text, _, ok := pstring(b, t+5); ok {
					text = strings.TrimSpace(strings.ReplaceAll(text, "\x00", ""))
					if text != "" {
						if _, seen := out[id]; !seen {
							out[id] = text
						}
					}
				}
			}
			if t >= 0 {
				p = t + 5
			} else {
				p = next
			}
		}
		return nil
	})
	return out, err
}

// pstring 读一个带长度前缀的字符串：一个字节自身编码短长度，
// 或者 0xd9/0xda 后面跟一/两个字节的长度。
func pstring(b []byte, pos int) (string, int, bool) {
	if pos >= len(b) {
		return "", 0, false
	}
	var length, extra int
	switch h := b[pos]; {
	case h >= 0xa0 && h < 0xc0:
		length, extra = int(h)-0xa0, 0
	case h == 0xd9:
		if pos+1 >= len(b) {
			return "", 0, false
		}
		length, extra = int(b[pos+1]), 1
	case h == 0xda:
		if pos+2 >= len(b) {
			return "", 0, false
		}
		length, extra = int(b[pos+1])*0x100+int(b[pos+2]), 2
	default:
		return "", 0, false
	}
	start := pos + 1 + extra
	if start+length > len(b) {
		return "", 0, false
	}
	return string(b[start : start+length]), start + length, true
}

// writeSheet 写审阅表：每张带文本 ID 的表一个 sheet，一个 ID 一行，游戏有的每种语言一列，
// 再加上该 ID 自己的哈希——那是游戏表和原始 .tbl 用的写法。
func writeSheet(path string, db *sql.DB, texts map[string]map[string]string, idToHash map[string]string) error {
	sources := []struct{ name, query string }{
		{"gem", "select Name from gem union select Description from gem"},
		{"skill", "select Name from skill union select Summary from skill union select Explain from skill"},
		{"skill_status", "select LevelDescription from skill_status"},
	}

	f := excelize.NewFile()
	defer f.Close()

	head, err := f.NewStyle(&excelize.Style{
		Font:      &excelize.Font{Bold: true, Color: "FFFFFF", Family: sheetFont, Size: sheetSize},
		Fill:      excelize.Fill{Type: "pattern", Pattern: 1, Color: []string{"0070C0"}},
		Alignment: &excelize.Alignment{Horizontal: "center", Vertical: "center", WrapText: true},
		Border:    sheetBorder(),
	})
	if err != nil {
		return err
	}
	// 数据格一律左对齐，这样长名字从第一个字就能读。
	body, err := f.NewStyle(&excelize.Style{
		Font:      &excelize.Font{Family: sheetFont, Size: sheetSize},
		Alignment: &excelize.Alignment{Horizontal: "left", Vertical: "center", WrapText: true},
		Border:    sheetBorder(),
	})
	if err != nil {
		return err
	}

	// key、hash，然后每种语言一列。列名交给 excelize 算：手数列字母，
	// 语言数一多就会算出 [、\ 这种非法列名。
	last, err := excelize.ColumnNumberToName(2 + len(sheetLangs))
	if err != nil {
		return err
	}
	for _, s := range sources {
		ids := sheetIDs(db, s.query)
		if _, err := f.NewSheet(s.name); err != nil {
			return err
		}

		row := make([]any, 0, len(sheetLangs)+2)
		row = append(row, "key", "hash")
		for _, l := range sheetLangs {
			row = append(row, l.code)
		}
		if err := f.SetSheetRow(s.name, "A1", &row); err != nil {
			return err
		}
		for r, id := range ids {
			row = row[:0]
			row = append(row, id, hashOf(id, idToHash))
			for _, l := range sheetLangs {
				row = append(row, texts[l.code][id])
			}
			cell, err := excelize.CoordinatesToCellName(1, r+2)
			if err != nil {
				return err
			}
			if err := f.SetSheetRow(s.name, cell, &row); err != nil {
				return err
			}
		}

		if err := f.SetCellStyle(s.name, "A1", last+"1", head); err != nil {
			return err
		}
		if len(ids) > 0 {
			if err := f.SetCellStyle(s.name, "A2", fmt.Sprintf("%s%d", last, len(ids)+1), body); err != nil {
				return err
			}
		}
		for i := range len(ids) + 1 {
			if err := f.SetRowHeight(s.name, i+1, sheetRowHeight); err != nil {
				return err
			}
		}
		if err := f.SetColWidth(s.name, "B", "B", sheetHashWidth); err != nil {
			return err
		}
		if err := f.SetColWidth(s.name, "C", last, sheetLangWidth); err != nil {
			return err
		}
		// key 列是唯一"每张表内容都不同"的列，所以只给它做自适应。
		// excelize 按普通字体的度量估算，对这些 ID（24 字符的鸿蒙黑体 10 号）会短两个单位左右：
		// ID 折到第二行，而固定 20 的行高又把第二行裁掉。保留它的自适应，但绝不低于最长 ID 需要的宽度，
		// 26 正是 Office 自己的 AutoFit 给这一列定下的宽度。
		if err := f.AutoFitColWidth(s.name, "A"); err != nil {
			return err
		}
		if len(ids) > 0 {
			fit, err := f.GetColWidth(s.name, "A")
			if err != nil {
				return err
			}
			longest := len(slices.MaxFunc(ids, func(a, b string) int { return len(a) - len(b) }))
			if want := float64(longest + 2); fit < want {
				if err := f.SetColWidth(s.name, "A", "A", want); err != nil {
					return err
				}
			}
		}
		if err := f.SetPanes(s.name, &excelize.Panes{Freeze: true, YSplit: 1, TopLeftCell: "A2", ActivePane: "bottomLeft"}); err != nil {
			return err
		}
		fmt.Printf("  %s: %d ids\n", s.name, len(ids))
	}

	if err := f.DeleteSheet("Sheet1"); err != nil {
		return err
	}
	f.SetActiveSheet(0)
	return f.SaveAs(path)
}

// sheetIDs 取某张表各文本列点到的、去重且非空的文本 ID。
func sheetIDs(db *sql.DB, query string) []string {
	seen := make(map[string]bool)
	var ids []string
	for _, r := range mustQuery(db, query) {
		id := strings.TrimSpace(r[0])
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	slices.Sort(ids)
	return ids
}

// hashOf 是一个文本 ID 在游戏自己表里存成的哈希。工具箱反查不出来的 ID，
// 本身就是那个哈希；其余情况没有哈希可给。
func hashOf(id string, idToHash map[string]string) string {
	if hash, ok := idToHash[id]; ok {
		return hash
	}
	if len(id) == 8 {
		if _, err := strconv.ParseUint(id, 16, 32); err == nil {
			return id
		}
	}
	return ""
}

// sheetBorder 是审阅表四边的细线。
func sheetBorder() []excelize.Border {
	return []excelize.Border{
		{Type: "left", Color: "000000", Style: 1},
		{Type: "right", Color: "000000", Style: 1},
		{Type: "top", Color: "000000", Style: 1},
		{Type: "bottom", Color: "000000", Style: 1},
	}
}

func writeJSON(path string, value any) error {
	// 排序输出：资产是提交进仓库的，不排序的话同一批表每次运行都会给出不同的 map 字节序，
	// 于是每次重新生成都变成整文件 diff。
	//
	// 注意：现在提交的那几份资产是**手工格式化过**的（4 空格缩进、数组按约 240 列换行），
	// 而这里写出的是紧凑单行，所以重新生成仍会出现一次整文件 diff——这是既定约定，不是 bug。
	// 要让它归零，就提交本程序写出的紧凑版本。
	data, err := jsonv2.Marshal(value, jsonv2.Deterministic(true))
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

// fail 把所有错误都汇到一个出口：这个程序是手工运行的开发工具，报错就退出。
func fail(err error) {
	fmt.Fprintln(os.Stderr, "错误:", err)
	os.Exit(1)
}
