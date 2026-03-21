//! Local HTTP server for Chrome extension. Verifies connection key and queues add requests.

use log::info;
use serde_json::Value;
use std::collections::VecDeque;
#[allow(unused_imports)]
use std::io::Read;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread;
use tiny_http::{Method, Response, Server, StatusCode};
use url::Url;

pub struct ExtensionQueue(pub Arc<Mutex<VecDeque<Value>>>);

const PREF_EXTENSION_KEY: &str = "extension_connection_key";
const PREF_EXTENSION_LAST: &str = "extension_last_connection_ts";
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

fn respond_401() -> Response<std::io::Cursor<Vec<u8>>> {
    respond_json(
        StatusCode(401),
        &serde_json::json!({ "error": "Invalid or missing connection key" }),
    )
}

fn respond_400(message: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    respond_json(StatusCode(400), &serde_json::json!({ "error": message }))
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

pub fn spawn(db_path: std::path::PathBuf, queue: Arc<Mutex<VecDeque<Value>>>) {
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
            let client_key: String = request
                .headers()
                .iter()
                .find(|h| h.field.to_string().to_lowercase() == key_name_lower)
                .map(|h| h.value.as_str().trim().to_string())
                .unwrap_or_default();

            if client_key.is_empty() {
                log::warn!("[extension] /qooti/add or /qooti/handshake: missing X-Qooti-Key");
                let _ = request.respond(respond_401());
                continue;
            }

            let stored_key = match get_key_from_db(&db_path) {
                Some(k) => k,
                None => {
                    log::warn!("[extension] No connection key in preferences");
                    let _ = request.respond(respond_401());
                    continue;
                }
            };

            if client_key != stored_key.trim() {
                log::warn!("[extension] Invalid connection key");
                let _ = request.respond(respond_401());
                continue;
            }

            update_last_connection(&db_path);

            let path = request.url().split('?').next().unwrap_or("");
            if *request.method() == Method::Options
                && (path == "/qooti/add" || path == "/qooti/handshake")
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
                    let body = serde_json::json!({ "ok": true, "lastConnection": ts });
                    let _ = request.respond(respond_json(StatusCode(200), &body));
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
                                    "[extension] Add request: action={} host={}",
                                    action,
                                    url_host
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
                    let _ = request.respond(respond_json(
                        StatusCode(200),
                        &serde_json::json!({ "ok": true }),
                    ));
                }
                _ => {
                    let r = Response::from_string("")
                        .with_status_code(StatusCode(404))
                        .with_header(cors_header());
                    let _ = request.respond(r);
                }
            }
        }
    });
}
