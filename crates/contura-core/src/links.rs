//! Links Contura opens in the system browser, such as an icon set's source in Icon credits.
//! The text comes from data Contura did not write, so only a plain https address passes:
//! no other scheme, no user name or password, no control characters, and a host.

use crate::error::Error;

/// The longest address Contura opens.
const MAX_URL: usize = 2048;

/// `text` as a normalised https URL when it is safe to hand to the system browser, else an
/// `InvalidInput` saying why.
pub fn safe_https_url(text: &str) -> Result<String, Error> {
    let refuse = |why: &str| Err(Error::InvalidInput(why.to_string()));
    if text.len() > MAX_URL {
        return refuse("This link is too long to open.");
    }
    // The URL parser trims and drops spaces, tabs and line breaks; refuse them instead, so
    // what opens is exactly what was checked.
    if text.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return refuse("This link has spaces or control characters, so Contura won't open it.");
    }
    let Ok(url) = url::Url::parse(text) else {
        return refuse("Contura opens only https links.");
    };
    if url.scheme() != "https" {
        return refuse("Contura opens only https links.");
    }
    if !url.username().is_empty() || url.password().is_some() {
        return refuse("This link carries a user name or password, so Contura won't open it.");
    }
    if url.host_str().is_none_or(str::is_empty) {
        return refuse("Contura opens only https links.");
    }
    let out = url.as_str();
    if out.len() > MAX_URL {
        return refuse("This link is too long to open.");
    }
    Ok(out.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn https_addresses_pass_normalised() {
        assert_eq!(
            safe_https_url("https://lucide.dev").unwrap(),
            "https://lucide.dev/"
        );
        assert_eq!(
            safe_https_url("https://aws.amazon.com/architecture/icons/").unwrap(),
            "https://aws.amazon.com/architecture/icons/"
        );
        assert_eq!(
            safe_https_url("HTTPS://Example.COM/a?q=1#x").unwrap(),
            "https://example.com/a?q=1#x"
        );
    }

    #[test]
    fn other_schemes_are_refused() {
        for bad in [
            "http://lucide.dev",
            "javascript:alert(1)",
            "file:///C:/Windows/System32/calc.exe",
            "ms-settings:",
            "data:text/html,<b>x</b>",
            "mailto:a@b.c",
            "\\\\server\\share\\x.exe",
            "C:\\Windows\\notepad.exe",
            "//lucide.dev",
            "lucide.dev",
            "",
        ] {
            assert!(safe_https_url(bad).is_err(), "{bad} passed");
        }
    }

    #[test]
    fn credentials_and_odd_characters_are_refused() {
        for bad in [
            "https://user@lucide.dev",
            "https://user:pass@lucide.dev",
            "https://:pass@lucide.dev",
            " https://lucide.dev",
            "https://lucide.dev\n",
            "https://lucide.dev/\u{0}x",
            "https://lucide.dev/\tx",
            "https://",
        ] {
            assert!(safe_https_url(bad).is_err(), "{bad:?} passed");
        }
        let long = format!("https://lucide.dev/{}", "a".repeat(MAX_URL));
        assert!(safe_https_url(&long).is_err());
    }

    #[test]
    fn what_reaches_the_shell_is_the_normalised_form() {
        // A backslash form is read as https and written with slashes.
        assert_eq!(
            safe_https_url("https:\\\\lucide.dev").unwrap(),
            "https://lucide.dev/"
        );
        // A quote or an angle bracket comes back percent-encoded, so no browser command line
        // splits on it.
        assert_eq!(
            safe_https_url("https://lucide.dev/a\"b<c>d").unwrap(),
            "https://lucide.dev/a%22b%3Cc%3Ed"
        );
        // An international host becomes punycode.
        assert_eq!(
            safe_https_url("https://bücher.example/").unwrap(),
            "https://xn--bcher-kva.example/"
        );
    }

    #[test]
    fn unicode_spaces_and_direction_marks_are_refused() {
        for bad in [
            "https://lucide.dev/\u{a0}x",
            "https://lucide.dev/\u{3000}x",
            "https://lucide.dev/\u{2028}x",
            "https://lucide\u{202e}.dev/",
        ] {
            assert!(safe_https_url(bad).is_err(), "{bad:?} passed");
        }
    }

    #[test]
    fn the_refusal_is_plain_invalid_input() {
        match safe_https_url("http://lucide.dev") {
            Err(Error::InvalidInput(m)) => assert_eq!(m, "Contura opens only https links."),
            other => panic!("unexpected {other:?}"),
        }
    }
}
