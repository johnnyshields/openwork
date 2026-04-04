#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // In debug builds, redirect env_logger to a log file for easy tailing
    #[cfg(debug_assertions)]
    {
        use std::fs::OpenOptions;
        use std::io::Write;

        let log_path = std::env::temp_dir().join("openwork-debug.log");
        // Truncate on startup so the file stays fresh
        if let Ok(mut f) = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&log_path)
        {
            let _ = writeln!(f, "=== OpenWork debug log started ===");
        }

        let target = env_logger::Target::Pipe(Box::new(
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_path)
                .expect("Failed to open debug log file"),
        ));

        env_logger::Builder::from_default_env()
            .target(target)
            .init();

        eprintln!("Debug log: {}", log_path.display());
    }

    #[cfg(not(debug_assertions))]
    env_logger::init();

    openwork::run();
}
