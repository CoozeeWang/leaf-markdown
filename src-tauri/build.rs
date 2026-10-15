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
    tauri_build::build()
}
