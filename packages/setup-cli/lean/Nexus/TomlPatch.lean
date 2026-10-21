/-
Formal model of `lib/harnesses/codex/toml-patch.mjs`.

Lines are modeled abstractly. `strip` removes Nexus-owned lines; `patch`
prepends an owned routing block to a stripped base. Theorems: strip is a
fixpoint, patch-then-strip restores the stripped base when the routing block
is owned (byte-for-byte `off` restoration), and user lines are never dropped.
-/
namespace Nexus.TomlPatch

inductive Line where
  | userRoot : String → Line
  | userTable : String → Line
  | userLine : String → Line
  | ownedRoot : String → Line
  | ownedTable : String → Line
  deriving DecidableEq, Repr

def isOwned : Line → Bool
  | .ownedRoot _ => true
  | .ownedTable _ => true
  | _ => false

/-- Keep-predicate for `strip`: owned tables always go; owned roots go only
when `stripRoot` (i.e. `stripRootRouting := true`). -/
def keep (stripRoot : Bool) : Line → Bool
  | .ownedTable _ => false
  | .ownedRoot _ => !stripRoot
  | _ => true

def strip (ls : List Line) (stripRoot : Bool) : List Line :=
  ls.filter (keep stripRoot)

/-- `patchFireconnectRoutingRaw`: strip, then append the owned routing block. -/
def patch (ls : List Line) (routing : List Line) : List Line :=
  strip ls true ++ routing

theorem keep_idem (b : Bool) (l : Line) : (keep b l && keep b l) = keep b l := by
  cases l <;> cases b <;> rfl

theorem strip_idem (ls : List Line) (b : Bool) :
    strip (strip ls b) b = strip ls b := by
  unfold strip
  rw [List.filter_filter]
  simp

theorem strip_append (l₁ l₂ : List Line) (b : Bool) :
    strip (l₁ ++ l₂) b = strip l₁ b ++ strip l₂ b := by
  unfold strip
  rw [List.filter_append]

theorem strip_routing_nil (routing : List Line)
    (h : routing.all isOwned = true) :
    strip routing true = [] := by
  unfold strip
  induction routing with
  | nil => rfl
  | cons hd tl ih =>
    have hhd : isOwned hd = true :=
      (List.all_eq_true.mp h) hd (List.mem_cons.mpr (Or.inl rfl))
    have htl : tl.all isOwned = true := by
      apply List.all_eq_true.mpr
      intro x hx
      exact (List.all_eq_true.mp h) x (List.mem_cons.mpr (Or.inr hx))
    have iht := ih htl
    revert hhd
    cases hd with
    | userRoot s =>
      intro hhd
      simp [isOwned] at hhd
    | userTable s =>
      intro hhd
      simp [isOwned] at hhd
    | userLine s =>
      intro hhd
      simp [isOwned] at hhd
    | ownedRoot s =>
      intro _
      simp [keep, iht]
    | ownedTable s =>
      intro _
      simp [keep, iht]

theorem patch_strip_roundtrip (ls routing : List Line)
    (h : routing.all isOwned = true) :
    strip (patch ls routing) true = strip ls true := by
  unfold patch
  rw [strip_append, strip_routing_nil routing h, List.append_nil]
  exact strip_idem ls true

theorem strip_preserves_users (ls : List Line) (b : Bool) :
    (strip ls b).filter (fun l => !isOwned l) =
      ls.filter (fun l => !isOwned l) := by
  unfold strip
  rw [List.filter_filter]
  have h : ∀ l : Line, ((!isOwned l && keep b l) = (!isOwned l)) := by
    intro l
    cases l <;> cases b <;> rfl
  have hfun : (fun l => !isOwned l && keep b l) = (fun l => !isOwned l) :=
    funext h
  rw [hfun]

theorem spot :
    strip [.userRoot "a", .ownedRoot "model_provider", .ownedTable "t"] true =
      [.userRoot "a"] ∧
    strip [.userRoot "a", .ownedRoot "model_provider", .ownedTable "t"] false =
      [.userRoot "a", .ownedRoot "model_provider"] := by
  decide

end Nexus.TomlPatch
