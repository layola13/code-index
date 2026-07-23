mod discover;
mod model;
mod parser;
mod writer;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use discover::{default_ignored_dirs, discover_source_files};
use model::ModuleIr;
use parser::parse_source_file;
use rayon::prelude::*;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;
use writer::{build_edges, build_manifest, write_index};

#[derive(Debug, Parser)]
#[command(name = "code-index-rs")]
#[command(about = "Fast Rust implementation of the code-index builder")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    Build(BuildArgs),
    Describe(DescribeArgs),
}

#[derive(Debug, Parser)]
struct BuildArgs {
    #[arg(default_value = ".")]
    root_dir: PathBuf,

    #[arg(long)]
    output_dir: Option<PathBuf>,

    #[arg(long, default_value_t = default_workers())]
    workers: usize,

    #[arg(long)]
    max_files: Option<usize>,

    #[arg(long)]
    max_file_bytes: Option<u64>,

    #[arg(long = "ignore")]
    ignored_dir_names: Vec<String>,
}

#[derive(Debug, Parser)]
struct DescribeArgs {
    #[arg(default_value = ".")]
    root_dir: PathBuf,

    #[arg(long)]
    output_dir: Option<PathBuf>,
}

#[derive(Default)]
struct Timings {
    discover_ms: u128,
    parse_ms: u128,
    build_edges_ms: u128,
    write_ms: u128,
    total_ms: u128,
}

fn default_workers() -> usize {
    num_cpus::get().saturating_sub(1).clamp(1, 8)
}

fn resolve_root(path: &Path) -> Result<PathBuf> {
    path.canonicalize()
        .with_context(|| format!("failed to resolve root {}", path.display()))
}

fn resolve_output_dir(root_dir: &Path, output_dir: Option<PathBuf>) -> Result<PathBuf> {
    let output = output_dir.unwrap_or_else(|| root_dir.join(".code_index"));
    if output.is_absolute() {
        Ok(output)
    } else {
        Ok(std::env::current_dir()?.join(output))
    }
}

fn clean_output_dir(output_dir: &Path) -> Result<()> {
    if output_dir.exists() {
        fs::remove_dir_all(output_dir)
            .with_context(|| format!("failed to remove {}", output_dir.display()))?;
    }
    Ok(())
}

fn build(args: BuildArgs) -> Result<()> {
    let total_start = Instant::now();
    let root_dir = resolve_root(&args.root_dir)?;
    let output_dir = resolve_output_dir(&root_dir, args.output_dir)?;
    let workers = args.workers.max(1);
    let ignored_dirs = default_ignored_dirs(&args.ignored_dir_names);
    let mut timings = Timings::default();

    eprintln!("code-index-rs build");
    eprintln!("  root: {}", root_dir.display());
    eprintln!("  output: {}", output_dir.display());
    eprintln!("  workers: {workers}");

    let discover_start = Instant::now();
    let discovery = discover_source_files(
        &root_dir,
        &output_dir,
        workers,
        &ignored_dirs,
        args.max_files,
    )?;
    timings.discover_ms = discover_start.elapsed().as_millis();
    eprintln!(
        "Discovered {} source files in {:.2}s{}",
        discovery.files.len(),
        timings.discover_ms as f64 / 1000.0,
        if discovery.file_limit_reached {
            " (file limit reached)"
        } else {
            ""
        }
    );

    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(workers)
        .build()
        .context("failed to build rayon worker pool")?;

    let parse_start = Instant::now();
    let parsed = AtomicUsize::new(0);
    let total = discovery.files.len();
    let mut modules: Vec<ModuleIr> = pool.install(|| {
        discovery
            .files
            .par_iter()
            .map(|file| {
                let module = parse_source_file(file, args.max_file_bytes);
                let completed = parsed.fetch_add(1, Ordering::Relaxed) + 1;
                if completed == total || completed.is_multiple_of(1000) {
                    eprintln!("Parsed {completed}/{total} source files");
                }
                module
            })
            .collect()
    });
    modules.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    timings.parse_ms = parse_start.elapsed().as_millis();

    let edge_start = Instant::now();
    let edges = build_edges(&modules);
    timings.build_edges_ms = edge_start.elapsed().as_millis();

    clean_output_dir(&output_dir)?;
    let manifest = build_manifest(
        &root_dir,
        &output_dir,
        &modules,
        &edges,
        args.max_files,
        discovery.file_limit_reached,
    );

    let write_start = Instant::now();
    write_index(&root_dir, &output_dir, &modules, &edges, &manifest)?;
    timings.write_ms = write_start.elapsed().as_millis();
    timings.total_ms = total_start.elapsed().as_millis();

    println!("Index built");
    println!("  Engine: rust");
    println!("  Root: {}", root_dir.display());
    println!("  Output: {}", output_dir.display());
    println!("  Workers: {workers}");
    println!("  Modules: {}", manifest.module_count);
    println!("  Classes: {}", manifest.class_count);
    println!("  Functions: {}", manifest.function_count);
    println!("  Methods: {}", manifest.method_count);
    println!("  Edges: {}", manifest.edge_count);
    println!("  Timings:");
    println!("    discover: {:.2}s", timings.discover_ms as f64 / 1000.0);
    println!("    parse: {:.2}s", timings.parse_ms as f64 / 1000.0);
    println!(
        "    build_edges: {:.2}s",
        timings.build_edges_ms as f64 / 1000.0
    );
    println!("    write: {:.2}s", timings.write_ms as f64 / 1000.0);
    println!("    total: {:.2}s", timings.total_ms as f64 / 1000.0);
    Ok(())
}

fn describe(args: DescribeArgs) -> Result<()> {
    let root_dir = resolve_root(&args.root_dir)?;
    let output_dir = resolve_output_dir(&root_dir, args.output_dir)?;
    let manifest_path = output_dir.join("index/manifest.json");
    let summary_path = output_dir.join("index/summary.md");
    let manifest = fs::read_to_string(&manifest_path)
        .with_context(|| format!("failed to read {}", manifest_path.display()))?;
    println!("{}", manifest.trim_end());
    if let Ok(summary) = fs::read_to_string(&summary_path) {
        println!();
        println!("{}", summary.trim_end());
    }
    Ok(())
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Build(args) => build(args),
        Command::Describe(args) => describe(args),
    }
}
