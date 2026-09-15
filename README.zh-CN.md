# GBFR Sigil Edit

[English](README.md)

《碧蓝幻想：Relink》的 **因子参数编辑器**。

**下载**：[Nexus 页面](https://www.nexusmods.com/granbluefantasyrelink/mods/858) · [GitHub Release](https://github.com/baagod/GBFR-Sigil-Edit/releases)

常见的改表 mod 会自带一份改好的 `.tbl`，两个这样的 mod 改同一张表就会互相覆盖；本 mod 不带 `.tbl`，而是从游戏封包中读出表，在游戏启动时从内存中改写 `skill_status.tbl` 的行，因此它可以和其他 **改表** mod 并存。

## 前置条件

- [Reloaded-II](https://github.com/Reloaded-Project/Reloaded-II)
- [gbfrelink.utility.manager](https://github.com/WistfulHopes/gbfrelink.utility.manager)（读取游戏封包表）

## 安装

1. 安装 Reloaded-II 并启用 `gbfrelink.utility.manager`。
2. 解压发布包，把 `GBFR.SigilEdit` 文件夹放进 `Reloaded-II\Mods\`。
3. 在 Reloaded-II 里启用 `GBFR.SigilEdit` 后使用 Reloaded-II 启动游戏。
4. 想改数值时运行 `Reloaded-II\Mods\GBFR.SigilEdit\SigilEdit.exe`。改动配置存放在 `%APPDATA%\GBFR.SigilEdit\Config.json`。

## 使用

- **添加因子**：在下拉框中添加你想要改动的因子。新条目带着该因子词条的原始值，只需改你想改的那个数值。
- **修改参数**：每行有十个参槽，**鼠标停在整行** 会显示这个因子的说明。占位符已编号，与参数位对齐，置空会把游戏原值灰显为占位符，并存回原值。
- **生效说明**：改动时 **因子描述** 实时生效，但 **实际效果** 在下一场战斗开始时生效。

## 说明

- 界面支持 **中文 / English / 日本語**，首次运行跟随系统语言，右上角可切换。
- exe **未签名**，首次运行可能触发 Windows SmartScreen。选「更多信息」→「仍要运行」，或者自己从源码构建。
- 如果游戏里没有变化，看 `Reloaded-II\Mods\GBFR.SigilEdit\GBFR.SigilEdit.log`：mod 会记录改了哪些行，以及它去哪儿找过 `Config.json`。

## 从源码构建

需要 .NET SDK 8、Node.js 22.5+、Go 1.25+。

```powershell
./build.ps1 -Package   # -> dist/GBFR.SigilEdit/ 与 dist/GBFR.SigilEdit-<版本>.zip
./deploy.ps1           # -> 复制 dist/GBFR.SigilEdit 到 Reloaded-II/Mods/（先关掉游戏）
```
