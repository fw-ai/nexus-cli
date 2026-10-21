/-
Formal model of provider BYOK credential handling in
`lib/firerouter/core.mjs` (key shapes, resolution precedence) and
`lib/firerouter/flag.mjs` (header attach rules, no-throw behavior), plus the
OpenAI route predicate from `lib/fireworks/model-id.mjs`.

`classifyKey` transliterates the JS shape checks as one if/else chain, so the
"mislabeled keys never seat the wrong family" property falls out of the
branch order instead of needing prefix-transitivity lemmas. `firstShaped`
models the flag > global > env > stored-header walk. Attach rules are pure
`Bool` functions, so every safety property is plain boolean reasoning.
-/
namespace Nexus.CredentialResolution

/-- Which provider family a key belongs to. Mirrors `isAnthropicShapedKey` /
`isOpenAIShapedKey`: the Anthropic branch is checked first, so an `sk-ant-…`
key can never fall through to the OpenAI branch. -/
def classifyKey (s : String) : Option String :=
  if "sk-ant-".isPrefixOf s then some "anthropic"
  else if "sk-".isPrefixOf s then some "openai"
  else none

/-- The Anthropic branch wins whenever it matches, regardless of the rest. -/
theorem anthropic_checked_first (s : String)
    (h : "sk-ant-".isPrefixOf s = true) :
    classifyKey s = some "anthropic" := by
  unfold classifyKey
  simp [h]

/-- Reaching the OpenAI branch proves the key is not Anthropic-shaped. -/
theorem openai_branch_excludes_anthropic (s : String)
    (h : classifyKey s = some "openai") :
    "sk-ant-".isPrefixOf s = false := by
  unfold classifyKey at h
  split at h
  · contradiction
  · next _ =>
    cases hb : "sk-ant-".isPrefixOf s <;> simp_all

/-- A key classifies to at most one family (single `Option` result). -/
theorem classify_never_both (s : String)
    (h : classifyKey s = some "anthropic") :
    classifyKey s ≠ some "openai" := by
  simp [h]

/-- Spot checks for each family plus the unclassified cases. -/
theorem classify_spot :
    classifyKey "sk-ant-123" = some "anthropic" ∧
    classifyKey "sk-proj-abc" = some "openai" ∧
    classifyKey "sk-abc" = some "openai" ∧
    classifyKey "fw_test" = none ∧
    classifyKey "" = none := by
  native_decide

/-- First shaped key in the resolution walk (flag > global > env > stored
header). An unshaped entry — including a mislabeled key — is skipped, never
seated. -/
def firstShaped (p : String → Bool) : List (Option String) → Option String
  | [] => none
  | some k :: rest => if p k then some k else firstShaped p rest
  | none :: rest => firstShaped p rest

/-- The walk only ever returns a key satisfying the shape predicate. -/
theorem firstShaped_returns_shaped (p : String → Bool) (l : List (Option String))
    (k : String) (h : firstShaped p l = some k) :
    p k = true := by
  induction l with
  | nil => simp [firstShaped] at h
  | cons head rest ih =>
    cases head with
    | none =>
      simp [firstShaped] at h
      exact ih h
    | some k' =>
      simp only [firstShaped] at h
      split at h
      · next hk =>
        cases h
        exact hk
      · next _ =>
        exact ih h

/-- A shaped head wins outright: flag precedence. -/
theorem firstShaped_first_wins (p : String → Bool) (k : String)
    (rest : List (Option String)) (h : p k = true) :
    firstShaped p (some k :: rest) = some k := by
  simp [firstShaped, h]

/-- An unshaped head is skipped: mislabeled keys fall through. -/
theorem firstShaped_skips_unshaped (p : String → Bool) (k : String)
    (rest : List (Option String)) (h : p k = false) :
    firstShaped p (some k :: rest) = firstShaped p rest := by
  simp [firstShaped, h]

/-- Nothing configured resolves to nothing: the walk is total and never throws. -/
theorem firstShaped_empty (p : String → Bool) :
    firstShaped p [] = none :=
  rfl

/-- Attach the Anthropic header only where the selection routes to Anthropic. -/
def attachAnthropic (requiresAnthropic keyPresent : Bool) : Bool :=
  requiresAnthropic && keyPresent

/-- Attach the OpenAI header on bare `firerouter` (whose mix can serve GPT
primaries) or a GPT-member route — never on pinned non-GPT compounds. -/
def attachOpenai (bareFirerouter requiresOpenai keyPresent : Bool) : Bool :=
  (bareFirerouter || requiresOpenai) && keyPresent

/-- An attached Anthropic header implies routability and a configured key. -/
theorem attachAnthropic_implies (r k : Bool)
    (h : attachAnthropic r k = true) :
    r = true ∧ k = true := by
  unfold attachAnthropic at h
  cases r <;> cases k <;> simp_all

/-- An attached OpenAI header implies a configured key. -/
theorem attachOpenai_implies_configured (b r k : Bool)
    (h : attachOpenai b r k = true) :
    k = true := by
  unfold attachOpenai at h
  cases b <;> cases r <;> cases k <;> simp_all

/-- An attached OpenAI header implies a routable selection. -/
theorem attachOpenai_implies_routable (b r k : Bool)
    (h : attachOpenai b r k = true) :
    b = true ∨ r = true := by
  unfold attachOpenai at h
  cases b <;> cases r <;> cases k <;> simp_all

/-- Pinned non-GPT compounds stay clean even with a key configured. -/
theorem pinned_compound_stays_clean :
    attachOpenai false false true = false ∧
    attachAnthropic false true = false := by
  native_decide

/-- `byok: "none"` harnesses attach no provider headers: the connect proceeds
without BYOK instead of throwing. -/
theorem byokNone_attaches_nothing (k : Bool) :
    attachAnthropic false k = false ∧
    attachOpenai false false k = false := by
  cases k <;> native_decide

/-- Whether a slash-path member routes to an OpenAI model. Mirrors
`firerouterRequiresOpenaiKey` member matching (`openai`, `gpt`, `gpt-…`,
`openai-…`, plus the o-series reasoning ids `o1`, `o3`, `o4-mini`, …). -/
def isOSeries (s : String) : Bool :=
  match s.toList with
  | 'o' :: c :: _ => c.isDigit
  | _ => false

def requiresOpenaiMembers : List String → Bool
  | [] => false
  | m :: ms =>
    (m == "openai" || m == "gpt" || "gpt-".isPrefixOf m || "openai-".isPrefixOf m
      || isOSeries m)
      || requiresOpenaiMembers ms

/-- A GPT member anywhere in the path requires the OpenAI credential. -/
theorem requiresOpenai_of_gpt_member (members : List String)
    (h : "gpt-5p6" ∈ members) :
    requiresOpenaiMembers members = true := by
  induction members with
  | nil => simp at h
  | cons m ms ih =>
    unfold requiresOpenaiMembers
    simp only [Bool.or_eq_true]
    by_cases hm : m = "gpt-5p6"
    · left
      simp only [hm]
      native_decide
    · right
      apply ih
      simp at h
      exact h.resolve_left (Ne.symm hm)

/-- Claude/Opus, Sol, and pure-Fireworks members never require it. -/
theorem requiresOpenai_spot :
    requiresOpenaiMembers ["firerouter", "opus"] = false ∧
    requiresOpenaiMembers ["firerouter", "sol"] = false ∧
    requiresOpenaiMembers ["firerouter", "kimi-k3"] = false ∧
    requiresOpenaiMembers ["firerouter", "gpt-5p6"] = true ∧
    requiresOpenaiMembers ["firerouter", "o4-mini"] = true ∧
    requiresOpenaiMembers ["firerouter", "opus"] = false ∧
    requiresOpenaiMembers [] = false := by
  native_decide

/-- Strip Nexus-managed header lines, preserving user-added ones.
Mirrors `stripManagedCustomHeaderLines`: membership in the managed set is the
only removal criterion. -/
def stripManaged (managed headers : List String) : List String :=
  headers.filter (fun h => decide (h ∉ managed))

/-- User headers survive the strip. -/
theorem stripManaged_preserves_user (managed headers : List String) (h : String)
    (hmem : h ∈ headers) (huser : h ∉ managed) :
    h ∈ stripManaged managed headers := by
  unfold stripManaged
  simp [List.mem_filter, hmem, huser]

/-- Managed headers are removed. -/
theorem stripManaged_removes_managed (managed headers : List String) (h : String)
    (hmanaged : h ∈ managed) :
    h ∉ stripManaged managed headers := by
  unfold stripManaged
  simp [List.mem_filter, hmanaged]

/-- Spot check: BYOK lines go, user lines stay. -/
theorem stripManaged_spot :
    stripManaged ["x-anthropic-api-key", "x-openai-api-key"]
      ["x-anthropic-api-key", "x-user-trace"] = ["x-user-trace"] := by
  native_decide

end Nexus.CredentialResolution
