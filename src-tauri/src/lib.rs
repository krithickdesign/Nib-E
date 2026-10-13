//! Nib-E desktop app.
//!
//! The window shows Nib-E's web app from inside the app bundle. There is no
//! network code here and the web view's security rules (tauri.conf.json, CSP)
//! allow no connections. Files are read and written only through the commands
//! below, and only files the person chose: in an Open or Save window, by
//! dropping them on Nib-E, or by opening them with Nib-E from the system. That list
//! is remembered (recent files) so the study library can reopen books.

use std::collections::{HashSet, VecDeque};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use percent_encoding::percent_decode_str;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, DragDropEvent, Emitter, Manager, State, WebviewWindow, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

/// Where "Get the latest version" points (set at build time; see .github/workflows/desktop.yml).
const WEBSITE: &str = match option_env!("NIB_WEBSITE") {
    Some(url) => url,
    None => "https://github.com/",
};

/// Feedback and survey form (Google Form), opened in the browser on request.
const FORM: &str = match option_env!("NIB_FORM") {
    Some(url) => url,
    None => "https://docs.google.com/forms/d/e/1FAIpQLSfy3FUAR3hxknKPvrZi9NFxmflDDaBQQIV0PNaT5af3yO8xDA/viewform",
};

/// Largest file Nib-E reads into memory.
const MAX_FILE: u64 = 2 * 1024 * 1024 * 1024;
/// How many recent files keep their permission across restarts.
const MAX_RECENT: usize = 400;

#[derive(Default)]
struct Files {
    allowed: Mutex<HashSet<PathBuf>>,
    recent: Mutex<VecDeque<PathBuf>>,
    store: Mutex<Option<PathBuf>>,
    /// Files opened before the window was ready (double-click on a PDF, Open with…).
    pending: Mutex<Vec<String>>,
}

/// The page has started and listens for files (set by `startup_files`).
static PAGE_READY: AtomicBool = AtomicBool::new(false);

/// Last time each window was asked to close (see the close handling in `run`).
static CLOSE_ASKED: Mutex<Vec<(String, u64)>> = Mutex::new(Vec::new());
/// Windows that may close without asking again (the page already asked).
static CLOSE_OK: Mutex<Vec<String>> = Mutex::new(Vec::new());
/// Numbering for extra windows ("Nib-E" logo → new window).
static WINDOW_NO: AtomicU64 = AtomicU64::new(1);

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// A stable form of a path (resolves `..`, symlinks and case where the file exists).
fn normal(p: &Path) -> PathBuf {
    if let Ok(c) = fs::canonicalize(p) {
        return c;
    }
    match (p.parent(), p.file_name()) {
        (Some(dir), Some(name)) => fs::canonicalize(dir).map(|d| d.join(name)).unwrap_or_else(|_| p.to_path_buf()),
        _ => p.to_path_buf(),
    }
}

impl Files {
    fn allow(&self, paths: &[PathBuf]) {
        let mut allowed = self.allowed.lock().unwrap();
        let mut recent = self.recent.lock().unwrap();
        for p in paths {
            let n = normal(p);
            allowed.insert(n.clone());
            recent.retain(|x| x != &n);
            recent.push_front(n);
        }
        while recent.len() > MAX_RECENT {
            if let Some(old) = recent.pop_back() {
                allowed.remove(&old);
            }
        }
        drop(allowed);
        let list: Vec<String> = recent.iter().map(|p| p.to_string_lossy().into_owned()).collect();
        drop(recent);
        if let Some(file) = self.store.lock().unwrap().as_ref() {
            if let Ok(json) = serde_json::to_vec(&list) {
                let _ = fs::write(file, json);
            }
        }
    }

    fn load(&self, file: PathBuf) {
        if let Ok(bytes) = fs::read(&file) {
            if let Ok(list) = serde_json::from_slice::<Vec<String>>(&bytes) {
                let mut allowed = self.allowed.lock().unwrap();
                let mut recent = self.recent.lock().unwrap();
                for s in list.into_iter().take(MAX_RECENT) {
                    let p = PathBuf::from(s);
                    allowed.insert(p.clone());
                    recent.push_back(p);
                }
            }
        }
        *self.store.lock().unwrap() = Some(file);
    }

    fn check(&self, p: &Path) -> Result<PathBuf, String> {
        let n = normal(p);
        if self.allowed.lock().unwrap().contains(&n) {
            Ok(n)
        } else {
            Err("Nib-E may only open files you chose. Open it with the Open button.".into())
        }
    }
}

fn is_pdf(p: &Path) -> bool {
    p.extension().map(|e| e.eq_ignore_ascii_case("pdf")).unwrap_or(false)
}

/// PDF paths from a command line (`Nib-E.exe file.pdf`, "Open with…").
fn pdf_args<I: IntoIterator<Item = String>>(args: I) -> Vec<PathBuf> {
    args.into_iter().map(PathBuf::from).filter(|p| is_pdf(p) && p.is_file()).collect()
}

/// Gives files to one window: the one they were dropped on, else the main
/// window, else any open window.
fn hand_over(app: &AppHandle, target: Option<&str>, paths: Vec<PathBuf>) {
    if paths.is_empty() {
        return;
    }
    let files = app.state::<Files>();
    files.allow(&paths);
    let list: Vec<String> = paths.iter().map(|p| normal(p).to_string_lossy().into_owned()).collect();
    if !PAGE_READY.load(Ordering::SeqCst) {
        files.pending.lock().unwrap().extend(list);
        return;
    }
    let windows = app.webview_windows();
    let label = target
        .filter(|l| windows.contains_key(*l))
        .map(|l| l.to_string())
        .or_else(|| windows.contains_key("main").then(|| "main".to_string()))
        .or_else(|| windows.keys().next().cloned());
    if let Some(label) = label {
        if let Some(w) = windows.get(&label) {
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
        let _ = app.emit_to(label.as_str(), "nib://open-paths", list);
    }
}

// ---------- commands ----------

#[tauri::command]
async fn pick_open(app: AppHandle, files: State<'_, Files>, multiple: bool) -> Result<Vec<String>, String> {
    let dialog = app.dialog().file().set_title("Open PDF").add_filter("PDF document", &["pdf", "PDF"]);
    let picked: Vec<PathBuf> = tauri::async_runtime::spawn_blocking(move || {
        if multiple {
            dialog.blocking_pick_files().unwrap_or_default().into_iter().filter_map(|f| f.into_path().ok()).collect()
        } else {
            dialog.blocking_pick_file().and_then(|f| f.into_path().ok()).into_iter().collect()
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    files.allow(&picked);
    Ok(picked.iter().map(|p| normal(p).to_string_lossy().into_owned()).collect())
}

#[tauri::command]
async fn pick_save(app: AppHandle, files: State<'_, Files>, name: String, ext: String, label: String) -> Result<Option<String>, String> {
    let mut dialog = app.dialog().file().set_title("Save").set_file_name(&name);
    if !ext.is_empty() {
        dialog = dialog.add_filter(&label, &[ext.as_str()]);
    }
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_save_file().and_then(|f| f.into_path().ok()))
        .await
        .map_err(|e| e.to_string())?;
    Ok(picked.map(|p| {
        files.allow(std::slice::from_ref(&p));
        normal(&p).to_string_lossy().into_owned()
    }))
}

#[tauri::command]
fn read_file(files: State<'_, Files>, path: String) -> Result<Response, String> {
    let p = files.check(Path::new(&path))?;
    let meta = fs::metadata(&p).map_err(|e| format!("Could not open the file: {e}"))?;
    if !meta.is_file() {
        return Err("That is not a file.".into());
    }
    if meta.len() > MAX_FILE {
        return Err("This file is too large to open (over 2 GB).".into());
    }
    let bytes = fs::read(&p).map_err(|e| format!("Could not read the file: {e}"))?;
    Ok(Response::new(bytes))
}

/// Writes a file safely: a temporary file next to it first, then a rename over
/// the original. If anything fails, the original is left as it was.
#[tauri::command]
fn write_file(files: State<'_, Files>, request: Request<'_>) -> Result<(), String> {
    let raw = request.headers().get("x-nib-path").and_then(|v| v.to_str().ok()).ok_or("Missing file path")?;
    let path = percent_decode_str(raw).decode_utf8().map_err(|_| "Bad file path")?.into_owned();
    let target = files.check(Path::new(&path))?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected file data".into());
    };
    let dir = target.parent().ok_or("Bad file path")?;
    let name = target.file_name().ok_or("Bad file path")?.to_string_lossy();
    let tmp = dir.join(format!(".{name}.nib-tmp"));
    let result = (|| -> std::io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, &target)
    })();
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(format!("Could not save the file: {e}"));
    }
    Ok(())
}

/// Files Nib-E was started with (double-click on a PDF, Open with…).
#[tauri::command]
fn startup_files(files: State<'_, Files>) -> Vec<String> {
    let mut pending = files.pending.lock().unwrap();
    PAGE_READY.store(true, Ordering::SeqCst);
    std::mem::take(&mut *pending)
}

#[tauri::command]
fn print_page(window: WebviewWindow) -> Result<(), String> {
    window.print().map_err(|e| e.to_string())
}

/// Opens the project website in the person's normal browser. Nib-E itself does not connect.
#[tauri::command]
fn open_website(app: AppHandle) -> Result<(), String> {
    app.opener().open_url(WEBSITE, None::<&str>).map_err(|e| e.to_string())
}

/// Opens the feedback / survey form in the person's normal browser. Only this
/// one address can be opened.
#[tauri::command]
fn open_form(app: AppHandle) -> Result<(), String> {
    app.opener().open_url(FORM, None::<&str>).map_err(|e| e.to_string())
}

/// Closes the window that asked (after the page dealt with unsaved work).
#[tauri::command]
fn close_app(window: WebviewWindow) {
    CLOSE_OK.lock().unwrap().push(window.label().to_string());
    let _ = window.close();
}

/// Opens another Nib-E window on the start page.
#[tauri::command]
async fn new_window(app: AppHandle) -> Result<(), String> {
    let label = format!("w{}", WINDOW_NO.fetch_add(1, Ordering::SeqCst));
    tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::App("index.html".into()))
        .title("Nib-E")
        .inner_size(1320.0, 860.0)
        .min_inner_size(420.0, 420.0)
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

// ---------- app ----------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // A second start (double-click on another PDF) hands its files to the running Nib-E.
    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            hand_over(app, None, pdf_args(argv.into_iter().skip(1)));
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Files::default())
        .setup(|app| {
            let files = app.state::<Files>();
            if let Ok(dir) = app.path().app_data_dir() {
                let _ = fs::create_dir_all(&dir);
                files.load(dir.join("recent-files.json"));
            }
            let start = pdf_args(std::env::args().skip(1));
            files.allow(&start);
            files.pending.lock().unwrap().extend(start.iter().map(|p| normal(p).to_string_lossy().into_owned()));
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) => {
                let pdfs: Vec<PathBuf> = paths.iter().filter(|p| is_pdf(p) && p.is_file()).cloned().collect();
                hand_over(window.app_handle(), Some(window.label()), pdfs);
            }
            WindowEvent::CloseRequested { api, .. } => {
                // Ask the page first (unsaved changes). A second close within 4 s
                // always closes, so Nib-E can never get stuck open.
                let label = window.label().to_string();
                {
                    let mut ok = CLOSE_OK.lock().unwrap();
                    if let Some(i) = ok.iter().position(|l| l == &label) {
                        ok.remove(i);
                        return;
                    }
                }
                let now = now_ms();
                let mut asked = CLOSE_ASKED.lock().unwrap();
                let last = asked.iter().find(|(l, _)| l == &label).map(|(_, t)| *t).unwrap_or(0);
                asked.retain(|(l, _)| l != &label);
                if now.saturating_sub(last) < 4000 {
                    return;
                }
                asked.push((label.clone(), now));
                drop(asked);
                api.prevent_close();
                let _ = window.emit_to(label.as_str(), "nib://close-requested", ());
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![pick_open, pick_save, read_file, write_file, startup_files, print_page, open_website, open_form, close_app, new_window])
        .build(tauri::generate_context!())
        .expect("error while starting Nib-E")
        .run(|app, event| {
            // macOS hands files over as an event, not on the command line.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = &event {
                let paths: Vec<PathBuf> = urls.iter().filter_map(|u| u.to_file_path().ok()).filter(|p| is_pdf(p)).collect();
                hand_over(app, None, paths);
            }
            let _ = (app, &event);
        });
}
