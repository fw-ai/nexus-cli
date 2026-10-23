/-
Formal model of the Claude Desktop shim's header ownership in
`lib/harnesses/claude-desktop/shim.mjs` (the header rewrite in
`createShimServer`).

The shim sits between Claude Desktop and the Fireworks gateway. The
scope and provider-key headers belong to Nexus, not the client: any
inbound copy is dropped (a client must not spoof its own scope or
keys), attribution headers are replaced, and the current scope/keys
are injected only on auto-routed turns (`auto` / `auto-*`). Headers
are modeled as name/value pairs; the loaders (current scope, saved
keys) are opaque inputs, as in the JS where they are injected
callbacks. Two JS behaviors are outside the model: the always-on
telemetry header replacement, and the `x-api-key` → `Authorization`
conversion (plus hop-by-hop header drops), so "user headers survive"
is stated for headers that are neither owned nor transformed.
JS tests: `test/harnesses/claude-desktop/profile-lane.test.mjs`, `test/cli/auto-provider-keys.test.mjs`.
-/
namespace Nexus.ShimHeaderOwnership

/-- Header names Nexus owns outright in the shim: inbound copies are
always dropped before anything is (re-)injected. -/
def ownedNames : List String :=
  ["x-nexus-providers", "x-anthropic-api-key", "x-openai-api-key",
   "x-title", "http-referer"]

/-- Names carrying credentials or routing scope (the subset whose
spoofing or leakage is a security problem, as opposed to attribution). -/
def credentialNames : List String :=
  ["x-nexus-providers", "x-anthropic-api-key", "x-openai-api-key"]

def headersOf (names : List String) (hs : List (String × String)) : Bool :=
  hs.any (fun kv => kv.1 ∈ names)

/-- Drop every Nexus-owned inbound header. -/
def stripOwned (hs : List (String × String)) : List (String × String) :=
  hs.filter (fun kv => kv.1 ∉ ownedNames)

/-- Inject the current scope and saved keys, on auto turns only. An
empty scope string sends no scope header, matching the JS. -/
def inject (autoTurn : Bool) (scope : String) (keys : List (String × String))
    (hs : List (String × String)) : List (String × String) :=
  if !autoTurn then hs
  else hs ++ (if scope.isEmpty then [] else [("x-nexus-providers", scope)]) ++ keys

/-- On a non-auto turn the injection is the identity. -/
theorem inject_false (scope : String) (keys hs : List (String × String)) :
    inject false scope keys hs = hs := by
  simp [inject]

/-- On an auto turn the injection appends scope (when non-empty) and keys. -/
theorem inject_true (scope : String) (keys hs : List (String × String)) :
    inject true scope keys hs
      = hs ++ (if scope.isEmpty then [] else [("x-nexus-providers", scope)]) ++ keys := by
  simp [inject]

/-- The full rewrite: strip first, then inject. -/
def shimHeaders (inbound : List (String × String)) (autoTurn : Bool)
    (scope : String) (keys : List (String × String)) : List (String × String) :=
  inject autoTurn scope keys (stripOwned inbound)

/-- Whether a routed model id is an auto turn (`auto` / `auto-*`).
Mirrors the shim's `autoTurn` check. -/
def isAutoTurn (routedModel : String) : Bool :=
  routedModel == "auto" || "auto-".isPrefixOf routedModel

/-- After stripping, no owned name survives — spoofed scope/key
headers from the client are gone regardless of what follows. -/
theorem stripOwned_removes (hs : List (String × String))
    (name : String) (hname : name ∈ ownedNames)
    (kv : String × String) (hkv : kv ∈ stripOwned hs) : kv.1 ≠ name := by
  unfold stripOwned at hkv
  have h := (List.mem_filter.mp hkv).2
  intro hEq
  apply of_decide_eq_true h
  rw [hEq]
  exact hname

/-- On a non-auto turn, no credential or scope header is present in
the output at all: neither spoofed (stripped) nor saved (not injected). -/
theorem nonAuto_sends_no_credentials (inbound : List (String × String))
    (scope : String) (keys : List (String × String))
    (kv : String × String)
    (hkv : kv ∈ shimHeaders inbound false scope keys) :
    kv.1 ∉ credentialNames := by
  unfold shimHeaders inject at hkv
  simp only [Bool.not_false, ↓reduceIte] at hkv
  have h := (List.mem_filter.mp hkv).2
  intro hcred
  have hown : kv.1 ∈ ownedNames := by
    simp only [credentialNames, List.mem_cons, List.not_mem_nil, or_false] at hcred
    simp only [ownedNames, List.mem_cons, List.not_mem_nil, or_false]
    cases hcred with
    | inl g => exact Or.inl g
    | inr g =>
      cases g with
      | inl g => exact Or.inr (Or.inl g)
      | inr g => exact Or.inr (Or.inr (Or.inl g))
  exact (of_decide_eq_true h) hown

/-- On an auto turn, a saved key the loader produced is actually sent
(the feature works, not just the restriction). -/
theorem auto_injects_saved_key (inbound : List (String × String))
    (scope : String) (keys : List (String × String))
    (kv : String × String) (hkv : kv ∈ keys) :
    kv ∈ shimHeaders inbound true scope keys := by
  unfold shimHeaders inject
  simp [hkv]

/-- On an auto turn with a non-empty scope, the scope header is sent. -/
theorem auto_injects_scope (inbound : List (String × String))
    (scope : String) (keys : List (String × String))
    (h : !scope.isEmpty) :
    ("x-nexus-providers", scope) ∈ shimHeaders inbound true scope keys := by
  have hne : scope.isEmpty = false := by
    cases hs : scope.isEmpty with
    | false => rfl
    | true => simp [hs] at h
  simp [shimHeaders, inject, hne]

/-- User headers the shim does not own pass through untouched. -/
theorem user_headers_survive (inbound : List (String × String))
    (autoTurn : Bool) (scope : String) (keys : List (String × String))
    (kv : String × String) (hkv : kv ∈ inbound) (hown : kv.1 ∉ ownedNames)
    (_hxform : kv.1 ≠ "x-api-key" ∧ kv.1 ≠ "host" ∧ kv.1 ≠ "content-length") :
    kv ∈ shimHeaders inbound autoTurn scope keys := by
  unfold shimHeaders inject stripOwned
  have hmem : kv ∈ inbound.filter (fun p => p.1 ∉ ownedNames) :=
    List.mem_filter.mpr ⟨hkv, by simp [hown]⟩
  by_cases ht : autoTurn
  · rw [ht, if_neg (by simp)]
    exact List.mem_append.mpr (Or.inl (List.mem_append.mpr (Or.inl hmem)))
  · have haf : autoTurn = false := by
      cases ha : autoTurn with
      | false => rfl
      | true => simp [ha] at ht
    rw [haf, if_pos (by simp)]
    exact hmem

/-- Spot checks: spoofed keys dropped on non-auto turns, saved keys
injected on auto turns, `auto-*` counts as auto. -/
theorem shim_spot :
    shimHeaders [("x-openai-api-key", "sk-spoofed"), ("x-user", "1")]
        false "fireworks" [("x-openai-api-key", "sk-saved")]
      = [("x-user", "1")] ∧
    shimHeaders [("x-openai-api-key", "sk-spoofed")]
        true "" [("x-openai-api-key", "sk-saved")]
      = [("x-openai-api-key", "sk-saved")] ∧
    isAutoTurn "auto" = true ∧ isAutoTurn "auto-instant" = true ∧
    isAutoTurn "glm-5" = false := by
  native_decide

end Nexus.ShimHeaderOwnership
