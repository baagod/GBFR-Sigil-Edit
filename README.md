# GBFR Skill Edit

[中文](README.zh-CN.md)

A **skill-parameter editor** for *Granblue Fantasy: Relink*. At game startup it rewrites rows of `system/table/skill_status.tbl` in memory. **It ships no `.tbl` file, so it does not conflict with other table mods.**

A typical table mod brings its own edited `.tbl` and overwrites the game's copy, so two mods touching the same table clobber each other. This mod reads the table out of the game's archive, changes only the rows you name, and hands it back through `IDataManager`. Nothing on disk changes, which is why it can live alongside other mods.

## Requirements

- [Reloaded-II](https://github.com/Reloaded-Project/Reloaded-II)
- [gbfrelink.utility.manager](https://github.com/WistfulHopes/gbfrelink.utility.manager) (reads the game's archive tables)

## Installing

1. Install Reloaded-II and enable `gbfrelink.utility.manager`.
2. Unzip the release and move the `GBFR.SkillEdit` folder into `<Reloaded-II>\Mods\`. That folder **is** the mod: the DLL, its manifest and `SkillEdit.exe`. Nothing is installed by the tool itself, and there is no folder to pick.
3. Enable `GBFR.SkillEdit` in Reloaded-II (make sure `gbfrelink.utility.manager` is enabled too), then launch the game through Reloaded-II.
4. Run `SkillEdit.exe` from `<Reloaded-II>\Mods\GBFR.SkillEdit\` to change values. Your edit list lives in `%APPDATA%\GBFR.SkillEdit\Config.json`.

## Using it

- **Adding a skill**: pick one in the dropdown (you can type to search) and click Add. The new entry starts from that skill's own vanilla numbers, so only the value you care about needs changing.
- **Editing parameters**: every row has ten parameter boxes, corresponding to `LevelValue1-10` in the table. **Hovering anywhere on the row** shows that skill's description, with the placeholders numbered to line up with the boxes; a box left empty greys the game's own value out as a placeholder, and writes that value back.
- **Taking effect in game**: there is no install button and no restart - editing is the deployment. Half a second after you stop typing, the list is written to `%APPDATA%\GBFR.SkillEdit\Config.json` and the running game is told to re-apply it; keep typing and the write simply waits for you. While the game boots, the mod locates the table in the background, so a click verifies the known copies in milliseconds. If the background locate never stabilized, the first apply scans once instead.
- **Nothing is written while you type**: a burst of keystrokes becomes a single write, half a second after the last one. Closing the tool inside that window writes the pending list on the way out.

## Notes

- The interface ships in **中文 / English / 日本語**. It follows your system language on first run, and can be switched in the top-right corner.
- The exe is **unsigned**, so Windows SmartScreen may warn on first run. Choose "More info" → "Run anyway", or build it from source yourself.
- If nothing changes in game, read `<Reloaded-II>\Mods\GBFR.SkillEdit\GBFR.SkillEdit.log`: the mod records which rows it changed, and where it went looking for `Config.json`.

## Building from source

Needs .NET SDK 8, Node.js 20+, Go 1.25+.

```powershell
./build.ps1          # -> SkillEditTool/SkillEdit.exe
./build.ps1 -Package # -> dist/GBFR.SkillEdit/ + dist/GBFR.SkillEdit-<version>.zip
./deploy.ps1         # copies dist/GBFR.SkillEdit/ into Mods\ (close the game first)
```

The script builds the mod DLL, then the frontend, and only then compiles the exe — the Go build embeds the frontend bundle, so it has to be in place first. `-Package` assembles `dist/GBFR.SkillEdit/`, the folder that goes into `Mods/` as the whole mod, and zips it together with these documents.
