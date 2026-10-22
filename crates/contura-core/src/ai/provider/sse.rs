//! Server-sent events, split into events however the bytes arrive.

use crate::ai::AiError;

/// The longest line kept while waiting for its newline, and the most `data` one event holds.
const MAX_LINE_BYTES: usize = 1024 * 1024;

/// One event: its `event:` name, if any, and its `data:` lines joined with `\n`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SseEvent {
    pub event: Option<String>,
    pub data: String,
}

/// Keeps raw bytes until a line is complete, so a read that splits a line or a
/// multi-byte character never garbles text.
#[derive(Default)]
pub struct SseParser {
    buf: Vec<u8>,
    event: Option<String>,
    data: Option<String>,
    /// How much of `buf` is already known to hold no newline, so each byte is scanned once.
    scanned: usize,
    /// A line or an event's data went past `MAX_LINE_BYTES`; nothing more is read.
    overflowed: bool,
}

impl SseParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// The events completed by `bytes`. A line still unfinished past 1 MiB is
    /// `BadResponse`, and so is every later push: the buffer is dropped, not grown.
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<SseEvent>, AiError> {
        if self.overflowed {
            return Err(AiError::BadResponse);
        }
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        let mut start = 0;
        let mut from = self.scanned;
        while let Some(n) = self.buf[from..].iter().position(|&b| b == b'\n') {
            let end = from + n;
            let line = self.buf[start..end]
                .strip_suffix(b"\r")
                .unwrap_or(&self.buf[start..end]);
            // A whole line never splits a character, so decoding here is safe.
            let line = String::from_utf8_lossy(line).into_owned();
            start = end + 1;
            from = start;
            if let Some(event) = self.line(&line) {
                out.push(event);
            }
            if self.data.as_ref().is_some_and(|d| d.len() > MAX_LINE_BYTES) {
                return Err(self.overflow());
            }
        }
        self.buf.drain(..start);
        self.scanned = self.buf.len();
        if self.buf.len() > MAX_LINE_BYTES {
            return Err(self.overflow());
        }
        Ok(out)
    }

    /// The event left pending when the body ends: a last line with no newline, then any
    /// data with no blank line after it.
    pub fn finish(&mut self) -> Result<Option<SseEvent>, AiError> {
        if self.overflowed {
            return Err(AiError::BadResponse);
        }
        let rest = std::mem::take(&mut self.buf);
        self.scanned = 0;
        let rest = rest.strip_suffix(b"\r").unwrap_or(&rest);
        if !rest.is_empty() {
            // A field line never completes an event by itself.
            self.line(&String::from_utf8_lossy(rest));
        }
        Ok(self.line(""))
    }

    /// Drops everything kept; this and every later push is `BadResponse`.
    fn overflow(&mut self) -> AiError {
        self.overflowed = true;
        self.buf = Vec::new();
        self.scanned = 0;
        self.data = None;
        AiError::BadResponse
    }

    fn line(&mut self, line: &str) -> Option<SseEvent> {
        if line.is_empty() {
            let event = self.event.take();
            return self.data.take().map(|data| SseEvent { event, data });
        }
        if line.starts_with(':') {
            return None;
        }
        let (field, value) = match line.split_once(':') {
            Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
            None => (line, ""),
        };
        match field {
            "data" => match &mut self.data {
                Some(data) => {
                    data.push('\n');
                    data.push_str(value);
                }
                None => self.data = Some(value.to_string()),
            },
            "event" => self.event = Some(value.to_string()),
            _ => {}
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data(event: Option<&str>, data: &str) -> SseEvent {
        SseEvent {
            event: event.map(str::to_string),
            data: data.into(),
        }
    }

    #[test]
    fn sse_basic_event() {
        let mut p = SseParser::new();
        let out = p
            .push(b"event: delta\ndata: {\"a\":1}\n\ndata: next\n")
            .unwrap();
        assert_eq!(out, vec![data(Some("delta"), "{\"a\":1}")]);
        assert_eq!(p.push(b"\n").unwrap(), vec![data(None, "next")]);
    }

    #[test]
    fn sse_multi_data_lines_join() {
        let mut p = SseParser::new();
        let out = p.push(b"data: one\ndata:two\ndata:  three\n\n").unwrap();
        assert_eq!(out, vec![data(None, "one\ntwo\n three")]);
    }

    #[test]
    fn sse_comments_and_keepalive_ignored() {
        let mut p = SseParser::new();
        let out = p
            .push(b": OPENROUTER PROCESSING\n\n:\n\ndata: [DONE]\n\n")
            .unwrap();
        assert_eq!(out, vec![data(None, "[DONE]")]);
    }

    #[test]
    fn split_mid_char_and_mid_line() {
        let text = "こんにちは🙂";
        let bytes = format!("data: {text}\n\n").into_bytes();
        let mut p = SseParser::new();
        let mut out = Vec::new();
        for b in &bytes {
            out.extend(p.push(std::slice::from_ref(b)).unwrap());
        }
        assert_eq!(out, vec![data(None, text)]);
    }

    #[test]
    fn crlf_lines() {
        let mut p = SseParser::new();
        let out = p
            .push(b"event: message_stop\r\ndata: {}\r\n\r\ndata: x\r")
            .unwrap();
        assert_eq!(out, vec![data(Some("message_stop"), "{}")]);
        assert_eq!(p.push(b"\n\r\n").unwrap(), vec![data(None, "x")]);
    }

    #[test]
    fn sse_line_over_cap_is_bad_response() {
        let mut p = SseParser::new();
        let chunk = vec![b'a'; 64 * 1024];
        for _ in 0..16 {
            assert!(p.push(&chunk).unwrap().is_empty());
        }
        // Exactly 1 MiB pending is still allowed; one byte more is not.
        assert_eq!(p.push(b"a"), Err(AiError::BadResponse));
        assert!(p.buf.is_empty());
        assert_eq!(p.push(b"\n\n"), Err(AiError::BadResponse));
        assert!(p.buf.is_empty());
    }

    #[test]
    fn sse_finish_flushes_last_event() {
        let mut p = SseParser::new();
        assert!(
            p.push(b"event: message_stop\ndata: {\"a\":1}")
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            p.finish().unwrap(),
            Some(data(Some("message_stop"), "{\"a\":1}"))
        );
        assert_eq!(p.finish().unwrap(), None);

        // A last line ended by a newline but no blank line.
        let mut p = SseParser::new();
        assert!(p.push(b"data: x\r\n").unwrap().is_empty());
        assert_eq!(p.finish().unwrap(), Some(data(None, "x")));

        // Nothing pending.
        let mut p = SseParser::new();
        p.push(b"data: x\n\n").unwrap();
        assert_eq!(p.finish().unwrap(), None);
    }

    #[test]
    fn sse_data_over_cap_is_bad_response() {
        let mut p = SseParser::new();
        let line = format!("data: {}\n", "a".repeat(64 * 1024));
        for _ in 0..15 {
            assert!(p.push(line.as_bytes()).unwrap().is_empty());
        }
        // A 16th line of 64 KiB, with the joins, takes the data just over 1 MiB.
        assert_eq!(p.push(line.as_bytes()), Err(AiError::BadResponse));
        assert_eq!(p.data, None);
        assert_eq!(p.push(b"\n"), Err(AiError::BadResponse));
        assert_eq!(p.finish(), Err(AiError::BadResponse));
    }

    #[test]
    fn sse_long_line_scanned_once() {
        // 2 MiB in 1-byte pieces: each push scans only its own byte, so this is quick,
        // and the 1 MiB cap still ends the line.
        let started = std::time::Instant::now();
        let mut p = SseParser::new();
        let mut refused = 0;
        for _ in 0..2 * 1024 * 1024 {
            if p.push(b"a").is_err() {
                refused += 1;
            }
        }
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
        assert_eq!(refused, 1024 * 1024);
        assert!(p.buf.is_empty());
    }

    #[test]
    fn sse_scan_offset_finds_a_later_newline() {
        let mut p = SseParser::new();
        assert!(p.push(b"data: ab").unwrap().is_empty());
        assert!(p.push(b"c").unwrap().is_empty());
        assert!(
            p.push(
                b"
"
            )
            .unwrap()
            .is_empty()
        );
        assert_eq!(
            p.push(
                b"data: d

"
            )
            .unwrap(),
            vec![data(
                None, "abc
d"
            )]
        );
    }
}
