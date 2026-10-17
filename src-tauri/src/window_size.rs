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
    fn text_scale_reads_the_percent() {
        assert_eq!(text_scale_from_percent(None), 1.0);
        assert_eq!(text_scale_from_percent(Some(124)), 1.24);
        assert_eq!(text_scale_from_percent(Some(225)), 2.25);
        assert_eq!(text_scale_from_percent(Some(99)), 1.0);
        assert_eq!(text_scale_from_percent(Some(500)), 1.0);
    }
}
