import { useMemo } from "react"
import { ChevronDownIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue,
} from "@/components/ui/combobox"

export type PickerItem = { value: string; label: string }

/**
 * Searchable dropdown over the skill list.
 *
 * The stock shadcn combobox used as it ships: no styling of our own beyond the
 * layout the trigger needs.
 */
export function TraitPicker({
  items,
  value,
  placeholder,
  searchPlaceholder,
  emptyLabel,
  onSelect,
}: {
  items: PickerItem[]
  value: string
  placeholder: string
  searchPlaceholder: string
  emptyLabel: string
  onSelect: (value: string) => void
}) {
  // A stored key the picker no longer offers stays visible as itself instead of
  // masquerading as the placeholder.
  const selected = useMemo(
    () =>
      items.find((item) => item.value === value) ?? {
        value,
        label: value || placeholder,
      },
    [items, value, placeholder],
  )

  return (
    <Combobox
      items={items}
      value={selected}
      autoHighlight
      onValueChange={(item) => {
        if (item) onSelect(item.value)
      }}
    >
      <ComboboxTrigger
        render={
          <Button variant="outline" className="w-full min-w-0 justify-between font-normal">
            <ComboboxValue />
            <ChevronDownIcon className="size-4 text-muted-foreground" />
          </Button>
        }
      />
      {/*
        duration-0: the stock popup animates out with a zoom + slide. The picker
        sits directly above the bottom row, so that motion reads as the row
        itself jumping. Appear and disappear instantly instead.
      */}
      <ComboboxContent className="duration-0">
        <ComboboxInput showTrigger={false} placeholder={searchPlaceholder} />
        <ComboboxEmpty>{emptyLabel}</ComboboxEmpty>
        <ComboboxList>
          {(item: PickerItem) => (
            <ComboboxItem key={item.value} value={item}>
              {item.label}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}
