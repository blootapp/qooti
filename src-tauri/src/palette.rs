// Color palette extraction and Find Similar
// Stores LAB colors for perceptual similarity

use image::{DynamicImage, ImageFormat};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Palette as LAB triples: [[L,a,b], ...] for perceptual similarity
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Palette {
    pub colors: Vec<[f32; 3]>,
}

/// Convert sRGB (0–255) to LAB for use in color filter and similarity.
pub fn rgb_to_lab(r: u8, g: u8, b: u8) -> [f32; 3] {
    use palette::white_point::D65;
    use palette::{FromColor, Lab, Srgb};
    let srgb = Srgb::new(r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0);
    let lab: Lab<D65, f32> = Lab::from_color(srgb.into_linear());
    [lab.l, lab.a, lab.b]
}

/// Approximate sRGB (0–255) from a stored LAB triple (inverse of [`rgb_to_lab`]).
pub fn lab_to_rgb(lab: &[f32; 3]) -> [u8; 3] {
    use palette::white_point::D65;
    use palette::{FromColor, Lab, Srgb};
    let l = Lab::<D65, f32>::new(lab[0], lab[1], lab[2]);
    let srgb_f: Srgb<f32> = Srgb::from_color(l);
    let srgb_u8: Srgb<u8> = srgb_f.into_format();
    [srgb_u8.red, srgb_u8.green, srgb_u8.blue]
}

/// Hex string for UI swatches (e.g. `#a1b2c3`).
pub fn lab_to_hex(lab: &[f32; 3]) -> String {
    let [r, g, b] = lab_to_rgb(lab);
    format!("#{:02x}{:02x}{:02x}", r, g, b)
}

/// Minimum LAB distance from a single color to any color in the palette.
/// Returns f32::MAX if the palette is empty (no match).
pub fn min_distance_to_palette(lab: &[f32; 3], p: &Palette) -> f32 {
    if p.colors.is_empty() {
        return f32::MAX;
    }
    p.colors
        .iter()
        .map(|c| lab_distance(lab, c))
        .fold(f32::MAX, f32::min)
}

/// Minimum LAB distance from a single color to the top-N dominant colors in a palette.
/// Dominance order is the extracted palette order (most dominant first).
pub fn min_distance_to_palette_top_n(lab: &[f32; 3], p: &Palette, top_n: usize) -> f32 {
    if p.colors.is_empty() || top_n == 0 {
        return f32::MAX;
    }
    p.colors
        .iter()
        .take(top_n)
        .map(|c| lab_distance(lab, c))
        .fold(f32::MAX, f32::min)
}

/// Weighted average distance from a single color to every palette color.
/// Dominant palette colors (first entries) get higher weight.
pub fn weighted_distance_to_palette(lab: &[f32; 3], p: &Palette) -> f32 {
    if p.colors.is_empty() {
        return f32::MAX;
    }
    fn weight(i: usize) -> f32 {
        if i == 0 {
            4.0
        } else if i == 1 {
            2.5
        } else {
            1.0
        }
    }
    let mut weighted_sum = 0.0f32;
    let mut wsum = 0.0f32;
    for (i, c) in p.colors.iter().enumerate() {
        let w = weight(i);
        weighted_sum += w * lab_distance(lab, c);
        wsum += w;
    }
    weighted_sum / wsum
}

fn strip_utf8_bom(bytes: &[u8]) -> &[u8] {
    if bytes.len() >= 3 && bytes[0..3] == [0xEF, 0xBB, 0xBF] {
        &bytes[3..]
    } else {
        bytes
    }
}

fn decode_explicit(slice: &[u8], fmt: ImageFormat) -> Result<DynamicImage, String> {
    image::load_from_memory_with_format(slice, fmt).map_err(|e| e.to_string())
}

fn format_from_mime(mime: &str) -> Option<ImageFormat> {
    let m = mime
        .split(';')
        .next()
        .unwrap_or(mime)
        .trim()
        .to_ascii_lowercase();
    match m.as_str() {
        "image/jpeg" | "image/jpg" | "image/pjpeg" => Some(ImageFormat::Jpeg),
        "image/png" | "image/x-png" => Some(ImageFormat::Png),
        "image/gif" => Some(ImageFormat::Gif),
        "image/webp" => Some(ImageFormat::WebP),
        "image/bmp" | "image/x-ms-bmp" => Some(ImageFormat::Bmp),
        "image/tiff" | "image/x-tiff" => Some(ImageFormat::Tiff),
        "image/x-icon" | "image/vnd.microsoft.icon" => Some(ImageFormat::Ico),
        "image/avif" | "image/heif" => Some(ImageFormat::Avif),
        _ => None,
    }
}

fn format_from_filename(name: &str) -> Option<ImageFormat> {
    let ext = Path::new(name)
        .extension()?
        .to_str()?
        .to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" | "jpe" => Some(ImageFormat::Jpeg),
        "png" => Some(ImageFormat::Png),
        "gif" => Some(ImageFormat::Gif),
        "webp" => Some(ImageFormat::WebP),
        "bmp" | "dib" => Some(ImageFormat::Bmp),
        "tif" | "tiff" => Some(ImageFormat::Tiff),
        "ico" => Some(ImageFormat::Ico),
        "avif" | "heif" | "heic" => Some(ImageFormat::Avif),
        _ => None,
    }
}

/// Try to find an embedded raster after an optional prefix (vault files have no extension; some
/// pipelines prepend metadata or the `image` crate misses format sniff on edge cases).
fn try_decode_after_magic_scan(slice: &[u8]) -> Option<DynamicImage> {
    const WIN: usize = 96 * 1024;
    let n = slice.len().min(WIN);

    let png_sig = [137u8, 80, 78, 71, 13, 10, 26, 10];
    let mut s = 0usize;
    while s + 8 <= n {
        if let Some(rel) = slice[s..n].windows(8).position(|w| w == png_sig) {
            let i = s + rel;
            if let Ok(img) = decode_explicit(&slice[i..], ImageFormat::Png) {
                return Some(img);
            }
            s = i + 1;
        } else {
            break;
        }
    }

    let mut jpeg_tries = 0u8;
    for i in 0..n.saturating_sub(3) {
        if slice[i] == 0xFF && slice[i + 1] == 0xD8 && slice[i + 2] == 0xFF {
            if let Ok(img) = decode_explicit(&slice[i..], ImageFormat::Jpeg) {
                return Some(img);
            }
            jpeg_tries += 1;
            if jpeg_tries >= 24 {
                break;
            }
        }
    }

    for i in 0..n.saturating_sub(12) {
        if slice.len() >= i + 12
            && &slice[i..i + 4] == b"RIFF"
            && &slice[i + 8..i + 12] == b"WEBP"
        {
            if let Ok(img) = decode_explicit(&slice[i..], ImageFormat::WebP) {
                return Some(img);
            }
        }
    }

    for i in 0..n.saturating_sub(6) {
        if &slice[i..i + 6] == b"GIF87a" || &slice[i..i + 6] == b"GIF89a" {
            if let Ok(img) = decode_explicit(&slice[i..], ImageFormat::Gif) {
                return Some(img);
            }
        }
    }

    None
}

fn decode_image_bytes(
    bytes: &[u8],
    mime_hint: Option<&str>,
    original_filename_hint: Option<&str>,
) -> Result<DynamicImage, String> {
    let slice = strip_utf8_bom(bytes);
    if slice.is_empty() {
        return Err("empty media file".to_string());
    }

    if let Ok(fmt) = image::guess_format(slice) {
        if let Ok(img) = decode_explicit(slice, fmt) {
            return Ok(img);
        }
    }

    // Leading wrapper bytes (some imports / tools prepend data; vault files have no extension).
    let max_skip = slice.len().min(512);
    for i in 1..max_skip {
        let sub = &slice[i..];
        if sub.len() < 12 {
            break;
        }
        if let Ok(fmt) = image::guess_format(sub) {
            if let Ok(img) = decode_explicit(sub, fmt) {
                return Ok(img);
            }
        }
    }

    if let Some(img) = try_decode_after_magic_scan(slice) {
        return Ok(img);
    }

    if let Some(fmt) = mime_hint.and_then(format_from_mime) {
        if let Ok(img) = decode_explicit(slice, fmt) {
            return Ok(img);
        }
    }

    if let Some(fmt) = original_filename_hint.and_then(format_from_filename) {
        if let Ok(img) = decode_explicit(slice, fmt) {
            return Ok(img);
        }
    }

    Err("The image format could not be determined".to_string())
}

/// Extract dominant colors from an on-disk media file (vault paths are extensionless UUIDs).
/// Use `mime_hint` / `original_filename_hint` from the DB when magic-byte sniffing is ambiguous.
pub fn extract_palette_from_image(
    path: &Path,
    mime_hint: Option<&str>,
    original_filename_hint: Option<&str>,
) -> Result<Palette, String> {
    use color_thief::ColorFormat;

    let bytes = std::fs::read(path).map_err(|e| format!("read media: {e}"))?;
    let img = decode_image_bytes(&bytes, mime_hint, original_filename_hint)?;
    let rgb = img.to_rgb8();
    let raw = rgb.as_raw();

    // color_thief can fail on some dimensions/settings; try a short ladder of parameters.
    let colors = color_thief::get_palette(raw, ColorFormat::Rgb, 5, 10)
        .or_else(|_| color_thief::get_palette(raw, ColorFormat::Rgb, 5, 5))
        .or_else(|_| color_thief::get_palette(raw, ColorFormat::Rgb, 3, 5))
        .map_err(|e| e.to_string())?;

    let lab_colors: Vec<[f32; 3]> = colors.iter().map(|c| rgb_to_lab(c.r, c.g, c.b)).collect();

    Ok(Palette { colors: lab_colors })
}

/// Euclidean distance in LAB space (approximate perceptual distance).
pub fn lab_distance(a: &[f32; 3], b: &[f32; 3]) -> f32 {
    let dl = a[0] - b[0];
    let da = a[1] - b[1];
    let db = a[2] - b[2];
    (dl * dl + da * da + db * db).sqrt()
}

/// Convert LAB distance to normalized similarity 0..1 (higher = more similar).
/// Threshold 0.6–0.7 corresponds to discarding weak matches.
pub fn distance_to_similarity(distance: f32) -> f32 {
    1.0 / (1.0 + distance / 25.0)
}

/// Dominant color overlap gate: true if top 1–2 colors are close enough.
/// Returns (passed, min_distance) — min_distance is the best LAB distance between top-2 pairs, or f32::MAX if none pass.
/// Used for dynamic threshold: weak overlap (min_dist near max_distance) → require stricter similarity.
pub fn dominant_color_overlap_with_distance(
    source: &Palette,
    other: &Palette,
    max_distance: f32,
) -> (bool, f32) {
    if source.colors.is_empty() || other.colors.is_empty() {
        return (false, f32::MAX);
    }
    let mut best = f32::MAX;
    let src_top: Vec<&[f32; 3]> = source.colors.iter().take(2).collect();
    let other_top: Vec<&[f32; 3]> = other.colors.iter().take(2).collect();
    for sc in &src_top {
        for oc in &other_top {
            let d = lab_distance(sc, oc);
            if d < best {
                best = d;
            }
        }
    }
    (best <= max_distance, best)
}

/// Convenience: dominant overlap gate returning bool only.
pub fn dominant_color_overlap(source: &Palette, other: &Palette, max_distance: f32) -> bool {
    dominant_color_overlap_with_distance(source, other, max_distance).0
}

/// Weighted contribution: for index i, returns 2.0 for top 2 dominant colors, 1.0 otherwise.
/// Dominant color mismatch hurts more; accent matches matter less.
fn dominant_weight(i: usize) -> f32 {
    if i < 2 {
        2.0
    } else {
        1.0
    }
}

/// Compare two palettes with dominant color weighting.
/// Top 2 colors count 2x — main color mismatch hurts more, fixes red false-positives.
pub fn palette_similarity_weighted(palette_a: &Palette, palette_b: &Palette) -> f32 {
    if palette_a.colors.is_empty() || palette_b.colors.is_empty() {
        return f32::MAX;
    }
    let a_dists: Vec<f32> = palette_a
        .colors
        .iter()
        .map(|ca| {
            palette_b
                .colors
                .iter()
                .map(|cb| lab_distance(ca, cb))
                .fold(f32::MAX, f32::min)
        })
        .collect();
    let b_dists: Vec<f32> = palette_b
        .colors
        .iter()
        .map(|cb| {
            palette_a
                .colors
                .iter()
                .map(|ca| lab_distance(ca, cb))
                .fold(f32::MAX, f32::min)
        })
        .collect();
    let a_weighted: f32 = a_dists
        .iter()
        .enumerate()
        .map(|(i, d)| dominant_weight(i) * d)
        .sum::<f32>();
    let b_weighted: f32 = b_dists
        .iter()
        .enumerate()
        .map(|(i, d)| dominant_weight(i) * d)
        .sum::<f32>();
    let a_wsum: f32 = (0..palette_a.colors.len()).map(dominant_weight).sum();
    let b_wsum: f32 = (0..palette_b.colors.len()).map(dominant_weight).sum();
    let a_avg = a_weighted / a_wsum;
    let b_avg = b_weighted / b_wsum;
    (a_avg + b_avg) / 2.0
}

/// Legacy: unweighted symmetric average.
pub fn palette_similarity(palette_a: &Palette, palette_b: &Palette) -> f32 {
    if palette_a.colors.is_empty() || palette_b.colors.is_empty() {
        return f32::MAX;
    }
    let a_to_b: f32 = palette_a
        .colors
        .iter()
        .map(|ca| {
            palette_b
                .colors
                .iter()
                .map(|cb| lab_distance(ca, cb))
                .fold(f32::MAX, f32::min)
        })
        .sum::<f32>()
        / palette_a.colors.len() as f32;
    let b_to_a: f32 = palette_b
        .colors
        .iter()
        .map(|cb| {
            palette_a
                .colors
                .iter()
                .map(|ca| lab_distance(ca, cb))
                .fold(f32::MAX, f32::min)
        })
        .sum::<f32>()
        / palette_b.colors.len() as f32;
    (a_to_b + b_to_a) / 2.0
}

/// Fraction of palette colors within `radius` LAB distance of the top (dominant) color.
/// High value (>0.6) = monochrome-heavy. Low value (<0.4) = multi-color.
pub fn dominant_hue_concentration(p: &Palette, radius: f32) -> f32 {
    if p.colors.is_empty() {
        return 0.0;
    }
    let top = &p.colors[0];
    let within = p
        .colors
        .iter()
        .filter(|c| lab_distance(c, top) <= radius)
        .count();
    within as f32 / p.colors.len() as f32
}

/// Average lightness (L) and standard deviation of L for a palette.
pub fn lightness_stats(p: &Palette) -> (f32, f32) {
    if p.colors.is_empty() {
        return (0.0, 0.0);
    }
    let n = p.colors.len() as f32;
    let avg: f32 = p.colors.iter().map(|c| c[0]).sum::<f32>() / n;
    let var: f32 = p
        .colors
        .iter()
        .map(|c| {
            let d = c[0] - avg;
            d * d
        })
        .sum::<f32>()
        / n;
    (avg, var.sqrt())
}
