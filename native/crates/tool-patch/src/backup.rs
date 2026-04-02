//! backup.rs — File backup manager.
//!
//! Mirrors the behavior of TypeScript's `LocalBackupManager` in backup-manager.ts.
//! Backup files are stored under `{workspace_root}/.tuanzi/backups/{timestamp}/{relative_path}`.

use std::path::Path;
use tokio::fs;

/// Back up a file before modifying or deleting it.
///
/// Returns `Some(backup_path)` if the file was successfully backed up,
/// or `None` if the file doesn't exist or isn't a regular file.
pub async fn backup_file(absolute_path: &Path, workspace_root: &str) -> std::io::Result<Option<String>> {
    // Verify file exists and is a regular file
    let metadata = match fs::metadata(absolute_path).await {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    if !metadata.is_file() {
        return Ok(None);
    }

    let timestamp = format_timestamp();
    let relative_path = relative_from_workspace(absolute_path, workspace_root);
    let backup_root = Path::new(workspace_root).join(".tuanzi").join("backups");
    let backup_path = backup_root.join(&timestamp).join(&relative_path);
    let backup_dir = backup_path
        .parent()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "No parent directory"))?;

    fs::create_dir_all(backup_dir).await?;
    fs::copy(absolute_path, &backup_path).await?;

    Ok(Some(to_unix_path_string(&backup_path)))
}

/// Generate an ISO-like timestamp with `:` and `.` replaced by `-`.
/// Example: "2025-01-15T10-30-45-123Z"
fn format_timestamp() -> String {
    let now = chrono_lite_now();
    now
}

/// Minimal UTC timestamp generation without external chrono crate.
fn chrono_lite_now() -> String {
    use std::time::SystemTime;
    let duration = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    let total_secs = duration.as_secs();
    let millis = duration.subsec_millis();

    // Convert epoch seconds to date/time components
    let secs_per_day: u64 = 86400;
    let mut days = total_secs / secs_per_day;
    let day_secs = (total_secs % secs_per_day) as u32;
    let hours = day_secs / 3600;
    let minutes = (day_secs % 3600) / 60;
    let seconds = day_secs % 60;

    // Days since 1970-01-01 → year/month/day
    // Simplified algorithm
    let mut year: u32 = 1970;
    loop {
        let year_days = if is_leap_year(year) { 366 } else { 365 };
        if days < year_days {
            break;
        }
        days -= year_days;
        year += 1;
    }

    let month_days = if is_leap_year(year) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };

    let mut month: u32 = 1;
    for &md in &month_days {
        if days < md {
            break;
        }
        days -= md;
        month += 1;
    }
    let day = days as u32 + 1;

    // Format matching TS: replace `:` and `.` with `-`
    format!(
        "{year:04}-{month:02}-{day:02}T{hours:02}-{minutes:02}-{seconds:02}-{millis:03}Z"
    )
}

fn is_leap_year(year: u32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0)
}

/// Compute relative path from workspace root (forward slashes).
fn relative_from_workspace(absolute_path: &Path, workspace_root: &str) -> String {
    let ws = Path::new(workspace_root);
    match absolute_path.strip_prefix(ws) {
        Ok(rel) => to_unix_path_string_from(rel),
        Err(_) => to_unix_path_string(absolute_path),
    }
}

fn to_unix_path_string(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

fn to_unix_path_string_from(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_backup_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().to_str().unwrap();
        let file_path = dir.path().join("src").join("main.rs");

        fs::create_dir_all(file_path.parent().unwrap()).await.unwrap();
        fs::write(&file_path, "fn main() {}").await.unwrap();

        let result = backup_file(&file_path, workspace).await.unwrap();
        assert!(result.is_some());

        let backup_path_str = result.unwrap();
        assert!(backup_path_str.contains(".tuanzi/backups/"));
        assert!(backup_path_str.contains("src/main.rs"));

        // Verify backup content matches original
        let backup_content = fs::read_to_string(&backup_path_str.replace('/', &std::path::MAIN_SEPARATOR.to_string()))
            .await
            .unwrap();
        assert_eq!(backup_content, "fn main() {}");
    }

    #[tokio::test]
    async fn test_backup_nonexistent_file() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().to_str().unwrap();
        let file_path = dir.path().join("does_not_exist.txt");

        let result = backup_file(&file_path, workspace).await.unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn test_backup_preserves_directory_structure() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().to_str().unwrap();
        let file_path = dir.path().join("a").join("b").join("c.txt");

        fs::create_dir_all(file_path.parent().unwrap()).await.unwrap();
        fs::write(&file_path, "deep").await.unwrap();

        let result = backup_file(&file_path, workspace).await.unwrap();
        assert!(result.is_some());
        let backup = result.unwrap();
        assert!(backup.contains("a/b/c.txt"));
    }

    #[tokio::test]
    async fn test_backup_directory_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().to_str().unwrap();
        let subdir = dir.path().join("mydir");
        fs::create_dir_all(&subdir).await.unwrap();

        let result = backup_file(&subdir, workspace).await.unwrap();
        assert!(result.is_none());
    }
}
