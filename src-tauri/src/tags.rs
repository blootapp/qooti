// Tag registry and system tag generation

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: String,
    pub label: String,
    pub r#type: String,
    pub origin: String,
}

/// Ensure a tag exists in the registry. Returns tag_id.
/// Unique per (label, type).
pub fn ensure_tag(
    conn: &Connection,
    label: &str,
    tag_type: &str,
    origin: &str,
) -> Result<String, String> {
    let label = label.trim();
    if label.is_empty() {
        return Err("Tag label cannot be empty".to_string());
    }
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;

    // Check if exists
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM tags WHERE label = ? AND type = ?",
            rusqlite::params![label, tag_type],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(|e: rusqlite::Error| e.to_string())?;

    if let Some(id) = existing {
        return Ok(id);
    }

    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO tags (id, label, type, origin, created_at) VALUES (?, ?, ?, ?, ?)",
        rusqlite::params![id, label, tag_type, origin, ts],
    )
    .map_err(|e| e.to_string())?;
    Ok(id)
}

/// Increment usage count for a tag (used by tag filter bar / top tags).
pub fn increment_tag_usage(conn: &Connection, tag_id: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO tag_usage_counts (tag_id, usage_count) VALUES (?, 1) ON CONFLICT(tag_id) DO UPDATE SET usage_count = usage_count + 1",
        rusqlite::params![tag_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Decrement usage count for a tag.
pub fn decrement_tag_usage(conn: &Connection, tag_id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE tag_usage_counts SET usage_count = usage_count - 1 WHERE tag_id = ? AND usage_count > 0",
        rusqlite::params![tag_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Attach a tag to an inspiration (idempotent). Updates tag_usage_counts when a new link is added.
pub fn attach_tag(conn: &Connection, inspiration_id: &str, tag_id: &str) -> Result<(), String> {
    let n = conn
        .execute(
            "INSERT OR IGNORE INTO inspiration_tags (inspiration_id, tag_id) VALUES (?, ?)",
            rusqlite::params![inspiration_id, tag_id],
        )
        .map_err(|e| e.to_string())?;
    if n > 0 {
        increment_tag_usage(conn, tag_id)?;
    }
    Ok(())
}

/// Detach a tag from an inspiration. Updates tag_usage_counts when a link is removed.
pub fn detach_tag(conn: &Connection, inspiration_id: &str, tag_id: &str) -> Result<(), String> {
    let n = conn
        .execute(
            "DELETE FROM inspiration_tags WHERE inspiration_id = ? AND tag_id = ?",
            rusqlite::params![inspiration_id, tag_id],
        )
        .map_err(|e| e.to_string())?;
    if n > 0 {
        decrement_tag_usage(conn, tag_id)?;
    }
    Ok(())
}

/// Generate and attach system tags for a new inspiration.
pub fn apply_system_tags(
    conn: &Connection,
    inspiration_id: &str,
    source: &str,     // local | youtube | instagram | web
    media_type: &str, // image | video | gif | link
    aspect_ratio: Option<f64>,
    platform_hint: Option<&str>, // youtube | instagram etc
    channel_hint: Option<&str>,  // YouTube channel name etc
) -> Result<(), String> {
    // Source
    let source_tag = ensure_tag(conn, source, "source", "system")?;
    attach_tag(conn, inspiration_id, &source_tag)?;

    // Format (media type)
    let format_tag = ensure_tag(conn, media_type, "format", "system")?;
    attach_tag(conn, inspiration_id, &format_tag)?;

    // Orientation from aspect_ratio
    if let Some(ar) = aspect_ratio {
        let orientation = if ar > 1.15 {
            "horizontal"
        } else if ar < 0.87 {
            "vertical"
        } else {
            "square"
        };
        let orient_tag = ensure_tag(conn, orientation, "format", "system")?;
        attach_tag(conn, inspiration_id, &orient_tag)?;
    }

    // Platform (video only): reel | short | youtube
    if media_type == "video" || media_type == "gif" {
        if let Some(platform) = platform_hint {
            let platform = platform.to_lowercase();
            let pid = platform.as_str();
            let opt_tag = match (pid, aspect_ratio) {
                ("instagram", Some(ar)) if ar < 0.87 => {
                    Some(ensure_tag(conn, "reel", "platform", "system"))
                }
                ("youtube", Some(ar)) if ar < 0.87 => {
                    Some(ensure_tag(conn, "short", "platform", "system"))
                }
                ("youtube", _) => Some(ensure_tag(conn, "youtube", "platform", "system")),
                ("instagram", _) => Some(ensure_tag(conn, "instagram", "platform", "system")),
                _ => None,
            };
            if let Some(Ok(tid)) = opt_tag {
                let _ = attach_tag(conn, inspiration_id, &tid);
            }
        }
    }

    // Channel/creator (e.g. YouTube channel name)
    if let Some(ch) = channel_hint {
        let ch = ch.trim();
        if !ch.is_empty() && ch.len() <= 100 {
            if let Ok(tid) = ensure_tag(conn, ch, "channel", "system") {
                let _ = attach_tag(conn, inspiration_id, &tid);
            }
        }
    }

    Ok(())
}
