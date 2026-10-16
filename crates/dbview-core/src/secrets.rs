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

const SERVICE: &str = "DB View";

pub struct KeyringSecretStore;

impl KeyringSecretStore {
    pub fn new() -> Result<Self> {
        // keyring 4's `v1` mode installs the Windows native store as the default store
        // once per process; this surfaces any failure of that one-time setup.
        if let Err(e) = keyring::Entry::store_status() {
            return Err(Error::Secret(e.to_string()));
        }
        Ok(Self)
    }

    fn entry(account: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(SERVICE, account).map_err(|e| Error::Secret(e.to_string()))
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
        match Self::entry(name)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(Error::Secret(e.to_string())),
        }
    }

    fn set_named(&self, name: &str, secret: &str) -> Result<()> {
        Self::entry(name)?
            .set_password(secret)
            .map_err(|e| Error::Secret(e.to_string()))
    }

    fn delete_named(&self, name: &str) -> Result<()> {
        match Self::entry(name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(Error::Secret(e.to_string())),
        }
    }
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
}
