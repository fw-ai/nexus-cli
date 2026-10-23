/-
Formal model of `planCatalogRefresh` in `lib/harness/catalog-refresh.mjs`.

A re-`on` walks the currently-registered model ids against the fresh
catalog: first occurrences that are still served (or explicitly kept)
survive, duplicates and empty ids are pruned, delisted ids are pruned,
and fresh ids never seen are added. Every harness with a picker
(VS Code, Cursor, Copilot, OpenCode, Pi) consumes this partition, so
its safety properties are shared: nothing current vanishes without
landing in `pruned`, `kept` stays duplicate-free, `kept` only retains
ids the fresh catalog (or the keep predicate) approves, and `added`
only brings in genuinely new fresh ids. The JS computes kept/pruned
in one pass; the model computes each list with the same walk and the
same `seen` threading, which is equivalent at the level of the
membership properties proved here.
JS tests: `test/harness/catalog-refresh.test.mjs` (and the per-harness
refresh tests that consume the plan).
-/
namespace Nexus.CatalogRefreshPlan

/-- Kept ids from the walk, threading `seen` exactly as the JS `Set`
does: empty ids and repeats are never kept. -/
def keptOf : List String → List String → (String → Bool) → List String → List String
  | [], _, _, _ => []
  | id :: rest, fresh, keep, seen =>
    if id.isEmpty || id ∈ seen then keptOf rest fresh keep (id :: seen)
    else if fresh.contains id || keep id then id :: keptOf rest fresh keep (id :: seen)
    else keptOf rest fresh keep (id :: seen)

/-- Pruned ids from the same walk: empties, repeats, and delisted ids. -/
def prunedOf : List String → List String → (String → Bool) → List String → List String
  | [], _, _, _ => []
  | id :: rest, fresh, keep, seen =>
    if id.isEmpty || id ∈ seen then id :: prunedOf rest fresh keep (id :: seen)
    else if fresh.contains id || keep id then prunedOf rest fresh keep (id :: seen)
    else id :: prunedOf rest fresh keep (id :: seen)

/-- One-step unfolding when the head is an empty id or a repeat. -/
theorem keptOf_cons_seen {x : String} {xs fresh : List String}
    {keep : String → Bool} {seen : List String}
    (hc : (x.isEmpty || x ∈ seen)) :
    keptOf (x :: xs) fresh keep seen = keptOf xs fresh keep (x :: seen) := by
  simp [keptOf, hc]

/-- One-step unfolding when the head is kept. -/
theorem keptOf_cons_kept {x : String} {xs fresh : List String}
    {keep : String → Bool} {seen : List String}
    (hc : ¬(x.isEmpty || x ∈ seen)) (hf : x ∈ fresh ∨ keep x = true) :
    keptOf (x :: xs) fresh keep seen = x :: keptOf xs fresh keep (x :: seen) := by
  simp [keptOf, hc, hf]

/-- One-step unfolding when the head is delisted. -/
theorem keptOf_cons_delisted {x : String} {xs fresh : List String}
    {keep : String → Bool} {seen : List String}
    (hc : ¬(x.isEmpty || x ∈ seen)) (hf : ¬(x ∈ fresh ∨ keep x = true)) :
    keptOf (x :: xs) fresh keep seen = keptOf xs fresh keep (x :: seen) := by
  simp [keptOf, hc, hf]

/-- The approval condition in propositional form, from the `Bool` form
the walk tests. -/
theorem approvedProp {x : String} {fresh : List String} {keep : String → Bool}
    (hf : (fresh.contains x || keep x) = true) : x ∈ fresh ∨ keep x = true := by
  simp only [Bool.or_eq_true] at hf
  cases hf with
  | inl g => exact Or.inl (List.contains_iff_mem.mp g)
  | inr g => exact Or.inr g

/-- The non-approval condition in propositional form. -/
theorem notApprovedProp {x : String} {fresh : List String} {keep : String → Bool}
    (hf : ¬(fresh.contains x || keep x) = true) :
    ¬(x ∈ fresh ∨ keep x = true) := by
  intro hdis
  cases hdis with
  | inl g =>
    have h1 : (fresh.contains x || keep x) = true := by
      rw [Bool.or_eq_true]
      exact Or.inl (List.contains_iff_mem.mpr g)
    exact hf h1
  | inr g =>
    have h1 : (fresh.contains x || keep x) = true := by simp [g]
    exact hf h1

/-- Append unless present: the `Set`-insertion step behind the local
dedupe (same construction as `Nexus.Catalog.dedupe`). -/
def addNew (acc : List String) (id : String) : List String :=
  if id ∈ acc then acc else acc ++ [id]

/-- First-occurrence dedupe, matching `[...new Set(ids)]`. -/
def dedupeIds (ids : List String) : List String := ids.foldl addNew []

theorem mem_dedupeIds (y : String) (ids : List String) :
    y ∈ dedupeIds ids ↔ y ∈ ids := by
  have step : ∀ (input acc : List String),
      y ∈ input.foldl addNew acc ↔ y ∈ acc ∨ y ∈ input := by
    intro input
    induction input with
    | nil => intro acc; simp
    | cons x xs ih =>
      intro acc
      simp only [List.foldl]
      rw [ih]
      unfold addNew
      split
      · next hx =>
        constructor
        · intro h
          cases h with
          | inl g => exact Or.inl g
          | inr g => exact Or.inr (List.mem_cons_of_mem _ g)
        · intro h
          cases h with
          | inl g => exact Or.inl g
          | inr g =>
            cases g with
            | head => exact Or.inl hx
            | tail _ g => exact Or.inr g
      · simp_all [or_assoc]
  simp [dedupeIds, step]

/-- The full plan: kept/pruned from the walk, plus fresh ids that were
never seen (the JS builds `added` from the deduplicated fresh set). -/
def plan (current fresh : List String) (keep : String → Bool) :
    List String × List String × List String :=
  let seenAfter := dedupeIds (current.filter (fun id => !id.isEmpty))
  (keptOf current fresh keep [],
    prunedOf current fresh keep [],
    (dedupeIds (fresh.filter (fun id => !id.isEmpty))).filter
      (fun id => id ∉ seenAfter))

/-- Every current id lands somewhere: nothing vanishes silently
between `kept` and `pruned`. -/
theorem keptOrPruned (ids fresh : List String) (keep : String → Bool)
    (seen : List String) (id : String) (h : id ∈ ids) :
    id ∈ keptOf ids fresh keep seen ∨ id ∈ prunedOf ids fresh keep seen := by
  induction ids generalizing seen with
  | nil => simp at h
  | cons x xs ih =>
    cases h with
    | head =>
      by_cases hc : id.isEmpty || id ∈ seen
      · simp only [keptOf, prunedOf, hc, ↓reduceIte]
        exact Or.inr (by simp)
      · by_cases hf : fresh.contains id || keep id
        · simp only [keptOf, prunedOf, hc, hf]
          exact Or.inl (by simp)
        · simp only [keptOf, prunedOf, hc, hf]
          exact Or.inr (by simp)
    | tail _ hrest =>
      have ih' := ih (seen := x :: seen) hrest
      by_cases hc : x.isEmpty || x ∈ seen
      · simp only [keptOf, prunedOf, hc, ↓reduceIte]
        cases ih' with
        | inl g => exact Or.inl g
        | inr g => exact Or.inr (List.mem_cons_of_mem _ g)
      · by_cases hf : fresh.contains x || keep x
        · simp only [keptOf, prunedOf, hc, hf]
          cases ih' with
          | inl g => exact Or.inl (List.mem_cons_of_mem _ g)
          | inr g => exact Or.inr g
        · simp only [keptOf, prunedOf, hc, hf]
          cases ih' with
          | inl g => exact Or.inl g
          | inr g => exact Or.inr (List.mem_cons_of_mem _ g)

/-- Kept ids are approved: still in the fresh catalog or explicitly
kept by the harness (e.g. the `auto` router the catalog may not list). -/
theorem keptApproved (ids fresh : List String) (keep : String → Bool)
    (seen : List String) (id : String)
    (h : id ∈ keptOf ids fresh keep seen) :
    id ∈ ids ∧ (fresh.contains id = true ∨ keep id = true) := by
  induction ids generalizing seen with
  | nil => simp [keptOf] at h
  | cons x xs ih =>
    by_cases hc : x.isEmpty || x ∈ seen
    · have ih' := ih (seen := x :: seen) (by simpa [keptOf, hc] using h)
      exact ⟨List.mem_cons_of_mem _ ih'.1, ih'.2⟩
    · by_cases hf : fresh.contains x || keep x
      · simp only [keptOf, hc, hf, ↓reduceIte] at h
        cases h with
        | head =>
          refine ⟨(by simp), ?_⟩
          have hfP : fresh.contains id = true ∨ keep id = true := by
            simp only [Bool.or_eq_true] at hf
            exact hf
          cases hfP with
          | inl g => exact Or.inl g
          | inr g => exact Or.inr g
        | tail _ hrest =>
          have ih' := ih (seen := x :: seen) hrest
          exact ⟨List.mem_cons_of_mem _ ih'.1, ih'.2⟩
      · have ih' := ih (seen := x :: seen)
          (by rwa [keptOf_cons_delisted hc (notApprovedProp hf)] at h)
        exact ⟨List.mem_cons_of_mem _ ih'.1, ih'.2⟩

/-- Kept stays duplicate-free and disjoint from what was already seen:
first occurrences only, so a repeat can never sneak back into `kept`. -/
theorem keptNodup (ids fresh : List String) (keep : String → Bool)
    (seen : List String) :
    (keptOf ids fresh keep seen).Nodup
      ∧ ∀ id ∈ keptOf ids fresh keep seen, id ∉ seen := by
  induction ids generalizing seen with
  | nil => simp [keptOf]
  | cons x xs ih =>
    by_cases hc : (x.isEmpty || x ∈ seen)
    · have ih' := ih (seen := x :: seen)
      rw [keptOf_cons_seen hc]
      refine ⟨ih'.1, ?_⟩
      intro id hid hmem
      exact ih'.2 id hid (List.mem_cons_of_mem _ hmem)
    · by_cases hf : (fresh.contains x || keep x) = true
      · have ih' := ih (seen := x :: seen)
        rw [keptOf_cons_kept hc (approvedProp hf)]
        refine ⟨?_, ?_⟩
        · rw [List.nodup_cons]
          refine ⟨fun hxmem => ih'.2 x hxmem (by simp), ih'.1⟩
        · intro id hid hmem
          cases hid with
          | head => exact hc (by simp [hmem])
          | tail _ hrest =>
            exact ih'.2 id hrest (List.mem_cons_of_mem _ hmem)
      · have ih' := ih (seen := x :: seen)
        rw [keptOf_cons_delisted hc (notApprovedProp hf)]
        refine ⟨ih'.1, ?_⟩
        intro id hid hmem
        exact ih'.2 id hid (List.mem_cons_of_mem _ hmem)

/-- Added ids are genuinely new: fresh, and not among the current ids
the walk saw (so a kept or pruned id is never also "added"). -/
theorem addedNew (current fresh : List String) (keep : String → Bool)
    (id : String) (h : id ∈ (plan current fresh keep).2.2) :
    id ∈ fresh ∧ id ∉ current := by
  unfold plan at h
  simp only [List.mem_filter, mem_dedupeIds] at h
  obtain ⟨⟨hfresh, hne⟩, hcond⟩ := h
  refine ⟨hfresh, fun hcur => ?_⟩
  have hn : ¬(id ∈ current ∧ (!id.isEmpty) = true) := of_decide_eq_true hcond
  exact hn ⟨hcur, hne⟩

/-- Spot checks mirroring the JS tests: duplicates and empties are
pruned, delisted ids are pruned, the keeper predicate retains its id,
and additions are the unseen fresh ids. -/
theorem plan_spot :
    plan ["auto", "glm", "auto", "gone"] ["auto", "glm", "new"] (fun _ => false)
      = (["auto", "glm"], ["auto", "gone"], ["new"]) ∧
    plan ["firerouter"] [] (fun id => id == "firerouter")
      = (["firerouter"], [], []) ∧
    plan ["", "auto"] ["auto"] (fun _ => false)
      = (["auto"], [""], []) := by
  native_decide

end Nexus.CatalogRefreshPlan
