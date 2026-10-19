//! Opens a checked https link in the user's default browser. The webview itself never
//! navigates away or opens windows; links leave the app only through here.

use contura_core::Error;

/// Opens `url`, which `contura_core::links::safe_https_url` has already checked.
#[cfg(windows)]
pub fn open(url: &str) -> Result<(), Error> {
    use windows_sys::Win32::System::Com::{
        COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx, CoUninitialize,
    };
    use windows_sys::Win32::UI::Shell::{
        SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SHELLEXECUTEINFOW, ShellExecuteExW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let verb = wide("open");
    let file = wide(url);
    // SAFETY: the struct is plain data, zeroed then filled; both strings are NUL-terminated
    // UTF-16 that outlive the call. COM is set up on this thread for the shell, as its
    // documentation asks, and released only when it was set up here. NO_UI keeps Windows from
    // showing its own error box (Contura shows the error); NOASYNC finishes the hand-off
    // before this blocking thread goes back to the pool.
    let result = unsafe {
        let com = CoInitializeEx(
            std::ptr::null(),
            (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32,
        );
        let mut info: SHELLEXECUTEINFOW = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
        info.fMask = SEE_MASK_FLAG_NO_UI | SEE_MASK_NOASYNC;
        info.lpVerb = verb.as_ptr();
        info.lpFile = file.as_ptr();
        info.nShow = SW_SHOWNORMAL;
        let opened = ShellExecuteExW(&mut info) != 0;
        let error = std::io::Error::last_os_error();
        if com >= 0 {
            CoUninitialize();
        }
        if opened { Ok(()) } else { Err(error) }
    };
    result.map_err(|e| Error::File(format!("Windows couldn't open the link: {e}")))
}

#[cfg(not(windows))]
pub fn open(url: &str) -> Result<(), Error> {
    let program = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    std::process::Command::new(program)
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| Error::File(format!("The browser didn't open: {e}")))
}
