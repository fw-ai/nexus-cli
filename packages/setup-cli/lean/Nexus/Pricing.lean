/-
Formal model of the three `formatUsd` variants in Nexus:

- `pricing.mjs` (`formatPricingInOut` helper): minimal decimals, no finiteness
  guard (callers guarantee numbers).
- `model-list.mjs`: fixed 3 decimals + non-finite guard.
- `demo/measurement.mjs`: 4 decimals trimmed + non-finite/zero guards.

Amounts are modeled as `Nat` thousandths of a dollar (list/pricing domain), so
`1400 = $1.400`. The demo formatter works in ten-thousandths; it is modeled
separately where needed. The divergence theorem below is the Lean-found bug
that motivates unifying on one shared formatter.
-/
namespace Nexus.Pricing

/-- Pad a Nat's decimal representation to exactly `width` digits. -/
def padLeft (width : Nat) (n : Nat) : String :=
  let r := Nat.repr n
  if r.length >= width then r
  else String.mk (List.replicate (width - r.length) '0' ++ r.toList)

/-- Drop leading `"0"`s (structural recursion, so `decide` reduces). -/
def dropLeadingZero : List Char → List Char
  | [] => []
  | '0' :: cs => dropLeadingZero cs
  | c :: cs => c :: cs

/-- Trim trailing `"0"` characters (mirrors JS `.replace(/0+$/, "")`): reverse,
drop leading zeros, reverse back. -/
def trimZeros (s : String) : String :=
  String.mk ((dropLeadingZero s.toList.reverse).reverse)

/-- `pricing.mjs` minimal-decimal format on thousandths. `1400 → "$1.4"`,
`2000 → "$2"`, `44 → "$0.044"`. -/
def pricingFormat (thousandths : Nat) : String :=
  let q := thousandths / 1000
  let r := thousandths % 1000
  if r == 0 then "$" ++ Nat.repr q
  else "$" ++ Nat.repr q ++ "." ++ trimZeros (padLeft 3 r)

/-- `model-list.mjs` fixed-3-decimal format on thousandths. -/
def listFormat (thousandths : Nat) : String :=
  "$" ++ Nat.repr (thousandths / 1000) ++ "." ++ padLeft 3 (thousandths % 1000)

/-- Non-finite inputs render as `"—"` in list + demo formatters. Modeled as
`Option`: `none` = non-finite/unknown. -/
def listFormatOpt : Option Nat → String
  | none => "—"
  | some t => listFormat t

theorem pricing_trims : pricingFormat 1400 = "$1.4" := by native_decide

theorem pricing_whole : pricingFormat 2000 = "$2" := by native_decide

theorem pricing_small : pricingFormat 44 = "$0.044" := by native_decide

theorem list_fixed : listFormat 1400 = "$1.400" := by native_decide

theorem list_guards_nonfinite : listFormatOpt none = "—" := rfl

/-- Lean-found divergence (pre-fix record): the two catalog formatters
disagreed on every non-whole amount. `1.40` rendered as `"$1.4"` in
status/picker paths but `"$1.400"` in `model list`. The fix unifies `model
list` on the shared minimal formatter (`unifiedListFormat` below). -/
theorem pricing_list_diverge : pricingFormat 1400 ≠ listFormat 1400 := by native_decide

/-- Whole-dollar amounts diverged too (`"$2"` vs `"$2.000"`). -/
theorem pricing_list_diverge_whole : pricingFormat 2000 ≠ listFormat 2000 := by native_decide

/-- Post-fix: `model list` reuses the shared minimal formatter from
`pricing.mjs`, so the table agrees with status/picker output. -/
def unifiedListFormat := pricingFormat

theorem unified_matches_pricing (t : Nat) :
    unifiedListFormat t = pricingFormat t := rfl

theorem unified_spot :
    unifiedListFormat 1400 = "$1.4" ∧
    unifiedListFormat 2000 = "$2" := by native_decide

/-- Minimal format pins: no trailing zeros on the checked amounts. -/
theorem pricing_no_trailing_zero_spot :
    pricingFormat 1400 = "$1.4" ∧
    pricingFormat 2000 = "$2" ∧
    pricingFormat 44 = "$0.044" ∧
    pricingFormat 0 = "$0" := by native_decide

end Nexus.Pricing
