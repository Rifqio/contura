//! How one MySQL Connection opens its connections. Preferred SSL (security audit M2):
//! every new connection, pooled or not, asks for TLS first, and only an attempt whose
//! server greeting has no TLS goes on in plain text. The next new connection asks
//! again, so one stripped greeting never makes the whole session plain. The greeting
//! comes before the sign-in, so the TLS attempt sends no credentials; a TLS failure on
//! a server that offers TLS is an error, never a fall back.

use mysql_async::{Conn, DriverError, Error as MyError, OptsBuilder};

/// Whether `e` says the server's greeting offers no TLS.
fn no_tls(e: &MyError) -> bool {
    matches!(e, MyError::Driver(DriverError::NoClientSslFlagFromServer))
}

/// The options of one Connection, and whether it is Preferred.
#[derive(Clone)]
pub(crate) struct Opts {
    tls: OptsBuilder,
    prefer: bool,
}

impl Opts {
    pub(crate) fn new(opts: OptsBuilder, prefer: bool) -> Opts {
        Opts { tls: opts, prefer }
    }

    /// The same options changed by `f`, on both the TLS and the plain attempt.
    pub(crate) fn with(&self, f: impl FnOnce(OptsBuilder) -> OptsBuilder) -> Opts {
        Opts {
            tls: f(self.tls.clone()),
            prefer: self.prefer,
        }
    }

    fn plain(&self) -> Option<OptsBuilder> {
        self.prefer.then(|| self.tls.clone().ssl_opts(None))
    }

    /// A new connection outside the pool.
    pub(crate) async fn conn(&self) -> Result<Conn, MyError> {
        match Conn::new(self.tls.clone()).await {
            Err(e) if no_tls(&e) => match self.plain() {
                Some(plain) => Conn::new(plain).await,
                None => Err(e),
            },
            got => got,
        }
    }
}

/// The browse pool. For Preferred a second pool holds the plain connections; a checkout
/// tries the TLS pool first every time.
#[derive(Clone)]
pub(crate) struct Pool {
    tls: mysql_async::Pool,
    plain: Option<mysql_async::Pool>,
}

impl Pool {
    pub(crate) fn new(opts: &Opts) -> Pool {
        Pool {
            tls: mysql_async::Pool::new(opts.tls.clone()),
            plain: opts.plain().map(mysql_async::Pool::new),
        }
    }

    pub(crate) async fn get_conn(&self) -> Result<Conn, MyError> {
        match self.tls.get_conn().await {
            Err(e) if no_tls(&e) => match &self.plain {
                Some(plain) => plain.get_conn().await,
                None => Err(e),
            },
            got => got,
        }
    }

    pub(crate) async fn disconnect(self) -> Result<(), MyError> {
        let tls = self.tls.disconnect().await;
        if let Some(plain) = self.plain {
            plain.disconnect().await?;
        }
        tls
    }
}
