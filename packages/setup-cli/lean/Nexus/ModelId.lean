/-
Formal model of `lib/fireworks/model-id.mjs` + router/auto bits of
`lib/fireworks/model-specs.mjs`.

Segment-level predicates carry the general theorems (pure list reasoning, no
`String.splitOn` lemmas needed). `String` wrappers transliterate the JS entry
points and are pinned by `decide` examples plus the segment theorems.
-/
namespace Nexus.ModelId

/-- Drop a trailing `[1m]` context tag (case-insensitive), mirroring
`stripContextSuffix` in `model-id.mjs`. -/
def stripContextSuffix (s : String) : String :=
  if s.endsWith "[1m]" || s.endsWith "[1M]" then s.dropRight 4 else s

/-- Split on `/`, keeping empty segments (mirrors JS `.split("/")`). -/
def splitSlash (s : String) : List String :=
  s.splitOn "/"

/-- Last `/`-separated segment, or the whole string when there is no slash. -/
def lastSegment (s : String) : String :=
  (splitSlash s).getLastD s

/-- A slash path segment usable as a FireRouter member: non-empty, not
`.`/`..`, no whitespace. Mirrors the `members.every(...)` gate. -/
def isRouteMember (s : String) : Bool :=
  !s.isEmpty && s != "." && s != ".." &&
    !(s.toList.any (fun c => c == ' ' || c == '\t' || c == '\n' || c == '\r'))

/-- Strict admission on pre-split members: every member must be usable. -/
def routeMembersOk : List String → Bool
  | [] => false
  | members => members.all isRouteMember

/-- Liberal pattern on pre-split segments: any segment starts with
`firerouter`. -/
def patternOnSegments (segs : List String) : Bool :=
  segs.any (fun part => "firerouter".isPrefixOf part)

/-- Every strict route matches the liberal pattern: the head segment is
`firerouter` itself. Pure list reasoning. -/
theorem routeMembers_ok_implies_pattern (members : List String) :
    routeMembersOk ("firerouter" :: members) = true →
      patternOnSegments ("firerouter" :: members) = true := by
  intro _
  have hfir : "firerouter".isPrefixOf "firerouter" = true := by native_decide
  unfold patternOnSegments
  simp [hfir]

/-- Empty member lists are never routes (covers `firerouter/` after split). -/
theorem routeMembers_empty_rejected : routeMembersOk [] = false := rfl

/-- Empty / dot / dotdot members are rejected. -/
theorem routeMembers_rejects_junk :
    routeMembersOk [""] = false ∧
    routeMembersOk ["."] = false ∧
    routeMembersOk [".."] = false ∧
    routeMembersOk ["kimi-k3", ""] = false := by native_decide

/-- Lookalikes match the liberal pattern but can never be strict heads. -/
theorem pattern_accepts_lookalike :
    patternOnSegments ["foo", "firerouter-clone"] = true := by native_decide

/-- `isFirerouterRouteRef`: bare `firerouter` or `firerouter/a/...` with no
empty segment. Strict admission gate; display stays liberal. -/
def isFirerouterRouteRef (s : String) : Bool :=
  let ref := stripContextSuffix s.trim.toLower
  if ref == "firerouter" then true
  else if "firerouter/".isPrefixOf ref then
    routeMembersOk ((splitSlash (ref.drop "firerouter/".length)))
  else false

/-- `isFirerouterModelPattern` (`model-specs.mjs`): any slash segment starts
with `firerouter`. Liberal: routing/display only, never admission. -/
def isFirerouterModelPattern (s : String) : Bool :=
  patternOnSegments (splitSlash (stripContextSuffix s.trim.toLower))

/-- String-level spot checks (each by computation). -/
theorem routeRef_spot :
    isFirerouterRouteRef "firerouter" = true ∧
    isFirerouterRouteRef "firerouter/kimi-k3" = true ∧
    isFirerouterRouteRef "firerouter/" = false ∧
    isFirerouterRouteRef "firerouter//kimi" = false ∧
    isFirerouterRouteRef "foo/firerouter-clone" = false := by native_decide

theorem pattern_spot :
    isFirerouterModelPattern "firerouter" = true ∧
    isFirerouterModelPattern "firerouter/kimi-k3" = true ∧
    isFirerouterModelPattern "foo/firerouter-clone" = true ∧
    isFirerouterModelPattern "kimi-k3" = false := by native_decide

/-- The converse fails by design: lookalike matches liberal, rejected strict. -/
theorem pattern_not_implies_routeRef :
    ∃ s, isFirerouterModelPattern s = true ∧ isFirerouterRouteRef s = false :=
  ⟨"foo/firerouter-clone", by native_decide, by native_decide⟩

/-- Cursor-native `auto-smart` is not a gateway auto mix. -/
def isNonGatewayAuto (s : String) : Bool :=
  s == "auto-smart"

/-- `canonicalAutoModelId`: whole-ref match only, never per segment. -/
def canonicalAutoModelId (s : String) : String :=
  let slug := stripContextSuffix s.trim.toLower
  if slug.isEmpty then ""
  else if (splitSlash slug).length != 1 then ""
  else if isNonGatewayAuto slug then ""
  else if slug == "auto" || "auto-".isPrefixOf slug then slug
  else ""

theorem auto_spot :
    canonicalAutoModelId "auto" = "auto" ∧
    canonicalAutoModelId "auto-instant" = "auto-instant" ∧
    canonicalAutoModelId "AUTO-INSTANT[1m]" = "auto-instant" ∧
    canonicalAutoModelId "auto-smart" = "" ∧
    canonicalAutoModelId "firerouter/auto-instant" = "" ∧
    canonicalAutoModelId "accounts/auto-corp/x" = "" := by native_decide

/-- `stripContextSuffix` strips a single trailing tag. Nested tags need one
pass each (`"x[1m][1m]" → `"x[1m]" → `"x"`), so single-strip is *not*
idempotent — this documents the JS behavior callers must handle. -/
theorem stripContextSuffix_examples :
    stripContextSuffix "kimi-k3[1m]" = "kimi-k3" ∧
    stripContextSuffix "kimi-k3[1M]" = "kimi-k3" ∧
    stripContextSuffix "kimi-k3" = "kimi-k3" := by native_decide

theorem stripContextSuffix_nested_needs_two :
    stripContextSuffix "x[1m][1m]" = "x[1m]" ∧
    stripContextSuffix (stripContextSuffix "x[1m][1m]") = "x" := by native_decide

end Nexus.ModelId
