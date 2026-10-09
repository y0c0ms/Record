fn main() {
    // The dark variant of the std widgets, so dropdowns and text areas match
    // the app's dark surfaces instead of rendering as light boxes.
    let config = slint_build::CompilerConfiguration::new().with_style("fluent-dark".into());
    slint_build::compile_with_config("ui/app.slint", config).expect("Slint UI failed to compile");

    // The exe's own icon — what Explorer, the taskbar and Alt-Tab show. The
    // window icon set in app.slint covers the title bar; this covers the file.
    // Regenerate assets/app.ico from ui/icons/app.svg with
    // `node tools/render-icon.mjs`.
    #[cfg(windows)]
    {
        println!("cargo:rerun-if-changed=assets/app.ico");
        let mut res = winresource::WindowsResource::new();
        res.set_icon("assets/app.ico");
        res.set("FileDescription", "Record — Edge flow recorder");
        res.set("ProductName", "Record");
        res.compile().expect("could not embed the application icon");
    }
}
