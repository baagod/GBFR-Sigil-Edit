# GBFR Skill Edit

[中文](README.zh-CN.md)

A **runtime skill-parameter editor** for *Granblue Fantasy: Relink*. At game startup it rewrites rows of `system/table/skill_status.tbl` in memory. **It ships no `.tbl` file, so it does not conflict with other table mods.**

A typical table mod brings its own edited `.tbl` and overwrites the game's copy, so two mods touching the same table clobber each other. This mod reads the table out of the game's archive, changes only the rows you name, and hands it back through `IDataManager`. Nothing on disk changes, which is why it can live alongside other mods.

## Requirements

- Windows
- [Reloaded-II](https://github.com/Reloaded-Project/Reloaded-II)
- `gbfrelink.utility.manager` (reads the game's archive tables)

## Installing

1. Set up Reloaded-II, then add `gbfrelink.utility.manager` to it.
2. Run `SkillEdit.exe`.
3. Choose your Reloaded-II folder. The box is pre-filled with `%USERPROFILE%\Desktop\Reloaded-II`; that folder is used as-is when it really is a Reloaded-II install, otherwise pick the folder that contains `Reloaded-II.exe`.
4. Click **Install mod**. The mod itself goes to `<Reloaded-II>\Mods\GBFR.SkillEdit\`, and your edit list to `%APPDATA%\GBFR.SkillEdit\Config.json`.
5. Enable `GBFR.SkillEdit` in Reloaded-II (make sure `gbfrelink.utility.manager` is enabled too), then launch the game through Reloaded-II.

## Using it

- **Adding a skill**: pick one in the dropdown (you can type to search) and click Add. The new entry starts from that skill's own vanilla numbers, so only the value you care about needs changing.
- **Editing numbers**: every row has ten boxes, corresponding to `LevelValue1-10` in the table and to `{1-10}` in the skill's own description. **Hovering anywhere on the row** shows that description, with the placeholders numbered to match the boxes. A box left empty shows the game's value greyed out as a placeholder, and writes that value back.
- **Taking effect in game**: the parameters are read once, at game startup — **restart the game after changing them**. A running game is unaffected.

## Languages

The interface ships in **中文 / English / 日本語**. It follows your system language on first run, and can be switched in the top-right corner.

## Notes

- The picker offers the **200** skills the game gives a display name to. Skills without one are not listed.
- The exe is **unsigned**, so Windows SmartScreen may warn on first run. Choose "More info" → "Run anyway", or build it from source yourself.
- If nothing changes in game, read `<Reloaded-II>\Mods\GBFR.SkillEdit\GBFR.SkillEdit.log`: the mod records which rows it changed (rewritten on every launch), and names the path where it looked when it cannot find `Config.json`.

## Building from source

Needs .NET SDK 8, Node.js 20+, Go 1.25+.

```powershell
./build.ps1            # -> SkillEditTool/SkillEdit.exe
./build.ps1 -Package   # -> dist-release/GBFR.SkillEdit-<version>.zip
```

The script builds the mod DLL and copies it into `SkillEditTool/assets/`, then builds the frontend, and only then compiles the exe — the Go build embeds both, so they have to be in place first.
