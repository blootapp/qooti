// Collection pack export/import (.qooti format, encrypted container)

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::Engine;
use image::imageops::FilterType;
use image::{ImageBuffer, Rgba};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::Path;
use uuid::Uuid;

use crate::tags;

const MAGIC: &[u8; 8] = b"QOOTIPK1";
const NONCE_LEN: usize = 12;
const KEY_SEED: &str = "qooti-pack-internal-v1::desktop";
const MANIFEST_PATH: &str = "manifest.json";
const PROFILE_IMAGE_PATH: &str = "profile/profile.png";
const MEDIA_PREFIX: &str = "media/";
const PACK_VERSION: u32 = 1;
const FORMAT_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Clone)]
pub struct PackManifest {
    pub meta: PackMeta,
    pub collection: PackCollection,
    pub profile_image: PackProfileImage,
    pub items: Vec<PackItem>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct PackMeta {
    pub pack_id: String,
    pub pack_version: u32,
    pub format_version: u32,
    pub app_version: Option<String>,
    pub exported_at: i64,
    pub signature: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct PackCollection {
    pub name: String,
    pub created_at: i64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct PackProfileImage {
    pub path: String,
    pub mime: String,
    pub width: u32,
    pub height: u32,
    pub generated_default: bool,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct PackItem {
    pub original_id: String,
    pub r#type: String,
    pub filename: String,
    pub content_hash: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub palette: Option<serde_json::Value>,
    #[serde(default)]
    pub metadata: PackItemMetadata,
}

#[derive(Clone, Serialize, Deserialize, Default)]
pub struct PackItemMetadata {
    pub title: Option<String>,
    pub source_url: Option<String>,
    pub original_filename: Option<String>,
    pub aspect_ratio: Option<f64>,
}

#[derive(Serialize, Deserialize)]
pub struct PackPreview {
    pub pack_id: String,
    pub name: String,
    pub item_count: usize,
    pub exported_at: i64,
    pub app_version: Option<String>,
    pub pack_version: u32,
    pub format_version: u32,
    pub profile_image_data_url: String,
}

fn rel_to_vault(vault_root: &Path, abs: &Path) -> String {
    abs.strip_prefix(vault_root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| abs.to_string_lossy().replace('\\', "/"))
}

fn hex_sha256(bytes: &[u8]) -> String {
    let hash = Sha256::digest(bytes);
    hash.iter()
        .map(|b| format!("{:02x}", b))
        .collect::<String>()
}

fn derive_key() -> [u8; 32] {
    let hash = Sha256::digest(KEY_SEED.as_bytes());
    let mut out = [0u8; 32];
    out.copy_from_slice(&hash[..32]);
    out
}

fn encrypt_blob(plain: &[u8]) -> Result<Vec<u8>, String> {
    let key = derive_key();
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let mut nonce = [0u8; NONCE_LEN];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut nonce);
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), plain)
        .map_err(|_| "Encryption failed".to_string())?;

    let mut out = Vec::with_capacity(MAGIC.len() + NONCE_LEN + ciphertext.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

fn decrypt_blob(raw: &[u8]) -> Result<Vec<u8>, String> {
    if raw.len() < MAGIC.len() + NONCE_LEN {
        return Err("Invalid pack: file too small".to_string());
    }
    if &raw[..MAGIC.len()] != MAGIC {
        return Err("Invalid pack: unsupported format".to_string());
    }
    let nonce_start = MAGIC.len();
    let nonce_end = nonce_start + NONCE_LEN;
    let nonce = &raw[nonce_start..nonce_end];
    let ciphertext = &raw[nonce_end..];

    let key = derive_key();
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    cipher
        .decrypt(Nonce::from_slice(nonce), ciphertext)
        .map_err(|_| "Pack is corrupted or tampered".to_string())
}

fn decode_image_data_url(data_url: &str) -> Result<Vec<u8>, String> {
    let s = data_url.trim();
    if !s.starts_with("data:image/") {
        return Err("Profile image must be an image data URL".to_string());
    }
    let base64_idx = s
        .find(";base64,")
        .ok_or_else(|| "Profile image must be base64 encoded".to_string())?;
    let payload = &s[(base64_idx + ";base64,".len())..];
    base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|_| "Invalid profile image encoding".to_string())
}

fn resize_image_to_png_512(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let img =
        image::load_from_memory(bytes).map_err(|_| "Could not read profile image".to_string())?;
    let out = img
        .resize_to_fill(512, 512, FilterType::Lanczos3)
        .to_rgba8();
    let mut buf = Vec::new();
    image::DynamicImage::ImageRgba8(out)
        .write_to(&mut Cursor::new(&mut buf), image::ImageFormat::Png)
        .map_err(|_| "Could not encode profile image".to_string())?;
    Ok(buf)
}

fn glyph_for(c: char) -> [u8; 7] {
    match c.to_ascii_uppercase() {
        'A' => [
            0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001,
        ],
        'B' => [
            0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110,
        ],
        'C' => [
            0b01111, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b01111,
        ],
        'D' => [
            0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110,
        ],
        'E' => [
            0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111,
        ],
        'F' => [
            0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000,
        ],
        'G' => [
            0b01110, 0b10001, 0b10000, 0b10011, 0b10001, 0b10001, 0b01110,
        ],
        'H' => [
            0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001,
        ],
        'I' => [
            0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b11111,
        ],
        'J' => [
            0b11111, 0b00010, 0b00010, 0b00010, 0b10010, 0b10010, 0b01100,
        ],
        'K' => [
            0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001,
        ],
        'L' => [
            0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111,
        ],
        'M' => [
            0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001,
        ],
        'N' => [
            0b10001, 0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001,
        ],
        'O' => [
            0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110,
        ],
        'P' => [
            0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000,
        ],
        'Q' => [
            0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10010, 0b01101,
        ],
        'R' => [
            0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001,
        ],
        'S' => [
            0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110,
        ],
        'T' => [
            0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100,
        ],
        'U' => [
            0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110,
        ],
        'V' => [
            0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b01010, 0b00100,
        ],
        'W' => [
            0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b10101, 0b01010,
        ],
        'X' => [
            0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b01010, 0b10001,
        ],
        'Y' => [
            0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100,
        ],
        'Z' => [
            0b11111, 0b00010, 0b00100, 0b00100, 0b01000, 0b10000, 0b11111,
        ],
        '0' => [
            0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110,
        ],
        '1' => [
            0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110,
        ],
        '2' => [
            0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111,
        ],
        '3' => [
            0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110,
        ],
        '4' => [
            0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010,
        ],
        '5' => [
            0b11111, 0b10000, 0b10000, 0b11110, 0b00001, 0b00001, 0b11110,
        ],
        '6' => [
            0b01110, 0b10000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110,
        ],
        '7' => [
            0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000,
        ],
        '8' => [
            0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110,
        ],
        '9' => [
            0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00001, 0b01110,
        ],
        _ => [
            0b01110, 0b10001, 0b00001, 0b00110, 0b00100, 0b00000, 0b00100,
        ],
    }
}

fn generated_color(name: &str) -> [u8; 3] {
    let hash = Sha256::digest(name.as_bytes());
    let r = 80 + (hash[0] % 110);
    let g = 80 + (hash[1] % 110);
    let b = 80 + (hash[2] % 110);
    [r, g, b]
}

fn generate_default_profile_png(name: &str) -> Result<Vec<u8>, String> {
    let mut img: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::new(512, 512);
    let [r, g, b] = generated_color(name);
    for p in img.pixels_mut() {
        *p = Rgba([r, g, b, 255]);
    }

    let initial = name
        .chars()
        .find(|c| c.is_ascii_alphanumeric())
        .unwrap_or('Q')
        .to_ascii_uppercase();
    let glyph = glyph_for(initial);
    let scale = 52u32;
    let glyph_w = 5 * scale;
    let glyph_h = 7 * scale;
    let start_x = (512 - glyph_w) / 2;
    let start_y = (512 - glyph_h) / 2;
    for (row, bits) in glyph.iter().enumerate() {
        for col in 0..5u32 {
            if (bits & (1 << (4 - col))) != 0 {
                let x0 = start_x + col * scale;
                let y0 = start_y + row as u32 * scale;
                for y in y0..(y0 + scale) {
                    for x in x0..(x0 + scale) {
                        img.put_pixel(x, y, Rgba([255, 255, 255, 255]));
                    }
                }
            }
        }
    }

    let mut out = Vec::new();
    image::DynamicImage::ImageRgba8(img)
        .write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|_| "Could not generate default profile image".to_string())?;
    Ok(out)
}

fn read_manifest_and_profile(zip_bytes: &[u8]) -> Result<(PackManifest, Vec<u8>), String> {
    let cursor = Cursor::new(zip_bytes);
    let mut zip = zip::ZipArchive::new(cursor).map_err(|_| "Invalid pack archive".to_string())?;
    let manifest_data = {
        let mut f = zip
            .by_name(MANIFEST_PATH)
            .map_err(|_| "Invalid pack: missing manifest".to_string())?;
        let mut buf = Vec::new();
        f.read_to_end(&mut buf)
            .map_err(|_| "Invalid pack manifest".to_string())?;
        String::from_utf8(buf).map_err(|_| "Invalid manifest encoding".to_string())?
    };
    let manifest: PackManifest = serde_json::from_str(&manifest_data)
        .map_err(|_| "Invalid pack manifest JSON".to_string())?;
    if manifest.meta.format_version > FORMAT_VERSION {
        return Err("Pack format is newer than this app version".to_string());
    }
    let profile_bytes = {
        let mut pf = zip
            .by_name(&manifest.profile_image.path)
            .map_err(|_| "Invalid pack: missing profile image".to_string())?;
        let mut buf = Vec::new();
        pf.read_to_end(&mut buf)
            .map_err(|_| "Invalid pack profile image".to_string())?;
        buf
    };
    Ok((manifest, profile_bytes))
}

fn verify_signature(manifest: &PackManifest) -> bool {
    let mut copy = manifest.clone();
    let sig = copy.meta.signature.clone();
    copy.meta.signature.clear();
    let json = serde_json::to_vec(&copy).unwrap_or_default();
    sig == hex_sha256(&json)
}

fn notify_export_progress<F: FnMut(&str, u8)>(cb: &mut Option<F>, message: &str, percent: u8) {
    if let Some(f) = cb.as_mut() {
        f(message, percent.min(100));
    }
}

/// Export a collection to encrypted .qooti file. Returns (saved_path, items_bundled, items_skipped).
/// `on_progress` receives `(message, percent)` with `percent` in 0..=100.
pub fn export_collection<F>(
    conn: &Connection,
    vault_root: &Path,
    collection_id: &str,
    out_path: &Path,
    app_version: Option<&str>,
    pack_name: &str,
    profile_image_data_url: Option<&str>,
    mut on_progress: Option<F>,
) -> Result<(String, usize, usize), String>
where
    F: FnMut(&str, u8),
{
    let (_, created_at): (String, i64) = conn
        .query_row(
            "SELECT name, created_at FROM collections WHERE id = ?",
            [collection_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| e.to_string())?;

    let items: Vec<String> = conn
        .prepare(
            "SELECT inspiration_id FROM collection_items WHERE collection_id = ? ORDER BY created_at DESC, position ASC",
        )
        .map_err(|e| e.to_string())?
        .query_map([collection_id], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    notify_export_progress(&mut on_progress, "Preparing export…", 0);

    let mut pack_items: Vec<(PackItem, Vec<u8>)> = Vec::new();
    let mut bundled = 0usize;
    let mut skipped = 0usize;

    let n_total = items.len().max(1);
    for (idx, insp_id) in items.into_iter().enumerate() {
        let row: Option<(
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<f64>,
        )> = conn
            .query_row(
                "SELECT type, title, source_url, original_filename, stored_path, thumbnail_path, aspect_ratio FROM inspirations WHERE id = ?",
                [&insp_id],
                |r: &rusqlite::Row| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, Option<String>>(1)?,
                        r.get::<_, Option<String>>(2)?,
                        r.get::<_, Option<String>>(3)?,
                        r.get::<_, Option<String>>(4)?,
                        r.get::<_, Option<String>>(5)?,
                        r.get::<_, Option<f64>>(6)?,
                    ))
                },
            )
            .optional()
            .map_err(|e: rusqlite::Error| e.to_string())?;

        let Some((
            itype,
            title,
            source_url,
            original_filename,
            stored_path,
            thumbnail_path,
            aspect_ratio,
        )) = row
        else {
            skipped += 1;
            let pct = 4u8.saturating_add(((idx + 1) as u32 * 55 / n_total as u32) as u8);
            notify_export_progress(&mut on_progress, "Bundling media…", pct.min(58));
            continue;
        };

        let path_to_copy = match (&stored_path, &thumbnail_path, itype.as_str()) {
            (Some(sp), _, "image" | "gif" | "video") => Some(vault_root.join(sp)),
            (None, Some(tp), "link") => Some(vault_root.join(tp)),
            (Some(sp), _, "link") => Some(vault_root.join(sp)),
            (None, Some(tp), _) => Some(vault_root.join(tp)),
            _ => None,
        };
        let path_to_copy = match path_to_copy {
            Some(p) if p.exists() => p,
            _ => {
                skipped += 1;
                let pct = 4u8.saturating_add(((idx + 1) as u32 * 55 / n_total as u32) as u8);
                notify_export_progress(&mut on_progress, "Bundling media…", pct.min(58));
                continue;
            }
        };

        let bytes = fs::read(&path_to_copy).map_err(|e| e.to_string())?;
        let content_hash = hex_sha256(&bytes);
        let ext = path_to_copy
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("bin");
        let filename = format!("inspiration_{}.{}", &insp_id[..8.min(insp_id.len())], ext);
        let tags: Vec<String> = conn
            .prepare("SELECT t.label FROM inspiration_tags it JOIN tags t ON t.id = it.tag_id WHERE it.inspiration_id = ?")
            .ok()
            .and_then(|mut st| st.query_map([&insp_id], |r| r.get(0)).ok().map(|iter| iter.filter_map(|x| x.ok()).collect()))
            .unwrap_or_default();
        let palette: Option<serde_json::Value> = conn
            .query_row(
                "SELECT palette FROM inspirations WHERE id = ?",
                [&insp_id],
                |r: &rusqlite::Row| r.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|e: rusqlite::Error| e.to_string())?
            .flatten()
            .and_then(|s| serde_json::from_str(&s).ok());

        let pack_item = PackItem {
            original_id: insp_id.clone(),
            r#type: itype,
            filename: filename.clone(),
            content_hash,
            tags,
            palette,
            metadata: PackItemMetadata {
                title,
                source_url,
                original_filename,
                aspect_ratio,
            },
        };
        pack_items.push((pack_item, bytes));
        bundled += 1;
        let pct = 4u8.saturating_add(((idx + 1) as u32 * 55 / n_total as u32) as u8);
        notify_export_progress(&mut on_progress, "Bundling media…", pct.min(58));
    }

    notify_export_progress(&mut on_progress, "Creating profile image…", 60);

    let profile_png =
        if let Some(data_url) = profile_image_data_url.filter(|s| !s.trim().is_empty()) {
            let raw = decode_image_data_url(data_url)?;
            resize_image_to_png_512(&raw)?
        } else {
            generate_default_profile_png(pack_name)?
        };

    let exported_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let mut manifest = PackManifest {
        meta: PackMeta {
            pack_id: Uuid::new_v4().to_string(),
            pack_version: PACK_VERSION,
            format_version: FORMAT_VERSION,
            app_version: app_version.map(|s| s.to_string()),
            exported_at,
            signature: String::new(),
        },
        collection: PackCollection {
            name: pack_name.to_string(),
            created_at,
        },
        profile_image: PackProfileImage {
            path: PROFILE_IMAGE_PATH.to_string(),
            mime: "image/png".to_string(),
            width: 512,
            height: 512,
            generated_default: profile_image_data_url.is_none()
                || profile_image_data_url == Some(""),
        },
        items: pack_items.iter().map(|(i, _)| i.clone()).collect(),
    };

    notify_export_progress(&mut on_progress, "Writing archive…", 64);

    let mut sig_copy = manifest.clone();
    sig_copy.meta.signature.clear();
    manifest.meta.signature =
        hex_sha256(&serde_json::to_vec(&sig_copy).map_err(|e| e.to_string())?);

    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::<u8>::new()));
    let opts: zip::write::FileOptions<()> =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    zip.start_file(MANIFEST_PATH, opts)
        .map_err(|e| e.to_string())?;
    zip.write_all(
        serde_json::to_string_pretty(&manifest)
            .map_err(|e| e.to_string())?
            .as_bytes(),
    )
    .map_err(|e| e.to_string())?;
    zip.start_file(PROFILE_IMAGE_PATH, opts)
        .map_err(|e| e.to_string())?;
    zip.write_all(&profile_png).map_err(|e| e.to_string())?;

    notify_export_progress(&mut on_progress, "Compressing media…", 68);

    let n_media = pack_items.len().max(1);
    for (j, (item, bytes)) in pack_items.iter().enumerate() {
        let media_path = format!("{}{}", MEDIA_PREFIX, item.filename);
        zip.start_file(&media_path, opts)
            .map_err(|e| e.to_string())?;
        zip.write_all(bytes).map_err(|e| e.to_string())?;
        let pct = 68u8 + ((j + 1) as u32 * 22 / n_media as u32) as u8;
        notify_export_progress(&mut on_progress, "Compressing media…", pct.min(90));
    }
    let zip_cursor = zip.finish().map_err(|e| e.to_string())?;

    notify_export_progress(&mut on_progress, "Encrypting pack…", 92);

    let encrypted = encrypt_blob(&zip_cursor.into_inner())?;

    notify_export_progress(&mut on_progress, "Saving file…", 96);

    fs::write(out_path, encrypted).map_err(|e| e.to_string())?;

    notify_export_progress(&mut on_progress, "Finished", 100);

    Ok((out_path.to_string_lossy().to_string(), bundled, skipped))
}

pub fn inspect_pack(pack_path: &Path) -> Result<PackPreview, String> {
    let raw = fs::read(pack_path).map_err(|e| e.to_string())?;
    let decrypted = decrypt_blob(&raw)?;
    let (manifest, profile_bytes) = read_manifest_and_profile(&decrypted)?;
    if !verify_signature(&manifest) {
        return Err("Pack signature validation failed".to_string());
    }
    let profile_data_url = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(profile_bytes)
    );
    Ok(PackPreview {
        pack_id: manifest.meta.pack_id,
        name: manifest.collection.name,
        item_count: manifest.items.len(),
        exported_at: manifest.meta.exported_at,
        app_version: manifest.meta.app_version,
        pack_version: manifest.meta.pack_version,
        format_version: manifest.meta.format_version,
        profile_image_data_url: profile_data_url,
    })
}

/// Import encrypted .qooti file. Returns (collection_id, collection_name, items_imported, errors).
pub fn import_pack(
    conn: &Connection,
    vault_root: &Path,
    pack_path: &Path,
) -> Result<(String, String, usize, Vec<String>), String> {
    let raw = fs::read(pack_path).map_err(|e| e.to_string())?;
    let decrypted = decrypt_blob(&raw)?;
    let (manifest, profile_bytes) = read_manifest_and_profile(&decrypted)?;
    if !verify_signature(&manifest) {
        return Err("Pack signature validation failed".to_string());
    }

    // Use clean display name: strip any internal "(Imported <timestamp>)" suffix so it never appears in UI.
    let raw = manifest.collection.name.trim();
    let base_name: String = regex::Regex::new(r"(?i)\s*\(Imported\s+\d+\)\s*$")
        .ok()
        .map(|re| re.replace(raw, "").trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| raw.to_string());
    let base_name = base_name.trim();
    let base_name = if base_name.is_empty() {
        "Imported pack"
    } else {
        base_name
    };
    let mut name = base_name.to_string();
    // Ensure unique display name: use "Name (2)", "Name (3)", etc. No timestamp in UI.
    for n in 1..=999 {
        let candidate = if n == 1 {
            base_name.to_string()
        } else {
            format!("{} ({})", base_name, n)
        };
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM collections WHERE name = ? LIMIT 1",
                [&candidate],
                |r: &rusqlite::Row| r.get::<_, i32>(0),
            )
            .optional()
            .map_err(|e: rusqlite::Error| e.to_string())?
            .is_some();
        if !exists {
            name = candidate;
            break;
        }
    }

    let collection_id = Uuid::new_v4().to_string();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    conn.execute(
        "INSERT INTO collections (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
        rusqlite::params![collection_id, name, ts, ts],
    )
    .map_err(|e| e.to_string())?;

    let media_dir = vault_root.join("media");
    let thumbs_dir = vault_root.join("thumbnails");
    let profile_dir = vault_root.join("collection_profiles");
    fs::create_dir_all(&media_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(&thumbs_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(&profile_dir).map_err(|e| e.to_string())?;
    let _ = fs::write(
        profile_dir.join(format!("{}.png", collection_id)),
        &profile_bytes,
    );

    let mut zip = zip::ZipArchive::new(Cursor::new(decrypted))
        .map_err(|_| "Invalid pack archive".to_string())?;
    let mut imported = 0usize;
    let mut errors = Vec::new();

    for (pos, item) in manifest.items.iter().enumerate() {
        let media_path = format!("{}{}", MEDIA_PREFIX, item.filename);
        let mut entry = match zip.by_name(&media_path) {
            Ok(e) => e,
            Err(_) => {
                errors.push(format!("{}: missing media entry", item.filename));
                continue;
            }
        };
        let mut buf = Vec::new();
        if entry.read_to_end(&mut buf).is_err() {
            errors.push(format!("{}: failed to read media", item.filename));
            continue;
        }
        if item.content_hash != hex_sha256(&buf) {
            errors.push(format!("{}: hash mismatch", item.filename));
            continue;
        }

        let existing_id: Option<String> = if let Some(url) = item
            .metadata
            .source_url
            .as_ref()
            .filter(|s| !s.trim().is_empty())
        {
            conn.query_row(
                "SELECT id FROM inspirations WHERE source_url = ? LIMIT 1",
                [url],
                |r: &rusqlite::Row| r.get::<_, String>(0),
            )
            .optional()
            .map_err(|e: rusqlite::Error| e.to_string())?
        } else {
            None
        };

        let new_id = if let Some(ref existing) = existing_id {
            errors.push(format!("{}: duplicate, linking existing", item.filename));
            existing.clone()
        } else {
            Uuid::new_v4().to_string()
        };

        if existing_id.is_some() {
            // Link existing inspiration to this collection (so imported pack is not empty)
            let _ = conn.execute(
                "INSERT OR IGNORE INTO collection_items (collection_id, inspiration_id, position, created_at) VALUES (?, ?, ?, ?)",
                rusqlite::params![collection_id, &new_id, pos as i32, ts],
            );
            imported += 1;
            continue;
        }

        // New inspiration: write file and insert
        let ext = Path::new(&item.filename)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("bin");
        let dest_rel = format!("{}.{}", new_id, ext);
        let dest_path = match item.r#type.as_str() {
            "link" => thumbs_dir.join(&dest_rel),
            _ => media_dir.join(&dest_rel),
        };
        if fs::write(&dest_path, &buf).is_err() {
            errors.push(format!("{}: failed to write media", item.filename));
            continue;
        }

        let stored_rel = rel_to_vault(vault_root, &dest_path);
        let title = item
            .metadata
            .title
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| item.filename.clone());
        let source_url = item.metadata.source_url.clone();
        let aspect_ratio = item.metadata.aspect_ratio;
        let thumb_col = if item.r#type == "link" {
            Some(stored_rel.clone())
        } else {
            None
        };
        let stored_col = if item.r#type == "link" {
            None
        } else {
            Some(stored_rel)
        };
        let palette_json = item
            .palette
            .as_ref()
            .and_then(|p| serde_json::to_string(p).ok());

        if conn
            .execute(
                r#"INSERT INTO inspirations (id, type, title, source_url, original_filename, stored_path, thumbnail_path, display_row, aspect_ratio, created_at, updated_at, palette)
                   VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)"#,
                rusqlite::params![
                    new_id,
                    item.r#type,
                    title,
                    source_url,
                    item.metadata
                        .original_filename
                        .clone()
                        .unwrap_or_else(|| item.filename.clone()),
                    stored_col,
                    thumb_col,
                    aspect_ratio,
                    ts,
                    ts,
                    palette_json,
                ],
            )
            .is_err()
        {
            let _ = fs::remove_file(&dest_path);
            errors.push(format!("{}: failed to create record", item.filename));
            continue;
        }

        for label in &item.tags {
            if let Ok(tag_id) = tags::ensure_tag(conn, label, "style", "user") {
                let _ = tags::attach_tag(conn, &new_id, &tag_id);
            }
        }
        conn.execute(
            "INSERT INTO collection_items (collection_id, inspiration_id, position, created_at) VALUES (?, ?, ?, ?)",
            rusqlite::params![collection_id, new_id, pos as i32, ts],
        )
        .map_err(|e| e.to_string())?;
        imported += 1;
    }

    conn.execute(
        "UPDATE collections SET updated_at = ? WHERE id = ?",
        rusqlite::params![ts, collection_id],
    )
    .map_err(|e| e.to_string())?;
    Ok((collection_id, name, imported, errors))
}
