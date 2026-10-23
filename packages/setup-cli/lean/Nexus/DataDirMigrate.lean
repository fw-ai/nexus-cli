/-
Formal model of `migrateLegacyDataDir` in `lib/system/data-dir.mjs`
(the `~/.fireconnect` → `~/.nexus` rename), companion to
`Nexus.DataDir`, which models the `isNexusDataDir` ownership check
used here as an oracle input.

The safety properties are about never losing or clobbering data:

- A foreign `~/.nexus` (another program's directory) is left
  completely untouched — the `foreign` outcome mutates nothing.
- When both directories have an entry, the `~/.nexus` copy wins;
  only entries the target lacks move over (`moveMissingEntries`).
- Moving never loses an entry unique to the legacy directory: it
  either lands in the target or stays behind for the set-aside copy.

Filesystem failures (a rename that throws, a directory that will not
empty) are modeled by the `rmdirOk` input selecting `setAside`
instead of `moved`; both outcomes keep every entry.
JS tests: `test/system/data-dir.test.mjs`.
-/
namespace Nexus.DataDirMigrate

/-- Migration outcomes, mirroring the JS return union. -/
inductive Status where
  | none
  | moved
  | setAside
  | foreign
  | deferred
  | failed
deriving DecidableEq, Repr

/-- Entries the move actually transfers: what the target lacks. -/
def missingEntries (legacy target : List String) : List String :=
  legacy.filter (fun e => e ∉ target)

/-- Move only the entries the target lacks; the target's own copy of
a shared entry wins, and the shared duplicates stay behind for the
set-aside copy. Returns the leftovers and the new target contents. -/
def moveMissing (legacy target : List String) : List String × List String :=
  (legacy.filter (fun e => e ∈ target), target ++ missingEntries legacy target)

/-- The status decision, with `isNexusDataDir`, the link checks, and
each fallible filesystem step as oracle inputs, in the JS's check
order: no legacy (or legacy already a link to the target) does
nothing; an un-unlinkable deferred link stays `deferred`; a present
foreign target is `foreign`; a present owned target merges (linked
legacy set aside whole, otherwise missing entries move and an
un-emptiable legacy falls back to set-aside); an absent target is a
plain rename, falling back to a link (`deferred`) then `failed`. -/
def decide (legacyPresent legacyLinksToTarget targetLinksToLegacy unlinkOk
    targetPresent alreadyMoved targetOurs legacyIsLink rmdirOk asideOk
    renameOk linkOk : Bool) : Status :=
  if !legacyPresent || legacyLinksToTarget then .none
  else if targetLinksToLegacy && !unlinkOk then .deferred
  else if targetPresent && !targetLinksToLegacy then
    if alreadyMoved then .none
    else if !targetOurs then .foreign
    else if legacyIsLink then (if asideOk then .setAside else .failed)
    else if rmdirOk then .moved
    else if asideOk then .setAside else .failed
  else if renameOk then .moved
  else if alreadyMoved then .none
  else if linkOk then .deferred
  else .failed

/-- A foreign target produces the `foreign` outcome: the guard the
caller turns into "nothing is touched". -/
theorem foreign_status (legacyIsLink rmdirOk asideOk renameOk linkOk : Bool) :
    decide true false false true
      true false false legacyIsLink rmdirOk asideOk renameOk linkOk = .foreign := by
  simp [decide]

/-- A linked (dotfiles) legacy with no target still just renames:
`moved`, not set-aside — set-aside is only for the target-present
merge. Mirrors the pinned JS behavior for symlinked `~/.fireconnect`. -/
theorem linked_legacy_moves (unlinkOk alreadyMoved targetOurs rmdirOk asideOk
    linkOk : Bool) :
    decide true false false unlinkOk
      false alreadyMoved targetOurs true rmdirOk asideOk true linkOk = .moved := by
  simp [decide]

/-- When the plain rename fails and only the link fallback succeeds,
the outcome is `deferred` (a later run finishes the move). -/
theorem rename_failure_defers (unlinkOk targetOurs legacyIsLink
    rmdirOk asideOk : Bool) :
    decide true false false unlinkOk
      false false targetOurs legacyIsLink rmdirOk asideOk false true
      = .deferred := by
  simp [decide]

/-- Target wins a name clash: an entry already in the target is
never among the transferred entries, and stays in the target. -/
theorem target_wins_clash (legacy target : List String) (e : String)
    (h : e ∈ target) :
    e ∉ missingEntries legacy target ∧ e ∈ (moveMissing legacy target).2 := by
  unfold moveMissing missingEntries
  constructor
  · simp [List.mem_filter, h]
  · simp [List.mem_append, h]

/-- No legacy entry is lost by the move: it lands in the target or
remains behind for the set-aside copy. -/
theorem move_never_loses (legacy target : List String) (e : String)
    (h : e ∈ legacy) :
    e ∈ (moveMissing legacy target).2 ∨ e ∈ (moveMissing legacy target).1 := by
  unfold moveMissing missingEntries
  by_cases ht : e ∈ target
  · exact Or.inl (by simp [List.mem_append, ht])
  · have hm : e ∈ missingEntries legacy target :=
      List.mem_filter.mpr ⟨h, by simpa using ht⟩
    refine Or.inl ?_
    simp only [List.mem_append]
    exact Or.inr hm

/-- Everything already in the target survives the move. -/
theorem target_preserved (legacy target : List String) (e : String)
    (h : e ∈ target) : e ∈ (moveMissing legacy target).2 :=
  (target_wins_clash legacy target e h).2

/-- Moving into an empty target moves everything (the plain rename
case), and the left-behind list is empty. -/
theorem move_into_empty (legacy : List String) :
    (moveMissing legacy []).2 = legacy ∧
    ∀ e ∈ legacy, e ∉ (moveMissing legacy []).1 := by
  have hmiss : missingEntries legacy [] = legacy := by
    simp [missingEntries]
  constructor
  · simp [moveMissing, hmiss]
  · intro e _
    simp [moveMissing, List.mem_filter]

/-- Spot checks mirroring the JS migration tests. -/
theorem migrate_spot :
    decide true false false true true false false false false false false false
      = .foreign ∧
    decide false false false false false false false false false false false false
      = .none ∧
    decide true false false false true false true false true false false false
      = .moved ∧
    decide true false false false true false true false false true false false
      = .setAside ∧
    decide true false false false false false false false false false false true
      = .deferred ∧
    moveMissing ["config.json", "cache"] ["config.json"]
      = (["config.json"], ["config.json", "cache"]) := by
  native_decide

end Nexus.DataDirMigrate
