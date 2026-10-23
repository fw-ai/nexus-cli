/-
Formal model of version comparison in `lib/system/release-notes.mjs`
(`compareVersions`, `releaseNotesForRange`, the show-once gate in
`printUnseenReleaseNotes`) and its reuse in
`lib/system/update-cache.mjs` (`versionIsNewer`, `mergeUpdateCache`).

JS parses a version to three numeric parts (leading `v` stripped,
missing or unparsable parts read as 0), so a version is a triple of
naturals here and comparison is lexicographic. The properties that
matter are that the order is total (release-notes selection and the
update cache both assume it), that range selection keeps exactly
`from < v ≤ to`, and that "already shown / already seen" markers are
monotone: once the marker reaches a version, nothing at or below it
is shown or prompts again.
JS tests: `test/system/release-notes.test.mjs`, `test/system/update-notify.test.mjs`.
-/
namespace Nexus.VersionOrder

/-- A parsed version: three numeric parts, missing parts read as 0. -/
structure Version where
  major : Nat
  minor : Nat
  patch : Nat
deriving DecidableEq, BEq, Repr

/-- Lexicographic `≤` on version triples, as a `Bool`: the JS loop
comparing parts in order. -/
def leV (x y : Version) : Bool :=
  decide (x.major < y.major ∨ (x.major = y.major ∧ x.minor < y.minor)
    ∨ (x.major = y.major ∧ x.minor = y.minor ∧ x.patch ≤ y.patch))

/-- Strict `<`: `≤` without the reverse `≤` (equivalent to `<` for a
total order, and how "newer than" is consumed). -/
def ltV (x y : Version) : Bool := leV x y && !leV y x

/-- The `leV` characterization in propositional form. -/
theorem leV_iff (x y : Version) :
    leV x y = true ↔
      x.major < y.major ∨ (x.major = y.major ∧ x.minor < y.minor) ∨ (x.major = y.major ∧ x.minor = y.minor ∧ x.patch ≤ y.patch) := by
  simp [leV]

/-- The order is reflexive: a version is never "newer" than itself, so
re-checking the same release stays silent. -/
theorem leV_refl (x : Version) : leV x x = true := by
  rw [leV_iff]
  exact Or.inr (Or.inr ⟨rfl, rfl, Nat.le_refl _⟩)

/-- Antisymmetry: `x ≤ y` and `y ≤ x` pin every part, hence the triple. -/
theorem leV_antisymm {x y : Version}
    (hxy : leV x y = true) (hyx : leV y x = true) : x = y := by
  rw [leV_iff] at hxy hyx
  have e1 : x.major = y.major := by omega
  have e2 : x.minor = y.minor := by omega
  have e3 : x.patch = y.patch := by omega
  cases x <;> cases y <;> simp_all

/-- Transitivity across all three parts. -/
theorem leV_trans {x y z : Version}
    (hxy : leV x y = true) (hyz : leV y z = true) : leV x z = true := by
  rw [leV_iff] at hxy hyz ⊢
  omega

/-- Totality: any two versions compare one way or the other, which is
what makes "latest" well-defined for the notes and the update cache. -/
theorem leV_total (x y : Version) : leV x y = true ∨ leV y x = true := by
  rw [leV_iff, leV_iff]
  omega

/-- Range selection for release notes: exactly `from < v ≤ to`.
Mirrors the `releaseNotesForRange` filter predicate. -/
def inNotesRange (lo v hi : Version) : Bool := ltV lo v && leV v hi

/-- Membership in the selected range is the advertised half-open
interval — nothing at or below `from`, nothing above `to`. -/
theorem inNotesRange_iff (lo v hi : Version) :
    inNotesRange lo v hi = true ↔ ltV lo v = true ∧ leV v hi = true := by
  simp [inNotesRange, Bool.and_eq_true]

/-- The show-once gate: once the marker reaches the latest version,
nothing is shown again. Mirrors the `lastShownVersion` check. -/
def shouldShow (marker latest : Version) : Bool := ltV marker latest

theorem shown_once (marker latest : Version)
    (h : leV latest marker = true) : shouldShow marker latest = false := by
  simp [shouldShow, ltV, h]

/-- The update cache merge keeps the greater version: the cached
"latest" never moves backward when a slower check resolves last.
Mirrors `mergeUpdateCache` taking the max. -/
def mergeLatest (cached seen : Version) : Version :=
  if leV seen cached then cached else seen

theorem mergeLatest_never_backward (cached seen : Version) :
    leV cached (mergeLatest cached seen) = true ∧
    leV seen (mergeLatest cached seen) = true := by
  unfold mergeLatest
  by_cases h : leV seen cached = true
  · simp [h, leV_refl]
  · have hf : leV seen cached = false := by
      cases hf : leV seen cached with
      | false => rfl
      | true => rw [hf] at h; contradiction
    simp only [hf, Bool.false_eq_true, if_false]
    have hcs : leV cached seen = true := by
      cases leV_total cached seen with
      | inl g => exact g
      | inr g => rw [hf] at g; contradiction
    exact ⟨hcs, leV_refl seen⟩

/-- Spot checks mirroring the JS tests (0.10.x ordering, equality,
and the half-open range). -/
theorem version_spot :
    ltV (⟨0, 10, 0⟩ : Version) (⟨0, 10, 1⟩ : Version) = true ∧
    ltV (⟨0, 10, 1⟩ : Version) (⟨0, 10, 0⟩ : Version) = false ∧
    leV (⟨0, 9, 9⟩ : Version) (⟨0, 10, 0⟩ : Version) = true ∧
    inNotesRange (⟨0, 10, 0⟩ : Version) (⟨0, 10, 1⟩ : Version) (⟨0, 10, 1⟩ : Version) = true ∧
    inNotesRange (⟨0, 10, 0⟩ : Version) (⟨0, 10, 0⟩ : Version) (⟨0, 10, 1⟩ : Version) = false ∧
    mergeLatest (⟨0, 10, 1⟩ : Version) (⟨0, 9, 9⟩ : Version) = (⟨0, 10, 1⟩ : Version) := by
  native_decide

end Nexus.VersionOrder
