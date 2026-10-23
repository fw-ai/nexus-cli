/-
Formal model of `sanitizeKeyHint` in `lib/keys/provider-keys-status.mjs`.

A server-supplied `keyHint` is display-only. The client keeps it only
when it is plausibly a masked preview — it contains a mask character,
is short, and has at most a 4-character tail after the last mask
character — and re-masks everything else before the hint can reach the
terminal or `--json` output. Hints are modeled as character lists, so
mask membership is plain list reasoning; the JS string operations
(`lastIndexOf`, slicing) map to the reversed `takeWhile` tail below.
The re-masked form is modeled without the provider prefix the JS
preserves (`sk-ant-`/`sk-proj-`/first-3): the safety properties
(masked output, never verbatim) do not depend on it, but exact hint
strings do — see the JS tests for those.
-/
namespace Nexus.KeyHint

/-- Characters that mark a hint as masked. -/
def isMask (c : Char) : Bool := c == '•' || c == '*'

/-- Length of the run after the last mask character (the visible tail). -/
def tailAfterLastMask (h : List Char) : Nat :=
  (h.reverse.takeWhile (fun c => !isMask c)).length

/-- Whether a hint is plausibly a masked preview. Mirrors the
`sanitizeKeyHint` acceptance check. -/
def plausibleMask (h : List Char) : Bool :=
  h.any isMask && h.length ≤ 32 && tailAfterLastMask h ≤ 4

/-- The re-masked form: just the mask block for short values, otherwise
the mask block plus the last 4 characters — the JS construction at the
level the safety property needs (mask membership, bounded tail). -/
def remask (h : List Char) : List Char :=
  if h.length ≤ 8 then ['•', '•', '•', '•']
  else ['•', '•', '•', '•'] ++ h.drop (h.length - 4)

/-- Sanitize a server hint. Mirrors `sanitizeKeyHint`: empty stays
empty, a plausible masked preview is kept, anything else is re-masked. -/
def sanitize (h : List Char) : List Char :=
  if h.isEmpty then h
  else if plausibleMask h then h
  else remask h

/-- The output is always masked (or empty): no code path returns an
unmasked value to the display. -/
theorem sanitize_masked_or_empty (h : List Char)
    (hne : h.isEmpty = false) : (sanitize h).any isMask = true := by
  by_cases hp : plausibleMask h = true
  · have hmask : h.any isMask = true := by
      unfold plausibleMask at hp
      simp only [Bool.and_eq_true] at hp
      exact hp.1.1
    simp [sanitize, hne, hp, hmask]
  · have hmem : '•' ∈ remask h := by
      unfold remask
      split <;> simp
    simp only [sanitize, hne, hp, List.any_eq_true]
    exact ⟨'•', hmem, by simp [isMask]⟩

/-- An unmasked input is never returned verbatim: a full provider key
that a misconfigured or compromised gateway sends as the "hint" cannot
pass through to the terminal or `--json`. -/
theorem unmasked_input_never_returned (h : List Char)
    (hne : h.isEmpty = false) (hun : h.any isMask = false) :
    sanitize h ≠ h := by
  intro hcontra
  have hmask : (sanitize h).any isMask = true := sanitize_masked_or_empty h hne
  rw [hcontra] at hmask
  rw [hun] at hmask
  contradiction

/-- A plausible masked preview survives untouched, so the server
hints users already see (`sk-ant-••••2kAA`) are unchanged. -/
theorem plausible_kept (h : List Char)
    (hne : h.isEmpty = false) (hp : plausibleMask h = true) : sanitize h = h := by
  simp [sanitize, hne, hp]

/-- Spot checks mirroring the JS unit tests, including a full key that
merely contains a mask character in the middle. -/
theorem sanitize_spot :
    sanitize "sk-ant-••••2kAA".toList = "sk-ant-••••2kAA".toList ∧
    sanitize "shortkey".toList = "••••".toList ∧
    sanitize "".toList = "".toList ∧
    (sanitize "sk-ant-api03-example*fullkeyvalue-9zZZ".toList).any isMask = true ∧
    sanitize "sk-ant-api03-example*fullkeyvalue-9zZZ".toList
      ≠ "sk-ant-api03-example*fullkeyvalue-9zZZ".toList := by
  native_decide

end Nexus.KeyHint
