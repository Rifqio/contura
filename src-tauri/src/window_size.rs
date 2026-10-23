use std::sync::Mutex;

use contura_core::model::InterfaceSize;
use tauri::{LogicalSize, PhysicalPosition, PhysicalSize};

/// The size the main window opens at, in CSS pixels: the design frames draw 1280 x 800.
pub const START_WIDTH: f64 = 1280.0;
pub const START_HEIGHT: f64 = 800.0;

/// The opening client size in physical pixels: 1280 x 800 CSS pixels, shrunk to fit a work
/// area of `work_width` x `work_height` physical pixels.
///
/// One CSS pixel is `scale * text_scale` physical pixels in the page: `scale` is the
/// monitor's display scaling (1.25 at 125 percent) and `text_scale` is Windows'
/// Accessibility > Text size (1.24 at 124 percent), which WebView2 also applies to
/// `devicePixelRatio` although the window's own scale factor stays at the display's.
pub fn start_size(work_width: u32, work_height: u32, scale: f64, text_scale: f64) -> (u32, u32) {
    let css = sane(scale) * sane(text_scale);
    let fit = |want: f64, room: u32| ((want * css).round() as u32).min(room);
    (fit(START_WIDTH, work_width), fit(START_HEIGHT, work_height))
}

/// The smallest window in CSS pixels, as tauri.conf.json's `minWidth` and `minHeight`.
pub const MIN_WIDTH: f64 = 1024.0;
pub const MIN_HEIGHT: f64 = 480.0;

/// The minimum window size in logical pixels: 1024 x 480 CSS pixels at any Windows Text
/// size and Interface size.
///
/// The window's logical pixels follow display scaling only, while WebView2 also divides
/// the CSS viewport by `text_scale`, and the webview zoom (Interface size, `zoom`) divides
/// it again: 1024 x 480 logical is 826 x 387 CSS pixels at Text size 124 percent and
/// 819 x 384 at Interface size 125 percent. Multiplying by both keeps 1024 x 480 CSS
/// pixels. The result is clamped to the work area (`work_width` x `work_height` physical
/// pixels at `scale`), but never below the config's minimum, so Interface size 90 percent
/// keeps it too.
pub fn min_size(
    work_width: u32,
    work_height: u32,
    scale: f64,
    text_scale: f64,
    zoom: f64,
) -> (f64, f64) {
    let factor = sane(text_scale) * sane(zoom);
    let scale = sane(scale);
    let fit = |min: f64, room: u32| (min * factor).min(f64::from(room) / scale).max(min);
    (fit(MIN_WIDTH, work_width), fit(MIN_HEIGHT, work_height))
}

/// The logical size a window of `inner` logical pixels grows to so it is not under `min`,
/// or `None` when it already holds (half a pixel under counts as holding: rounding).
pub fn grown(inner: (f64, f64), min: (f64, f64)) -> Option<(f64, f64)> {
    let short = |have: f64, want: f64| have + 0.5 < want;
    if !short(inner.0, min.0) && !short(inner.1, min.1) {
        return None;
    }
    Some((inner.0.max(min.0), inner.1.max(min.1)))
}

/// The top-left (physical pixels) that keeps a window of `outer` size on the work area at
/// `work_pos` with size `work`, moving it as little as possible; `None` when it already
/// fits. A window wider or taller than the work area keeps its left or top edge on it.
pub fn kept_on_screen(
    pos: (i32, i32),
    outer: (u32, u32),
    work_pos: (i32, i32),
    work: (u32, u32),
) -> Option<(i32, i32)> {
    let axis = |at: i32, size: u32, start: i32, room: u32| {
        let end = i64::from(start) + i64::from(room) - i64::from(size);
        (i64::from(at).min(end).max(i64::from(start))) as i32
    };
    let next = (
        axis(pos.0, outer.0, work_pos.0, work.0),
        axis(pos.1, outer.1, work_pos.1, work.1),
    );
    (next != pos).then_some(next)
}

/// What the window was last given, so a refit that changes nothing makes no window call.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct FitState {
    /// The minimum last set on the window (logical px).
    pub applied: Option<(f64, f64)>,
    /// The size last asked for to grow the window to the minimum. A window manager that
    /// keeps the window smaller (a tiling one) is not asked again until the minimum changes.
    pub asked: Option<(f64, f64)>,
}

/// The window calls one refit makes, and the state after them.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Plan {
    pub set_min: bool,
    pub grow_to: Option<(f64, f64)>,
    pub next: FitState,
}

/// Decides a refit. `busy` is a maximized, full screen or minimized window: on Windows,
/// tao's `set_min_inner_size` re-applies the window size, which restores a maximized
/// window, so a busy window gets no call at all and the minimum stays pending until a
/// later refit (the `Resized` a restore sends). `inner` is the client size in logical px,
/// when known.
pub fn plan(state: FitState, min: (f64, f64), busy: bool, inner: Option<(f64, f64)>) -> Plan {
    if busy {
        return Plan {
            set_min: false,
            grow_to: None,
            next: state,
        };
    }
    let set_min = state.applied != Some(min);
    let asked = if set_min { None } else { state.asked };
    let grow_to = inner
        .and_then(|inner| grown(inner, min))
        .filter(|&target| asked != Some(target));
    Plan {
        set_min,
        grow_to,
        next: FitState {
            applied: Some(min),
            asked: grow_to.or(asked),
        },
    }
}

/// The interface size's zoom and what the window was last given.
#[derive(Default)]
pub struct WindowFit {
    zoom: Mutex<f64>,
    state: Mutex<FitState>,
}

impl WindowFit {
    /// At start: the saved zoom, and the minimum already set on the builder.
    pub fn new(zoom: f64, applied: Option<(f64, f64)>) -> Self {
        Self {
            zoom: Mutex::new(sane(zoom)),
            state: Mutex::new(FitState {
                applied,
                asked: None,
            }),
        }
    }

    fn zoom(&self) -> f64 {
        *self.zoom.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// How far a refit may change the window besides its minimum.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Refit {
    /// Grow a window that is under the new minimum (a move to another monitor, a restore
    /// from maximized, focus after Windows Text size changed).
    Grow,
    /// Grow, then move the window back onto the work area if growing pushed it off (an
    /// Interface size change, which the user makes on purpose).
    GrowAndKeepOnScreen,
}

/// Recomputes the minimum for the monitor the window is on, today's Windows Text size and
/// the interface size, sets it when it changed, and grows the window to it when smaller
/// (see `plan`). A maximized, full screen or minimized window is not touched at all.
pub fn refit(window: &tauri::Window, fit: &WindowFit, how: Refit) {
    let Some(monitor) = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())
    else {
        return;
    };
    let area = *monitor.work_area();
    let scale = monitor.scale_factor();
    let min = min_size(
        area.size.width,
        area.size.height,
        scale,
        text_scale(),
        fit.zoom(),
    );
    let busy = |r: tauri::Result<bool>| r.unwrap_or(true);
    let busy =
        busy(window.is_maximized()) || busy(window.is_fullscreen()) || busy(window.is_minimized());
    let factor = window.scale_factor().unwrap_or(scale);
    let inner_physical = window.inner_size().ok();
    let inner = inner_physical.map(|i| {
        let l: LogicalSize<f64> = i.to_logical(factor);
        (l.width, l.height)
    });
    let step = {
        let mut state = fit.state.lock().unwrap_or_else(|e| e.into_inner());
        let step = plan(*state, min, busy, inner);
        *state = step.next;
        step
    };
    if step.set_min {
        let _ = window.set_min_size(Some(LogicalSize::new(min.0, min.1)));
    }
    let (Some((width, height)), Some(inner_physical)) = (step.grow_to, inner_physical) else {
        return;
    };
    // Read before the resize: the window system applies it later, so the outer size read
    // after it may still be the old one.
    let before = window.outer_position().ok().zip(window.outer_size().ok());
    let _ = window.set_size(LogicalSize::new(width, height));
    if how != Refit::GrowAndKeepOnScreen {
        return;
    }
    if let Some((pos, outer)) = before {
        let target: PhysicalSize<u32> = LogicalSize::new(width, height).to_physical(factor);
        let outer = outer_after_resize(
            (outer.width, outer.height),
            (inner_physical.width, inner_physical.height),
            (target.width, target.height),
        );
        if let Some((x, y)) = kept_on_screen(
            (pos.x, pos.y),
            outer,
            (area.position.x, area.position.y),
            (area.size.width, area.size.height),
        ) {
            let _ = window.set_position(PhysicalPosition::new(x, y));
        }
    }
}

/// The outer size once the client area is `inner_after`: the frame around it (outer minus
/// inner now) stays as it is. All physical pixels.
pub fn outer_after_resize(
    outer: (u32, u32),
    inner: (u32, u32),
    inner_after: (u32, u32),
) -> (u32, u32) {
    let frame = |o: u32, i: u32| o.saturating_sub(i);
    (
        inner_after.0 + frame(outer.0, inner.0),
        inner_after.1 + frame(outer.1, inner.1),
    )
}

/// Settings, Appearance, Interface size: fits the window's minimum to the new size (growing
/// the window first when it is under it, so the page never gets under 1024 x 480 CSS
/// pixels), then zooms the webview. A maximized window zooms at once; its minimum waits for
/// the restore.
#[tauri::command]
pub fn set_interface_size(
    window: tauri::WebviewWindow,
    fit: tauri::State<'_, WindowFit>,
    size: u32,
) {
    let zoom = InterfaceSize(size).zoom();
    *fit.zoom.lock().unwrap_or_else(|e| e.into_inner()) = zoom;
    refit(&window.as_ref().window(), &fit, Refit::GrowAndKeepOnScreen);
    let _ = window.set_zoom(zoom);
}

fn sane(factor: f64) -> f64 {
    if factor.is_finite() && factor > 0.0 {
        factor
    } else {
        1.0
    }
}

/// Windows stores Text size as a percent from 100 to 225; anything else counts as 100.
pub fn text_scale_from_percent(percent: Option<u32>) -> f64 {
    match percent {
        Some(p @ 100..=225) => f64::from(p) / 100.0,
        _ => 1.0,
    }
}

/// Windows' Accessibility > Text size as a factor (1.0 when unset or off Windows).
pub fn text_scale() -> f64 {
    text_scale_from_percent(text_scale_percent())
}

#[cfg(windows)]
fn text_scale_percent() -> Option<u32> {
    use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RegGetValueW};
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let key = wide("Software\\Microsoft\\Accessibility");
    let name = wide("TextScaleFactor");
    let mut value: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;
    // SAFETY: both strings are NUL-terminated and outlive the call; `value` holds the
    // DWORD that RRF_RT_REG_DWORD limits the read to, and `size` says so.
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            (&mut value as *mut u32).cast(),
            &mut size,
        )
    };
    (status == 0).then_some(value)
}

#[cfg(not(windows))]
fn text_scale_percent() -> Option<u32> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_size_when_the_work_area_is_large_enough() {
        assert_eq!(start_size(1920, 1040, 1.0, 1.0), (1280, 800));
        // 124 percent display scaling: 1587.2 x 992 physical.
        assert_eq!(start_size(1920, 1040, 1.24, 1.0), (1587, 992));
    }

    #[test]
    fn text_size_counts_like_display_scaling() {
        // 100 percent display, 124 percent Text size: the page's devicePixelRatio is 1.24.
        assert_eq!(start_size(1920, 1080, 1.0, 1.24), (1587, 992));
        // Both: 125 percent display and 120 percent Text size is 1.5 physical per CSS pixel.
        assert_eq!(start_size(2560, 1400, 1.25, 1.2), (1920, 1200));
    }

    #[test]
    fn clamps_to_the_work_area() {
        // 1366 x 728 at 125 percent wants 1600 x 1000.
        assert_eq!(start_size(1366, 728, 1.25, 1.0), (1366, 728));
        // 2560 x 1400 at 200 percent wants 2560 x 1600.
        assert_eq!(start_size(2560, 1400, 2.0, 1.0), (2560, 1400));
    }

    #[test]
    fn a_bad_factor_counts_as_one() {
        assert_eq!(start_size(1920, 1080, 0.0, 1.0), (1280, 800));
        assert_eq!(start_size(1920, 1080, f64::NAN, f64::INFINITY), (1280, 800));
    }

    #[test]
    fn min_size_follows_text_size() {
        // 124 percent Text size on a 1920 x 1040 work area at 100 percent display.
        let (w, h) = min_size(1920, 1040, 1.0, 1.24, 1.0);
        assert!((w - 1269.76).abs() < 1e-9 && (h - 595.2).abs() < 1e-9);
        // Display scaling leaves logical pixels alone: 150 percent on 2880 x 1560 is 1920 x 1040.
        assert_eq!(min_size(2880, 1560, 1.5, 1.5, 1.0), (1536.0, 720.0));
    }

    #[test]
    fn min_size_is_the_config_at_normal_text_and_interface_size() {
        assert_eq!(min_size(1920, 1040, 1.0, 1.0, 1.0), (1024.0, 480.0));
        assert_eq!(min_size(1920, 1040, 1.25, 1.0, 1.0), (1024.0, 480.0));
        assert_eq!(
            min_size(1920, 1040, 1.0, f64::NAN, f64::NAN),
            (1024.0, 480.0)
        );
    }

    #[test]
    fn min_size_follows_interface_size() {
        // 125 percent zoom: 1024 x 480 CSS pixels is 1280 x 600 logical.
        assert_eq!(min_size(1920, 1040, 1.0, 1.0, 1.25), (1280.0, 600.0));
        // 110 percent.
        let (w, h) = min_size(1920, 1040, 1.0, 1.0, 1.1);
        assert!((w - 1126.4).abs() < 1e-6 && (h - 528.0).abs() < 1e-6);
        // 90 percent gives the page more room than 1024 x 480; the config's minimum stays.
        assert_eq!(min_size(1920, 1040, 1.0, 1.0, 0.9), (1024.0, 480.0));
    }

    #[test]
    fn min_size_multiplies_text_size_and_interface_size() {
        let near = |(w, h): (f64, f64), (ew, eh): (f64, f64)| {
            (w - ew).abs() < 1e-6 && (h - eh).abs() < 1e-6
        };
        // 120 percent Text size and 125 percent zoom: 1.5 logical px per CSS px.
        assert!(near(min_size(2560, 1400, 1.0, 1.2, 1.25), (1536.0, 720.0)));
        // 90 percent zoom under 125 percent Text size still keeps the page at 1024 x 480 CSS: 1.125.
        assert!(near(min_size(2560, 1400, 1.0, 1.25, 0.9), (1152.0, 540.0)));
    }

    #[test]
    fn min_size_clamps_to_the_work_area_but_not_below_the_config() {
        // 1366 x 728 at 100 percent, Text size 150 percent wants 1536 x 720.
        assert_eq!(min_size(1366, 728, 1.0, 1.5, 1.0), (1366.0, 720.0));
        // 225 percent wants 2304 x 1080 on a 1600 x 860 logical work area.
        assert_eq!(min_size(2000, 1075, 1.25, 2.25, 1.0), (1600.0, 860.0));
        // 125 percent zoom on a 1366 x 728 work area wants 1280 x 600, which fits.
        assert_eq!(min_size(1366, 728, 1.0, 1.0, 1.25), (1280.0, 600.0));
        // A work area under the config's minimum keeps the minimum.
        assert_eq!(min_size(1000, 400, 1.0, 1.5, 1.25), (1024.0, 480.0));
    }

    #[test]
    fn a_window_under_the_new_minimum_grows_to_it() {
        // 1024 x 700 when 125 percent asks for 1280 x 600: only the width grows.
        assert_eq!(
            grown((1024.0, 700.0), (1280.0, 600.0)),
            Some((1280.0, 700.0))
        );
        assert_eq!(
            grown((1000.0, 400.0), (1280.0, 600.0)),
            Some((1280.0, 600.0))
        );
        // Already large enough, or a rounding hair under: left alone.
        assert_eq!(grown((1600.0, 900.0), (1280.0, 600.0)), None);
        assert_eq!(grown((1279.6, 600.0), (1280.0, 600.0)), None);
    }

    #[test]
    fn a_grown_window_is_moved_back_onto_the_work_area() {
        let work = ((0, 0), (1920, 1040));
        // Grown past the right and bottom edges: moved left and up, just enough.
        assert_eq!(
            kept_on_screen((900, 600), (1280, 600), work.0, work.1),
            Some((640, 440))
        );
        // Off the left and top edges.
        assert_eq!(
            kept_on_screen((-20, -5), (1280, 600), work.0, work.1),
            Some((0, 0))
        );
        // Inside: left alone.
        assert_eq!(
            kept_on_screen((100, 100), (1280, 600), work.0, work.1),
            None
        );
        // A second monitor to the right, with its own origin.
        assert_eq!(
            kept_on_screen((3000, 0), (1280, 600), (1920, 0), (1600, 860)),
            Some((2240, 0))
        );
        // Wider than the work area: the left edge stays on screen.
        assert_eq!(
            kept_on_screen((100, 0), (2000, 600), work.0, work.1),
            Some((0, 0))
        );
    }

    const MIN_100: (f64, f64) = (1024.0, 480.0);
    const MIN_125: (f64, f64) = (1280.0, 600.0);

    #[test]
    fn a_maximized_full_screen_or_minimized_window_gets_no_window_call() {
        // On Windows tao's set_min_inner_size re-applies the size, which restores a maximized
        // window, so nothing is touched until it is restored; the minimum stays pending.
        let state = FitState {
            applied: Some(MIN_100),
            asked: None,
        };
        let plan = plan(state, MIN_125, true, Some((1920.0, 1040.0)));
        assert_eq!(
            plan,
            Plan {
                set_min: false,
                grow_to: None,
                next: state
            }
        );
        // Once restored (a Resized refit), the minimum lands and a smaller window grows.
        let plan = plan_restored(state);
        assert!(plan.set_min);
        assert_eq!(plan.grow_to, Some((1280.0, 700.0)));
        assert_eq!(plan.next.applied, Some(MIN_125));
    }

    fn plan_restored(state: FitState) -> Plan {
        plan(state, MIN_125, false, Some((1024.0, 700.0)))
    }

    #[test]
    fn nothing_changed_means_no_window_call() {
        let state = FitState {
            applied: Some(MIN_125),
            asked: None,
        };
        assert_eq!(
            plan(state, MIN_125, false, Some((1400.0, 800.0))),
            Plan {
                set_min: false,
                grow_to: None,
                next: state
            }
        );
    }

    #[test]
    fn a_new_minimum_is_set_once() {
        let state = FitState {
            applied: Some(MIN_100),
            asked: None,
        };
        let first = plan(state, MIN_125, false, Some((1400.0, 800.0)));
        assert!(first.set_min);
        assert_eq!(first.grow_to, None);
        let again = plan(first.next, MIN_125, false, Some((1400.0, 800.0)));
        assert!(!again.set_min);
    }

    #[test]
    fn a_refused_grow_is_not_asked_again_for_the_same_minimum() {
        // A tiling window manager keeps the tile under the minimum: ask once, not on every
        // focus and move.
        let state = FitState {
            applied: Some(MIN_125),
            asked: None,
        };
        let first = plan(state, MIN_125, false, Some((900.0, 500.0)));
        assert_eq!(first.grow_to, Some(MIN_125));
        let again = plan(first.next, MIN_125, false, Some((900.0, 500.0)));
        assert_eq!(again.grow_to, None);
        assert!(!again.set_min);
        // A new minimum asks again.
        let other = plan(again.next, (1400.0, 650.0), false, Some((900.0, 500.0)));
        assert!(other.set_min);
        assert_eq!(other.grow_to, Some((1400.0, 650.0)));
    }

    #[test]
    fn an_unknown_size_still_sets_the_minimum() {
        let state = FitState {
            applied: Some(MIN_100),
            asked: None,
        };
        let plan = plan(state, MIN_125, false, None);
        assert!(plan.set_min);
        assert_eq!(plan.grow_to, None);
    }

    #[test]
    fn the_outer_size_after_a_resize_keeps_the_frame() {
        // An undecorated window: the outer size is the client size.
        assert_eq!(
            outer_after_resize((1024, 500), (1024, 500), (1280, 600)),
            (1280, 600)
        );
        // A frame of 2 px each side and a 30 px title bar.
        assert_eq!(
            outer_after_resize((1028, 532), (1024, 500), (1280, 600)),
            (1284, 632)
        );
    }

    #[test]
    fn min_size_matches_the_config() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let main = &conf["app"]["windows"][0];
        assert_eq!(main["minWidth"].as_f64(), Some(MIN_WIDTH));
        assert_eq!(main["minHeight"].as_f64(), Some(MIN_HEIGHT));
    }

    #[test]
    fn text_scale_reads_the_percent() {
        assert_eq!(text_scale_from_percent(None), 1.0);
        assert_eq!(text_scale_from_percent(Some(124)), 1.24);
        assert_eq!(text_scale_from_percent(Some(225)), 2.25);
        assert_eq!(text_scale_from_percent(Some(99)), 1.0);
        assert_eq!(text_scale_from_percent(Some(500)), 1.0);
    }
}
