# GBFR Sigil Edit

[English](README.md)

《碧蓝幻想：Relink》的 **因子参数编辑器**。

常见的改表 mod 会自带一份改好的 `.tbl`，两个这样的 mod 改同一张表就会互相覆盖；本 mod 不带 `.tbl`，而是从游戏封包中读出表，在游戏启动时从内存中改写 `skill_status.tbl` 的行，因此它可以和其他 **改表** mod 并存。

> **AI 辅助开发声明**：本 mod 代码由 AI 助手在人类指导下编写；需求设计、游戏内验证与文档生成等由人类主导。 
> 
> 本 mod 不修改任何游戏本体文件，数据仅从归档读出，写进内存，不改存档。
> 
> **仅供单机使用，联机游玩时风险自负。**

**下载**：[Nexus](https://www.nexusmods.com/granbluefantasyrelink/mods/858) / [GitHub Release](https://github.com/baagod/GBFR-Sigil-Edit/releases)

## 前置条件

- [Reloaded-II](https://github.com/Reloaded-Project/Reloaded-II)
- [gbfrelink.utility.manager](https://github.com/WistfulHopes/gbfrelink.utility.manager)（读取游戏封包表）

## 安装

1. 解压发布包，把 `GBFR.SigilEdit` 文件夹放进 `Reloaded-II\Mods\` 并启用 ( 同时启用 `gbfrelink.utility.manager` )。
2. 使用 Reloaded-II 启动游戏。
3. 想改数值时运行 `SigilEdit.exe`，改动配置存放在 `%APPDATA%\GBFR.SigilEdit\Config.json`。

## 使用

- **添加因子**：在搜索框中按名称或 hash 找到它，勾选它所在的行（或其中某一等级）即启用。该等级的游戏原值以灰字占位符显示，**你改哪个槽就写哪个槽**——数值与游戏原值相同的槽按"没输入"处理，显示回灰字占位符，也不写进配置。**输入数值不会自动启用**——勾选才是让它在游戏里生效的开关。配置里只保留"已勾选、或你输入过数值"的等级；既没勾选也没输入过的等级不写进配置（勾了又取消，或把输入过的数值全部清空，都会把它移除）。
- **修改参数**：每行有十个参槽，**鼠标停在整行** 会显示这个因子的说明。占位符已编号，与参数位对齐，置空会把游戏原值灰显为占位符，并存回原值。
- **生效说明**：改动时 **因子描述** 实时生效，但 **实际效果** 在下一场战斗开始时生效。

## 说明

- 界面支持 **中文 / English / 日本語**，首次运行跟随系统语言，右上角可切换。
- exe **未签名**，首次运行可能触发 Windows SmartScreen。选「更多信息」→「仍要运行」，或者自己从源码构建。
- 如果游戏里没有变化，看 `Reloaded-II\Mods\GBFR.SigilEdit\GBFR.SigilEdit.log`：mod 会记录改了哪些行，以及它去哪儿找过 `Config.json`。

## 从源码构建

需要 .NET SDK 8、Node.js 20+（仅重新生成资产需要 22.5+）、Go 1.27+。

```powershell
./build.ps1 -Package   # -> dist/GBFR.SigilEdit/ 与 dist/GBFR.SigilEdit-<版本>.zip
./deploy.ps1           # -> 复制 dist/GBFR.SigilEdit 到 Reloaded-II/Mods/（先关掉游戏）
```
