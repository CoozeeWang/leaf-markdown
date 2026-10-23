//! Independent update worker. It never opens documents, credentials or WebView data.
#[cfg(not(test))]
#[path="../update_install.rs"]
mod update_install;
#[cfg(not(test))]
#[path="../update_binary_identity.rs"]
mod update_binary_identity;

#[cfg(all(not(test),target_os="macos",feature="native-smoke"))]
#[path="../update_install_fixture.rs"]
mod update_install_fixture;
#[cfg(not(test))]
fn main(){
    crate::leaf_update_binary_identity!("leaf-update-helper");
    if std::env::args().nth(1).as_deref()==Some("--leaf-build-identity"){
        use sha2::{Digest,Sha256};
        println!("{}:{:x}:{}:{}:{}:{}",env!("CARGO_PKG_VERSION"),Sha256::digest(include_bytes!("../update_install.rs")),
            std::env::consts::OS,std::env::consts::ARCH,if cfg!(feature="native-smoke"){"native-smoke"}else{"production"},if cfg!(debug_assertions){"debug"}else{"release"});
        return;
    }
    #[cfg(all(target_os="macos",feature="native-smoke"))]
    if std::env::args().nth(1).as_deref()==Some("--mac-update-fixture-helper"){
        if let Err(code)=update_install_fixture::helper_main(){eprintln!("mac_fixture_helper_failed:{code}");std::process::exit(1);}return;
    }
    #[cfg(all(target_os="macos",feature="native-smoke"))]
    if std::env::args().nth(1).as_deref()==Some("--mac-update-preservation-helper"){
        if let Err(code)=update_install_fixture::preservation_helper_main(){eprintln!("preservation_helper_failed:{code}");std::process::exit(1);}return;
    }
    #[cfg(target_os="macos")]
    let result=update_install::macos::helper_main();
    #[cfg(not(target_os="macos"))]
    let result:Result<(),String>=Err("update_install_platform_unavailable".into());
    if let Err(code)=result{eprintln!("update_helper_failed:{code}");std::process::exit(1);}
}
#[cfg(test)]
fn main(){}
