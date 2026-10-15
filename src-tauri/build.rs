fn main() {
    // Plain debug Cargo checks/tests do not bundle an application. They must
    // work before the generated externalBin input exists. Tauri CLI supplies
    // TAURI_CONFIG/platform; retain its strict production sidecar validation.
    if std::env::var_os("TAURI_CONFIG").is_none()
        && std::env::var_os("TAURI_ENV_PLATFORM").is_none()
        && std::env::var("PROFILE").as_deref() == Ok("debug")
    {
        std::env::set_var("TAURI_CONFIG", r#"{"bundle":{"externalBin":[]}}"#);
    }
    tauri_build::build();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        // tauri-winres embeds Common Controls v6 into bins, but not examples.
        // The native PDF example needs the same activation context to start.
        let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap())
            .join("examples/windows-pdf-check.manifest");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg-examples=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg-examples=/MANIFESTINPUT:{}", manifest.display());
    }
}
