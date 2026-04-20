fn main() {
    let profile = std::env::var("PROFILE").unwrap_or_default();
    let qooti = std::env::var("QOOTI_LICENSE_RESPONSE_SIGNING_SECRET")
        .ok()
        .filter(|s| !s.trim().is_empty());
    let worker_named = std::env::var("LICENSE_RESPONSE_SIGNING_SECRET")
        .ok()
        .filter(|s| !s.trim().is_empty());
    if profile == "release" && qooti.is_none() && worker_named.is_none() {
        println!(
            "cargo:warning=Release build without QOOTI_LICENSE_RESPONSE_SIGNING_SECRET or LICENSE_RESPONSE_SIGNING_SECRET — license activation will show \"not configured\" until you rebuild with the same secret as the Worker."
        );
    }
    tauri_build::build()
}
