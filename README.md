# GBFR Sigil Edit

[中文](README.zh-CN.md)

A **sigil-trait editor** for *Granblue Fantasy: Relink*. At game startup it rewrites rows of `system/table/skill_status.tbl` in memory. **It ships no `.tbl` file, so it does not conflict with other table mods.**

> A word on the name: what it edits are the **traits a sigil carries** - the `ATK`, `DMG Cap`, `Autorevive` entries with a `Lv` you see on the sigil screen - not character skills. The game's own data calls them `skill` (the table is `skill_status`, and a sigil record points at them through `skill1`/`skill2`), which is where this mod's old name came from; it is **Sigil Edit** now to keep that apart from character skills. The `skill_status` table name in the code stays as the game spells it.

A typical table mod brings its own edited `.tbl` and overwrites the game's copy, so two mods touching the same table clobber each other. This mod reads the table out of the game's archive, changes only the rows you name, and hands it back through `IDataManager`. Nothing on disk changes, which is why it can live alongside other mods.

## Requirements

- [Reloaded-II](https://github.com/Reloaded-Project/Reloaded-II)
- [gbfrelink.utility.manager](https://github.com/WistfulHopes/gbfrelink.utility.manager) (reads the game's archive tables)

## Installing

1. Install Reloaded-II and enable `gbfrelink.utility.manager`.
2. Unzip the release and move the `GBFR.SigilEdit` folder into `<Reloaded-II>\Mods\`. That folder **is** the mod: the DLL, its manifest and `SigilEdit.exe`. Nothing is installed by the tool itself, and there is no folder to pick.
3. Enable `GBFR.SigilEdit` in Reloaded-II (make sure `gbfrelink.utility.manager` is enabled too), then launch the game through Reloaded-II.
4. Run `SigilEdit.exe` from `<Reloaded-II>\Mods\GBFR.SigilEdit\` to change values. Your edit list lives in `%APPDATA%\GBFR.SigilEdit\Config.json`.

## Using it

- **Adding a trait**: pick one in the dropdown (you can type to search) and click Add. The new entry starts from that trait's own vanilla numbers, so only the value you care about needs changing.
- **Editing parameters**: every row has ten parameter boxes, corresponding to `LevelValue1-10` in the table. **Hovering anywhere on the row** shows that trait's description, with the placeholders numbered to line up with the boxes; a box left empty greys the game's own value out as a placeholder, and writes that value back.
- **Taking effect in game**: there is no install button and no restart - editing is the deployment. Half a second after you stop typing, the list is written to `%APPDATA%\GBFR.SigilEdit\Config.json` and the running game is told to re-apply it; keep typing and the write simply waits for you. While the game boots, the mod locates the table in the background, so a click verifies the known copies in milliseconds. If the background locate never stabilized, the first apply scans once instead.
- **Nothing is written while you type**: a burst of keystrokes becomes a single write, half a second after the last one. Closing the tool inside that window writes the pending list on the way out.

## Notes

- The interface ships in **中文 / English / 日本語**. It follows your system language on first run, and can be switched in the top-right corner.
- The exe is **unsigned**, so Windows SmartScreen may warn on first run. Choose "More info" → "Run anyway", or build it from source yourself.
- If nothing changes in game, read `<Reloaded-II>\Mods\GBFR.SigilEdit\GBFR.SigilEdit.log`: the mod records which rows it changed, and where it went looking for `Config.json`.

## Building from source

Needs .NET SDK 8, Node.js 20+, Go 1.25+. Only regenerating the game-derived assets (`tools/build-assets.js`, which no build and no release needs) asks for more: **Node 22.5+**, for the built-in `node:sqlite` it reads the game's database with.

```powershell
./build.ps1          # -> SigilEditTool/SigilEdit.exe
./build.ps1 -Package # -> dist/GBFR.SigilEdit/ + dist/GBFR.SigilEdit-<version>.zip
./deploy.ps1         # copies dist/GBFR.SigilEdit/ into Mods\ (close the game first)
```

The script builds the mod DLL, then the frontend, and only then compiles the exe — the Go build embeds the frontend bundle, so it has to be in place first. `-Package` assembles `dist/GBFR.SigilEdit/`, the folder that goes into `Mods/` as the whole mod, and zips it together with these documents.
