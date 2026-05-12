use portolan_index::{walk_city, WalkOptions};
use std::{env, path::PathBuf, process};

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        process::exit(2);
    }
}

fn run() -> Result<(), String> {
    let mut args = env::args_os().skip(1);
    let command = args
        .next()
        .and_then(|arg| arg.into_string().ok())
        .ok_or_else(usage)?;

    match command.as_str() {
        "walk" => {
            let mut root = None;
            let mut max_entries = None;

            while let Some(arg) = args.next() {
                match arg.to_string_lossy().as_ref() {
                    "--root" => root = args.next().map(PathBuf::from),
                    "--max-entries" => {
                        max_entries = args
                            .next()
                            .and_then(|value| value.to_string_lossy().parse::<usize>().ok())
                    }
                    "--help" | "-h" => return Err(usage()),
                    flag => return Err(format!("unknown option `{flag}`\n{}", usage())),
                }
            }

            let root = root.ok_or_else(|| format!("missing --root\n{}", usage()))?;
            let max_entries =
                max_entries.ok_or_else(|| format!("missing --max-entries\n{}", usage()))?;
            let summary = walk_city(&WalkOptions::new(root, max_entries))
                .map_err(|error| format!("walk failed: {error}"))?;
            serde_json::to_writer(std::io::stdout(), &summary)
                .map_err(|error| format!("failed to write JSON: {error}"))?;
            println!();
            Ok(())
        }
        "--help" | "-h" => Err(usage()),
        _ => Err(format!("unknown command `{command}`\n{}", usage())),
    }
}

fn usage() -> String {
    "usage: portolan-index walk --root <path> --max-entries <n>".to_string()
}
