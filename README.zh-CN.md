# GBFR Skill Edit

《碧蓝幻想：Relink》的**运行时技能参数修改工具**。游戏启动时在内存中改写
`system/table/skill_status.tbl` 的行，改动内容由一个小工具生成。**不落地任何
`.tbl` 文件**。

**正因为不落盘，它和其它改表 mod 不冲突。** 常见的改表 mod 会自带一份改好的
`.tbl` 覆盖游戏原文件，两个这样的 mod 改同一张表就会互相覆盖；本 mod 从游戏封包
里读出表，只改你指定的行，再通过 `IDataManager` 交回去，磁盘上什么都没变，因此
可以和别的 mod 并存。

## 前置条件

- Windows
- [Reloaded-II](https://github.com/Reloaded-Project/Reloaded-II)
- `gbfrelink.utility.manager`（本 mod 声明依赖它，读取游戏封包中的表就靠它）

## 安装

1. 装好并配置 Reloaded-II，再把 `gbfrelink.utility.manager` 加进去。
2. 运行 `SkillEditTool.exe`。
3. 选择 Reloaded-II 目录。输入框默认填 `%USERPROFILE%\Desktop\Reloaded-II`（即
   Reloaded-II 解压后原地运行时的位置），该目录里确实有 Reloaded-II 时直接用它；
   否则点这个输入框，选里有 `Reloaded-II.exe` 的那个目录。
4. 点「安装 Mod」。mod 本体写入 `<Reloaded-II>\Mods\GBFR.SkillEdit\`，改动列表
   写入 `<Reloaded-II>\User\Mods\GBFR.SkillEdit\Config.json`。
5. 在 Reloaded-II 里启用 `GBFR.SkillEdit`（同时确认
   `gbfrelink.utility.manager` 也已启用），然后用 Reloaded-II 启动游戏。

## 使用

- **添加技能**：在下拉框里选（可直接输入搜索），再点「添加」。新条目会带着该
  技能的原始数值，只需改你想改的那个数字。
- **改数字**：每行有十个数字框，对应表里的 `LevelValue1`..`LevelValue10`，与技能
  说明中的 `{1}`..`{10}` 一一对应。**把鼠标停在整行的任意位置**，会显示游戏自己
  对这条技能的说明，占位符已编号，与数字框对齐。
  - 留空的框会把游戏原值显示为灰色占位符，并存回原值。
- **等级**：框里显示 `Lv N / 满级`，`N` 是游戏显示的等级，`满级` 是该技能的上限，
  输入会被限制在这个范围内。新增技能时会自动选中该技能数值所在的等级。
- **启用 / 停用**：左侧复选框。改数字、改等级、勾选框都会立即保存；同一个「技能
  + 等级」只允许一条启用。
- **在游戏里生效**：参数只在游戏启动时读取一次，**改完必须重启游戏**。对运行中的
  游戏不会有任何影响。

## 配置存放位置

`<Reloaded-II>\User\Mods\GBFR.SkillEdit\Config.json`

这是 Reloaded-II 为每个 mod 分配的配置目录，也是 mod 读取改动列表的地方。工具会
自动写入；它本身就是普通 JSON，想手改也可以。mod 本体位于
`<Reloaded-II>\Mods\GBFR.SkillEdit\`。

## 界面语言

界面支持 **中文 / English / 日本語**，首次运行跟随系统语言，右上角可切换。技能名
取自游戏自己的文本表，因此也会随语言变化。

## 说明

- 选择器里是游戏里有显示名的 **200** 个技能；游戏里没有名字的技能不在此列。
- exe **未签名**，首次运行可能触发 Windows SmartScreen。选「更多信息」→「仍要
  运行」，或者自己从源码构建。
- 如果游戏里没有变化，看 `%TEMP%\GBFR.SkillEdit.log`：mod 会记录改了哪些行，找不到
  Config.json 时也会写明。

## 从源码构建

需要 .NET SDK 8、Node.js 20+、Go 1.25+。

```powershell
./build.ps1            # -> SkillEditTool/SkillEditTool.exe
./build.ps1 -Package   # -> dist-release/GBFR.SkillEdit-<版本>.zip
```

脚本先构建 mod DLL 并复制到 `SkillEditTool/assets/`，再构建前端，最后才编译 exe——
Go 构建会把前端产物和 DLL 一起内嵌，所以这两者必须先就位。

## 作者

作者 **baago**。源码与发布页：`<your-repo-url>`

[English README](README.md)

## 许可证

本项目基于 MIT 协议发布，详见 [LICENSE](LICENSE)。

项目内打包的第三方组件分别遵循各自协议：

- [shadcn/ui](https://ui.shadcn.com/) — MIT
- [Base UI](https://base-ui.com/) — MIT
- [lucide](https://lucide.dev/) — ISC
- [Geist](https://vercel.com/font) 字体 — SIL Open Font License 1.1
