/-
Formal model of the `nexus auto` provider scope in
`lib/config/auto-providers.mjs`: `normalizeAutoProviders` (stored-value
normalization), `autoScopeAllows` (whether a saved provider key may be
sent), and `nexusProvidersHeaders` (whether the `x-nexus-providers`
header is sent).

The safety property is that a stored value can never widen scope: the
CLI parser is strict about `--providers`, so the stored path must be at
least as strict. An unrecognized stored list normalizes to the empty
scope — no header sent, no saved keys sent — and only a missing or
non-list value reads as unset (the default, which allows everything).
Raw entries are modeled pre-normalized (trimmed/lowercased, as the JS
does before filtering), so `known` membership is the only question.
-/
namespace Nexus.AutoScope

/-- Providers the scope can name today, in canonical storage order.
Mirrors `AUTO_PROVIDER_IDS`. -/
def known : List String := ["fireworks"]

/-- Stored-list normalization: keep the recognized providers, in
canonical order. Mirrors `normalizeAutoProviders` on an array input. -/
def normalize (raw : List String) : List String :=
  known.filter (fun p => p ∈ raw)

/-- Whether the scope allows a saved key for `provider` to be sent.
`none` models unset (`null`): the default, which allows every provider.
Mirrors `autoScopeAllows`. -/
def allows : Option (List String) → String → Bool
  | none, _ => true
  | some providers, p => providers.contains p

/-- Whether the `x-nexus-providers` header is sent at all: only for a
set, non-empty scope. Mirrors `nexusProvidersHeaders` + `formatAutoProviders`. -/
def sendsHeader : Option (List String) → Bool
  | none => false
  | some providers => !providers.isEmpty

/-- Normalization only ever yields recognized providers. -/
theorem normalize_subset (raw : List String) (p : String)
    (h : p ∈ normalize raw) : p ∈ known := by
  simp only [normalize, List.mem_filter] at h
  exact h.1

/-- The scope never widens: a provider is allowed under a normalized
stored list only if it was named in that list. -/
theorem normalize_never_widens (raw : List String) (p : String)
    (h : allows (some (normalize raw)) p = true) : p ∈ raw := by
  simp only [allows, normalize, List.contains_iff_mem, List.mem_filter] at h
  exact of_decide_eq_true h.2

/-- A stored list naming nothing recognized is the empty scope, so no
saved key is sent for either provider and no header is sent. This is
the fail-closed direction: junk can narrow, never widen. -/
theorem unknown_only_sends_nothing (raw : List String)
    (h : "fireworks" ∉ raw) :
    normalize raw = [] ∧ allows (some (normalize raw)) "anthropic" = false
      ∧ allows (some (normalize raw)) "openai" = false
      ∧ sendsHeader (some (normalize raw)) = false := by
  have hnorm : normalize raw = [] := by
    unfold normalize known
    simp [h]
  refine ⟨hnorm, ?_, ?_, ?_⟩ <;> simp [allows, sendsHeader, hnorm]

/-- The empty scope sends no key and no header, for any provider. -/
theorem empty_scope_sends_nothing (p : String) :
    allows (some []) p = false ∧ sendsHeader (some []) = false := by
  simp [allows, sendsHeader]

/-- Unset is the only state that allows everything, and it sends no
header either (the gateway applies its default). -/
theorem unset_is_default (p : String) :
    allows none p = true ∧ sendsHeader none = false := by
  simp [allows, sendsHeader]

/-- Normalization is idempotent, so re-writing the config (every
unrelated `writeGlobalConfig` normalizes again) is a fixed point. -/
theorem normalize_idempotent (raw : List String) :
    normalize (normalize raw) = normalize raw := by
  by_cases h : "fireworks" ∈ raw <;> simp [normalize, known, h]

/-- Spot checks mirroring the JS unit tests. -/
theorem normalize_spot :
    normalize ["junk", "fireworks"] = ["fireworks"] ∧
    normalize ["junk"] = [] ∧
    normalize [] = [] ∧
    normalize ["fireworks", "fireworks"] = ["fireworks"] ∧
    normalize ["anthropic"] = [] := by
  native_decide

end Nexus.AutoScope
