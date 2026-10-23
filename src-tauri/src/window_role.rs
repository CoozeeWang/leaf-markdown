//! One native identity model for every Leaf window and ordinary quit intent.
use std::collections::HashSet;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowRole { Launcher, Document, Export, Update, Unknown }

pub fn role_for_label(label:&str)->WindowRole {
    match label {
        "main"=>WindowRole::Launcher,
        "desktop-update"=>WindowRole::Update,
        _ if label.strip_prefix("document-").is_some_and(|suffix|!suffix.is_empty())=>WindowRole::Document,
        _ if label.strip_prefix("export-").is_some_and(|suffix|!suffix.is_empty())=>WindowRole::Export,
        _=>WindowRole::Unknown,
    }
}
// The caller must additionally verify native registration and live window identity.
pub fn allows_command(role:WindowRole,command:&str)->bool {
    match role {
        WindowRole::Launcher=>!command.starts_with("update_") && command!="ordinary_quit_cancelled",
        WindowRole::Document=>!command.starts_with("update_"),
        WindowRole::Export=>matches!(command,"language_get"|"export_snapshot"|"print_export"|"read_resource"|"open_link"),
        WindowRole::Update=>matches!(command,"language_get"|"update_status"|"update_check"|"update_close"|"update_open_releases"|"update_start"|"update_resume"|"update_cancel_download"),
        WindowRole::Unknown=>false,
    }
}
pub fn allows_menu(role:WindowRole,command:&str)->bool {
    match role {
        WindowRole::Document=>true,
        WindowRole::Launcher=>matches!(command,"new"|"open"|"settings"),
        _=>false,
    }
}
struct QuitIntent { id:u64, participants:HashSet<String> }
#[derive(Default)]
pub struct OrdinaryQuit { next:u64, current:Option<QuitIntent> }
impl OrdinaryQuit {
    pub fn begin(&mut self,participants:HashSet<String>)->Result<u64,&'static str> {
        self.next=self.next.checked_add(1).filter(|n|*n<=9_007_199_254_740_991).ok_or("quit_sequence_exhausted")?;
        self.current=Some(QuitIntent{id:self.next,participants});Ok(self.next)
    }
    pub fn cancel(&mut self,id:u64,label:&str)->bool {
        if !self.current.as_ref().is_some_and(|intent|intent.id==id&&intent.participants.contains(label)) {return false;}
        self.current=None;true
    }
    pub fn destroyed(&mut self,label:&str)->bool {
        let Some(intent)=self.current.as_mut()else{return false;};
        if !intent.participants.remove(label) {return false;}
        if intent.participants.is_empty() {self.current=None;true}else{false}
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn classifies_known_native_windows_and_unknowns() {
        for (label,role) in [("main",WindowRole::Launcher),("document-1",WindowRole::Document),
            ("export-42",WindowRole::Export),("desktop-update",WindowRole::Update),
            ("unknown",WindowRole::Unknown),("document-",WindowRole::Unknown),
            ("desktop-update-2",WindowRole::Unknown)] {
            assert_eq!(role_for_label(label),role,"{label}");
        }
    }
    #[test]
    fn updater_authority_is_narrow_and_unknowns_fail_closed() {
        for command in ["language_get","update_status","update_check","update_close","update_open_releases","update_start","update_resume","update_cancel_download"] {
            assert!(allows_command(WindowRole::Update,command),"{command}");
            assert!(!allows_command(WindowRole::Unknown,command),"{command}");
        }
        for command in ["new_document","open_document","write_document","read_document","rename_document",
            "relocate_document","import_attachment","copy_pasted_images","recovery_checkpoint","recovery_delete",
            "recovery_open","open_export","export_bundle","mcp_register","mcp_authorize","mcp_configure_tunnel","language_set"] {
            assert!(!allows_command(WindowRole::Update,command),"{command}");
            assert!(!allows_command(WindowRole::Unknown,command),"{command}");
        }
        assert!(allows_command(WindowRole::Document,"write_document"));
        assert!(allows_command(WindowRole::Launcher,"new_document"));
        assert!(allows_command(WindowRole::Export,"export_snapshot"));
        assert!(allows_command(WindowRole::Export,"read_resource"));
        assert!(!allows_command(WindowRole::Export,"write_document"));
        assert!(!allows_command(WindowRole::Document,"update_status"));
    }
    #[test]
    fn document_menus_never_target_auxiliary_or_unknown_windows() {
        assert!(allows_menu(WindowRole::Document,"save"));
        assert!(allows_menu(WindowRole::Launcher,"new"));
        assert!(allows_menu(WindowRole::Launcher,"settings"));
        assert!(!allows_menu(WindowRole::Launcher,"save"));
        for role in [WindowRole::Export,WindowRole::Update,WindowRole::Unknown] {
            for command in ["new","save","undo","settings"] {assert!(!allows_menu(role,command));}
        }
    }
    #[test]
    fn ordinary_quit_cancellation_is_bound_to_current_generation_and_recipient() {
        let mut quit=OrdinaryQuit::default();
        let participants=["document-1".to_owned(),"document-2".to_owned()].into_iter().collect();
        let old=quit.begin(participants).unwrap();
        let new=quit.begin(["document-1".to_owned()].into_iter().collect()).unwrap();
        assert!(!quit.cancel(old,"document-1"));
        assert!(!quit.cancel(new,"desktop-update"));
        assert!(quit.cancel(new,"document-1"));
        assert!(!quit.destroyed("document-1"),"cancelled ordinary Quit has no exit authority");
        assert!(!quit.cancel(new,"document-1"),"duplicate cancellation is stale");
    }
    #[test]
    fn ordinary_quit_requires_every_fixed_native_participant_to_close() {
        let mut quit=OrdinaryQuit::default();
        quit.begin(["document-1".to_owned(),"document-2".to_owned()].into_iter().collect()).unwrap();
        assert!(!quit.destroyed("desktop-update"));
        assert!(!quit.destroyed("document-1"));
        assert!(!quit.destroyed("document-1"),"duplicate close cannot advance");
        assert!(quit.destroyed("document-2"));
        assert!(!quit.destroyed("document-2"),"exit authority is consumed once");
    }

}
