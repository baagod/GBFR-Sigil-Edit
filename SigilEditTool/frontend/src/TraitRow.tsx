/*
  The rows themselves: one trait's row, the rows of its levels, and the ten value
  boxes a level holds.

  They live here rather than in App because they are the bulk of the list's markup and
  none of them needs to know how the list is filtered, ordered or saved - what they need
  arrives as props: the row data, whether the pointer is on this row, whether this trait
  is open, and a context of the handful of callbacks App owns.
*/
import { Fragment, useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Dict } from "./i18n";
import {
  addressOf,
  NO_TYPED,
  pad,
  SLOTS,
  slotEdit,
  stepValue,
  withSlot,
  type SigilTrait,
  type TraitInfo,
} from "./traits";

/** One trait's row and its levels, as the list builds them. */
export type Row = {
  key: string;
  label: string;
  info?: TraitInfo;
  records: SigilTrait[];
  byLevel: Map<number, SigilTrait>;
  enabled: boolean;
  levels: number[];
};

/**
 * What a row needs from App: the copy, the explanation text for a trait, and the edits a
 * row can ask for - including the two pointer handlers the tooltip runs on. Passed as one
 * object so the markup above does not carry a dozen props around.
 */
export type RowContext = {
  t: Dict;
  notationOf: (key: string, level: number) => string;
  rest: (id: string, e: PointerEvent<HTMLElement>) => void;
  leave: (id: string) => void;
  toggleLevel: (key: string, level: number) => void;
  toggleTrait: (key: string, nextChecked: boolean) => void;
  toggleOpen: (key: string) => void;
  updateLevel: (key: string, level: number, patch: Partial<SigilTrait>) => void;
  isControl: (e: MouseEvent<HTMLElement>) => boolean;
};

/**
 * Ten compact value inputs, named for the level they belong to so a screen reader can
 * tell a thousand of them apart.
 *
 * Each slot's placeholder is the game's own number for that slot, so an empty box reads
 * as "this one is untouched, it will be written as the game's value", and whether a box
 * is empty is decided by whether the user has typed in it - never by comparing the number
 * to the default. A typed 20 in a slot whose default is 20 is still the user's 20.
 *
 * What a keystroke means, and what the box shows while it is being typed into, is decided
 * in traits.ts (slotEdit) - including why a typed number keeps its own text on screen
 * until the box is left. That is the rule to read before changing anything here.
 */
function ValueSlots({
  values,
  typed,
  defaults,
  label,
  level,
  onChange,
}: {
  values: number[];
  typed: boolean[];
  defaults?: number[];
  label: string;
  level: number;
  onChange: (values: number[], typed: boolean[]) => void;
}) {
  // The text the box is showing while it is being edited, if it differs from what the
  // committed number renders as: "-" and "0." are states on the way to a number, and a
  // typed number keeps its own text too (0.004 must not render as 0 mid-typing).
  // Dropped on blur, which is when the box goes back to rendering the number.
  const [halfTyped, setHalfTyped] = useState<Record<number, string>>({});

  const vanillaOf = (i: number) => defaults?.[i] ?? 0;

  /*
    The wheel steps a focused box, and the list must not scroll with it.

    React registers wheel listeners as passive, so preventDefault inside an onWheel
    prop does nothing: the browser warns and scrolls the list anyway, while the box
    steps at the same time. The listener therefore has to be a native one, added with
    passive: false - hence the ref, and the latest-props ref that keeps the one
    listener reading the current values.
  */
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef({ values, typed, onChange });
  latest.current = { values, typed, onChange };

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      const target = event.target as HTMLInputElement | null;
      if (!target || document.activeElement !== target) return;
      // Which box it was, by position: the row holds exactly these slots and nothing
      // else, so no index has to be carried through the DOM for this.
      const index = Array.prototype.indexOf.call(element.querySelectorAll("input"), target);
      if (index < 0) return;
      event.preventDefault();
      const { values, typed, onChange } = latest.current;
      const next = [...values];
      next[index] = stepValue(values[index], event.deltaY < 0 ? 1 : -1);
      setHalfTyped(({ [index]: _dropped, ...rest }) => rest);
      onChange(next, withSlot(typed, index, true));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  return (
    // The one flexible part of the row: whatever the name and the level do not
    // need goes to the values, and they share it evenly.
    //
    // No cursor-text on the wrapper: each box carries its own, so the I-beam marks
    // exactly the boxes that accept typing, and every box types: a level with no edit
    // yet shows the game's numbers as placeholders and the first keystroke starts it.
    //
    // The right padding is the disclosure's column, exactly: a parent row ends in a 28px
    // chevron, and a row of values ends where that chevron's box begins, so the last slot
    // stops at the same line the arrow starts on. 28px is pr-7. The arrow's own glyph is
    // 16px inside that box, which leaves about 6px of white between the two on screen.
    <div ref={host} className="flex min-w-0 flex-1 items-center pr-7">
      {Array.from({ length: SLOTS }, (_, i) => (
        <Fragment key={i}>
          {/* Every slot, the first one too: it separates the values from the level
              the same way they are separated from each other. */}
          <span className="shrink-0 text-muted-foreground/40" aria-hidden>
            |
          </span>
          <Input
            type="text"
            inputMode="decimal"
            aria-label={`${label} Lv${level} value ${i + 1}`}
            placeholder={String(vanillaOf(i))}
            // Digits also show when the stored number differs from the game's - a
            // slot edited in Config.json by hand should not look untouched.
            value={
              halfTyped[i] ??
              (typed[i] || values[i] !== vanillaOf(i) ? String(values[i]) : "")
            }
            onChange={(e) => {
              // What a keystroke means - dropped, half typed, or a number to commit -
              // is decided in traits.ts, where a test can drive it key by key.
              const edit = slotEdit(e.target.value, i, values, typed, vanillaOf);
              if (edit.kind === "drop") return;
              if (edit.kind === "half") {
                setHalfTyped((prev) => ({ ...prev, [i]: edit.text }));
                return;
              }
              // The number is committed, but the box keeps the text that was typed until
              // it is left: a prefix of a number is often a number itself (0.0, 0.00), so
              // rendering the box from the committed number ate the rest of what was
              // typed - 0.004 came out as 4. Blur renders the number again.
              setHalfTyped(({ [i]: _dropped, ...rest }) =>
                edit.keeps ? { ...rest, [i]: edit.keeps } : rest,
              );
              onChange(edit.values, edit.typed);
            }}
            onBlur={() => setHalfTyped(({ [i]: _dropped, ...rest }) => rest)}
            /*
              Stepping by one, which a number input would have given for free: these
              boxes have to hold "-" and "0." to be typed into, and a number input
              cannot report those. A step replaces whatever was half typed, because
              the number is what the box is for from then on.
            */
            onKeyDown={(e) => {
              // Escape lets go of the box: the list is read with the pointer, so leaving a
              // slot is a blur and nothing else. Whatever was half typed goes back with it,
              // because that is what onBlur already does.
              if (e.key === "Escape") {
                e.currentTarget.blur();
                return;
              }
              if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
              // Otherwise the arrow moves the caret to the end of the box, and on a
              // list that scrolls it would scroll that too.
              e.preventDefault();
              const next = [...values];
              next[i] = stepValue(values[i], e.key === "ArrowUp" ? 1 : -1);
              setHalfTyped(({ [i]: _dropped, ...rest }) => rest);
              onChange(next, withSlot(typed, i, true));
            }}
            /*
              Bare text, not a field: no border, no fill, no focus ring. The row
              reads as one line of numbers separated by |, and the only chrome left
              is a faint wash on the slot being edited so the caret has a home.

              The box is the height of the row: the row has no padding of its own,
              so the wash that marks the focused slot covers the row top to bottom,
              and a click anywhere in that band lands in the box. A trait's row and
              its levels' rows are then the same height (the multi-level row is h-11
              for the same reason).

              Every box on the row types, whether or not the level is on: a level with
              no edit yet shows the game's numbers as placeholders, and the first
              keystroke or step starts the edit (see updateLevel). So there is no
              disabled state to paint around - only the placeholder, which is what an
              untouched slot in an edited level shows too.
            */
            className="h-11! min-w-0 flex-1 border-0 bg-transparent px-0 text-center text-xs md:text-xs tabular-nums shadow-none focus:bg-muted/50 focus-visible:ring-0 dark:bg-transparent"
          />
        </Fragment>
      ))}
    </div>
  );
}

/**
 * One level of a trait: its checkbox - ticking it is what starts an edit there - its
 * level, its ten slots, and the trait's own tooltip, because the description covers the
 * whole row and any part of the row is a reasonable place to ask.
 */
function LevelRow({
  row,
  level,
  nested,
  hovered,
  ctx,
}: {
  row: Row;
  level: number;
  nested: boolean;
  hovered: boolean;
  ctx: RowContext;
}) {
  // Its own level's wording, not the trait's: a resistance reads "受到的伤害-{1}%" until
  // level 29 and "…免疫" at 30, and this row is one of them (see explainAt).
  const notation = ctx.notationOf(row.key, level);
  const record = row.byLevel.get(level);
  const id = addressOf(row.key, level);

  return (
    <Tooltip
      open={hovered}
      disabled={!notation}
      disableHoverablePopup
      trackCursorAxis="x"
    >
      {/*
        The trigger is the whole row, its checkbox included: the trait's explanation is
        worth asking for anywhere on the row, and the box is where the pointer already is
        when a level is being switched.

        Whether the tooltip is open is decided by App, from the pointer alone - see the
        note there. What is left to base-ui is the placement, and the two switches it
        needs: the popup sits over the row above the one being hovered, so it must not
        take the pointer (or that row can never be hovered) and it must not stay open
        while the pointer is inside the popup's own box.

        A div, not the button a trigger renders by default: the row holds value boxes and
        a checkbox, and interactive content cannot live inside a button.
      */}
      <TooltipTrigger
        data-row={id}
        onPointerEnter={(e) => ctx.rest(id, e)}
        onPointerLeave={() => ctx.leave(id)}
        render={
          <div
            className={`flex items-center gap-2 border-b last:border-b-0 ${
              nested ? "pl-9" : ""
            }`}
          />
        }
      >
        <Checkbox
          checked={record?.enabled ?? false}
          // 2px of room on the left: the row's first child is the box, and a focus ring
          // grows outward, so without this the container's edge clipped the ring.
          className="ml-0.5"
          aria-label={ctx.t.enable(`${row.label} Lv${level}`)}
          onCheckedChange={() => ctx.toggleLevel(row.key, level)}
        />

        {!nested && (
          <span
            /*
              A fixed width, not a flexible one: the name and the level have to stay
              together, and the value boxes are what should absorb a wider window. 217px
              covers the longest name in any of the three languages
              ("スーパーアルティメットJust回避"), with only a few pixels to spare;
              anything longer truncates, with the tooltip carrying the whole one.
            */
            className="w-[217px] shrink-0 truncate text-sm"
          >
            {row.label}
          </span>
        )}

        {/* The level a row edits, as text: it is part of the address the row writes, not a
            field of its own. A single-level trait says the same thing on the one row it has. */}
        <span className="w-12 shrink-0 text-sm leading-7 text-muted-foreground tabular-nums select-none">
          Lv {level}
        </span>

        <ValueSlots
          values={record ? record.values : pad(row.info?.Levels?.[level - 1] ?? [])}
          typed={record ? record.typed : NO_TYPED}
          defaults={row.info?.Levels?.[level - 1]}
          label={row.label}
          level={level}
          onChange={(values, typed) =>
            ctx.updateLevel(row.key, level, { values: values, typed: typed })
          }
        />
      </TooltipTrigger>
      {/*
        The trait's explanation, above the row and centred on it: every row reads the same
        way, and the list under the pointer is never covered. Wider than the stock bubble,
        and keeping the line breaks the game's own text has - some explanations are three
        lines of parameters, and a one-line bubble would cut them off. The open and close
        animations are off: the bubble changes rows without being animated in and out.
      */}
      <TooltipContent
        side="top"
        align="center"
        className="max-w-md items-start whitespace-pre-line data-open:animate-none data-closed:animate-none"
      >
        {notation}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * A trait: one row when its numbers live on a single level, and otherwise its own row
 * plus a row per level - the edited levels first, ascending, the untouched ones after
 * them. Its checkbox is then all of its levels at once: ticked when they are all on,
 * mixed when some are, empty when none are.
 */
export function TraitRow({
  row,
  hoveredId,
  isOpen,
  ctx,
}: {
  row: Row;
  hoveredId: string | null;
  isOpen: boolean;
  ctx: RowContext;
}) {
  const on = row.records.filter((record) => record.enabled).length;
  const allOn = row.records.length > 0 && on === row.records.length;

  if (row.levels.length === 1) {
    return (
      <LevelRow
        row={row}
        level={row.levels[0]}
        nested={false}
        hovered={hoveredId === addressOf(row.key, row.levels[0])}
        ctx={ctx}
      />
    );
  }

  // The parent row stands for the trait and has no level of its own, so it reads the trait's
  // highest band: what the trait does at full power. It said the default level's wording for
  // a while, which read as "this trait is worth that little" on a trait whose low levels are
  // a fraction of its top - a resistance says "受到的伤害-{1}%" at 15 and "…免疫" at 30.
  const notation = ctx.notationOf(row.key, row.info?.Max ?? row.levels[0] ?? 1);

  return (
    <>
      <Tooltip
        open={hoveredId === row.key}
        disabled={!notation}
        disableHoverablePopup
        trackCursorAxis="x"
      >
        <TooltipTrigger
          data-row={row.key}
          onPointerEnter={(e) => ctx.rest(row.key, e)}
          onPointerLeave={() => ctx.leave(row.key)}
          /*
            The trigger is the row, checkbox included, and the row is also what opens
            the trait: a click anywhere but on a control toggles it (the chevron is an
            icon, not a second control).
          */
          render={
            <div
              onClick={(e) => {
                if (ctx.isControl(e)) return;
                ctx.toggleOpen(row.key);
              }}
              className="flex h-11 items-center gap-2 border-b"
            />
          }
        >
          <span className="relative ml-0.5 inline-flex shrink-0">
            <Checkbox
              checked={allOn}
              indeterminate={on > 0 && !allOn}
              aria-label={ctx.t.enable(row.label)}
              onCheckedChange={() => ctx.toggleTrait(row.key, !allOn)}
            />
            {on > 0 && !allOn && (
              /*
                A dash of the row's making, because the geometry is the whole point of
                it: a horizontal stroke has to sit on the centre of a pixel row or it
                blurs across two. Lucide's minus puts its line at y=12 of a 24-unit box,
                which is exactly y=7.0 of the 14px the indicator draws at - a pixel
                boundary, and it came out fuzzy next to the check. This is the same line
                (lucide's x 5..19, stroke 2.3 of 24) in a 14-unit box where y=7.5 is the
                middle of row 7, so it renders solid.
              */
              <svg
                aria-hidden
                viewBox="0 0 14 14"
                className="pointer-events-none absolute inset-0 m-auto size-3.5 text-primary-foreground"
              >
                <line
                  x1="2.92"
                  y1="7.5"
                  x2="11.08"
                  y2="7.5"
                  stroke="currentColor"
                  strokeWidth="1.34"
                  strokeLinecap="round"
                />
              </svg>
            )}
          </span>

          <span className="w-[217px] shrink-0 truncate text-sm">{row.label}</span>

          <span className="flex-1" />

          {/*
            The disclosure, as a plain icon: no click of its own, no background of its
            own. Opening the trait is the row's job - the row is what the pointer is on
            when it means "this trait" - and an icon that answered a click would be a
            second, quieter control for the same thing. As a ghost button it also painted
            a wash under the pointer, which read as a button with something to do.
          */}
          <span
            aria-hidden
            className="grid size-7 shrink-0 place-content-center text-muted-foreground"
          >
            {isOpen ? (
              <ChevronDown className="size-4" />
            ) : (
              <ChevronRight className="size-4" />
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          align="center"
          className="max-w-md items-start whitespace-pre-line data-open:animate-none data-closed:animate-none"
        >
          {notation}
        </TooltipContent>
      </Tooltip>

      {isOpen &&
        row.levels.map((level) => (
          <LevelRow
            key={addressOf(row.key, level)}
            row={row}
            level={level}
            nested
            hovered={hoveredId === addressOf(row.key, level)}
            ctx={ctx}
          />
        ))}
    </>
  );
}
