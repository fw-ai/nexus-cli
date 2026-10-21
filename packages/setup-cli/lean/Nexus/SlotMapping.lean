/-
Formal model of tier-slot override merging in
`lib/harnesses/claude/activation.mjs` (`resolveClaudeActivationPlan`) and
`lib/harnesses/claude/connect.mjs` (`claudeSlotOverridesFromCtx`).

A tier slot is either pinned to a Fireworks model id (`some id`) or left on
Claude's own default (`none`, the `native` / `claude-default` sentinel in JS).
Each override source maps a slot to `none` (flag absent — keep the lower
precedence level) or `some v` (flag present — win, where `v = none` is an
explicit `native` unpin). Precedence, lowest to highest: defaults < saved
profile < live settings < CLI flags. `--model` is picker-only and never feeds
the merge; `main` is not a tier slot and is left out of the mapping entirely.
-/
namespace Nexus.SlotMapping

inductive TierSlot where
  | opus
  | sonnet
  | haiku
  | fable
  | subagent
  deriving DecidableEq, Repr

/-- Slot value: `none` = native (Claude default), `some id` = pinned model. -/
abbrev SlotValue := Option String

/-- One merge source: `none` = flag absent, `some v` = explicit flag value. -/
abbrev Override := TierSlot → Option SlotValue

/-- A full tier mapping. -/
abbrev Mapping := TierSlot → SlotValue

/-- All-native defaults (`defaultClaudeModelMapping` for standard keys). -/
def defaults : Mapping := fun _ => none

/-- One merge step: an explicit flag wins, an absent flag keeps the base. -/
def mergeOne (base : Mapping) (over : Override) : Mapping :=
  fun slot => match over slot with
    | none => base slot
    | some v => v

/-- Full precedence chain: saved profile < live settings < CLI flags. -/
def resolve (saved live flags : Override) : Mapping :=
  mergeOne (mergeOne (mergeOne defaults saved) live) flags

/-- An absent flag keeps the lower-precedence value. -/
theorem mergeOne_absent (base : Mapping) (over : Override) (slot : TierSlot)
    (h : over slot = none) : mergeOne base over slot = base slot := by
  simp [mergeOne, h]

/-- An explicit flag wins over the lower-precedence value. -/
theorem mergeOne_present (base : Mapping) (over : Override) (slot : TierSlot)
    (v : SlotValue) (h : over slot = some v) : mergeOne base over slot = v := by
  simp [mergeOne, h]

/-- With no source pinning anything, every slot stays native. -/
theorem resolve_all_absent_is_native (slot : TierSlot) :
    resolve (fun _ => none) (fun _ => none) (fun _ => none) slot = none := by
  simp [resolve, mergeOne, defaults]

/-- A saved pin survives a plain re-`on` (no live edit, no flag). -/
theorem resolve_saved_pins (saved live flags : Override) (slot : TierSlot)
    (pinned : String)
    (hs : saved slot = some (some pinned))
    (hl : live slot = none)
    (hf : flags slot = none) :
    resolve saved live flags slot = some pinned := by
  simp [resolve, mergeOne, hs, hl, hf]

/-- A live edit beats the saved profile when no flag is passed. -/
theorem resolve_live_beats_saved (saved live flags : Override) (slot : TierSlot)
    (v : SlotValue)
    (hl : live slot = some v)
    (hf : flags slot = none) :
    resolve saved live flags slot = v := by
  simp [resolve, mergeOne, hl, hf]

/-- An explicit flag beats both saved and live values. -/
theorem resolve_flags_win (saved live flags : Override) (slot : TierSlot)
    (v : SlotValue)
    (h : flags slot = some v) :
    resolve saved live flags slot = v := by
  simp [resolve, mergeOne, h]

/-- Explicit `native` clears a saved pin (the reported subagent use case:
main Anthropic, subagent on Flash, then back to default with one flag). -/
theorem resolve_native_clears_saved (saved live flags : Override) (slot : TierSlot)
    (pinned : String)
    (_hs : saved slot = some (some pinned))
    (_hl : live slot = none)
    (hf : flags slot = some none) :
    resolve saved live flags slot = none := by
  simp [resolve, mergeOne, hf]

/-- Pinning one slot never disturbs another (sonnet flag, haiku untouched). -/
theorem resolve_slot_independent (saved live flags : Override)
    (hf : flags TierSlot.haiku = none)
    (hl : live TierSlot.haiku = none)
    (hs : saved TierSlot.haiku = none) :
    resolve saved live flags TierSlot.haiku = none := by
  simp [resolve, mergeOne, defaults, hs, hl, hf]

/-- Spot check mirroring the e2e test: sonnet pinned, subagent explicitly
native, everything else untouched. -/
def exFlags : Override
  | .sonnet => some (some "deepseek-flash-latest")
  | .subagent => some none
  | _ => none

theorem ex_spot :
    resolve (fun _ => none) (fun _ => none) exFlags TierSlot.sonnet =
      some "deepseek-flash-latest" ∧
    resolve (fun _ => none) (fun _ => none) exFlags TierSlot.subagent = none ∧
    resolve (fun _ => none) (fun _ => none) exFlags TierSlot.opus = none := by
  decide

/-! ## OpenAI key attach

Mirrors `claudeMappingNeedsOpenaiKey` in `model-profile.mjs`: the key rides
along when any candidate — the /model default `on` writes, or any resolved
slot value — is bare `firerouter` or a GPT compound. `isBare` / `requiresKey`
abstract `isFirerouterModel` / `firerouterRequiresOpenaiKey`. -/

def needsOpenaiKey (isBare requiresKey : String → Bool)
    (extra : Option String) (pins : List String) : Bool :=
  (extra.toList ++ pins).any fun m => isBare m || requiresKey m

/-- A GPT compound pinned to a tier slot attaches the key (the Bugbot finding:
previously only `--model` was inspected). -/
theorem slot_gpt_compound_attaches (isBare requiresKey : String → Bool)
    (extra : Option String) (pins : List String) (m : String)
    (hm : m ∈ pins) (hk : requiresKey m = true) :
    needsOpenaiKey isBare requiresKey extra pins = true := by
  apply List.any_eq_true.mpr
  exact ⟨m, List.mem_append_right _ hm, by simp [hk]⟩

/-- With no slot pins, behavior is exactly the old `--model`-only rule, so
existing `--model firerouter[/gpt-…]` behavior is unchanged. -/
theorem extra_only_unchanged (isBare requiresKey : String → Bool) (extra : Option String) :
    needsOpenaiKey isBare requiresKey extra [] =
      (match extra with
        | none => false
        | some m => isBare m || requiresKey m) := by
  cases extra <;> simp [needsOpenaiKey]

/-- No bare router and no GPT compound anywhere: the key stays off (pinned
non-GPT compounds like `firerouter/opus` stay clean). -/
theorem clean_without_openai_route (isBare requiresKey : String → Bool)
    (extra : Option String) (pins : List String)
    (h : ∀ m ∈ extra.toList ++ pins, isBare m = false ∧ requiresKey m = false) :
    needsOpenaiKey isBare requiresKey extra pins = false := by
  rw [needsOpenaiKey, List.any_eq_false]
  intro m hm
  simp [(h m hm).1, (h m hm).2]

/-! ### The /model default candidate

Mirrors `resolveClaudeDefaultModel` in `core.mjs` for standard keys: `--model`
wins, else a saved pick the picker still serves is kept, else the implicit
FireRouter mix. The pre-fix check only saw `--model`, so a plain `on` landing
on the implicit `firerouter` default dropped the key. -/

def defaultModel (selected savedServable : Option String) : String :=
  selected.getD (savedServable.getD "firerouter")

/-- Plain `on` (no `--model`, no servable saved pick) lands on `firerouter`. -/
theorem plain_on_lands_on_firerouter : defaultModel none none = "firerouter" := rfl

/-- The regression: with the implicit default as a candidate, plain `on`
attaches the key whenever bare `firerouter` is recognized. -/
theorem plain_on_attaches (isBare requiresKey : String → Bool)
    (pins : List String) (hb : isBare "firerouter" = true) :
    needsOpenaiKey isBare requiresKey (some (defaultModel none none)) pins = true := by
  apply List.any_eq_true.mpr
  exact ⟨"firerouter", by simp [defaultModel], by simp [hb]⟩

/-- A kept saved pick replaces the implicit default, so it alone decides:
re-`on` on a saved non-router pick does not attach the key by default. -/
theorem saved_pick_decides (saved : String) :
    defaultModel none (some saved) = saved := rfl

/-- `--model` always wins as the candidate, so `--model` behavior is
unchanged by considering the default. -/
theorem selected_wins (selected : String) (savedServable : Option String) :
    defaultModel (some selected) savedServable = selected := rfl

end Nexus.SlotMapping
