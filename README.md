# GBFR Skill Edit

A runtime skill-parameter editor for **Granblue Fantasy: Relink**. It rewrites
rows of `system/table/skill_status.tbl` in memory while the game starts, driven
by an edit list you build in a small desktop tool. No `.tbl` is ever shipped or
written to disk.

**No table file is touched, so this mod does not conflict with other table
mods.** Mods that patch tables usually ship a modified `.tbl` and replace the
game's copy; two of them editing the same table overwrite each other. This one
reads the table out of the game archive, changes the rows you asked for, and
hands it back through `IDataManager` — nothing on disk changes, so it can sit
next to whatever else you run.

## Requirements

- Windows
- [Reloaded-II](https://github.com/Reloaded-Project/Reloaded-II)
- The `gbfrelink.utility.manager` mod (this mod is declared to depend on it, and
  it is what provides access to the game's table archive)

## Install

1. Install and set up Reloaded-II, then add `gbfrelink.utility.manager` to it.
2. Run `SkillEditTool.exe`.
3. Pick your Reloaded-II folder. The field is pre-filled with
   `%USERPROFILE%\Desktop\Reloaded-II` (where Reloaded-II lands when it is
   unpacked and run in place) and is used as-is when it is really there;
   otherwise click the field and choose the folder that contains
   `Reloaded-II.exe`.
4. Click **Install mod**. This writes the mod into
   `<Reloaded-II>\Mods\GBFR.SkillEdit\` and your edit list into
   `<Reloaded-II>\User\Mods\GBFR.SkillEdit\Config.json`.
5. Enable `GBFR.SkillEdit` in Reloaded-II (make sure
   `gbfrelink.utility.manager` is enabled too) and launch the game through
   Reloaded-II.

## Using the tool

- **Add a skill**: pick one from the dropdown (type to search), then click
  **Add**. A new entry starts on that skill's own vanilla numbers, so you only
  change the number you care about.
- **Change numbers**: each row has ten boxes, which are the table's
  `LevelValue1`..`LevelValue10`. They line up with the `{1}`..`{10}`
  placeholders in the skill's own description. **Hover anywhere on a row** to
  read the game's own explanation of that skill, with its placeholders numbered
  to match the boxes.
  - A box left empty shows the game's original value as a placeholder and is
    written back unchanged.
- **Level**: the box reads `Lv N / max`. `N` is the level as the game displays
  it, `max` is that skill's maximum, and the field is clamped to it. Adding a
  skill preselects the level its values actually live on.
- **Enable / disable**: the checkbox on the left. Editing the numbers, the level
  or the checkboxes saves immediately; a skill and level pair can only have one
  enabled entry at a time.
- **Apply in game**: parameter changes are read once, when the game starts —
  **restart the game** after editing. Nothing is applied to a running game.

## Where your edits are stored

`<Reloaded-II>\User\Mods\GBFR.SkillEdit\Config.json`

That is Reloaded-II's per-mod configuration directory, which is where the mod
reads its edit list from. The tool writes it for you; it is plain JSON if you
would rather edit it by hand. The mod itself lives in
`<Reloaded-II>\Mods\GBFR.SkillEdit\`.

## Languages

The interface ships in **中文 / English / 日本語** and follows the system
language on first run; the switch is in the top right. Skill names come from the
game's own text tables, so they change with the language too.

## Notes

- The picker lists the **200** skills the game gives a display name to. Skills
  with no name in game are not editable here.
- The exe is **not code-signed**, so Windows SmartScreen may warn you the first
  time you run it. Choose "More info" → "Run anyway", or build it yourself.
- If nothing changes in game, check `%TEMP%\GBFR.SkillEdit.log` — the mod logs
  which rows it patched, and says so when it cannot find its Config.json.

## Build from source

Requires the .NET SDK 8, Node.js 20+ and Go 1.25+.

```powershell
./build.ps1            # -> SkillEditTool/SkillEditTool.exe
./build.ps1 -Package   # -> dist-release/GBFR.SkillEdit-<version>.zip
```

The script builds the mod DLL, copies it into `SkillEditTool/assets/`, builds
the frontend, and only then compiles the executable — the Go build embeds both
the frontend bundle and the DLL, so those have to exist first.

## Credits

Made by **baago**. Source and releases: `<your-repo-url>`

[中文说明](README.zh-CN.md)
