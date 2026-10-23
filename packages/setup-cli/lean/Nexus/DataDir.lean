/-
Formal model of `isNexusDataDir` in `lib/system/data-dir.mjs` (mirrored
by `foreign_data_dir` in `install.sh`).

Ownership is tiered. A distinctive name, the install tree, or the CLI's
own config shape claims `~/.nexus` alone. Generic names (`demo.json`,
`cli`, `update-check.json`, …) — which another program could plausibly
use too — count only when every entry in the directory is
Nexus-owned, so a mixed foreign directory stays foreign and Nexus
neither merges into it nor deletes it on uninstall. The all-owned
case still covers a fresh `~/.nexus` that one of Nexus's own early
writers created before the rename migration ran.
-/
namespace Nexus.DataDir

/-- Every top-level name Nexus writes into `~/.nexus`.
Mirrors `NEXUS_OWNED_FILENAMES`. -/
def ownedNames : List String := [
  "key-storage.json", "secret-backend.json", "rename-complete", "rename-announced",
  "catalog-cache.json", "list-price-cache.json", "codex-stock-models.json",
  "update-check.json", "update-check.lock", "release-notes.json", "minted-key.json",
  "demo.json", ".api-key", ".secret-memory",
  "cli", "claude-desktop", "statusline-refresh",
]

/-- Names distinctive enough to claim the directory alone.
Mirrors `NEXUS_STRONG_FILENAMES`. -/
def strongNames : List String := [
  "key-storage.json", "secret-backend.json", "rename-complete", "rename-announced",
  "minted-key.json", ".secret-memory",
]

/-- A strongly-owned entry (account-suffixed memory stores included). -/
def strongEntry (e : String) : Bool :=
  e ∈ strongNames || ".secret-memory".isPrefixOf e

/-- Any Nexus-owned entry (the looser, generic tier). -/
def ownedEntry (e : String) : Bool :=
  e ∈ ownedNames || ".secret-memory-".isPrefixOf e

/-- Tiered ownership. `installTree` and `configOurs` model the two
structural checks (the CLI checkout under `cli/`, and a `config.json`
that parses to our shape — a non-null, non-array `harnesses` object).
A `config.json` that no longer parses to that shape does not poison
the generic tier, but never claims the directory on its own. -/
def isOurs (entries : List String) (installTree configOurs : Bool) : Bool :=
  entries.isEmpty
    || entries.any strongEntry
    || installTree
    || configOurs
    || (entries.any ownedEntry
      && entries.all (fun e => ownedEntry e || e == "config.json"))

/-- A distinctive name claims the directory no matter what else is in
it — this is the CLI's own state, even if a user dropped other files in. -/
theorem strong_claims (entries : List String) (e : String)
    (hmem : e ∈ entries) (hstrong : strongEntry e = true)
    (installTree configOurs : Bool) :
    isOurs entries installTree configOurs = true := by
  unfold isOurs
  have hany : entries.any strongEntry = true :=
    List.any_eq_true.mpr ⟨e, hmem, hstrong⟩
  simp [hany]

/-- A directory containing anything foreign-looking, with no strong
claim, is not ours — the #518 guard holds, and uninstall never gets
the chance to delete another program's data. -/
theorem mixed_foreign_rejected (entries : List String) (f : String)
    (hmem : f ∈ entries) (hforeign : ownedEntry f = false)
    (hnotcfg : f ≠ "config.json")
    (hstrong : entries.any strongEntry = false)
    (installTree configOurs : Bool)
    (hi : installTree = false) (hc : configOurs = false) :
    isOurs entries installTree configOurs = false := by
  unfold isOurs
  have hne : entries.isEmpty = false := by
    cases entries with
    | nil => simp at hmem
    | cons e es => simp
  have hall : entries.all (fun e => ownedEntry e || e == "config.json") = false := by
    cases hall : entries.all (fun e => ownedEntry e || e == "config.json") with
    | false => rfl
    | true =>
      have hf := List.all_eq_true.mp hall f hmem
      simp [hforeign, hnotcfg] at hf
  simp [hne, hstrong, hi, hc, hall]

/-- A fresh directory holding only Nexus's own early writes (however
generic) is ours — the #523 race keeps working. -/
theorem lone_generic_claims (g : String)
    (hg : ownedEntry g = true) (installTree configOurs : Bool) :
    isOurs [g] installTree configOurs = true := by
  unfold isOurs
  simp [hg]

/-- An empty directory is ours to fill. -/
theorem empty_claims (installTree configOurs : Bool) :
    isOurs [] installTree configOurs = true := by
  simp [isOurs]

/-- Spot checks mirroring the JS and installer tests. -/
theorem isOurs_spot :
    isOurs ["settings.ini", "demo.json"] false false = false ∧
    isOurs ["settings.ini", "key-storage.json"] false false = true ∧
    isOurs ["demo.json"] false false = true ∧
    isOurs ["cli"] false false = true ∧
    isOurs ["cli", "settings.ini"] false false = false ∧
    isOurs ["catalog-cache.json", "list-price-cache.json"] false false = true ∧
    isOurs ["config.json", "catalog-cache.json"] false false = true ∧
    isOurs ["config.json"] false false = false ∧
    isOurs [] false false = true := by
  native_decide

end Nexus.DataDir
