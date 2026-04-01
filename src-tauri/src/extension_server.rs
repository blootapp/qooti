//! Local HTTP server for Chrome extension. Verifies connection key and queues add requests.

use log::{debug, info, warn};
use serde_json::Value;
use std::collections::VecDeque;
#[allow(unused_imports)]
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use tiny_http::{Method, Response, Server, StatusCode};
use url::Url;

pub struct ExtensionQueue(pub Arc<Mutex<VecDeque<Value>>>);

const PREF_EXTENSION_KEY: &str = "extension_connection_key";
const PREF_EXTENSION_LAST: &str = "extension_last_connection_ts";
const PREF_EXTENSION_PICKER_ENABLED: &str = "extensionShowCollectionPicker";
const PREF_EXTENSION_PICKER_LAST_COLLECTION_ID: &str = "extension_collection_picker_last_collection_id";
const PREF_LANGUAGE: &str = "language";
const PORT: u16 = 1420;
const MAX_REQUEST_BODY_BYTES: usize = 64 * 1024;
const MAX_EXTENSION_URL_LENGTH: usize = 2048;

fn get_key_from_db(db_path: &Path) -> Option<String> {
    let conn = rusqlite::Connection::open(db_path).ok()?;
    let key: Option<String> = conn
        .query_row(
            "SELECT value FROM preferences WHERE key = ?",
            [PREF_EXTENSION_KEY],
            |r| r.get(0),
        )
        .ok();
    key.filter(|s| !s.trim().is_empty())
}

fn update_last_connection(db_path: &Path) {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    if let Ok(conn) = rusqlite::Connection::open(db_path) {
        let _ = conn.execute(
            "INSERT OR REPLACE INTO preferences(key, value) VALUES (?, ?)",
            rusqlite::params![PREF_EXTENSION_LAST, ts.to_string()],
        );
    }
}

fn cors_header() -> tiny_http::Header {
    tiny_http::Header::from_bytes(&b"Access-Control-Allow-Origin"[..], b"*").unwrap()
}

fn respond_json(status: StatusCode, body: &Value) -> Response<std::io::Cursor<Vec<u8>>> {
    let json = serde_json::to_string(body).unwrap_or_else(|_| "{}".to_string());
    Response::from_string(json)
        .with_status_code(status)
        .with_header(
            tiny_http::Header::from_bytes(&b"Content-Type"[..], b"application/json").unwrap(),
        )
        .with_header(cors_header())
}

fn respond_binary(
    status: StatusCode,
    body: Vec<u8>,
    content_type: &str,
    filename: Option<&str>,
) -> Response<std::io::Cursor<Vec<u8>>> {
    let mut response = Response::from_data(body)
        .with_status_code(status)
        .with_header(
            tiny_http::Header::from_bytes(&b"Content-Type"[..], content_type.as_bytes()).unwrap(),
        )
        .with_header(cors_header());
    if let Some(name) = filename {
        let val = format!("attachment; filename=\"{}\"", name);
        response = response.with_header(
            tiny_http::Header::from_bytes(&b"Content-Disposition"[..], val.as_bytes()).unwrap(),
        );
    }
    response
}

fn respond_401() -> Response<std::io::Cursor<Vec<u8>>> {
    respond_json(
        StatusCode(401),
        &serde_json::json!({ "error": "Invalid or missing connection key" }),
    )
}

fn respond_400(message: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    respond_json(StatusCode(400), &serde_json::json!({ "error": message }))
}

fn respond_404(message: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    respond_json(StatusCode(404), &serde_json::json!({ "error": message }))
}

fn respond_413() -> Response<std::io::Cursor<Vec<u8>>> {
    respond_json(
        StatusCode(413),
        &serde_json::json!({ "error": "Request body is too large" }),
    )
}

fn normalize_extension_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("URL is required".to_string());
    }
    if trimmed.len() > MAX_EXTENSION_URL_LENGTH {
        return Err("URL is too long".to_string());
    }
    let parsed = Url::parse(trimmed).map_err(|_| "Invalid URL format".to_string())?;
    let scheme = parsed.scheme().to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err("Only http/https URLs are supported".to_string());
    }
    Ok(parsed.to_string())
}

fn read_pref_string(conn: &rusqlite::Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM preferences WHERE key = ?",
        [key],
        |r| r.get::<_, String>(0),
    )
    .ok()
}

fn pref_bool(conn: &rusqlite::Connection, key: &str, default: bool) -> bool {
    let raw = match read_pref_string(conn, key) {
        Some(v) => v,
        None => return default,
    };
    match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => true,
        "0" | "false" | "no" | "off" => false,
        _ => default,
    }
}

fn current_language(conn: &rusqlite::Connection) -> String {
    let lang = read_pref_string(conn, PREF_LANGUAGE).unwrap_or_else(|| "en".to_string());
    if lang.trim().eq_ignore_ascii_case("uz") {
        "uz".to_string()
    } else {
        "en".to_string()
    }
}

fn picker_collections(conn: &rusqlite::Connection) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT c.id, c.name, c.updated_at, COUNT(ci.inspiration_id) AS item_count
             FROM collections c
             LEFT JOIN collection_items ci ON ci.collection_id = c.id
             GROUP BY c.id, c.name, c.updated_at",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut out: Vec<(String, String, i64, i64)> = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }

    let last_used = read_pref_string(conn, PREF_EXTENSION_PICKER_LAST_COLLECTION_ID).unwrap_or_default();
    out.sort_by(|a, b| {
        let a_last = !last_used.is_empty() && a.0 == last_used;
        let b_last = !last_used.is_empty() && b.0 == last_used;
        if a_last != b_last {
            return b_last.cmp(&a_last);
        }
        b.2.cmp(&a.2).then_with(|| a.1.to_lowercase().cmp(&b.1.to_lowercase()))
    });

    Ok(out
        .into_iter()
        .map(|(id, name, updated_at, item_count)| {
            serde_json::json!({
                "id": id,
                "name": name,
                "updated_at": updated_at,
                "item_count": item_count
            })
        })
        .collect())
}

fn ensure_collection_for_picker(conn: &rusqlite::Connection, payload: &Value) -> Result<String, String> {
    if let Some(cid) = payload
        .get("collectionId")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        let exists: Option<String> = conn
            .query_row("SELECT id FROM collections WHERE id = ?", [cid], |r| r.get(0))
            .ok();
        if exists.is_none() {
            return Err("Collection not found".to_string());
        }
        return Ok(cid.to_string());
    }

    let name = payload
        .get("newCollectionName")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Collection id or new collection name is required".to_string())?;

    let duplicate: Option<String> = conn
        .query_row(
            "SELECT id FROM collections WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) LIMIT 1",
            [name],
            |r| r.get(0),
        )
        .ok();
    if duplicate.is_some() {
        return Err("collection_name_exists".to_string());
    }

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO collections (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
        rusqlite::params![&id, &name, ts, ts],
    )
    .map_err(|e| e.to_string())?;
    Ok(id)
}

fn find_latest_inspiration_id_by_url(conn: &rusqlite::Connection, url: &str) -> Option<String> {
    conn.query_row(
        "SELECT id FROM inspirations WHERE source_url = ? ORDER BY created_at DESC LIMIT 1",
        [url],
        |r| r.get::<_, String>(0),
    )
    .ok()
}

fn assign_latest_to_collection(conn: &rusqlite::Connection, payload: &Value) -> Result<Value, String> {
    let raw_url = payload
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "url is required".to_string())?;
    let url = normalize_extension_url(raw_url)?;
    let collection_id = ensure_collection_for_picker(conn, payload)?;
    let inspiration_id = find_latest_inspiration_id_by_url(conn, &url)
        .ok_or_else(|| "inspiration_not_found".to_string())?;

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    conn.execute(
        "DELETE FROM collection_items WHERE inspiration_id = ?",
        rusqlite::params![&inspiration_id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO collection_items (collection_id, inspiration_id, position, created_at) VALUES (?, ?, 0, ?)",
        rusqlite::params![&collection_id, &inspiration_id, ts],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE collections SET updated_at = ? WHERE id = ?",
        rusqlite::params![ts, &collection_id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO preferences(key, value) VALUES (?, ?)",
        rusqlite::params![PREF_EXTENSION_PICKER_LAST_COLLECTION_ID, &collection_id],
    )
    .map_err(|e| e.to_string())?;

    Ok(serde_json::json!({
        "ok": true,
        "collection_id": collection_id,
        "inspiration_id": inspiration_id
    }))
}

fn export_full_collection_pack(
    conn: &rusqlite::Connection,
    vault_root: &Path,
    collection_id: &str,
) -> Result<Vec<u8>, String> {
    let pack_name: String = conn
        .query_row(
            "SELECT name FROM collections WHERE id = ? LIMIT 1",
            [collection_id],
            |r| r.get::<_, String>(0),
        )
        .map_err(|_| "Collection not found".to_string())?;
    let tmp_path = std::env::temp_dir().join(format!(
        "qooti-export-full-{}-{}.qooti",
        collection_id,
        uuid::Uuid::new_v4()
    ));
    crate::pack::export_collection(
        conn,
        vault_root,
        collection_id,
        &tmp_path,
        None,
        &pack_name,
        None,
        None::<fn(&str, u8)>,
    )?;
    let bytes = std::fs::read(&tmp_path).map_err(|e| format!("Failed reading exported pack: {}", e))?;
    let _ = std::fs::remove_file(&tmp_path);
    Ok(bytes)
}

pub fn spawn(db_path: std::path::PathBuf, vault_root: PathBuf, queue: Arc<Mutex<VecDeque<Value>>>) {
    thread::spawn(move || {
        let addr = format!("127.0.0.1:{}", PORT);
        let server = match Server::http(&addr) {
            Ok(s) => s,
            Err(e) => {
                log::warn!(
                    "[extension] Could not start local server on {}: {}",
                    addr,
                    e
                );
                return;
            }
        };
        info!("[extension] Listening on http://{}", addr);
        let key_name_lower = "x-qooti-key";
        for mut request in server.incoming_requests() {
            let req_start = std::time::Instant::now();
            let method_str = format!("{}", request.method());
            let path_only = request
                .url()
                .split('?')
                .next()
                .unwrap_or("")
                .to_string();
            let client_key: String = request
                .headers()
                .iter()
                .find(|h| h.field.to_string().to_lowercase() == key_name_lower)
                .map(|h| h.value.as_str().trim().to_string())
                .unwrap_or_default();

            if client_key.is_empty() {
                warn!(
                    "[server] rejected | method={} | path={} | reason=missing_key | duration={}ms",
                    method_str,
                    path_only,
                    req_start.elapsed().as_millis()
                );
                let _ = request.respond(respond_401());
                continue;
            }

            let stored_key = match get_key_from_db(&db_path) {
                Some(k) => k,
                None => {
                    warn!(
                        "[server] rejected | method={} | path={} | reason=no_stored_key | duration={}ms",
                        method_str,
                        path_only,
                        req_start.elapsed().as_millis()
                    );
                    let _ = request.respond(respond_401());
                    continue;
                }
            };

            if client_key != stored_key.trim() {
                warn!(
                    "[server] rejected | method={} | path={} | reason=invalid_key | duration={}ms",
                    method_str,
                    path_only,
                    req_start.elapsed().as_millis()
                );
                let _ = request.respond(respond_401());
                continue;
            }

            update_last_connection(&db_path);

            debug!(
                "[server] request | method={} | path={}",
                method_str, path_only
            );

            let path = request.url().split('?').next().unwrap_or("");
            if *request.method() == Method::Options
                && (path == "/qooti/add"
                    || path == "/qooti/handshake"
                    || path == "/qooti/picker/config"
                    || path == "/qooti/picker/collections"
                    || path == "/qooti/picker/assign")
            {
                let r = Response::from_string("")
                    .with_status_code(StatusCode(204))
                    .with_header(cors_header());
                let _ = request.respond(r);
                continue;
            }
            match (request.method().clone(), path) {
                (Method::Post, "/qooti/handshake") => {
                    let ts = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0);
                    let body = if let Ok(conn) = rusqlite::Connection::open(&db_path) {
                        serde_json::json!({
                            "ok": true,
                            "lastConnection": ts,
                            "language": current_language(&conn),
                            "showCollectionPicker": pref_bool(&conn, PREF_EXTENSION_PICKER_ENABLED, true)
                        })
                    } else {
                        serde_json::json!({
                            "ok": true,
                            "lastConnection": ts,
                            "language": "en",
                            "showCollectionPicker": true
                        })
                    };
                    debug!(
                        "[server] response | method={} | path={} | status=200 | duration={}ms",
                        method_str,
                        path_only,
                        req_start.elapsed().as_millis()
                    );
                    let _ = request.respond(respond_json(StatusCode(200), &body));
                }
                (Method::Post, "/qooti/picker/config") => {
                    let body = if let Ok(conn) = rusqlite::Connection::open(&db_path) {
                        serde_json::json!({
                            "ok": true,
                            "language": current_language(&conn),
                            "showCollectionPicker": pref_bool(&conn, PREF_EXTENSION_PICKER_ENABLED, true)
                        })
                    } else {
                        serde_json::json!({
                            "ok": true,
                            "language": "en",
                            "showCollectionPicker": true
                        })
                    };
                    debug!(
                        "[server] response | method={} | path={} | status=200 | duration={}ms",
                        method_str,
                        path_only,
                        req_start.elapsed().as_millis()
                    );
                    let _ = request.respond(respond_json(StatusCode(200), &body));
                }
                (Method::Post, "/qooti/picker/collections") => {
                    let mut body = Vec::new();
                    if request
                        .as_reader()
                        .take((MAX_REQUEST_BODY_BYTES + 1) as u64)
                        .read_to_end(&mut body)
                        .is_err()
                    {
                        let _ = request.respond(respond_400("Failed to read request body"));
                        continue;
                    }
                    let conn = match rusqlite::Connection::open(&db_path) {
                        Ok(c) => c,
                        Err(_) => {
                            let _ = request.respond(respond_400("Could not open database"));
                            continue;
                        }
                    };
                    match picker_collections(&conn) {
                        Ok(collections) => {
                            debug!(
                                "[server] response | method={} | path={} | status=200 | duration={}ms | collections_count={}",
                                method_str,
                                path_only,
                                req_start.elapsed().as_millis(),
                                collections.len()
                            );
                            let _ = request.respond(respond_json(
                                StatusCode(200),
                                &serde_json::json!({
                                    "ok": true,
                                    "collections": collections,
                                    "language": current_language(&conn),
                                    "showCollectionPicker": pref_bool(&conn, PREF_EXTENSION_PICKER_ENABLED, true)
                                }),
                            ));
                        }
                        Err(err) => {
                            warn!(
                                "[server] response | method={} | path={} | status=400 | duration={}ms | error={}",
                                method_str,
                                path_only,
                                req_start.elapsed().as_millis(),
                                err
                            );
                            let _ = request.respond(respond_400(&err));
                        }
                    }
                }
                (Method::Post, "/qooti/picker/assign") => {
                    let mut body = Vec::new();
                    if request
                        .as_reader()
                        .take((MAX_REQUEST_BODY_BYTES + 1) as u64)
                        .read_to_end(&mut body)
                        .is_err()
                    {
                        let _ = request.respond(respond_400("Failed to read request body"));
                        continue;
                    }
                    if body.len() > MAX_REQUEST_BODY_BYTES {
                        let _ = request.respond(respond_413());
                        continue;
                    }
                    let payload = match serde_json::from_slice::<Value>(&body) {
                        Ok(v) => v,
                        Err(_) => {
                            let _ = request.respond(respond_400("Invalid JSON body"));
                            continue;
                        }
                    };
                    let conn = match rusqlite::Connection::open(&db_path) {
                        Ok(c) => c,
                        Err(_) => {
                            let _ = request.respond(respond_400("Could not open database"));
                            continue;
                        }
                    };
                    match assign_latest_to_collection(&conn, &payload) {
                        Ok(resp) => {
                            debug!(
                                "[server] response | method={} | path={} | status=200 | duration={}ms",
                                method_str,
                                path_only,
                                req_start.elapsed().as_millis()
                            );
                            let _ = request.respond(respond_json(StatusCode(200), &resp));
                        }
                        Err(err) if err == "collection_name_exists" => {
                            warn!(
                                "[server] response | method={} | path={} | status=409 | duration={}ms",
                                method_str,
                                path_only,
                                req_start.elapsed().as_millis()
                            );
                            let _ = request.respond(respond_json(
                                StatusCode(409),
                                &serde_json::json!({ "error": err }),
                            ));
                        }
                        Err(err) if err == "inspiration_not_found" => {
                            warn!(
                                "[server] response | method={} | path={} | status=404 | duration={}ms",
                                method_str,
                                path_only,
                                req_start.elapsed().as_millis()
                            );
                            let _ = request.respond(respond_404(&err));
                        }
                        Err(err) => {
                            warn!(
                                "[server] response | method={} | path={} | status=400 | duration={}ms | error={}",
                                method_str,
                                path_only,
                                req_start.elapsed().as_millis(),
                                err
                            );
                            let _ = request.respond(respond_400(&err));
                        }
                    }
                }
                (Method::Post, path)
                    if path.starts_with("/qooti/generator/collections/")
                        && path.ends_with("/export-full") =>
                {
                    let collection_id = path
                        .trim_start_matches("/qooti/generator/collections/")
                        .trim_end_matches("/export-full")
                        .trim_matches('/')
                        .to_string();
                    if collection_id.is_empty() {
                        let _ = request.respond(respond_400("collection_id is required"));
                        continue;
                    }
                    let conn = match rusqlite::Connection::open(&db_path) {
                        Ok(c) => c,
                        Err(_) => {
                            let _ = request.respond(respond_400("Could not open database"));
                            continue;
                        }
                    };
                    match export_full_collection_pack(&conn, &vault_root, &collection_id) {
                        Ok(bytes) => {
                            let filename = format!("{}.qooti", collection_id);
                            let _ = request.respond(respond_binary(
                                StatusCode(200),
                                bytes,
                                "application/octet-stream",
                                Some(&filename),
                            ));
                        }
                        Err(err) => {
                            let _ = request.respond(respond_400(&err));
                        }
                    }
                }
                (Method::Post, "/qooti/add") => {
                    let mut body = Vec::new();
                    if request
                        .as_reader()
                        .take((MAX_REQUEST_BODY_BYTES + 1) as u64)
                        .read_to_end(&mut body)
                        .is_ok()
                    {
                        if body.len() > MAX_REQUEST_BODY_BYTES {
                            let _ = request.respond(respond_413());
                            continue;
                        }
                        match serde_json::from_slice::<Value>(&body) {
                            Ok(mut v) => {
                                let action = v
                                    .get("action")
                                    .and_then(|a| a.as_str())
                                    .unwrap_or("add")
                                    .to_string();
                                let url = v.get("url").and_then(|u| u.as_str()).unwrap_or("");
                                let normalized_url = match normalize_extension_url(url) {
                                    Ok(url) => url,
                                    Err(message) => {
                                        let _ = request.respond(respond_400(&message));
                                        continue;
                                    }
                                };
                                if let Some(url_value) = v.get_mut("url") {
                                    *url_value = Value::String(normalized_url.clone());
                                }
                                let url_host = Url::parse(&normalized_url)
                                    .ok()
                                    .and_then(|u| u.host_str().map(|h| h.to_string()))
                                    .unwrap_or_else(|| "unknown".to_string());
                                info!(
                                    "[server] add queued | action={} | host={} | duration={}ms",
                                    action,
                                    url_host,
                                    req_start.elapsed().as_millis()
                                );
                                queue.lock().unwrap().push_back(v);
                            }
                            Err(e) => {
                                log::warn!("[extension] Invalid JSON body: {}", e);
                                let _ = request.respond(respond_400("Invalid JSON body"));
                                continue;
                            }
                        }
                    } else {
                        log::warn!("[extension] Failed to read request body");
                        let _ = request.respond(respond_400("Failed to read request body"));
                        continue;
                    }
                    debug!(
                        "[server] response | method={} | path={} | status=200 | duration={}ms",
                        method_str,
                        path_only,
                        req_start.elapsed().as_millis()
                    );
                    let _ = request.respond(respond_json(
                        StatusCode(200),
                        &serde_json::json!({ "ok": true }),
                    ));
                }
                _ => {
                    debug!(
                        "[server] response | method={} | path={} | status=404 | duration={}ms",
                        method_str,
                        path_only,
                        req_start.elapsed().as_millis()
                    );
                    let r = Response::from_string("")
                        .with_status_code(StatusCode(404))
                        .with_header(cors_header());
                    let _ = request.respond(r);
                }
            }
        }
    });
}
