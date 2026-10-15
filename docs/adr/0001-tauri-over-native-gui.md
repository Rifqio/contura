# Tauri instead of a native GUI toolkit

DB View is described as a native Windows desktop app, but its UI is React running in Tauri's WebView2, not native widgets or a pure-Rust GUI (egui, iced, slint). We chose Tauri for the web ecosystem's mature canvas and data-grid libraries, which the Visual Query and table grids depend on. In exchange we accept roughly 80–150 MB of WebView2 baseline memory. The Rust Core stays independent of the UI, and we avoid Windows-only APIs so macOS and Linux remain possible.
