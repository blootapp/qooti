// Color palette extraction and Find Similar
// Stores LAB colors for perceptual similarity

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

/// Extract dominant colors from an image file. Returns LAB colors.
pub fn extract_palette_from_image(path: &Path) -> Result<Palette, String> {
    use color_thief::ColorFormat;

    let img = image::open(path).map_err(|e| e.to_string())?;
    let rgb = img.to_rgb8();

    let colors = color_thief::get_palette(rgb.as_raw(), ColorFormat::Rgb, 5, 10)
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
