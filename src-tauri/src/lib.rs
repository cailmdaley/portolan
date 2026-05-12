use serde::Serialize;
use std::{
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

const BACKEND_HOST: &str = "127.0.0.1";
const BACKEND_PORT: u16 = 4004;
const BACKEND_URL: &str = "http://127.0.0.1:4004";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeStatus {
    app: NativeAppStatus,
    backend: BackendStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeAppStatus {
    product_name: String,
    version: String,
    profile: String,
    frontend_dist: String,
    project_root: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendStatus {
    url: String,
    reachable: bool,
    owner: String,
    launch_kind: String,
    pid: Option<u32>,
    started_at_unix: Option<u64>,
    last_error: Option<String>,
}

struct NativeState {
    backend: Mutex<BackendBridge>,
}

struct BackendBridge {
    owner: BackendOwner,
    launch_kind: String,
    started_at_unix: Option<u64>,
    last_error: Option<String>,
    child: Option<Child>,
}

#[derive(Clone, Copy)]
enum BackendOwner {
    App,
    External,
    Failed,
}

struct BackendLaunch {
    kind: &'static str,
    program: PathBuf,
    args: Vec<String>,
    cwd: PathBuf,
}

impl BackendBridge {
    fn start() -> Self {
        if backend_reachable() {
            return Self {
                owner: BackendOwner::External,
                launch_kind: "already-running".to_string(),
                started_at_unix: None,
                last_error: None,
                child: None,
            };
        }

        let launch = backend_launch();
        match launch.spawn() {
            Ok(child) => {
                let pid = child.id();
                let reachable = wait_for_backend(Duration::from_secs(8));
                Self {
                    owner: if reachable {
                        BackendOwner::App
                    } else {
                        BackendOwner::Failed
                    },
                    launch_kind: launch.kind.to_string(),
                    started_at_unix: Some(unix_now()),
                    last_error: if reachable {
                        None
                    } else {
                        Some(format!(
                            "spawned backend process {pid}, but {BACKEND_URL} did not become reachable"
                        ))
                    },
                    child: Some(child),
                }
            }
            Err(error) => Self {
                owner: BackendOwner::Failed,
                launch_kind: launch.kind.to_string(),
                started_at_unix: Some(unix_now()),
                last_error: Some(format!(
                    "failed to spawn `{}` in {}: {error}",
                    launch.program.display(),
                    launch.cwd.display()
                )),
                child: None,
            },
        }
    }

    fn status(&self) -> BackendStatus {
        BackendStatus {
            url: BACKEND_URL.to_string(),
            reachable: backend_reachable(),
            owner: self.owner.as_str().to_string(),
            launch_kind: self.launch_kind.clone(),
            pid: self.child.as_ref().map(Child::id),
            started_at_unix: self.started_at_unix,
            last_error: self.last_error.clone(),
        }
    }
}

impl Drop for BackendBridge {
    fn drop(&mut self) {
        if !matches!(self.owner, BackendOwner::App | BackendOwner::Failed) {
            return;
        }

        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl BackendOwner {
    fn as_str(self) -> &'static str {
        match self {
            BackendOwner::App => "app",
            BackendOwner::External => "external",
            BackendOwner::Failed => "failed",
        }
    }
}

impl BackendLaunch {
    fn spawn(&self) -> std::io::Result<Child> {
        Command::new(&self.program)
            .args(&self.args)
            .current_dir(&self.cwd)
            .env("PORTOLAN_NATIVE", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
    }
}

fn backend_launch() -> BackendLaunch {
    let cwd = project_root().join("server");
    let dist_entry = cwd.join("dist").join("index.js");

    if cfg!(debug_assertions) || !dist_entry.exists() {
        return BackendLaunch {
            kind: "npm-dev",
            program: resolve_program(
                "npm",
                &[
                    "/opt/homebrew/bin/npm",
                    "/usr/local/bin/npm",
                    "/usr/bin/npm",
                ],
            ),
            args: vec!["run".to_string(), "dev".to_string()],
            cwd,
        };
    }

    BackendLaunch {
        kind: "node-dist",
        program: resolve_program(
            "node",
            &[
                "/opt/homebrew/bin/node",
                "/usr/local/bin/node",
                "/usr/bin/node",
            ],
        ),
        args: vec!["dist/index.js".to_string()],
        cwd,
    }
}

fn resolve_program(name: &str, candidates: &[&str]) -> PathBuf {
    candidates
        .iter()
        .map(PathBuf::from)
        .find(|path| path.exists())
        .unwrap_or_else(|| PathBuf::from(name))
}

fn project_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri should live inside the Portolan repository")
        .to_path_buf()
}

fn backend_addr() -> SocketAddr {
    format!("{BACKEND_HOST}:{BACKEND_PORT}")
        .parse()
        .expect("Portolan backend address should be a valid socket address")
}

fn backend_reachable() -> bool {
    TcpStream::connect_timeout(&backend_addr(), Duration::from_millis(250)).is_ok()
}

fn wait_for_backend(timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if backend_reachable() {
            return true;
        }
        thread::sleep(Duration::from_millis(100));
    }
    false
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[tauri::command]
fn native_status(state: tauri::State<'_, NativeState>) -> NativeStatus {
    let backend = state.backend.lock().expect("native backend state poisoned");
    NativeStatus {
        app: NativeAppStatus {
            product_name: "Portolan".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            profile: if cfg!(debug_assertions) {
                "debug"
            } else {
                "release"
            }
            .to_string(),
            frontend_dist: "../dist".to_string(),
            project_root: project_root().display().to_string(),
        },
        backend: backend.status(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![native_status])
        .setup(|app| {
            app.manage(NativeState {
                backend: Mutex::new(BackendBridge::start()),
            });
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_addr_targets_portolan_backend() {
        assert_eq!(backend_addr().to_string(), "127.0.0.1:4004");
        assert_eq!(BACKEND_HOST, "127.0.0.1");
    }

    #[test]
    fn project_root_is_src_tauri_parent() {
        assert_eq!(
            project_root().join("src-tauri"),
            Path::new(env!("CARGO_MANIFEST_DIR"))
        );
    }

    #[test]
    fn backend_launch_uses_server_directory() {
        let launch = backend_launch();
        assert_eq!(launch.cwd, project_root().join("server"));
        assert!(matches!(launch.kind, "npm-dev" | "node-dist"));
    }

    #[test]
    fn resolve_program_falls_back_to_name() {
        assert_eq!(
            resolve_program("missing-portolan-tool", &["/definitely/missing"]),
            PathBuf::from("missing-portolan-tool")
        );
    }
}
