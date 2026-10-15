use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use crate::error::{Error, Result};
use crate::model::ConnectionId;

pub trait SecretStore: Send + Sync {
    fn get(&self, id: ConnectionId) -> Result<Option<String>>;
    fn set(&self, id: ConnectionId, secret: &str) -> Result<()>;
    fn delete(&self, id: ConnectionId) -> Result<()>;
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

    fn entry(id: ConnectionId) -> Result<keyring::Entry> {
        keyring::Entry::new(SERVICE, &id.to_string()).map_err(|e| Error::Secret(e.to_string()))
    }
}

impl SecretStore for KeyringSecretStore {
    fn get(&self, id: ConnectionId) -> Result<Option<String>> {
        match Self::entry(id)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(Error::Secret(e.to_string())),
        }
    }

    fn set(&self, id: ConnectionId, secret: &str) -> Result<()> {
        Self::entry(id)?
            .set_password(secret)
            .map_err(|e| Error::Secret(e.to_string()))
    }

    fn delete(&self, id: ConnectionId) -> Result<()> {
        match Self::entry(id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(Error::Secret(e.to_string())),
        }
    }
}

#[derive(Default)]
pub struct MemorySecretStore {
    secrets: Mutex<HashMap<ConnectionId, String>>,
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
