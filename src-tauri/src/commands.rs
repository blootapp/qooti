use crate::db::Db;
use crate::palette;
use crate::tags;
use crate::vault::VaultPaths;
use base64::Engine;
use image::GenericImageView;
use log::{debug, error, info, warn};

use rusqlite::{Connection, OptionalExtension};
use rusqlite::types::Value as SqlValue;

/// Per-command timing: start at `debug!`, finish at `info!`, `warn!` if slow (>500ms).
macro_rules! cmd_log {
    ($name:expr) => {
        let _cmd_log_guard = {
            struct CmdLogGuard(&'static str, std::time::Instant);
            impl Drop for CmdLogGuard {
                fn drop(&mut self) {
                    let ms = self.1.elapsed().as_millis() as u64;
                    if ms > 500 {
                        warn!(
                            "[CMD] {} | duration={}ms | status=slow",
                            self.0, ms
                        );
                    }
                    info!(
                        "[CMD] {} | duration={}ms | status=finished",
                        self.0, ms
                    );
                }
            }
            debug!("[CMD] {} | status=started", $name);
            CmdLogGuard($name, std::time::Instant::now())
        };
    };
}

/// For hot polling paths (e.g. extension queue): only `debug!` + slow warning.
macro_rules! cmd_log_debug {
    ($name:expr) => {
        let _cmd_log_guard = {
            struct CmdLogGuard(&'static str, std::time::Instant);
            impl Drop for CmdLogGuard {
                fn drop(&mut self) {
                    let ms = self.1.elapsed().as_millis() as u64;
                    if ms > 500 {
                        warn!(
                            "[CMD] {} | duration={}ms | status=slow",
                            self.0, ms
                        );
                    }
                    debug!(
                        "[CMD] {} | duration={}ms | status=finished",
                        self.0, ms
                    );
                }
            }
            debug!("[CMD] {} | status=started", $name);
            CmdLogGuard($name, std::time::Instant::now())
        };
    };
}

pub fn log_startup_session() {
    let session_id = &Uuid::new_v4().to_string()[..8];
    info!(
        "[startup] session={} | version={} | os={} | arch={} | debug={}",
        session_id,
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
        cfg!(debug_assertions)
    );
}
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, State};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

#[derive(Serialize, Deserialize, Clone)]
pub struct InspirationRow {
    pub id: String,
    pub r#type: String,
    pub title: Option<String>,
    pub source_url: Option<String>,
    pub original_filename: Option<String>,
    pub stored_path: Option<String>,
    pub thumbnail_path: Option<String>,
    pub display_row: Option<String>,
    pub aspect_ratio: Option<f64>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vault_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stored_path_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail_path_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stored_path_abs: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail_path_abs: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<tags::Tag>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub palette: Option<serde_json::Value>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct NotificationRow {
    pub id: String,
    pub title: Option<String>,
    pub body: String,
    pub youtube_url: Option<String>,
    pub button_text: Option<String>,
    pub button_link: Option<String>,
    pub high_priority: bool,
    pub is_active: bool,
    pub created_at: i64,
    pub expires_at: Option<i64>,
    pub unread: bool,
}

#[derive(Serialize, Deserialize)]
pub struct OcrDebugPaletteSwatch {
    pub hex: String,
    pub lab_l: f32,
    pub lab_a: f32,
    pub lab_b: f32,
}

#[derive(Serialize, Deserialize)]
pub struct OcrDebugInfo {
    pub id: String,
    pub media_type: String,
    pub ocr_status: Option<String>,
    pub can_attempt_ocr: bool,
    pub tesseract_available: bool,
    pub ocr_refreshed: bool,
    pub has_ocr_text: bool,
    pub token_count: usize,
    pub ocr_text: String,
    pub analysis_path: Option<String>,
    pub tesseract_binary: Option<String>,
    /// Dominant colors (LAB in DB → hex + components for debug UI).
    pub palette: Vec<OcrDebugPaletteSwatch>,
}

#[derive(Serialize, Deserialize)]
pub struct OcrIndexCandidate {
    pub id: String,
    pub image_path: String,
    pub image_rel_path: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct OcrIndexStats {
    pub total: i64,
    pub done: i64,
    pub no_text: i64,
    pub processing: i64,
    pub pending: i64,
}

#[derive(Serialize, Deserialize)]
pub struct OcrReindexSummary {
    pub queued: i64,
    pub already_done: i64,
    pub already_processing: i64,
    pub skipped: i64,
}

fn normalize_windows_verbatim_prefix(path_text: &str) -> String {
    path_text
        .trim_start_matches(r"\\?\")
        .trim_start_matches("//?/")
        .to_string()
}

fn abs_path_for_webview(path: &Path) -> Option<String> {
    path.canonicalize().ok().map(|p| {
        normalize_windows_verbatim_prefix(&p.to_string_lossy())
            .replace('\\', "/")
    })
}

fn tokenize_search_text(input: &str) -> Vec<String> {
    use std::sync::OnceLock;
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"[^\p{L}\p{N}]+").expect("search tokenize regex"));
    re.replace_all(&input.to_lowercase(), " ")
        .split_whitespace()
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn levenshtein_distance(a: &str, b: &str) -> usize {
    if a == b {
        return 0;
    }
    let ac: Vec<char> = a.chars().collect();
    let bc: Vec<char> = b.chars().collect();
    if ac.is_empty() {
        return bc.len();
    }
    if bc.is_empty() {
        return ac.len();
    }
    let mut prev: Vec<usize> = (0..=bc.len()).collect();
    let mut curr: Vec<usize> = vec![0; bc.len() + 1];
    for (i, ca) in ac.iter().enumerate() {
        curr[0] = i + 1;
        for (j, cb) in bc.iter().enumerate() {
            let cost = if ca == cb { 0 } else { 1 };
            curr[j + 1] = (curr[j] + 1).min(prev[j + 1] + 1).min(prev[j] + cost);
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    prev[bc.len()]
}

fn token_match_score(query_token: &str, candidate_tokens: &[String]) -> f32 {
    let mut best = 0.0f32;
    for ct in candidate_tokens {
        if ct == query_token {
            return 1.0;
        }
        if ct.contains(query_token) || query_token.contains(ct) {
            best = best.max(0.9);
            continue;
        }
        let dist = levenshtein_distance(query_token, ct);
        let max_len = query_token.chars().count().max(ct.chars().count()).max(1) as f32;
        let norm = dist as f32 / max_len;
        if dist <= 1 || (dist <= 2 && max_len >= 5.0) {
            best = best.max((1.0 - norm).max(0.0));
        }
    }
    best
}

fn field_match_score(query_tokens: &[String], field_texts: &[String]) -> f32 {
    if query_tokens.is_empty() {
        return 0.0;
    }
    let mut candidate_tokens: Vec<String> = Vec::new();
    for text in field_texts {
        candidate_tokens.extend(tokenize_search_text(text));
    }
    if candidate_tokens.is_empty() {
        return 0.0;
    }
    let sum: f32 = query_tokens
        .iter()
        .map(|qt| token_match_score(qt, &candidate_tokens))
        .sum();
    (sum / query_tokens.len() as f32).clamp(0.0, 1.0)
}

fn escape_like_fragment(input: &str) -> String {
    input
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn normalize_required_http_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Empty URL".to_string());
    }
    if trimmed.len() > 2048 {
        return Err("URL is too long".to_string());
    }
    let parsed = url::Url::parse(trimmed).map_err(|_| "Invalid URL format".to_string())?;
    let scheme = parsed.scheme().to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err("Only http/https URLs are supported".to_string());
    }
    Ok(parsed.to_string())
}

fn resolve_vault_relative_existing_path(vault_root: &Path, rel_path: &str) -> Result<PathBuf, String> {
    let rel_raw = rel_path.trim();
    if rel_raw.is_empty() {
        return Err("File path is required.".to_string());
    }
    let vault_root_abs = vault_root
        .canonicalize()
        .map_err(|e| format!("Vault path is unavailable: {}", e))?;

    // Accept both historical absolute DB paths and newer vault-relative paths.
    let rel_no_verbatim = normalize_windows_verbatim_prefix(rel_raw);
    let input_path = PathBuf::from(&rel_no_verbatim);
    let candidate = if input_path.is_absolute() {
        input_path
    } else {
        let normalized = rel_no_verbatim
            .trim_start_matches('/')
            .replace('/', std::path::MAIN_SEPARATOR_STR);
        vault_root_abs.join(normalized)
    };
    let resolved = candidate
        .canonicalize()
        .map_err(|e| format!("File not found: {}", e))?;
    let resolved_txt = normalize_windows_verbatim_prefix(&resolved.to_string_lossy()).to_lowercase();
    let vault_txt = normalize_windows_verbatim_prefix(&vault_root_abs.to_string_lossy()).to_lowercase();
    if !resolved_txt.starts_with(&vault_txt) {
        return Err("Path is outside the vault.".to_string());
    }
    Ok(resolved)
}

fn populate_inspiration_row_paths(row: &mut InspirationRow, vault_root: &Path) {
    if let Some(ref sp) = row.stored_path {
        if let Ok(abs) = resolve_vault_relative_existing_path(vault_root, sp) {
            row.stored_path_url = abs_path_for_webview(&abs);
            row.stored_path_abs = Some(abs.to_string_lossy().to_string());
        }
    }
    if let Some(ref tp) = row.thumbnail_path {
        if let Ok(abs) = resolve_vault_relative_existing_path(vault_root, tp) {
            row.thumbnail_path_url = abs_path_for_webview(&abs);
            row.thumbnail_path_abs = Some(abs.to_string_lossy().to_string());
        }
    }
}

#[tauri::command]
pub async fn list_inspirations(
    db: State<'_, Arc<Db>>,
    vault: State<'_, Arc<VaultPaths>>,
    params: Option<serde_json::Value>,
) -> Result<Vec<InspirationRow>, String> {
    cmd_log!("list_inspirations");
    let db = db.inner().clone();
    let vault = vault.inner().clone();
    let params = params.unwrap_or(serde_json::json!({}));
    let dbg_query_len = params["query"].as_str().map(|s| s.len()).unwrap_or(0);
    let dbg_has_collection = params["collectionId"].as_str().is_some();
    let dbg_has_tag = params["tagId"]
        .as_str()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    let dbg_has_color = params.get("colorFilter").is_some();
    let dbg_missing_palette = params
        .get("missingPaletteOnly")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    debug!(
        "[CMD] list_inspirations | query_len={} | collection_filter={} | tag_filter={} | color_filter={} | missing_palette={}",
        dbg_query_len, dbg_has_collection, dbg_has_tag, dbg_has_color, dbg_missing_palette
    );

    tauri::async_runtime::spawn_blocking(move || {
        let query = params["query"].as_str().unwrap_or("").trim();
        let missing_palette_only = params
            .get("missingPaletteOnly")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let collection_id = params["collectionId"].as_str();
        let tag_id_filter = params["tagId"].as_str().map(|s| s.trim()).filter(|s| !s.is_empty());
        let color_filter = params.get("colorFilter").and_then(|c| {
            let r = c.get("r").and_then(|v| v.as_u64()).map(|v| v.min(255) as u8).unwrap_or(0);
            let g = c.get("g").and_then(|v| v.as_u64()).map(|v| v.min(255) as u8).unwrap_or(0);
            let b = c.get("b").and_then(|v| v.as_u64()).map(|v| v.min(255) as u8).unwrap_or(0);
            Some([r, g, b])
        });

        let conn = db.conn();
        let limit: i64 = params
            .get("limit")
            .and_then(|l| l.as_i64())
            .unwrap_or(10_000);
        let offset: i64 = params.get("offset").and_then(|o| o.as_i64()).unwrap_or(0);
        let limit = limit.clamp(1, 500);
        let offset = offset.max(0);
        let sql_limit = if query.is_empty() { limit } else { 1000 };
        let sql_offset = if query.is_empty() { offset } else { 0 };

        // Color filter gates:
        // 1) strict tier: most suitable matches
        // 2) near tier: close shades (lighter/darker/adjacent) shown after strict matches
        // This keeps high precision at the top while still returning useful nearby colors.
        const COLOR_FILTER_MIN_THRESHOLD: f32 = 55.0;
        const COLOR_FILTER_DOMINANT_THRESHOLD: f32 = 68.0;
        const COLOR_FILTER_WEIGHTED_THRESHOLD: f32 = 75.0;
        const COLOR_FILTER_NEAR_MIN_THRESHOLD: f32 = 70.0;
        const COLOR_FILTER_NEAR_DOMINANT_THRESHOLD: f32 = 86.0;
        const COLOR_FILTER_NEAR_WEIGHTED_THRESHOLD: f32 = 95.0;

        // Only hide content from hidden collections on the unfiltered main feed
        // (no tag, no color, no search). Any active filter should search everything.
        let has_active_filter = tag_id_filter.is_some()
            || color_filter.is_some()
            || !query.is_empty()
            || missing_palette_only;
        let hide_hidden_collections = collection_id.is_none() && !has_active_filter;

        let ordered_ids: Option<Vec<String>> = if let Some([r, g, b]) = color_filter {
            let user_lab = palette::rgb_to_lab(r, g, b);
            let mut sql_ids = "SELECT i.id, i.palette FROM inspirations i".to_string();
            let mut sql_id_params: Vec<SqlValue> = Vec::new();
            if collection_id.is_some() {
                sql_ids += " INNER JOIN collection_items ci ON ci.inspiration_id = i.id";
            }
            sql_ids += " WHERE 1=1";
            if let Some(cid) = collection_id {
                sql_ids += " AND ci.collection_id = ?";
                sql_id_params.push(SqlValue::from(cid.to_string()));
            }
            let rows: Vec<(String, Option<String>)> = conn
                .prepare(&sql_ids)
                .map_err(|e| e.to_string())?
                .query_map(rusqlite::params_from_iter(sql_id_params.iter()), |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
                })
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();
            let mut strict_matches: Vec<(String, f32)> = Vec::new();
            let mut near_matches: Vec<(String, f32)> = Vec::new();
            for (id, pal_json) in rows.into_iter() {
                let colors: Vec<[f32; 3]> = match pal_json
                    .as_ref()
                    .and_then(|s| serde_json::from_str(s.as_str()).ok())
                {
                    Some(v) => v,
                    None => continue,
                };
                let p = palette::Palette { colors };
                let d_min = palette::min_distance_to_palette(&user_lab, &p);
                let d_dom = palette::min_distance_to_palette_top_n(&user_lab, &p, 2);
                let d_weighted = palette::weighted_distance_to_palette(&user_lab, &p);

                // Final score favors dominant + overall palette relevance,
                // while still considering the best local match.
                let score = 0.50 * d_dom + 0.35 * d_weighted + 0.15 * d_min;

                let is_strict = d_min <= COLOR_FILTER_MIN_THRESHOLD
                    && d_dom <= COLOR_FILTER_DOMINANT_THRESHOLD
                    && d_weighted <= COLOR_FILTER_WEIGHTED_THRESHOLD;
                let is_near = d_min <= COLOR_FILTER_NEAR_MIN_THRESHOLD
                    && d_dom <= COLOR_FILTER_NEAR_DOMINANT_THRESHOLD
                    && d_weighted <= COLOR_FILTER_NEAR_WEIGHTED_THRESHOLD;

                if is_strict {
                    strict_matches.push((id, score));
                } else if is_near {
                    // Penalty keeps all near-tier results after strict-tier results.
                    near_matches.push((id, score + 1000.0));
                }
            }
            strict_matches.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
            near_matches.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
            let ids: Vec<String> = strict_matches
                .into_iter()
                .chain(near_matches.into_iter())
                .map(|(id, _)| id)
                .collect();
            Some(ids)
        } else {
            None
        };

        let mut sql = "SELECT i.id, i.type, i.title, i.source_url, i.original_filename, i.stored_path, i.thumbnail_path, i.display_row, i.aspect_ratio, i.created_at, i.updated_at, i.vault_id, i.mime_type, i.palette FROM inspirations i".to_string();
        let mut sql_params: Vec<SqlValue> = Vec::new();
        if collection_id.is_some() {
            sql += " INNER JOIN collection_items ci ON ci.inspiration_id = i.id";
        }
        sql += " WHERE 1=1";
        if let Some(cid) = collection_id {
            sql += " AND ci.collection_id = ?";
            sql_params.push(SqlValue::from(cid.to_string()));
        }
        if hide_hidden_collections {
            sql += " AND i.id NOT IN (SELECT ci.inspiration_id FROM collection_items ci INNER JOIN collections c ON c.id = ci.collection_id WHERE COALESCE(c.visible_on_home, 1) = 0)";
        }
        if let Some(tid) = tag_id_filter {
            sql += " AND i.id IN (SELECT inspiration_id FROM inspiration_tags WHERE tag_id = ?)";
            sql_params.push(SqlValue::from(tid.to_string()));
        }
        if missing_palette_only {
            sql += " AND i.type IN ('image', 'link') AND (i.palette IS NULL OR TRIM(COALESCE(i.palette, '')) = '' OR TRIM(COALESCE(i.palette, '')) = '[]')";
        }
        if let Some(ref ids) = ordered_ids {
            if ids.is_empty() {
                return Ok(Vec::new());
            }
            let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            sql += &format!(" AND i.id IN ({})", placeholders);
            for id in ids {
                sql_params.push(SqlValue::from(id.clone()));
            }
        } else {
            if !query.is_empty() {
                let q_tokens = tokenize_search_text(query);
                if !q_tokens.is_empty() {
                    let mut or_parts: Vec<String> = Vec::new();
                    let mut tag_likes: Vec<String> = Vec::new();
                    let mut tag_like_params: Vec<SqlValue> = Vec::new();
                    for t in &q_tokens {
                        let like_pattern = format!("%{}%", escape_like_fragment(t));
                        or_parts.push("i.title LIKE ? ESCAPE '\\'".to_string());
                        sql_params.push(SqlValue::from(like_pattern.clone()));
                        or_parts.push("i.ocr_text LIKE ? ESCAPE '\\'".to_string());
                        sql_params.push(SqlValue::from(like_pattern.clone()));
                        tag_likes.push("t2.label LIKE ? ESCAPE '\\'".to_string());
                        tag_like_params.push(SqlValue::from(like_pattern));
                    }
                    or_parts.push(format!(
                        "i.id IN (SELECT it2.inspiration_id FROM inspiration_tags it2 JOIN tags t2 ON t2.id = it2.tag_id WHERE {})",
                        tag_likes.join(" OR ")
                    ));
                    sql_params.extend(tag_like_params);
                    sql += &format!(" AND ({})", or_parts.join(" OR "));
                }
            }
            if collection_id.is_some() {
                sql += " ORDER BY ci.created_at DESC";
            } else {
                sql += " ORDER BY i.created_at DESC";
            }
            sql += " LIMIT ? OFFSET ?";
            sql_params.push(SqlValue::from(sql_limit));
            sql_params.push(SqlValue::from(sql_offset));
        }

        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(sql_params.iter()), |r| {
                Ok(InspirationRow {
                    id: r.get(0)?,
                    r#type: r.get(1)?,
                    title: r.get(2)?,
                    source_url: r.get(3)?,
                    original_filename: r.get(4)?,
                    stored_path: r.get(5)?,
                    thumbnail_path: r.get(6)?,
                    display_row: r.get(7)?,
                    aspect_ratio: r.get(8)?,
                    created_at: r.get(9)?,
                    updated_at: r.get(10)?,
                    vault_id: r.get(11)?,
                    mime_type: r.get(12)?,
                    stored_path_url: None,
                    thumbnail_path_url: None,
                    stored_path_abs: None,
                    thumbnail_path_abs: None,
                    tags: None,
                    palette: r.get::<_, Option<String>>(13)?.and_then(|s| serde_json::from_str(&s).ok()),
                })
            })
            .map_err(|e| e.to_string())?;
        let mut result: Vec<InspirationRow> = rows
            .filter_map(|r| r.ok())
            .collect();
        if let Some(ref ids) = ordered_ids {
            let order: std::collections::HashMap<&str, usize> =
                ids.iter().enumerate().map(|(i, id)| (id.as_str(), i)).collect();
            result.sort_by_cached_key(|r| *order.get(r.id.as_str()).unwrap_or(&0));
        }

        for r in &mut result {
            populate_inspiration_row_paths(r, &vault.root);
        }

        // Fetch tags for all inspirations
        if !result.is_empty() {
            let placeholders = result.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let tag_params: Vec<SqlValue> =
                result.iter().map(|r| SqlValue::from(r.id.clone())).collect();
            let tag_sql = format!(
                "SELECT it.inspiration_id, t.id, t.label, t.type, t.origin FROM inspiration_tags it JOIN tags t ON t.id = it.tag_id WHERE it.inspiration_id IN ({})",
                placeholders
            );
            let mut tag_stmt = conn.prepare(&tag_sql).map_err(|e| e.to_string())?;
            let tag_rows = tag_stmt
                .query_map(rusqlite::params_from_iter(tag_params.iter()), |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        tags::Tag {
                            id: r.get(1)?,
                            label: r.get(2)?,
                            r#type: r.get(3)?,
                            origin: r.get(4)?,
                        },
                    ))
                })
                .map_err(|e| e.to_string())?;
            let mut tag_map: std::collections::HashMap<String, Vec<tags::Tag>> = std::collections::HashMap::new();
            for row in tag_rows {
                let (iid, tag) = row.map_err(|e| e.to_string())?;
                tag_map.entry(iid).or_default().push(tag);
            }
            for r in &mut result {
                r.tags = tag_map.remove(&r.id);
            }
        }

        if !query.is_empty() && !result.is_empty() {
            let query_tokens = tokenize_search_text(query);
            if !query_tokens.is_empty() {
                let placeholders = result.iter().map(|_| "?").collect::<Vec<_>>().join(",");
                let ocr_params: Vec<SqlValue> =
                    result.iter().map(|r| SqlValue::from(r.id.clone())).collect();
                let ocr_sql = format!(
                    "SELECT id, COALESCE(ocr_text, '') FROM inspirations WHERE id IN ({})",
                    placeholders
                );
                let mut ocr_stmt = conn.prepare(&ocr_sql).map_err(|e| e.to_string())?;
                let ocr_rows = ocr_stmt
                    .query_map(rusqlite::params_from_iter(ocr_params.iter()), |r| {
                        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                    })
                    .map_err(|e| e.to_string())?;
                let mut ocr_map: HashMap<String, String> = HashMap::new();
                for row in ocr_rows {
                    let (id, text) = row.map_err(|e| e.to_string())?;
                    ocr_map.insert(id, text);
                }

                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                let cutoff = 15.0f32;
                let mut scored: Vec<(InspirationRow, f32)> = Vec::new();

                for item in result.into_iter() {
                    let title_text = item.title.clone().unwrap_or_default();
                    let tag_texts: Vec<String> = item
                        .tags
                        .as_ref()
                        .map(|ts| ts.iter().map(|t| t.label.clone()).collect())
                        .unwrap_or_default();
                    let ocr_text = normalize_ocr_text(ocr_map.get(&item.id).map(|s| s.as_str()).unwrap_or(""));
                    let metadata_text = format!(
                        "{} {}",
                        item.source_url.clone().unwrap_or_default(),
                        item.original_filename.clone().unwrap_or_default()
                    );

                    let title_score = field_match_score(&query_tokens, &[title_text]);
                    let tags_score = field_match_score(&query_tokens, &tag_texts);
                    let ocr_score = field_match_score(&query_tokens, &[ocr_text]);
                    let metadata_score = field_match_score(&query_tokens, &[metadata_text]);

                    let weighted = match item.r#type.as_str() {
                        "image" => 0.80 * ocr_score + 0.15 * tags_score + 0.05 * title_score,
                        "video" | "gif" => 0.80 * tags_score + 0.20 * title_score,
                        "link" => 0.60 * tags_score + 0.20 * title_score + 0.20 * metadata_score,
                        _ => 0.80 * tags_score + 0.20 * title_score,
                    };

                    let age_days = ((now_ms - item.created_at).max(0) as f32) / (1000.0 * 60.0 * 60.0 * 24.0);
                    let recency_boost = (1.0 / (1.0 + age_days / 7.0)) * 3.0;
                    let final_score = weighted * 100.0 + recency_boost;
                    if final_score >= cutoff {
                        scored.push((item, final_score));
                    }
                }

                scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
                let start = (offset as usize).min(scored.len());
                let end = (start + limit as usize).min(scored.len());
                result = scored[start..end]
                    .iter()
                    .map(|(item, _)| item.clone())
                    .collect();
            } else {
                result.clear();
            }
        } else if ordered_ids.is_some() {
            let start = (offset as usize).min(result.len());
            let end = (start + limit as usize).min(result.len());
            result = result[start..end].to_vec();
        }

        let n = result.len();
        debug!("[CMD] list_inspirations | count={}", n);
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Cursor-based pagination for history view. Returns inspirations ordered by created_at DESC.
/// params: { cursor: number | null (last created_at from previous page), limit: number (default 50) }
#[tauri::command]
pub async fn list_inspirations_history(
    db: State<'_, Arc<Db>>,
    vault: State<'_, Arc<VaultPaths>>,
    params: Option<serde_json::Value>,
) -> Result<Vec<InspirationRow>, String> {
    cmd_log!("list_inspirations_history");
    let db = db.inner().clone();
    let vault = vault.inner().clone();
    let params = params.unwrap_or(serde_json::json!({}));
    let cursor = params.get("cursor").and_then(|c| c.as_i64());
    let limit = params.get("limit").and_then(|l| l.as_u64()).unwrap_or(50) as i64;
    let limit = limit.clamp(1, 100);

    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.conn();
        // Cursor-based: WHERE (? IS NULL OR i.created_at < ?) ORDER BY created_at DESC LIMIT ?
        let sql = "SELECT i.id, i.type, i.title, i.source_url, i.original_filename, i.stored_path, i.thumbnail_path, i.display_row, i.aspect_ratio, i.created_at, i.updated_at, i.vault_id, i.mime_type, i.palette FROM inspirations i WHERE (?1 IS NULL OR i.created_at < ?2) ORDER BY i.created_at DESC LIMIT ?3";
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let cursor_val = cursor.unwrap_or(0);
        let rows = stmt
            .query_map(rusqlite::params![cursor, cursor_val, limit], |r| {
                Ok(InspirationRow {
                    id: r.get(0)?,
                    r#type: r.get(1)?,
                    title: r.get(2)?,
                    source_url: r.get(3)?,
                    original_filename: r.get(4)?,
                    stored_path: r.get(5)?,
                    thumbnail_path: r.get(6)?,
                    display_row: r.get(7)?,
                    aspect_ratio: r.get(8)?,
                    created_at: r.get(9)?,
                    updated_at: r.get(10)?,
                    vault_id: r.get(11)?,
                    mime_type: r.get(12)?,
                    stored_path_url: None,
                    thumbnail_path_url: None,
                    stored_path_abs: None,
                    thumbnail_path_abs: None,
                    tags: None,
                    palette: r.get::<_, Option<String>>(13)?.and_then(|s| serde_json::from_str(&s).ok()),
                })
            })
            .map_err(|e| e.to_string())?;

        let mut result: Vec<InspirationRow> = Vec::new();
        for row in rows {
            let mut r = row.map_err(|e| e.to_string())?;
            populate_inspiration_row_paths(&mut r, &vault.root);
            result.push(r);
        }
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn get_app_info(
    db: State<Arc<Db>>,
    vault: State<Arc<VaultPaths>>,
) -> Result<serde_json::Value, String> {
    cmd_log!("get_app_info");
    let conn = db.conn();
    let counts = conn
        .query_row(
            "SELECT
                (SELECT COUNT(*) FROM inspirations) AS i,
                (SELECT COUNT(*) FROM collections) AS c",
            [],
            |r| {
                Ok(serde_json::json!({
                    "inspirations": r.get::<_, i64>(0)?,
                    "collections": r.get::<_, i64>(1)?,
                }))
            },
        )
        .map_err(|e| e.to_string())?;

    Ok(serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "schemaVersion": 4,
        "vaultRoot": vault.root.to_string_lossy(),
        "counts": counts
    }))
}

#[tauri::command]
pub fn get_absolute_path_for_file(
    vault: State<Arc<VaultPaths>>,
    rel_path: String,
) -> Result<String, String> {
    cmd_log!("get_absolute_path_for_file");
    resolve_vault_relative_existing_path(&vault.root, &rel_path)
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn read_image_as_base64(
    vault: State<'_, Arc<VaultPaths>>,
    path: String,
) -> Result<String, String> {
    cmd_log!("read_image_as_base64");
    let vault_root = vault
        .root
        .canonicalize()
        .unwrap_or_else(|_| vault.root.clone());
    tauri::async_runtime::spawn_blocking(move || {
        let resolved = PathBuf::from(path)
            .canonicalize()
            .map_err(|e| format!("Failed to read file path: {}", e))?;
        if !resolved.starts_with(&vault_root) {
            return Err("Image path is outside vault".to_string());
        }
        if !resolved.is_file() {
            return Err("Image path is not a file".to_string());
        }
        let bytes = fs::read(&resolved).map_err(|e| format!("Failed to read file: {}", e))?;
        if bytes.is_empty() {
            return Err("Image file is empty".to_string());
        }
        let ext_mime = match resolved
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str()
        {
            "jpg" | "jpeg" => Some("image/jpeg"),
            "png" => Some("image/png"),
            "webp" => Some("image/webp"),
            "gif" => Some("image/gif"),
            "bmp" => Some("image/bmp"),
            "avif" => Some("image/avif"),
            _ => None,
        };
        let sniffed_mime = detect_mime_from_bytes(&bytes);
        let mime = if sniffed_mime.starts_with("image/") {
            sniffed_mime
        } else if let Some(m) = ext_mime {
            m
        } else {
            return Err("Unsupported image format for OCR source".to_string());
        };
        let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
        Ok(format!("data:{};base64,{}", mime, b64))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn copy_file_to_clipboard(
    db: State<Arc<Db>>,
    vault: State<Arc<VaultPaths>>,
    rel_path: String,
) -> Result<(), String> {
    cmd_log!("copy_file_to_clipboard");
    let clip_start = std::time::Instant::now();
    let abs = resolve_vault_relative_existing_path(&vault.root, &rel_path)?;
    if !abs.is_file() {
        error!("[copy] failed | stage=resolve | error=not_a_file");
        return Err("Only local media files can be copied.".to_string());
    }
    let abs_text = normalize_windows_verbatim_prefix(&abs.to_string_lossy());
    let rel_text = vault_relative_path_for_lookup(&vault.root, &abs);
    let vault_file_name = abs
        .file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.to_string());

    let (inspiration_id, original_filename, mime_for_clip): (
        Option<String>,
        Option<String>,
        Option<String>,
    ) = {
        let conn = db.conn();
        let try_paths = || {
            conn.query_row(
                "SELECT id, original_filename, mime_type
                 FROM inspirations
                 WHERE stored_path = ?1 OR thumbnail_path = ?1
                    OR stored_path = ?2 OR thumbnail_path = ?2
                 LIMIT 1",
                rusqlite::params![&rel_text, &abs_text],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, Option<String>>(1)?,
                        r.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|e| e.to_string())
        };
        let row = try_paths()?;
        match row {
            Some((id, on, mt)) => (Some(id), on, mt),
            None => {
                if let Some(ref vid) = vault_file_name {
                    if let Some((id, on, mt)) = conn
                        .query_row(
                            "SELECT id, original_filename, mime_type
                             FROM inspirations WHERE vault_id = ?1 LIMIT 1",
                            [vid.as_str()],
                            |r| {
                                Ok((
                                    r.get::<_, String>(0)?,
                                    r.get::<_, Option<String>>(1)?,
                                    r.get::<_, Option<String>>(2)?,
                                ))
                            },
                        )
                        .optional()
                        .map_err(|e| e.to_string())?
                    {
                        (Some(id), on, mt)
                    } else {
                        (None, None, None)
                    }
                } else {
                    (None, None, None)
                }
            }
        }
    };

    let sanitized_name = original_filename
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| {
            s.chars()
                .map(|ch| match ch {
                    '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
                    _ => ch,
                })
                .collect::<String>()
        })
        .filter(|s| !s.is_empty())
        .or_else(|| {
            extension_for_mime_clipboard(mime_for_clip.as_deref()).map(|ext| format!("qooti_clipboard.{ext}"))
        })
        .unwrap_or_else(|| {
            abs.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("qooti-file")
                .to_string()
        });
    let temp_dir = std::env::temp_dir().join("qooti_copy");
    fs::create_dir_all(&temp_dir).map_err(|e| format!("Failed to prepare temp copy folder: {}", e))?;
    let temp_path = temp_dir.join(&sanitized_name);
    fs::copy(&abs, &temp_path).map_err(|e| format!("Failed to prepare clipboard file: {}", e))?;
    if !temp_path.exists() {
        error!(
            "[copy] failed | item_id={} | stage=temp | error=missing_temp",
            inspiration_id.as_deref().unwrap_or("-")
        );
        return Err("Temp file was not created".to_string());
    }
    let temp_size = fs::metadata(&temp_path).map(|m| m.len()).unwrap_or(0);
    debug!(
        "[copy] temp_file | name={:?} | size_bytes={}",
        temp_path.file_name(),
        temp_size
    );
    info!(
        "[copy] starting | item_id={} | vault_rel={} | clip_name={} | size_bytes={}",
        inspiration_id.as_deref().unwrap_or("-"),
        rel_text,
        sanitized_name,
        temp_size
    );

    #[cfg(target_os = "windows")]
    {
        debug!("[copy] clipboard | os=windows | stage=powershell");
        let clipboard_path = normalize_windows_clipboard_path(&temp_path);
        let escaped = clipboard_path.replace('\'', "''");
        let script = format!(
            "Add-Type -AssemblyName System.Windows.Forms; $files = New-Object System.Collections.Specialized.StringCollection; $null = $files.Add('{}'); [System.Windows.Forms.Clipboard]::SetFileDropList($files)",
            escaped
        );
        let mut cmd = Command::new("powershell");
        suppress_console_window(&mut cmd);
        let output = cmd
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-STA",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &script,
            ])
            .output()
            .map_err(|e| format!("Could not access clipboard: {}", e))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            error!(
                "[copy] failed | item_id={} | stage=clipboard | os=windows | error={}",
                inspiration_id.as_deref().unwrap_or("-"),
                stderr
            );
            return Err(if stderr.is_empty() {
                "Could not copy file to clipboard.".to_string()
            } else {
                stderr
            });
        }
        info!(
            "[copy] clipboard | os=windows | status=ok | duration={}ms",
            clip_start.elapsed().as_millis()
        );
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        debug!("[copy] clipboard | os=macos | stage=osascript");
        let clipboard_path = temp_path
            .canonicalize()
            .unwrap_or(temp_path)
            .to_string_lossy()
            .replace('"', "\\\"");
        let script = format!(r#"set the clipboard to (POSIX file "{}")"#, clipboard_path);
        let output = Command::new("osascript")
            .args(["-e", &script])
            .output()
            .map_err(|e| format!("Could not access clipboard: {}", e))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            error!(
                "[copy] failed | item_id={} | stage=clipboard | os=macos | error={}",
                inspiration_id.as_deref().unwrap_or("-"),
                stderr
            );
            return Err(if stderr.is_empty() {
                "Could not copy file to clipboard.".to_string()
            } else {
                stderr
            });
        }
        info!(
            "[copy] clipboard | os=macos | status=ok | duration={}ms",
            clip_start.elapsed().as_millis()
        );
        return Ok(());
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Err("Copying local files to clipboard is currently supported on Windows and macOS only.".to_string())
    }
}

#[tauri::command]
pub fn copy_text_to_clipboard(text: String) -> Result<(), String> {
    cmd_log!("copy_text_to_clipboard");
    let value = text.trim();
    if value.is_empty() {
        return Err("Nothing to copy.".to_string());
    }
    // Native clipboard (Tauri): avoids flaky renderer Clipboard API and shell helpers (pbcopy / PowerShell).
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    {
        let mut clipboard = arboard::Clipboard::new()
            .map_err(|e| format!("Could not access clipboard: {}", e))?;
        clipboard
            .set_text(value)
            .map_err(|e| format!("Could not copy text to clipboard: {}", e))?;
        return Ok(());
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Err("Copying text to clipboard is not supported on this platform.".to_string())
    }
}

#[cfg(target_os = "windows")]
fn normalize_windows_clipboard_path(path: &Path) -> String {
    let raw = path.to_string_lossy();
    if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{}", rest)
    } else if let Some(rest) = raw.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        raw.into_owned()
    }
}

/// Strip internal "(Imported 123...)" suffix from collection name so it never appears in UI.
fn collection_display_name(raw: &str) -> String {
    let re = Regex::new(r"(?i)\s*\(Imported\s+\d+\)\s*$").unwrap();
    let binding = re.replace(raw.trim(), "");
    let s = binding.trim();
    if s.is_empty() {
        "Collection".to_string()
    } else {
        s.to_string()
    }
}

const DEFAULT_UNSORTED_COLLECTION_ID: &str = "qooti-unsorted-default";
const DEFAULT_UNSORTED_COLLECTION_NAME: &str = "Unsorted";

fn ensure_default_unsorted_collection(conn: &Connection) -> Result<(), String> {
    let ts = now_ms();
    conn.execute(
        "INSERT OR IGNORE INTO collections (id, name, created_at, updated_at, visible_on_home) VALUES (?, ?, ?, ?, 1)",
        rusqlite::params![
            DEFAULT_UNSORTED_COLLECTION_ID,
            DEFAULT_UNSORTED_COLLECTION_NAME,
            ts,
            ts
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn add_inspiration_to_unsorted(conn: &Connection, inspiration_id: &str) -> Result<(), String> {
    if inspiration_id.trim().is_empty() {
        return Ok(());
    }
    ensure_default_unsorted_collection(conn)?;
    let ts = now_ms();
    let changed = conn
        .execute(
            "INSERT OR IGNORE INTO collection_items (collection_id, inspiration_id, position, created_at) VALUES (?, ?, NULL, ?)",
            rusqlite::params![DEFAULT_UNSORTED_COLLECTION_ID, inspiration_id, ts],
        )
        .map_err(|e| e.to_string())?;
    if changed > 0 {
        conn.execute(
            "UPDATE collections SET updated_at = ? WHERE id = ?",
            rusqlite::params![ts, DEFAULT_UNSORTED_COLLECTION_ID],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn sync_unsorted_membership(conn: &Connection) -> Result<(), String> {
    ensure_default_unsorted_collection(conn)?;
    let ts = now_ms();
    let changed = conn
        .execute(
            "INSERT OR IGNORE INTO collection_items (collection_id, inspiration_id, position, created_at)
             SELECT ?, i.id, NULL, ?
             FROM inspirations i
             LEFT JOIN collection_items ci ON ci.inspiration_id = i.id
             WHERE ci.inspiration_id IS NULL",
            rusqlite::params![DEFAULT_UNSORTED_COLLECTION_ID, ts],
        )
        .map_err(|e| e.to_string())?;
    if changed > 0 {
        conn.execute(
            "UPDATE collections SET updated_at = ? WHERE id = ?",
            rusqlite::params![ts, DEFAULT_UNSORTED_COLLECTION_ID],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Serialize)]
pub struct CollectionRow {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_count: Option<i64>,
    /// When true, collection appears in the navbar "Collections" dropdown (home).
    #[serde(default)]
    pub visible_on_home: bool,
}

#[tauri::command]
pub async fn list_collections(db: State<'_, Arc<Db>>) -> Result<Vec<CollectionRow>, String> {
    cmd_log!("list_collections");
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.conn();
        ensure_default_unsorted_collection(&conn)?;
        sync_unsorted_membership(&conn)?;
        let mut stmt = conn
            .prepare(
                "SELECT c.id, c.name, c.created_at, c.updated_at, COUNT(ci.inspiration_id) AS item_count, COALESCE(c.visible_on_home, 1)
                 FROM collections c
                 LEFT JOIN collection_items ci ON ci.collection_id = c.id
                 GROUP BY c.id, c.name, c.created_at, c.updated_at
                 ORDER BY c.name",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                let raw_name: String = r.get(1)?;
                let visible: i64 = r.get(5).unwrap_or(1);
                Ok(CollectionRow {
                    id: r.get(0)?,
                    name: collection_display_name(&raw_name),
                    created_at: r.get(2)?,
                    updated_at: r.get(3)?,
                    item_count: Some(r.get(4)?),
                    visible_on_home: visible != 0,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn create_collection(db: State<Arc<Db>>, name: String) -> Result<CollectionRow, String> {
    cmd_log!("create_collection");
    let name = name.trim();
    if name.is_empty() {
        return Err("Collection name cannot be empty".to_string());
    }
    let id = Uuid::new_v4().to_string();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;

    let conn = db.conn();
    conn.execute(
        "INSERT INTO collections (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
        rusqlite::params![id, name, ts, ts],
    )
    .map_err(|e| e.to_string())?;

    Ok(CollectionRow {
        id: id.clone(),
        name: name.to_string(),
        created_at: ts,
        updated_at: ts,
        item_count: Some(0),
        visible_on_home: true,
    })
}

#[tauri::command]
pub fn rename_collection(
    db: State<Arc<Db>>,
    collection_id: String,
    new_name: String,
) -> Result<(), String> {
    cmd_log!("rename_collection");
    if collection_id == DEFAULT_UNSORTED_COLLECTION_ID {
        return Err("Default collection cannot be renamed".to_string());
    }
    let new_name = new_name.trim();
    if new_name.is_empty() {
        return Err("Collection name cannot be empty".to_string());
    }
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;

    let conn = db.conn();
    let n = conn
        .execute(
            "UPDATE collections SET name = ?, updated_at = ? WHERE id = ?",
            rusqlite::params![new_name, ts, collection_id],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("Collection not found".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn delete_collection(db: State<Arc<Db>>, collection_id: String) -> Result<(), String> {
    cmd_log!("delete_collection");
    if collection_id == DEFAULT_UNSORTED_COLLECTION_ID {
        return Err("Default collection cannot be deleted".to_string());
    }
    let conn = db.conn();
    conn.execute(
        "DELETE FROM collection_items WHERE collection_id = ?",
        [&collection_id],
    )
    .map_err(|e| e.to_string())?;
    let n = conn
        .execute("DELETE FROM collections WHERE id = ?", [&collection_id])
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("Collection not found".to_string());
    }
    sync_unsorted_membership(&conn)?;
    Ok(())
}

#[tauri::command]
pub fn set_collection_visible_on_home(
    db: State<Arc<Db>>,
    collection_id: String,
    visible: bool,
) -> Result<(), String> {
    cmd_log!("set_collection_visible_on_home");
    let conn = db.conn();
    let n = conn
        .execute(
            "UPDATE collections SET visible_on_home = ? WHERE id = ?",
            rusqlite::params![if visible { 1i32 } else { 0i32 }, collection_id],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("Collection not found".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn set_collection_profile_image(
    vault: State<'_, Arc<VaultPaths>>,
    collection_id: String,
    profile_image_data_url: Option<String>,
) -> Result<(), String> {
    cmd_log!("set_collection_profile_image");
    let profile_dir = vault.root.join("collection_profiles");
    let path = profile_dir.join(format!("{}.png", collection_id));
    if let Some(ref data_url) = profile_image_data_url {
        let s = data_url.trim();
        if s.is_empty() {
            let _ = fs::remove_file(&path);
            return Ok(());
        }
        if !s.starts_with("data:image/") {
            return Err("Profile image must be an image data URL".to_string());
        }
        let base64_idx = s
            .find(";base64,")
            .ok_or("Profile image must be base64 encoded")?;
        let payload = &s[(base64_idx + ";base64,".len())..];
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(payload)
            .map_err(|_| "Invalid profile image encoding")?;
        fs::create_dir_all(&profile_dir).map_err(|e| e.to_string())?;
        fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    } else {
        let _ = fs::remove_file(&path);
    }
    Ok(())
}

#[tauri::command]
pub fn add_to_collection(
    db: State<Arc<Db>>,
    collection_id: String,
    inspiration_ids: Vec<String>,
) -> Result<(), String> {
    cmd_log!("add_to_collection");
    if inspiration_ids.is_empty() {
        return Ok(());
    }
    let ts = now_ms();

    let conn = db.conn();
    ensure_default_unsorted_collection(&conn)?;
    for (pos, id) in inspiration_ids.iter().enumerate() {
        let _ = conn.execute(
            "INSERT OR IGNORE INTO collection_items (collection_id, inspiration_id, position, created_at) VALUES (?, ?, ?, ?)",
            rusqlite::params![collection_id, id, pos as i32, ts],
        );
    }
    if collection_id != DEFAULT_UNSORTED_COLLECTION_ID {
        for id in &inspiration_ids {
            let _ = conn.execute(
                "DELETE FROM collection_items WHERE collection_id = ? AND inspiration_id = ?",
                rusqlite::params![DEFAULT_UNSORTED_COLLECTION_ID, id],
            );
        }
        let _ = conn.execute(
            "UPDATE collections SET updated_at = ? WHERE id = ?",
            rusqlite::params![ts, DEFAULT_UNSORTED_COLLECTION_ID],
        );
    }
    conn.execute(
        "UPDATE collections SET updated_at = ? WHERE id = ?",
        rusqlite::params![ts, collection_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn remove_from_collection(
    db: State<Arc<Db>>,
    collection_id: String,
    inspiration_id: String,
) -> Result<(), String> {
    cmd_log!("remove_from_collection");
    let conn = db.conn();
    conn.execute(
        "DELETE FROM collection_items WHERE collection_id = ? AND inspiration_id = ?",
        rusqlite::params![collection_id, inspiration_id],
    )
    .map_err(|e| e.to_string())?;
    sync_unsorted_membership(&conn)?;
    Ok(())
}

#[tauri::command]
pub async fn get_collections_for_inspiration(
    db: State<'_, Arc<Db>>,
    inspiration_id: String,
) -> Result<Vec<CollectionRow>, String> {
    cmd_log!("get_collections_for_inspiration");
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.conn();
        let mut stmt = conn
            .prepare(
                "SELECT c.id, c.name, c.created_at, c.updated_at FROM collections c
                 INNER JOIN collection_items ci ON ci.collection_id = c.id
                 WHERE ci.inspiration_id = ?
                 ORDER BY c.name",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([&inspiration_id], |r| {
                let raw_name: String = r.get(1)?;
                Ok(CollectionRow {
                    id: r.get(0)?,
                    name: collection_display_name(&raw_name),
                    created_at: r.get(2)?,
                    updated_at: r.get(3)?,
                    item_count: None,
                    visible_on_home: true,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Safe default filename stem for the save dialog (manifest still uses the full display name).
fn sanitize_pack_default_filename_stem(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            _ => c,
        })
        .collect();
    let trimmed = s.trim().trim_end_matches('.').to_string();
    if trimmed.is_empty() {
        return "collection-pack".to_string();
    }
    const MAX_STEM: usize = 180;
    if trimmed.chars().count() > MAX_STEM {
        trimmed.chars().take(MAX_STEM).collect()
    } else {
        trimmed
    }
}

#[tauri::command]
pub async fn export_collection_as_pack(
    app: AppHandle,
    db: State<'_, Arc<Db>>,
    vault: State<'_, Arc<VaultPaths>>,
    collection_id: String,
    pack_name: String,
    profile_image_data_url: Option<String>,
) -> Result<serde_json::Value, String> {
    cmd_log!("export_collection_as_pack");
    let normalized_name = pack_name
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string();
    if normalized_name.is_empty() {
        return Err("Pack name is required".to_string());
    }
    const MAX_PACK_NAME_CHARS: usize = 256;
    if normalized_name.chars().count() > MAX_PACK_NAME_CHARS {
        return Err(format!(
            "Pack name must be {} characters or fewer",
            MAX_PACK_NAME_CHARS
        ));
    }

    let default_stem = sanitize_pack_default_filename_stem(&normalized_name);
    let default_name = format!("{}.qooti", default_stem);

    let path = app
        .dialog()
        .file()
        .set_file_name(&default_name)
        .add_filter("Qooti Pack", &["qooti"])
        .set_title("Export collection")
        .blocking_save_file();

    let out_path = match path.and_then(|p| p.as_path().map(PathBuf::from)) {
        Some(p) => p,
        None => return Err("Export cancelled".to_string()),
    };

    let app_version = app.package_info().version.to_string();
    let db = db.inner().clone();
    let vault_root = vault.root.clone();
    let app_emit = app.clone();
    let collection_id_owned = collection_id.clone();
    let normalized_owned = normalized_name.clone();
    let profile_owned = profile_image_data_url.clone();

    let export_result = tauri::async_runtime::spawn_blocking(move || {
        let conn = db.conn();
        crate::pack::export_collection(
            &*conn,
            &vault_root,
            &collection_id_owned,
            &out_path,
            Some(app_version.as_str()),
            &normalized_owned,
            profile_owned.as_deref(),
            Some(move |msg: &str, pct: u8| {
                let _ = app_emit.emit(
                    "collection-pack-export-progress",
                    serde_json::json!({
                        "percent": pct,
                        "message": msg,
                    }),
                );
            }),
        )
    })
    .await
    .map_err(|e| e.to_string())?;

    let (saved_path, bundled, skipped) = export_result.map_err(|e| e.to_string())?;

    Ok(serde_json::json!({
        "savedPath": saved_path,
        "bundled": bundled,
        "skipped": skipped
    }))
}

#[tauri::command]
pub async fn select_collection_pack_file(app: AppHandle) -> Result<Option<String>, String> {
    cmd_log!("select_collection_pack_file");
    let path = app
        .dialog()
        .file()
        .add_filter("Qooti Pack", &["qooti"])
        .set_title("Select .qooti file")
        .blocking_pick_file();
    Ok(path
        .and_then(|p| p.as_path().map(PathBuf::from))
        .map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn inspect_collection_pack(pack_path: String) -> Result<serde_json::Value, String> {
    cmd_log!("inspect_collection_pack");
    let path = PathBuf::from(pack_path);
    let ext_ok = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.eq_ignore_ascii_case("qooti"))
        .unwrap_or(false);
    if !ext_ok {
        return Err("Invalid file extension. Expected .qooti".to_string());
    }
    let preview = crate::pack::inspect_pack(&path)?;
    serde_json::to_value(preview).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn import_collection_pack(
    app: AppHandle,
    db: State<'_, Arc<Db>>,
    vault: State<'_, Arc<VaultPaths>>,
    pack_path: Option<String>,
) -> Result<serde_json::Value, String> {
    cmd_log!("import_collection_pack");
    let chosen_path = match pack_path {
        Some(p) => PathBuf::from(p),
        None => {
            let path = app
                .dialog()
                .file()
                .add_filter("Qooti Pack", &["qooti"])
                .set_title("Import collection")
                .blocking_pick_file();
            match path.and_then(|p| p.as_path().map(PathBuf::from)) {
                Some(p) => p,
                None => return Err("Import cancelled".to_string()),
            }
        }
    };
    let ext_ok = chosen_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.eq_ignore_ascii_case("qooti"))
        .unwrap_or(false);
    if !ext_ok {
        return Err("Invalid file extension. Expected .qooti".to_string());
    }

    let conn = db.conn();
    let (collection_id, collection_name, imported, errors) =
        crate::pack::import_pack(&conn, &vault.root, &chosen_path)?;
    let display_name = collection_display_name(&collection_name);

    Ok(serde_json::json!({
        "collectionId": collection_id,
        "collectionName": display_name,
        "imported": imported,
        "errors": errors
    }))
}

#[tauri::command]
pub async fn select_telegram_export_folder(app: AppHandle) -> Result<Option<String>, String> {
    cmd_log!("select_telegram_export_folder");
    let path = app
        .dialog()
        .file()
        .set_title("Select Telegram export folder")
        .blocking_pick_folder();
    Ok(path
        .and_then(|p| p.as_path().map(PathBuf::from))
        .map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn inspect_telegram_export(folder_path: String) -> Result<serde_json::Value, String> {
    cmd_log!("inspect_telegram_export");
    let folder = PathBuf::from(folder_path);
    let (preview, _) = parse_telegram_export(&folder)?;
    serde_json::to_value(preview).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn import_telegram_export(
    app: AppHandle,
    db: State<'_, Arc<Db>>,
    vault: State<'_, Arc<VaultPaths>>,
    payload: TelegramImportPayload,
) -> Result<serde_json::Value, String> {
    cmd_log!("import_telegram_export");
    let db = db.inner().clone();
    let vault = vault.inner().clone();
    let app_handle = app.clone();
    let folder = PathBuf::from(payload.folder_path.clone());

    let summary = tauri::async_runtime::spawn_blocking(move || -> Result<TelegramImportSummary, String> {
        let (preview, candidates) = parse_telegram_export(&folder)?;
        let total = candidates.len();
        if total == 0 {
            return Ok(TelegramImportSummary {
                imported: 0,
                duplicates: 0,
                failed: 0,
                skipped_unsupported: preview.skipped_unsupported,
                total_candidates: 0,
                collection_id: None,
                collection_name: None,
            });
        }

        let conn = db.conn();
        let ts_now = now_ms();
        let (collection_id_opt, collection_name_opt) = match payload.collection_mode.as_str() {
            "new" => {
                let base = payload
                    .collection_name
                    .clone()
                    .unwrap_or_else(|| format!("Telegram - {}", preview.channel_name))
                    .trim()
                    .to_string();
                let name = if base.is_empty() {
                    "Telegram Import".to_string()
                } else {
                    base
                };
                let collection_id = Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO collections (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
                    rusqlite::params![&collection_id, &name, ts_now, ts_now],
                )
                .map_err(|e| e.to_string())?;
                (Some(collection_id), Some(name))
            }
            "existing" => {
                let cid = payload
                    .collection_id
                    .clone()
                    .ok_or("Please select a collection.")?;
                let existing_name: Option<String> = conn
                    .query_row("SELECT name FROM collections WHERE id = ?", [&cid], |r| r.get(0))
                    .optional()
                    .map_err(|e: rusqlite::Error| e.to_string())?;
                let Some(name) = existing_name else {
                    return Err("Selected collection was not found.".to_string());
                };
                (Some(cid), Some(name))
            }
            _ => (None, None),
        };

        let mut imported = 0usize;
        let mut duplicates = 0usize;
        let mut failed = 0usize;
        let mut seen_hashes: HashSet<String> = HashSet::new();
        let existing_hash_index = build_existing_hash_index(&conn, &vault);
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

        let _ = app_handle.emit(
            "telegram-import-progress",
            TelegramImportProgress {
                stage: "start".to_string(),
                current: 0,
                total,
            },
        );

        for (idx, candidate) in candidates.iter().enumerate() {
            let current = idx + 1;
            let _ = app_handle.emit(
                "telegram-import-progress",
                TelegramImportProgress {
                    stage: "progress".to_string(),
                    current,
                    total,
                },
            );

            let src_abs = folder.join(candidate.source_rel_path.replace('/', std::path::MAIN_SEPARATOR_STR));
            let bytes = match fs::read(&src_abs) {
                Ok(b) => b,
                Err(_) => {
                    failed += 1;
                    continue;
                }
            };
            let content_hash = hex_sha256(&bytes);
            if seen_hashes.contains(&content_hash) {
                duplicates += 1;
                continue;
            }
            seen_hashes.insert(content_hash.clone());

            let existing_by_url: Option<String> = if let Some(url) = candidate.source_url.as_ref().filter(|s| !s.trim().is_empty()) {
                tx.query_row(
                    "SELECT id FROM inspirations WHERE source_url = ? LIMIT 1",
                    [url],
                    |r| r.get::<_, String>(0),
                )
                .optional()
                .map_err(|e: rusqlite::Error| e.to_string())?
            } else {
                None
            };
            let existing_by_identity: Option<String> = tx
                .query_row(
                    "SELECT id FROM inspirations WHERE original_filename = ? AND type = ? AND created_at = ? LIMIT 1",
                    rusqlite::params![&candidate.original_filename, &candidate.media_type, candidate.created_at],
                    |r| r.get::<_, String>(0),
                )
                .optional()
                .map_err(|e: rusqlite::Error| e.to_string())?;
            let existing_by_hash = existing_hash_index.get(&content_hash).cloned();
            let existing_id = existing_by_url.or(existing_by_identity).or(existing_by_hash);
            if let Some(existing_inspiration_id) = existing_id {
                if let Some(collection_id) = collection_id_opt.as_ref() {
                    let _ = tx.execute(
                        "INSERT OR IGNORE INTO collection_items (collection_id, inspiration_id, position, created_at) VALUES (?, ?, ?, ?)",
                        rusqlite::params![collection_id, existing_inspiration_id, current as i32, ts_now],
                    );
                }
                duplicates += 1;
                continue;
            }

            let new_id = Uuid::new_v4().to_string();
            let stored_abs = next_vault_uuid_path(&vault.media_dir);
            let vault_id = stored_abs
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default()
                .to_string();
            if fs::create_dir_all(&vault.media_dir).is_err() || fs::write(&stored_abs, &bytes).is_err() {
                failed += 1;
                continue;
            }
            let stored_rel = rel_to_vault(&vault.root, &stored_abs);
            let mime_type = detect_mime_from_filename(&candidate.original_filename);
            let title = candidate
                .title
                .clone()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| {
                    Path::new(&candidate.original_filename)
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("Telegram media")
                        .to_string()
                });
            let aspect_ratio = get_media_aspect_ratio(&stored_abs, &candidate.media_type);
            if tx
                .execute(
                    r#"INSERT INTO inspirations (id, type, title, source_url, original_filename, stored_path, thumbnail_path, display_row, aspect_ratio, created_at, updated_at, vault_id, mime_type)
                       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)"#,
                    rusqlite::params![
                        &new_id,
                        &candidate.media_type,
                        &title,
                        candidate.source_url.clone(),
                        &candidate.original_filename,
                        &stored_rel,
                        aspect_ratio,
                        candidate.created_at,
                        candidate.created_at,
                        &vault_id,
                        &mime_type
                    ],
                )
                .is_err()
            {
                let _ = fs::remove_file(&stored_abs);
                failed += 1;
                continue;
            }

            // Source tag=telegram, format tag=media type, orientation tag from aspect ratio.
            let _ = tags::apply_system_tags(
                &tx,
                &new_id,
                "telegram",
                &candidate.media_type,
                aspect_ratio,
                Some("telegram"),
                Some(&preview.channel_name),
            );

            if let Some(collection_id) = collection_id_opt.as_ref() {
                let _ = tx.execute(
                    "INSERT OR IGNORE INTO collection_items (collection_id, inspiration_id, position, created_at) VALUES (?, ?, ?, ?)",
                    rusqlite::params![collection_id, &new_id, current as i32, ts_now],
                );
            }
            imported += 1;
        }

        if let Some(collection_id) = collection_id_opt.as_ref() {
            let _ = tx.execute(
                "UPDATE collections SET updated_at = ? WHERE id = ?",
                rusqlite::params![ts_now, collection_id],
            );
        }
        tx.commit().map_err(|e| e.to_string())?;
        let _ = app_handle.emit(
            "telegram-import-progress",
            TelegramImportProgress {
                stage: "done".to_string(),
                current: total,
                total,
            },
        );

        Ok(TelegramImportSummary {
            imported,
            duplicates,
            failed,
            skipped_unsupported: preview.skipped_unsupported,
            total_candidates: total,
            collection_id: collection_id_opt,
            collection_name: collection_name_opt.map(|n| collection_display_name(&n)),
        })
    })
    .await
    .map_err(|e| e.to_string())??;

    serde_json::to_value(summary).map_err(|e| e.to_string())
}

fn extract_zip_recursive(zip_path: &Path, output_dir: &Path) -> Result<(), String> {
    let file = fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir() {
            continue;
        }
        let entry_name = entry.name().replace('\\', "/");
        if entry_name.contains("..") || entry_name.starts_with('/') {
            continue;
        }
        let out_path = output_dir.join(&entry_name);
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }

        let lower = entry_name.to_lowercase();
        if lower.ends_with(".zip") {
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
            fs::write(&out_path, &bytes).map_err(|e| e.to_string())?;
            extract_zip_recursive(&out_path, output_dir)?;
            continue;
        }

        let mut out_file = fs::File::create(&out_path).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out_file).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn collect_media_files_recursive(dir: &Path, out: &mut Vec<String>) {
    let entries = match fs::read_dir(dir) {
        Ok(v) => v,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_media_files_recursive(&path, out);
            continue;
        }
        if detect_media_type(&path).is_some() {
            out.push(path.to_string_lossy().to_string());
        }
    }
}

/// Parse Notion export `.md` files to extract tags for each referenced media file.
/// Returns a map: normalized media filename (lowercase) -> Vec<tag labels>.
fn parse_notion_md_tags(dir: &Path) -> std::collections::HashMap<String, Vec<String>> {
    let mut map: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    collect_notion_md_tags_recursive(dir, &mut map);
    map
}

fn collect_notion_md_tags_recursive(
    dir: &Path,
    map: &mut std::collections::HashMap<String, Vec<String>>,
) {
    let entries = match fs::read_dir(dir) {
        Ok(v) => v,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_notion_md_tags_recursive(&path, map);
            continue;
        }
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if !ext.eq_ignore_ascii_case("md") {
            continue;
        }
        let content = match fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let mut tag_labels: Vec<String> = Vec::new();
        let mut media_refs: Vec<String> = Vec::new();
        for line in content.lines() {
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix("Tags:") {
                for tag in rest.split(',') {
                    let t = tag.trim().to_string();
                    if !t.is_empty() {
                        tag_labels.push(t);
                    }
                }
            }
            if trimmed.starts_with("![") {
                if let Some(start) = trimmed.find("](") {
                    let after = &trimmed[start + 2..];
                    if let Some(end) = after.find(')') {
                        let raw_ref = &after[..end];
                        let decoded = urlencoding::decode(raw_ref)
                            .map(|s| s.to_string())
                            .unwrap_or_else(|_| raw_ref.to_string());
                        media_refs.push(decoded);
                    }
                }
            }
        }
        if tag_labels.is_empty() || media_refs.is_empty() {
            continue;
        }
        for media_ref in &media_refs {
            let filename = Path::new(media_ref)
                .file_name()
                .map(|f| f.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            if !filename.is_empty() {
                let entry = map.entry(filename).or_default();
                for t in &tag_labels {
                    if !entry.iter().any(|e| e.eq_ignore_ascii_case(t)) {
                        entry.push(t.clone());
                    }
                }
            }
        }
    }
}

#[derive(Deserialize)]
pub struct NotionZipImportPayload {
    #[serde(alias = "zipPath")]
    pub zip_path: String,
    #[serde(alias = "saveAsCollection")]
    pub save_as_collection: Option<bool>,
    #[serde(alias = "collectionName")]
    pub collection_name: Option<String>,
}

#[tauri::command]
pub async fn select_notion_export_zip(app: AppHandle) -> Result<Option<String>, String> {
    cmd_log!("select_notion_export_zip");
    let path = app
        .dialog()
        .file()
        .add_filter("ZIP archive", &["zip"])
        .set_title("Select Notion export ZIP")
        .blocking_pick_file();
    Ok(path
        .and_then(|p| p.as_path().map(PathBuf::from))
        .map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn inspect_notion_export_zip(zip_path: String) -> Result<serde_json::Value, String> {
    cmd_log!("inspect_notion_export_zip");
    let zip = PathBuf::from(zip_path.trim());
    if !zip.exists() {
        return Err("ZIP file not found.".to_string());
    }
    if zip
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("zip"))
        != Some(true)
    {
        return Err("Please select a .zip export file.".to_string());
    }

    let result =
        tauri::async_runtime::spawn_blocking(move || -> Result<serde_json::Value, String> {
            let temp_dir =
                std::env::temp_dir().join(format!("qooti_notion_scan_{}", Uuid::new_v4()));
            fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;
            let _cleanup = temp_dir.clone();
            let out = (|| -> Result<serde_json::Value, String> {
                extract_zip_recursive(&zip, &temp_dir)?;
                let mut media_files = Vec::new();
                collect_media_files_recursive(&temp_dir, &mut media_files);
                let total = media_files.len();
                if total == 0 {
                    return Err("No media files found in Notion export ZIP.".to_string());
                }
                let suggested_name = zip
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("Notion Import")
                    .to_string();
                Ok(serde_json::json!({
                    "total": total,
                    "suggestedName": suggested_name
                }))
            })();
            let _ = fs::remove_dir_all(&_cleanup);
            out
        })
        .await
        .map_err(|e| e.to_string())??;

    Ok(result)
}

#[tauri::command]
pub async fn import_notion_export_zip(
    app: AppHandle,
    db: State<'_, Arc<Db>>,
    vault: State<'_, Arc<VaultPaths>>,
    payload: NotionZipImportPayload,
) -> Result<serde_json::Value, String> {
    cmd_log!("import_notion_export_zip");
    let db = db.inner().clone();
    let vault = vault.inner().clone();
    let db_bg = db.clone();
    let vault_bg = vault.clone();
    let zip_path = payload.zip_path.trim().to_string();
    if zip_path.is_empty() {
        return Err("ZIP path is required.".to_string());
    }
    let save_as_collection = payload.save_as_collection.unwrap_or(true);
    let requested_name = payload.collection_name.clone();

    let app_handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let zip = PathBuf::from(zip_path);
        if !zip.exists() {
            return Err("ZIP file not found.".to_string());
        }
        let temp_dir = std::env::temp_dir().join(format!("qooti_notion_import_{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;
        let _cleanup = temp_dir.clone();

        let out = (|| -> Result<serde_json::Value, String> {
            let _ = app_handle.emit(
                "notion-import-progress",
                serde_json::json!({ "stage": "scanning", "status": "Scanning export ZIP…", "current": 0, "total": 0, "percent": 0 }),
            );
            extract_zip_recursive(&zip, &temp_dir)?;
            let mut media_files = Vec::new();
            collect_media_files_recursive(&temp_dir, &mut media_files);
            if media_files.is_empty() {
                return Err("No media files found in Notion export ZIP.".to_string());
            }
            let total = media_files.len();
            let md_tags = parse_notion_md_tags(&temp_dir);
            let _ = app_handle.emit(
                "notion-import-progress",
                serde_json::json!({ "stage": "start", "status": "Preparing files…", "current": 0, "total": total, "percent": 0 }),
            );

            let mut added = Vec::new();
            for (idx, media_path) in media_files.iter().enumerate() {
                let mut one = add_inspirations_from_paths_impl(&db, &vault, vec![media_path.clone()])?;
                if let Some(row) = one.first() {
                    let media_filename = Path::new(media_path)
                        .file_name()
                        .map(|f| f.to_string_lossy().to_lowercase())
                        .unwrap_or_default();
                    if let Some(tag_labels) = md_tags.get(&media_filename) {
                        let conn = db.conn();
                        for label in tag_labels {
                            if let Ok(tag_id) = tags::ensure_tag(&conn, label, "style", "system") {
                                let _ = tags::attach_tag(&conn, &row.id, &tag_id);
                            }
                        }
                    }
                }
                added.append(&mut one);
                let current = idx + 1;
                let pct = ((current as f32 / total as f32) * 100.0).round() as i32;
                let _ = app_handle.emit(
                    "notion-import-progress",
                    serde_json::json!({
                        "stage": "progress",
                        "status": "Processing files",
                        "current": current,
                        "total": total,
                        "percent": pct
                    }),
                );
            }
            let imported = added.len();
            let image_ids: Vec<String> = added
                .iter()
                .filter(|r| r.r#type == "image")
                .map(|r| r.id.clone())
                .collect();
            if !image_ids.is_empty() {
                let db_bg2 = db_bg.clone();
                let vault_bg2 = vault_bg.clone();
                std::thread::spawn(move || {
                    for id in image_ids {
                        let _ = do_extract_palette(&db_bg2, &vault_bg2, &id);
                    }
                });
            }

            let mut collection_id: Option<String> = None;
            let mut collection_name: Option<String> = None;
            if save_as_collection && imported > 0 {
                let conn = db.conn();
                let ts = now_ms();
                let base = requested_name
                    .as_ref()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| {
                        zip.file_stem()
                            .and_then(|s| s.to_str())
                            .unwrap_or("Notion Import")
                            .to_string()
                    });
                let cid = Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO collections (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
                    rusqlite::params![&cid, &base, ts, ts],
                )
                .map_err(|e| e.to_string())?;
                for (pos, row) in added.iter().enumerate() {
                    let _ = conn.execute(
                        "INSERT OR IGNORE INTO collection_items (collection_id, inspiration_id, position, created_at) VALUES (?, ?, ?, ?)",
                        rusqlite::params![&cid, &row.id, pos as i32, ts],
                    );
                }
                collection_id = Some(cid);
                collection_name = Some(collection_display_name(&base));
            }
            let _ = app_handle.emit(
                "notion-import-progress",
                serde_json::json!({
                    "stage": "done",
                    "status": "Done",
                    "current": total,
                    "total": total,
                    "percent": 100
                }),
            );

            Ok(serde_json::json!({
                "imported": imported,
                "failed": 0,
                "duplicates": 0,
                "collectionId": collection_id,
                "collectionName": collection_name
            }))
        })();

        let _ = fs::remove_dir_all(&_cleanup);
        out
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(result)
}

#[tauri::command]
pub fn get_preference(db: State<Arc<Db>>, key: String) -> Result<Option<String>, String> {
    cmd_log!("get_preference");
    let conn = db.conn();
    let row: Option<String> = conn
        .query_row("SELECT value FROM preferences WHERE key = ?", [&key], |r| {
            r.get::<_, String>(0)
        })
        .optional()
        .map_err(|e: rusqlite::Error| e.to_string())?;
    Ok(row)
}

#[derive(Deserialize)]
pub struct SetPreferencePayload {
    pub key: String,
    pub value: String,
}

#[tauri::command]
pub fn set_preference(db: State<Arc<Db>>, payload: SetPreferencePayload) -> Result<(), String> {
    cmd_log!("set_preference");
    let conn = db.conn();
    conn.execute(
        "INSERT OR REPLACE INTO preferences(key, value) VALUES (?, ?)",
        rusqlite::params![payload.key, payload.value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------- Onboarding survey ----------

const SURVEY_COMPLETED_KEY: &str = "survey_completed";

#[tauri::command]
pub fn get_survey_completed(db: State<Arc<Db>>) -> Result<bool, String> {
    cmd_log!("get_survey_completed");
    let conn = db.conn();
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM preferences WHERE key = ?",
            [SURVEY_COMPLETED_KEY],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e: rusqlite::Error| e.to_string())?;
    Ok(value.as_deref() == Some("true"))
}

#[tauri::command]
pub fn set_survey_completed(db: State<Arc<Db>>) -> Result<(), String> {
    cmd_log!("set_survey_completed");
    let conn = db.conn();
    conn.execute(
        "INSERT OR REPLACE INTO preferences(key, value) VALUES (?, ?)",
        rusqlite::params![SURVEY_COMPLETED_KEY, "true"],
    )
    .map_err(|e| e.to_string())?;
    let db_clone = db.inner().clone();
    std::thread::spawn(move || {
        send_new_user_telegram_notification(db_clone);
    });
    Ok(())
}

#[derive(Debug, serde::Serialize)]
pub struct SurveyDataRow {
    pub creative_role: Option<String>,
    pub creative_role_detail: Option<String>,
    pub primary_use_case: Option<String>,
    pub inspiration_method: Option<String>,
    pub discovery_source: Option<String>,
    pub discovery_source_detail: Option<String>,
    pub creative_level: Option<String>,
}

#[tauri::command]
pub fn get_survey_data(db: State<Arc<Db>>) -> Result<Option<SurveyDataRow>, String> {
    cmd_log!("get_survey_data");
    let conn = db.conn();
    let row = conn
        .query_row(
            "SELECT creative_role, creative_role_detail, primary_use_case, inspiration_method, discovery_source, discovery_source_detail, creative_level FROM user_survey_data WHERE id = 1",
            [],
            |r| {
                Ok(SurveyDataRow {
                    creative_role: r.get(0)?,
                    creative_role_detail: r.get(1)?,
                    primary_use_case: r.get(2)?,
                    inspiration_method: r.get(3)?,
                    discovery_source: r.get(4)?,
                    discovery_source_detail: r.get(5)?,
                    creative_level: r.get(6)?,
                })
            },
        )
        .optional()
        .map_err(|e: rusqlite::Error| e.to_string())?;
    Ok(row)
}

#[derive(Deserialize)]
pub struct SaveSurveyDataPayload {
    pub creative_role: Option<String>,
    pub creative_role_detail: Option<String>,
    pub primary_use_case: Option<String>,
    pub inspiration_method: Option<String>,
    pub discovery_source: Option<String>,
    pub discovery_source_detail: Option<String>,
    pub creative_level: Option<String>,
}

#[tauri::command]
pub fn save_survey_data(db: State<Arc<Db>>, payload: SaveSurveyDataPayload) -> Result<(), String> {
    cmd_log!("save_survey_data");
    let conn = db.conn();
    conn.execute(
        r#"
        INSERT OR REPLACE INTO user_survey_data (
            id,
            creative_role,
            creative_role_detail,
            primary_use_case,
            inspiration_method,
            discovery_source,
            discovery_source_detail,
            creative_level
        )
        VALUES (1, ?, ?, ?, ?, ?, ?, ?)
        "#,
        rusqlite::params![
            payload.creative_role,
            payload.creative_role_detail,
            payload.primary_use_case,
            payload.inspiration_method,
            payload.discovery_source,
            payload.discovery_source_detail,
            payload.creative_level,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn clear_survey_data(db: State<Arc<Db>>) -> Result<(), String> {
    cmd_log!("clear_survey_data");
    let conn = db.conn();
    conn.execute("DELETE FROM preferences WHERE key = ?", [SURVEY_COMPLETED_KEY])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM user_survey_data WHERE id = 1", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------- Notifications ----------

const DEFAULT_NOTIFICATION_USER_ID: &str = "local";

fn normalize_optional_text(v: Option<String>, max_len: usize) -> Option<String> {
    let s = v.unwrap_or_default().trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s.chars().take(max_len).collect())
    }
}

fn normalize_optional_http_url(v: Option<String>) -> Result<Option<String>, String> {
    let raw = v.unwrap_or_default().trim().to_string();
    if raw.is_empty() {
        return Ok(None);
    }
    let parsed = url::Url::parse(&raw).map_err(|_| "Invalid URL format".to_string())?;
    let scheme = parsed.scheme().to_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err("Only http/https URLs are supported".to_string());
    }
    Ok(Some(raw))
}

fn normalize_optional_youtube_url(v: Option<String>) -> Result<Option<String>, String> {
    let raw = v.unwrap_or_default().trim().to_string();
    if raw.is_empty() {
        return Ok(None);
    }
    if let Some(video_id) = extract_youtube_video_id(&raw) {
        return Ok(Some(format!(
            "https://www.youtube.com/watch?v={}",
            video_id
        )));
    }
    Err("Invalid YouTube URL".to_string())
}

#[derive(Deserialize)]
pub struct CreateAdminNotificationPayload {
    pub title: Option<String>,
    pub message: Option<String>,
    pub body: Option<String>,
    pub youtube_url: Option<String>,
    pub button_text: Option<String>,
    pub button_link: Option<String>,
    pub high_priority: Option<bool>,
    pub is_global: Option<bool>,
    pub is_active: Option<bool>,
    pub expires_at: Option<i64>,
}

#[tauri::command]
pub fn create_admin_notification(
    db: State<Arc<Db>>,
    payload: CreateAdminNotificationPayload,
) -> Result<NotificationRow, String> {
    cmd_log!("create_admin_notification");
    let conn = db.conn();
    let id = Uuid::new_v4().to_string();
    let created_at = now_ms();
    let title = normalize_optional_text(payload.title, 120);
    let body_raw = payload
        .body
        .as_ref()
        .map(|s| s.as_str())
        .or_else(|| payload.message.as_ref().map(|s| s.as_str()))
        .unwrap_or("")
        .trim()
        .to_string();
    if body_raw.is_empty() {
        return Err("Body is required".to_string());
    }
    let body = body_raw.chars().take(4000).collect::<String>();
    let youtube_url = normalize_optional_youtube_url(payload.youtube_url)?;
    let mut button_text = normalize_optional_text(payload.button_text, 40);
    let button_link = normalize_optional_http_url(payload.button_link)?;
    if button_link.is_none() {
        button_text = None;
    }
    let high_priority = payload.high_priority.unwrap_or(false);
    let is_global = payload.is_global.unwrap_or(true);
    let is_active = payload.is_active.unwrap_or(true);
    let expires_at = payload.expires_at;

    conn.execute(
        "INSERT INTO notifications (id, title, message, youtube_url, button_text, button_link, high_priority, is_global, is_active, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        rusqlite::params![
            id,
            title,
            body,
            youtube_url,
            button_text,
            button_link,
            if high_priority { 1 } else { 0 },
            if is_global { 1 } else { 0 },
            if is_active { 1 } else { 0 },
            created_at,
            expires_at
        ],
    )
    .map_err(|e| e.to_string())?;

    conn.execute(
        "DELETE FROM notifications
         WHERE id NOT IN (
           SELECT id FROM notifications ORDER BY created_at DESC LIMIT 5
         )",
        [],
    )
    .map_err(|e| e.to_string())?;

    Ok(NotificationRow {
        id,
        title,
        body,
        youtube_url,
        button_text,
        button_link,
        high_priority,
        is_active,
        created_at,
        expires_at,
        unread: true,
    })
}

#[tauri::command]
pub fn list_notifications(
    db: State<Arc<Db>>,
    params: Option<serde_json::Value>,
) -> Result<Vec<NotificationRow>, String> {
    cmd_log!("list_notifications");
    let conn = db.conn();
    let p = params.unwrap_or(serde_json::json!({}));
    let cursor = p.get("cursor").and_then(|v| v.as_i64());
    let limit = p
        .get("limit")
        .and_then(|v| v.as_i64())
        .unwrap_or(5)
        .clamp(1, 5);
    let latest_only = p
        .get("latestOnly")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let include_inactive = p
        .get("includeInactive")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    fn parse_i64(v: &serde_json::Value) -> Option<i64> {
        if let Some(n) = v.as_i64() {
            return Some(n);
        }
        v.as_str().and_then(|s| s.parse::<i64>().ok())
    }

    fn parse_worker_notification(raw: &serde_json::Value) -> Option<NotificationRow> {
        let id = raw.get("id")?.as_str()?.trim().to_string();
        if id.is_empty() {
            return None;
        }
        let title = raw
            .get("title")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let body = raw
            .get("body")
            .or_else(|| raw.get("message"))
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        if body.is_empty() {
            return None;
        }
        let youtube_url = raw
            .get("youtube_url")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let button_text = raw
            .get("button_text")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let button_link = raw
            .get("button_link")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let is_active = raw
            .get("is_active")
            .and_then(parse_i64)
            .map(|n| n != 0)
            .or_else(|| raw.get("is_active").and_then(|v| v.as_bool()))
            .unwrap_or(true);
        let created_raw = raw.get("created_at").and_then(parse_i64).unwrap_or(0);
        // Worker stores timestamps in seconds; renderer expects milliseconds.
        let created_at = if created_raw > 0 && created_raw < 1_000_000_000_000 {
            created_raw.saturating_mul(1000)
        } else {
            created_raw
        };

        Some(NotificationRow {
            id,
            title,
            body,
            youtube_url,
            button_text,
            button_link,
            high_priority: false,
            is_active,
            created_at,
            expires_at: None,
            unread: false,
        })
    }

    fn fetch_worker_notifications(
        conn: &rusqlite::Connection,
        latest_only: bool,
        limit: i64,
    ) -> Result<Option<Vec<NotificationRow>>, String> {
        let api_base = std::env::var("QOOTI_LICENSE_API_URL")
            .unwrap_or_else(|_| DEFAULT_LICENSE_API_URL.to_string());
        let api_base = api_base.trim().trim_end_matches('/');
        if api_base.is_empty() {
            return Ok(None);
        }
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(8))
            .build()
            .map_err(|e| {
                log::error!("[HTTP][notifications] client build failed: {}", e);
                e.to_string()
            })?;
        let url = if latest_only {
            format!("{}/app/notifications?latest_only=1", api_base)
        } else {
            format!("{}/app/notifications?limit={}", api_base, limit.clamp(1, 5))
        };
        let response = match client.get(url).send() {
            Ok(r) => r,
            Err(e) => {
                log::error!("[HTTP][notifications] request failed: {}", e);
                return Ok(None);
            }
        };
        if !response.status().is_success() {
            log::warn!(
                "[HTTP][notifications] non-success status: {}",
                response.status()
            );
            return Ok(None);
        }
        let payload: serde_json::Value = match response.json() {
            Ok(v) => v,
            Err(e) => {
                log::error!("[HTTP][notifications] response parse failed: {}", e);
                return Ok(None);
            }
        };
        let mut rows: Vec<NotificationRow> = payload
            .get("notifications")
            .and_then(|v| v.as_array())
            .map(|list| list.iter().filter_map(parse_worker_notification).collect())
            .unwrap_or_default();
        rows.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        rows.truncate(if latest_only { 1 } else { limit as usize });

        if !latest_only {
            let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM notifications", [])
                .map_err(|e| e.to_string())?;
            for n in &rows {
                tx.execute(
                    "INSERT OR REPLACE INTO notifications (id, title, message, youtube_url, button_text, button_link, high_priority, is_global, is_active, created_at, expires_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    rusqlite::params![
                        n.id,
                        n.title,
                        n.body,
                        n.youtube_url,
                        n.button_text,
                        n.button_link,
                        if n.high_priority { 1 } else { 0 },
                        1,
                        if n.is_active { 1 } else { 0 },
                        n.created_at,
                        n.expires_at
                    ],
                )
                .map_err(|e| e.to_string())?;
            }
            tx.commit().map_err(|e| e.to_string())?;
        }

        Ok(Some(rows))
    }

    if let Some(cloud_rows) = fetch_worker_notifications(&conn, latest_only, limit)? {
        return Ok(cloud_rows);
    }

    let now = now_ms();
    let mut sql = "
        SELECT n.id, n.title, n.message, n.youtube_url, n.button_text, n.button_link, n.high_priority, n.is_active, n.created_at, n.expires_at
        FROM notifications n
        WHERE (n.expires_at IS NULL OR n.expires_at > ?1)
          AND (?2 IS NULL OR n.created_at < ?2)
    ".to_string();
    if !include_inactive {
        sql.push_str(" AND n.is_active = 1 ");
    }
    if latest_only {
        sql.push_str(" ORDER BY n.created_at DESC LIMIT 1 ");
    } else {
        sql.push_str(" ORDER BY n.created_at DESC LIMIT ?3 ");
    }

    let mut list = Vec::new();
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    if latest_only {
        let rows = stmt
            .query_map(rusqlite::params![now, cursor], |r| {
                Ok(NotificationRow {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    body: r.get(2)?,
                    youtube_url: r.get(3)?,
                    button_text: r.get(4)?,
                    button_link: r.get(5)?,
                    high_priority: r.get::<_, i64>(6)? != 0,
                    is_active: r.get::<_, i64>(7)? != 0,
                    created_at: r.get(8)?,
                    expires_at: r.get(9)?,
                    unread: false,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            list.push(row.map_err(|e| e.to_string())?);
        }
    } else {
        let rows = stmt
            .query_map(rusqlite::params![now, cursor, limit], |r| {
                Ok(NotificationRow {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    body: r.get(2)?,
                    youtube_url: r.get(3)?,
                    button_text: r.get(4)?,
                    button_link: r.get(5)?,
                    high_priority: r.get::<_, i64>(6)? != 0,
                    is_active: r.get::<_, i64>(7)? != 0,
                    created_at: r.get(8)?,
                    expires_at: r.get(9)?,
                    unread: false,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            list.push(row.map_err(|e| e.to_string())?);
        }
    }
    Ok(list)
}

#[tauri::command]
pub fn get_unread_notification_count(db: State<Arc<Db>>) -> Result<i64, String> {
    cmd_log!("get_unread_notification_count");
    let conn = db.conn();
    let now = now_ms();
    let user_id = DEFAULT_NOTIFICATION_USER_ID;
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*)
             FROM notifications n
             LEFT JOIN notification_reads nr
               ON nr.notification_id = n.id AND nr.user_id = ?
             WHERE (n.expires_at IS NULL OR n.expires_at > ?)
               AND n.is_active = 1
               AND nr.read_at IS NULL",
            rusqlite::params![user_id, now],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(count)
}

#[tauri::command]
pub fn mark_notifications_read(
    db: State<Arc<Db>>,
    ids: Option<Vec<String>>,
) -> Result<i64, String> {
    cmd_log!("mark_notifications_read");
    let conn = db.conn();
    let user_id = DEFAULT_NOTIFICATION_USER_ID;
    let now = now_ms();
    let mut changed = 0_i64;

    if let Some(list) = ids {
        for id in list.into_iter().filter(|v| !v.trim().is_empty()) {
            let rows = conn
                .execute(
                    "INSERT OR IGNORE INTO notification_reads(notification_id, user_id, read_at) VALUES (?, ?, ?)",
                    rusqlite::params![id, user_id, now],
                )
                .map_err(|e| e.to_string())?;
            changed += rows as i64;
        }
        return Ok(changed);
    }

    let rows = conn
        .execute(
            "INSERT OR IGNORE INTO notification_reads(notification_id, user_id, read_at)
             SELECT n.id, ?, ?
             FROM notifications n
             LEFT JOIN notification_reads nr
               ON nr.notification_id = n.id AND nr.user_id = ?
             WHERE (n.expires_at IS NULL OR n.expires_at > ?)
               AND n.is_active = 1
               AND nr.notification_id IS NULL",
            rusqlite::params![user_id, now, user_id, now],
        )
        .map_err(|e| e.to_string())?;
    changed += rows as i64;
    Ok(changed)
}

// ---------- Extension connection (Chrome extension secure pairing) ----------

const PREF_EXTENSION_KEY: &str = "extension_connection_key";
const PREF_EXTENSION_LAST: &str = "extension_last_connection_ts";
const EXTENSION_KEY_LEN: usize = 32;
const KEY_CHARS: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";

pub fn ensure_extension_key(conn: &rusqlite::Connection) -> Result<String, String> {
    let existing: Option<String> = conn
        .query_row(
            "SELECT value FROM preferences WHERE key = ?",
            [PREF_EXTENSION_KEY],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(k) = existing.filter(|s| s.trim().len() >= EXTENSION_KEY_LEN) {
        return Ok(k);
    }
    let key: String = (0..EXTENSION_KEY_LEN)
        .map(|_| {
            let i = rand::Rng::gen_range(&mut rand::thread_rng(), 0..KEY_CHARS.len());
            KEY_CHARS[i] as char
        })
        .collect();
    conn.execute(
        "INSERT OR REPLACE INTO preferences(key, value) VALUES (?, ?)",
        rusqlite::params![PREF_EXTENSION_KEY, &key],
    )
    .map_err(|e| e.to_string())?;
    Ok(key)
}

#[derive(Serialize)]
pub struct ExtensionConnectionStatus {
    pub key_masked: String,
    pub connected: bool,
    pub last_connection_ts: Option<i64>,
}

#[tauri::command]
pub fn get_extension_connection_status(
    db: State<Arc<Db>>,
) -> Result<ExtensionConnectionStatus, String> {
    cmd_log!("get_extension_connection_status");
    let conn = db.conn();
    let key = ensure_extension_key(&*conn).map_err(|e| e.to_string())?;
    let masked = if key.len() >= 8 {
        format!("{}…{}", &key[..4], &key[key.len() - 4..])
    } else {
        "••••".to_string()
    };
    let last_ts: Option<i64> = conn
        .query_row(
            "SELECT value FROM preferences WHERE key = ?",
            [PREF_EXTENSION_LAST],
            |r| {
                let s: String = r.get(0)?;
                Ok(s.parse().ok())
            },
        )
        .optional()
        .map_err(|e: rusqlite::Error| e.to_string())?
        .flatten();
    Ok(ExtensionConnectionStatus {
        key_masked: masked,
        connected: last_ts.is_some(),
        last_connection_ts: last_ts,
    })
}

#[tauri::command]
pub fn get_extension_key_for_copy(db: State<Arc<Db>>) -> Result<String, String> {
    cmd_log!("get_extension_key_for_copy");
    let conn = db.conn();
    let key = ensure_extension_key(&*conn).map_err(|e| e.to_string())?;
    Ok(key)
}

#[tauri::command]
pub fn regenerate_extension_key(db: State<Arc<Db>>) -> Result<String, String> {
    cmd_log!("regenerate_extension_key");
    let conn = db.conn();
    let key: String = (0..EXTENSION_KEY_LEN)
        .map(|_| {
            let i = rand::Rng::gen_range(&mut rand::thread_rng(), 0..KEY_CHARS.len());
            KEY_CHARS[i] as char
        })
        .collect();
    conn.execute(
        "INSERT OR REPLACE INTO preferences(key, value) VALUES (?, ?)",
        rusqlite::params![PREF_EXTENSION_KEY, &key],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM preferences WHERE key = ?",
        rusqlite::params![PREF_EXTENSION_LAST],
    )
    .map_err(|e| e.to_string())?;
    Ok(key)
}

#[tauri::command]
pub fn get_extension_pending(
    queue: State<'_, crate::extension_server::ExtensionQueue>,
) -> Result<Vec<serde_json::Value>, String> {
    cmd_log_debug!("get_extension_pending");
    let mut q = queue.0.lock().map_err(|e| e.to_string())?;
    let items: Vec<_> = q.drain(..).collect();
    Ok(items)
}

// ---------- License (gate + cache + Worker API) ----------

/// Default license Worker URL (used when QOOTI_LICENSE_API_URL is not set).
/// Users can override via env var for development.
const DEFAULT_LICENSE_API_URL: &str = "https://qooti-license.azizbekhabibullayev74.workers.dev";

const LICENSE_CACHE_ID: i32 = 1;
const DEVICE_ID_PREF_KEY: &str = "device_id";

fn get_device_fingerprint(db: &Db) -> Result<String, String> {
    let conn = db.conn();
    let existing: Option<String> = conn
        .query_row(
            "SELECT value FROM preferences WHERE key = ?",
            [DEVICE_ID_PREF_KEY],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e: rusqlite::Error| e.to_string())?;
    if let Some(id) = existing {
        if !id.trim().is_empty() {
            return Ok(id);
        }
    }
    let new_id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT OR REPLACE INTO preferences(key, value) VALUES (?, ?)",
        rusqlite::params![DEVICE_ID_PREF_KEY, &new_id],
    )
    .map_err(|e: rusqlite::Error| e.to_string())?;
    Ok(new_id)
}

#[derive(Serialize)]
pub struct LicenseCacheResult {
    pub valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activated_at: Option<i64>,
    pub has_cached_key: bool,
    pub used_cached: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_validated_at: Option<i64>,
}

#[derive(Clone)]
struct StoredLicenseCache {
    license_key: String,
    plan_type: String,
    expires_at: i64,
    activated_at: Option<i64>,
    last_validated_at: Option<i64>,
    last_validation_status: Option<String>,
    last_validation_error: Option<String>,
}

fn now_unix_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn normalize_license_status(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "valid" => "valid".to_string(),
        "revoked" => "revoked".to_string(),
        "expired" | "expired_or_revoked" => "expired".to_string(),
        "device_limit" | "device_blocked" | "over_limit" | "at_limit" => "device_limit".to_string(),
        "not_found" | "missing" => "not_found".to_string(),
        "inactive" => "inactive".to_string(),
        "network_error" | "server_unreachable" => "network_error".to_string(),
        "offline_cache" => "offline_cache".to_string(),
        _ => "invalid".to_string(),
    }
}

fn is_server_rejected_status(status: &str) -> bool {
    matches!(
        normalize_license_status(status).as_str(),
        "revoked" | "expired" | "device_limit" | "not_found" | "inactive" | "invalid"
    )
}

fn read_license_cache_row(conn: &rusqlite::Connection) -> Result<Option<StoredLicenseCache>, String> {
    conn.query_row(
        "SELECT license_key, plan_type, expires_at, activated_at, last_validated_at, last_validation_status, last_validation_error
         FROM license_cache
         WHERE id = ?",
        rusqlite::params![LICENSE_CACHE_ID],
        |r| {
            Ok(StoredLicenseCache {
                license_key: r.get::<_, String>(0)?,
                plan_type: r.get::<_, String>(1)?,
                expires_at: r.get::<_, i64>(2)?,
                activated_at: r.get::<_, Option<i64>>(3).ok().flatten(),
                last_validated_at: r.get::<_, Option<i64>>(4).ok().flatten(),
                last_validation_status: r.get::<_, Option<String>>(5).ok().flatten(),
                last_validation_error: r.get::<_, Option<String>>(6).ok().flatten(),
            })
        },
    )
    .optional()
    .map_err(|e: rusqlite::Error| e.to_string())
}

fn is_cache_currently_valid(row: &StoredLicenseCache) -> bool {
    if row.license_key.trim().is_empty() || row.expires_at <= now_unix_ts() {
        return false;
    }
    !row
        .last_validation_status
        .as_deref()
        .map(is_server_rejected_status)
        .unwrap_or(false)
}

fn build_license_cache_result(row: Option<&StoredLicenseCache>) -> LicenseCacheResult {
    match row {
        Some(row) => {
            let valid = is_cache_currently_valid(row);
            let status = row.last_validation_status.clone().or_else(|| {
                Some(if valid {
                    "valid".to_string()
                } else if row.expires_at <= now_unix_ts() {
                    "expired".to_string()
                } else {
                    "invalid".to_string()
                })
            });
            LicenseCacheResult {
                valid,
                plan_type: Some(row.plan_type.clone()),
                expires_at: Some(row.expires_at),
                activated_at: row.activated_at,
                has_cached_key: true,
                used_cached: false,
                status,
                error: row.last_validation_error.clone(),
                last_validated_at: row.last_validated_at,
            }
        }
        None => LicenseCacheResult {
            valid: false,
            plan_type: None,
            expires_at: None,
            activated_at: None,
            has_cached_key: false,
            used_cached: false,
            status: Some("missing".to_string()),
            error: None,
            last_validated_at: None,
        },
    }
}

fn set_license_cache_impl(
    conn: &rusqlite::Connection,
    license_key: &str,
    plan_type: &str,
    expires_at: i64,
    validation_status: &str,
    validation_error: Option<&str>,
) -> Result<(), String> {
    let now = now_unix_ts();
    let existing_row: Option<(String, Option<i64>)> = conn
        .query_row(
            "SELECT license_key, activated_at FROM license_cache WHERE id = ?",
            rusqlite::params![LICENSE_CACHE_ID],
            |r| Ok((r.get(0)?, r.get::<_, Option<i64>>(1).ok().flatten())),
        )
        .optional()
        .map_err(|e: rusqlite::Error| e.to_string())?;
    let activated_at = existing_row
        .as_ref()
        .filter(|(existing_key, _)| existing_key == license_key)
        .and_then(|(_, activated_at)| *activated_at)
        .unwrap_or(now);
    conn.execute(
        "INSERT OR REPLACE INTO license_cache
         (id, license_key, plan_type, expires_at, last_validated_at, activated_at, last_validation_status, last_validation_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        rusqlite::params![
            LICENSE_CACHE_ID,
            license_key,
            plan_type,
            expires_at,
            now,
            activated_at,
            validation_status,
            validation_error
        ],
    )
    .map_err(|e: rusqlite::Error| e.to_string())?;
    Ok(())
}

fn update_cached_license_validation_state(
    conn: &rusqlite::Connection,
    status: &str,
    error: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "UPDATE license_cache
         SET last_validated_at = ?, last_validation_status = ?, last_validation_error = ?
         WHERE id = ?",
        rusqlite::params![now_unix_ts(), status, error, LICENSE_CACHE_ID],
    )
    .map_err(|e: rusqlite::Error| e.to_string())?;
    Ok(())
}

fn infer_license_status(
    http_status: reqwest::StatusCode,
    json: &serde_json::Value,
) -> String {
    if let Some(status) = json["status"].as_str() {
        let normalized = normalize_license_status(status);
        if normalized != "invalid" || status.eq_ignore_ascii_case("invalid") {
            return normalized;
        }
    }
    if json["valid"].as_bool() == Some(true) {
        return "valid".to_string();
    }
    let msg = json["error"]
        .as_str()
        .or_else(|| json["message"].as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if msg.contains("revok") {
        return "revoked".to_string();
    }
    if msg.contains("device") || msg.contains("limit") {
        return "device_limit".to_string();
    }
    if msg.contains("expir") {
        return "expired".to_string();
    }
    if msg.contains("inactive") {
        return "inactive".to_string();
    }
    if msg.contains("not found") || http_status == reqwest::StatusCode::NOT_FOUND {
        return "not_found".to_string();
    }
    if json["valid"].as_bool() == Some(false) && http_status.is_success() {
        return "invalid".to_string();
    }
    if matches!(
        http_status,
        reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN
    ) {
        return "invalid".to_string();
    }
    "invalid".to_string()
}

#[derive(Clone)]
struct LicenseServerCheck {
    valid: bool,
    status: String,
    plan_type: Option<String>,
    expires_at: Option<i64>,
    error: Option<String>,
}

fn parse_license_server_response(
    http_status: reqwest::StatusCode,
    json: serde_json::Value,
) -> LicenseServerCheck {
    let status = infer_license_status(http_status, &json);
    let valid = status == "valid";
    let error = json["error"]
        .as_str()
        .or_else(|| json["message"].as_str())
        .map(|s| s.to_string());
    LicenseServerCheck {
        valid,
        status,
        plan_type: json["plan_type"].as_str().map(|s| s.to_string()),
        expires_at: parse_expires_at(&json["expires_at"]).or_else(|| {
            if valid {
                Some(i64::MAX)
            } else {
                None
            }
        }),
        error,
    }
}

fn request_license_server_check(
    api_base: &str,
    license_key: &str,
    device_id: &str,
    activation: bool,
) -> Result<LicenseServerCheck, String> {
    let endpoint = if activation {
        format!("{}/license/validate", api_base)
    } else {
        format!("{}/license/status", api_base)
    };
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(if activation { 8 } else { 5 }))
        .build()
        .map_err(|e| {
            log::error!("[HTTP][license] client build failed endpoint={} err={}", endpoint, e);
            e.to_string()
        })?;
    let response = if activation {
        let body = serde_json::json!({
            "license_key": license_key,
            "device_fingerprint": device_id,
        });
        client
            .post(format!("{}/license/validate", api_base))
            .json(&body)
            .send()
    } else {
        client
            .get(format!(
                "{}/license/status?license_key={}&device_fingerprint={}",
                api_base,
                urlencoding::encode(license_key),
                urlencoding::encode(device_id)
            ))
            .send()
    }
    .map_err(|e| {
        log::error!(
            "[HTTP][license] request failed endpoint={} activation={} err={}",
            endpoint,
            activation,
            e
        );
        format!("Network error: {}", e)
    })?;
    let http_status = response.status();
    if !http_status.is_success() {
        log::warn!(
            "[HTTP][license] non-success response endpoint={} status={}",
            endpoint,
            http_status
        );
    }
    let json = response
        .json::<serde_json::Value>()
        .map_err(|e| {
            log::error!(
                "[HTTP][license] response parse failed endpoint={} status={} err={}",
                endpoint,
                http_status,
                e
            );
            format!("Network error: {}", e)
        })?;
    Ok(parse_license_server_response(http_status, json))
}

#[tauri::command]
pub fn get_license_cache(db: State<Arc<Db>>) -> Result<LicenseCacheResult, String> {
    cmd_log!("get_license_cache");
    let conn = db.conn();
    let row = read_license_cache_row(&conn)?;
    Ok(build_license_cache_result(row.as_ref()))
}

#[tauri::command]
pub fn clear_license_cache(db: State<Arc<Db>>) -> Result<(), String> {
    cmd_log!("clear_license_cache");
    let conn = db.conn();
    conn.execute(
        "DELETE FROM license_cache WHERE id = ?",
        rusqlite::params![LICENSE_CACHE_ID],
    )
    .map_err(|e: rusqlite::Error| e.to_string())?;
    Ok(())
}

fn parse_expires_at(v: &serde_json::Value) -> Option<i64> {
    if let Some(n) = v.as_i64() {
        return Some(n);
    }
    if let Some(s) = v.as_str() {
        if let Ok(n) = s.parse::<i64>() {
            return Some(n);
        }
    }
    None
}

#[derive(Serialize)]
pub struct ValidateLicenseResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    pub used_cached: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[tauri::command]
pub fn validate_license(
    db: State<Arc<Db>>,
    license_key: String,
) -> Result<ValidateLicenseResult, String> {
    cmd_log!("validate_license");
    info!("[license] validate_license: start");
    let key_trim = license_key.trim();
    if key_trim.is_empty() {
        return Ok(ValidateLicenseResult {
            success: false,
            plan_type: None,
            expires_at: None,
            status: Some("invalid".to_string()),
            used_cached: false,
            error: Some("Please enter a license key.".to_string()),
        });
    }
    let api_base = std::env::var("QOOTI_LICENSE_API_URL")
        .unwrap_or_else(|_| DEFAULT_LICENSE_API_URL.to_string());
    let api_base = api_base.trim().trim_end_matches('/');
    if api_base.is_empty() {
        return Ok(ValidateLicenseResult {
            success: false,
            plan_type: None,
            expires_at: None,
            status: Some("network_error".to_string()),
            used_cached: false,
            error: Some("License server not configured.".to_string()),
        });
    }
    info!(
        "[license] validate_license: sending POST to {}/license/validate",
        api_base
    );
    let device_id = get_device_fingerprint(&db)?;
    let server_check = match request_license_server_check(api_base, key_trim, &device_id, true) {
        Ok(result) => result,
        Err(error) => {
            info!("[license] validate_license: request failed: {}", error);
            return Ok(ValidateLicenseResult {
                success: false,
                plan_type: None,
                expires_at: None,
                status: Some("network_error".to_string()),
                used_cached: false,
                error: Some(error),
            });
        }
    };
    if server_check.valid {
        let plan_type = server_check
            .plan_type
            .clone()
            .unwrap_or_else(|| "lifetime".to_string());
        let expires = server_check.expires_at.unwrap_or(i64::MAX);
        let conn = db.conn();
        set_license_cache_impl(&conn, key_trim, &plan_type, expires, "valid", None)?;
        return Ok(ValidateLicenseResult {
            success: true,
            plan_type: Some(plan_type),
            expires_at: Some(expires),
            status: Some("valid".to_string()),
            used_cached: false,
            error: None,
        });
    }
    Ok(ValidateLicenseResult {
        success: false,
        plan_type: None,
        expires_at: None,
        status: Some(server_check.status),
        used_cached: false,
        error: Some(
            server_check
                .error
                .unwrap_or_else(|| "Validation failed.".to_string()),
        ),
    })
}

fn license_endpoint_for_log(base: &str) -> String {
    base.split('?')
        .next()
        .unwrap_or(base)
        .chars()
        .take(80)
        .collect()
}

fn check_current_license_with_server_impl(db: &Arc<Db>) -> Result<LicenseCacheResult, String> {
    let t0 = std::time::Instant::now();
    let row = {
        let conn = db.conn();
        read_license_cache_row(&conn)?
    };
    let Some(row) = row else {
        info!(
            "[license] result | valid=false | reason=no_cache | duration={}ms",
            t0.elapsed().as_millis()
        );
        return Ok(build_license_cache_result(None));
    };
    let key_hint = format!(
        "{}***",
        row.license_key.chars().take(4).collect::<String>()
    );
    debug!(
        "[license] checking | key_hint={} | cached_plan={} | duration_so_far={}ms",
        key_hint,
        row.plan_type,
        t0.elapsed().as_millis()
    );
    let api_base = std::env::var("QOOTI_LICENSE_API_URL")
        .unwrap_or_else(|_| DEFAULT_LICENSE_API_URL.to_string());
    let api_base = api_base.trim().trim_end_matches('/');
    if api_base.is_empty() {
        let valid = is_cache_currently_valid(&row);
        info!(
            "[license] result | valid={} | mode=no_endpoint_config | duration={}ms",
            valid,
            t0.elapsed().as_millis()
        );
        return Ok(LicenseCacheResult {
            valid,
            plan_type: Some(row.plan_type),
            expires_at: Some(row.expires_at),
            activated_at: row.activated_at,
            has_cached_key: true,
            used_cached: valid,
            status: Some(if valid {
                "offline_cache".to_string()
            } else {
                "network_error".to_string()
            }),
            error: Some("License server not configured.".to_string()),
            last_validated_at: row.last_validated_at,
        });
    }
    let device_id = get_device_fingerprint(&db)?;
    let server_check = match request_license_server_check(api_base, &row.license_key, &device_id, false) {
        Ok(result) => result,
        Err(error) => {
            warn!(
                "[license] server unreachable | url={} | error={} | duration={}ms",
                license_endpoint_for_log(api_base),
                error,
                t0.elapsed().as_millis()
            );
            let conn = db.conn();
            let _ = update_cached_license_validation_state(&conn, "network_error", Some(error.as_str()));
            let valid = is_cache_currently_valid(&row);
            return Ok(LicenseCacheResult {
                valid,
                plan_type: Some(row.plan_type),
                expires_at: Some(row.expires_at),
                activated_at: row.activated_at,
                has_cached_key: true,
                used_cached: valid,
                status: Some(if valid {
                    "offline_cache".to_string()
                } else {
                    "network_error".to_string()
                }),
                error: Some(error),
                last_validated_at: Some(now_unix_ts()),
            });
        }
    };
    let plan_type = server_check
        .plan_type
        .clone()
        .unwrap_or_else(|| row.plan_type.clone());
    let expires_at = server_check.expires_at.unwrap_or(row.expires_at);
    let conn = db.conn();
    let _ = set_license_cache_impl(
        &conn,
        &row.license_key,
        &plan_type,
        expires_at,
        server_check.status.as_str(),
        server_check.error.as_deref(),
    );
    let days_remaining = expires_at
        .checked_sub(now_unix_ts())
        .map(|d| d / 86400)
        .unwrap_or(0);
    info!(
        "[license] result | valid={} | plan={} | status={} | days_remaining={} | duration={}ms",
        server_check.valid,
        plan_type,
        server_check.status,
        days_remaining,
        t0.elapsed().as_millis()
    );
    Ok(LicenseCacheResult {
        valid: server_check.valid,
        plan_type: Some(plan_type),
        expires_at: Some(expires_at),
        activated_at: row.activated_at,
        has_cached_key: true,
        used_cached: false,
        status: Some(server_check.status),
        error: server_check.error,
        last_validated_at: Some(now_unix_ts()),
    })
}

#[tauri::command]
pub fn check_current_license_with_server(db: State<Arc<Db>>) -> Result<LicenseCacheResult, String> {
    cmd_log!("check_current_license_with_server");
    let db = db.inner().clone();
    check_current_license_with_server_impl(&db)
}

#[tauri::command]
pub fn refresh_license_status(db: State<Arc<Db>>) -> Result<LicenseCacheResult, String> {
    cmd_log!("refresh_license_status");
    let db = db.inner().clone();
    check_current_license_with_server_impl(&db)
}

fn get_setting(conn: &rusqlite::Connection, key: &str) -> String {
    let row: Option<String> = conn
        .query_row("SELECT value FROM preferences WHERE key = ?", [key], |r| {
            r.get(0)
        })
        .optional()
        .ok()
        .flatten();
    row.unwrap_or_else(|| setting_default(key).unwrap_or_default().to_string())
}

/// Default settings keys and values. Used when key is missing.
fn setting_default(key: &str) -> Option<&'static str> {
    Some(match key {
        "theme" => "system",
        "cardSize" => "medium",
        "gridDensity" => "comfortable",
        "showMediaTitle" => "true",
        "showSourceLabels" => "true",
        "showCollectionIndicator" => "true",
        "showQuickTagsInToast" => "true",
        "defaultClickBehavior" => "preview",
        "enableContextMenu" => "true",
        "confirmBeforeDelete" => "true",
        "enableDragDropImport" => "true",
        "autoExtractPalette" => "true",
        "downloadQualityMode" => "best",
        "downloadConcurrentFragments" => "8",
        "preferProgressiveFormats" => "true",
        "relatedStrictness" => "balanced",
        "relatedPreferSameOrientation" => "true",
        "relatedPreferSameMediaType" => "true",
        "relatedTagInfluence" => "true",
        "quickTagsDefaultEnabled" => "true",
        "quickTagsCustom" => "[]",
        "tagFilterBarPrefs" => r#"{"hidden":[],"order":null}"#,
        "d1ApiToken" => "",
        "profileName" => "",
        "profileImageDataUrl" => "",
        _ => return None,
    })
}

#[tauri::command]
pub fn get_settings(db: State<Arc<Db>>) -> Result<serde_json::Value, String> {
    cmd_log!("get_settings");
    let conn = db.conn();
    let rows: Vec<(String, String)> = conn
        .prepare("SELECT key, value FROM preferences")
        .map_err(|e| e.to_string())?
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    let mut map = serde_json::Map::new();
    for key in [
        "theme",
        "cardSize",
        "gridDensity",
        "showMediaTitle",
        "showSourceLabels",
        "showCollectionIndicator",
        "showQuickTagsInToast",
        "defaultClickBehavior",
        "enableContextMenu",
        "confirmBeforeDelete",
        "enableDragDropImport",
        "autoExtractPalette",
        "downloadQualityMode",
        "downloadConcurrentFragments",
        "preferProgressiveFormats",
        "relatedStrictness",
        "relatedPreferSameOrientation",
        "relatedPreferSameMediaType",
        "relatedTagInfluence",
        "quickTagsDefaultEnabled",
        "quickTagsCustom",
        "tagFilterBarPrefs",
        "d1ApiToken",
        "profileName",
        "profileImageDataUrl",
    ] {
        let value = rows
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
            .or_else(|| setting_default(key).map(String::from));
        if let Some(v) = value {
            map.insert(key.to_string(), serde_json::Value::String(v));
        }
    }
    Ok(serde_json::Value::Object(map))
}

#[tauri::command]
pub fn open_folder(vault: State<Arc<VaultPaths>>) -> Result<(), String> {
    cmd_log!("open_folder");
    let path = vault.root.clone();
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    cmd_log!("open_external_url");
    let parsed = url::Url::parse(url.trim()).map_err(|_| "Invalid URL format".to_string())?;
    let scheme = parsed.scheme().to_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err("Only http/https URLs are supported".to_string());
    }
    let target = parsed.as_str().to_string();
    #[cfg(target_os = "windows")]
    {
        // Use "start" so the URL opens in the default browser; "explorer" can open file manager
        let mut cmd = Command::new("cmd");
        suppress_console_window(&mut cmd);
        cmd.args(["/C", "start", "", &target])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(&target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn window_close(app: AppHandle) -> Result<(), String> {
    cmd_log!("window_close");
    app.get_webview_window("main")
        .ok_or_else(|| "window not found".to_string())?
        .close()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn window_hide(app: AppHandle) -> Result<(), String> {
    cmd_log!("window_hide");
    app.get_webview_window("main")
        .ok_or_else(|| "window not found".to_string())?
        .hide()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn window_quit(app: AppHandle) -> Result<(), String> {
    cmd_log!("window_quit");
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub fn window_minimize(app: AppHandle) -> Result<(), String> {
    cmd_log!("window_minimize");
    app.get_webview_window("main")
        .ok_or_else(|| "window not found".to_string())?
        .minimize()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn window_maximize(app: AppHandle) -> Result<(), String> {
    cmd_log!("window_maximize");
    app.get_webview_window("main")
        .ok_or_else(|| "window not found".to_string())?
        .maximize()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn window_unmaximize(app: AppHandle) -> Result<(), String> {
    cmd_log!("window_unmaximize");
    app.get_webview_window("main")
        .ok_or_else(|| "window not found".to_string())?
        .unmaximize()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn window_is_maximized(app: AppHandle) -> Result<bool, String> {
    cmd_log!("window_is_maximized");
    app.get_webview_window("main")
        .ok_or_else(|| "window not found".to_string())?
        .is_maximized()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_devtools(app: AppHandle) -> Result<(), String> {
    cmd_log!("open_devtools");
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "window not found".to_string())?;
    window.open_devtools();
    Ok(())
}

fn extract_youtube_video_id(url: &str) -> Option<String> {
    let u = url::Url::parse(url).ok()?;
    if u.host_str()?.contains("youtube.com") {
        if let Some(v) = u.query_pairs().find(|(k, _)| k == "v") {
            return Some(v.1.to_string());
        }
        if u.path().starts_with("/embed/") {
            return u
                .path()
                .trim_start_matches("/embed/")
                .split('/')
                .next()
                .map(String::from);
        }
        if u.path().starts_with("/shorts/") {
            return u
                .path()
                .trim_start_matches("/shorts/")
                .split('/')
                .next()
                .map(String::from);
        }
    }
    if u.host_str()? == "youtu.be" {
        return u
            .path()
            .trim_start_matches('/')
            .split('/')
            .next()
            .map(String::from);
    }
    None
}

fn domain_from_url(url: &str) -> String {
    let normalized = if url.starts_with("www.") {
        format!("https://{}", url)
    } else {
        url.to_string()
    };
    url::Url::parse(&normalized)
        .ok()
        .and_then(|u| u.host_str().map(String::from))
        .map(|h| h.trim_start_matches("www.").to_string())
        .unwrap_or_else(|| url.to_string())
}

#[tauri::command]
pub fn fetch_link_preview(url: String) -> Result<Option<serde_json::Value>, String> {
    cmd_log!("fetch_link_preview");
    let normalized_url = match normalize_required_http_url(&url) {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    let trimmed = normalized_url.as_str();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let client = reqwest::blocking::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0")
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    // YouTube
    if let Some(video_id) = extract_youtube_video_id(trimmed) {
        let thumbnail_url = format!("https://i.ytimg.com/vi/{}/maxresdefault.jpg", video_id);
        let is_short = trimmed.contains("/shorts/");
        // Optional: fetch oembed for title
        let oembed_url = format!(
            "https://www.youtube.com/oembed?url={}&format=json&maxwidth=1280&maxheight=720",
            urlencoding::encode(trimmed)
        );
        let mut title = "YouTube video".to_string();
        let mut aspect_ratio: Option<f64> = None;
        if let Ok(resp) = client.get(&oembed_url).send() {
            if let Ok(json) = resp.json::<serde_json::Value>() {
                if let Some(t) = json.get("title").and_then(|v| v.as_str()) {
                    title = t.to_string();
                }
                if let (Some(w), Some(h)) = (
                    json.get("width").and_then(|v| v.as_f64()),
                    json.get("height").and_then(|v| v.as_f64()),
                ) {
                    if w > 0.0 && h > 0.0 {
                        aspect_ratio = Some(w / h);
                    }
                }
            }
        }
        return Ok(Some(serde_json::json!({
            "type": "youtube",
            "url": trimmed,
            "title": title,
            "author": serde_json::Value::Null,
            "thumbnailUrl": thumbnail_url,
            "isShortForm": is_short,
            "aspectRatio": aspect_ratio
        })));
    }

    // Instagram and other URLs: fetch page, parse og tags
    if trimmed.contains("instagram.com") {
        let is_reel = trimmed.contains("/reel/");
        match client.get(trimmed).send() {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(html) = resp.text() {
                    let og_image = regex_replace(
                        &html,
                        r#"<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']"#,
                    )
                    .or_else(|| {
                        regex_replace(
                            &html,
                            r#"content=["']([^"']+)["'][^>]+property=["']og:image["']"#,
                        )
                    });
                    let og_title = regex_replace(
                        &html,
                        r#"<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']"#,
                    )
                    .or_else(|| {
                        regex_replace(
                            &html,
                            r#"content=["']([^"']+)["'][^>]+property=["']og:title["']"#,
                        )
                    })
                    .map(|t| t.replace(" | Instagram", "").trim().to_string())
                    .unwrap_or_else(|| "Instagram".to_string());
                    let mut aspect_ratio: Option<f64> = None;
                    if let (Some(w), Some(h)) = (
                        regex_replace(
                            &html,
                            r#"<meta[^>]+property=["']og:image:width["'][^>]+content=["']([^"']+)["']"#,
                        ),
                        regex_replace(
                            &html,
                            r#"<meta[^>]+property=["']og:image:height["'][^>]+content=["']([^"']+)["']"#,
                        ),
                    ) {
                        if let (Ok(wi), Ok(hi)) = (w.parse::<f64>(), h.parse::<f64>()) {
                            if wi > 0.0 && hi > 0.0 {
                                aspect_ratio = Some(wi / hi);
                            }
                        }
                    }
                    return Ok(Some(serde_json::json!({
                        "type": "instagram",
                        "url": trimmed,
                        "title": og_title,
                        "author": serde_json::Value::Null,
                        "thumbnailUrl": og_image,
                        "isShortForm": is_reel,
                        "aspectRatio": aspect_ratio
                    })));
                }
            }
            _ => {}
        }
        return Ok(Some(serde_json::json!({
            "type": "instagram",
            "url": trimmed,
            "title": "Instagram",
            "author": serde_json::Value::Null,
            "thumbnailUrl": serde_json::Value::Null,
            "isShortForm": trimmed.contains("/reel/"),
            "aspectRatio": serde_json::Value::Null
        })));
    }

    // Generic: try to fetch og tags
    match client.get(trimmed).send() {
        Ok(resp) if resp.status().is_success() => {
            if let Ok(html) = resp.text() {
                let og_image = regex_replace(
                    &html,
                    r#"<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']"#,
                )
                .or_else(|| {
                    regex_replace(
                        &html,
                        r#"content=["']([^"']+)["'][^>]+property=["']og:image["']"#,
                    )
                });
                let og_title = regex_replace(
                    &html,
                    r#"<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']"#,
                )
                .or_else(|| {
                    regex_replace(
                        &html,
                        r#"content=["']([^"']+)["'][^>]+property=["']og:title["']"#,
                    )
                });
                let title = og_title.unwrap_or_else(|| domain_from_url(trimmed));
                return Ok(Some(serde_json::json!({
                    "type": "link",
                    "url": trimmed,
                    "title": title,
                    "author": serde_json::Value::Null,
                    "thumbnailUrl": og_image,
                    "isShortForm": false,
                    "aspectRatio": serde_json::Value::Null
                })));
            }
        }
        _ => {}
    }

    // Fallback: domain as title
    Ok(Some(serde_json::json!({
        "type": "link",
        "url": trimmed,
        "title": domain_from_url(trimmed),
        "author": serde_json::Value::Null,
        "thumbnailUrl": serde_json::Value::Null,
        "isShortForm": false,
        "aspectRatio": serde_json::Value::Null
    })))
}

fn regex_replace(html: &str, re: &str) -> Option<String> {
    use regex::Regex;
    let re = Regex::new(re).ok()?;
    let cap = re.captures(html)?;
    cap.get(1).map(|m| m.as_str().to_string())
}

// ─── Notion gallery import ─────────────────────────────────────────────────

fn is_valid_notion_url(url: &str) -> bool {
    let u = url.trim();
    u.contains("notion.site")
        || u.starts_with("https://www.notion.so/")
        || u.starts_with("https://notion.so/")
}

fn normalize_notion_media_url(raw: &str) -> String {
    let cleaned = raw
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .replace("\\u0026", "&")
        .replace("\\/", "/");
    if let Ok(parsed) = url::Url::parse(&cleaned) {
        let host = parsed.host_str().unwrap_or("").to_lowercase();
        let path = parsed.path().to_lowercase();
        if (host.ends_with("notion.so") || host.ends_with("notion.site"))
            && path.starts_with("/image/")
        {
            if let Some(encoded) = parsed.query_pairs().find_map(|(k, v)| {
                if k == "url" {
                    Some(v.to_string())
                } else {
                    None
                }
            }) {
                if let Ok(decoded) = urlencoding::decode(&encoded) {
                    let decoded = decoded.to_string();
                    if decoded.starts_with("http://") || decoded.starts_with("https://") {
                        return decoded;
                    }
                }
            }
        }
    }
    cleaned
}

fn extract_notion_candidate_ids(url: &str) -> Vec<String> {
    let mut out = Vec::new();
    let re = match Regex::new(r"([0-9a-fA-F]{32})") {
        Ok(r) => r,
        Err(_) => return out,
    };
    for caps in re.captures_iter(url) {
        if let Some(m) = caps.get(1) {
            let raw = m.as_str().to_lowercase();
            let hyphenated = format!(
                "{}-{}-{}-{}-{}",
                &raw[0..8],
                &raw[8..12],
                &raw[12..16],
                &raw[16..20],
                &raw[20..32]
            );
            if !out.iter().any(|id| id == &hyphenated) {
                out.push(hyphenated);
            }
        }
    }
    out
}

fn normalize_notion_id(raw: &str) -> Option<String> {
    let hex: String = raw.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if hex.len() != 32 {
        return None;
    }
    let lower = hex.to_lowercase();
    Some(format!(
        "{}-{}-{}-{}-{}",
        &lower[0..8],
        &lower[8..12],
        &lower[12..16],
        &lower[16..20],
        &lower[20..32]
    ))
}

fn looks_like_media_url(s: &str) -> bool {
    let lower = s.to_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return false;
    }
    lower.contains("notion.so/image/")
        || lower.contains("notion.site/image/")
        || lower.contains("notion-static.com/")
        || lower.contains("notionusercontent.com/")
        || lower.contains("amazonaws.com/secure.notion-static/")
        || lower.contains("prod-files-secure.s3.")
        || lower.contains(".png")
        || lower.contains(".jpg")
        || lower.contains(".jpeg")
        || lower.contains(".gif")
        || lower.contains(".webp")
        || lower.contains(".svg")
        || lower.contains(".mp4")
        || lower.contains(".mov")
        || lower.contains(".webm")
        || lower.contains(".mkv")
        || lower.contains(".pdf")
        || lower.contains(".mp3")
        || lower.contains(".wav")
        || lower.contains(".ogg")
}

fn collect_urls_recursive(value: &serde_json::Value, out: &mut Vec<String>) {
    match value {
        serde_json::Value::String(s) => {
            if looks_like_media_url(s) {
                out.push(s.to_string());
            }
        }
        serde_json::Value::Array(arr) => {
            for item in arr {
                collect_urls_recursive(item, out);
            }
        }
        serde_json::Value::Object(map) => {
            for (_, v) in map {
                collect_urls_recursive(v, out);
            }
        }
        _ => {}
    }
}

fn collect_string_arrays_for_key(value: &serde_json::Value, key: &str, out: &mut Vec<String>) {
    match value {
        serde_json::Value::Object(map) => {
            for (k, v) in map {
                if k == key {
                    if let Some(arr) = v.as_array() {
                        for item in arr {
                            if let Some(s) = item.as_str() {
                                out.push(s.to_string());
                            }
                        }
                    }
                }
                collect_string_arrays_for_key(v, key, out);
            }
        }
        serde_json::Value::Array(arr) => {
            for item in arr {
                collect_string_arrays_for_key(item, key, out);
            }
        }
        _ => {}
    }
}

fn collect_notion_media_from_block_map(
    payload: &serde_json::Value,
    seen: &mut HashSet<String>,
    out: &mut Vec<NotionGalleryItem>,
) {
    let block_map = payload
        .get("recordMap")
        .and_then(|v| v.get("block"))
        .and_then(|v| v.as_object());
    let Some(blocks) = block_map else { return };

    for (_id, block_entry) in blocks {
        let value = block_entry.get("value").unwrap_or(block_entry);
        let block_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let supported_type = matches!(block_type, "image" | "video" | "file" | "audio" | "pdf");
        let title = value
            .get("properties")
            .and_then(|p| p.get("title"))
            .and_then(|t| t.get(0))
            .and_then(|t| t.get(0))
            .and_then(|t| t.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| "Notion Item".to_string());

        if supported_type {
            if let Some(src) = value
                .get("properties")
                .and_then(|p| p.get("source"))
                .and_then(|s| s.get(0))
                .and_then(|s| s.get(0))
                .and_then(|s| s.as_str())
            {
                let media_url = normalize_notion_media_url(src);
                let lower = media_url.to_lowercase();
                let is_meta = lower.contains("/images/meta/default")
                    || lower.contains("favicon")
                    || lower.contains("apple-touch-icon");
                if !is_meta && seen.insert(media_url.clone()) {
                    out.push(NotionGalleryItem {
                        title: title.clone(),
                        media_url,
                    });
                }
            }
        }

        // Some Notion blocks store media links in format/source/display_source
        if let Some(src) = value
            .get("format")
            .and_then(|f| f.get("display_source"))
            .and_then(|s| s.as_str())
        {
            let media_url = normalize_notion_media_url(src);
            let lower = media_url.to_lowercase();
            let is_meta = lower.contains("/images/meta/default")
                || lower.contains("favicon")
                || lower.contains("apple-touch-icon");
            if !is_meta && looks_like_media_url(&media_url) && seen.insert(media_url.clone()) {
                out.push(NotionGalleryItem {
                    title: title.clone(),
                    media_url,
                });
            }
        }
        if let Some(src) = value
            .get("format")
            .and_then(|f| f.get("source"))
            .and_then(|s| s.as_str())
        {
            let media_url = normalize_notion_media_url(src);
            let lower = media_url.to_lowercase();
            let is_meta = lower.contains("/images/meta/default")
                || lower.contains("favicon")
                || lower.contains("apple-touch-icon");
            if !is_meta && looks_like_media_url(&media_url) && seen.insert(media_url.clone()) {
                out.push(NotionGalleryItem {
                    title: title.clone(),
                    media_url,
                });
            }
        }

        if let Some(cover) = value
            .get("format")
            .and_then(|f| f.get("page_cover"))
            .and_then(|c| c.as_str())
        {
            let media_url = normalize_notion_media_url(cover);
            let lower = media_url.to_lowercase();
            let is_meta = lower.contains("/images/meta/default")
                || lower.contains("favicon")
                || lower.contains("apple-touch-icon");
            if !is_meta && seen.insert(media_url.clone()) {
                out.push(NotionGalleryItem {
                    title: title.clone(),
                    media_url,
                });
            }
        }

        // Generic deep fallback for unknown/changed block schemas.
        let mut candidates = Vec::new();
        collect_urls_recursive(value, &mut candidates);
        for raw in candidates {
            let media_url = normalize_notion_media_url(&raw);
            let lower = media_url.to_lowercase();
            let is_meta = lower.contains("/images/meta/default")
                || lower.contains("favicon")
                || lower.contains("apple-touch-icon");
            if !is_meta && looks_like_media_url(&media_url) && seen.insert(media_url.clone()) {
                out.push(NotionGalleryItem {
                    title: title.clone(),
                    media_url,
                });
            }
        }
    }
}

fn collect_notion_child_page_ids(payload: &serde_json::Value, out: &mut Vec<String>) {
    let block_map = payload
        .get("recordMap")
        .and_then(|v| v.get("block"))
        .and_then(|v| v.as_object());
    let Some(blocks) = block_map else { return };
    for (_id, block_entry) in blocks {
        let value = block_entry.get("value").unwrap_or(block_entry);
        let block_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if matches!(
            block_type,
            "child_page" | "child_database" | "collection_view_page"
        ) {
            if let Some(id) = value.get("id").and_then(|v| v.as_str()) {
                if let Some(nid) = normalize_notion_id(id) {
                    if !out.iter().any(|x| x == &nid) {
                        out.push(nid);
                    }
                }
            }
        }
    }
}

fn collect_notion_collection_and_view_ids(
    payload: &serde_json::Value,
    collection_ids: &mut Vec<String>,
    view_ids: &mut Vec<String>,
) {
    if let Some(cols) = payload
        .get("recordMap")
        .and_then(|v| v.get("collection"))
        .and_then(|v| v.as_object())
    {
        for key in cols.keys() {
            if let Some(id) = normalize_notion_id(key) {
                if !collection_ids.iter().any(|x| x == &id) {
                    collection_ids.push(id);
                }
            }
        }
    }
    if let Some(views) = payload
        .get("recordMap")
        .and_then(|v| v.get("collection_view"))
        .and_then(|v| v.as_object())
    {
        for key in views.keys() {
            if let Some(id) = normalize_notion_id(key) {
                if !view_ids.iter().any(|x| x == &id) {
                    view_ids.push(id);
                }
            }
        }
    }

    let block_map = payload
        .get("recordMap")
        .and_then(|v| v.get("block"))
        .and_then(|v| v.as_object());
    let Some(blocks) = block_map else { return };
    for (_id, block_entry) in blocks {
        let value = block_entry.get("value").unwrap_or(block_entry);
        if let Some(cid) = value.get("collection_id").and_then(|v| v.as_str()) {
            if let Some(id) = normalize_notion_id(cid) {
                if !collection_ids.iter().any(|x| x == &id) {
                    collection_ids.push(id);
                }
            }
        }
        if let Some(arr) = value.get("view_ids").and_then(|v| v.as_array()) {
            for vv in arr {
                if let Some(vs) = vv.as_str() {
                    if let Some(id) = normalize_notion_id(vs) {
                        if !view_ids.iter().any(|x| x == &id) {
                            view_ids.push(id);
                        }
                    }
                }
            }
        }
    }
}

#[derive(Serialize, Deserialize)]
pub struct NotionGalleryItem {
    pub title: String,
    pub media_url: String,
}

#[derive(Serialize, Deserialize)]
pub struct NotionGalleryResponse {
    pub page_title: String,
    pub items: Vec<NotionGalleryItem>,
}

#[tauri::command]
pub async fn fetch_notion_gallery(url: String) -> Result<NotionGalleryResponse, String> {
    cmd_log!("fetch_notion_gallery");
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("URL is required.".to_string());
    }
    if !is_valid_notion_url(&url) {
        return Err("Please use a public Notion page link (notion.site or notion.so).".to_string());
    }

    let body = tauri::async_runtime::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
            .timeout(std::time::Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
            .map_err(|e| e.to_string())?;

        let resp = client.get(&url).send().map_err(|e| e.to_string())?;
        let status = resp.status();
        if status.as_u16() == 403 || status.as_u16() == 401 {
            return Err("This Notion page is not public. Use Share → Publish to web.".to_string());
        }
        if !status.is_success() {
            return Err(format!("Could not load page: {}", status));
        }
        let html = resp.text().map_err(|e| e.to_string())?;

        // Page title from <title> or og:title
        let page_title = regex_replace(&html, r"<title[^>]*>([^<]*)</title>")
            .or_else(|| regex_replace(&html, r#"<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']"#))
            .or_else(|| regex_replace(&html, r#"content=["']([^"']+)["'][^>]+property=["']og:title["']"#))
            .map(|t| t.trim().to_string())
            .unwrap_or_else(|| "Notion Gallery".to_string());

        // Gather ids from URL + query params
        let mut page_candidates = extract_notion_candidate_ids(&url);
        if let Ok(parsed_url) = url::Url::parse(&url) {
            if let Some(v) = parsed_url
                .query_pairs()
                .find_map(|(k, v)| if k == "v" { Some(v.to_string()) } else { None })
            {
                if let Some(view_id) = normalize_notion_id(&v) {
                    page_candidates.push(view_id);
                }
            }
            if let Some(p) = parsed_url
                .query_pairs()
                .find_map(|(k, v)| if k == "p" { Some(v.to_string()) } else { None })
            {
                if let Some(page_id) = normalize_notion_id(&p) {
                    page_candidates.push(page_id);
                }
            }
        }
        page_candidates.sort();
        page_candidates.dedup();

        let mut media_items: Vec<NotionGalleryItem> = Vec::new();
        let mut seen_urls: HashSet<String> = HashSet::new();
        let mut collection_ids: Vec<String> = Vec::new();
        let mut view_ids: Vec<String> = Vec::new();
        let mut pending: VecDeque<String> = VecDeque::new();
        let mut visited_pages: HashSet<String> = HashSet::new();
        const MAX_SCAN_PAGES: usize = 500;

        for id in page_candidates {
            pending.push_back(id);
        }
        // Seed collection/view candidates from URL directly.
        let url_ids = extract_notion_candidate_ids(&url);
        if let Some(first_id) = url_ids.first() {
            if !collection_ids.iter().any(|x| x == first_id) {
                collection_ids.push(first_id.clone());
            }
        }
        if let Ok(parsed_url) = url::Url::parse(&url) {
            if let Some(v) = parsed_url
                .query_pairs()
                .find_map(|(k, v)| if k == "v" { Some(v.to_string()) } else { None })
            {
                if let Some(view_id) = normalize_notion_id(&v) {
                    if !view_ids.iter().any(|x| x == &view_id) {
                        view_ids.push(view_id);
                    }
                }
            }
        }

        // Breadth-first scan: root page -> nested child pages/databases
        while let Some(pid) = pending.pop_front() {
            if visited_pages.contains(&pid) {
                continue;
            }
            if visited_pages.len() >= MAX_SCAN_PAGES {
                break;
            }
            visited_pages.insert(pid.clone());

            let payload = serde_json::json!({
                "pageId": pid,
                "limit": 100,
                "cursor": { "stack": [] },
                "chunkNumber": 0,
                "verticalColumns": false
            });
            let resp = client
                .post("https://www.notion.so/api/v3/loadPageChunk")
                .header("content-type", "application/json")
                .header("accept", "application/json, text/plain, */*")
                .header("referer", &url)
                .json(&payload)
                .send();
            let Ok(resp) = resp else { continue };
            let status = resp.status();
            if status.as_u16() == 403 || status.as_u16() == 401 {
                return Err("This Notion page is not public. Use Share → Publish to web.".to_string());
            }
            if !status.is_success() {
                continue;
            }
            let Ok(json) = resp.json::<serde_json::Value>() else { continue };

            collect_notion_media_from_block_map(&json, &mut seen_urls, &mut media_items);
            collect_notion_collection_and_view_ids(&json, &mut collection_ids, &mut view_ids);

            let mut child_pages = Vec::new();
            collect_notion_child_page_ids(&json, &mut child_pages);
            for child in child_pages {
                if !visited_pages.contains(&child) {
                    pending.push_back(child);
                }
            }

            let mut block_ids = Vec::new();
            collect_string_arrays_for_key(&json, "blockIds", &mut block_ids);
            for bid in block_ids {
                if let Some(id) = normalize_notion_id(&bid) {
                    if !visited_pages.contains(&id) {
                        pending.push_back(id);
                    }
                }
            }

            if visited_pages.len() >= 100 && !pending.is_empty() {
                std::thread::sleep(std::time::Duration::from_millis(300));
            }
        }

        // Query all discovered collection/view pairs (not limited to gallery DBs)
        for cid in collection_ids.clone() {
            for vid in view_ids.clone() {
                let query_payload = serde_json::json!({
                    "collection": { "id": cid },
                    "collectionView": { "id": vid },
                    "loader": {
                        "type": "table",
                        "limit": 1000,
                        "searchQuery": "",
                        "userTimeZone": "UTC",
                        "loadContentCover": true
                    }
                });
                if let Ok(qresp) = client
                    .post("https://www.notion.so/api/v3/queryCollection")
                    .header("content-type", "application/json")
                    .header("accept", "application/json, text/plain, */*")
                    .header("referer", &url)
                    .json(&query_payload)
                    .send()
                {
                    if qresp.status().is_success() {
                        if let Ok(qjson) = qresp.json::<serde_json::Value>() {
                            let mut block_ids = Vec::new();
                            collect_string_arrays_for_key(&qjson, "blockIds", &mut block_ids);
                            for bid in block_ids {
                                if let Some(id) = normalize_notion_id(&bid) {
                                    if !visited_pages.contains(&id) {
                                        pending.push_back(id);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // Scan row pages discovered from queryCollection too
        while let Some(pid) = pending.pop_front() {
            if visited_pages.contains(&pid) {
                continue;
            }
            if visited_pages.len() >= MAX_SCAN_PAGES {
                break;
            }
            visited_pages.insert(pid.clone());
            let payload = serde_json::json!({
                "pageId": pid,
                "limit": 100,
                "cursor": { "stack": [] },
                "chunkNumber": 0,
                "verticalColumns": false
            });
            if let Ok(resp) = client
                .post("https://www.notion.so/api/v3/loadPageChunk")
                .header("content-type", "application/json")
                .header("accept", "application/json, text/plain, */*")
                .header("referer", &url)
                .json(&payload)
                .send()
            {
                if resp.status().is_success() {
                    if let Ok(json) = resp.json::<serde_json::Value>() {
                        collect_notion_media_from_block_map(&json, &mut seen_urls, &mut media_items);
                        let mut child_pages = Vec::new();
                        collect_notion_child_page_ids(&json, &mut child_pages);
                        for child in child_pages {
                            if !visited_pages.contains(&child) {
                                pending.push_back(child);
                            }
                        }
                    }
                }
            }
            if visited_pages.len() >= 100 && !pending.is_empty() {
                std::thread::sleep(std::time::Duration::from_millis(300));
            }
        }

        // Legacy final fallback: static URL scan from HTML body
        if media_items.is_empty() {
            let html_unescaped = html
                .replace("\\u0026", "&")
                .replace("\\/", "/");
            let re_generic_media = Regex::new(
                r#"https?://[^\s"'<>\\]+\.(?:png|jpg|jpeg|gif|webp|svg|mp4|mov|webm|pdf|mp3|wav|ogg)(?:\?[^\s"'<>\\]*)?"#,
            )
            .map_err(|_| "Regex error".to_string())?;
            for src in [&html, &html_unescaped] {
                for m in re_generic_media.find_iter(src) {
                    let media_url = normalize_notion_media_url(m.as_str());
                    let lower = media_url.to_lowercase();
                    let is_meta = lower.contains("/images/meta/default")
                        || lower.contains("favicon")
                        || lower.contains("apple-touch-icon");
                    if !is_meta && seen_urls.insert(media_url.clone()) {
                        media_items.push(NotionGalleryItem {
                            title: "Notion Item".to_string(),
                            media_url,
                        });
                    }
                }
            }
        }

        if media_items.is_empty() {
            return Err("No media files found on this Notion page or nested pages.".to_string());
        }

        Ok::<_, String>(NotionGalleryResponse {
            page_title: page_title.replace(" | Notion", "").trim().to_string(),
            items: media_items,
        })
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(body)
}

#[derive(Deserialize)]
pub struct AddLinkPayload {
    pub url: String,
    pub metadata: Option<AddLinkMetadata>,
}

#[derive(Deserialize)]
pub struct AddLinkMetadata {
    pub title: Option<String>,
    #[serde(alias = "thumbnailUrl")]
    #[allow(dead_code)]
    pub thumbnail_url: Option<String>,
    #[serde(alias = "aspectRatio")]
    pub aspect_ratio: Option<f64>,
}

#[tauri::command]
pub fn add_link_inspiration(
    app: AppHandle,
    db: State<Arc<Db>>,
    vault: State<Arc<VaultPaths>>,
    payload: AddLinkPayload,
) -> Result<serde_json::Value, String> {
    cmd_log!("add_link_inspiration");
    let url = payload.url.trim().to_string();
    if url.is_empty() {
        return Err("Empty URL".to_string());
    }
    let meta = payload.metadata.as_ref();
    let mut resolved_title: Option<String> = meta
        .and_then(|m| m.title.as_deref())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let mut aspect_ratio = meta.and_then(|m| m.aspect_ratio);

    let id = Uuid::new_v4().to_string();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;

    let mut thumbnail_rel: Option<String> = None;
    let mut thumb_urls: Vec<String> = if let Some(thumb_url) = meta
        .and_then(|m| m.thumbnail_url.as_deref())
        .filter(|s| !s.is_empty())
    {
        let url = thumb_url.to_string();
        if url.contains("ytimg.com") && url.contains("/maxresdefault.jpg") {
            let sd = url.replace("/maxresdefault.jpg", "/sddefault.jpg");
            let hq = url.replace("/maxresdefault.jpg", "/hqdefault.jpg");
            vec![url, sd, hq]
        } else {
            vec![url]
        }
    } else {
        vec![]
    };

    if let Some(video_id) = extract_youtube_video_id(&url) {
        if thumb_urls.is_empty() {
            thumb_urls = vec![
                format!("https://i.ytimg.com/vi/{}/maxresdefault.jpg", video_id),
                format!("https://i.ytimg.com/vi/{}/sddefault.jpg", video_id),
                format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", video_id),
            ];
        }
        // Prefer oEmbed title for YouTube links so library title matches the real video title.
        let oembed_url = format!(
            "https://www.youtube.com/oembed?url={}&format=json&maxwidth=1280&maxheight=720",
            urlencoding::encode(&url)
        );
        let oembed_client = reqwest::blocking::Client::builder()
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0")
            .connect_timeout(std::time::Duration::from_secs(3))
            .timeout(std::time::Duration::from_secs(6))
            .redirect(reqwest::redirect::Policy::limited(3))
            .build()
            .map_err(|e| e.to_string())?;
        if let Ok(resp) = oembed_client.get(&oembed_url).send() {
            if let Ok(json) = resp.json::<serde_json::Value>() {
                if let Some(t) = json
                    .get("title")
                    .and_then(|v| v.as_str())
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
                {
                    resolved_title = Some(t.to_string());
                }
                if aspect_ratio.is_none() {
                    if let (Some(w), Some(h)) = (
                        json.get("width").and_then(|v| v.as_f64()),
                        json.get("height").and_then(|v| v.as_f64()),
                    ) {
                        if w > 0.0 && h > 0.0 {
                            aspect_ratio = Some(w / h);
                        }
                    }
                }
            }
        }
    }

    let title: String = resolved_title.unwrap_or_else(|| domain_from_url(&url));
    if !thumb_urls.is_empty() {
        let dest = next_vault_uuid_path(&vault.thumbs_dir);
        fs::create_dir_all(&vault.thumbs_dir).map_err(|e| e.to_string())?;
        let client = reqwest::blocking::Client::builder()
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36")
            .connect_timeout(std::time::Duration::from_secs(3))
            .timeout(std::time::Duration::from_secs(6))
            .redirect(reqwest::redirect::Policy::limited(3))
            .build()
            .map_err(|e| e.to_string())?;
        for thumb_url in &thumb_urls {
            if let Ok(resp) = client.get(thumb_url).send() {
                if resp.status().is_success() {
                    if let Ok(bytes) = resp.bytes() {
                        if fs::write(&dest, &bytes).is_ok() {
                            thumbnail_rel = Some(rel_to_vault(&vault.root, &dest));
                            break;
                        }
                    }
                }
            }
        }
    }

    let conn = db.conn();
    let vault_id = thumbnail_rel
        .as_ref()
        .and_then(|p| Path::new(p).file_name())
        .and_then(|n| n.to_str())
        .map(|s| s.to_string());
    conn.execute(
        r#"INSERT INTO inspirations (id, type, title, source_url, original_filename, stored_path, thumbnail_path, display_row, aspect_ratio, created_at, updated_at, vault_id, mime_type)
           VALUES (?, 'link', ?, ?, NULL, NULL, ?, NULL, ?, ?, ?, ?, ?)"#,
        rusqlite::params![
            id,
            title,
            url,
            thumbnail_rel,
            aspect_ratio,
            ts,
            ts,
            vault_id,
            "image/jpeg"
        ],
    )
    .map_err(|e| e.to_string())?;
    add_inspiration_to_unsorted(&conn, &id)?;

    let source = if extract_youtube_video_id(&url).is_some() {
        "youtube"
    } else if url.contains("instagram.com") {
        "instagram"
    } else {
        "web"
    };
    let platform = if source == "youtube" {
        Some("youtube")
    } else if source == "instagram" {
        Some("instagram")
    } else {
        None
    };
    let channel = if source == "youtube" {
        resolve_ytdlp_path(Some(&app)).and_then(|p| fetch_youtube_channel(&p, &url))
    } else {
        None
    };
    let _ = tags::apply_system_tags(
        &conn,
        &id,
        source,
        "link",
        aspect_ratio,
        platform,
        channel.as_deref(),
    );

    // Extract palette from thumbnail image when present (background, fire-and-forget)
    if thumbnail_rel.is_some() {
        let db_bg = db.inner().clone();
        let vault_bg = vault.inner().clone();
        let id_bg = id.clone();
        std::thread::spawn(move || {
            let _ = do_extract_palette(&db_bg, &vault_bg, &id_bg);
        });
    }

    Ok(serde_json::json!({ "id": id }))
}

#[tauri::command]
pub fn delete_inspiration(
    db: State<Arc<Db>>,
    vault: State<Arc<VaultPaths>>,
    id: String,
) -> Result<serde_json::Value, String> {
    cmd_log!("delete_inspiration");
    let conn = db.conn();
    let row: Option<(Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT stored_path, thumbnail_path FROM inspirations WHERE id = ?",
            [&id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let tag_ids: Vec<String> = conn
        .prepare("SELECT tag_id FROM inspiration_tags WHERE inspiration_id = ?")
        .map_err(|e| e.to_string())?
        .query_map([&id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    conn.execute("DELETE FROM inspirations WHERE id = ?", [&id])
        .map_err(|e| e.to_string())?;

    for tag_id in tag_ids {
        let _ = tags::decrement_tag_usage(&conn, &tag_id);
    }

    if let Some((stored, thumb)) = row {
        if let Some(ref p) = stored {
            if let Ok(abs) = resolve_vault_relative_existing_path(&vault.root, p) {
                let _ = fs::remove_file(&abs);
            }
        }
        if let Some(ref p) = thumb {
            if let Ok(abs) = resolve_vault_relative_existing_path(&vault.root, p) {
                let _ = fs::remove_file(&abs);
            }
        }
    }
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
pub fn clear_all_media(
    db: State<Arc<Db>>,
    vault: State<Arc<VaultPaths>>,
) -> Result<serde_json::Value, String> {
    cmd_log!("clear_all_media");
    let conn = db.conn();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;

    let media_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM inspirations", [], |r| r.get(0))
        .unwrap_or(0);

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM inspiration_tags", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM tag_usage_counts", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM collection_items", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM inspirations", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM collections", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM tags WHERE origin IN ('system','computed')", [])
        .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE moodboard_items SET inspiration_id = NULL, updated_at = ? WHERE inspiration_id IS NOT NULL",
        [ts],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    let mut deleted_files = 0usize;
    let collection_profiles_dir = vault.root.join("collection_profiles");
    for dir in [
        &vault.media_dir,
        &vault.thumbs_dir,
        &collection_profiles_dir,
    ] {
        if !dir.exists() {
            continue;
        }
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_file() && fs::remove_file(&p).is_ok() {
                    deleted_files += 1;
                } else if p.is_dir() && fs::remove_dir_all(&p).is_ok() {
                    deleted_files += 1;
                }
            }
        }
        let _ = fs::create_dir_all(dir);
    }

    Ok(serde_json::json!({
        "ok": true,
        "deletedMediaRows": media_count,
        "deletedStorageEntries": deleted_files
    }))
}

#[derive(Deserialize)]
pub struct UpdateInspirationPayload {
    pub id: String,
    pub updates: Option<serde_json::Value>,
}

#[tauri::command]
pub fn update_inspiration(
    db: State<Arc<Db>>,
    _vault: State<Arc<VaultPaths>>,
    payload: UpdateInspirationPayload,
) -> Result<Option<serde_json::Value>, String> {
    cmd_log!("update_inspiration");
    let updates = match payload.updates.as_ref() {
        Some(u) => u,
        None => return Ok(None),
    };
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;

    let conn = db.conn();
    let mut has_update = false;
    if let Some(v) = updates.get("title").and_then(|x| x.as_str()) {
        conn.execute(
            "UPDATE inspirations SET title = ?, updated_at = ? WHERE id = ?",
            rusqlite::params![v, ts, payload.id],
        )
        .map_err(|e| e.to_string())?;
        has_update = true;
    }
    if let Some(v) = updates.get("display_row").and_then(|x| x.as_str()) {
        conn.execute(
            "UPDATE inspirations SET display_row = ?, updated_at = ? WHERE id = ?",
            rusqlite::params![v, ts, payload.id],
        )
        .map_err(|e| e.to_string())?;
        has_update = true;
    }
    if !has_update {
        return Ok(None);
    }

    let row = conn
        .query_row(
            "SELECT id, type, title, source_url, original_filename, stored_path, thumbnail_path, display_row, aspect_ratio, created_at, updated_at FROM inspirations WHERE id = ?",
            [&payload.id],
            |r| {
                Ok(serde_json::json!({
                    "id": r.get::<_, String>(0)?,
                    "type": r.get::<_, String>(1)?,
                    "title": r.get::<_, Option<String>>(2)?,
                    "source_url": r.get::<_, Option<String>>(3)?,
                    "original_filename": r.get::<_, Option<String>>(4)?,
                    "stored_path": r.get::<_, Option<String>>(5)?,
                    "thumbnail_path": r.get::<_, Option<String>>(6)?,
                    "display_row": r.get::<_, Option<String>>(7)?,
                    "aspect_ratio": r.get::<_, Option<f64>>(8)?,
                    "created_at": r.get::<_, i64>(9)?,
                    "updated_at": r.get::<_, i64>(10)?
                }))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;

    Ok(row)
}

fn get_media_aspect_ratio(path: &Path, media_type: &str) -> Option<f64> {
    if media_type == "image" || media_type == "gif" {
        if let Ok(img) = image::open(path) {
            let (w, h) = img.dimensions();
            if h > 0 {
                return Some(w as f64 / h as f64);
            }
        }
    }
    if media_type == "video" {
        // Will be filled when we have ffprobe
        return None;
    }
    None
}

fn detect_media_type(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_string_lossy().to_lowercase();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "webp" | "bmp" | "tiff" | "tif" | "heic" => Some("image"),
        "gif" => Some("gif"),
        "mp4" | "mov" | "mkv" | "webm" | "avi" | "wmv" | "m4v" => Some("video"),
        _ => None,
    }
}

fn rel_to_vault(vault_root: &Path, abs: &Path) -> String {
    abs.strip_prefix(vault_root)
        .unwrap_or(abs)
        .to_string_lossy()
        .replace('\\', "/")
}

/// Vault-relative path as stored in SQLite (`media/<uuid>`), using canonical roots so Windows matches.
fn vault_relative_path_for_lookup(vault_root: &Path, abs: &Path) -> String {
    vault_root
        .canonicalize()
        .ok()
        .and_then(|root| abs.strip_prefix(&root).ok())
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|| rel_to_vault(vault_root, abs))
}

fn extension_for_mime_clipboard(mime: Option<&str>) -> Option<&'static str> {
    match mime.unwrap_or("").to_ascii_lowercase().as_str() {
        "video/mp4" => Some("mp4"),
        "video/webm" => Some("webm"),
        "video/quicktime" => Some("mov"),
        "video/x-matroska" | "video/mkv" => Some("mkv"),
        "video/x-msvideo" => Some("avi"),
        "video/x-ms-wmv" => Some("wmv"),
        "video/x-m4v" => Some("m4v"),
        "image/jpeg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        _ => None,
    }
}

fn detect_mime_from_filename(name: &str) -> String {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg".to_string(),
        "png" => "image/png".to_string(),
        "webp" => "image/webp".to_string(),
        "gif" => "image/gif".to_string(),
        "bmp" => "image/bmp".to_string(),
        "avif" => "image/avif".to_string(),
        "heic" => "image/heic".to_string(),
        "mp4" => "video/mp4".to_string(),
        "mov" => "video/quicktime".to_string(),
        "webm" => "video/webm".to_string(),
        "mkv" => "video/x-matroska".to_string(),
        "avi" => "video/x-msvideo".to_string(),
        "wmv" => "video/x-ms-wmv".to_string(),
        "m4v" => "video/x-m4v".to_string(),
        "flv" => "video/x-flv".to_string(),
        "svg" => "image/svg+xml".to_string(),
        _ => "application/octet-stream".to_string(),
    }
}

fn next_vault_uuid_path(dir: &Path) -> PathBuf {
    dir.join(Uuid::new_v4().to_string())
}

fn detect_mime_from_bytes(bytes: &[u8]) -> &'static str {
    if bytes.len() < 4 {
        return "application/octet-stream";
    }
    if bytes.len() >= 3 && bytes[0..3] == [0xFF, 0xD8, 0xFF] {
        return "image/jpeg";
    }
    if bytes.len() >= 8 && bytes[0..8] == [137, 80, 78, 71, 13, 10, 26, 10] {
        return "image/png";
    }
    if bytes.len() >= 6 && (bytes[0..6] == *b"GIF87a" || bytes[0..6] == *b"GIF89a") {
        return "image/gif";
    }
    if bytes.len() >= 12 && bytes[0..4] == *b"RIFF" && bytes[8..12] == *b"WEBP" {
        return "image/webp";
    }
    if bytes.len() >= 2 && bytes[0..2] == *b"BM" {
        return "image/bmp";
    }
    if bytes.len() >= 8 && bytes[4..8] == *b"ftyp" {
        return "video/mp4";
    }
    if bytes.len() >= 4 && bytes[0..4] == [0x1A, 0x45, 0xDF, 0xA3] {
        return "video/webm";
    }
    "application/octet-stream"
}

pub fn migrate_vault_filenames_to_uuid(
    db: &Arc<Db>,
    vault: &Arc<VaultPaths>,
) -> Result<(), String> {
    let migration_flag = vault.root.join(".vault_migrated_uuid");
    if migration_flag.exists() {
        return Ok(());
    }

    let rows: Vec<(String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>)> = {
        let conn = db.conn();
        let mut stmt = conn
            .prepare(
                "SELECT id, stored_path, thumbnail_path, vault_id, original_filename, mime_type
                 FROM inspirations",
            )
            .map_err(|e| e.to_string())?;
        let mapped = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, Option<String>>(5)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in mapped {
            out.push(row.map_err(|e| e.to_string())?);
        }
        out
    };

    for (id, stored_path, thumbnail_path, vault_id, original_filename, mime_type) in rows {
        let mut new_stored_path = stored_path.clone();
        let mut new_thumbnail_path = thumbnail_path.clone();
        let mut new_vault_id = vault_id.clone();
        let mut new_original_filename = original_filename.clone();
        let mut new_mime_type = mime_type.clone();
        let mut changed = false;

        if let Some(sp) = stored_path.clone() {
            if let Ok(abs) = resolve_vault_relative_existing_path(&vault.root, &sp) {
                let old_name = abs
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("unknown")
                    .to_string();
                if abs.extension().is_some() {
                    let new_abs = next_vault_uuid_path(abs.parent().unwrap_or(&vault.media_dir));
                    fs::rename(&abs, &new_abs).map_err(|e| e.to_string())?;
                    new_stored_path = Some(rel_to_vault(&vault.root, &new_abs));
                    new_vault_id = new_abs
                        .file_name()
                        .and_then(|n| n.to_str())
                        .map(|s| s.to_string());
                    if new_original_filename
                        .as_deref()
                        .map(|s| s.trim().is_empty())
                        .unwrap_or(true)
                    {
                        new_original_filename = Some(old_name.clone());
                    }
                    if new_mime_type
                        .as_deref()
                        .map(|s| s.trim().is_empty())
                        .unwrap_or(true)
                    {
                        new_mime_type = Some(detect_mime_from_filename(&old_name));
                    }
                    changed = true;
                } else {
                    if new_vault_id
                        .as_deref()
                        .map(|s| s.trim().is_empty())
                        .unwrap_or(true)
                    {
                        new_vault_id = Some(old_name.clone());
                        changed = true;
                    }
                    if new_original_filename
                        .as_deref()
                        .map(|s| s.trim().is_empty())
                        .unwrap_or(true)
                    {
                        new_original_filename = Some(old_name);
                        changed = true;
                    }
                }
            }
        }

        if let Some(tp) = thumbnail_path.clone() {
            if let Ok(abs) = resolve_vault_relative_existing_path(&vault.root, &tp) {
                let old_name = abs
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("unknown")
                    .to_string();
                if abs.extension().is_some() {
                    let new_abs = next_vault_uuid_path(abs.parent().unwrap_or(&vault.thumbs_dir));
                    fs::rename(&abs, &new_abs).map_err(|e| e.to_string())?;
                    new_thumbnail_path = Some(rel_to_vault(&vault.root, &new_abs));
                    if new_vault_id
                        .as_deref()
                        .map(|s| s.trim().is_empty())
                        .unwrap_or(true)
                    {
                        new_vault_id = new_abs
                            .file_name()
                            .and_then(|n| n.to_str())
                            .map(|s| s.to_string());
                    }
                    if new_mime_type
                        .as_deref()
                        .map(|s| s.trim().is_empty())
                        .unwrap_or(true)
                    {
                        new_mime_type = Some(detect_mime_from_filename(&old_name));
                    }
                    changed = true;
                }
            }
        }

        if changed {
            let conn = db.conn();
            conn.execute(
                "UPDATE inspirations
                 SET stored_path = ?, thumbnail_path = ?, vault_id = ?, original_filename = ?, mime_type = ?
                 WHERE id = ?",
                rusqlite::params![
                    new_stored_path,
                    new_thumbnail_path,
                    new_vault_id,
                    new_original_filename,
                    new_mime_type,
                    id
                ],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    fs::write(&migration_flag, b"1").map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Clone)]
struct TelegramMediaCandidate {
    media_type: String,
    source_rel_path: String,
    original_filename: String,
    title: Option<String>,
    source_url: Option<String>,
    created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TelegramExportPreview {
    is_valid: bool,
    channel_name: String,
    valid_count: usize,
    skipped_unsupported: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramImportPayload {
    pub folder_path: String,
    pub collection_mode: String, // new | existing | none
    pub collection_name: Option<String>,
    pub collection_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TelegramImportProgress {
    stage: String,
    current: usize,
    total: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TelegramImportSummary {
    imported: usize,
    duplicates: usize,
    failed: usize,
    skipped_unsupported: usize,
    total_candidates: usize,
    collection_id: Option<String>,
    collection_name: Option<String>,
}

fn feedback_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn parse_telegram_created_at_ms(message: &Value) -> i64 {
    if let Some(v) = message.get("date_unixtime").and_then(|v| v.as_str()) {
        if let Ok(sec) = v.parse::<i64>() {
            return sec.saturating_mul(1000);
        }
    }
    if let Some(sec) = message.get("date_unixtime").and_then(|v| v.as_i64()) {
        return sec.saturating_mul(1000);
    }
    now_ms()
}

fn parse_telegram_source_url(message: &Value) -> Option<String> {
    if let Some(s) = message.get("link").and_then(|v| v.as_str()) {
        let t = s.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    if let Some(arr) = message.get("text_entities").and_then(|v| v.as_array()) {
        for e in arr {
            let maybe_type = e.get("type").and_then(|v| v.as_str()).unwrap_or_default();
            if maybe_type.eq_ignore_ascii_case("link") {
                if let Some(text) = e.get("text").and_then(|v| v.as_str()) {
                    let t = text.trim();
                    if t.starts_with("http://") || t.starts_with("https://") {
                        return Some(t.to_string());
                    }
                }
            }
        }
    }
    None
}

fn parse_telegram_title(message: &Value, fallback_filename: &str) -> Option<String> {
    if let Some(s) = message.get("text").and_then(|v| v.as_str()) {
        let t = s.trim();
        if !t.is_empty() {
            return Some(t.chars().take(120).collect());
        }
    }
    if let Some(arr) = message.get("text").and_then(|v| v.as_array()) {
        for v in arr {
            if let Some(s) = v.as_str() {
                let t = s.trim();
                if !t.is_empty() {
                    return Some(t.chars().take(120).collect());
                }
            } else if let Some(s) = v.get("text").and_then(|x| x.as_str()) {
                let t = s.trim();
                if !t.is_empty() {
                    return Some(t.chars().take(120).collect());
                }
            }
        }
    }
    let stem = Path::new(fallback_filename)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Telegram import")
        .trim();
    if stem.is_empty() {
        None
    } else {
        Some(stem.to_string())
    }
}

fn telegram_media_field(message: &Value) -> Option<(String, String)> {
    if let Some(photo) = message.get("photo").and_then(|v| v.as_str()) {
        let p = photo.trim();
        if !p.is_empty() {
            return Some((p.to_string(), "image".to_string()));
        }
    }

    if let Some(file) = message.get("file").and_then(|v| v.as_str()) {
        let p = file.trim();
        if p.is_empty() {
            return None;
        }
        let media_type_hint = message
            .get("media_type")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_lowercase();

        let kind = if media_type_hint.contains("animation") || media_type_hint.contains("gif") {
            "gif".to_string()
        } else if media_type_hint.contains("video") {
            "video".to_string()
        } else {
            detect_media_type(Path::new(p)).unwrap_or("").to_string()
        };

        if kind == "image" || kind == "video" || kind == "gif" {
            return Some((p.to_string(), kind));
        }
    }

    None
}

fn parse_telegram_export(
    folder: &Path,
) -> Result<(TelegramExportPreview, Vec<TelegramMediaCandidate>), String> {
    let result_json = folder.join("result.json");
    if !result_json.exists() {
        return Err("Invalid Telegram export folder.".to_string());
    }

    let root_abs = folder
        .canonicalize()
        .map_err(|_| "Invalid Telegram export folder.".to_string())?;
    let file =
        fs::File::open(&result_json).map_err(|_| "Invalid Telegram export folder.".to_string())?;
    let reader = BufReader::new(file);
    let data: Value = serde_json::from_reader(reader)
        .map_err(|_| "Invalid Telegram export folder.".to_string())?;

    let channel_name = data
        .get("name")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or("Telegram")
        .to_string();

    let mut skipped_unsupported = 0usize;
    let mut out = Vec::new();
    let messages = data
        .get("messages")
        .and_then(|v| v.as_array())
        .ok_or("Invalid Telegram export folder.".to_string())?;

    for msg in messages {
        let Some((rel_path_raw, media_type)) = telegram_media_field(msg) else {
            continue;
        };

        let rel_path = rel_path_raw
            .replace('\\', "/")
            .trim_start_matches("./")
            .trim_start_matches('/')
            .to_string();
        let abs = folder.join(&rel_path);
        let abs_ok = match abs.canonicalize() {
            Ok(p) => p,
            Err(_) => {
                skipped_unsupported += 1;
                continue;
            }
        };
        if !abs_ok.starts_with(&root_abs) || !abs_ok.is_file() {
            skipped_unsupported += 1;
            continue;
        }

        let original_filename = Path::new(&rel_path)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("telegram-media")
            .to_string();
        let created_at = parse_telegram_created_at_ms(msg);
        let source_url = parse_telegram_source_url(msg);
        let title = parse_telegram_title(msg, &original_filename);

        out.push(TelegramMediaCandidate {
            media_type,
            source_rel_path: rel_path,
            original_filename,
            title,
            source_url,
            created_at,
        });
    }

    Ok((
        TelegramExportPreview {
            is_valid: true,
            channel_name,
            valid_count: out.len(),
            skipped_unsupported,
        },
        out,
    ))
}

fn hex_sha256(bytes: &[u8]) -> String {
    let hash = Sha256::digest(bytes);
    hash.iter()
        .map(|b| format!("{:02x}", b))
        .collect::<String>()
}

fn build_existing_hash_index(
    conn: &rusqlite::Connection,
    vault: &VaultPaths,
) -> HashMap<String, String> {
    let mut index = HashMap::new();
    let mut stmt = match conn.prepare("SELECT id, stored_path, thumbnail_path FROM inspirations") {
        Ok(s) => s,
        Err(_) => return index,
    };
    let rows = match stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, Option<String>>(2)?,
        ))
    }) {
        Ok(r) => r,
        Err(_) => return index,
    };
    for row in rows.flatten() {
        let (id, stored, thumb) = row;
        let rel = stored.or(thumb);
        let Some(rel_path) = rel else {
            continue;
        };
        let abs = vault.root.join(rel_path);
        let Ok(bytes) = fs::read(abs) else {
            continue;
        };
        index.insert(hex_sha256(&bytes), id);
    }
    index
}

fn fetch_youtube_channel(ytdlp_path: &std::path::Path, url: &str) -> Option<String> {
    ensure_executable(ytdlp_path);
    let mut cmd = Command::new(ytdlp_path);
    suppress_console_window(&mut cmd);
    let out = cmd
        .args([
            "--skip-download",
            "--no-warnings",
            "--no-check-certificates",
            "--print",
            "%(channel)s",
            url,
        ])
        .output()
        .ok()?;
    if out.status.success() {
        String::from_utf8_lossy(&out.stdout).lines().find_map(|l| {
            let t = l.trim();
            if !t.is_empty() && t.len() <= 100 {
                Some(t.to_string())
            } else {
                None
            }
        })
    } else {
        let mut fallback_cmd = Command::new(ytdlp_path);
        suppress_console_window(&mut fallback_cmd);
        fallback_cmd
            .args([
                "--skip-download",
                "--no-warnings",
                "--print",
                "%(uploader)s",
                url,
            ])
            .output()
            .ok()
            .and_then(|o| {
                if o.status.success() {
                    String::from_utf8_lossy(&o.stdout).lines().find_map(|l| {
                        let t = l.trim();
                        if !t.is_empty() && t.len() <= 100 {
                            Some(t.to_string())
                        } else {
                            None
                        }
                    })
                } else {
                    None
                }
            })
    }
}

fn resolve_ytdlp_path(app: Option<&AppHandle>) -> Option<PathBuf> {
    use tauri::path::BaseDirectory;
    let app = app?;
    let path_api = app.path();
    for candidate in &["resources/yt-dlp.exe", "yt-dlp.exe", "resources/yt-dlp", "yt-dlp"] {
        if let Ok(p) = path_api.resolve(candidate, BaseDirectory::Resource) {
            let exists = p.exists();
            let size = fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
            info!(
                "[yt-dlp] candidate={} path={} exists={} size={}",
                candidate,
                p.display(),
                exists,
                size
            );
            if exists && size > 1_000_000 {
                return Some(p);
            }
        }
    }
    if let Ok(res_dir) = path_api.resource_dir() {
        let p = res_dir.join("resources").join("yt-dlp.exe");
        if p.exists() && fs::metadata(&p).map(|m| m.len()).unwrap_or(0) > 1_000_000 {
            return Some(p);
        }
        let p2 = res_dir.join("yt-dlp.exe");
        if p2.exists() && fs::metadata(&p2).map(|m| m.len()).unwrap_or(0) > 1_000_000 {
            return Some(p2);
        }
        let p3 = res_dir.join("resources").join("yt-dlp");
        if p3.exists() && fs::metadata(&p3).map(|m| m.len()).unwrap_or(0) > 1_000_000 {
            return Some(p3);
        }
        let p4 = res_dir.join("yt-dlp");
        if p4.exists() && fs::metadata(&p4).map(|m| m.len()).unwrap_or(0) > 1_000_000 {
            return Some(p4);
        }
    }
    warn!("[yt-dlp] no valid bundled binary found");
    None
}

#[cfg(target_os = "macos")]
fn ensure_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = fs::metadata(path) {
        let mut perms = meta.permissions();
        let mode = perms.mode();
        if mode & 0o111 == 0 {
            perms.set_mode(0o755);
            let _ = fs::set_permissions(path, perms);
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn ensure_executable(_path: &Path) {}

// ---- Video download: progress events, pause (stderr backpressure), cancel (kill) ----

#[derive(Clone)]
pub struct VideoDownloadSessionState(pub Arc<Mutex<Option<Arc<VideoDownloadSessionInner>>>>);

impl Default for VideoDownloadSessionState {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(None)))
    }
}

pub struct VideoDownloadSessionInner {
    pub cancel: Arc<AtomicBool>,
    pub paused: Arc<AtomicBool>,
    pub child: Mutex<Option<std::process::Child>>,
}

fn cleanup_ytdlp_temp_by_prefix(media_dir: &Path, temp_prefix: &str) {
    let Ok(rd) = fs::read_dir(media_dir) else {
        return;
    };
    for entry in rd.flatten() {
        let p = entry.path();
        let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        if stem == temp_prefix {
            let _ = fs::remove_file(&p);
        }
    }
}

fn install_video_download_session(
    state: &VideoDownloadSessionState,
    session: Arc<VideoDownloadSessionInner>,
) {
    let mut slot = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(old) = slot.take() {
        old.cancel.store(true, Ordering::SeqCst);
        if let Ok(mut ch) = old.child.lock() {
            if let Some(mut c) = ch.take() {
                let _ = c.kill();
                let _ = c.wait();
            }
        }
    }
    *slot = Some(session);
}

fn clear_video_download_session(state: &VideoDownloadSessionState) {
    let mut slot = state.0.lock().unwrap_or_else(|e| e.into_inner());
    *slot = None;
}

fn ytdlp_emit_progress_from_line(
    line: &str,
    app_emit: &AppHandle,
    re_pct: &Regex,
    re_frag: &Regex,
    tail: &Mutex<String>,
) {
    if let Ok(mut t) = tail.lock() {
        t.push_str(line);
        if t.len() > 12_000 {
            let drain = t.len() - 8_000;
            t.drain(..drain);
        }
    }
    if let Some(caps) = re_pct.captures(line) {
        if let Ok(p) = caps[1].parse::<f64>() {
            let pct = p.clamp(0.0, 100.0).round() as i64;
            let _ = app_emit.emit(
                "video-download-progress",
                serde_json::json!({ "percent": pct }),
            );
            return;
        }
    }
    if let Some(caps) = re_frag.captures(line) {
        if let (Ok(a), Ok(b)) = (caps[1].parse::<u64>(), caps[2].parse::<u64>()) {
            if b > 0 {
                let pct = ((a.saturating_mul(100)) / b).min(100) as i64;
                let _ = app_emit.emit(
                    "video-download-progress",
                    serde_json::json!({ "percent": pct }),
                );
            }
        }
    }
}

#[tauri::command]
pub fn set_video_download_paused(
    paused: bool,
    state: State<'_, VideoDownloadSessionState>,
) -> Result<(), String> {
    let slot = state
        .0
        .lock()
        .map_err(|_| "video download session lock poisoned")?;
    if let Some(s) = slot.as_ref() {
        s.paused.store(paused, Ordering::SeqCst);
    }
    Ok(())
}

#[tauri::command]
pub fn cancel_video_download(state: State<'_, VideoDownloadSessionState>) -> Result<(), String> {
    let slot = state
        .0
        .lock()
        .map_err(|_| "video download session lock poisoned")?;
    if let Some(s) = slot.as_ref() {
        s.cancel.store(true, Ordering::SeqCst);
        if let Ok(mut ch) = s.child.lock() {
            if let Some(ref mut c) = *ch {
                let _ = c.kill();
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn download_video_from_url(
    app: AppHandle,
    db: State<'_, Arc<Db>>,
    vault: State<'_, Arc<VaultPaths>>,
    download_session: State<'_, VideoDownloadSessionState>,
    url: String,
    title: Option<String>,
) -> Result<serde_json::Value, String> {
    cmd_log!("download_video_from_url");
    let url = normalize_required_http_url(&url)?;
    let db = db.inner().clone();
    let vault = vault.inner().clone();
    let app = app.clone();
    let download_ctrl = (*download_session).clone();

    tauri::async_runtime::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let run = || -> Result<serde_json::Value, String> {
        info!("[download] starting url={}", url);
        let id = Uuid::new_v4().to_string();
        let temp_prefix = Uuid::new_v4().to_string();
        let dest = vault.media_dir.join(format!("{}.mp4", temp_prefix));

        fs::create_dir_all(&vault.media_dir).map_err(|e| e.to_string())?;

        let output_template = dest.with_extension("%(ext)s");
        let output_str = output_template.to_string_lossy().replace('\\', "/");

        let ytdlp_path = resolve_ytdlp_path(Some(&app)).unwrap_or_else(|| {
            PathBuf::from(if cfg!(target_os = "windows") {
                "yt-dlp.exe"
            } else {
                "yt-dlp"
            })
        });
        info!("[yt-dlp] selected binary path={}", ytdlp_path.display());
        ensure_executable(&ytdlp_path);

        let is_youtube = extract_youtube_video_id(&url).is_some();
        let channel_name = if is_youtube {
            fetch_youtube_channel(&ytdlp_path, &url)
        } else {
            None
        };

        let (quality_mode, concurrent, prefer_prog) = {
            let conn = db.conn();
            (
                get_setting(&conn, "downloadQualityMode"),
                get_setting(&conn, "downloadConcurrentFragments"),
                get_setting(&conn, "preferProgressiveFormats"),
            )
        };

        // "best" (UI: Highest) must prefer merged best video+audio (YouTube DASH), not a single
        // progressive MP4 — the latter often caps around 720p/1080p even when 4K exists.
        let format_str = match quality_mode.as_str() {
            "fast" => "best[height<=720]/best".to_string(),
            "balanced" => "best[height<=1080][ext=mp4]/best[ext=mp4]/best".to_string(),
            "best" => {
                if prefer_prog == "true" {
                    "bestvideo*+bestaudio/best[ext=mp4]/best".to_string()
                } else {
                    "bestvideo*+bestaudio/bestvideo+bestaudio/best".to_string()
                }
            }
            _ => {
                if prefer_prog == "true" {
                    "bestvideo*+bestaudio/best[ext=mp4]/best".to_string()
                } else {
                    "bestvideo*+bestaudio/bestvideo+bestaudio/best".to_string()
                }
            }
        };
        info!("[download] quality_mode={} format={}", quality_mode, format_str);

        let cf: u32 = concurrent.parse().unwrap_or(8);
        let cf_str = format!("{}", cf.clamp(1, 16));

        let args = vec![
            "-o".to_string(),
            output_str.clone(),
            "-f".to_string(),
            format_str,
            "--no-check-certificates".to_string(),
            "--no-warnings".to_string(),
            "--no-playlist".to_string(),
            "--no-update".to_string(),
            "--ignore-config".to_string(),
            "--no-write-info-json".to_string(),
            "--no-write-comments".to_string(),
            "--no-write-subs".to_string(),
            "--no-embed-metadata".to_string(),
            "--no-embed-thumbnail".to_string(),
            "--no-mtime".to_string(),
            "--newline".to_string(),
            "--concurrent-fragments".to_string(),
            cf_str,
            "--write-thumbnail".to_string(),
            url.clone(),
        ];

        let session = Arc::new(VideoDownloadSessionInner {
            cancel: Arc::new(AtomicBool::new(false)),
            paused: Arc::new(AtomicBool::new(false)),
            child: Mutex::new(None),
        });
        install_video_download_session(&download_ctrl, session.clone());

        let stderr_tail = Arc::new(Mutex::new(String::new()));
        // yt-dlp may print "%" progress or "k of n" fragments; match loosely. Some builds buffer
        // stderr when piped — PYTHONUNBUFFERED helps Python-based yt-dlp on Windows.
        let re_pct = Regex::new(r"(?i)\[download\][^\n\r]*?(\d+(?:\.\d+)?)\s*%")
            .map_err(|e| e.to_string())?;
        let re_frag = Regex::new(r"(?i)\[download\][^\n\r]*?\b(\d+)\s+of\s+(\d+)\b")
            .map_err(|e| e.to_string())?;

        let app_emit = app.clone();
        let cancel_reader = session.cancel.clone();
        let paused_reader = session.paused.clone();
        let tail_reader = stderr_tail.clone();

        let mut cmd = Command::new(&ytdlp_path);
        suppress_console_window(&mut cmd);
        cmd.args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("PYTHONUNBUFFERED", "1");

        let mut child = cmd.spawn().map_err(|e| {
            log::error!(
                "[yt-dlp] spawn failed path={} err={}",
                ytdlp_path.display(),
                e
            );
            format!(
                "yt-dlp not found. Run 'npm install' and ensure yt-dlp is in src-tauri/resources/. Error: {}",
                e
            )
        })?;

        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "yt-dlp stderr pipe unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "yt-dlp stdout pipe unavailable".to_string())?;

        {
            let mut ch = session
                .child
                .lock()
                .map_err(|_| "video download child lock poisoned")?;
            *ch = Some(child);
        }

        let re_pct_out = re_pct.clone();
        let re_frag_out = re_frag.clone();
        let app_out = app_emit.clone();
        let tail_out = tail_reader.clone();
        let cancel_out = cancel_reader.clone();
        let paused_out = paused_reader.clone();

        let stdout_jh = std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            loop {
                while paused_out.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(50));
                    if cancel_out.load(Ordering::SeqCst) {
                        return;
                    }
                }
                if cancel_out.load(Ordering::SeqCst) {
                    return;
                }
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) => ytdlp_emit_progress_from_line(
                        &line,
                        &app_out,
                        &re_pct_out,
                        &re_frag_out,
                        &tail_out,
                    ),
                    Err(_) => break,
                }
            }
        });

        let stderr_jh = std::thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            loop {
                while paused_reader.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(50));
                    if cancel_reader.load(Ordering::SeqCst) {
                        return;
                    }
                }
                if cancel_reader.load(Ordering::SeqCst) {
                    return;
                }
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) => ytdlp_emit_progress_from_line(
                        &line,
                        &app_emit,
                        &re_pct,
                        &re_frag,
                        &tail_reader,
                    ),
                    Err(_) => break,
                }
            }
        });

        let mut exit_status: Option<ExitStatus> = None;
        loop {
            if session.cancel.load(Ordering::SeqCst) {
                if let Ok(mut ch) = session.child.lock() {
                    if let Some(ref mut c) = *ch {
                        let _ = c.kill();
                    }
                }
                break;
            }
            let mut done = false;
            if let Ok(mut ch) = session.child.lock() {
                if let Some(ref mut c) = *ch {
                    match c.try_wait() {
                        Ok(Some(st)) => {
                            exit_status = Some(st);
                            *ch = None;
                            done = true;
                        }
                        Ok(None) => {}
                        Err(e) => {
                            log::error!("[yt-dlp] try_wait error: {}", e);
                            *ch = None;
                            done = true;
                        }
                    }
                }
            }
            if done {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }

        let _ = stdout_jh.join();
        let _ = stderr_jh.join();

        if session.cancel.load(Ordering::SeqCst) {
            if let Ok(mut ch) = session.child.lock() {
                if let Some(mut c) = ch.take() {
                    let _ = c.wait();
                }
            }
            cleanup_ytdlp_temp_by_prefix(&vault.media_dir, &temp_prefix);
            return Ok(serde_json::json!({ "ok": false, "cancelled": true }));
        }

        let Some(st) = exit_status else {
            cleanup_ytdlp_temp_by_prefix(&vault.media_dir, &temp_prefix);
            return Err("yt-dlp process ended unexpectedly".to_string());
        };

        if !st.success() {
            let tail = stderr_tail
                .lock()
                .map(|s| s.trim().to_string())
                .unwrap_or_default();
            log::error!(
                "[yt-dlp] failed code={:?} stderr_tail={}",
                st.code(),
                tail
            );
            cleanup_ytdlp_temp_by_prefix(&vault.media_dir, &temp_prefix);
            let msg = if tail.is_empty() {
                "yt-dlp failed".to_string()
            } else {
                format!("yt-dlp failed: {}", tail)
            };
            return Err(msg);
        }
        info!("[yt-dlp] download command completed successfully");
        let _ = app.emit(
            "video-download-progress",
            serde_json::json!({ "percent": 100 }),
        );

        let files: Vec<_> = fs::read_dir(&vault.media_dir)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.path()
                    .file_stem()
                    .map(|s| s.to_string_lossy() == temp_prefix)
                    .unwrap_or(false)
            })
            .collect();

        let video_path = files
            .iter()
            .find(|e| {
                let ext = e
                    .path()
                    .extension()
                    .map(|e| e.to_string_lossy().to_lowercase())
                    .unwrap_or_default();
                matches!(
                    ext.as_str(),
                    "mp4" | "webm" | "mkv" | "mov" | "avi" | "wmv" | "m4v" | "flv"
                )
            })
            .map(|e| e.path())
            .ok_or_else(|| "Download completed but video file not found".to_string())?;

        let mut thumbnail_rel: Option<String> = None;
        if let Some(thumb_entry) = files.iter().find(|e| {
            let ext = e
                .path()
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            matches!(ext.as_str(), "jpg" | "jpeg" | "webp" | "png")
        }) {
            let thumb_src = thumb_entry.path();
            let thumb_dest = next_vault_uuid_path(&vault.thumbs_dir);
            fs::create_dir_all(&vault.thumbs_dir).ok();
            if fs::copy(&thumb_src, &thumb_dest).is_ok() {
                thumbnail_rel = Some(rel_to_vault(&vault.root, &thumb_dest));
            }
            let _ = fs::remove_file(&thumb_src);
        }

        let vault_media_path = next_vault_uuid_path(&vault.media_dir);
        fs::rename(&video_path, &vault_media_path).map_err(|e| e.to_string())?;
        let stored_rel = rel_to_vault(&vault.root, &vault_media_path);
        let vault_id = vault_media_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_string();
        let original_filename = format!(
            "video.{}",
            video_path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("mp4")
        );
        let mime_type = detect_mime_from_filename(&original_filename);
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let final_title = title
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "Downloaded video".to_string());

        let conn = db.conn();
        let aspect_ratio = get_media_aspect_ratio(&vault_media_path, "video");
        conn.execute(
            r#"INSERT INTO inspirations (id, type, title, source_url, original_filename, stored_path, thumbnail_path, display_row, aspect_ratio, created_at, updated_at, vault_id, mime_type)
               VALUES (?, 'video', ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)"#,
            rusqlite::params![
                id,
                final_title,
                url,
                original_filename,
                stored_rel,
                thumbnail_rel,
                aspect_ratio,
                ts,
                ts,
                vault_id,
                mime_type
            ],
        )
        .map_err(|e| e.to_string())?;
        add_inspiration_to_unsorted(&conn, &id)?;

        let source = if extract_youtube_video_id(&url).is_some() {
            "youtube"
        } else if url.contains("instagram.com") {
            "instagram"
        } else {
            "web"
        };
        let platform = if source == "youtube" {
            Some("youtube")
        } else if source == "instagram" {
            Some("instagram")
        } else {
            None
        };
        let _ = tags::apply_system_tags(
            &conn,
            &id,
            source,
            "video",
            aspect_ratio,
            platform,
            channel_name.as_deref(),
        );

        let stored_url = abs_path_for_webview(&vault_media_path);
        let thumb_url = thumbnail_rel
            .as_ref()
            .and_then(|r| abs_path_for_webview(&vault.root.join(r)));
        Ok(serde_json::json!({
            "ok": true,
            "inspiration": {
                "id": id,
                "type": "video",
                "title": final_title,
                "source_url": url,
                "stored_path": stored_rel,
                "stored_path_url": stored_url,
                "thumbnail_path": thumbnail_rel,
                "thumbnail_path_url": thumb_url
            }
        }))
        };
        let out = run();
        clear_video_download_session(&download_ctrl);
        out
    })
    .await
    .map_err(|e| e.to_string())?
}

fn add_inspirations_from_paths_impl(
    db: &Arc<Db>,
    vault: &Arc<VaultPaths>,
    paths: Vec<String>,
) -> Result<Vec<InspirationRow>, String> {
    let mut result = Vec::new();
    for src_str in paths {
        let src = PathBuf::from(&src_str);
        if !src.exists() {
            continue;
        }
        let media_type = match detect_media_type(&src) {
            Some(t) => t,
            None => continue,
        };
        let id = Uuid::new_v4().to_string();
        let stored_abs = next_vault_uuid_path(&vault.media_dir);
        fs::create_dir_all(&vault.media_dir).map_err(|e| e.to_string())?;
        fs::copy(&src, &stored_abs).map_err(|e| e.to_string())?;

        let stored_rel = rel_to_vault(&vault.root, &stored_abs);
        let title = src
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "Untitled".to_string());
        let orig_name = src
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let vault_id = stored_abs
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_string();
        let mime_type = detect_mime_from_filename(&orig_name);
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;

        let conn = db.conn();
        let aspect_ratio = get_media_aspect_ratio(&stored_abs, media_type);

        conn.execute(
            r#"INSERT INTO inspirations (id, type, title, source_url, original_filename, stored_path, thumbnail_path, display_row, aspect_ratio, created_at, updated_at, vault_id, mime_type)
               VALUES (?, ?, ?, NULL, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)"#,
            rusqlite::params![
                id,
                media_type,
                title,
                orig_name,
                stored_rel,
                aspect_ratio,
                ts,
                ts,
                vault_id,
                mime_type
            ],
        )
        .map_err(|e| e.to_string())?;
        add_inspiration_to_unsorted(&conn, &id)?;

        let _ = tags::apply_system_tags(
            &conn,
            &id,
            "local",
            media_type,
            aspect_ratio,
            None::<&str>,
            None,
        );

        // Palette extraction deferred to background so import returns fast (no freeze)

        let stored_url = abs_path_for_webview(&stored_abs);
        result.push(InspirationRow {
            id: id.clone(),
            r#type: media_type.to_string(),
            title: Some(title),
            source_url: None,
            original_filename: Some(orig_name),
            stored_path: Some(stored_rel),
            thumbnail_path: None,
            display_row: None,
            aspect_ratio,
            created_at: ts,
            updated_at: ts,
            vault_id: Some(vault_id),
            mime_type: Some(mime_type),
            stored_path_url: stored_url,
            thumbnail_path_url: None,
            stored_path_abs: stored_abs
                .canonicalize()
                .ok()
                .map(|p| p.to_string_lossy().to_string()),
            thumbnail_path_abs: None,
            tags: None,
            palette: None,
        });
    }
    Ok(result)
}

#[tauri::command]
pub fn add_inspirations_from_paths(
    db: State<'_, Arc<Db>>,
    vault: State<'_, Arc<VaultPaths>>,
    paths: Vec<String>,
) -> Result<Vec<InspirationRow>, String> {
    cmd_log!("add_inspirations_from_paths");
    let db = db.inner().clone();
    let vault = vault.inner().clone();
    let added = add_inspirations_from_paths_impl(&db, &vault, paths)?;
    let image_ids: Vec<String> = added
        .iter()
        .filter(|r| r.r#type == "image")
        .map(|r| r.id.clone())
        .collect();
    if !image_ids.is_empty() {
        let db_bg = db.clone();
        let vault_bg = vault.clone();
        std::thread::spawn(move || {
            for id in image_ids {
                let _ = do_extract_palette(&db_bg, &vault_bg, &id);
            }
        });
    }
    Ok(added)
}

/// Import media from filesystem paths. Entry point for drag & drop.
/// Validates extensions, copies into vault, creates inspiration records.
/// Returns { added, skipped } for UX feedback. Partial success allowed.
/// Runs in spawn_blocking to avoid freezing the app.
#[tauri::command]
pub async fn import_media_from_paths(
    db: State<'_, Arc<Db>>,
    vault: State<'_, Arc<VaultPaths>>,
    paths: Vec<String>,
) -> Result<serde_json::Value, String> {
    cmd_log!("import_media_from_paths");
    let db = db.inner().clone();
    let vault = vault.inner().clone();
    let db_bg = db.clone();
    let vault_bg = vault.clone();
    let total = paths.len();
    let added = tauri::async_runtime::spawn_blocking(move || {
        add_inspirations_from_paths_impl(&db, &vault, paths)
    })
    .await
    .map_err(|e| e.to_string())??;
    let skipped = total.saturating_sub(added.len());

    // Always extract palette for images in background (automatic for import/drag-and-drop)
    let image_ids: Vec<String> = added
        .iter()
        .filter(|r| r.r#type == "image")
        .map(|r| r.id.clone())
        .collect();
    if !image_ids.is_empty() {
        std::thread::spawn(move || {
            for id in image_ids {
                let _ = do_extract_palette(&db_bg, &vault_bg, &id);
            }
        });
    }

    Ok(serde_json::json!({
        "added": added,
        "skipped": skipped
    }))
}

#[tauri::command]
pub async fn add_inspirations_from_files(
    app: AppHandle,
    db: State<'_, Arc<Db>>,
    vault: State<'_, Arc<VaultPaths>>,
) -> Result<Vec<InspirationRow>, String> {
    cmd_log!("add_inspirations_from_files");
    let paths: Option<Vec<_>> = app
        .dialog()
        .file()
        .add_filter(
            "Media",
            &[
                "png", "jpg", "jpeg", "webp", "gif", "mp4", "mov", "mkv", "webm", "avi", "wmv",
                "m4v",
            ],
        )
        .set_title("Add inspiration files")
        .blocking_pick_files();

    let paths = match paths {
        Some(p) => p,
        None => return Ok(vec![]),
    };
    let path_strs: Vec<String> = paths
        .into_iter()
        .filter_map(|p| p.as_path().map(|path| path.to_string_lossy().to_string()))
        .collect();
    if path_strs.is_empty() {
        return Ok(vec![]);
    }

    let db = db.inner().clone();
    let vault = vault.inner().clone();

    let added = tauri::async_runtime::spawn_blocking({
        let db = db.clone();
        let vault = vault.clone();
        move || add_inspirations_from_paths_impl(&db, &vault, path_strs)
    })
    .await
    .map_err(|e| e.to_string())??;

    // Always extract palette for added images (automatic for local/add-from-files)
    let image_ids: Vec<String> = added
        .iter()
        .filter(|r| r.r#type == "image")
        .map(|r| r.id.clone())
        .collect();
    if !image_ids.is_empty() {
        let db_bg = db.clone();
        let vault_bg = vault.clone();
        std::thread::spawn(move || {
            for id in image_ids {
                let _ = do_extract_palette(&db_bg, &vault_bg, &id);
            }
        });
    }

    Ok(added)
}

/// Download thumbnail using yt-dlp (Instagram/other) or direct HTTP (YouTube).
#[tauri::command]
pub async fn add_thumbnail_from_video_url(
    app: AppHandle,
    db: State<'_, Arc<Db>>,
    vault: State<'_, Arc<VaultPaths>>,
    video_url: String,
    title: Option<String>,
) -> Result<serde_json::Value, String> {
    cmd_log!("add_thumbnail_from_video_url");
    let url = video_url.trim().to_string();
    if url.is_empty() {
        return Err("Empty URL".to_string());
    }
    let id = Uuid::new_v4().to_string();
    let thumbs_dir = vault.thumbs_dir.clone();
    let vault_root = vault.root.clone();
    fs::create_dir_all(&thumbs_dir).map_err(|e| e.to_string())?;

    // YouTube: direct HTTP fetch (fast). Return immediately after insert; run channel/tags/palette in a background thread.
    if let Some(video_id) = extract_youtube_video_id(&url) {
        let db = db.inner().clone();
        let vault = vault.inner().clone();
        let db_enrich = db.clone();
        let vault_enrich = vault.clone();
        let title_opt = title.clone();
        let url_clone = url.clone();
        let id_clone = id.clone();
        let thumbs = thumbs_dir.clone();
        let root = vault_root.clone();
        let ytdlp_path = resolve_ytdlp_path(Some(&app));

        let (response, aspect_ratio) = tauri::async_runtime::spawn_blocking(move || {
            // Try highest quality first; maxresdefault may 404 for older videos
            let thumb_urls = [
                format!("https://i.ytimg.com/vi/{}/maxresdefault.jpg", video_id),
                format!("https://i.ytimg.com/vi/{}/sddefault.jpg", video_id),
                format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", video_id),
            ];
            let dest = next_vault_uuid_path(&thumbs);
            let client = reqwest::blocking::Client::builder()
                .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36")
                .connect_timeout(std::time::Duration::from_secs(3))
                .timeout(std::time::Duration::from_secs(5))
                .redirect(reqwest::redirect::Policy::limited(3))
                .build()
                .map_err(|e| e.to_string())?;
            for thumb_url in &thumb_urls {
                if let Ok(resp) = client.get(thumb_url).send() {
                    if resp.status().is_success() {
                        if let Ok(bytes) = resp.bytes() {
                            if fs::write(&dest, &bytes).is_ok() {
                                let stored_rel = rel_to_vault(&root, &dest);
                                let aspect_ratio = get_media_aspect_ratio(&dest, "image");
                                let final_title = title_opt
                                    .as_ref()
                                    .filter(|s| !s.trim().is_empty())
                                    .map(|s| s.as_str())
                                    .unwrap_or("Thumbnail");
                                let ts = std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .unwrap()
                                    .as_millis() as i64;
                                let conn = db.conn();
                                let vault_id = dest
                                    .file_name()
                                    .and_then(|n| n.to_str())
                                    .unwrap_or_default()
                                    .to_string();
                                conn.execute(
                                    r#"INSERT INTO inspirations (id, type, title, source_url, original_filename, stored_path, thumbnail_path, display_row, aspect_ratio, created_at, updated_at, vault_id, mime_type)
                                       VALUES (?, 'image', ?, ?, 'thumbnail.jpg', ?, NULL, NULL, ?, ?, ?, ?, ?)"#,
                                    rusqlite::params![
                                        id_clone,
                                        final_title,
                                        url_clone,
                                        stored_rel,
                                        aspect_ratio,
                                        ts,
                                        ts,
                                        vault_id,
                                        "image/jpeg"
                                    ],
                                )
                                .map_err(|e| e.to_string())?;
                                add_inspiration_to_unsorted(&conn, &id_clone)?;
                                let stored_url = abs_path_for_webview(&dest);
                                let response = serde_json::json!({
                                    "id": id_clone,
                                    "type": "image",
                                    "title": final_title,
                                    "stored_path": stored_rel,
                                    "stored_path_url": stored_url,
                                    "thumbnail_path_url": stored_url
                                });
                                return Ok::<_, String>((response, aspect_ratio));
                            }
                        }
                    }
                }
            }
            Err("Could not fetch YouTube thumbnail".to_string())
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e)?;

        // Enrichment in a separate OS thread so we don't block the async runtime or tie up the blocking pool
        let id_enrich = id.clone();
        let url_enrich = url.clone();
        std::thread::spawn(move || {
            let channel = ytdlp_path
                .as_ref()
                .and_then(|p| fetch_youtube_channel(p, &url_enrich));
            let conn = db_enrich.conn();
            let _ = tags::apply_system_tags(
                &conn,
                &id_enrich,
                "youtube",
                "image",
                aspect_ratio,
                None::<&str>,
                channel.as_deref(),
            );
            let _ = do_extract_palette(&db_enrich, &vault_enrich, &id_enrich);
        });

        return Ok(response);
    }

    // Instagram/other: yt-dlp with timeouts
    let output_template = thumbs_dir.join(format!("{}.%(ext)s", id));
    let output_str = output_template.to_string_lossy().replace('\\', "/");

    let ytdlp_path = resolve_ytdlp_path(Some(&app)).unwrap_or_else(|| {
        PathBuf::from(if cfg!(target_os = "windows") {
            "yt-dlp.exe"
        } else {
            "yt-dlp"
        })
    });
    info!("[yt-dlp] thumbnail binary path={}", ytdlp_path.display());
    ensure_executable(&ytdlp_path);

    let output = {
        let ytdlp_path = ytdlp_path.clone();
        let url_clone = url.clone();
        let output_str_clone = output_str.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let mut cmd = Command::new(&ytdlp_path);
            suppress_console_window(&mut cmd);
            cmd.args([
                "-o",
                &output_str_clone,
                "--no-check-certificates",
                "--no-warnings",
                "--no-playlist",
                "--skip-download",
                "--write-thumbnail",
                "--socket-timeout",
                "8",
                "--retries",
                "1",
                "--extractor-retries",
                "1",
                &url_clone,
            ])
            .output()
            .map_err(|e| {
                log::error!(
                    "[yt-dlp] thumbnail spawn failed path={} err={}",
                    ytdlp_path.display(),
                    e
                );
                e.to_string()
            })
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e)?
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        log::error!(
            "[yt-dlp] thumbnail failed code={:?} stderr={}",
            output.status.code(),
            stderr.trim()
        );
        return Err(format!("yt-dlp failed: {}", stderr.trim()));
    }

    let db_non_yt = db.inner().clone();
    let thumbs_dir_non_yt = thumbs_dir.clone();
    let vault_root_non_yt = vault_root.clone();
    let id_non_yt = id.clone();
    let url_non_yt = url.clone();
    let title_non_yt = title.clone();
    let source = if url.contains("youtube.com") || url.contains("youtu.be") {
        "youtube"
    } else if url.contains("instagram.com") {
        "instagram"
    } else {
        "web"
    };
    let source_non_yt = source.to_string();

    let (response, stored_rel) = tauri::async_runtime::spawn_blocking(move || -> Result<(serde_json::Value, String), String> {
        let thumb_file = fs::read_dir(&thumbs_dir_non_yt)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok())
            .find(|e| {
                e.path()
                    .file_stem()
                    .map(|s| s.to_string_lossy() == id_non_yt)
                    .unwrap_or(false)
                    && e.path()
                        .extension()
                        .map(|e| {
                            let ext = e.to_string_lossy().to_lowercase();
                            matches!(ext.as_str(), "jpg" | "jpeg" | "webp" | "png")
                        })
                        .unwrap_or(false)
            })
            .map(|e| e.path())
            .ok_or_else(|| "Thumbnail not found after download".to_string())?;

        let vault_thumb_path = next_vault_uuid_path(&thumbs_dir_non_yt);
        fs::rename(&thumb_file, &vault_thumb_path).map_err(|e| e.to_string())?;
        let stored_rel = rel_to_vault(&vault_root_non_yt, &vault_thumb_path);
        let vault_id = vault_thumb_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_string();

        let final_title = title_non_yt
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "Thumbnail".to_string());
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;

        let conn = db_non_yt.conn();
        // Insert with aspect_ratio = None so we don't block with image::open(); background thread will set it
        conn.execute(
            r#"INSERT INTO inspirations (id, type, title, source_url, original_filename, stored_path, thumbnail_path, display_row, aspect_ratio, created_at, updated_at, vault_id, mime_type)
               VALUES (?, 'image', ?, ?, 'thumbnail.jpg', ?, NULL, NULL, ?, ?, ?, ?, ?)"#,
            rusqlite::params![
                id_non_yt,
                final_title,
                url_non_yt,
                stored_rel,
                None::<f64>,
                ts,
                ts,
                vault_id,
                "image/jpeg"
            ],
        )
        .map_err(|e| e.to_string())?;
        add_inspiration_to_unsorted(&conn, &id_non_yt)?;

        let stored_url = abs_path_for_webview(&vault_thumb_path);
        let response = serde_json::json!({
            "id": id_non_yt,
            "type": "image",
            "title": final_title,
            "stored_path": stored_rel,
            "stored_path_url": stored_url,
            "thumbnail_path_url": stored_url
        });
        Ok((response, stored_rel))
    })
    .await
    .map_err(|e| e.to_string())??;

    let db_enrich = db.inner().clone();
    let vault_enrich = vault.inner().clone();
    let id_enrich = id.clone();
    let url_enrich = url.clone();
    let ytdlp_enrich = ytdlp_path.clone();
    let source_enrich = source_non_yt;
    let stored_rel_enrich = stored_rel;
    // Use a separate OS thread so we don't block the async runtime or exhaust the blocking pool
    std::thread::spawn(move || {
        let path = vault_enrich.root.join(&stored_rel_enrich);
        let aspect_ratio = get_media_aspect_ratio(&path, "image");
        if let Some(ar) = aspect_ratio {
            let conn = db_enrich.conn();
            let _ = conn.execute(
                "UPDATE inspirations SET aspect_ratio = ? WHERE id = ?",
                rusqlite::params![ar, id_enrich],
            );
        }
        let channel = fetch_youtube_channel(&ytdlp_enrich, &url_enrich);
        let conn = db_enrich.conn();
        let _ = tags::apply_system_tags(
            &conn,
            &id_enrich,
            &source_enrich,
            "image",
            aspect_ratio,
            None::<&str>,
            channel.as_deref(),
        );
        let _ = do_extract_palette(&db_enrich, &vault_enrich, &id_enrich);
    });

    Ok(response)
}

#[derive(Deserialize)]
pub struct AddThumbnailPayload {
    #[serde(alias = "thumbnailUrl")]
    pub thumbnail_url: String,
    pub title: Option<String>,
}

#[tauri::command]
pub async fn add_thumbnail_from_url(
    db: State<'_, Arc<Db>>,
    vault: State<'_, Arc<VaultPaths>>,
    payload: AddThumbnailPayload,
) -> Result<serde_json::Value, String> {
    cmd_log!("add_thumbnail_from_url");
    let url = normalize_required_http_url(&payload.thumbnail_url)?;
    let title = payload.title.clone();
    let db = db.inner().clone();
    let vault = vault.inner().clone();
    let db_palette = db.clone();
    let vault_palette = vault.clone();

    let response = tauri::async_runtime::spawn_blocking(move || {
        {
            let conn = db.conn();
            if let Ok(existing_id) = conn.query_row(
                "SELECT id FROM inspirations WHERE source_url = ?1",
                [&url],
                |r| r.get::<_, String>(0),
            ) {
                return Ok::<_, String>((
                    serde_json::json!({ "id": existing_id, "duplicate": true }),
                    existing_id,
                ));
            }
        }

        let id = Uuid::new_v4().to_string();
        let dest = next_vault_uuid_path(&vault.media_dir);
        fs::create_dir_all(&vault.media_dir).map_err(|e| e.to_string())?;

        let client = reqwest::blocking::Client::builder()
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36")
            .connect_timeout(std::time::Duration::from_secs(5))
            .timeout(std::time::Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
            .map_err(|e| {
                log::error!("[HTTP][thumbnail] client build failed url={} err={}", url, e);
                e.to_string()
            })?;
        let mut req = client.get(&url);
        if url.contains("pinimg.com") || url.contains("pinterest.com") {
            req = req.header("Referer", "https://www.pinterest.com/");
        }
        let resp = req.send().map_err(|e| {
            log::error!("[HTTP][thumbnail] request failed url={} err={}", url, e);
            e.to_string()
        })?;
        if !resp.status().is_success() {
            log::error!(
                "[HTTP][thumbnail] download failed url={} status={}",
                url,
                resp.status()
            );
            return Err(format!("Download failed: {}", resp.status()));
        }
        let bytes = resp.bytes().map_err(|e| {
            log::error!("[HTTP][thumbnail] body read failed url={} err={}", url, e);
            e.to_string()
        })?;
        fs::write(&dest, &bytes).map_err(|e| e.to_string())?;

        let stored_rel = rel_to_vault(&vault.root, &dest);
        let aspect_ratio = get_media_aspect_ratio(&dest, "image");
        let final_title = title
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "Thumbnail".to_string());
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;

        let conn = db.conn();
        let vault_id = dest
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_string();
        conn.execute(
            r#"INSERT INTO inspirations (id, type, title, source_url, original_filename, stored_path, thumbnail_path, display_row, aspect_ratio, created_at, updated_at, vault_id, mime_type)
               VALUES (?, 'image', ?, ?, 'thumbnail.jpg', ?, NULL, NULL, ?, ?, ?, ?, ?)"#,
            rusqlite::params![
                id,
                final_title,
                url,
                stored_rel,
                aspect_ratio,
                ts,
                ts,
                vault_id,
                "image/jpeg"
            ],
        )
        .map_err(|e| e.to_string())?;
        add_inspiration_to_unsorted(&conn, &id)?;

        let source = if url.contains("youtube.com") || url.contains("ytimg.com") {
            "youtube"
        } else if url.contains("instagram.com") || url.contains("cdninstagram.com") {
            "instagram"
        } else if url.contains("notion") || url.contains("amazonaws.com") {
            "notion"
        } else {
            "web"
        };
        let _ = tags::apply_system_tags(&conn, &id, source, "image", aspect_ratio, None::<&str>, None);

        let stored_url = abs_path_for_webview(&dest);
        Ok::<_, String>((
            serde_json::json!({
                "id": id,
                "type": "image",
                "title": final_title,
                "stored_path": stored_rel,
                "stored_path_url": stored_url,
                "thumbnail_path_url": stored_url
            }),
            id,
        ))
    })
    .await
    .map_err(|e| e.to_string())??;

    let (response, id) = response;
    let is_duplicate = response
        .get("duplicate")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !is_duplicate {
        std::thread::spawn(move || {
            let _ = do_extract_palette(&db_palette, &vault_palette, &id);
        });
    }
    Ok(response)
}

#[derive(Deserialize)]
pub struct AddRemoteMediaPayload {
    pub url: String,
    pub title: Option<String>,
}

#[tauri::command]
pub async fn add_media_from_url(
    db: State<'_, Arc<Db>>,
    vault: State<'_, Arc<VaultPaths>>,
    payload: AddRemoteMediaPayload,
) -> Result<serde_json::Value, String> {
    cmd_log!("add_media_from_url");
    let url = normalize_required_http_url(&payload.url)?;
    let title = payload.title.clone();
    let db = db.inner().clone();
    let vault = vault.inner().clone();
    let db_palette = db.clone();
    let vault_palette = vault.clone();

    let response = tauri::async_runtime::spawn_blocking(move || {
        let conn = db.conn();
        if let Ok(existing_id) =
            conn.query_row("SELECT id, type FROM inspirations WHERE source_url = ?1", [&url], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
        {
            let (id, media_type) = existing_id;
            return Ok::<_, String>((
                serde_json::json!({ "id": id, "duplicate": true, "type": media_type }),
                id,
            ));
        }

        let client = reqwest::blocking::Client::builder()
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36")
            .connect_timeout(std::time::Duration::from_secs(4))
            .timeout(std::time::Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
            .map_err(|e| {
                log::error!("[HTTP][media] client build failed url={} err={}", url, e);
                e.to_string()
            })?;
        let resp = client.get(&url).send().map_err(|e| {
            log::error!("[HTTP][media] request failed url={} err={}", url, e);
            e.to_string()
        })?;
        if !resp.status().is_success() {
            log::error!(
                "[HTTP][media] download failed url={} status={}",
                url,
                resp.status()
            );
            return Err(format!("Download failed: {}", resp.status()));
        }
        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_lowercase();
        let bytes = resp.bytes().map_err(|e| {
            log::error!("[HTTP][media] body read failed url={} err={}", url, e);
            e.to_string()
        })?;

        let lower_url = url.to_lowercase();
        let media_type = if content_type.starts_with("video/")
            || lower_url.ends_with(".mp4")
            || lower_url.ends_with(".mov")
            || lower_url.ends_with(".webm")
            || lower_url.ends_with(".mkv")
        {
            "video"
        } else if content_type.starts_with("image/")
            || lower_url.ends_with(".png")
            || lower_url.ends_with(".jpg")
            || lower_url.ends_with(".jpeg")
            || lower_url.ends_with(".gif")
            || lower_url.ends_with(".webp")
            || lower_url.ends_with(".svg")
        {
            "image"
        } else {
            "link"
        };

        let id = Uuid::new_v4().to_string();
        let ext = if media_type == "video" {
            if lower_url.ends_with(".webm") { "webm" }
            else if lower_url.ends_with(".mov") { "mov" }
            else if lower_url.ends_with(".mkv") { "mkv" }
            else { "mp4" }
        } else if media_type == "image" && lower_url.ends_with(".png") {
            "png"
        } else if media_type == "image" && lower_url.ends_with(".gif") {
            "gif"
        } else if media_type == "image" && lower_url.ends_with(".webp") {
            "webp"
        } else if media_type == "image" && lower_url.ends_with(".svg") {
            "svg"
        } else if content_type.contains("pdf") || lower_url.ends_with(".pdf") {
            "pdf"
        } else if content_type.contains("audio/mpeg") || lower_url.ends_with(".mp3") {
            "mp3"
        } else if content_type.contains("audio/wav") || lower_url.ends_with(".wav") {
            "wav"
        } else if content_type.contains("audio/ogg") || lower_url.ends_with(".ogg") {
            "ogg"
        } else {
            if media_type == "image" { "jpg" } else { "bin" }
        };

        let dest = next_vault_uuid_path(&vault.media_dir);
        fs::create_dir_all(&vault.media_dir).map_err(|e| e.to_string())?;
        fs::write(&dest, &bytes).map_err(|e| e.to_string())?;

        let stored_rel = rel_to_vault(&vault.root, &dest);
        let vault_id = dest
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_string();
        let original_filename = format!("downloaded.{}", ext);
        let mime_type = if content_type.is_empty() {
            detect_mime_from_filename(&original_filename)
        } else {
            content_type.clone()
        };
        let aspect_ratio = get_media_aspect_ratio(&dest, media_type);
        let final_title = title
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "Notion item".to_string());
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;

        let conn = db.conn();
        conn.execute(
            r#"INSERT INTO inspirations (id, type, title, source_url, original_filename, stored_path, thumbnail_path, display_row, aspect_ratio, created_at, updated_at, vault_id, mime_type)
               VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)"#,
            rusqlite::params![
                id,
                media_type,
                final_title,
                url,
                original_filename,
                stored_rel,
                aspect_ratio,
                ts,
                ts,
                vault_id,
                mime_type
            ],
        )
        .map_err(|e| e.to_string())?;
        add_inspiration_to_unsorted(&conn, &id)?;

        let source = if url.contains("notion") || url.contains("amazonaws.com") {
            "notion"
        } else {
            "web"
        };
        let _ = tags::apply_system_tags(&conn, &id, source, media_type, aspect_ratio, None::<&str>, None);

        let stored_url = abs_path_for_webview(&dest);
        let thumbnail_url = if media_type == "image" { stored_url.clone() } else { None };
        Ok::<_, String>((
            serde_json::json!({
                "id": id,
                "type": media_type,
                "title": final_title,
                "stored_path": stored_rel,
                "stored_path_url": stored_url,
                "thumbnail_path_url": thumbnail_url
            }),
            id,
        ))
    })
    .await
    .map_err(|e| e.to_string())??;

    let (response, id) = response;
    let is_duplicate = response
        .get("duplicate")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let media_type = response.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if !is_duplicate && media_type == "image" {
        std::thread::spawn(move || {
            let _ = do_extract_palette(&db_palette, &vault_palette, &id);
        });
    }
    Ok(response)
}

// ---- Tag commands ----

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopTagRow {
    pub id: String,
    pub label: String,
    pub usage_count: i64,
}

#[derive(Clone)]
struct QueuedFeedbackJob {
    id: String,
    message: String,
    image_path: Option<String>,
    timestamp_iso: Option<String>,
    attempts: u32,
}

/// Global runtime state for serialized feedback delivery queue.
#[derive(Clone)]
pub struct FeedbackQueueState {
    worker_running: Arc<AtomicBool>,
}

impl FeedbackQueueState {
    pub fn new() -> Self {
        Self {
            worker_running: Arc::new(AtomicBool::new(false)),
        }
    }
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SubmitFeedbackPayload {
    pub message: String,
    pub image_data_url: Option<String>,
    pub timestamp_iso: Option<String>,
}

const TELEGRAM_BOT_TOKEN: &str = "8783240003:AAGYfMTDjzo8nJ6xGMqBVWbI557ab3LZxpA";
const TELEGRAM_CHAT_ID: &str = "911682360";
const FEEDBACK_LOG_LINES_LIMIT: usize = 300;
static APP_LOG_DIR_OVERRIDE: OnceLock<PathBuf> = OnceLock::new();

pub fn configure_app_log_dir(path: PathBuf) {
    if path.as_os_str().is_empty() {
        return;
    }
    let _ = APP_LOG_DIR_OVERRIDE.set(path);
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn parse_image_data_url(data_url: &str) -> Result<(Vec<u8>, String, String), String> {
    let trimmed = data_url.trim();
    if !trimmed.starts_with("data:") {
        return Err("Unsupported image format".to_string());
    }
    let Some(comma_idx) = trimmed.find(',') else {
        return Err("Invalid image payload".to_string());
    };
    let head = &trimmed[..comma_idx];
    let b64 = &trimmed[comma_idx + 1..];
    if !head.ends_with(";base64") {
        return Err("Only base64 image payloads are supported".to_string());
    }
    let mime = head
        .trim_start_matches("data:")
        .trim_end_matches(";base64")
        .to_lowercase();
    let (ext, mime_ok) = match mime.as_str() {
        "image/png" => ("png", true),
        "image/jpeg" | "image/jpg" => ("jpg", true),
        "image/webp" => ("webp", true),
        _ => ("bin", false),
    };
    if !mime_ok {
        return Err("Only PNG/JPG/WEBP screenshots are supported".to_string());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|_| "Failed to decode screenshot".to_string())?;
    if bytes.is_empty() {
        return Err("Attached screenshot is empty".to_string());
    }
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("Attached screenshot is too large (max 8MB)".to_string());
    }
    let filename = format!("feedback_screenshot.{}", ext);
    Ok((bytes, mime, filename))
}

fn feedback_screenshot_dir() -> PathBuf {
    if let Some(pictures) = dirs::picture_dir() {
        return pictures.join("qooti");
    }
    if let Ok(user_profile) = env::var("USERPROFILE") {
        return PathBuf::from(user_profile).join("Pictures").join("qooti");
    }
    if let Ok(home) = env::var("HOME") {
        return PathBuf::from(home).join("Pictures").join("qooti");
    }
    PathBuf::from("qooti-feedback")
}

fn store_feedback_screenshot(bytes: &[u8], filename: &str) -> Result<String, String> {
    let ext = Path::new(filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png");
    let dir = feedback_screenshot_dir();
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create screenshot directory: {}", e))?;
    let safe_name = format!("feedback_{}_{}.{}", now_ms(), Uuid::new_v4(), ext);
    let path = dir.join(safe_name);
    fs::write(&path, bytes).map_err(|e| format!("Could not save screenshot: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

fn resolve_telegram_chat_id(client: &reqwest::blocking::Client) -> Result<String, String> {
    if !TELEGRAM_CHAT_ID.trim().is_empty() {
        return Ok(TELEGRAM_CHAT_ID.trim().to_string());
    }
    let url = format!(
        "https://api.telegram.org/bot{}/getUpdates",
        TELEGRAM_BOT_TOKEN
    );
    let resp = client
        .get(url)
        .send()
        .map_err(|e| format!("Telegram getUpdates failed: {}", e))?;
    let payload: serde_json::Value = resp
        .json()
        .map_err(|e| format!("Failed to parse Telegram getUpdates response: {}", e))?;
    if payload.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        let desc = payload
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown error");
        return Err(format!("Telegram getUpdates error: {}", desc));
    }
    let Some(result) = payload.get("result").and_then(|v| v.as_array()) else {
        return Err("No Telegram updates found. Send a message to your bot first.".to_string());
    };
    for update in result.iter().rev() {
        if let Some(chat_id) = update
            .get("message")
            .and_then(|m| m.get("chat"))
            .and_then(|c| c.get("id"))
            .and_then(|id| id.as_i64())
        {
            return Ok(chat_id.to_string());
        }
        if let Some(chat_id) = update
            .get("channel_post")
            .and_then(|m| m.get("chat"))
            .and_then(|c| c.get("id"))
            .and_then(|id| id.as_i64())
        {
            return Ok(chat_id.to_string());
        }
    }
    Err("No chat ID found. Start a conversation with the bot first.".to_string())
}

/// Sends profile + survey results to admin Telegram with #newuser. Errors are logged only; never fail the caller.
fn send_new_user_telegram_notification(db: Arc<Db>) {
    let res = (|| -> Result<(), String> {
        let conn = db.conn();
        let profile_name: String = conn
            .query_row(
                "SELECT value FROM preferences WHERE key = 'profileName'",
                [],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or_else(|| "—".to_string());
        let survey = conn
            .query_row(
                "SELECT creative_role, creative_role_detail, primary_use_case, inspiration_method, discovery_source, discovery_source_detail, creative_level FROM user_survey_data WHERE id = 1",
                [],
                |r| {
                    Ok((
                        r.get::<_, Option<String>>(0)?,
                        r.get::<_, Option<String>>(1)?,
                        r.get::<_, Option<String>>(2)?,
                        r.get::<_, Option<String>>(3)?,
                        r.get::<_, Option<String>>(4)?,
                        r.get::<_, Option<String>>(5)?,
                        r.get::<_, Option<String>>(6)?,
                    ))
                },
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let (creative_role, creative_role_detail, primary_use_case, inspiration_method, discovery_source, discovery_source_detail, creative_level) = match survey {
            Some(s) => s,
            None => return Err("No survey data".to_string()),
        };
        let opt = |v: Option<String>| v.unwrap_or_else(|| "—".to_string());
        let name_display = profile_name.trim();
        let name_display = if name_display.is_empty() { "—" } else { name_display };
        let body = format!(
            "#newuser\n\n\
👤 Profile\n\
Username: {}\n\n\
📋 Survey\n\
Creative role: {}\n\
Role detail: {}\n\
Primary use case: {}\n\
Inspiration method: {}\n\
Discovery source: {}\n\
Discovery detail: {}\n\
Creative level: {}",
            name_display,
            opt(creative_role),
            opt(creative_role_detail),
            opt(primary_use_case),
            opt(inspiration_method),
            opt(discovery_source),
            opt(discovery_source_detail),
            opt(creative_level),
        );
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|e| format!("HTTP client: {}", e))?;
        let chat_id = resolve_telegram_chat_id(&client)?;
        let url = format!(
            "https://api.telegram.org/bot{}/sendMessage",
            TELEGRAM_BOT_TOKEN
        );
        let params = [
            ("chat_id", chat_id),
            ("text", body),
            ("disable_web_page_preview", "true".to_string()),
        ];
        let resp = client
            .post(&url)
            .form(&params)
            .send()
            .map_err(|e| format!("Telegram send failed: {}", e))?;
        let json: serde_json::Value = resp
            .json()
            .map_err(|e| format!("Telegram response parse: {}", e))?;
        if json.get("ok").and_then(|v| v.as_bool()) != Some(true) {
            let desc = json
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            return Err(format!("Telegram API: {}", desc));
        }
        Ok(())
    })();
    if let Err(e) = res {
        log::warn!("[qooti] new user Telegram notification failed: {}", e);
    }
}

fn sanitize_filename_part(input: &str, fallback: &str) -> String {
    let mut out = String::new();
    for ch in input.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            out.push(ch);
        } else if ch.is_whitespace() {
            out.push('_');
        }
    }
    let compact = out.trim_matches('_').to_string();
    if compact.is_empty() {
        fallback.to_string()
    } else {
        compact
    }
}

fn filename_date_from_iso(ts: Option<&str>) -> String {
    if let Some(s) = ts {
        let t = s.trim();
        if t.len() >= 10 {
            let d = &t[..10];
            if d.chars().enumerate().all(|(i, c)| match i {
                4 | 7 => c == '-',
                _ => c.is_ascii_digit(),
            }) {
                return d.to_string();
            }
        }
    }
    "unknown-date".to_string()
}

fn append_recent_lines(buf: &mut Vec<String>, text: &str, max_lines: usize) {
    if max_lines == 0 {
        return;
    }
    for line in text.lines().rev() {
        if buf.len() >= max_lines {
            break;
        }
        buf.push(line.to_string());
    }
}

fn preferred_app_log_dir() -> Option<PathBuf> {
    if let Some(path) = APP_LOG_DIR_OVERRIDE.get() {
        return Some(path.clone());
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = dirs::home_dir() {
            return Some(home.join("Library").join("Logs").join("com.qooti.desktop"));
        }
    }
    dirs::data_local_dir().map(|root| root.join("com.qooti.desktop").join("logs"))
}

fn find_candidate_log_files() -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut dirs = Vec::new();
    if let Some(dir) = preferred_app_log_dir() {
        dirs.push(dir);
    }
    for env_key in ["APPDATA", "LOCALAPPDATA"] {
        if let Ok(root) = std::env::var(env_key) {
            let root = PathBuf::from(root);
            dirs.push(root.join("qooti").join("logs"));
            dirs.push(root.join("com.qooti.desktop").join("logs"));
            dirs.push(root.join("qooti"));
            dirs.push(root.join("com.qooti.desktop"));
        }
    }
    if let Some(local) = dirs::data_local_dir() {
        dirs.push(local.join("qooti").join("logs"));
        dirs.push(local.join("com.qooti.desktop").join("logs"));
        dirs.push(local.join("qooti"));
        dirs.push(local.join("com.qooti.desktop"));
    }
    #[cfg(target_os = "macos")]
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join("Library").join("Logs").join("com.qooti.desktop"));
    }
    let mut seen = HashSet::new();
    dirs.retain(|dir| seen.insert(dir.clone()));
    for dir in dirs {
        if !dir.exists() {
            continue;
        }
        if let Ok(read_dir) = std::fs::read_dir(&dir) {
            for entry in read_dir.flatten() {
                let p = entry.path();
                if p.is_file() {
                    let ext = p
                        .extension()
                        .and_then(|e| e.to_str())
                        .unwrap_or("")
                        .to_ascii_lowercase();
                    if ext == "log" || ext == "txt" {
                        files.push(p);
                    }
                }
            }
        }
    }
    files.sort_by_key(|p| {
        std::fs::metadata(p)
            .and_then(|m| m.modified())
            .ok()
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
    });
    files.reverse();
    files
}

fn build_feedback_log_attachment(job: &QueuedFeedbackJob, username: &str) -> (String, Vec<u8>) {
    let safe_username = sanitize_filename_part(username, "user");
    let mut lines: Vec<String> = Vec::new();
    lines.push("Qooti feedback diagnostics".to_string());
    lines.push(format!("queue_job_id={}", job.id));
    lines.push(format!("attempt={}", job.attempts));
    lines.push(format!("created_at_ms={}", feedback_now_ms()));
    lines.push("".to_string());
    lines.push("=== Recent app logs ===".to_string());

    let candidates = find_candidate_log_files();
    if candidates.is_empty() {
        lines.push("No log files found in known app directories.".to_string());
    } else {
        let mut collected_rev: Vec<String> = Vec::new();
        for path in candidates.iter().take(4) {
            let content = std::fs::read_to_string(path).unwrap_or_default();
            if !content.is_empty() {
                append_recent_lines(&mut collected_rev, &content, FEEDBACK_LOG_LINES_LIMIT);
                collected_rev.push(format!("--- source: {} ---", path.display()));
            }
            if collected_rev.len() >= FEEDBACK_LOG_LINES_LIMIT {
                break;
            }
        }
        if collected_rev.is_empty() {
            lines.push(
                "Log files were found but no readable text content was available.".to_string(),
            );
        } else {
            collected_rev.reverse();
            lines.extend(collected_rev);
        }
    }

    lines.push("".to_string());
    lines.push("=== Feedback payload snapshot ===".to_string());
    lines.push(format!(
        "timestamp_iso={}",
        job.timestamp_iso.as_deref().unwrap_or("n/a").trim()
    ));
    lines.push(format!(
        "has_image={}",
        job.image_path
            .as_ref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
    ));
    lines.push(format!("message_len={}", job.message.chars().count()));

    let date_part = filename_date_from_iso(job.timestamp_iso.as_deref());
    let filename = format!("{}_{}.txt", safe_username, date_part);
    (filename, lines.join("\n").into_bytes())
}

fn send_telegram_feedback(db: Arc<Db>, job: &QueuedFeedbackJob) -> Result<(), String> {
    let conn = db.conn();
    let username: String = conn
        .query_row(
            "SELECT value FROM preferences WHERE key = 'profileName'",
            [],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| "User".to_string());
    let license_key: String = conn
        .query_row(
            "SELECT license_key FROM license_cache WHERE id = 1",
            [],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| "N/A".to_string());
    let counts = conn
        .query_row(
            "SELECT (SELECT COUNT(*) FROM inspirations), (SELECT COUNT(*) FROM collections)",
            [],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
        )
        .map_err(|e| e.to_string())?;

    let ts = job
        .timestamp_iso
        .clone()
        .unwrap_or_else(|| format!("{}", feedback_now_ms()));
    let app_version = env!("CARGO_PKG_VERSION");
    let os = std::env::consts::OS;
    let msg = job.message.trim();

    let mut body = format!(
        "🆕 New Qooti Feedback\n\n\
👤 Username: {}\n\
🔑 License: {}\n\
🖥 OS: {}\n\
📦 App Version: {}\n\n\
🕒 Time:\n{}\n\n\
📊 Library Stats\n\
Media count: {}\n\
Collections: {}\n\n\
💬 Message:\n{}",
        username, license_key, os, app_version, ts, counts.0, counts.1, msg
    );
    if body.len() > 3900 {
        body.truncate(3900);
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|e| format!("Failed to initialize feedback client: {}", e))?;
    let chat_id = resolve_telegram_chat_id(&client)?;

    if let Some(image_path) = job.image_path.as_ref().filter(|v| !v.trim().is_empty()) {
        let path = PathBuf::from(image_path);
        let bytes = fs::read(&path)
            .map_err(|e| format!("Failed to read screenshot file '{}': {}", image_path, e))?;
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let mime = match ext.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "webp" => "image/webp",
            _ => "application/octet-stream",
        };
        let filename = path
            .file_name()
            .and_then(|f| f.to_str())
            .unwrap_or("feedback_screenshot.png")
            .to_string();
        let url = format!(
            "https://api.telegram.org/bot{}/sendPhoto",
            TELEGRAM_BOT_TOKEN
        );
        let part = reqwest::blocking::multipart::Part::bytes(bytes)
            .file_name(filename)
            .mime_str(&mime)
            .map_err(|e| format!("Invalid screenshot mime type: {}", e))?;
        let form = reqwest::blocking::multipart::Form::new()
            .text("chat_id", chat_id.clone())
            .text("caption", body.chars().take(1000).collect::<String>())
            .part("photo", part);
        let resp = client
            .post(url)
            .multipart(form)
            .send()
            .map_err(|e| format!("Failed to send feedback screenshot: {}", e))?;
        let json: serde_json::Value = resp
            .json()
            .map_err(|e| format!("Invalid Telegram response: {}", e))?;
        if json.get("ok").and_then(|v| v.as_bool()) != Some(true) {
            let desc = json
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown error");
            return Err(format!("Telegram sendPhoto failed: {}", desc));
        }
    } else {
        let url = format!(
            "https://api.telegram.org/bot{}/sendMessage",
            TELEGRAM_BOT_TOKEN
        );
        let params = [
            ("chat_id", chat_id.clone()),
            ("text", body),
            ("disable_web_page_preview", "true".to_string()),
        ];
        let resp = client
            .post(url)
            .form(&params)
            .send()
            .map_err(|e| format!("Failed to send feedback: {}", e))?;
        let json: serde_json::Value = resp
            .json()
            .map_err(|e| format!("Invalid Telegram response: {}", e))?;
        if json.get("ok").and_then(|v| v.as_bool()) != Some(true) {
            let desc = json
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown error");
            return Err(format!("Telegram sendMessage failed: {}", desc));
        }
    }

    let (log_filename, log_bytes) = build_feedback_log_attachment(job, &username);
    let doc_url = format!(
        "https://api.telegram.org/bot{}/sendDocument",
        TELEGRAM_BOT_TOKEN
    );
    let log_part = reqwest::blocking::multipart::Part::bytes(log_bytes)
        .file_name(log_filename)
        .mime_str("text/plain; charset=utf-8")
        .map_err(|e| format!("Invalid log mime type: {}", e))?;
    let form = reqwest::blocking::multipart::Form::new()
        .text("chat_id", chat_id)
        .text("caption", "📎 Attached diagnostic logs")
        .part("document", log_part);
    let resp = client
        .post(doc_url)
        .multipart(form)
        .send()
        .map_err(|e| format!("Failed to send feedback logs: {}", e))?;
    let json: serde_json::Value = resp
        .json()
        .map_err(|e| format!("Invalid Telegram response: {}", e))?;
    if json.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        let desc = json
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown error");
        return Err(format!("Telegram sendDocument failed: {}", desc));
    }
    Ok(())
}

fn fetch_next_feedback_job(db: &Arc<Db>, now: i64) -> Result<Option<QueuedFeedbackJob>, String> {
    let conn = db.conn();
    conn.query_row(
        "SELECT id, message, image_path, timestamp_iso, attempts
         FROM feedback_outbox
         WHERE next_attempt_at <= ?
         ORDER BY created_at ASC
         LIMIT 1",
        rusqlite::params![now],
        |r| {
            Ok(QueuedFeedbackJob {
                id: r.get(0)?,
                message: r.get(1)?,
                image_path: r.get(2)?,
                timestamp_iso: r.get(3)?,
                attempts: r.get::<_, i64>(4)? as u32,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

fn has_feedback_jobs(db: &Arc<Db>) -> bool {
    let conn = db.conn();
    conn.query_row("SELECT COUNT(*) FROM feedback_outbox", [], |r| r.get::<_, i64>(0))
        .map(|count| count > 0)
        .unwrap_or(false)
}

fn mark_feedback_job_failed(db: &Arc<Db>, job: &QueuedFeedbackJob, err: &str) {
    let next_attempts = job.attempts.saturating_add(1);
    let pow = std::cmp::min(next_attempts, 6);
    let backoff_sec = 5_i64 * (1_i64 << pow);
    let next_attempt_at = now_ms() + std::cmp::min(backoff_sec, 300) * 1000;
    let conn = db.conn();
    let _ = conn.execute(
        "UPDATE feedback_outbox
         SET attempts = ?, next_attempt_at = ?, last_error = ?
         WHERE id = ?",
        rusqlite::params![next_attempts as i64, next_attempt_at, err, job.id],
    );
}

fn delete_feedback_job(db: &Arc<Db>, job: &QueuedFeedbackJob) {
    let conn = db.conn();
    let _ = conn.execute("DELETE FROM feedback_outbox WHERE id = ?", [job.id.as_str()]);
    if let Some(path) = job.image_path.as_ref().filter(|p| !p.trim().is_empty()) {
        let _ = fs::remove_file(path);
    }
}

fn start_feedback_queue_worker(db: Arc<Db>, queue_state: FeedbackQueueState) {
    if queue_state.worker_running.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || loop {
        let job_opt = fetch_next_feedback_job(&db, now_ms()).unwrap_or(None);
        let Some(job) = job_opt else {
            if has_feedback_jobs(&db) {
                std::thread::sleep(Duration::from_millis(5000));
                continue;
            }
            queue_state.worker_running.store(false, Ordering::SeqCst);
            let has_more = has_feedback_jobs(&db);
            if has_more && !queue_state.worker_running.swap(true, Ordering::SeqCst) {
                continue;
            }
            break;
        };

        let send_result = send_telegram_feedback(db.clone(), &job);

        match send_result {
            Ok(_) => {
                info!(
                    "[feedback-queue] sent job={} attempts={}",
                    job.id,
                    job.attempts + 1
                );
                delete_feedback_job(&db, &job);
            }
            Err(err) => {
                info!(
                    "[feedback-queue] send failed job={} attempt={} err={}",
                    job.id,
                    job.attempts + 1,
                    err
                );
                mark_feedback_job_failed(&db, &job, &err);
                let sleep_ms = 3000;
                std::thread::sleep(Duration::from_millis(sleep_ms as u64));
            }
        }
    });
}

pub fn start_feedback_delivery_worker(db: Arc<Db>, queue_state: FeedbackQueueState) {
    start_feedback_queue_worker(db, queue_state);
}

#[tauri::command(rename_all = "camelCase")]
pub async fn submit_feedback(
    db: State<'_, Arc<Db>>,
    payload: SubmitFeedbackPayload,
    queue_state: State<'_, FeedbackQueueState>,
) -> Result<(), String> {
    cmd_log!("submit_feedback");
    let message = payload.message.trim().to_string();
    if message.len() < 3 {
        return Err("Please enter at least 3 characters.".to_string());
    }
    if message.len() > 3000 {
        return Err("Feedback is too long (max 3000 chars).".to_string());
    }
    if let Some(image_data_url) = payload
        .image_data_url
        .as_ref()
        .filter(|v| !v.trim().is_empty())
    {
        let (bytes, _mime, filename) = parse_image_data_url(image_data_url)?;
        let image_path = store_feedback_screenshot(&bytes, &filename)?;
        let conn = db.conn();
        conn.execute(
            "INSERT INTO feedback_outbox (id, message, image_path, timestamp_iso, attempts, next_attempt_at, last_error, created_at)
             VALUES (?, ?, ?, ?, 0, ?, NULL, ?)",
            rusqlite::params![
                Uuid::new_v4().to_string(),
                message,
                image_path,
                payload.timestamp_iso,
                now_ms(),
                now_ms()
            ],
        )
        .map_err(|e| e.to_string())?;
    } else {
        let conn = db.conn();
        conn.execute(
            "INSERT INTO feedback_outbox (id, message, image_path, timestamp_iso, attempts, next_attempt_at, last_error, created_at)
             VALUES (?, ?, NULL, ?, 0, ?, NULL, ?)",
            rusqlite::params![
                Uuid::new_v4().to_string(),
                message,
                payload.timestamp_iso,
                now_ms(),
                now_ms()
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    start_feedback_queue_worker(db.inner().clone(), queue_state.inner().clone());
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_top_tags(
    db: State<'_, Arc<Db>>,
    limit: Option<u32>,
) -> Result<Vec<TopTagRow>, String> {
    cmd_log!("get_top_tags");
    let limit = limit.unwrap_or(25).min(50) as i64;
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.conn();
        let mut stmt = conn
            .prepare(
                "SELECT t.id, t.label, tc.usage_count FROM tag_usage_counts tc \
                 JOIN tags t ON t.id = tc.tag_id WHERE tc.usage_count > 0 \
                 AND LOWER(t.label) NOT IN (
                   'image','video','gif',
                   'horizontal','vertical','square',
                   'local','youtube','instagram','tiktok','vimeo','pinterest'
                 ) \
                 ORDER BY tc.usage_count DESC LIMIT ?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![limit], |r| {
                Ok(TopTagRow {
                    id: r.get(0)?,
                    label: r.get(1)?,
                    usage_count: r.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| e.to_string())?);
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Shared state: true while the one-time tag count backfill is running.
pub struct TagCountBackfillState(pub Arc<AtomicBool>);

const TAG_COUNT_BACKFILL_BATCH_SIZE: i64 = 100;
const TAG_COUNT_BACKFILL_SLEEP_MS: u64 = 25;

fn run_tag_count_backfill_sync(db: &Db, running: &AtomicBool) -> Result<(), String> {
    {
        let conn = db.conn();
        let initialized: Option<String> = conn
            .query_row(
                "SELECT value FROM meta WHERE key = 'tag_count_initialized'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if initialized.as_deref() == Some("1") {
            return Ok(());
        }
        conn.execute("DELETE FROM tag_usage_counts", [])
            .map_err(|e| e.to_string())?;
    }
    running.store(true, Ordering::SeqCst);
    let mut offset: i64 = 0;
    loop {
        let ids: Vec<String> = {
            let conn = db.conn();
            let mut stmt = conn
                .prepare("SELECT id FROM inspirations ORDER BY id LIMIT ?1 OFFSET ?2")
                .map_err(|e| e.to_string())?;
            let out: Vec<String> = stmt
                .query_map(
                    rusqlite::params![TAG_COUNT_BACKFILL_BATCH_SIZE, offset],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();
            out
        };
        if ids.is_empty() {
            break;
        }
        let rows: Vec<(String, String)> = {
            let conn = db.conn();
            let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let sql = format!(
                "SELECT inspiration_id, tag_id FROM inspiration_tags WHERE inspiration_id IN ({})",
                placeholders
            );
            let params: Vec<&dyn rusqlite::ToSql> =
                ids.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let out: Vec<(String, String)> = stmt
                .query_map(rusqlite::params_from_iter(params.iter().map(|p| *p)), |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();
            out
        };
        {
            let conn = db.conn();
            for (_inspiration_id, tag_id) in &rows {
                tags::increment_tag_usage(&conn, tag_id).map_err(|e| e.to_string())?;
            }
        }
        offset += ids.len() as i64;
        std::thread::sleep(Duration::from_millis(TAG_COUNT_BACKFILL_SLEEP_MS));
    }
    {
        let conn = db.conn();
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('tag_count_initialized', '1')",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    running.store(false, Ordering::SeqCst);
    info!("[tag_count] backfill complete");
    Ok(())
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagCountStatus {
    pub initialized: bool,
    pub backfill_running: bool,
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_tag_count_status(
    db: State<'_, Arc<Db>>,
    backfill_state: State<'_, TagCountBackfillState>,
) -> Result<TagCountStatus, String> {
    let db = db.inner().clone();
    let running = backfill_state.0.load(Ordering::SeqCst);
    let initialized = tauri::async_runtime::spawn_blocking(move || {
        let conn = db.conn();
        conn.query_row(
            "SELECT value FROM meta WHERE key = 'tag_count_initialized'",
            [],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map(|v| v.as_deref() == Some("1"))
        .unwrap_or(false)
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(TagCountStatus {
        initialized,
        backfill_running: running,
    })
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureTagCountResult {
    pub started: bool,
}

#[tauri::command(rename_all = "camelCase")]
pub async fn ensure_tag_counts_initialized(
    db: State<'_, Arc<Db>>,
    backfill_state: State<'_, TagCountBackfillState>,
) -> Result<EnsureTagCountResult, String> {
    let db = db.inner().clone();
    let already_initialized = tauri::async_runtime::spawn_blocking({
        let db = db.clone();
        move || {
            let conn = db.conn();
            conn.query_row(
                "SELECT value FROM meta WHERE key = 'tag_count_initialized'",
                [],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map(|v| v.as_deref() == Some("1"))
            .unwrap_or(false)
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    if already_initialized {
        return Ok(EnsureTagCountResult { started: false });
    }
    if backfill_state.0.load(Ordering::SeqCst) {
        return Ok(EnsureTagCountResult { started: true });
    }
    let db_backfill = db.clone();
    let state_backfill = backfill_state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = run_tag_count_backfill_sync(db_backfill.as_ref(), &state_backfill);
    });
    Ok(EnsureTagCountResult { started: true })
}

#[tauri::command]
pub async fn list_tags(db: State<'_, Arc<Db>>) -> Result<Vec<tags::Tag>, String> {
    cmd_log!("list_tags");
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.conn();
        let mut stmt = conn
            .prepare("SELECT id, label, type, origin FROM tags ORDER BY type, label")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(tags::Tag {
                    id: r.get(0)?,
                    label: r.get(1)?,
                    r#type: r.get(2)?,
                    origin: r.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| e.to_string())?);
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn create_user_tag(
    db: State<'_, Arc<Db>>,
    label: String,
    tag_type: Option<String>,
) -> Result<tags::Tag, String> {
    cmd_log!("create_user_tag");
    let db = db.inner().clone();
    let tag_type = tag_type.unwrap_or_else(|| "style".to_string());
    let label = label.trim().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.conn();
        let id = tags::ensure_tag(&conn, &label, &tag_type, "user")?;
        Ok(tags::Tag {
            id: id.clone(),
            label,
            r#type: tag_type,
            origin: "user".to_string(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn rename_tag(db: State<Arc<Db>>, tag_id: String, new_label: String) -> Result<(), String> {
    cmd_log!("rename_tag");
    let conn = db.conn();
    let new_label = new_label.trim();
    if new_label.is_empty() {
        return Err("Label cannot be empty".to_string());
    }
    let origin: String = conn
        .query_row("SELECT origin FROM tags WHERE id = ?", [&tag_id], |r| {
            r.get(0)
        })
        .map_err(|e| e.to_string())?;
    if origin != "user" {
        return Err("Only user tags can be renamed".to_string());
    }
    conn.execute(
        "UPDATE tags SET label = ? WHERE id = ?",
        rusqlite::params![new_label, tag_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn attach_tag_to_inspiration(
    db: State<'_, Arc<Db>>,
    inspiration_id: String,
    tag_id: String,
) -> Result<(), String> {
    cmd_log!("attach_tag_to_inspiration");
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.conn();
        tags::attach_tag(&conn, &inspiration_id, &tag_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "camelCase")]
pub fn detach_tag_from_inspiration(
    db: State<Arc<Db>>,
    inspiration_id: String,
    tag_id: String,
) -> Result<(), String> {
    cmd_log!("detach_tag_from_inspiration");
    let conn = db.conn();
    let origin: String = conn
        .query_row("SELECT origin FROM tags WHERE id = ?", [&tag_id], |r| {
            r.get(0)
        })
        .map_err(|e| e.to_string())?;
    if origin == "system" {
        return Err("System tags cannot be detached".to_string());
    }
    tags::detach_tag(&conn, &inspiration_id, &tag_id)
}

// ---- Palette & Find Similar ----

/// Tags to ALWAYS IGNORE in similarity / related calculations.
/// These are structural/technical and must NOT influence "Find related" results.
/// All other tags are used as semantic signals (style, mood, intent, design type).
const SIMILARITY_IGNORED_TAGS: &[&str] = &[
    // Media type
    "image",
    "video",
    "gif",
    // Platform / source
    "youtube",
    "instagram",
    "vimeo",
    "tiktok",
    "local",
    "link",
    // Orientation / format
    "horizontal",
    "vertical",
    "square",
    "portrait",
    "landscape",
    // System / auto tags
    "downloaded",
    "imported",
    "generated",
    "extracted",
    "cached",
    "thumbnail",
];

fn resolve_image_path_for_analysis(
    db: &std::sync::Arc<Db>,
    vault: &std::sync::Arc<VaultPaths>,
    inspiration_id: &str,
) -> Result<Option<PathBuf>, String> {
    let conn = db.conn();
    let row: Option<(String, Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT type, stored_path, thumbnail_path FROM inspirations WHERE id = ?",
            [inspiration_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let (media_type, stored_path, thumbnail_path) = match row {
        Some(r) => r,
        None => return Ok(None),
    };

    let try_one = |rel: Option<&String>| -> Option<PathBuf> {
        let s = rel?.trim();
        if s.is_empty() {
            return None;
        }
        resolve_vault_relative_existing_path(&vault.root, s).ok()
    };

    // OCR/palette: static images only. Skip videos and gifs.
    // For `image`, try stored file first, then thumbnail — the first match arm used to skip
    // thumbnail whenever stored_path was non-null, even if that path was broken.
    let mut candidates: Vec<PathBuf> = Vec::new();
    match media_type.as_str() {
        "image" => {
            if let Some(p) = try_one(stored_path.as_ref()) {
                candidates.push(p);
            }
            if let Some(p) = try_one(thumbnail_path.as_ref()) {
                if !candidates.iter().any(|c| c == &p) {
                    candidates.push(p);
                }
            }
        }
        "link" => {
            if let Some(p) = try_one(thumbnail_path.as_ref()) {
                candidates.push(p);
            }
            if let Some(p) = try_one(stored_path.as_ref()) {
                if !candidates.iter().any(|c| c == &p) {
                    candidates.push(p);
                }
            }
        }
        _ => {}
    }

    Ok(candidates.into_iter().find(|p| p.exists()))
}

fn normalize_ocr_text(raw: &str) -> String {
    use std::sync::OnceLock;
    static RE_NW: OnceLock<Regex> = OnceLock::new();
    static RE_WS: OnceLock<Regex> = OnceLock::new();
    let re_non_word = RE_NW.get_or_init(|| Regex::new(r"[^\p{L}\p{N}\s]+").expect("ocr regex"));
    let re_ws = RE_WS.get_or_init(|| Regex::new(r"\s+").expect("ocr regex"));
    let lower = raw.to_lowercase();
    let stripped = re_non_word.replace_all(&lower, " ");
    re_ws.replace_all(stripped.trim(), " ").to_string()
}

fn suppress_console_window(cmd: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

fn tesseract_command_available(bin: &Path) -> bool {
    let mut cmd = Command::new(bin);
    suppress_console_window(&mut cmd);
    cmd.arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn resolve_tesseract_from_where() -> Option<PathBuf> {
    if !cfg!(target_os = "windows") {
        return None;
    }
    let mut cmd = Command::new("where");
    suppress_console_window(&mut cmd);
    let out = cmd.arg("tesseract").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    for line in stdout.lines() {
        let p = PathBuf::from(line.trim());
        if p.exists() {
            return Some(p);
        }
    }
    None
}

fn resolve_tesseract_binary() -> Option<PathBuf> {
    if let Ok(custom) = env::var("QOOTI_TESSERACT_PATH") {
        let p = PathBuf::from(custom);
        if p.exists() && tesseract_command_available(&p) {
            return Some(p);
        }
    }

    let bin_name = if cfg!(target_os = "windows") {
        "tesseract.exe"
    } else {
        "tesseract"
    };

    let mut candidates: Vec<PathBuf> = Vec::new();
    if cfg!(target_os = "windows") {
        let common = vec![
            r"C:\Program Files\Tesseract-OCR\tesseract.exe",
            r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
        ];
        for p in common {
            candidates.push(PathBuf::from(p));
        }
        if let Ok(local_app_data) = env::var("LOCALAPPDATA") {
            candidates.push(
                PathBuf::from(local_app_data)
                    .join("Programs")
                    .join("Tesseract-OCR")
                    .join("tesseract.exe"),
            );
        }
        if let Some(p) = resolve_tesseract_from_where() {
            candidates.push(p);
        }
    }

    // Dev-time fallback: pick from repo resources directory.
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    candidates.push(
        manifest_dir
            .join("resources")
            .join("tesseract")
            .join(bin_name),
    );
    candidates.push(manifest_dir.join("resources").join(bin_name));

    if let Ok(exe) = env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let bundled_candidates = [
                exe_dir.join("resources").join("tesseract").join(bin_name),
                exe_dir.join("resources").join(bin_name),
                exe_dir
                    .join("..")
                    .join("Resources")
                    .join("tesseract")
                    .join(bin_name),
                exe_dir.join("..").join("Resources").join(bin_name),
            ];
            for p in bundled_candidates {
                candidates.push(p);
            }
        }
    }

    // PATH fallback
    candidates.push(PathBuf::from("tesseract"));

    for p in candidates {
        if tesseract_command_available(&p) {
            return Some(p);
        }
    }

    None
}

fn resolve_tessdata_prefix(binary: &Path) -> Option<PathBuf> {
    if let Ok(custom) = env::var("QOOTI_TESSDATA_PREFIX") {
        let p = PathBuf::from(custom);
        if p.exists() {
            return Some(p);
        }
    }
    let parent = binary.parent()?;
    let candidates = [
        parent.join("tessdata"),
        parent.join("..").join("tessdata"),
        parent.join("..").join("share").join("tessdata"),
        parent.join("..").join("Resources").join("tessdata"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("tesseract")
            .join("tessdata"),
    ];
    for p in candidates {
        if p.exists() {
            return Some(p);
        }
    }
    None
}

fn run_tesseract_ocr(binary: &Path, image_path: &Path, psm: &str) -> Result<String, String> {
    let mut cmd = Command::new(binary);
    suppress_console_window(&mut cmd);
    if let Some(prefix) = resolve_tessdata_prefix(binary) {
        cmd.env("TESSDATA_PREFIX", prefix);
    }
    let output = cmd
        .arg(image_path)
        .arg("stdout")
        .arg("--psm")
        .arg(psm)
        .arg("-l")
        .arg("eng")
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(format!("exit {:?}", output.status.code()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn do_extract_ocr_text(
    db: &std::sync::Arc<Db>,
    vault: &std::sync::Arc<VaultPaths>,
    inspiration_id: &str,
) -> Result<bool, String> {
    let path = match resolve_image_path_for_analysis(db, vault, inspiration_id)? {
        Some(p) => p,
        None => {
            warn!(
                "[OCR][backend] no analysis path for inspiration {}",
                inspiration_id
            );
            return Ok(false);
        }
    };

    // Local OCR via tesseract CLI with path fallback.
    let tess_bin = match resolve_tesseract_binary() {
        Some(p) => p,
        None => {
            warn!(
                "[OCR][backend] no tesseract binary available for inspiration {}",
                inspiration_id
            );
            return Ok(false);
        }
    };
    info!(
        "[OCR][backend] starting tesseract for {} using {} on {}",
        inspiration_id,
        tess_bin.to_string_lossy(),
        path.file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string_lossy().to_string())
    );

    let raw_primary = match run_tesseract_ocr(&tess_bin, &path, "6") {
        Ok(s) => s,
        Err(e) => {
            warn!(
                "[OCR][backend] tesseract psm6 failed for {}: {}",
                inspiration_id, e
            );
            return Ok(false);
        }
    };
    let mut cleaned = normalize_ocr_text(&raw_primary);

    // Retry with sparse-text mode for stylized/banner images where psm 6 may miss words.
    if cleaned.len() < 3 {
        if let Ok(raw_sparse) = run_tesseract_ocr(&tess_bin, &path, "11") {
            let cleaned_sparse = normalize_ocr_text(&raw_sparse);
            if cleaned_sparse.len() > cleaned.len() {
                cleaned = cleaned_sparse;
            }
        }
    }

    if cleaned.is_empty() {
        let conn = db.conn();
        let _ = conn.execute(
            "UPDATE inspirations SET ocr_text = '', ocr_status = 'no_text' WHERE id = ?",
            rusqlite::params![inspiration_id.to_string()],
        );
        info!(
            "[OCR][backend] no text detected for {} after tesseract",
            inspiration_id
        );
        return Ok(false);
    }

    let conn = db.conn();
    conn.execute(
        "UPDATE inspirations SET ocr_text = ?, ocr_status = 'done' WHERE id = ?",
        rusqlite::params![cleaned, inspiration_id.to_string()],
    )
    .map_err(|e| e.to_string())?;
    info!(
        "[OCR][backend] OCR saved for {}",
        inspiration_id
    );
    Ok(true)
}

fn claim_pending_ocr_candidates(
    db: &std::sync::Arc<Db>,
    vault: &std::sync::Arc<VaultPaths>,
    limit: usize,
) -> Result<Vec<OcrIndexCandidate>, String> {
    let vault_root_abs = vault
        .root
        .canonicalize()
        .unwrap_or_else(|_| vault.root.clone());
    let ids: Vec<String> = {
        let conn = db.conn();
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let _ = tx.execute(
            "UPDATE inspirations SET ocr_status = NULL WHERE ocr_status = 'processing'",
            [],
        );
        let mut stmt = tx
            .prepare(
                "SELECT id FROM inspirations
                 WHERE type IN ('image','link')
                   AND (ocr_status IS NULL OR ocr_status = 'pending')
                 ORDER BY updated_at DESC
                 LIMIT ?1",
            )
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        let rows = stmt
            .query_map([limit as i64], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for row in rows {
            out.push(row.map_err(|e| e.to_string())?);
        }
        drop(stmt);
        for id in &out {
            let _ = tx.execute(
                "UPDATE inspirations SET ocr_status = 'processing' WHERE id = ? AND (ocr_status IS NULL OR ocr_status = 'pending')",
                [id],
            );
        }
        tx.commit().map_err(|e| e.to_string())?;
        out
    };
    let selected_count = ids.len();
    let selected_ids = ids.clone();

    let mut out: Vec<OcrIndexCandidate> = Vec::new();
    let mut demoted_no_path = 0usize;
    for id in ids {
        if let Some(path) = resolve_image_path_for_analysis(db, vault, &id)? {
            let path_abs_buf = path
                .canonicalize()
                .unwrap_or(path);
            let path_abs = path_abs_buf.to_string_lossy().to_string();
            let image_rel_path = path_abs_buf
                .strip_prefix(&vault_root_abs)
                .ok()
                .map(|p| p.to_string_lossy().replace('\\', "/"));
            out.push(OcrIndexCandidate {
                id,
                image_path: path_abs,
                image_rel_path,
            });
        } else {
            let conn = db.conn();
            let _ = conn.execute(
                "UPDATE inspirations SET ocr_status = 'no_text', ocr_text = '' WHERE id = ?",
                [&id],
            );
            demoted_no_path += 1;
            warn!(
                "[OCR][queue] candidate {} has no analysis path; marked no_text",
                id
            );
        }
    }

    info!(
        "[OCR][queue] selected={} returned={} demoted_no_path={} limit={} selected_ids={:?}",
        selected_count,
        out.len(),
        demoted_no_path,
        limit,
        selected_ids
    );

    Ok(out)
}

fn queue_full_ocr_reindex_impl(
    db: &std::sync::Arc<Db>,
    vault: &std::sync::Arc<VaultPaths>,
) -> Result<OcrReindexSummary, String> {
    let rows: Vec<(String, Option<String>)> = {
        let conn = db.conn();
        let mut stmt = conn
            .prepare(
                "SELECT id, ocr_status
                 FROM inspirations
                 WHERE type IN ('image','link')
                 ORDER BY updated_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let mapped = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)))
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in mapped {
            out.push(row.map_err(|e| e.to_string())?);
        }
        out
    };

    let mut queued_ids: Vec<String> = Vec::new();
    let mut already_done = 0_i64;
    let mut already_processing = 0_i64;
    let mut skipped = 0_i64;

    for (id, status) in rows {
        if resolve_image_path_for_analysis(db, vault, &id)?.is_none() {
            skipped += 1;
            continue;
        }
        match status.as_deref() {
            Some("done") => already_done += 1,
            Some("processing") => already_processing += 1,
            Some("no_text") | Some("pending") | None => queued_ids.push(id),
            _ => queued_ids.push(id),
        }
    }

    if !queued_ids.is_empty() {
        let conn = db.conn();
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        for id in &queued_ids {
            tx.execute(
                "UPDATE inspirations
                 SET ocr_status = 'pending', ocr_text = ''
                 WHERE id = ?1
                   AND type IN ('image','link')
                   AND (ocr_status IS NULL OR ocr_status IN ('pending', 'no_text'))",
                [id],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
    }

    Ok(OcrReindexSummary {
        queued: queued_ids.len() as i64,
        already_done,
        already_processing,
        skipped,
    })
}

fn do_extract_palette(
    db: &std::sync::Arc<Db>,
    vault: &std::sync::Arc<VaultPaths>,
    inspiration_id: &str,
) -> Result<bool, String> {
    let path = match resolve_image_path_for_analysis(db, vault, inspiration_id)? {
        Some(p) => p,
        None => {
            warn!(
                "[palette] extract skipped | id={} | reason=no_resolvable_image_path",
                inspiration_id
            );
            return Ok(false);
        }
    };

    let conn = db.conn();
    let (mime_hint, name_hint): (Option<String>, Option<String>) = conn
        .query_row(
            "SELECT mime_type, original_filename FROM inspirations WHERE id = ?",
            [inspiration_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| e.to_string())?;

    let p = match palette::extract_palette_from_image(
        &path,
        mime_hint.as_deref(),
        name_hint.as_deref(),
    ) {
        Ok(p) => p,
        Err(e) => {
            warn!(
                "[palette] extract failed | id={} | path={} | err={}",
                inspiration_id,
                path.display(),
                e
            );
            return Ok(false);
        }
    };

    let json = serde_json::to_string(&p.colors).map_err(|e| e.to_string())?;
    let n = conn
        .execute(
            "UPDATE inspirations SET palette = ? WHERE id = ?",
            rusqlite::params![json, inspiration_id.to_string()],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        warn!(
            "[palette] extract no row updated | id={} | path={}",
            inspiration_id,
            path.display()
        );
        return Ok(false);
    }
    info!(
        "[palette] extract ok | id={} | path={} | swatches={}",
        inspiration_id,
        path.display(),
        p.colors.len()
    );
    Ok(true)
}

#[tauri::command]
pub async fn extract_palette(
    db: State<'_, Arc<Db>>,
    vault: State<'_, Arc<VaultPaths>>,
    inspiration_id: String,
) -> Result<bool, String> {
    cmd_log!("extract_palette");
    let db = db.inner().clone();
    let vault = vault.inner().clone();
    tauri::async_runtime::spawn_blocking(move || do_extract_palette(&db, &vault, &inspiration_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn extract_ocr_text(
    db: State<'_, Arc<Db>>,
    vault: State<'_, Arc<VaultPaths>>,
    inspiration_id: String,
) -> Result<bool, String> {
    cmd_log!("extract_ocr_text");
    let db = db.inner().clone();
    let vault = vault.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let ok = do_extract_ocr_text(&db, &vault, &inspiration_id)?;
        if !ok {
            warn!(
                "[ocr] no_text | item_id={} | reason=tesseract_or_no_image_path",
                inspiration_id
            );
            // Tesseract unavailable or no image path — mark as no_text so the
            // item is not endlessly re-queued.
            let conn = db.conn();
            let _ = conn.execute(
                "UPDATE inspirations SET ocr_text = '', ocr_status = 'no_text' WHERE id = ? AND (ocr_status IS NULL OR ocr_status IN ('processing', 'pending'))",
                rusqlite::params![&inspiration_id],
            );
        } else {
            info!("[ocr] extract_ok | item_id={}", inspiration_id);
        }
        Ok(ok)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn claim_ocr_index_candidates(
    db: State<'_, Arc<Db>>,
    vault: State<'_, Arc<VaultPaths>>,
    limit: Option<u32>,
) -> Result<Vec<OcrIndexCandidate>, String> {
    cmd_log!("claim_ocr_index_candidates");
    let db = db.inner().clone();
    let vault = vault.inner().clone();
    let take = limit.unwrap_or(2).clamp(1, 8) as usize;
    tauri::async_runtime::spawn_blocking(move || claim_pending_ocr_candidates(&db, &vault, take))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn finalize_ocr_index_result(
    db: State<'_, Arc<Db>>,
    inspiration_id: String,
    text: Option<String>,
    failed: Option<bool>,
    stage: Option<String>,
    error_code: Option<String>,
    error_message: Option<String>,
) -> Result<bool, String> {
    cmd_log!("finalize_ocr_index_result");
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.conn();
        let prior_status: Option<String> = conn
            .query_row(
                "SELECT ocr_status FROM inspirations WHERE id = ?",
                [&inspiration_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let raw_text = text.unwrap_or_default();
        let raw_len = raw_text.len();
        let cleaned = normalize_ocr_text(&raw_text);
        let cleaned_len = cleaned.len();
        let is_failed = failed.unwrap_or(false);
        let stage = stage.unwrap_or_default();
        let error_code = error_code.unwrap_or_default();
        let error_message = error_message.unwrap_or_default();
        if failed.unwrap_or(false) {
            let rows_affected = conn
                .execute(
                "UPDATE inspirations SET ocr_text = '', ocr_status = 'no_text' WHERE id = ?",
                [&inspiration_id],
            )
            .map_err(|e| e.to_string())?;
            info!(
                "[OCR][finalize] id={} branch={} failed={} stage={} error_code={} error_message={} prior_status={:?} raw_len={} cleaned_len={} rows_affected={}",
                inspiration_id,
                "failed_flag_no_text",
                is_failed,
                stage,
                error_code,
                error_message,
                prior_status,
                raw_len,
                cleaned_len,
                rows_affected
            );
            return Ok(true);
        }
        let (branch, rows_affected) = if cleaned.is_empty() {
            let rows_affected = conn
                .execute(
                "UPDATE inspirations SET ocr_text = '', ocr_status = 'no_text' WHERE id = ?",
                [&inspiration_id],
            )
            .map_err(|e| e.to_string())?;
            ("cleaned_empty_no_text", rows_affected)
        } else {
            let rows_affected = conn
                .execute(
                "UPDATE inspirations SET ocr_text = ?, ocr_status = 'done' WHERE id = ?",
                rusqlite::params![cleaned, inspiration_id],
            )
            .map_err(|e| e.to_string())?;
            ("cleaned_nonempty_done", rows_affected)
        };
        info!(
            "[OCR][finalize] id={} branch={} failed={} stage={} error_code={} error_message={} prior_status={:?} raw_len={} cleaned_len={} rows_affected={}",
            inspiration_id,
            branch,
            is_failed,
            stage,
            error_code,
            error_message,
            prior_status,
            raw_len,
            cleaned_len,
            rows_affected
        );
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn reset_ocr_status_for_inspiration(
    db: State<'_, Arc<Db>>,
    inspiration_id: String,
) -> Result<bool, String> {
    cmd_log!("reset_ocr_status_for_inspiration");
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.conn();
        conn.execute(
            "UPDATE inspirations SET ocr_status = NULL, ocr_text = '' WHERE id = ?",
            [&inspiration_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn queue_full_ocr_reindex(
    db: State<'_, Arc<Db>>,
    vault: State<'_, Arc<VaultPaths>>,
) -> Result<OcrReindexSummary, String> {
    cmd_log!("queue_full_ocr_reindex");
    let db = db.inner().clone();
    let vault = vault.inner().clone();
    tauri::async_runtime::spawn_blocking(move || queue_full_ocr_reindex_impl(&db, &vault))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_ocr_index_stats(db: State<'_, Arc<Db>>) -> Result<OcrIndexStats, String> {
    cmd_log!("get_ocr_index_stats");
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.conn();
        let done: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM inspirations WHERE type IN ('image','link') AND ocr_status = 'done'",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let no_text: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM inspirations WHERE type IN ('image','link') AND ocr_status = 'no_text'",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let processing: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM inspirations WHERE type IN ('image','link') AND ocr_status = 'processing'",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let pending: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM inspirations WHERE type IN ('image','link') AND (ocr_status IS NULL OR ocr_status = 'pending')",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        // OCR progress should be based on only currently unindexed work.
        // "total" means the active OCR backlog for this run (pending + processing).
        let total = pending + processing;
        Ok(OcrIndexStats {
            total,
            done,
            no_text,
            processing,
            pending,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_inspiration_ocr_debug(
    db: State<'_, Arc<Db>>,
    vault: State<'_, Arc<VaultPaths>>,
    inspiration_id: String,
    force_refresh: Option<bool>,
) -> Result<OcrDebugInfo, String> {
    cmd_log!("get_inspiration_ocr_debug");
    let db = db.inner().clone();
    let vault = vault.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let force_refresh = force_refresh.unwrap_or(false);
        let row: Option<(String, String, Option<String>, Option<String>)> = {
            let conn = db.conn();
            conn.query_row(
                "SELECT type, COALESCE(ocr_text, ''), ocr_status, palette FROM inspirations WHERE id = ?",
                [inspiration_id.clone()],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, Option<String>>(2)?,
                        r.get::<_, Option<String>>(3)?,
                    ))
                },
            )
            .optional()
            .map_err(|e| e.to_string())?
        };
        let (media_type, ocr_text, ocr_status, palette_json) =
            row.ok_or_else(|| "Inspiration not found".to_string())?;

        let palette_swatches: Vec<OcrDebugPaletteSwatch> = palette_json
            .as_deref()
            .and_then(|s| {
                let s = s.trim();
                if s.is_empty() {
                    return None;
                }
                serde_json::from_str::<Vec<[f32; 3]>>(s).ok()
            })
            .map(|labs| {
                labs.iter()
                    .map(|lab| OcrDebugPaletteSwatch {
                        hex: palette::lab_to_hex(lab),
                        lab_l: lab[0],
                        lab_a: lab[1],
                        lab_b: lab[2],
                    })
                    .collect()
            })
            .unwrap_or_default();

        let analysis_path = resolve_image_path_for_analysis(&db, &vault, &inspiration_id)?;
        let can_attempt_ocr = analysis_path.is_some();

        let mut ocr_asset_roots = vec![
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("src")
                .join("assets")
                .join("ocr"),
        ];
        if let Ok(exe) = env::current_exe() {
            if let Some(exe_dir) = exe.parent() {
                ocr_asset_roots.push(exe_dir.join("resources").join("src").join("assets").join("ocr"));
                ocr_asset_roots.push(
                    exe_dir
                        .join("..")
                        .join("Resources")
                        .join("src")
                        .join("assets")
                        .join("ocr"),
                );
            }
        }
        let frontend_ocr_available = ocr_asset_roots.iter().any(|root| {
            root.join("ocr-engine.js").exists()
                && root.join("ort.wasm.min.js").exists()
                && root.join("models").join("ch_PP-OCRv4_det_infer.onnx").exists()
                && root.join("models").join("ch_PP-OCRv4_rec_infer.onnx").exists()
                && root.join("models").join("ppocr_keys_v1.txt").exists()
        });
        let tesseract_available = resolve_tesseract_binary().is_some();

        let ocr_refreshed = false;
        if can_attempt_ocr && (force_refresh || ocr_text.trim().is_empty()) {
            info!(
                "[OCR][debug] inspect for {} (force_refresh={}, had_text={}, frontend_assets={}, tesseract_cli_available={}, read_only=true)",
                inspiration_id,
                force_refresh,
                !ocr_text.trim().is_empty(),
                frontend_ocr_available,
                tesseract_available
            );
            info!(
                "[OCR][debug] inspect result for {} (refreshed={}, status={:?}, text_len={})",
                inspiration_id,
                ocr_refreshed,
                ocr_status,
                ocr_text.trim().len()
            );
        }

        let has_ocr_text = !ocr_text.trim().is_empty();
        let token_count = if has_ocr_text {
            ocr_text.split_whitespace().count()
        } else {
            0
        };

        Ok(OcrDebugInfo {
            id: inspiration_id,
            media_type,
            ocr_status,
            can_attempt_ocr,
            tesseract_available,
            ocr_refreshed,
            has_ocr_text,
            token_count,
            ocr_text,
            analysis_path: analysis_path
                .and_then(|p| p.canonicalize().ok().or(Some(p)))
                .map(|p| p.to_string_lossy().to_string()),
            tesseract_binary: resolve_tesseract_binary().map(|p| p.to_string_lossy().to_string()),
            palette: palette_swatches,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn find_similar(
    db: State<'_, Arc<Db>>,
    vault: State<'_, Arc<VaultPaths>>,
    inspiration_id: String,
    limit: Option<u32>,
) -> Result<Vec<InspirationRow>, String> {
    cmd_log!("find_similar");
    let db = db.inner().clone();
    let vault = vault.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
    let limit = limit.unwrap_or(12).min(50);
    let conn = db.conn();

    let strictness = get_setting(&conn, "relatedStrictness");
    let prefer_orientation = get_setting(&conn, "relatedPreferSameOrientation") == "true";
    let prefer_media_type = get_setting(&conn, "relatedPreferSameMediaType") == "true";
    let tag_influence = get_setting(&conn, "relatedTagInfluence") == "true";

    let (threshold_strong, threshold_weak, confidence_cutoff) = match strictness.as_str() {
        "loose" => (0.55, 0.6, 0.7),
        "strict" => (0.65, 0.7, 0.8),
        _ => (0.6, 0.65, 0.75),
    };

    // Get source palette, extract on demand if missing
    let source_palette_json: Option<String> = conn
        .query_row("SELECT palette FROM inspirations WHERE id = ?", [&inspiration_id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?
        .flatten();

    // Use existing palette only — no on-demand extraction (avoids blocking/freeze)
    let source_palette = source_palette_json
        .as_ref()
        .and_then(|s| serde_json::from_str::<Vec<[f32; 3]>>(s).ok())
        .map(|colors| palette::Palette { colors });

    let mut color_sim: std::collections::HashMap<String, f32> = std::collections::HashMap::new();

    if let Some(ref source_palette) = source_palette {
        // Get source type and aspect_ratio for compatibility filtering
        let source_row: Option<(String, Option<f64>)> = conn
            .query_row("SELECT type, aspect_ratio FROM inspirations WHERE id = ?", [&inspiration_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()
            .map_err(|e| e.to_string())?;
        let (source_type, source_ar) = source_row.unwrap_or(("link".to_string(), None));

        // Progressive elimination: all candidates with palettes → filter → rank
        let all: Vec<(String, Option<String>, String, Option<f64>)> = conn
        .prepare(
            "SELECT id, palette, type, aspect_ratio FROM inspirations WHERE id != ? AND palette IS NOT NULL AND palette != ''",
        )
        .map_err(|e| e.to_string())?
        .query_map([&inspiration_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    const DOMINANT_COLOR_MAX_DISTANCE: f32 = 40.0;  // allow slightly different reds (35→40)
    const DOMINANT_WEAK_THRESHOLD: f32 = 32.0;      // min_dist >= this = weak overlap (25→32)
    const TYPE_PENALTY: f32 = 12.0;
    const ORIENTATION_PENALTY: f32 = 8.0;
    const DISTRIBUTION_PENALTY: f32 = 10.0; // monochrome vs multi-color
    const BRIGHTNESS_PENALTY: f32 = 8.0;    // avg L diff > threshold
    const CONTRAST_PENALTY: f32 = 6.0;      // std L diff significant
    const BRIGHTNESS_DIFF_THRESHOLD: f32 = 25.0;  // was 20 — red+black vs red+midtones
    const CONTRAST_DIFF_THRESHOLD: f32 = 18.0;    // was 15 — high-contrast pairs
    const MAX_RESULTS: usize = 12;
    const HUE_RADIUS: f32 = 25.0;
    const MONOCHROME_MIN: f32 = 0.6;  // >60% one hue = monochrome
    const MULTICOLOR_MAX: f32 = 0.4;  // <40% one hue = multi-color

    let orientation = |ar: Option<f64>| -> &'static str {
        match ar {
            Some(a) if a > 1.15 => "horizontal",
            Some(a) if a < 0.87 => "vertical",
            _ => "square",
        }
    };
    let type_compatible = |a: &str, b: &str| -> bool {
        matches!((a, b),
            ("image", "image") | ("image", "gif") | ("gif", "image") | ("gif", "gif") |
            ("video", "video") | ("link", "link") | ("link", "image") | ("image", "link") | ("link", "gif") | ("gif", "link")
        )
    };

    let src_monochrome = palette::dominant_hue_concentration(&source_palette, HUE_RADIUS) > MONOCHROME_MIN;
    let (src_avg_l, src_std_l) = palette::lightness_stats(&source_palette);

    let mut passed: Vec<(String, f32)> = Vec::new();
    for (id, pal_json, cand_type, cand_ar) in all {
        let Some(ref s) = pal_json else { continue };
        let Ok(colors) = serde_json::from_str::<Vec<[f32; 3]>>(s) else { continue };
        let other = palette::Palette { colors };

        // 1. Dominant color overlap gate (with distance for dynamic threshold)
        let (overlap_ok, min_dist) =
            palette::dominant_color_overlap_with_distance(&source_palette, &other, DOMINANT_COLOR_MAX_DISTANCE);
        if !overlap_ok {
            continue;
        }

        // 2. Weighted palette similarity + penalties
        let raw_distance = palette::palette_similarity_weighted(&source_palette, &other);
        let mut adj_distance = raw_distance;

        if prefer_media_type && !type_compatible(&source_type, &cand_type) {
            adj_distance += TYPE_PENALTY;
        }
        if prefer_orientation && orientation(source_ar) != orientation(cand_ar) {
            adj_distance += ORIENTATION_PENALTY;
        }

        // Color distribution balance: monochrome source + multi-color candidate → penalty
        // Skip if they share dominant hue (min_dist < 40): e.g. both red-heavy images
        let cand_monochrome = palette::dominant_hue_concentration(&other, HUE_RADIUS) > MONOCHROME_MIN;
        let cand_multicolor = palette::dominant_hue_concentration(&other, HUE_RADIUS) < MULTICOLOR_MAX;
        let share_dominant_hue = min_dist < 40.0;
        if !share_dominant_hue && src_monochrome && cand_multicolor && !cand_monochrome {
            adj_distance += DISTRIBUTION_PENALTY;
        }

        // Brightness / contrast penalty
        let (cand_avg_l, cand_std_l) = palette::lightness_stats(&other);
        if (src_avg_l - cand_avg_l).abs() > BRIGHTNESS_DIFF_THRESHOLD {
            adj_distance += BRIGHTNESS_PENALTY;
        }
        if (src_std_l - cand_std_l).abs() > CONTRAST_DIFF_THRESHOLD {
            adj_distance += CONTRAST_PENALTY;
        }

        let similarity = palette::distance_to_similarity(adj_distance);

        // 3. Dynamic similarity threshold: weak overlap → stricter, strong → looser
        let threshold = if min_dist >= DOMINANT_WEAK_THRESHOLD {
            threshold_weak
        } else {
            threshold_strong
        };
        if similarity < threshold {
            continue;
        }

        passed.push((id, similarity));
    }

    // Color similarity map: id -> 0..1 (higher = more similar). Priority 1 for ranking.
    let best_sim = passed.first().map(|(_, s)| *s).unwrap_or(0.0);
    let cutoff = best_sim * confidence_cutoff;
    for (id, s) in passed {
        if s >= cutoff {
            color_sim.insert(id, s);
        }
    }
    }

    // Tag overlap: id -> overlap count. Normalize to 0..1 for scoring (priority 2).
    let source_tag_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM inspiration_tags WHERE inspiration_id = ?", [&inspiration_id], |r| r.get(0))
        .unwrap_or(0);
    let ignored_list: String = SIMILARITY_IGNORED_TAGS
        .iter()
        .map(|s| format!("'{}'", s.replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(",");
    let tag_overlap: std::collections::HashMap<String, i64> = if tag_influence {
        conn.prepare(&format!(
            "SELECT i2.inspiration_id, COUNT(*) as overlap
             FROM inspiration_tags i1
             JOIN inspiration_tags i2 ON i1.tag_id = i2.tag_id
             JOIN tags t ON t.id = i1.tag_id
             WHERE i1.inspiration_id = ? AND i2.inspiration_id != ?
               AND LOWER(TRIM(t.label)) NOT IN ({})
             GROUP BY i2.inspiration_id
             HAVING overlap > 0",
            ignored_list
        ))
        .map_err(|e| e.to_string())?
        .query_map([&inspiration_id, &inspiration_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect()
    } else {
        std::collections::HashMap::new()
    };

    // Combined score: (color_similarity * 0.7) + (tag_similarity * 0.3). Color is priority 1.
    const COLOR_WEIGHT: f32 = 0.7;
    const TAG_WEIGHT: f32 = 0.3;
    let max_tag_norm = source_tag_count.max(1) as f32;
    let mut all_ids: std::collections::HashSet<String> = color_sim.keys().cloned().collect();
    for id in tag_overlap.keys() {
        all_ids.insert(id.clone());
    }
    let mut scored: Vec<(String, f32)> = all_ids
        .into_iter()
        .map(|id| {
            let c = color_sim.get(&id).copied().unwrap_or(0.0);
            let t_raw = tag_overlap.get(&id).copied().unwrap_or(0) as f32;
            let t = (t_raw / max_tag_norm).min(1.0);
            let combined = (c * COLOR_WEIGHT) + (t * TAG_WEIGHT);
            (id, combined)
        })
        .collect();
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let top_ids: Vec<String> = scored.into_iter().take(limit as usize).map(|(id, _)| id).collect();

    if top_ids.is_empty() {
        return Ok(vec![]);
    }

    let placeholders = top_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT i.id, i.type, i.title, i.source_url, i.original_filename, i.stored_path, i.thumbnail_path, i.display_row, i.aspect_ratio, i.created_at, i.updated_at, i.vault_id, i.mime_type, i.palette FROM inspirations i WHERE i.id IN ({})",
        placeholders
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let params: Vec<&dyn rusqlite::ToSql> = top_ids.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
    let rows = stmt
        .query_map(rusqlite::params_from_iter(params.iter().map(|p| *p)), |r| {
            Ok(InspirationRow {
                id: r.get(0)?,
                r#type: r.get(1)?,
                title: r.get(2)?,
                source_url: r.get(3)?,
                original_filename: r.get(4)?,
                stored_path: r.get(5)?,
                thumbnail_path: r.get(6)?,
                display_row: r.get(7)?,
                aspect_ratio: r.get(8)?,
                created_at: r.get(9)?,
                updated_at: r.get(10)?,
                vault_id: r.get(11)?,
                mime_type: r.get(12)?,
                stored_path_url: None,
                thumbnail_path_url: None,
                stored_path_abs: None,
                thumbnail_path_abs: None,
                tags: None,
                palette: r.get::<_, Option<String>>(13)?.and_then(|s| serde_json::from_str(&s).ok()),
            })
        })
        .map_err(|e| e.to_string())?;

    let mut result: Vec<InspirationRow> = rows.filter_map(|r| r.ok()).collect();
    for r in &mut result {
        populate_inspiration_row_paths(r, &vault.root);
        let tag_rows: Vec<tags::Tag> = conn
            .prepare(
                "SELECT t.id, t.label, t.type, t.origin FROM inspiration_tags it JOIN tags t ON t.id = it.tag_id WHERE it.inspiration_id = ?",
            )
            .ok()
            .and_then(|mut st| {
                st.query_map([&r.id], |row| {
                    Ok(tags::Tag {
                        id: row.get(0)?,
                        label: row.get(1)?,
                        r#type: row.get(2)?,
                        origin: row.get(3)?,
                    })
                })
                .ok()
                .map(|iter| iter.filter_map(|x| x.ok()).collect())
            })
            .unwrap_or_default();
        if !tag_rows.is_empty() {
            r.tags = Some(tag_rows);
        }
    }
    Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}
