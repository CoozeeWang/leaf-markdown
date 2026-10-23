//! The release inventory crosschecks this compiled product/version/role identity.
#[macro_export]
macro_rules! leaf_update_binary_identity {
    ($role:literal) => {{
        #[used]
        static LEAF_IDENTITY: &[u8] = concat!("LEAF_UPDATE_BINARY_IDENTITY_V1\0Leaf\0studio.leaf.editor\0",env!("CARGO_PKG_VERSION"),"\0",$role,"\0").as_bytes();
        let _=std::hint::black_box(LEAF_IDENTITY);
    }};
}
