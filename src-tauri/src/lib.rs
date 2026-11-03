use std::sync::Mutex;

mod github;
mod pages;
mod publish;
mod watch;

use tauri::menu::{
    Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder,
};
use tauri::{AppHandle, Emitter, Manager, State, Wry};

#[derive(serde::Deserialize)]
struct RecentItem {
    /// Open spec (local path or mdviewer:// URL) used as the menu item id suffix.
    spec: String,
    label: String,
}

/// Files the OS asked us to open before the frontend was ready to receive events.
#[derive(Default)]
struct PendingFiles {
    paths: Vec<String>,
    frontend_ready: bool,
}

struct AppState(Mutex<PendingFiles>);

/// Allow the asset protocol to serve files (images) from a document's folder.
/// The static asset scope is empty; access is granted per opened document
/// instead of blanket filesystem access.
fn allow_assets_near(app: &AppHandle, path: &str) {
    if let Some(parent) = std::path::Path::new(path).parent() {
        let _ = app.asset_protocol_scope().allow_directory(parent, true);
    }
}

#[tauri::command]
fn read_file(app: AppHandle, path: String) -> Result<String, String> {
    let contents =
        std::fs::read_to_string(&path).map_err(|e| format!("Could not read {path}: {e}"))?;
    allow_assets_near(&app, &path);
    Ok(contents)
}

#[tauri::command]
fn write_file(app: AppHandle, path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("Could not write {path}: {e}"))?;
    allow_assets_near(&app, &path);
    Ok(())
}

/// Single-quote a path for a remote POSIX shell, leaving a leading `~/` (home)
/// unquoted so the remote shell still expands it.
fn shell_quote(path: &str) -> String {
    let quote = |s: &str| format!("'{}'", s.replace('\'', "'\\''"));
    if path == "~" {
        "~".to_string()
    } else if let Some(rest) = path.strip_prefix("~/") {
        format!("~/{}", quote(rest))
    } else {
        quote(path)
    }
}

#[derive(serde::Serialize)]
struct SearchHit {
    path: String,
    line: u32,
    text: String,
}

/// Matches per file and files per search are capped; a line is cut to this.
const SEARCH_MAX_PER_FILE: &str = "50";
const SEARCH_MAX_FILES: usize = 500;
const SEARCH_LINE_CHARS: usize = 400;

fn grep_flags(case_sensitive: bool, whole_word: bool, regex: bool) -> Vec<&'static str> {
    // -I skips binary files, -s missing ones (a recent file may be gone).
    let mut flags = vec!["-n", "-H", "-I", "-s", "-m", SEARCH_MAX_PER_FILE];
    flags.push(if regex { "-E" } else { "-F" });
    if !case_sensitive {
        flags.push("-i");
    }
    if whole_word {
        flags.push("-w");
    }
    flags
}

/// `grep -n -H` output to hits. A path may contain `:`, so a line is split
/// after the longest searched path it starts with, else at the first `:N:`.
fn parse_grep(out: &str, paths: &[String]) -> Vec<SearchHit> {
    let mut hits = Vec::new();
    for line in out.lines() {
        let known = paths
            .iter()
            .filter(|p| line.len() > p.len() && line.starts_with(p.as_str()) && line.as_bytes()[p.len()] == b':')
            .max_by_key(|p| p.len());
        let (path, rest) = match known {
            Some(p) => (p.clone(), &line[p.len() + 1..]),
            None => match line.match_indices(':').find(|(i, _)| {
                let tail = &line[i + 1..];
                let digits = tail.bytes().take_while(u8::is_ascii_digit).count();
                digits > 0 && tail.as_bytes().get(digits) == Some(&b':')
            }) {
                Some((i, _)) => (line[..i].to_string(), &line[i + 1..]),
                None => continue,
            },
        };
        let Some((num, text)) = rest.split_once(':') else { continue };
        let Ok(line_no) = num.parse() else { continue };
        hits.push(SearchHit { path, line: line_no, text: text.chars().take(SEARCH_LINE_CHARS).collect() });
    }
    hits
}

/// Search files for a word or phrase with `grep`: local files directly, a
/// remote host's files in one `grep` over its (shared) ssh connection.
#[tauri::command]
async fn search_files(
    host: Option<String>,
    paths: Vec<String>,
    pattern: String,
    case_sensitive: bool,
    whole_word: bool,
    regex: bool,
) -> Result<Vec<SearchHit>, String> {
    if pattern.is_empty() || paths.is_empty() {
        return Ok(vec![]);
    }
    if let Some(h) = &host {
        if github::is_github(h) {
            return Err("GitHub files are searched when opened".into());
        }
        validate_host(h)?;
    }
    let paths: Vec<String> = paths.into_iter().take(SEARCH_MAX_FILES).collect();
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<SearchHit>, String> {
        let flags = grep_flags(case_sensitive, whole_word, regex);
        let out = match &host {
            None => {
                let output = std::process::Command::new("/usr/bin/grep")
                    .args(&flags)
                    .arg("-e")
                    .arg(&pattern)
                    .arg("--")
                    .args(&paths)
                    .output()
                    .map_err(|e| format!("Could not run grep: {e}"))?;
                // 0: matches, 1: none; 2 also covers a missing file, whose
                // matches in the other files are still printed.
                if output.status.code() == Some(2) && output.stdout.is_empty() && !output.stderr.is_empty() && regex {
                    return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
                }
                output.stdout
            }
            Some(h) => {
                let quote = |s: &str| format!("'{}'", s.replace('\'', "'\\''"));
                let files: Vec<String> = paths.iter().map(|p| shell_quote(p)).collect();
                // `; true`: grep's own exit codes stay out of ssh's, so 255
                // means the connection failed. Output is capped.
                let remote = format!(
                    "grep {} -e {} -- {} 2>/dev/null | head -c 4000000; true",
                    flags.join(" "),
                    quote(&pattern),
                    files.join(" ")
                );
                let output = ssh_run(h, &remote).map_err(|e| format!("Could not run ssh: {e}"))?;
                if !output.status.success() {
                    return Err(format!("Could not reach {h}: {}", String::from_utf8_lossy(&output.stderr).trim()));
                }
                output.stdout
            }
        };
        Ok(parse_grep(&String::from_utf8_lossy(&out), &paths))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Reject anything that isn't a plain `[user@]host` token. Critically this
/// blocks a leading `-`, which `ssh` would otherwise treat as an option
/// (e.g. `-oProxyCommand=…` = arbitrary command execution) — reachable via the
/// mdviewer:// URL scheme, so this is a hard gate, not just hygiene.
fn validate_host(host: &str) -> Result<(), String> {
    let ok = !host.is_empty()
        && !host.starts_with('-')
        && host.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '@' | ':' | '[' | ']')
        });
    if ok {
        Ok(())
    } else {
        Err(format!("Invalid SSH host: {host:?}"))
    }
}

fn ssh_base() -> std::process::Command {
    let mut cmd = std::process::Command::new("ssh");
    cmd.arg("-o").arg("ConnectTimeout=20").arg("-o").arg("BatchMode=yes");
    cmd.args(mux_opts());
    cmd
}

/// Share one connection per host (ssh multiplexing). Every read, stat and
/// listing otherwise opens its own connection: slow through a ProxyCommand,
/// and publishing many files at once can trip the proxy's or sshd's
/// connection limits ("Connection timed out during banner exchange").
fn mux_opts() -> Vec<String> {
    match control_dir() {
        Some(dir) => vec![
            "-o".into(),
            "ControlMaster=auto".into(),
            "-o".into(),
            format!("ControlPath={dir}/%C"),
            "-o".into(),
            "ControlPersist=120".into(),
        ],
        None => vec![],
    }
}

/// `/tmp/openmd-ssh-<uid>`, private to this user (short, for the socket path
/// limit). If it can't be made safely (someone else's, a symlink, open
/// permissions), connections just aren't shared.
fn control_dir() -> Option<&'static str> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    static DIR: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    DIR.get_or_init(|| {
        let uid = std::fs::metadata(std::env::var_os("HOME")?).ok()?.uid();
        let dir = format!("/tmp/openmd-ssh-{uid}");
        let _ = std::fs::DirBuilder::new().mode(0o700).create(&dir);
        let meta = std::fs::symlink_metadata(&dir).ok()?;
        let private = meta.is_dir() && meta.uid() == uid && meta.permissions().mode() & 0o077 == 0;
        private.then_some(dir)
    })
    .as_deref()
}

/// Run `remote` on `host`, retrying when the connection itself failed (ssh
/// exits 255 with a connection error), never when the remote command did.
fn ssh_run(host: &str, remote: &str) -> std::io::Result<std::process::Output> {
    const TRANSIENT: [&str; 7] = [
        "banner exchange",
        "Connection timed out",
        "Operation timed out",
        "Connection closed",
        "Connection reset",
        "kex_exchange_identification",
        "Broken pipe",
    ];
    let mut delays = [1u64, 3].into_iter();
    loop {
        // `--` ends ssh option parsing; the host can never be read as a flag.
        let output = ssh_base().arg("--").arg(host).arg(remote).output()?;
        let err = String::from_utf8_lossy(&output.stderr);
        let transient = output.status.code() == Some(255) && TRANSIENT.iter().any(|t| err.contains(t));
        match delays.next() {
            Some(secs) if transient => std::thread::sleep(std::time::Duration::from_secs(secs)),
            _ => return Ok(output),
        }
    }
}

/// A file's real path (symlinks resolved), so one file has one identity
/// however it was opened (`/home/me` vs `/local/home/me`). Remote: `readlink
/// -f` over ssh. Anything that can't be resolved comes back as given.
#[tauri::command]
async fn real_path(host: Option<String>, path: String) -> Result<String, String> {
    let Some(host) = host else {
        return Ok(std::fs::canonicalize(&path)
            .map(|p| p.display().to_string())
            .unwrap_or(path));
    };
    if github::is_github(&host) {
        return Ok(path);
    }
    validate_host(&host)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let output = ssh_run(&host, &format!("readlink -f -- {} 2>/dev/null", shell_quote(&path)))
            .map_err(|e| format!("Could not run ssh: {e}"))?;
        let real = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(if output.status.success() && real.starts_with('/') { real } else { path })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A cheap change signature for a remote file: modification time and size.
/// GNU `stat -c` first, BSD `stat -f` as the fallback (macOS remotes).
#[tauri::command]
async fn remote_stat(host: String, path: String) -> Result<String, String> {
    if github::is_github(&host) {
        return github::blocking(move || github::stat(&host, &path)).await;
    }
    validate_host(&host)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let q = shell_quote(&path);
        let output = ssh_run(&host, &format!("stat -c '%Y %s' -- {q} 2>/dev/null || stat -f '%m %z' -- {q}"))
            .map_err(|e| format!("Could not run ssh: {e}"))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Images referenced by a remote document are fetched for the preview; cap the
/// size so a stray link to a huge file can't stall the app.
const REMOTE_IMAGE_LIMIT: usize = 25 * 1024 * 1024;

/// Read a remote file's raw bytes (images in remote documents), base64-encoded
/// for the trip to the webview.
#[tauri::command]
async fn read_remote_bytes(host: String, path: String) -> Result<String, String> {
    use base64::Engine;
    if github::is_github(&host) {
        let bytes = github::blocking(move || github::read_bytes(&host, &path, REMOTE_IMAGE_LIMIT)).await?;
        return Ok(base64::engine::general_purpose::STANDARD.encode(bytes));
    }
    validate_host(&host)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let output = ssh_run(&host, &format!("head -c {} -- {}", REMOTE_IMAGE_LIMIT + 1, shell_quote(&path)))
            .map_err(|e| format!("Could not run ssh: {e}"))?;
        if !output.status.success() {
            return Err(format!("Could not read {host}:{path}: {}", String::from_utf8_lossy(&output.stderr).trim()));
        }
        if output.stdout.len() > REMOTE_IMAGE_LIMIT {
            return Err(format!("{host}:{path} is larger than 25 MB"));
        }
        Ok(base64::engine::general_purpose::STANDARD.encode(&output.stdout))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Read a file from a remote host over SSH (`ssh HOST cat -- PATH`).
#[tauri::command]
async fn read_remote(host: String, path: String) -> Result<String, String> {
    if github::is_github(&host) {
        return github::blocking(move || github::read(&host, &path)).await;
    }
    validate_host(&host)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let output = ssh_run(&host, &format!("cat -- {}", shell_quote(&path)))
            .map_err(|e| format!("Could not run ssh: {e}"))?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "Could not read {host}:{path}\n{}",
                err.trim()
            ));
        }
        String::from_utf8(output.stdout).map_err(|_| "File is not valid UTF-8".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
struct RemoteEntry {
    name: String,
    #[serde(rename = "isDir")]
    is_dir: bool,
}

#[derive(serde::Serialize)]
struct RemoteListing {
    /// Absolute, resolved directory (`~` expanded by the remote shell).
    dir: String,
    entries: Vec<RemoteEntry>,
}

/// List a remote directory over SSH, for the remote file browser. Prints the
/// resolved directory, then one entry per line; `ls -p` marks directories with
/// a trailing `/` and `-L` follows symlinks so linked folders browse as folders.
#[tauri::command]
async fn list_remote(host: String, path: String) -> Result<RemoteListing, String> {
    if github::is_github(&host) {
        let (dir, entries) = github::blocking(move || github::list(&host, &path)).await?;
        let entries = entries.into_iter().map(|(name, is_dir)| RemoteEntry { name, is_dir }).collect();
        return Ok(RemoteListing { dir, entries });
    }
    validate_host(&host)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<RemoteListing, String> {
        let q = shell_quote(if path.is_empty() { "~" } else { &path });
        let output = ssh_run(&host, &format!("cd -- {q} && pwd && {{ ls -1ApL 2>/dev/null || true; }}"))
            .map_err(|e| format!("Could not run ssh: {e}"))?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Could not list {host}:{path}\n{}", err.trim()));
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let mut lines = text.lines();
        let dir = lines.next().unwrap_or("/").to_string();
        let entries = lines
            .filter(|l| !l.is_empty())
            .map(|l| match l.strip_suffix('/') {
                Some(name) => RemoteEntry { name: name.to_string(), is_dir: true },
                None => RemoteEntry { name: l.to_string(), is_dir: false },
            })
            .collect();
        Ok(RemoteListing { dir, entries })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Create a remote folder and any missing parents (`mkdir -p`), for saving into
/// a folder that doesn't exist yet.
#[tauri::command]
async fn make_remote_dir(host: String, path: String) -> Result<(), String> {
    validate_host(&host)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let output = ssh_run(&host, &format!("mkdir -p -- {}", shell_quote(&path)))
            .map_err(|e| format!("Could not run ssh: {e}"))?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Could not create {host}:{path}\n{}", err.trim()));
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Copy local files or folders into a remote directory (drag-and-drop onto the
/// remote browser). Uses the system `scp`, so `~/.ssh/config` (aliases, keys,
/// ProxyCommand) applies, and binary files are fine.
#[tauri::command]
async fn upload_remote(host: String, local_paths: Vec<String>, dir: String) -> Result<(), String> {
    if github::is_github(&host) {
        return Err(github::READ_ONLY.into());
    }
    validate_host(&host)?;
    if local_paths.is_empty() {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let target = format!("{host}:{}/", dir.trim_end_matches('/'));
        let output = std::process::Command::new("/usr/bin/scp")
            .args(["-o", "ConnectTimeout=20", "-o", "BatchMode=yes", "-r", "-q"])
            .args(mux_opts())
            .arg("--")
            .args(&local_paths)
            .arg(&target)
            .output()
            .map_err(|e| format!("Could not run scp: {e}"))?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Could not copy to {target}\n{}", err.trim()));
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Copy a remote file or folder to a local path the user picked in a save
/// dialog (so macOS grants access without a privacy prompt). `scp -r`.
#[tauri::command]
async fn download_remote(host: String, remote_path: String, local_path: String) -> Result<(), String> {
    if github::is_github(&host) {
        return Err(github::READ_ONLY.into());
    }
    validate_host(&host)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let source = format!("{host}:{remote_path}");
        let output = std::process::Command::new("/usr/bin/scp")
            .args(["-o", "ConnectTimeout=20", "-o", "BatchMode=yes", "-r", "-q"])
            .args(mux_opts())
            .arg("--")
            .arg(&source)
            .arg(&local_path)
            .output()
            .map_err(|e| format!("Could not run scp: {e}"))?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Could not download {source}\n{}", err.trim()));
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Write a file to a remote host over SSH, atomically (temp file + mv).
#[tauri::command]
async fn write_remote(host: String, path: String, contents: String) -> Result<(), String> {
    use std::io::Write;
    use std::process::Stdio;

    if github::is_github(&host) {
        return Err(github::READ_ONLY.into());
    }
    validate_host(&host)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let q = shell_quote(&path);
        // Write to a sibling temp file, then atomically move it into place so a
        // dropped connection can't truncate the original. `mv --` guards against
        // a path that begins with `-`.
        let remote = format!("tmp={q}.mdtmp.$$; cat > \"$tmp\" && mv -f -- \"$tmp\" {q}");
        let mut child = ssh_base()
            // `--` ends ssh option parsing; the host can never be read as a flag.
            .arg("--")
            .arg(&host)
            .arg(remote)
            .stdin(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Could not run ssh: {e}"))?;

        child
            .stdin
            .take()
            .ok_or("Could not open ssh stdin")?
            .write_all(contents.as_bytes())
            .map_err(|e| e.to_string())?;

        let output = child
            .wait_with_output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Could not save {host}:{path}\n{}", err.trim()));
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Allow a single dropped/referenced image file to be served by the asset protocol.
#[tauri::command]
fn allow_asset(app: AppHandle, path: String) -> Result<(), String> {
    app.asset_protocol_scope()
        .allow_file(std::path::Path::new(&path))
        .map_err(|e| e.to_string())
}

/// Whether a local path exists (used to decide if a clicked file link is openable).
#[tauri::command]
fn path_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

/// Frontend startup errors land here so release builds (no devtools) are debuggable.
#[tauri::command]
fn log_error(message: String) {
    eprintln!("[frontend] {message}");
}

fn find_submenu_in(sub: &Submenu<Wry>, id: &str) -> Option<Submenu<Wry>> {
    for kind in sub.items().ok()? {
        if let Some(s) = kind.as_submenu() {
            if s.id().0 == id {
                return Some(s.clone());
            }
            if let Some(found) = find_submenu_in(s, id) {
                return Some(found);
            }
        }
    }
    None
}

fn find_submenu(menu: &Menu<Wry>, id: &str) -> Option<Submenu<Wry>> {
    for kind in menu.items().ok()? {
        if let Some(s) = kind.as_submenu() {
            if s.id().0 == id {
                return Some(s.clone());
            }
            if let Some(found) = find_submenu_in(s, id) {
                return Some(found);
            }
        }
    }
    None
}

/// Rebuild the File → Open Recent submenu from the frontend's recent list.
#[tauri::command]
fn set_recent_files(app: AppHandle, items: Vec<RecentItem>) -> Result<(), String> {
    let menu = app.menu().ok_or("application menu is not available")?;
    let submenu = find_submenu(&menu, "recent-menu").ok_or("recent menu not found")?;

    while let Ok(Some(_)) = submenu.remove_at(0) {}

    if items.is_empty() {
        let empty = MenuItemBuilder::with_id("recent-empty", "No Recent Files")
            .enabled(false)
            .build(&app)
            .map_err(|e| e.to_string())?;
        submenu.append(&empty).map_err(|e| e.to_string())?;
        return Ok(());
    }

    for item in &items {
        let entry = MenuItemBuilder::with_id(format!("recent:{}", item.spec), &item.label)
            .build(&app)
            .map_err(|e| e.to_string())?;
        submenu.append(&entry).map_err(|e| e.to_string())?;
    }
    submenu
        .append(&PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let clear = MenuItemBuilder::with_id("clear-recent", "Clear Menu")
        .build(&app)
        .map_err(|e| e.to_string())?;
    submenu.append(&clear).map_err(|e| e.to_string())?;
    Ok(())
}

fn find_menu_item(
    menu: &tauri::menu::Menu<tauri::Wry>,
    id: &str,
) -> Option<tauri::menu::MenuItem<tauri::Wry>> {
    if let Some(kind) = menu.get(id) {
        if let Some(item) = kind.as_menuitem() {
            return Some(item.clone());
        }
    }
    for kind in menu.items().ok()? {
        if let Some(submenu) = kind.as_submenu() {
            if let Some(found) = submenu.get(id) {
                if let Some(item) = found.as_menuitem() {
                    return Some(item.clone());
                }
            }
        }
    }
    None
}

/// Update menu item accelerators (configurable keybindings). An empty string
/// clears the accelerator.
#[tauri::command]
fn set_menu_accelerators(
    app: AppHandle,
    accelerators: std::collections::HashMap<String, String>,
) -> Result<(), String> {
    let Some(menu) = app.menu() else {
        return Err("application menu is not available".into());
    };
    for (id, accelerator) in accelerators {
        if let Some(item) = find_menu_item(&menu, &id) {
            let value: Option<&str> = if accelerator.is_empty() {
                None
            } else {
                Some(accelerator.as_str())
            };
            item.set_accelerator(value).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Called by the frontend once its event listeners are installed.
/// Returns any file paths that were requested before that point (Finder
/// "Open With", double-click on an associated file, CLI args).
#[tauri::command]
fn frontend_ready(state: State<'_, AppState>) -> Vec<String> {
    let mut pending = state.0.lock().unwrap();
    pending.frontend_ready = true;
    std::mem::take(&mut pending.paths)
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Make this app the default handler for Markdown files. Only meaningful for
/// the bundled release build (the dev binary has no registered bundle).
#[cfg(all(target_os = "macos", not(debug_assertions)))]
fn register_as_default_markdown_app() {
    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};

    #[link(name = "CoreServices", kind = "framework")]
    extern "C" {
        fn LSSetDefaultRoleHandlerForContentType(
            content_type: CFStringRef,
            role: u32,
            handler_bundle_id: CFStringRef,
        ) -> i32;
        fn LSSetDefaultHandlerForURLScheme(
            url_scheme: CFStringRef,
            handler_bundle_id: CFStringRef,
        ) -> i32;
    }

    const ROLES_ALL: u32 = 0xFFFF_FFFF;
    let bundle_id = CFString::new("com.oztalha.open-md");
    for uti in ["net.daringfireball.markdown", "public.markdown"] {
        let content_type = CFString::new(uti);
        unsafe {
            LSSetDefaultRoleHandlerForContentType(
                content_type.as_concrete_TypeRef(),
                ROLES_ALL,
                bundle_id.as_concrete_TypeRef(),
            );
        }
    }

    // Claim the mdviewer:// URL scheme (remote-file deep links).
    let scheme = CFString::new("mdviewer");
    unsafe {
        LSSetDefaultHandlerForURLScheme(
            scheme.as_concrete_TypeRef(),
            bundle_id.as_concrete_TypeRef(),
        );
    }
}

fn build_menu(app: &AppHandle) -> tauri::Result<()> {
    let app_menu = SubmenuBuilder::new(app, "Markdown")
        // Our own About window (not the predefined panel): macOS's native one
        // only shows plain text, so the project link couldn't be clickable.
        .item(&MenuItemBuilder::with_id("about", "About Markdown").build(app)?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("settings", "Settings…")
                .accelerator("CmdOrCtrl+,")
                .build(app)?,
        )
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .item(
            &MenuItemBuilder::with_id("quit", "Quit Markdown")
                .accelerator("CmdOrCtrl+Q")
                .build(app)?,
        )
        .build()?;

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(
            &MenuItemBuilder::with_id("new", "New")
                .accelerator("CmdOrCtrl+N")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("open", "Open…")
                .accelerator("CmdOrCtrl+O")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("open-remote", "Open Remote…")
                .accelerator("Shift+CmdOrCtrl+O")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("import-link", "Import from Link…")
                .accelerator("Shift+CmdOrCtrl+I")
                .build(app)?,
        )
        .item(
            &SubmenuBuilder::with_id(app, "recent-menu", "Open Recent")
                .item(
                    &MenuItemBuilder::with_id("recent-empty", "No Recent Files")
                        .enabled(false)
                        .build(app)?,
                )
                .build()?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("save", "Save")
                .accelerator("CmdOrCtrl+S")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("save-as", "Save As…")
                .accelerator("Alt+CmdOrCtrl+S")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("save-remote", "Save to Remote…")
                .accelerator("Shift+CmdOrCtrl+S")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("publish", "Publish…")
                .accelerator("Shift+CmdOrCtrl+P")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("open-published", "Open Published Page")
                .accelerator("Shift+CmdOrCtrl+L")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("published-list", "Published Documents…")
                .accelerator("CmdOrCtrl+P")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("export-html", "Export as HTML…")
                .accelerator("Shift+CmdOrCtrl+E")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("reload", "Reload")
                .accelerator("CmdOrCtrl+R")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("close-pane", "Close Tab")
                .accelerator("CmdOrCtrl+W")
                .build(app)?,
        )
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .item(
            &MenuItemBuilder::with_id("paste-plain", "Paste and Match Style")
                .accelerator("Shift+Alt+CmdOrCtrl+V")
                .build(app)?,
        )
        // Custom (not the predefined item): the native selectAll does nothing when
        // no text field has focus — e.g. in preview mode. The frontend picks the
        // right target (input, editor, or rendered preview).
        .item(
            &MenuItemBuilder::with_id("select-all", "Select All")
                .accelerator("CmdOrCtrl+A")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("find", "Find…")
                .accelerator("CmdOrCtrl+F")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("find-next", "Find Next")
                .accelerator("CmdOrCtrl+G")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("find-prev", "Find Previous")
                .accelerator("Shift+CmdOrCtrl+G")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("search-files", "Search in Files…")
                .accelerator("Shift+CmdOrCtrl+F")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("copy-path", "Copy Path")
                .accelerator("Shift+CmdOrCtrl+C")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("format", "Format Document")
                .accelerator("Shift+Alt+F")
                .build(app)?,
        )
        .build()?;

    let view_menu = SubmenuBuilder::new(app, "View")
        .item(
            &MenuItemBuilder::with_id("mode-editor", "Editor Only")
                .accelerator("Shift+CmdOrCtrl+7")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("mode-split", "Editor & Preview")
                .accelerator("Shift+CmdOrCtrl+8")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("mode-preview", "Preview Only")
                .accelerator("Shift+CmdOrCtrl+9")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("toggle-preview", "Toggle Editor / Preview")
                .accelerator("Shift+CmdOrCtrl+V")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("toggle-sidebar", "Toggle Sidebar")
                .accelerator("CmdOrCtrl+\\")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("show-files", "Files")
                .accelerator("Shift+CmdOrCtrl+1")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("toggle-outline", "Outline")
                .accelerator("Shift+CmdOrCtrl+0")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("toggle-line-numbers", "Line Numbers")
                .accelerator("Shift+CmdOrCtrl+N")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("zoom-in", "Zoom In")
                .accelerator("CmdOrCtrl+=")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("zoom-out", "Zoom Out")
                .accelerator("CmdOrCtrl+-")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("zoom-reset", "Actual Size")
                .accelerator("CmdOrCtrl+0")
                .build(app)?,
        )
        .build()?;

    // Browser-style tab navigation.
    let tabs_menu = SubmenuBuilder::new(app, "Tabs")
        .item(
            &MenuItemBuilder::with_id("focus-next", "Next Tab")
                .accelerator("Ctrl+Tab")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("focus-prev", "Previous Tab")
                .accelerator("Ctrl+Shift+Tab")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("tab-next", "Select Next Tab")
                .accelerator("Shift+CmdOrCtrl+]")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("tab-prev", "Select Previous Tab")
                .accelerator("Shift+CmdOrCtrl+[")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("tab-1", "Tab 1")
                .accelerator("CmdOrCtrl+1")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("tab-2", "Tab 2")
                .accelerator("CmdOrCtrl+2")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("tab-3", "Tab 3")
                .accelerator("CmdOrCtrl+3")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("tab-4", "Tab 4")
                .accelerator("CmdOrCtrl+4")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("tab-5", "Tab 5")
                .accelerator("CmdOrCtrl+5")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("tab-6", "Tab 6")
                .accelerator("CmdOrCtrl+6")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("tab-7", "Tab 7")
                .accelerator("CmdOrCtrl+7")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("tab-8", "Tab 8")
                .accelerator("CmdOrCtrl+8")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("tab-9", "Tab 9")
                .accelerator("CmdOrCtrl+9")
                .build(app)?,
        )
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .item(&PredefinedMenuItem::maximize(app, Some("Zoom"))?)
        .separator()
        .fullscreen()
        .build()?;

    let help_menu = SubmenuBuilder::new(app, "Help")
        .item(&MenuItemBuilder::with_id("help-github", "OpenMD on GitHub").build(app)?)
        .item(&MenuItemBuilder::with_id("help-issue", "Report an Issue…").build(app)?)
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &tabs_menu,
            &window_menu,
            &help_menu,
        ])
        .build()?;
    app.set_menu(menu)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// OpenMD was called md-viewer (app id `com.maxleiter.md-viewer`). On the
/// first launch under the new id, bring its data along: the webview's storage
/// (publish records and history, settings, recent files), the app's support
/// folder and `~/.config/md-viewer` (publish targets). Copies, never moves, so
/// an old copy of the app still works; runs before any window opens.
fn migrate_from_md_viewer() {
    let Some(home) = std::env::var_os("HOME").map(std::path::PathBuf::from) else { return };
    for (old, new) in [
        ("Library/WebKit/com.maxleiter.md-viewer", "Library/WebKit/com.oztalha.open-md"),
        ("Library/Application Support/com.maxleiter.md-viewer", "Library/Application Support/com.oztalha.open-md"),
        (".config/md-viewer", ".config/open-md"),
    ] {
        let (from, to) = (home.join(old), home.join(new));
        if from.is_dir() && !to.exists() {
            if let Err(err) = copy_dir(&from, &to) {
                eprintln!("could not copy {} to {}: {err}", from.display(), to.display());
            }
        }
    }
}

fn copy_dir(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let (src, dst) = (entry.path(), to.join(entry.file_name()));
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_dir(&src, &dst)?;
        } else if kind.is_symlink() {
            std::os::unix::fs::symlink(std::fs::read_link(&src)?, &dst)?;
        } else {
            std::fs::copy(&src, &dst)?;
        }
    }
    Ok(())
}

pub fn run() {
    migrate_from_md_viewer();
    tauri::Builder::default()
        // Must be the first plugin: a second launch (e.g. `mdv file.md`)
        // forwards its file/remote args to the running window instead of
        // spawning another app instance.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let specs: Vec<String> = argv
                .into_iter()
                .skip(1)
                .filter(|a| !a.starts_with('-'))
                .collect();
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
            if !specs.is_empty() {
                let _ = app.emit("open-files", specs);
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(AppState(Mutex::new(PendingFiles::default())))
        .manage(publish::SessionState::default())
        .manage(watch::WatchState::default())
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            read_remote,
            remote_stat,
            read_remote_bytes,
            watch::watch_files,
            list_remote,
            upload_remote,
            download_remote,
            publish::publish_targets,
            publish::publish_edit_config,
            publish::publish_config_read,
            publish::publish_config_write,
            publish::publish_write_temp,
            publish::publish_mcp_open,
            publish::publish_mcp_call,
            publish::publish_mcp_close,
            publish::publish_gist,
            publish::gist_exists,
            publish::link_status,
            pages::pages_status,
            pages::pages_list,
            pages::pages_live,
            pages::pages_delete,
            publish::gist_delete,
            pages::pages_base,
            pages::pages_commit,
            pages::pages_index_get,
            pages::pages_password_get,
            pages::pages_password_set,
            publish::publish_command,
            publish::publish_step_command,
            publish::publish_write_temp_bytes,
            publish::publish_upload_image,
            github::github_resolve_url,
            github::gh_accounts,
            write_remote,
            search_files,
            real_path,
            make_remote_dir,
            allow_asset,
            path_exists,
            log_error,
            set_recent_files,
            set_menu_accelerators,
            frontend_ready,
            quit_app
        ])
        .setup(|app| {
            // Files passed as CLI arguments (e.g. `markdown notes.md`).
            let args: Vec<String> = std::env::args()
                .skip(1)
                .filter(|a| !a.starts_with('-'))
                .collect();
            if !args.is_empty() {
                let state: State<'_, AppState> = app.state();
                state.0.lock().unwrap().paths.extend(args);
            }
            // A menu failure (e.g. an accelerator the OS rejects) shouldn't
            // prevent the app from starting.
            if let Err(err) = build_menu(app.handle()) {
                eprintln!("failed to build application menu: {err}");
            }
            #[cfg(all(target_os = "macos", not(debug_assertions)))]
            register_as_default_markdown_app();
            Ok(())
        })
        .on_menu_event(|app, event| {
            let _ = app.emit("menu", event.id().as_ref().to_string());
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // macOS: files opened via Finder ("Open With", double-click) arrive
            // as Apple events, not CLI args.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = event {
                // File opens arrive as file:// URLs; mdviewer:// deep links
                // (remote files) pass through as their raw string for the
                // frontend to classify.
                let paths: Vec<String> = urls
                    .iter()
                    .map(|u| {
                        u.to_file_path()
                            .map(|p| p.to_string_lossy().into_owned())
                            .unwrap_or_else(|_| u.to_string())
                    })
                    .collect();
                if paths.is_empty() {
                    return;
                }
                let state: State<'_, AppState> = app.state();
                let mut pending = state.0.lock().unwrap();
                if pending.frontend_ready {
                    drop(pending);
                    let _ = app.emit("open-files", paths);
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.set_focus();
                    }
                } else {
                    pending.paths.extend(paths);
                }
            }
        });
}

#[cfg(test)]
mod search_tests {
    #[test]
    fn grep_output_with_colons_in_paths() {
        let paths = vec!["/a/b.md".to_string(), "/x/notes: v2.md".to_string()];
        let out = "/a/b.md:3:hello: world\n/x/notes: v2.md:12:found it\n/other/c.md:7:x\n";
        let hits = super::parse_grep(out, &paths);
        assert_eq!(hits.len(), 3);
        assert_eq!((hits[0].path.as_str(), hits[0].line, hits[0].text.as_str()), ("/a/b.md", 3, "hello: world"));
        assert_eq!((hits[1].path.as_str(), hits[1].line), ("/x/notes: v2.md", 12));
        assert_eq!((hits[2].path.as_str(), hits[2].line), ("/other/c.md", 7));
    }
}
