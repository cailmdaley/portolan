use serde::Serialize;
use std::{
    io,
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
const BACKEND_SHUTDOWN_GRACE: Duration = Duration::from_secs(2);

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
    resource_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendStatus {
    url: String,
    reachable: bool,
    owner: String,
    launch_kind: String,
    process_group: bool,
    cwd: String,
    entry: Option<String>,
    resource_dir: Option<String>,
    pid: Option<u32>,
    started_at_unix: Option<u64>,
    last_error: Option<String>,
}

struct NativeState {
    backend: Mutex<BackendBridge>,
    resource_dir: Option<PathBuf>,
}

struct BackendBridge {
    owner: BackendOwner,
    launch: BackendLaunch,
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
    kind: String,
    program: PathBuf,
    args: Vec<String>,
    cwd: PathBuf,
    entry: Option<PathBuf>,
    resource_dir: Option<PathBuf>,
    process_group: bool,
}

impl BackendBridge {
    fn start(resource_dir: Option<PathBuf>) -> Self {
        Self::start_for_profile(resource_dir, cfg!(debug_assertions))
    }

    fn start_for_profile(resource_dir: Option<PathBuf>, debug: bool) -> Self {
        if backend_reachable() {
            let launch = backend_launch_for_profile(resource_dir, debug);
            return Self {
                owner: BackendOwner::External,
                launch,
                started_at_unix: None,
                last_error: None,
                child: None,
            };
        }

        let launch = backend_launch_for_profile(resource_dir, debug);
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
                    launch,
                    started_at_unix: Some(unix_now()),
                    last_error: if reachable {
                        None
                    } else {
                        Some(format!(
                            "spawned backend process {pid}, but {} did not become reachable",
                            backend_url()
                        ))
                    },
                    child: Some(child),
                }
            }
            Err(error) => {
                let last_error = Some(format!(
                    "failed to spawn `{}` in {}: {error}",
                    launch.program.display(),
                    launch.cwd.display()
                ));
                Self {
                    owner: BackendOwner::Failed,
                    launch,
                    started_at_unix: Some(unix_now()),
                    last_error,
                    child: None,
                }
            }
        }
    }

    fn status(&self) -> BackendStatus {
        BackendStatus {
            url: backend_url(),
            reachable: backend_reachable(),
            owner: self.owner.as_str().to_string(),
            launch_kind: self.launch.kind.clone(),
            process_group: backend_uses_process_group(),
            cwd: self.launch.cwd.display().to_string(),
            entry: self
                .launch
                .entry
                .as_ref()
                .map(|path| path.display().to_string()),
            resource_dir: self
                .launch
                .resource_dir
                .as_ref()
                .map(|path| path.display().to_string()),
            pid: self.child.as_ref().map(Child::id),
            started_at_unix: self.started_at_unix,
            last_error: self.last_error.clone(),
        }
    }

    fn shutdown(&mut self) {
        if !matches!(self.owner, BackendOwner::App | BackendOwner::Failed) {
            return;
        }

        if let Some(mut child) = self.child.take() {
            let _ = terminate_backend_child(&mut child);
        }
    }
}

impl Drop for BackendBridge {
    fn drop(&mut self) {
        self.shutdown();
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
        let mut command = Command::new(&self.program);
        command
            .args(&self.args)
            .current_dir(&self.cwd)
            .env("PORTOLAN_NATIVE", "1")
            .env("PORTOLAN_NATIVE_BACKEND_ROOT", &self.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Some(resource_dir) = &self.resource_dir {
            command.env("PORTOLAN_NATIVE_RESOURCE_DIR", resource_dir);
        }
        if self.process_group {
            configure_backend_process_group(&mut command);
        }
        command.spawn()
    }
}

fn backend_launch_for_profile(resource_dir: Option<PathBuf>, debug: bool) -> BackendLaunch {
    if !debug {
        if let Some(server_root) = bundled_server_root(resource_dir.as_deref()) {
            return node_backend_launch("node-dist-resource", server_root, resource_dir);
        }
    }

    let source_server_root = project_root().join("server");
    let source_dist_entry = dist_entry(&source_server_root);

    if !debug && source_dist_entry.exists() {
        return node_backend_launch("node-dist-source", source_server_root, None);
    }

    BackendLaunch {
        kind: "npm-dev".to_string(),
        program: resolve_program(
            "npm",
            &[
                "/opt/homebrew/bin/npm",
                "/usr/local/bin/npm",
                "/usr/bin/npm",
            ],
        ),
        args: vec!["run".to_string(), "dev".to_string()],
        cwd: source_server_root,
        entry: None,
        resource_dir: None,
        process_group: backend_uses_process_group(),
    }
}

fn node_backend_launch(
    kind: impl Into<String>,
    server_root: PathBuf,
    resource_dir: Option<PathBuf>,
) -> BackendLaunch {
    BackendLaunch {
        kind: kind.into(),
        program: resolve_program(
            "node",
            &[
                "/opt/homebrew/bin/node",
                "/usr/local/bin/node",
                "/usr/bin/node",
            ],
        ),
        args: vec![dist_entry(&server_root).display().to_string()],
        entry: Some(dist_entry(&server_root)),
        cwd: server_root,
        resource_dir,
        process_group: backend_uses_process_group(),
    }
}

fn bundled_server_root(resource_dir: Option<&Path>) -> Option<PathBuf> {
    let server_root = resource_dir?.join("server");
    let has_server_entry = dist_entry(&server_root).exists();
    let has_dependencies = server_root.join("node_modules").is_dir();
    if has_server_entry && has_dependencies {
        Some(server_root)
    } else {
        None
    }
}

fn dist_entry(server_root: &Path) -> PathBuf {
    server_root.join("dist").join("index.js")
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
    format!("{BACKEND_HOST}:{}", backend_port())
        .parse()
        .expect("Portolan backend address should be a valid socket address")
}

fn backend_port() -> u16 {
    #[cfg(test)]
    {
        if let Ok(raw) = std::env::var("PORTOLAN_SMOKE_BACKEND_PORT") {
            if let Ok(port) = raw.parse::<u16>() {
                return port;
            }
        }
    }
    BACKEND_PORT
}

fn backend_url() -> String {
    format!("http://{BACKEND_HOST}:{}", backend_port())
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

fn backend_uses_process_group() -> bool {
    cfg!(unix)
}

fn configure_backend_process_group(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    #[cfg(not(unix))]
    {
        let _ = command;
    }
}

fn wait_for_child_exit(child: &mut Child, timeout: Duration) -> io::Result<bool> {
    let start = Instant::now();
    loop {
        if child.try_wait()?.is_some() {
            return Ok(true);
        }
        if start.elapsed() >= timeout {
            return Ok(false);
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn terminate_backend_child(child: &mut Child) -> io::Result<()> {
    if child.try_wait()?.is_some() {
        return Ok(());
    }

    #[cfg(unix)]
    {
        let pgid = child.id() as libc::pid_t;
        unsafe {
            libc::kill(-pgid, libc::SIGTERM);
        }
        if wait_for_child_exit(child, BACKEND_SHUTDOWN_GRACE)? {
            return Ok(());
        }
        unsafe {
            libc::kill(-pgid, libc::SIGKILL);
        }
        let _ = child.wait();
        Ok(())
    }

    #[cfg(not(unix))]
    {
        child.kill()?;
        let _ = child.wait();
        Ok(())
    }
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
            resource_dir: state
                .resource_dir
                .as_ref()
                .map(|path| path.display().to_string()),
        },
        backend: backend.status(),
    }
}

fn shutdown_backend(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<NativeState>() {
        if let Ok(mut backend) = state.backend.lock() {
            backend.shutdown();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![native_status])
        .setup(|app| {
            let resource_dir = app.path().resource_dir().ok();
            app.manage(NativeState {
                backend: Mutex::new(BackendBridge::start(resource_dir.clone())),
                resource_dir,
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
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| match event {
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
            shutdown_backend(app_handle);
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};

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
        let launch = backend_launch_for_profile(None, cfg!(debug_assertions));
        assert_eq!(launch.cwd, project_root().join("server"));
        assert!(matches!(
            launch.kind.as_str(),
            "npm-dev" | "node-dist-source" | "node-dist-resource"
        ));
        assert_eq!(launch.process_group, cfg!(unix));
    }

    #[test]
    fn release_backend_launch_prefers_bundled_server_resources() {
        let resource_dir = temp_resource_dir("bundled-server");
        let server_root = resource_dir.join("server");
        fs::create_dir_all(server_root.join("dist")).expect("test dist should be created");
        fs::create_dir_all(server_root.join("node_modules")).expect("test deps should be created");
        fs::write(dist_entry(&server_root), "console.log('portolan')\n")
            .expect("test entry should be written");

        let launch = backend_launch_for_profile(Some(resource_dir.clone()), false);
        assert_eq!(launch.kind, "node-dist-resource");
        assert_eq!(launch.cwd, server_root);
        assert_eq!(launch.resource_dir, Some(resource_dir.clone()));
        assert_eq!(launch.entry, Some(dist_entry(&server_root)));

        fs::remove_dir_all(resource_dir).ok();
    }

    #[test]
    fn release_backend_launch_ignores_incomplete_bundled_server_resources() {
        let resource_dir = temp_resource_dir("incomplete-bundled-server");
        let server_root = resource_dir.join("server");
        fs::create_dir_all(server_root.join("dist")).expect("test dist should be created");
        fs::write(dist_entry(&server_root), "console.log('missing deps')\n")
            .expect("test entry should be written");

        let launch = backend_launch_for_profile(Some(resource_dir.clone()), false);
        assert_ne!(launch.kind, "node-dist-resource");
        assert_ne!(launch.cwd, server_root);

        fs::remove_dir_all(resource_dir).ok();
    }

    #[test]
    fn resolve_program_falls_back_to_name() {
        assert_eq!(
            resolve_program("missing-portolan-tool", &["/definitely/missing"]),
            PathBuf::from("missing-portolan-tool")
        );
    }

    fn temp_resource_dir(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "portolan-tauri-{name}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        fs::create_dir_all(&path).expect("test resource dir should be created");
        path
    }

    fn write_fake_dist_backend(server_root: &Path) -> io::Result<()> {
        fs::create_dir_all(server_root.join("dist")).expect("test dist dir should be created");
        fs::create_dir_all(server_root.join("node_modules"))
            .expect("test node_modules dir should be created");
        let fake_server = r#"const http = require('http');

const payload = JSON.stringify({ source: 'portolan-tauri-native-smoke', ok: true });
const backendPort = parseInt(process.env.PORTOLAN_SMOKE_BACKEND_PORT || '4004', 10);
const server = http.createServer((req, res) => {
  if (req.url === '/debug-runtime') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(payload);
    return;
  }

  res.statusCode = 404;
  res.end('not-found');
});

server.listen(backendPort, '127.0.0.1');
"#;
        fs::write(dist_entry(server_root), fake_server)
    }

    fn fetch_debug_runtime(port: u16) -> io::Result<String> {
        let mut stream = TcpStream::connect((BACKEND_HOST, port))?;
        let request = format!(
            "GET /debug-runtime HTTP/1.1\r\nHost: {BACKEND_HOST}:{port}\r\nConnection: close\r\n\r\n"
        );
        stream.write_all(request.as_bytes())?;

        let mut response = String::new();
        stream.read_to_string(&mut response)?;
        Ok(response)
    }

    fn wait_for_debug_runtime(port: u16, timeout: Duration) -> io::Result<String> {
        let start = Instant::now();
        let mut last_error = None;
        while start.elapsed() < timeout {
            match fetch_debug_runtime(port) {
                Ok(response) => return Ok(response),
                Err(error) => {
                    last_error = Some(error);
                    thread::sleep(Duration::from_millis(100));
                }
            }
        }

        Err(last_error.unwrap_or_else(|| {
            io::Error::new(
                io::ErrorKind::TimedOut,
                "timed out waiting for /debug-runtime",
            )
        }))
    }

    fn command_exists(program: &str) -> bool {
        Command::new(program)
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    #[test]
    #[ignore]
    fn native_backend_smoke_starts_resource_bound_backend_without_gui() {
        // Deepest free boundary: launch decision + child process lifecycle in src-tauri
        // (no Tauri app shell is started here).
        let backend_port = free_port_for_smoke();

        if !command_exists("node") {
            eprintln!("[smoke] skipped: node not found");
            return;
        }

        assert!(
            !backend_reachable_on_port(backend_port),
            "pre-existing process on port {backend_port} would mask app-owned launch path"
        );

        std::env::set_var("PORTOLAN_SMOKE_BACKEND_PORT", backend_port.to_string());
        let _port_guard = SmokeBackendPortGuard;

        let resource_dir = temp_resource_dir("native-backend-smoke");
        let server_root = resource_dir.join("server");
        write_fake_dist_backend(&server_root).expect("fake dist backend should be written");

        let launch = backend_launch_for_profile(Some(resource_dir.clone()), false);
        assert_eq!(launch.kind, "node-dist-resource");
        assert_eq!(launch.resource_dir, Some(resource_dir.clone()));
        assert_eq!(launch.cwd, server_root);

        let mut bridge = BackendBridge::start_for_profile(Some(resource_dir.clone()), false);
        let status = bridge.status();
        assert_eq!(status.owner, "app");
        assert_eq!(status.launch_kind, "node-dist-resource");
        assert!(status.pid.is_some());
        assert_eq!(status.url, format!("http://{BACKEND_HOST}:{backend_port}"));

        let response = wait_for_debug_runtime(backend_port, Duration::from_secs(5))
            .expect("fake backend should answer /debug-runtime");
        assert!(
            response.contains("\"source\":\"portolan-tauri-native-smoke\""),
            "unexpected /debug-runtime payload: {response}"
        );

        bridge.shutdown();
        assert!(
            !backend_reachable_on_port(backend_port),
            "backend must not remain reachable after cleanup"
        );
        fs::remove_dir_all(resource_dir).ok();
    }

    struct SmokeBackendPortGuard;

    impl Drop for SmokeBackendPortGuard {
        fn drop(&mut self) {
            std::env::remove_var("PORTOLAN_SMOKE_BACKEND_PORT");
        }
    }

    fn free_port_for_smoke() -> u16 {
        TcpListener::bind((BACKEND_HOST, 0))
            .expect("smoke should bind free local port")
            .local_addr()
            .expect("smoke port should be readable")
            .port()
    }

    fn backend_reachable_on_port(port: u16) -> bool {
        TcpStream::connect_timeout(
            &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
            Duration::from_millis(250),
        )
        .is_ok()
    }

    #[cfg(unix)]
    #[test]
    fn terminate_backend_child_stops_descendants_in_process_group() {
        use std::io::{BufRead, BufReader};
        use std::time::Duration;

        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg("sleep 30 & echo $!; wait")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        configure_backend_process_group(&mut command);

        let mut child = command.spawn().expect("test backend process should spawn");
        let stdout = child
            .stdout
            .take()
            .expect("test process should pipe stdout");
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .expect("test process should print descendant pid");
        let descendant_pid: libc::pid_t = line
            .trim()
            .parse()
            .expect("descendant pid should be numeric");

        terminate_backend_child(&mut child).expect("process group should terminate");
        assert!(
            wait_for_process_gone(descendant_pid, Duration::from_secs(2)),
            "descendant process should be gone after process-group shutdown"
        );
    }

    #[cfg(unix)]
    fn wait_for_process_gone(pid: libc::pid_t, timeout: Duration) -> bool {
        let start = Instant::now();
        loop {
            if unsafe { libc::kill(pid, 0) } != 0 {
                return true;
            }
            if start.elapsed() >= timeout {
                return false;
            }
            thread::sleep(Duration::from_millis(50));
        }
    }
}
