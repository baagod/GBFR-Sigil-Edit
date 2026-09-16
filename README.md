# GBFR Sigil Edit

[中文](README.zh-CN.md)

A **sigil parameter editor** for *Granblue Fantasy: Relink*.

A typical table mod brings its own edited `.tbl`; two such mods editing the same table overwrite each other. This mod carries no `.tbl`: it reads the table out of the game's archive and rewrites the rows of `skill_status.tbl` in memory at game startup, so it can live alongside other **table** mods.

**Download**: [Nexus](https://www.nexusmods.com/granbluefantasyrelink/mods/858) / [GitHub Release](https://github.com/baagod/GBFR-Sigil-Edit/releases)

## Requirements

- [Reloaded-II](https://github.com/Reloaded-Project/Reloaded-II)
- [gbfrelink.utility.manager](https://github.com/WistfulHopes/gbfrelink.utility.manager) (reads the game's archive tables)

## Installing

1. Unzip the release, move the `GBFR.SigilEdit` folder into `Reloaded-II\Mods\` and enable it (enable `gbfrelink.utility.manager` as well).
2. Launch the game through Reloaded-II.
3. Run `SigilEdit.exe` when you want to change values. Your edit list lives in `%APPDATA%\GBFR.SigilEdit\Config.json`.

## Using it

- **Adding a sigil**: find it in the search box by name or hash, then tick its row - or a single level of it - to switch that trait on. The entry carries the trait's original values, so only the number you want needs changing.
- **Editing parameters**: every row has ten slots; **hovering anywhere on the row** shows that sigil's description. The placeholders are numbered to line up with the slots, and an empty slot greys the game's own value out as a placeholder and writes that value back.
- **Taking effect**: the **sigil description** changes live, but the **actual effect** applies when the next battle starts.

## Notes

- The interface ships in **中文 / English / 日本語**. It follows your system language on first run, and can be switched in the top-right corner.
- The exe is **unsigned**, so Windows SmartScreen may warn on first run. Choose "More info" → "Run anyway", or build it from source yourself.
- If nothing changes in game, read `Reloaded-II\Mods\GBFR.SigilEdit\GBFR.SigilEdit.log`: the mod records which rows it changed, and where it went looking for `Config.json`.

## Building from source

Needs .NET SDK 8, Node.js 20+ (22.5+ only to regenerate the assets), Go 1.27+.

```powershell
./build.ps1 -Package # -> dist/GBFR.SigilEdit/ + dist/GBFR.SigilEdit-<version>.zip
./deploy.ps1         # -> copies dist/GBFR.SigilEdit into Reloaded-II/Mods/ (close the game first)
```
