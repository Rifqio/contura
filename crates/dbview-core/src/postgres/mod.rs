use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio_postgres::error::SqlState;
use tokio_postgres::{Client, NoTls};
use tokio_postgres_rustls::MakeRustlsConnect;

use crate::dialect::Dialect;
use crate::error::{Error, Result};
use crate::model::{
    ConnectionConfig, DbObject, FullValue, FullValueRequest, ObjectKind, ObjectPath, Page,
    PageRequest, SchemaInfo, SslMode,
};

mod introspect;
mod page;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_DATABASE: &str = "postgres";

/// One Postgres client per database, since a Postgres session is bound to the
/// database it signed in to.
pub struct PostgresDialect {
    settings: Settings,
    default_database: String,
    clients: Mutex<HashMap<String, Arc<Client>>>,
}

#[derive(Clone)]
struct Settings {
    /// Everything but the database name.
    base: tokio_postgres::Config,
    /// `None` means plain TCP.
    tls: Option<MakeRustlsConnect>,
    target: String,
}

impl PostgresDialect {
    /// Signs in to the configured database (or `postgres`), so a bad config fails right away.
    pub async fn connect(config: &ConnectionConfig, password: Option<&str>) -> Result<Self> {
        let settings = build_settings(config, password)?;
        let default_database = config
            .database
            .clone()
            .unwrap_or_else(|| DEFAULT_DATABASE.to_string());
        let client = open_client(&settings, &default_database).await?;
        let clients = HashMap::from([(default_database.clone(), Arc::new(client))]);
        Ok(Self {
            settings,
            default_database,
            clients: Mutex::new(clients),
        })
    }

    /// The cached client for `database`, connecting a new one when there is
    /// none or it has closed. Public only for integration tests.
    #[doc(hidden)]
    pub async fn client(&self, database: &str) -> Result<Arc<Client>> {
        if let Some(client) = self.cached(database)? {
            return Ok(client);
        }
        // Connect outside the lock; on a race the first client cached wins.
        let fresh = Arc::new(open_client(&self.settings, database).await?);
        let mut clients = self.clients.lock().map_err(|_| poisoned())?;
        match clients.get(database) {
            Some(existing) if !existing.is_closed() => Ok(existing.clone()),
            _ => {
                clients.insert(database.to_string(), fresh.clone());
                Ok(fresh)
            }
        }
    }

    fn cached(&self, database: &str) -> Result<Option<Arc<Client>>> {
        let clients = self.clients.lock().map_err(|_| poisoned())?;
        Ok(clients.get(database).filter(|c| !c.is_closed()).cloned())
    }
}

fn poisoned() -> Error {
    Error::Query("postgres client cache lock poisoned".into())
}

fn build_settings(config: &ConnectionConfig, password: Option<&str>) -> Result<Settings> {
    let mut base = tokio_postgres::Config::new();
    base.host(&config.host)
        .port(config.port)
        .user(&config.user)
        .connect_timeout(CONNECT_TIMEOUT)
        .application_name("DB View")
        .options("-c TimeZone=UTC");
    if let Some(password) = password {
        base.password(password);
    }
    let tls = match &config.ssl {
        SslMode::Disable => None,
        SslMode::Require => Some(MakeRustlsConnect::new(tls::accept_any_certificate())),
        SslMode::VerifyCa { ca_path } => Some(MakeRustlsConnect::new(tls::trust_only_ca(ca_path)?)),
    };
    base.ssl_mode(if tls.is_some() {
        tokio_postgres::config::SslMode::Require
    } else {
        tokio_postgres::config::SslMode::Disable
    });
    Ok(Settings {
        base,
        tls,
        target: format!("{}:{}", config.host, config.port),
    })
}

async fn open_client(settings: &Settings, database: &str) -> Result<Client> {
    let mut config = settings.base.clone();
    config.dbname(database);
    let connecting = async {
        match &settings.tls {
            None => {
                let (client, connection) = config.connect(NoTls).await?;
                tokio::spawn(async move {
                    let _ = connection.await;
                });
                Ok(client)
            }
            Some(tls) => {
                let (client, connection) = config.connect(tls.clone()).await?;
                tokio::spawn(async move {
                    let _ = connection.await;
                });
                Ok(client)
            }
        }
    };
    match tokio::time::timeout(CONNECT_TIMEOUT, connecting).await {
        Ok(Ok(client)) => Ok(client),
        Ok(Err(e)) => Err(map_connect_error(e, &settings.target)),
        Err(_) => Err(Error::Connect(format!(
            "timed out after {} s connecting to {}",
            CONNECT_TIMEOUT.as_secs(),
            settings.target
        ))),
    }
}

fn map_connect_error(e: tokio_postgres::Error, target: &str) -> Error {
    match e.as_db_error() {
        Some(db)
            if *db.code() == SqlState::INVALID_PASSWORD
                || *db.code() == SqlState::INVALID_AUTHORIZATION_SPECIFICATION =>
        {
            Error::Auth(db.message().to_string())
        }
        // The server answered, so host and port are fine (e.g. 3D000 unknown database).
        Some(db) => Error::Query(db.message().to_string()),
        None if is_missing_password(&e) => Error::Auth(
            "the server requires a password, and none is saved for this Connection".into(),
        ),
        None => Error::Connect(format!("cannot reach {target}: {e}")),
    }
}

/// tokio-postgres fails client side, with a config error, when the server asks
/// for a password and none was given. The server was reached by then.
fn is_missing_password(e: &tokio_postgres::Error) -> bool {
    use std::error::Error as _;
    e.to_string().starts_with("invalid configuration")
        && e.source()
            .is_some_and(|s| s.to_string().contains("password missing"))
}

pub(crate) fn query_err(e: tokio_postgres::Error) -> Error {
    match e.as_db_error() {
        Some(db) => Error::Query(db.message().to_string()),
        None => Error::Query(e.to_string()),
    }
}

/// `SHOW server_version` can carry a build note, as in `16.4 (Debian 16.4-1)`.
fn version_number(version: &str) -> &str {
    version.split(' ').next().unwrap_or(version)
}

/// rustls client configs for the two TLS modes, on the `ring` provider.
mod tls {
    use std::path::Path;
    use std::sync::Arc;

    use rustls::client::WebPkiServerVerifier;
    use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
    use rustls::crypto::{CryptoProvider, verify_tls12_signature, verify_tls13_signature};
    use rustls::pki_types::pem::PemObject;
    use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
    use rustls::{CertificateError, ClientConfig, DigitallySignedStruct, RootCertStore};

    use crate::error::{Error, Result};

    fn provider() -> Arc<CryptoProvider> {
        Arc::new(rustls::crypto::ring::default_provider())
    }

    fn config_with(verifier: Arc<dyn ServerCertVerifier>) -> ClientConfig {
        ClientConfig::builder_with_provider(provider())
            .with_safe_default_protocol_versions()
            .expect("ring supports the default protocol versions")
            .dangerous()
            .with_custom_certificate_verifier(verifier)
            .with_no_client_auth()
    }

    /// `Require`: encrypt, but accept any certificate, as MySQL's `Require` does.
    pub(super) fn accept_any_certificate() -> ClientConfig {
        config_with(Arc::new(AcceptAny(provider())))
    }

    /// `VerifyCa`: the chain must lead to a CA from `ca_path` (and only those),
    /// but a host name mismatch is ignored, as MySQL's `VerifyCa` does.
    pub(super) fn trust_only_ca(ca_path: &Path) -> Result<ClientConfig> {
        let unreadable = |e: &dyn std::fmt::Display| {
            Error::InvalidInput(format!("cannot read CA file {}: {e}", ca_path.display()))
        };
        let pem = std::fs::read(ca_path).map_err(|e| unreadable(&e))?;
        let mut roots = RootCertStore::empty();
        for cert in CertificateDer::pem_slice_iter(&pem) {
            let cert = cert.map_err(|e| unreadable(&e))?;
            roots.add(cert).map_err(|e| unreadable(&e))?;
        }
        if roots.is_empty() {
            return Err(unreadable(&"no certificates found"));
        }
        let inner = WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider())
            .build()
            .map_err(|e| unreadable(&e))?;
        Ok(config_with(Arc::new(IgnoreName(inner))))
    }

    #[derive(Debug)]
    struct AcceptAny(Arc<CryptoProvider>);

    impl ServerCertVerifier for AcceptAny {
        fn verify_server_cert(
            &self,
            _end_entity: &CertificateDer<'_>,
            _intermediates: &[CertificateDer<'_>],
            _server_name: &ServerName<'_>,
            _ocsp_response: &[u8],
            _now: UnixTime,
        ) -> std::result::Result<ServerCertVerified, rustls::Error> {
            Ok(ServerCertVerified::assertion())
        }

        fn verify_tls12_signature(
            &self,
            message: &[u8],
            cert: &CertificateDer<'_>,
            dss: &DigitallySignedStruct,
        ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
            verify_tls12_signature(
                message,
                cert,
                dss,
                &self.0.signature_verification_algorithms,
            )
        }

        fn verify_tls13_signature(
            &self,
            message: &[u8],
            cert: &CertificateDer<'_>,
            dss: &DigitallySignedStruct,
        ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
            verify_tls13_signature(
                message,
                cert,
                dss,
                &self.0.signature_verification_algorithms,
            )
        }

        fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
            self.0.signature_verification_algorithms.supported_schemes()
        }
    }

    #[derive(Debug)]
    struct IgnoreName(Arc<WebPkiServerVerifier>);

    impl ServerCertVerifier for IgnoreName {
        fn verify_server_cert(
            &self,
            end_entity: &CertificateDer<'_>,
            intermediates: &[CertificateDer<'_>],
            server_name: &ServerName<'_>,
            ocsp_response: &[u8],
            now: UnixTime,
        ) -> std::result::Result<ServerCertVerified, rustls::Error> {
            // webpki checks the chain before the name, so a name error means the chain passed.
            match self.0.verify_server_cert(
                end_entity,
                intermediates,
                server_name,
                ocsp_response,
                now,
            ) {
                Err(rustls::Error::InvalidCertificate(
                    CertificateError::NotValidForName
                    | CertificateError::NotValidForNameContext { .. },
                )) => Ok(ServerCertVerified::assertion()),
                other => other,
            }
        }

        fn verify_tls12_signature(
            &self,
            message: &[u8],
            cert: &CertificateDer<'_>,
            dss: &DigitallySignedStruct,
        ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
            self.0.verify_tls12_signature(message, cert, dss)
        }

        fn verify_tls13_signature(
            &self,
            message: &[u8],
            cert: &CertificateDer<'_>,
            dss: &DigitallySignedStruct,
        ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
            self.0.verify_tls13_signature(message, cert, dss)
        }

        fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
            self.0.supported_verify_schemes()
        }
    }
}

#[async_trait::async_trait]
impl Dialect for PostgresDialect {
    async fn server_version(&self) -> Result<String> {
        let client = self.client(&self.default_database).await?;
        let row = client
            .query_one("SHOW server_version", &[])
            .await
            .map_err(query_err)?;
        let version: String = row.try_get(0).map_err(query_err)?;
        Ok(version_number(&version).to_string())
    }

    async fn list_databases(&self) -> Result<Vec<String>> {
        let client = self.client(&self.default_database).await?;
        introspect::list_databases(&client).await
    }

    async fn list_schemas(&self, database: &str) -> Result<Vec<SchemaInfo>> {
        let client = self.client(database).await?;
        introspect::list_schemas(&client).await
    }

    async fn list_objects(&self, database: &str, schema: Option<&str>) -> Result<Vec<DbObject>> {
        let client = self.client(database).await?;
        introspect::list_objects(&client, schema).await
    }

    async fn object_definition(&self, kind: ObjectKind, path: &ObjectPath) -> Result<String> {
        let client = self.client(&path.database).await?;
        introspect::definition(&client, kind, path).await
    }

    async fn fetch_page(&self, req: &PageRequest) -> Result<Page> {
        let client = self.client(&req.table.database).await?;
        page::fetch_page(&client, req).await
    }

    async fn fetch_full_value(&self, req: &FullValueRequest) -> Result<FullValue> {
        let client = self.client(&req.table.database).await?;
        page::fetch_full_value(&client, req).await
    }

    async fn disconnect(&self) -> Result<()> {
        // Dropping a client ends its connection task.
        self.clients.lock().map_err(|_| poisoned())?.clear();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_number_drops_the_build_note() {
        assert_eq!(version_number("16.4 (Debian 16.4-1)"), "16.4");
        assert_eq!(version_number("17.0"), "17.0");
    }

    #[test]
    fn ca_file_without_certificates_is_invalid_input() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ca.pem");
        std::fs::write(&path, "not a certificate").unwrap();
        match tls::trust_only_ca(&path) {
            Err(Error::InvalidInput(m)) => assert_eq!(
                m,
                format!(
                    "cannot read CA file {}: no certificates found",
                    path.display()
                )
            ),
            Err(other) => panic!("got {other:?}"),
            Ok(_) => panic!("expected an error"),
        }
    }
}
