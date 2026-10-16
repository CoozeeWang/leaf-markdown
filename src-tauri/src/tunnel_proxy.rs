//! Resolve only the tunnel's outbound route. Never change OS proxy settings.
use std::process::Command;

pub struct ProxyRoute { pub source: &'static str, env: Vec<(String,String)> }
impl ProxyRoute {
    pub fn apply(&self, command:&mut Command) { for (name,value) in &self.env {command.env(name,value);} }
}
pub fn validate_explicit(value:&str)->Result<(),String> {
    if value.is_empty(){return Ok(());}
    validate_url(value,false)
}
fn validate_url(value:&str,credentials:bool)->Result<(),String> {
    let url=tauri::Url::parse(value).map_err(|_|"invalid_tunnel_proxy")?;
    if !matches!(url.scheme(),"http"|"https")||url.host_str().is_none()||url.port_or_known_default().is_none()||(!credentials&&(!url.username().is_empty()||url.password().is_some()))||!matches!(url.path(),""|"/")||url.query().is_some()||url.fragment().is_some()||value.chars().any(char::is_whitespace){return Err("invalid_tunnel_proxy".into());}Ok(())
}
pub fn resolve(explicit:&str)->Result<ProxyRoute,String> {
    resolve_with(explicit,|name|std::env::var(name).ok(),system_proxy)
}
fn resolve_with(explicit:&str,env:impl Fn(&str)->Option<String>,system:impl FnOnce()->Result<Option<String>,String>)->Result<ProxyRoute,String> {
    validate_explicit(explicit)?;
    if !explicit.is_empty(){return Ok(ProxyRoute{source:"explicit",env:vec![("CONTROL_PLANE_HTTP_PROXY".into(),explicit.into())]});}
    for name in ["CONTROL_PLANE_HTTP_PROXY","TUNNEL_CLIENT_HTTP_PROXY"] {
        if let Some(value)=env(name).filter(|v|!v.is_empty()) {validate_url(&value,true)?;return Ok(ProxyRoute{source:"environment",env:vec![("CONTROL_PLANE_HTTP_PROXY".into(),value)]});}
    }
    // Preserve standard HTTPS proxy + bypass semantics; do not project global
    // tunnel configuration, credentials or arbitrary environment variables.
    if let Some(value)=env("HTTPS_PROXY").filter(|v|!v.is_empty()).or_else(||env("https_proxy").filter(|v|!v.is_empty())).or_else(||env("ALL_PROXY").filter(|v|!v.is_empty())).or_else(||env("all_proxy").filter(|v|!v.is_empty())) {
        validate_url(&value,true)?;
        let mut values=vec![("HTTPS_PROXY".into(),value)];
        if let Some(bypass)=env("NO_PROXY").filter(|v|!v.is_empty()).or_else(||env("no_proxy")){values.push(("NO_PROXY".into(),bypass));}
        return Ok(ProxyRoute{source:"environment",env:values});
    }
    if let Some(value)=system()? {validate_url(&value,true)?;return Ok(ProxyRoute{source:"windows-system",env:vec![("CONTROL_PLANE_HTTP_PROXY".into(),value)]});}
    Ok(ProxyRoute{source:"direct",env:vec![]})
}
#[cfg(not(windows))]
fn system_proxy()->Result<Option<String>,String>{Ok(None)}
#[cfg(windows)]
fn system_proxy()->Result<Option<String>,String>{
    // PAC discovery can block inside WinHTTP. Bound the caller independently
    // of OS timeouts; the worker owns all returned buffers and handles.
    let (send,receive)=std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move||{let _=send.send(read_windows_proxy());});
    receive.recv_timeout(std::time::Duration::from_secs(5)).map_err(|_|"tunnel_proxy_auto_config".to_string())?
}
#[cfg(windows)]
fn read_windows_proxy()->Result<Option<String>,String>{
    use windows_sys::Win32::{Networking::WinHttp::*,Foundation::GlobalFree};
    unsafe {
        let read=|p:*mut u16| {if p.is_null(){return String::new();}let mut n=0;while n<32768&&*p.add(n)!=0{n+=1;}String::from_utf16_lossy(std::slice::from_raw_parts(p,n))};
        let free=|p:*mut u16|{if !p.is_null(){GlobalFree(p.cast());}};
        let mut config:WINHTTP_CURRENT_USER_IE_PROXY_CONFIG=std::mem::zeroed();
        if WinHttpGetIEProxyConfigForCurrentUser(&mut config)==0{return Err("tunnel_system_proxy_unavailable".into());}
        let server=read(config.lpszProxy);let bypass=read(config.lpszProxyBypass);let pac=read(config.lpszAutoConfigUrl);
        let automatic=config.fAutoDetect!=0;free(config.lpszProxy);free(config.lpszProxyBypass);free(config.lpszAutoConfigUrl);
        resolve_windows_proxy_config(&server,&bypass,&pac,automatic)
    }
}
#[cfg(windows)]
fn resolve_windows_proxy_config(server:&str,bypass:&str,pac:&str,automatic:bool)->Result<Option<String>,String>{
    use windows_sys::Win32::{Networking::WinHttp::*,Foundation::{GlobalFree,GetLastError}};
    unsafe {
        let read=|p:*mut u16| {if p.is_null(){return String::new();}let mut n=0;while n<32768&&*p.add(n)!=0{n+=1;}String::from_utf16_lossy(std::slice::from_raw_parts(p,n))};
        let free=|p:*mut u16|{if !p.is_null(){GlobalFree(p.cast());}};
        let wide=|s:&str|s.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
        if pac.is_empty()&&(!automatic||!server.trim().is_empty()){return windows_static_proxy(server,bypass,false);}
        let session=WinHttpOpen(wide("Leaf tunnel proxy resolution").as_ptr(),WINHTTP_ACCESS_TYPE_NO_PROXY,std::ptr::null(),std::ptr::null(),0);
        if session.is_null(){return Err("tunnel_proxy_auto_config".into());}
        WinHttpSetTimeouts(session,1500,1500,1500,1500);
        let pac_wide=wide(pac);let mut options:WINHTTP_AUTOPROXY_OPTIONS=std::mem::zeroed();
        if !pac.is_empty(){options.dwFlags=WINHTTP_AUTOPROXY_CONFIG_URL;options.lpszAutoConfigUrl=pac_wide.as_ptr();}
        else{options.dwFlags=WINHTTP_AUTOPROXY_AUTO_DETECT;options.dwAutoDetectFlags=WINHTTP_AUTO_DETECT_TYPE_DHCP|WINHTTP_AUTO_DETECT_TYPE_DNS_A;}
        // Do not send ambient Windows credentials to a PAC server.
        options.fAutoLogonIfChallenged=0;
        let mut result:WINHTTP_PROXY_INFO=std::mem::zeroed();
        let success=WinHttpGetProxyForUrl(session,wide("https://api.openai.com").as_ptr(),&mut options,&mut result)!=0;
        let error=GetLastError();WinHttpCloseHandle(session);
        let resolved=read(result.lpszProxy);let exclusions=read(result.lpszProxyBypass);free(result.lpszProxy);free(result.lpszProxyBypass);
        if success {
            return if result.dwAccessType==WINHTTP_ACCESS_TYPE_NO_PROXY{Ok(None)}else{windows_static_proxy(resolved.split(';').next().unwrap_or(""),&exclusions,false)};
        }
        // Windows falls back to its configured static route when WPAD finds
        // no PAC. A configured PAC failing to load is an actionable error.
        if pac.is_empty()&&error==ERROR_WINHTTP_AUTODETECTION_FAILED{return windows_static_proxy(&server,&bypass,false);}
        Err("tunnel_proxy_auto_config".into())
    }
}
#[cfg(any(windows,test))]
fn windows_static_proxy(server:&str,bypass:&str,automatic:bool)->Result<Option<String>,String>{
    // Interpret WinINET's protocol map for the fixed HTTPS control-plane host.
    // PAC/WPAD must not silently fall back to direct: offer the explicit field.
    if server.trim().is_empty(){return if automatic{Err("tunnel_proxy_auto_config".into())}else{Ok(None)};}
    if bypass.split(';').any(|p|wildcard(p.trim().to_ascii_lowercase().as_bytes(),b"api.openai.com")||wildcard(p.trim().to_ascii_lowercase().as_bytes(),b"api.openai.com:443")){return Ok(None);}
    let raw=if server.contains('='){server.split(';').filter_map(|part|part.trim().split_once('=')).find(|(scheme,_)|scheme.eq_ignore_ascii_case("https")).map(|(_,value)|value.trim())}else{Some(server.trim())};
    let Some(raw)=raw.filter(|s|!s.is_empty()) else{return Ok(None);};
    let url=if raw.contains("://"){raw.to_owned()}else{format!("http://{raw}")};validate_url(&url,true)?;Ok(Some(url))
}
#[cfg(any(windows,test))]
fn wildcard(pattern:&[u8],value:&[u8])->bool {
    let (mut p,mut v,mut star,mut back)=(0,0,None,0);
    while v<value.len(){
        if p<pattern.len()&&pattern[p]==value[v]{p+=1;v+=1;}
        else if p<pattern.len()&&pattern[p]==b'*'{star=Some(p);p+=1;back=v;}
        else if let Some(at)=star{back+=1;v=back;p=at+1;}
        else{return false;}
    }
    while p<pattern.len()&&pattern[p]==b'*'{p+=1;}p==pattern.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[test] fn tunnel_windows_pac_resolves_without_changing_system_settings(){
        use std::io::{Read,Write};
        // Directly give WinHTTP a disposable PAC URL; never set system PAC.
        for result in ["PROXY proxy.example:9123; DIRECT","DIRECT"] {
            let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();listener.set_nonblocking(true).unwrap();
            let pac=format!("http://127.0.0.1:{}/proxy.pac",listener.local_addr().unwrap().port());
            let body=format!("function FindProxyForURL(url, host) {{ return '{result}'; }}");
            let worker=std::thread::spawn(move||{
                let start=std::time::Instant::now();
                loop {if let Ok((mut socket,_))=listener.accept(){
                    socket.set_read_timeout(Some(std::time::Duration::from_secs(2))).unwrap();let mut request=[0;4096];let _=socket.read(&mut request);
                    let response=format!("HTTP/1.0 200 OK\r\nContent-Type: application/x-ns-proxy-autoconfig\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
                    socket.write_all(response.as_bytes()).unwrap();break;
                }if start.elapsed()>std::time::Duration::from_secs(10){break;}std::thread::sleep(std::time::Duration::from_millis(10));}
            });
            let route=resolve_windows_proxy_config("","",&pac,false);worker.join().unwrap();
            assert_eq!(route.unwrap(),if result=="DIRECT"{None}else{Some("http://proxy.example:9123".into())});
        }
    }
    #[test] fn precedence_bypass_and_secret_boundaries(){
        let route=resolve_with("http://127.0.0.1:12345", |_|Some("invalid".into()),||panic!("explicit wins")).unwrap();assert_eq!(route.source,"explicit");
        let route=resolve_with("",|n|match n{"https_proxy"=>Some("http://user:secret@proxy.example:8901".into()),"no_proxy"=>Some("localhost,.example.org".into()),_=>None},||panic!("environment wins")).unwrap();
        assert_eq!(route.source,"environment");assert_eq!(route.env[1].1,"localhost,.example.org");
        assert!(validate_explicit("http://user:secret@proxy.example:8901").is_err());
        for bad in ["socks5://localhost:12345","http://proxy.example/?token=secret","http://proxy.example/#secret","http://proxy.example/path"]{assert!(validate_explicit(bad).is_err());}
        assert!(resolve_with("",|n|(n=="HTTPS_PROXY").then(||"broken".into()),||Ok(None)).is_err(),"invalid proxy never silently becomes direct");
        assert_eq!(resolve_with("",|_|None,||Ok(None)).unwrap().source,"direct");
    }
    #[test] fn windows_existing_settings_are_read_only_and_https_specific(){
        assert_eq!(windows_static_proxy("http=other:8000;https=proxy.example:9911","<local>;*.example.org",false).unwrap(),Some("http://proxy.example:9911".into()));
        assert_eq!(windows_static_proxy("127.0.0.1:9911","*.openai.com",false).unwrap(),None);
        assert_eq!(windows_static_proxy("127.0.0.1:9911","<local>",false).unwrap(),Some("http://127.0.0.1:9911".into()));
        assert!(windows_static_proxy("","",true).is_err());
    }
}
