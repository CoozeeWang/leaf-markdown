// Bypass Microsoft Print to PDF: that driver truncates Unicode PDF titles.
// WebView2's PDF renderer keeps document.title as Unicode metadata.
use std::path::Path;
use webview2_com::{Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2Environment, ICoreWebView2Environment6, ICoreWebView2_7,
}, PrintToPdfCompletedHandler};
use windows::core::{Interface, PCWSTR};

// WebView2 dimensions are inches. Match Leaf's A4 / 18 mm paper rules.
pub unsafe fn start(
    environment: ICoreWebView2Environment,
    webview: ICoreWebView2,
    output: &Path,
    complete: Box<dyn FnOnce(windows::core::Result<bool>)>,
) -> windows::core::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    let settings = environment.cast::<ICoreWebView2Environment6>()?.CreatePrintSettings()?;
    settings.SetPageWidth(210.0 / 25.4)?;
    settings.SetPageHeight(297.0 / 25.4)?;
    settings.SetMarginTop(18.0 / 25.4)?;
    settings.SetMarginBottom(18.0 / 25.4)?;
    settings.SetMarginLeft(18.0 / 25.4)?;
    settings.SetMarginRight(18.0 / 25.4)?;
    settings.SetScaleFactor(1.0)?;
    settings.SetShouldPrintBackgrounds(true)?;
    settings.SetShouldPrintHeaderAndFooter(false)?;
    settings.SetShouldPrintSelectionOnly(false)?;
    let path: Vec<u16> = output.as_os_str().encode_wide().chain(Some(0)).collect();
    let callback = PrintToPdfCompletedHandler::create(Box::new(move |status, saved| {
        complete(status.map(|()| saved));
        Ok(())
    }));
    webview.cast::<ICoreWebView2_7>()?.PrintToPdf(PCWSTR(path.as_ptr()), &settings, &callback)
}
