//! Fixed-source, bounded release enumeration. No renderer supplies network authority.
use std::{collections::{HashMap, HashSet}, time::Duration};
use serde::Deserialize;
use semver::Version;
use reqwest::{Client, Url};

pub const CATALOG: &str = "https://api.github.com/repos/CoozeeWang/leaf-markdown/releases";
pub const MAX_PAGE_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_MANIFEST_BYTES: usize = 256 * 1024;
pub const MAX_NOTES_BYTES: usize = 64 * 1024;
pub const MAX_PAGES: usize = 10;
const MAX_URL_BYTES: usize = 4096;
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CandidateIdentity {
    pub release_id: u64, pub tag: String, pub version: String,
    pub platform: String, pub arch: String, pub manifest_asset_id: u64,
    pub asset_id: u64, pub asset_name: String, pub url: String, pub signature: String,
}
impl CandidateIdentity {
    pub fn opaque_id(&self) -> String {
        use sha2::{Digest, Sha256};
        let fields = [&self.tag, &self.version, &self.platform, &self.arch, &self.asset_name, &self.url, &self.signature];
        let mut hash = Sha256::new();
        hash.update(self.release_id.to_be_bytes()); hash.update(self.manifest_asset_id.to_be_bytes()); hash.update(self.asset_id.to_be_bytes());
        for field in fields { hash.update((field.len() as u64).to_be_bytes()); hash.update(field.as_bytes()); }
        format!("{:x}", hash.finalize())
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CatalogOutcome { Current, NoCatalog, NoPackage, Available }
#[derive(Clone, Debug)]
pub struct ReleaseCatalog { pub outcome: CatalogOutcome, pub candidate: Option<CandidateIdentity>, pub notes: Option<String> }
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
struct Release {
    id: u64, tag_name: String, draft: bool,
    #[serde(default)] prerelease: bool,
    #[serde(default)] published_at: Option<String>,
    #[serde(default)] body: Option<String>,
    assets: Vec<Asset>,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
struct Asset { id: u64, name: String, browser_download_url: String }
#[derive(Deserialize)]
struct Manifest {
    version: String,
    #[serde(deserialize_with="unique_platforms")]
    platforms: HashMap<String, ManifestPlatform>,
}
#[derive(Deserialize)]
struct ManifestPlatform { url: String, signature: String }
fn unique_platforms<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<HashMap<String, ManifestPlatform>, D::Error> {
    struct Visitor;
    impl<'de> serde::de::Visitor<'de> for Visitor {
        type Value = HashMap<String, ManifestPlatform>;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result { f.write_str("unique bounded platform keys") }
        fn visit_map<A: serde::de::MapAccess<'de>>(self, mut access: A) -> Result<Self::Value, A::Error> {
            let mut result = HashMap::new();
            while let Some((key, value)) = access.next_entry::<String, ManifestPlatform>()? {
                if result.len() >= 64 || key.len() > 128 || result.insert(key, value).is_some() { return Err(serde::de::Error::custom("invalid platform keys")); }
            }
            Ok(result)
        }
    }
    deserializer.deserialize_map(Visitor)
}
pub fn product_version(tag: &str) -> Option<Version> {
    if tag.len() > 256 || !tag.is_ascii() { return None; }
    let version = Version::parse(tag.strip_prefix('v').unwrap_or(tag)).ok()?;
    if !version.pre.is_empty() {
        let number = version.pre.as_str().strip_prefix("beta.")?;
        if number.is_empty() || !number.bytes().all(|c| c.is_ascii_digit()) { return None; }
    }
    Some(version)
}
pub fn platform() -> String { format!("{}-{}", os(), std::env::consts::ARCH) }
pub fn os() -> &'static str { if cfg!(target_os="macos") {"darwin"} else if cfg!(target_os="windows") {"windows"} else {"linux"} }
fn clean_url(url: &Url) -> bool {
    url.username().is_empty() && url.password().is_none() && url.port().is_none() && url.fragment().is_none()
}
pub fn official_asset(url: &str, tag: &str) -> bool {
    if url.len() > MAX_URL_BYTES || product_version(tag).is_none() { return false; }
    let Ok(parsed) = Url::parse(url) else { return false; };
    let prefix = format!("/CoozeeWang/leaf-markdown/releases/download/{tag}/");
    let Some(name) = parsed.path().strip_prefix(&prefix) else { return false; };
    parsed.scheme()=="https" && parsed.host_str()==Some("github.com") && clean_url(&parsed) && parsed.query().is_none()
        && !name.is_empty() && name.len()<=255 && !matches!(name,"."|"..")
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b"._+-".contains(&b))
}
fn official_asset_named(url: &str, tag: &str, name: &str) -> bool {
    official_asset(url, tag) && url == format!("https://github.com/CoozeeWang/leaf-markdown/releases/download/{tag}/{name}")
}
fn cdn_redirect(url: &Url) -> bool {
    if url.scheme()!="https" || !clean_url(url) || url.as_str().len()>8192 { return false; }
    let prefixes: &[&str] = match url.host_str() {
        Some("release-assets.githubusercontent.com") => &["/github-production-release-asset/"],
        Some("objects.githubusercontent.com") => &["/github-production-release-asset-2e65be/", "/github-production-release-asset/"],
        _ => return false,
    };
    prefixes.iter().any(|prefix| url.path().strip_prefix(prefix).is_some_and(|tail| {
        let mut fields=tail.split('/');
        fields.next().is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
            && fields.next().is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)))
            && fields.next().is_none()
    }))
}
pub fn fixture_source(source: &str) -> bool {
    #[cfg(any(test,feature="native-smoke"))]
    {
        #[cfg(all(feature="native-smoke",not(test)))]
        if !crate::update_test_driver::network_fixture_enabled() { return false; }
        let Ok(url)=Url::parse(source) else {return false;};
        return url.scheme()=="http" && url.host_str()==Some("127.0.0.1") && url.port().is_some()
            && url.username().is_empty() && url.password().is_none() && url.query().is_none() && url.fragment().is_none()
            && url.path()=="/releases";
    }
    #[cfg(not(any(test,feature="native-smoke")))]
    { let _=source; false }
}
pub fn client(testing: bool) -> Result<Client, String> {
    if testing {
        #[cfg(not(any(test,feature="native-smoke")))]
        return Err("update_source_rejected".into());
    }
    Client::builder().user_agent(concat!("Leaf/",env!("CARGO_PKG_VERSION")))
        .https_only(!testing).connect_timeout(Duration::from_secs(10)).timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            // API redirects never carry the CI-only probe token to another host.
            let Some(first)=attempt.previous().first() else {return attempt.stop();};
            if first.host_str()==Some("api.github.com") {return attempt.stop();}
            let same_fixture=fixture_source(first.as_str().split("/manifest/").next().unwrap_or(""))
                && attempt.url().origin()==first.origin();
            if attempt.previous().len()<4 && (cdn_redirect(attempt.url()) || same_fixture) {attempt.follow()} else {attempt.stop()}
        })).build().map_err(|_|"update_client_failed".into())
}
pub fn network_error(error: reqwest::Error) -> String {
    if error.is_timeout() {"update_timeout"} else if error.is_connect() {"update_connect_failed"} else if error.is_builder() {"update_client_failed"} else {"update_network_failed"}.into()
}

fn pagination_token(byte:u8)->bool {
    byte.is_ascii_alphanumeric()||byte==96||b"!#$%&'*+-.^_|~".contains(&byte)
}
fn pagination_value(bytes:&[u8],position:&mut usize)->Result<String,String> {
    let invalid=||"update_invalid_pagination".to_owned();
    let mut value=Vec::new();
    if bytes.get(*position)==Some(&b'"') {
        *position+=1;
        loop {
            let byte=*bytes.get(*position).ok_or_else(invalid)?;*position+=1;
            if byte==b'"' {break;}
            let byte=if byte==b'\\' {let byte=*bytes.get(*position).ok_or_else(invalid)?;*position+=1;byte}else{byte};
            if byte<32||byte==127 {return Err(invalid());}value.push(byte);
        }
    }else {
        while bytes.get(*position).is_some_and(|byte|pagination_token(*byte)) {value.push(bytes[*position]);*position+=1;}
        if value.is_empty() {return Err(invalid());}
    }
    String::from_utf8(value).map_err(|_|invalid())
}
fn pagination_next(headers:&reqwest::header::HeaderMap,current:&Url)->Result<bool,String> {
    let invalid=||"update_invalid_pagination".to_owned();
    let mut next=None;let mut total=0usize;
    for header in headers.get_all("link") {
        total=total.checked_add(header.as_bytes().len()).filter(|n|*n<=8192).ok_or_else(invalid)?;
        let text=header.to_str().map_err(|_|invalid())?;let bytes=text.as_bytes();let mut position=0;
        if bytes.is_empty() {return Err(invalid());}
        while position<bytes.len() {
            while bytes.get(position).is_some_and(|byte|matches!(*byte,b' '|b'\t')) {position+=1;}
            if bytes.get(position)!=Some(&b'<') {return Err(invalid());}position+=1;
            let start=position;
            while bytes.get(position).is_some_and(|byte|*byte!=b'>') {
                if bytes[position]<33||bytes[position]==b'<' {return Err(invalid());}position+=1;
            }
            if bytes.get(position)!=Some(&b'>')||position==start {return Err(invalid());}
            let target=&text[start..position];position+=1;
            let mut relation=None;let mut anchor=false;
            loop {
                while bytes.get(position).is_some_and(|byte|matches!(*byte,b' '|b'\t')) {position+=1;}
                if position==bytes.len()||bytes[position]==b',' {break;}
                if bytes[position]!=b';' {return Err(invalid());}position+=1;
                while bytes.get(position).is_some_and(|byte|matches!(*byte,b' '|b'\t')) {position+=1;}
                let start=position;
                while bytes.get(position).is_some_and(|byte|pagination_token(*byte)) {position+=1;}
                if position==start {return Err(invalid());}
                let name=&text[start..position];
                while bytes.get(position).is_some_and(|byte|matches!(*byte,b' '|b'\t')) {position+=1;}
                let value=if bytes.get(position)==Some(&b'=') {
                    position+=1;
                    while bytes.get(position).is_some_and(|byte|matches!(*byte,b' '|b'\t')) {position+=1;}
                    Some(pagination_value(bytes,&mut position)?)
                }else{None};
                if name.eq_ignore_ascii_case("rel")&&relation.is_none() {relation=Some(value.ok_or_else(invalid)?);}
                if name.eq_ignore_ascii_case("anchor") {anchor=true;}
            }
            if relation.is_none() {return Err(invalid());}
            if !anchor&&relation.is_some_and(|value|value.split_ascii_whitespace().any(|relation|relation.eq_ignore_ascii_case("next"))) {
                let target=current.join(target).map_err(|_|invalid())?;
                let query:Vec<_>=target.query_pairs().collect();
                let current_page=current.query_pairs().find(|(name,_)|name=="page").and_then(|(_,page)|page.parse::<usize>().ok()).ok_or_else(invalid)?;
                let expected=current_page.checked_add(1).ok_or_else(invalid)?.to_string();
                if target.origin()!=current.origin()||target.path()!=current.path()||!target.username().is_empty()||target.password().is_some()||target.fragment().is_some()
                    ||query.len()!=2||query.iter().filter(|(name,value)|name.as_ref()=="per_page"&&value.as_ref()=="100").count()!=1
                    ||query.iter().filter(|(name,value)|name.as_ref()=="page"&&value.as_ref()==expected.as_str()).count()!=1 {return Err(invalid());}
                if next.as_ref().is_some_and(|previous|previous!=&target) {return Err(invalid());}
                next=Some(target);
            }
            if position<bytes.len() {position+=1;if position==bytes.len() {return Err(invalid());}}
        }
    }
    Ok(next.is_some())
}

pub async fn bounded_request(request: reqwest::RequestBuilder, limit: usize) -> Result<(Vec<u8>,bool),String> {
    let mut response=request.send().await.map_err(network_error)?;
    if !response.status().is_success() {
        let status=response.status().as_u16();
        return Err(if status==403||status==429 {"update_rate_limited".into()} else {format!("update_http_{status}")});
    }
    if response.content_length().is_some_and(|n|n>limit as u64) {return Err("update_response_too_large".into());}
    let next=pagination_next(response.headers(),response.url())?;
    let mut bytes=Vec::new();
    while let Some(chunk)=response.chunk().await.map_err(network_error)? {
        if bytes.len().checked_add(chunk.len()).is_none_or(|size|size>limit) {return Err("update_response_too_large".into());}
        bytes.extend_from_slice(&chunk);
    }
    Ok((bytes,next))
}
pub async fn read_catalog(source: &str, installed: &str, target: &str, probe_token: Option<&str>) -> Result<ReleaseCatalog,String> {
    tokio::time::timeout(Duration::from_secs(90),read_catalog_inner(source,installed,target,probe_token)).await
        .map_err(|_|"update_timeout".to_owned())?
}
async fn read_catalog_inner(source: &str, installed: &str, target: &str, probe_token: Option<&str>) -> Result<ReleaseCatalog,String> {
    let testing=fixture_source(source);
    if source!=CATALOG && !testing {return Err("update_source_rejected".into());}
    if probe_token.is_some() && source!=CATALOG {return Err("update_source_rejected".into());}
    #[cfg(not(feature="native-smoke"))]
    if probe_token.is_some() {return Err("update_source_rejected".into());}
    let client=client(testing)?;
    let mut releases: HashMap<u64,Release>=HashMap::new();
    let mut tags=HashMap::new();
    let mut assets=HashMap::new();
    for page in 1..=MAX_PAGES {
        let mut request=client.get(format!("{source}?per_page=100&page={page}"))
            .header("Accept","application/vnd.github+json").header("X-GitHub-Api-Version","2022-11-28");
        if let Some(token)=probe_token {request=request.bearer_auth(token);}
        let (bytes,next)=bounded_request(request,MAX_PAGE_BYTES).await?;
        let entries:Vec<Release>=serde_json::from_slice(&bytes).map_err(|_|"update_catalog_invalid")?;
        if entries.len()>100 {return Err("update_catalog_incomplete".into());}
        let page_full=entries.len()==100;
        for release in entries {
            if release.tag_name.len()>256 || release.body.as_ref().is_some_and(|s|s.len()>MAX_NOTES_BYTES)
                || release.published_at.as_ref().is_some_and(|s|s.len()>256) || release.assets.len()>1000 {return Err("update_catalog_invalid".into());}
            if let Some(previous)=releases.get(&release.id) {
                if previous!=&release {return Err("update_catalog_duplicate".into());}
                continue;
            }
            if tags.insert(release.tag_name.clone(),release.id).is_some() {return Err("update_catalog_duplicate".into());}
            let mut names=HashSet::new();
            let mut urls=HashSet::new();
            for asset in &release.assets {
                if asset.name.len()>255 || asset.browser_download_url.len()>MAX_URL_BYTES
                    || !names.insert(&asset.name) || !urls.insert(&asset.browser_download_url)
                    || assets.insert(asset.id,release.id).is_some() {return Err("update_catalog_duplicate".into());}
            }
            releases.insert(release.id,release);
        }
        if !next&&!page_full {break;}
        if page==MAX_PAGES {return Err("update_catalog_incomplete".into());}
    }
    let mut published:Vec<_>=releases.into_values().filter_map(|release| {
        if release.draft || release.published_at.as_deref().is_none_or(|s|s.trim().is_empty()) {return None;}
        let version=product_version(&release.tag_name)?;
        if release.prerelease && version.pre.is_empty() {return None;}
        Some((version,release))
    }).collect();
    if published.is_empty() {return Ok(ReleaseCatalog{outcome:CatalogOutcome::NoCatalog,candidate:None,notes:None});}
    let installed=product_version(installed).ok_or("update_installed_version_invalid")?;
    published.sort_by(|a,b| b.0.cmp_precedence(&a.0).then_with(||a.1.id.cmp(&b.1.id)).then_with(||a.1.tag_name.cmp(&b.1.tag_name)));
    let mut newer=false;
    for (version,release) in published {
        if !version.cmp_precedence(&installed).is_gt() {continue;}
        newer=true;
        let Some(manifest_asset)=release.assets.iter().find(|a|a.name=="latest.json") else {continue;};
        if !official_asset_named(&manifest_asset.browser_download_url,&release.tag_name,"latest.json") {return Err("update_asset_rejected".into());}
        let url=if testing {format!("{source}/manifest/{}",manifest_asset.id)} else {manifest_asset.browser_download_url.clone()};
        let (bytes,_)=match bounded_request(client.get(url),MAX_MANIFEST_BYTES).await {
            Ok(response)=>response,
            Err(code) if code=="update_http_404"||code=="update_http_410"=>continue,
            Err(code)=>return Err(code),
        };
        let manifest:Manifest=serde_json::from_slice(&bytes).map_err(|_|"update_manifest_invalid")?;
        if product_version(&manifest.version).as_ref()!=Some(&version) || manifest.version.starts_with('v') {return Err("update_version_mismatch".into());}
        let Some(package)=manifest.platforms.get(target) else {continue;};
        if !official_asset(&package.url,&release.tag_name) {return Err("update_asset_rejected".into());}
        let Some(asset)=release.assets.iter().find(|a|a.browser_download_url==package.url) else {continue;};
        if asset.name=="latest.json" || !official_asset_named(&asset.browser_download_url,&release.tag_name,&asset.name) {return Err("update_asset_rejected".into());}
        if package.signature.is_empty() || package.signature.len()>16384 {return Err("update_signature_missing".into());}
        let arch=target.rsplit_once('-').ok_or("update_platform_invalid")?.1.to_owned();
        return Ok(ReleaseCatalog {outcome:CatalogOutcome::Available, notes:release.body,
            candidate:Some(CandidateIdentity {release_id:release.id,tag:release.tag_name,version:version.to_string(),
                platform:target.into(),arch,manifest_asset_id:manifest_asset.id,asset_id:asset.id,asset_name:asset.name.clone(),url:package.url.clone(),signature:package.signature.clone()})});
    }
    Ok(ReleaseCatalog{outcome:if newer {CatalogOutcome::NoPackage} else {CatalogOutcome::Current},candidate:None,notes:None})
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn pagination_relations_are_parsed_and_bound_to_the_next_fixed_page() {
        fn parsed(value:&str)->Result<bool,String> {
            let mut headers=reqwest::header::HeaderMap::new();
            headers.insert("link",value.parse().unwrap());
            pagination_next(&headers,&Url::parse("https://api.github.com/repos/CoozeeWang/leaf-markdown/releases?per_page=100&page=1").unwrap())
        }
        for value in [
            "<?per_page=100&page=2>; rel=next",
            "<?page=2&per_page=100>; rel=\"next\"",
            "<?page=2&per_page=100>; title=\"a,b\"; REL=\"previous next\"",
        ] {assert_eq!(parsed(value).unwrap(),true,"{value}");}
        for value in [
            "<?page=2&per_page=100>; rel=previous; title=\"rel=next\"",
            "<?page=2&per_page=100>; rel=nextish",
            "<?page=2&per_page=100>; rel=previous; rel=next",
            "<?page=2&per_page=100>; rel=next; anchor=\"/another-context\"",
        ] {assert_eq!(parsed(value).unwrap(),false,"{value}");}
        for value in [
            "",
            "<?page=2&per_page=100>",
            "<?page=3&per_page=100>; rel=next",
            "<?page=2&page=2>; rel=next",
            "<?page=2&per_page=100&extra=1>; rel=next",
            "<https://untrusted.invalid/releases?page=2&per_page=100>; rel=next",
            "<?page=2&per_page=100>; rel=\"next",
            "<?page=2&per_page=100>; title=\"unterminated",
            "<?page=2&per_page=100>; rel=next, <?page=3&per_page=100>; rel=next",
        ] {assert!(parsed(value).is_err(),"{value}");}
    }
    #[tokio::test] async fn complete_pagination_and_fallthrough() {super::fixture::run().await.unwrap();}
    #[test] fn fixture_page_query_does_not_confuse_page_size() {
        assert_eq!(super::fixture::page("/releases?per_page=100&page=1"),Some(1));
        assert_eq!(super::fixture::page("/releases?per_page=100&page=2"),Some(2));
        assert_eq!(super::fixture::page("/releases?per_page=100"),None);
        let origin="https://api.github.com/repos/CoozeeWang/leaf-markdown/releases";
        for page in [1,2,10] {
            let mut headers=reqwest::header::HeaderMap::new();
            headers.insert("link",super::fixture::next_link(origin,page).parse().unwrap());
            let current=Url::parse(&format!("{origin}?per_page=100&page={page}")).unwrap();
            assert!(pagination_next(&headers,&current).unwrap(),"fixture must advance from page {page}");
        }
    }
    #[test] fn version_precedence_and_exact_identity() {
        let a=product_version("v1.0.0+one").unwrap(); let b=product_version("v1.0.0+two").unwrap();
        assert!(a.cmp_precedence(&b).is_eq()); assert_ne!(a,b);
        assert!(product_version("1.0.0-beta.0").is_some());
        assert!(product_version("1.0.0-beta.10").unwrap().cmp_precedence(&product_version("1.0.0-beta.2").unwrap()).is_gt());
        for bad in ["1.0.0-rc.1","1.0.0-beta.01","v v1.0.0","1.0.0-beta.1.2","1.0.0-beta.-1"] {assert!(product_version(bad).is_none());}
    }
    #[test] fn exact_release_asset_and_cdn_scope() {
        assert!(official_asset("https://github.com/CoozeeWang/leaf-markdown/releases/download/v1.0.0/Leaf.app.tar.gz","v1.0.0"));
        for name in ["folder/Leaf.zip","%2e%2e/Leaf.zip","Leaf.zip/extra","Leaf%2fother.zip","Leaf%5cother.zip"] {
            assert!(!official_asset(&format!("https://github.com/CoozeeWang/leaf-markdown/releases/download/v1.0.0/{name}"),"v1.0.0"));
        }
        assert!(cdn_redirect(&Url::parse("https://release-assets.githubusercontent.com/github-production-release-asset/123/abcd-123?token=synthetic").unwrap()));
        for url in ["https://release-assets.githubusercontent.com/other/123/asset","https://github.com.evil.invalid/github-production-release-asset/123/asset","http://objects.githubusercontent.com/github-production-release-asset/123/asset"] {assert!(!cdn_redirect(&Url::parse(url).unwrap()));}
    }
}

#[cfg(any(test,feature="native-smoke"))]
mod fixture {
    use super::*;
    use serde_json::{json,Value};
    use tokio::io::{AsyncReadExt,AsyncWriteExt};
    pub fn page(path:&str)->Option<usize> {
        let url=Url::parse(&format!("http://127.0.0.1{path}")).ok()?;
        let pages:Vec<_>=url.query_pairs().filter(|(key,_)|key=="page").collect();
        if pages.len()!=1 {return None;}
        pages[0].1.parse().ok()
    }
    pub fn next_link(origin:&str,page:usize)->String {
        format!("<{origin}?per_page=100&page={}>; rel=\"next\"",page+1)
    }
    pub async fn scenario(mode:&str) -> Result<ReleaseCatalog,String> {
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|_|"fixture_bind")?;
        let source=format!("http://{}/releases",listener.local_addr().map_err(|_|"fixture_address")?);
        let origin=source.clone();let mode=mode.to_owned();
        let task=tokio::spawn(async move {
            loop {
                let Ok((mut stream,_))=listener.accept().await else{return;};
                let mode=mode.clone();let origin=origin.clone();
                tokio::spawn(async move {
                    let mut input=Vec::new();let mut chunk=[0u8;1024];
                    while !input.windows(4).any(|bytes|bytes==b"\r\n\r\n") {
                        let Ok(size)=stream.read(&mut chunk).await else{return;};
                        if size==0||input.len().checked_add(size).is_none_or(|length|length>8192) {return;}
                        input.extend_from_slice(&chunk[..size]);
                    }
                    let request=String::from_utf8_lossy(&input);
                    let path=request.split_whitespace().nth(1).unwrap_or("");
                    let page=page(path);
                    let base="https://github.com/CoozeeWang/leaf-markdown/releases/download/";
                    let make=|id:u64,version:&str,manifest:bool| {
                        let mut assets=vec![json!({"id":id*10+2,"name":"Leaf.tar.gz","browser_download_url":format!("{base}v{version}/Leaf.tar.gz")})];
                        if manifest {assets.push(json!({"id":id*10+1,"name":"latest.json","browser_download_url":format!("{base}v{version}/latest.json")}));}
                        json!({"id":id,"tag_name":format!("v{version}"),"draft":false,"prerelease":version.contains("beta"),"published_at":"2026-01-01T00:00:00Z","body":"Synthetic notes","assets":assets})
                    };
                    let mut next=false;
                    let payload:Value;
                    if path.contains("/manifest/") {
                        let id=path.rsplit('/').next().unwrap_or("");
                        let version=if id=="11" {"9.0.0"} else {"8.0.0-beta.10"};
                        let target=if mode=="missing_platform" && id=="11" {"windows-other"} else {"darwin-aarch64"};
                        let filename=if mode=="asset_missing"&&id=="11" {"Leaf-missing.tar.gz"}else{"Leaf.tar.gz"};
                        payload=json!({"version":version,"platforms":{target:{"url":format!("{base}v{version}/{filename}"),"signature":"synthetic-metadata-only"}}});
                    } else if mode=="empty" {payload=json!([]);}
                    else if mode=="unpublished" {let mut release=make(1,"9.0.0",true);release["published_at"]=Value::Null;payload=json!([release]);}
                    else if mode=="current" {payload=json!([make(1,"1.0.0+different",false)]);}
                    else if mode=="no_package" {payload=json!([make(1,"9.0.0",false)]);}
                    else if mode=="cap" {next=true;payload=json!([]);}
                    else if mode=="full_without_link" && page==Some(1) {payload=Value::Array(vec![make(1,"9.0.0",false);100]);}
                    else if page==Some(1) {
                        next=true;payload=json!([make(1,"9.0.0",mode!="missing_manifest")]);
                    } else {
                        let mut lower=make(2,"8.0.0-beta.10",true);
                        if mode=="duplicate_asset" {lower["assets"][0]["id"]=json!(12);}
                        payload=if mode=="duplicate_same" {json!([make(1,"9.0.0",true),lower])}
                        else if mode=="duplicate_conflict" {let mut duplicate=make(1,"9.0.0",true);duplicate["body"]=json!("conflicting notes");json!([duplicate,lower])}
                        else {json!([lower])};
                    }
                    let bytes=serde_json::to_vec(&payload).unwrap();
                    let link=if next {format!("Link: {}\r\n",next_link(&origin,page.unwrap_or(0)))}else{String::new()};
                    let status=if mode=="manifest_not_found"&&path.contains("/manifest/11") {"404 Not Found"}else{"200 OK"};
                    let header=format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{link}Connection: close\r\n\r\n",bytes.len());
                    let _=stream.write_all(header.as_bytes()).await;let _=stream.write_all(&bytes).await;
                });
            }
        });
        let result=read_catalog(&source,"1.0.0","darwin-aarch64",None).await;
        task.abort();result
    }
    pub async fn run() -> Result<(),String> {
        for (mode,outcome,version) in [
            ("empty",CatalogOutcome::NoCatalog,None),
            ("unpublished",CatalogOutcome::NoCatalog,None),
            ("current",CatalogOutcome::Current,None),
            ("no_package",CatalogOutcome::NoPackage,None),
            ("available",CatalogOutcome::Available,Some("9.0.0")),
            ("missing_manifest",CatalogOutcome::Available,Some("8.0.0-beta.10")),
            ("missing_platform",CatalogOutcome::Available,Some("8.0.0-beta.10")),
            ("manifest_not_found",CatalogOutcome::Available,Some("8.0.0-beta.10")),
            ("asset_missing",CatalogOutcome::Available,Some("8.0.0-beta.10")),
            ("full_without_link",CatalogOutcome::Available,Some("8.0.0-beta.10")),
            ("duplicate_same",CatalogOutcome::Available,Some("9.0.0")),
        ] {
            let result=scenario(mode).await?;
            if result.outcome!=outcome || result.candidate.as_ref().map(|c|c.version.as_str())!=version {return Err(format!("catalog_fixture_{mode}"));}
        }
        for mode in ["duplicate_conflict","duplicate_asset"] {
            if scenario(mode).await.err().as_deref()!=Some("update_catalog_duplicate") {return Err(format!("catalog_fixture_{mode}"));}
        }
        let cap=scenario("cap").await.err();
        if cap.as_deref()!=Some("update_catalog_incomplete") {return Err(format!("catalog_fixture_truncation:{cap:?}"));}
        Ok(())
    }
}
#[cfg(feature="native-smoke")]
pub async fn smoke() -> Result<(),String> {fixture::run().await}
