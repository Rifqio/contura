//! A scripted HTTP/1.1 server on 127.0.0.1 for the AI client tests: one connection
//! per reply, closed after it, so every request the client makes is seen.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

pub struct MockReply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    /// Each chunk is written after its delay.
    pub chunks: Vec<(Duration, Vec<u8>)>,
    /// Promise more body than is sent, then close: the client sees a cut-off body.
    pub close_early: bool,
}

impl MockReply {
    pub fn new(status: u16, body: &[u8]) -> Self {
        Self {
            status,
            headers: Vec::new(),
            chunks: vec![(Duration::ZERO, body.to_vec())],
            close_early: false,
        }
    }

    pub fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }
}

/// Serves `script` in order, one reply per connection, and returns each request: its
/// head, then its body.
pub async fn serve(script: Vec<MockReply>) -> (url::Url, JoinHandle<Vec<String>>) {
    let (url, handle, _seen) = serve_seen(script).await;
    (url, handle)
}

/// As `serve`, plus the requests seen so far, readable while the server still waits.
pub async fn serve_seen(
    script: Vec<MockReply>,
) -> (url::Url, JoinHandle<Vec<String>>, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let url = url::Url::parse(&format!("http://127.0.0.1:{port}/v1")).unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    let handle = tokio::spawn(async move {
        for reply in script {
            let (mut sock, _) = listener.accept().await.unwrap();
            let request = read_request(&mut sock).await;
            log.lock().unwrap().push(request);
            write_reply(&mut sock, reply).await;
        }
        log.lock().unwrap().clone()
    });
    (url, handle, seen)
}

async fn read_request(sock: &mut TcpStream) -> String {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    let head_end = loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
        let n = sock.read(&mut tmp).await.unwrap();
        if n == 0 {
            break buf.len();
        }
        buf.extend_from_slice(&tmp[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    let len = head
        .lines()
        .find_map(|l| {
            let (k, v) = l.split_once(':')?;
            k.eq_ignore_ascii_case("content-length")
                .then(|| v.trim().parse::<usize>().ok())?
        })
        .unwrap_or(0);
    while buf.len() - head_end < len {
        let n = sock.read(&mut tmp).await.unwrap();
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&tmp[..n]);
    }
    let body = String::from_utf8_lossy(&buf[head_end..]);
    format!("{head}{body}")
}

async fn write_reply(sock: &mut TcpStream, reply: MockReply) {
    let total: usize = reply.chunks.iter().map(|(_, c)| c.len()).sum();
    let mut head = format!("HTTP/1.1 {} X\r\nconnection: close\r\n", reply.status);
    for (k, v) in &reply.headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    if reply.close_early {
        head.push_str(&format!("content-length: {}\r\n", total + 100));
    }
    head.push_str("\r\n");
    if sock.write_all(head.as_bytes()).await.is_err() {
        return;
    }
    for (delay, chunk) in reply.chunks {
        tokio::time::sleep(delay).await;
        if sock.write_all(&chunk).await.is_err() || sock.flush().await.is_err() {
            return;
        }
    }
    let _ = sock.shutdown().await;
}
