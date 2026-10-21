/-
Abstract safety specification for the catalog id-set policy documented in
`lib/harness/catalog-refresh.mjs`.

This is not a refinement proof over the JavaScript implementations: the
adapters have different storage formats and id normalizers. Concrete
cross-harness tests independently assert the same no-duplicates and
selection-preservation properties against every adapter. This model proves
those properties for a first-occurrence-preserving normalization equivalent
to JavaScript's `[...new Set(ids)]` for a candidate id list.
-/
namespace Nexus.Catalog

/-- Append one id unless it is already present, matching `Set` insertion order. -/
def addUnique [DecidableEq α] (xs : List α) (x : α) : List α :=
  if x ∈ xs then xs else xs ++ [x]

theorem addUnique_nodup [DecidableEq α] (xs : List α) (x : α)
    (h : xs.Nodup) : (addUnique xs x).Nodup := by
  unfold addUnique
  split
  · exact h
  · rw [List.nodup_append]
    refine ⟨h, by simp, ?_⟩
    intro a ha b hb
    simp only [List.mem_singleton] at hb
    subst b
    intro hax
    apply ‹¬x ∈ xs›
    rwa [← hax]

theorem mem_addUnique [DecidableEq α] (xs : List α) (x y : α) :
    y ∈ addUnique xs x ↔ y ∈ xs ∨ y = x := by
  unfold addUnique
  split <;> simp_all

/-- Normalize left-to-right, retaining each id's first occurrence. -/
def dedupe [DecidableEq α] (xs : List α) : List α :=
  xs.foldl addUnique []

theorem foldl_addUnique_nodup [DecidableEq α] (input acc : List α)
    (h : acc.Nodup) : (input.foldl addUnique acc).Nodup := by
  induction input generalizing acc with
  | nil => exact h
  | cons x xs ih =>
    simp only [List.foldl]
    exact ih (addUnique acc x) (addUnique_nodup acc x h)

theorem dedupe_nodup [DecidableEq α] (xs : List α) : (dedupe xs).Nodup := by
  exact foldl_addUnique_nodup xs [] (by simp)

theorem mem_foldl_addUnique [DecidableEq α] (y : α) (input acc : List α) :
    y ∈ input.foldl addUnique acc ↔ y ∈ acc ∨ y ∈ input := by
  induction input generalizing acc with
  | nil => simp
  | cons x xs ih =>
    simp only [List.foldl]
    rw [ih]
    rw [mem_addUnique]
    simp only [List.mem_cons, or_assoc]

/-- Normalization changes multiplicity only: every candidate id remains. -/
theorem mem_dedupe [DecidableEq α] (y : α) (xs : List α) :
    y ∈ dedupe xs ↔ y ∈ xs := by
  simp [dedupe, mem_foldl_addUnique]

/-- Repeated normalization cannot accumulate duplicates. -/
theorem repeated_dedupe_nodup [DecidableEq α] (xs : List α) :
    (dedupe (dedupe xs)).Nodup :=
  dedupe_nodup (dedupe xs)

/-- Fresh `on`: ensure the selected/default id and seed the fetched catalog. -/
def freshCatalog [DecidableEq α] (selected : α) (fetched : List α) : List α :=
  dedupe (selected :: fetched)

theorem freshCatalog_nodup [DecidableEq α] (selected : α) (fetched : List α) :
    (freshCatalog selected fetched).Nodup :=
  dedupe_nodup (selected :: fetched)

theorem freshCatalog_contains_selected [DecidableEq α]
    (selected : α) (fetched : List α) :
    selected ∈ freshCatalog selected fetched := by
  simp [freshCatalog, mem_dedupe]

theorem freshCatalog_contains_fetched [DecidableEq α]
    (selected model : α) (fetched : List α) (h : model ∈ fetched) :
    model ∈ freshCatalog selected fetched := by
  simp [freshCatalog, mem_dedupe, h]

/-- Existing `on --model`: retain current ids and ensure the selected id. -/
def selectExisting [DecidableEq α] (current : List α) (selected : α) : List α :=
  dedupe (current ++ [selected])

theorem selectExisting_nodup [DecidableEq α] (current : List α) (selected : α) :
    (selectExisting current selected).Nodup :=
  dedupe_nodup (current ++ [selected])

theorem selectExisting_contains_selected [DecidableEq α]
    (current : List α) (selected : α) :
    selected ∈ selectExisting current selected := by
  simp [selectExisting, mem_dedupe]

/-- Plain re-`on`: retain the selection while combining kept and fresh ids. -/
def refreshCatalog [DecidableEq α]
    (selected : α) (kept fresh : List α) : List α :=
  dedupe (kept ++ [selected] ++ fresh)

theorem refreshCatalog_nodup [DecidableEq α]
    (selected : α) (kept fresh : List α) :
    (refreshCatalog selected kept fresh).Nodup :=
  dedupe_nodup (kept ++ [selected] ++ fresh)

theorem refreshCatalog_contains_selected [DecidableEq α]
    (selected : α) (kept fresh : List α) :
    selected ∈ refreshCatalog selected kept fresh := by
  simp [refreshCatalog, mem_dedupe]

/-- Concrete duplicate-heavy spot check for the CLI's string id domain. -/
theorem catalog_duplicate_spot :
    freshCatalog "alpha" ["beta", "alpha", "beta", "gamma"] =
      ["alpha", "beta", "gamma"] := by
  native_decide

/-! ## Auto mixes: one served row each

`withCanonicalAutoRows` in `lib/fireworks/models.mjs` walks the served
catalog, keeping every ordinary row and only the first row of each auto mix
(however the gateway spelled its resource path). A row is modeled by its auto
key: `some mix` for an auto mix, `none` for anything else.
-/

def keepAuto (acc : List (Option String)) : Option String → List (Option String)
  | none => acc ++ [none]
  | some k => if some k ∈ acc then acc else acc ++ [some k]

def canonicalAuto (rows : List (Option String)) : List (Option String) :=
  rows.foldl keepAuto []

theorem keepAuto_nodup (acc : List (Option String)) (x : Option String)
    (h : (acc.filterMap id).Nodup) : ((keepAuto acc x).filterMap id).Nodup := by
  cases x with
  | none =>
    have : (acc ++ [none]).filterMap id = acc.filterMap id := by simp [List.filterMap_append]
    simpa [keepAuto, this] using h
  | some k =>
    by_cases hk : some k ∈ acc
    · simpa [keepAuto, hk] using h
    · have hs : (acc ++ [some k]).filterMap id = acc.filterMap id ++ [k] := by
        simp [List.filterMap_append]
      have hnot : k ∉ acc.filterMap id := by
        simpa [List.mem_filterMap] using hk
      simp only [keepAuto, hk, if_false, hs]
      exact List.nodup_append.mpr ⟨h, by simp, by
        intro a ha b hb
        simp only [List.mem_singleton] at hb
        subst hb
        intro hab
        subst hab
        exact hnot ha⟩

theorem foldl_keepAuto_nodup : ∀ (rows acc : List (Option String)),
    (acc.filterMap id).Nodup → ((rows.foldl keepAuto acc).filterMap id).Nodup := by
  intro rows
  induction rows with
  | nil => intro acc h; simpa using h
  | cons x xs ih => intro acc h; exact ih _ (keepAuto_nodup acc x h)

/-- No auto mix is ever served twice. -/
theorem canonicalAuto_nodup (rows : List (Option String)) :
    ((canonicalAuto rows).filterMap id).Nodup :=
  foldl_keepAuto_nodup rows [] (by simp)

/-- Concrete pin: a duplicated `auto` collapses in first-seen position;
ordinary rows and `auto-instant` survive. -/
example : canonicalAuto [some "auto", none, some "auto", some "auto-instant", none]
    = [some "auto", none, some "auto-instant", none] := by native_decide

end Nexus.Catalog
