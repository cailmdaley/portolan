use portolan_index::{search_city, walk_city, SearchOptions, WalkOptions};
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
        "search" => {
            let mut root = None;
            let mut database = None;
            let mut query = None;
            let mut limit = None;
            let mut max_entries = None;
            let mut refresh_ttl_ms = None;

            while let Some(arg) = args.next() {
                match arg.to_string_lossy().as_ref() {
                    "--root" => root = args.next().map(PathBuf::from),
                    "--db" => database = args.next().map(PathBuf::from),
                    "--query" => query = args.next().and_then(|value| value.into_string().ok()),
                    "--limit" => {
                        limit = args
                            .next()
                            .and_then(|value| value.to_string_lossy().parse::<usize>().ok())
                    }
                    "--max-entries" => {
                        max_entries = args
                            .next()
                            .and_then(|value| value.to_string_lossy().parse::<usize>().ok())
                    }
                    "--refresh-ttl-ms" => {
                        refresh_ttl_ms = args
                            .next()
                            .and_then(|value| value.to_string_lossy().parse::<u64>().ok())
                    }
                    "--help" | "-h" => return Err(usage()),
                    flag => return Err(format!("unknown option `{flag}`\n{}", usage())),
                }
            }

            let root = root.ok_or_else(|| format!("missing --root\n{}", usage()))?;
            let database = database.ok_or_else(|| format!("missing --db\n{}", usage()))?;
            let query = query.ok_or_else(|| format!("missing --query\n{}", usage()))?;
            let limit = limit.ok_or_else(|| format!("missing --limit\n{}", usage()))?;
            let max_entries =
                max_entries.ok_or_else(|| format!("missing --max-entries\n{}", usage()))?;
            let refresh_ttl_ms =
                refresh_ttl_ms.ok_or_else(|| format!("missing --refresh-ttl-ms\n{}", usage()))?;

            let summary = search_city(&SearchOptions::new(
                root,
                database,
                query,
                limit,
                max_entries,
                refresh_ttl_ms,
            ))
            .map_err(|error| format!("search failed: {error}"))?;
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
    "usage: portolan-index walk --root <path> --max-entries <n>\n       portolan-index search --root <path> --db <path> --query <q> --limit <n> --max-entries <n> --refresh-ttl-ms <ms>".to_string()
}
