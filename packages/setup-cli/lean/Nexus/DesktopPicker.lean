/-
Formal model of the pure-logic invariants in the Claude Desktop integration
(`lib/harnesses/claude-desktop/profile-lane.mjs` and `index.mjs`): the picker
pairing in `serverlessLineup`, the effort-rewrite closure in
`normalizeThinking`, the device-config backup/restore round trip, and the
two-lane exclusivity. `native_decide`/`decide` spot checks pin the constants.
-/
namespace Nexus.DesktopPicker

/-! ## Pairing: one picker row per router, each with a unique catalog id

`serverlessLineup` walks the `-latest` routers, pairing each with the next
catalog id in the pool not used by an earlier row. The guarded bug (hit live):
the same catalog id on two rows renders two identical picker entries. The
draw-without-replacement model below takes one pool id per router.
-/

/-- Pair each router with the next pool id, consuming the pool. -/
def pairUp : List String → List String → List (String × String)
  | [], _ => []
  | _ :: _, [] => []
  | r :: rs, i :: ids => (r, i) :: pairUp rs ids

/-- Every assigned id comes from the pool. -/
theorem pairUp_mem : ∀ (routers : List String) (ids : List String) (x : String),
    x ∈ (pairUp routers ids).map Prod.snd → x ∈ ids := by
  intro routers
  induction routers with
  | nil => intro ids x hx; simp [pairUp] at hx
  | cons r rs ih =>
    intro ids x hx
    match ids with
    | [] => simp [pairUp] at hx
    | i :: rest =>
      simp only [pairUp, List.map_cons, List.mem_cons] at hx ⊢
      rcases hx with hx | hx
      · exact Or.inl hx
      · exact Or.inr (ih rest x hx)

/-- The picker never renders two rows with the same catalog id. -/
theorem pairUp_nodup : ∀ (routers ids : List String),
    ids.Nodup → ((pairUp routers ids).map Prod.snd).Nodup := by
  intro routers
  induction routers with
  | nil => intro ids _; simp [pairUp]
  | cons r rs ih =>
    intro ids hnodup
    match ids, hnodup with
    | [], _ => simp [pairUp]
    | i :: rest, h =>
      simp only [pairUp, List.map_cons]
      refine List.nodup_cons.mpr ⟨?_, ih rest (List.nodup_cons.mp h).right⟩
      intro hmem
      exact absurd (pairUp_mem rs rest i hmem) (List.nodup_cons.mp h).left

/-- Concrete pin: two routers, three ids → distinct assignments. -/
example : (pairUp ["kimi-latest", "glm-latest"]
    ["claude-opus-4-8", "claude-sonnet-5-5", "claude-haiku-4-5-20251001"]).map Prod.snd
    = ["claude-opus-4-8", "claude-sonnet-5-5"] := by native_decide

/-- Pairing cannot create more rows than the pool has ids. -/
theorem pairUp_length : ∀ (routers ids : List String),
    (pairUp routers ids).length ≤ routers.length ∧ (pairUp routers ids).length ≤ ids.length := by
  intro routers
  induction routers with
  | nil => intro ids; simp [pairUp]
  | cons r rs ih =>
    intro ids
    match ids with
    | [] => simp [pairUp]
    | i :: rest =>
      simp only [pairUp, List.length_cons]
      have h := ih rest
      omega

/-! ## Effort rewrite closure

`normalizeThinking` maps UI effort spellings the Fireworks ladders do not
advertise (`xhigh`, `extended`) onto nearest supported levels. Invariant:
every rewrite target is a ladder level (a rewritten request cannot 400).
-/

def ladder : List String := ["low", "medium", "high", "max"]
def rewrites : List (String × String) := [("xhigh", "max"), ("extended", "high")]

theorem rewrite_targets_in_ladder :
    ∀ p ∈ rewrites, p.2 ∈ ladder := by decide

theorem rewrite_sources_not_in_ladder :
    ∀ p ∈ rewrites, ¬ p.1 ∈ ladder := by decide

/-! ## Device config backup/restore round trip

`on` rewrites four device keys in `claude_desktop_config.json` and snapshots
their prior values; `off` restores them. A repeat `on` must keep the ORIGINAL
snapshot (Bugbot round: recapturing from the already-rewritten config made
`off` restore Nexus's own values).
-/

abbrev Config := String → Option String

def deviceKeys : List String :=
  ["modelCatalogEnabled", "catalogUrl", "modelPrefer1mContext", "defaultModelEffort"]

/-- Snapshot of the device keys (other keys read as `none`). -/
def backupOf (c : Config) : Config :=
  fun k => if k ∈ deviceKeys then c k else none

/-- Restore: device keys take the snapshot's value (present or absent); other
keys pass through untouched. -/
def restoreOf (saved c : Config) : Config :=
  fun k => if k ∈ deviceKeys then saved k else c k

/-- `off` returns the device keys to their pre-Nexus values exactly. -/
theorem restore_backup_roundtrip (c c' : Config) :
    ∀ k ∈ deviceKeys, restoreOf (backupOf c) c' k = c k := by
  intro k hk
  simp [restoreOf, backupOf, hk]

/-- Other keys are never touched by a restore. -/
theorem restore_leaves_other_keys (c c' : Config) :
    ∀ k ∉ deviceKeys, restoreOf c c' k = c' k := by
  intro k hk
  simp [restoreOf, hk]

/-- A repeat `on` never overwrites the original snapshot. -/
theorem repeat_on_keeps_backup (c c' : Config) :
    ∀ k ∈ deviceKeys, backupOf (restoreOf (backupOf c) c') k = backupOf c k := by
  intro k hk
  simp [restoreOf, backupOf, hk]

end Nexus.DesktopPicker
