# GBFR Sigil Edit

[English](README.md)

《碧蓝幻想：Relink》的 **因子词条修改工具**。游戏启动时在内存中改写 `system/table/skill_status.tbl` 的行，**不落地任何 `.tbl` 文件，它和其它改表 mod 不冲突。**

> 说明一下名字：改的是**因子（Sigil）身上的词条**——就是你截图/面板里 `ATK`、`DMG Cap`、`Autorevive` 那些带 `Lv` 的条目，不是角色的技能。游戏内部数据把这类词条叫 `skill`（表名 `skill_status`，因子记录里的字段是 `skill1`/`skill2`），本 mod 早期因此叫 SkillEdit；为了和「角色技能」区分，现在统一叫 **Sigil Edit**。代码里与游戏数据对齐的 `skill_status` 表名保持不变。

常见的改表 mod 会自带一份改好的 `.tbl` 覆盖游戏原文件，两个这样的 mod 改同一张表就会互相覆盖；本 mod 从游戏封包里读出表，只改你指定的行，再通过 `IDataManager` 交回去，磁盘上什么都没变，因此可以和别的 mod 并存。

## 前置条件

- [Reloaded-II](https://github.com/Reloaded-Project/Reloaded-II)
- [gbfrelink.utility.manager](https://github.com/WistfulHopes/gbfrelink.utility.manager)（读取游戏封包表）

## 安装

1. 安装 Reloaded-II 并启用 `gbfrelink.utility.manager`。
2. 解压发布包，把 `GBFR.SigilEdit` 文件夹整个放进 `<Reloaded-II>\Mods\`。这个文件夹**就是** mod：DLL、清单和 `SigilEdit.exe` 都在里面，工具本身不安装任何东西，也不需要选目录。
3. 在 Reloaded-II 里启用 `GBFR.SigilEdit`（同时确认 `gbfrelink.utility.manager` 也已启用），然后用 Reloaded-II 启动游戏。
4. 想改数值时运行 `<Reloaded-II>\Mods\GBFR.SigilEdit\SigilEdit.exe`。改动列表存放在 `%APPDATA%\GBFR.SigilEdit\Config.json`。

## 使用

- **添加词条**：在下拉框里选（可直接输入搜索），再点「添加」。新条目会带着该词条的原始数值，只需改你想改的那个数字。
- **改参数**：每行有十个参数框，对应表里的 `LevelValue1-10`。**鼠标停在整行** 会显示这条词条的说明，占位符已编号，与参数位对齐，置空会把游戏原值灰显为占位符，并存回原值。
- **在游戏里生效**：没有安装按钮，也不需要重启 —— 编辑本身就是部署。停手 0.5 秒后，改动写入 `%APPDATA%\GBFR.SigilEdit\Config.json`，并通知运行中的游戏重新应用；继续改就一直等最后一次。游戏启动后 mod 会在后台自动定位数据表（对玩家无感），应用时只做毫秒级的地址校验与写入；若后台定位未能稳定，则第一次应用会现场扫描一次（几秒），此后即时。
- **已经开始的战斗仍用开打时的数值**：战斗一开始，游戏就把词条的参数结算进自己的结构，整场战斗读的都是那份结构，所以战斗中途的改动要到下一场战斗才用上；词条描述则立刻改变。战斗之外的显示、以及之后开始的每一场战斗，都是改动后的值，全程不需要重启游戏。
- **打字期间不写盘**：连续改动只会在最后一次之后 0.5 秒产生一次写入。若在这半秒内关掉工具，待写入的列表会在退出时补写。

## 说明

- 界面支持 **中文 / English / 日本語**，首次运行跟随系统语言，右上角可切换。
- exe **未签名**，首次运行可能触发 Windows SmartScreen。选「更多信息」→「仍要运行」，或者自己从源码构建。
- 如果游戏里没有变化，看 `<Reloaded-II>\Mods\GBFR.SigilEdit\GBFR.SigilEdit.log`：mod 会记录改了哪些行，以及它去哪儿找过 `Config.json`。

## 从源码构建

需要 .NET SDK 8、Node.js 20+、Go 1.25+。只有**重新生成游戏资产**（`tools/build-assets.js`，构建与发版都不走它）要求更高：**Node 22.5+**，因为它用内置的 `node:sqlite` 读游戏数据库。

```powershell
./build.ps1            # -> SigilEditTool/SigilEdit.exe
./build.ps1 -Package   # -> dist/GBFR.SigilEdit/ 与 dist/GBFR.SigilEdit-<版本>.zip
./deploy.ps1           # 把 dist/GBFR.SigilEdit/ 复制进 Mods\（先关掉游戏）
```

脚本先构建 mod DLL，再构建前端，最后才编译 exe —— Go 构建会把前端产物内嵌，所以前端必须先就位。`-Package` 会组装出 `dist/GBFR.SigilEdit/`（整份放进 `Mods/` 的 mod 目录），并与本文档一起打包成 zip。
