//! WebKitGTK 2.53.0 to 2.54.1 crash the UI process on any paste (Ctrl+V, middle-click, the
//! context menu, `navigator.clipboard.readText()`) while the X selection has no owner:
//! `Clipboard::formats()` reads a null target list (bugs.webkit.org/show_bug.cgi?id=324466,
//! fixed in 2.54.2). On those versions Contura takes CLIPBOARD and PRIMARY with an empty
//! text offer whenever nobody owns them, so WebKit always gets a target list. Anyone else
//! taking the selection replaces the offer. Remove this module once the distros Contura
//! supports ship 2.54.2.

use std::cell::Cell;
use std::rc::Rc;
use std::time::Duration;

use gtk::{gdk, glib, prelude::*};

/// How long an ownerless selection waits before Contura takes it: a clipboard manager
/// restoring the last copy after its owner quit gets there first.
const CLAIM_DELAY: Duration = Duration::from_millis(200);

/// The WebKitGTK versions with the crash: 2.53.x (the 2.54 previews), 2.54.0 and 2.54.1.
fn affected(major: u32, minor: u32, micro: u32) -> bool {
    major == 2 && (minor == 53 || (minor == 54 && micro < 2))
}

/// The owner changes of one selection. Losing its owner hands out a ticket to check it
/// later; any change after that, Contura's own claim too, makes the ticket stale.
#[derive(Default)]
struct Watch {
    changes: Cell<u64>,
}

impl Watch {
    /// The owner changed: a ticket when nobody (or nobody known, on Wayland) owns it now.
    fn changed(&self, has_owner: bool) -> Option<u64> {
        self.changes.set(self.changes.get() + 1);
        (!has_owner).then(|| self.changes.get())
    }

    /// No change since the ticket was handed out.
    fn current(&self, ticket: u64) -> bool {
        self.changes.get() == ticket
    }
}

/// Takes the selection with an empty text offer when it offers no targets. Asked
/// asynchronously: no nested main loop, and an ownerless selection answers at once.
fn claim_if_empty(clipboard: &gtk::Clipboard, watch: Rc<Watch>, ticket: u64) {
    clipboard.request_contents(&gdk::Atom::intern("TARGETS"), move |clipboard, data| {
        let empty = data.targets().is_none_or(|targets| targets.is_empty());
        if empty && watch.current(ticket) {
            clipboard.set_text("");
        }
    });
}

fn guard(selection: &gdk::Atom) {
    let clipboard = gtk::Clipboard::get(selection);
    let watch = Rc::new(Watch::default());
    clipboard.connect_local("owner-change", false, {
        let (clipboard, watch) = (clipboard.clone(), watch.clone());
        move |args| {
            // X11 names the new owner. Wayland names none for other apps: the targets decide.
            let has_owner = args
                .get(1)
                .and_then(|v| v.get::<gdk::Event>().ok())
                .and_then(|e| e.downcast::<gdk::EventOwnerChange>().ok())
                .is_some_and(|e| e.owner().is_some());
            if let Some(ticket) = watch.changed(has_owner) {
                let (clipboard, watch) = (clipboard.clone(), watch.clone());
                glib::timeout_add_local_once(CLAIM_DELAY, move || {
                    if watch.current(ticket) {
                        claim_if_empty(&clipboard, watch, ticket);
                    }
                });
            }
            None
        }
    });
    // Empty at start-up when nothing has been copied in this session yet.
    let ticket = watch.changed(false).unwrap_or_default();
    claim_if_empty(&clipboard, watch, ticket);
}

/// Keeps CLIPBOARD and PRIMARY owned on a WebKitGTK with the crash; does nothing on others.
pub fn install(window: &tauri::WebviewWindow) {
    // SAFETY: plain getters for the linked library's version.
    let version = unsafe {
        (
            webkit2gtk::ffi::webkit_get_major_version(),
            webkit2gtk::ffi::webkit_get_minor_version(),
            webkit2gtk::ffi::webkit_get_micro_version(),
        )
    };
    if !affected(version.0, version.1, version.2) {
        return;
    }
    let _ = window.run_on_main_thread(|| {
        guard(&gdk::SELECTION_CLIPBOARD);
        guard(&gdk::SELECTION_PRIMARY);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_2_53_to_2_54_1_crash() {
        assert!(affected(2, 53, 90));
        assert!(affected(2, 54, 0));
        assert!(affected(2, 54, 1));
        assert!(!affected(2, 54, 2));
        assert!(!affected(2, 52, 6));
        assert!(!affected(2, 56, 0));
    }

    #[test]
    fn a_new_owner_needs_no_check() {
        let watch = Watch::default();
        assert_eq!(watch.changed(true), None);
    }

    #[test]
    fn losing_the_owner_is_checked_while_nothing_else_changes() {
        let watch = Watch::default();
        let ticket = watch.changed(false).unwrap();
        assert!(watch.current(ticket));
    }

    #[test]
    fn an_owner_arriving_first_cancels_the_check() {
        // A clipboard manager restores the last copy before the delay ends.
        let watch = Watch::default();
        let ticket = watch.changed(false).unwrap();
        assert_eq!(watch.changed(true), None);
        assert!(!watch.current(ticket));
    }

    #[test]
    fn only_the_latest_loss_is_checked() {
        let watch = Watch::default();
        let first = watch.changed(false).unwrap();
        let second = watch.changed(false).unwrap();
        assert!(!watch.current(first));
        assert!(watch.current(second));
    }
}
