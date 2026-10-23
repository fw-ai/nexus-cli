/-
Formal model of the secret-store lifecycle in `lib/keys/secret-store.mjs`
and `lib/keys/secret-fallbacks.mjs`.

Three safety properties, each corresponding to a bug class this code
has had:

1. The fallback ladder (`storeSecretWithFallbacks`) tries the secure
   backend, then the encrypted file, then plaintext — plaintext is
   chosen only when both safer stores failed.
2. Deletion (`deleteSecret`, via `deleteSecretFromSecureBackend`)
   clears every store — OS keychain, encrypted file, plaintext, and
   the storage cache — so a deleted key cannot resurrect from a copy
   left in another backend.
3. Reprobe retirement (`retireFileFallbackCopy`) removes the
   encrypted-file copy only once the key reads back from the secure
   backend; otherwise the file copy is restored. The key is never
   left with zero durable copies.

Stores are modeled as optional values per backend; IO, prompts, and
timeouts stay outside the model. The delete/retire theorems describe
completed operations: the JS deletes are individually best-effort,
so a backend delete that itself fails can still leave a copy — that
failure mode is outside this model, as is the test-only memory store.
JS tests: `test/keys/file-fallback-reads.test.mjs`,
`test/keys/plaintext-fallback.test.mjs`, `test/keys/secret-backend.test.mjs`.
-/
namespace Nexus.SecretLifecycle

/-- Which backend a write landed in, in ladder order. -/
inductive Backend where
  | secure
  | file
  | plaintext
  | failed
deriving DecidableEq, Repr

/-- The fallback ladder: secure first, then the encrypted file, then
plaintext. Mirrors `storeSecretWithFallbacks` descending on failure. -/
def chooseBackend (secureOk fileOk plaintextOk : Bool) : Backend :=
  if secureOk then .secure
  else if fileOk then .file
  else if plaintextOk then .plaintext
  else .failed

/-- Plaintext is chosen only when both safer stores failed. -/
theorem plaintext_only_when_safer_failed (s f p : Bool)
    (h : chooseBackend s f p = .plaintext) : s = false ∧ f = false := by
  unfold chooseBackend at h
  by_cases hs : s = true
  · simp [hs] at h
  · have hs' : s = false := by cases s <;> simp_all
    by_cases hf : f = true
    · simp [hs', hf] at h
    · have hf' : f = false := by cases f <;> simp_all
      exact ⟨hs', hf'⟩

/-- A working secure backend is always where the write lands. -/
theorem secure_first (f p : Bool) :
    chooseBackend true f p = .secure := by
  simp [chooseBackend]

/-- The durable copies of the key, one optional value per backend. -/
structure Stores where
  keychain : Option String
  file : Option String
  plaintext : Option String
deriving Repr

/-- Reading the key: the first durable copy found, in the order the
resolver consults backends (secure, file, plaintext). -/
def read (s : Stores) : Option String :=
  s.keychain.or (s.file.or s.plaintext)

/-- Deletion clears every backend. Mirrors the delete-both-stores
behavior of `deleteSecretFromSecureBackend` plus the plaintext and
cache clears in `deleteSecret`. -/
def deleteAll (_s : Stores) : Stores := ⟨none, none, none⟩

/-- After deletion, no backend can produce the key again: whichever
store a stale copy sat in, the read comes back empty. -/
theorem delete_never_resurrects (s : Stores) :
    read (deleteAll s) = none := rfl

/-- Deletion is total over contents: even with every store populated,
the post-delete state is empty everywhere. -/
theorem delete_clears_each (k f p : String) :
    deleteAll ⟨some k, some f, some p⟩ = ⟨none, none, none⟩ := rfl

/-- Reprobe retirement: drop the file copy only when the secure
backend verifiably holds the key (`secureKeeps` — the readback the JS
checks before retiring), otherwise restore the file copy. Mirrors
`retireFileFallbackCopy` on its success paths. -/
def retire (s : Stores) (key : String) (secureKeeps : Bool) : Stores :=
  if secureKeeps then { keychain := some key, file := none, plaintext := s.plaintext }
  else { s with file := some key }

/-- Retirement never leaves the key with zero durable copies: with
the key in the keychain beforehand, it is afterwards in the keychain
(retirement succeeded) or back in the file (restored). -/
theorem retire_keeps_a_copy (s : Stores) (key : String)
    (secureKeeps : Bool) :
    (retire s key secureKeeps).keychain = some key
      ∨ (retire s key secureKeeps).file = some key := by
  cases secureKeeps <;> simp [retire]

/-- A committed file fallback stays in the file even if the OS
keychain later starts answering again: reads consult the committed
backend, which is what stops an older keychain copy from shadowing
the current key. Mirrors `fileFallbackCommitted` steering reads. -/
def readCommitted (s : Stores) (committed : Option Backend) : Option String :=
  match committed with
  | some .file => s.file
  | some .plaintext => s.plaintext
  | _ => read s

theorem committed_file_reads_file (s : Stores) (staleKeychain : String) :
    readCommitted { s with keychain := some staleKeychain } (some .file)
      = s.file := rfl

/-- Spot checks mirroring the JS lifecycle tests. -/
theorem lifecycle_spot :
    chooseBackend true true true = .secure ∧
    chooseBackend false true true = .file ∧
    chooseBackend false false true = .plaintext ∧
    chooseBackend false false false = .failed ∧
    read (deleteAll ⟨some "fw_old", some "fw_old", some "fw_old"⟩) = none ∧
    (retire ⟨some "fw_k", some "fw_k", none⟩ "fw_k" false).file = some "fw_k" ∧
    (retire ⟨some "fw_k", some "fw_k", none⟩ "fw_k" true).file = none := by
  native_decide

end Nexus.SecretLifecycle
