use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use crate::error::{Error, Result};
use crate::model::ConnectionId;

pub trait SecretStore: Send + Sync {
    fn get(&self, id: ConnectionId) -> Result<Option<String>>;
    fn set(&self, id: ConnectionId, secret: &str) -> Result<()>;
    fn delete(&self, id: ConnectionId) -> Result<()>;
    /// Secrets that belong to no Connection, such as the AI key (`AI/<provider>`).
    fn get_named(&self, name: &str) -> Result<Option<String>>;
    fn set_named(&self, name: &str, secret: &str) -> Result<()>;
    fn delete_named(&self, name: &str) -> Result<()>;
}

const SERVICE: &str = "Contura";
/// The service name used before the rename; read only by the startup migration.
const LEGACY_SERVICE: &str = "DB View";

pub struct KeyringSecretStore {
    service: &'static str,
}

impl KeyringSecretStore {
    pub fn new() -> Result<Self> {
        // keyring 4's `v1` mode installs the Windows native store as the default store
        // once per process; this surfaces any failure of that one-time setup.
        if let Err(e) = keyring::Entry::store_status() {
            return Err(Error::Secret(e.to_string()));
        }
        Ok(Self { service: SERVICE })
    }

    /// The store under the pre-rename service name, for `migrate_from_legacy` only.
    pub fn legacy() -> Result<Self> {
        Self::new()?;
        Ok(Self {
            service: LEGACY_SERVICE,
        })
    }

    fn entry(&self, account: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(self.service, account).map_err(|e| Error::Secret(e.to_string()))
    }
}

impl SecretStore for KeyringSecretStore {
    fn get(&self, id: ConnectionId) -> Result<Option<String>> {
        self.get_named(&id.to_string())
    }

    fn set(&self, id: ConnectionId, secret: &str) -> Result<()> {
        self.set_named(&id.to_string(), secret)
    }

    fn delete(&self, id: ConnectionId) -> Result<()> {
        self.delete_named(&id.to_string())
    }

    fn get_named(&self, name: &str) -> Result<Option<String>> {
        match self.entry(name)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(Error::Secret(e.to_string())),
        }
    }

    fn set_named(&self, name: &str, secret: &str) -> Result<()> {
        self.entry(name)?
            .set_password(secret)
            .map_err(|e| Error::Secret(e.to_string()))
    }

    fn delete_named(&self, name: &str) -> Result<()> {
        match self.entry(name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(Error::Secret(e.to_string())),
        }
    }
}

/// What a legacy-secret migration did. Counts only: no secret or account name is ever kept here.
#[derive(Debug, Default, PartialEq, Eq, Clone, Copy)]
pub struct MigrationReport {
    pub migrated: usize,
    pub skipped: usize,
    pub failed: usize,
}

/// Moves secrets from the pre-rename service (`DB View`) to the current one.
///
/// For each account that has a legacy entry and no current entry, the secret is written to
/// `current`, read back and compared, and only then deleted from `legacy`. Any failed step
/// leaves the legacy entry in place and counts as `failed`; nothing is returned or logged
/// that contains a secret. Only the given accounts are touched, and a second run is a no-op.
pub fn migrate_from_legacy(
    current: &dyn SecretStore,
    legacy: &dyn SecretStore,
    connections: &[ConnectionId],
    named: &[String],
) -> MigrationReport {
    let mut report = MigrationReport::default();
    for id in connections {
        let step = migrate_one(
            || legacy.get(*id),
            || current.get(*id),
            |s| current.set(*id, s),
            || current.delete(*id),
            || legacy.delete(*id),
        );
        report.add(step);
    }
    for name in named {
        let step = migrate_one(
            || legacy.get_named(name),
            || current.get_named(name),
            |s| current.set_named(name, s),
            || current.delete_named(name),
            || legacy.delete_named(name),
        );
        report.add(step);
    }
    report
}

enum Step {
    Nothing,
    Skipped,
    Migrated,
    Failed,
}

impl MigrationReport {
    fn add(&mut self, step: Step) {
        match step {
            Step::Nothing => {}
            Step::Skipped => self.skipped += 1,
            Step::Migrated => self.migrated += 1,
            Step::Failed => self.failed += 1,
        }
    }
}

fn migrate_one(
    read_legacy: impl Fn() -> Result<Option<String>>,
    read_current: impl Fn() -> Result<Option<String>>,
    write_current: impl Fn(&str) -> Result<()>,
    delete_current: impl Fn() -> Result<()>,
    delete_legacy: impl Fn() -> Result<()>,
) -> Step {
    let Ok(old) = read_legacy() else {
        return Step::Failed;
    };
    let Some(old) = old else {
        return Step::Nothing;
    };
    match read_current() {
        Ok(None) => {}
        // An earlier run copied it but could not delete the old entry: finish that run.
        Ok(Some(existing)) if existing == old => {
            return match delete_legacy() {
                Ok(()) => Step::Migrated,
                Err(_) => Step::Failed,
            };
        }
        Ok(Some(_)) => return Step::Skipped,
        Err(_) => return Step::Failed,
    }
    if write_current(&old).is_err() {
        return Step::Failed;
    }
    match read_current() {
        Ok(Some(back)) if back == old => {}
        _ => {
            // Never leave a copy that does not match: the next start would skip this account.
            let _ = delete_current();
            return Step::Failed;
        }
    }
    if delete_legacy().is_err() {
        return Step::Failed;
    }
    Step::Migrated
}

#[derive(Default)]
pub struct MemorySecretStore {
    secrets: Mutex<HashMap<ConnectionId, String>>,
    named: Mutex<HashMap<String, String>>,
}

impl MemorySecretStore {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> Result<MutexGuard<'_, HashMap<ConnectionId, String>>> {
        self.secrets
            .lock()
            .map_err(|_| Error::Secret("secret store lock poisoned".into()))
    }

    fn lock_named(&self) -> Result<MutexGuard<'_, HashMap<String, String>>> {
        self.named
            .lock()
            .map_err(|_| Error::Secret("secret store lock poisoned".into()))
    }
}

impl SecretStore for MemorySecretStore {
    fn get(&self, id: ConnectionId) -> Result<Option<String>> {
        Ok(self.lock()?.get(&id).cloned())
    }

    fn set(&self, id: ConnectionId, secret: &str) -> Result<()> {
        self.lock()?.insert(id, secret.to_string());
        Ok(())
    }

    fn delete(&self, id: ConnectionId) -> Result<()> {
        self.lock()?.remove(&id);
        Ok(())
    }

    fn get_named(&self, name: &str) -> Result<Option<String>> {
        Ok(self.lock_named()?.get(name).cloned())
    }

    fn set_named(&self, name: &str, secret: &str) -> Result<()> {
        self.lock_named()?
            .insert(name.to_string(), secret.to_string());
        Ok(())
    }

    fn delete_named(&self, name: &str) -> Result<()> {
        self.lock_named()?.remove(name);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_store_set_get_delete() {
        let store = MemorySecretStore::new();
        let id = ConnectionId::new_v4();
        assert_eq!(store.get(id).unwrap(), None);
        store.set(id, "hunter2").unwrap();
        assert_eq!(store.get(id).unwrap().as_deref(), Some("hunter2"));
        store.set(id, "changed").unwrap();
        assert_eq!(store.get(id).unwrap().as_deref(), Some("changed"));
        store.delete(id).unwrap();
        assert_eq!(store.get(id).unwrap(), None);
    }

    #[test]
    fn memory_store_named_secrets_are_separate() {
        let store = MemorySecretStore::new();
        assert_eq!(store.get_named("AI/groq").unwrap(), None);
        store.set_named("AI/groq", "k1").unwrap();
        store.set_named("AI/openai", "k2").unwrap();
        assert_eq!(store.get_named("AI/groq").unwrap().as_deref(), Some("k1"));
        store.delete_named("AI/groq").unwrap();
        assert_eq!(store.get_named("AI/groq").unwrap(), None);
        assert_eq!(store.get_named("AI/openai").unwrap().as_deref(), Some("k2"));
        store.delete_named("AI/groq").unwrap();
    }

    #[test]
    fn delete_missing_is_ok() {
        let store = MemorySecretStore::new();
        store.delete(ConnectionId::new_v4()).unwrap();
    }

    #[test]
    #[ignore = "touches the real Windows Credential Manager"]
    fn keyring_store_round_trip() {
        let store = KeyringSecretStore::new().unwrap();
        let id = ConnectionId::new_v4();
        assert_eq!(store.get(id).unwrap(), None);
        store.set(id, "s3cret").unwrap();
        assert_eq!(store.get(id).unwrap().as_deref(), Some("s3cret"));
        store.delete(id).unwrap();
        assert_eq!(store.get(id).unwrap(), None);
        store.delete(id).unwrap();
    }

    /// Wraps a store to make writes fail or land with a different value.
    struct Faulty {
        inner: MemorySecretStore,
        fail_set: bool,
        corrupt_set: bool,
        refuse: Option<ConnectionId>,
    }

    impl Faulty {
        fn new(fail_set: bool, corrupt_set: bool) -> Self {
            Self {
                inner: MemorySecretStore::new(),
                fail_set,
                corrupt_set,
                refuse: None,
            }
        }

        /// Refuses writes for one Connection id only.
        fn refusing(id: ConnectionId) -> Self {
            Self {
                refuse: Some(id),
                ..Self::new(false, false)
            }
        }
    }

    impl SecretStore for Faulty {
        fn get(&self, id: ConnectionId) -> Result<Option<String>> {
            self.inner.get(id)
        }
        fn set(&self, id: ConnectionId, secret: &str) -> Result<()> {
            if self.fail_set || self.refuse == Some(id) {
                return Err(Error::Secret("write refused".into()));
            }
            let stored = if self.corrupt_set { "other" } else { secret };
            self.inner.set(id, stored)
        }
        fn delete(&self, id: ConnectionId) -> Result<()> {
            self.inner.delete(id)
        }
        fn get_named(&self, name: &str) -> Result<Option<String>> {
            self.inner.get_named(name)
        }
        fn set_named(&self, name: &str, secret: &str) -> Result<()> {
            if self.fail_set {
                return Err(Error::Secret("write refused".into()));
            }
            let stored = if self.corrupt_set { "other" } else { secret };
            self.inner.set_named(name, stored)
        }
        fn delete_named(&self, name: &str) -> Result<()> {
            self.inner.delete_named(name)
        }
    }

    fn ai() -> Vec<String> {
        vec!["AI/groq".to_string(), "AI/openai".to_string()]
    }

    #[test]
    fn migration_copies_verifies_then_deletes_old() {
        let (legacy, current) = (MemorySecretStore::new(), MemorySecretStore::new());
        let id = ConnectionId::new_v4();
        legacy.set(id, "db-pw").unwrap();
        legacy.set_named("AI/groq", "k1").unwrap();
        let report = migrate_from_legacy(&current, &legacy, &[id], &ai());
        assert_eq!(
            report,
            MigrationReport {
                migrated: 2,
                skipped: 0,
                failed: 0
            }
        );
        assert_eq!(current.get(id).unwrap().as_deref(), Some("db-pw"));
        assert_eq!(current.get_named("AI/groq").unwrap().as_deref(), Some("k1"));
        assert_eq!(legacy.get(id).unwrap(), None);
        assert_eq!(legacy.get_named("AI/groq").unwrap(), None);
    }

    #[test]
    fn migration_keeps_old_when_new_write_fails() {
        let legacy = MemorySecretStore::new();
        let current = Faulty::new(true, false);
        let id = ConnectionId::new_v4();
        legacy.set(id, "db-pw").unwrap();
        legacy.set_named("AI/groq", "k1").unwrap();
        let report = migrate_from_legacy(&current, &legacy, &[id], &ai());
        assert_eq!(
            report,
            MigrationReport {
                migrated: 0,
                skipped: 0,
                failed: 2
            }
        );
        assert_eq!(legacy.get(id).unwrap().as_deref(), Some("db-pw"));
        assert_eq!(legacy.get_named("AI/groq").unwrap().as_deref(), Some("k1"));
        assert_eq!(current.get(id).unwrap(), None);
    }

    #[test]
    fn migration_keeps_old_when_read_back_differs() {
        let legacy = MemorySecretStore::new();
        let current = Faulty::new(false, true);
        let id = ConnectionId::new_v4();
        legacy.set(id, "db-pw").unwrap();
        legacy.set_named("AI/groq", "k1").unwrap();
        let report = migrate_from_legacy(&current, &legacy, &[id], &ai());
        assert_eq!(
            report,
            MigrationReport {
                migrated: 0,
                skipped: 0,
                failed: 2
            }
        );
        assert_eq!(legacy.get(id).unwrap().as_deref(), Some("db-pw"));
        assert_eq!(legacy.get_named("AI/groq").unwrap().as_deref(), Some("k1"));
        // The mismatched copy is removed, so the next start tries again.
        assert_eq!(current.get(id).unwrap(), None);
        assert_eq!(current.get_named("AI/groq").unwrap(), None);
    }

    #[test]
    fn migration_finishes_an_earlier_copy_whose_old_entry_stayed() {
        let (legacy, current) = (MemorySecretStore::new(), MemorySecretStore::new());
        let id = ConnectionId::new_v4();
        legacy.set(id, "db-pw").unwrap();
        current.set(id, "db-pw").unwrap();
        let report = migrate_from_legacy(&current, &legacy, &[id], &ai());
        assert_eq!(
            report,
            MigrationReport {
                migrated: 1,
                skipped: 0,
                failed: 0
            }
        );
        assert_eq!(legacy.get(id).unwrap(), None);
        assert_eq!(current.get(id).unwrap().as_deref(), Some("db-pw"));
    }

    #[test]
    fn migration_skips_when_new_entry_exists() {
        let (legacy, current) = (MemorySecretStore::new(), MemorySecretStore::new());
        let id = ConnectionId::new_v4();
        legacy.set(id, "old").unwrap();
        current.set(id, "new").unwrap();
        let report = migrate_from_legacy(&current, &legacy, &[id], &ai());
        assert_eq!(
            report,
            MigrationReport {
                migrated: 0,
                skipped: 1,
                failed: 0
            }
        );
        assert_eq!(current.get(id).unwrap().as_deref(), Some("new"));
        assert_eq!(legacy.get(id).unwrap().as_deref(), Some("old"));
    }

    #[test]
    fn migration_ignores_ids_without_a_legacy_entry_and_other_accounts() {
        let (legacy, current) = (MemorySecretStore::new(), MemorySecretStore::new());
        let id = ConnectionId::new_v4();
        legacy.set_named("someone-else", "x").unwrap();
        let report = migrate_from_legacy(&current, &legacy, &[id], &ai());
        assert_eq!(report, MigrationReport::default());
        assert_eq!(current.get_named("someone-else").unwrap(), None);
        assert_eq!(
            legacy.get_named("someone-else").unwrap().as_deref(),
            Some("x")
        );
    }

    #[test]
    fn migration_is_idempotent() {
        let (legacy, current) = (MemorySecretStore::new(), MemorySecretStore::new());
        let id = ConnectionId::new_v4();
        legacy.set(id, "db-pw").unwrap();
        migrate_from_legacy(&current, &legacy, &[id], &ai());
        let again = migrate_from_legacy(&current, &legacy, &[id], &ai());
        assert_eq!(again, MigrationReport::default());
        assert_eq!(current.get(id).unwrap().as_deref(), Some("db-pw"));
    }

    #[test]
    fn migration_continues_past_one_failure() {
        let legacy = MemorySecretStore::new();
        let (a, b) = (ConnectionId::new_v4(), ConnectionId::new_v4());
        let current = Faulty::refusing(a);
        legacy.set(a, "pa").unwrap();
        legacy.set(b, "pb").unwrap();
        let report = migrate_from_legacy(&current, &legacy, &[a, b], &ai());
        assert_eq!(
            report,
            MigrationReport {
                migrated: 1,
                skipped: 0,
                failed: 1
            }
        );
        assert_eq!(legacy.get(a).unwrap().as_deref(), Some("pa"));
        assert_eq!(current.get(b).unwrap().as_deref(), Some("pb"));
    }
}
