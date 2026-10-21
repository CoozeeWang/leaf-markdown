//! Rewrite only destinations recognized by CommonMark, preserving source bytes.
//! Shared JS/Rust fixtures guard the contract with the frontend Lezer parser.
use pulldown_cmark::{Event, LinkType, Parser, Tag};
use std::ops::Range;

fn destination(text: &str, mut at: usize) -> Option<Range<usize>> {
    let bytes=text.as_bytes();
    while bytes.get(at).is_some_and(u8::is_ascii_whitespace) {at+=1;}
    if bytes.get(at)==Some(&b'<') {
        let start=at+1;at=start;
        while at<bytes.len() {if bytes[at]==b'>' {return Some(start..at);} if bytes[at]==b'\\' {at+=1;} at+=1;}
        return None;
    }
    let start=at;let mut depth=0;
    while at<bytes.len() {
        match bytes[at] {
            b'\\'=>{at+=1;if at>=bytes.len(){return None;}},
            b'('=>depth+=1,
            b')'=>{if depth==0 {break;} depth-=1;},
            ch if ch.is_ascii_whitespace()=>break,
            _=>{}
        }
        at+=1;
    }
    Some(start..at)
}
fn inline_tail(text:&str,end:usize)->bool {
    let mut tail=&text[end..];
    if tail.starts_with('>') {tail=&tail[1..];}
    if tail==")" {return true;}
    let trimmed=tail.trim_start();
    if trimmed.len()==tail.len() {return false;}
    if trimmed==")" {return true;}
    let Some(open)=trimmed.as_bytes().first().copied() else{return false;};
    let close=match open {b'\''=>b'\'',b'"'=>b'"',b'('=>b')',_=>return false};
    let b=trimmed.as_bytes();let mut at=1;
    while at<b.len() {
        if b[at]==b'\\' {at+=2;continue;}
        if b[at]==close {return trimmed[at+1..].trim()==")";}
        at+=1;
    }
    false
}
fn encoded(name:&str)->String {
    name.as_bytes().iter().map(|b|if b.is_ascii_alphanumeric()||b"-_.~!\'()*".contains(b){(*b as char).to_string()}else{format!("%{b:02X}")}).collect()
}
pub fn rewrite(content:&str,mappings:&[(String,String)])->String {
    let parser=Parser::new(content);let mut ranges=Vec::new();
    for (_,definition) in parser.reference_definitions().iter() {
        let span=definition.span.clone();let text=&content[span.clone()];
        // The parser already established that this is a definition, not prose
        // or code. Find the closing label and optional whitespace after ':'.
        for (at,_) in text.match_indices("]:") {
            if let Some(url)=destination(text,at+2) {
                if &text[url.clone()]==definition.dest.as_ref() {ranges.push(span.start+url.start..span.start+url.end);break;}
            }
        }
    }
    for (event,span) in parser.into_offset_iter() {
        if let Event::Start(Tag::Link{link_type:LinkType::Inline,dest_url,..}|Tag::Image{link_type:LinkType::Inline,dest_url,..})=event {
            let text=&content[span.clone()];
            for (at,_) in text.match_indices("](") {
                if let Some(url)=destination(text,at+2) {
                    if &text[url.clone()]==dest_url.as_ref()&&inline_tail(text,url.end) {
                        ranges.push(span.start+url.start..span.start+url.end);break;
                    }
                }
            }
        }
    }
    ranges.sort_by_key(|r|r.start);ranges.dedup();let mut result=content.to_owned();
    for range in ranges.into_iter().rev() {
        let raw=&content[range.clone()];
        let replacement=mappings.iter().find_map(|(old,new)| {
            let encode_path=|path:&str|path.split('/').map(encoded).collect::<Vec<_>>().join("/");
            let link_path=|path:&str|path.replace(' ',"%20").replace('(',"%28").replace(')',"%29");
            [(old.clone(),new.clone()),(encode_path(old),encode_path(new)),(link_path(old),link_path(new))].into_iter().find_map(|(old,new)|if raw==old {Some(new)}else{None})
        });
        if let Some(replacement)=replacement {result.replace_range(range,&replacement);}
    }
    result
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn shared_resource_rewrite_contract() {
        let cases:serde_json::Value=serde_json::from_str(include_str!("../../tests/fixtures/resource-rewrite.json")).unwrap();
        for case in cases.as_array().unwrap() {
            let mappings:Vec<(String,String)>=serde_json::from_value(case["mappings"].clone()).unwrap();
            assert_eq!(rewrite(case["source"].as_str().unwrap(),&mappings),case["expected"].as_str().unwrap(),"{}",case["name"]);
        }
    }
}
