fn main() {
    // Etterna's MinaCalc (MSD, see minacalc/README.md), compiled in
    cc::Build::new()
        .cpp(true)
        .std("c++20")
        .warnings(false)
        .define("STANDALONE_CALC", None)
        .define("NDEBUG", None)
        .opt_level(2)
        .include("minacalc")
        .include("minacalc/MinaCalc")
        .file("minacalc/API.cpp")
        // the entry points Rust calls: MinaCalc behind a C++ try, so an exception from it never
        // reaches Rust (which would abort the whole app)
        .file("minacalc/Guarded.cpp")
        .file("minacalc/MinaCalc/MinaCalc.cpp")
        .compile("minacalc");
    println!("cargo:rerun-if-changed=minacalc");
    build_key();
    tauri_build::build()
}

/// Fumen's own builds carry its maker's build key (online.rs signs requests to fumen.dertesti.dev
/// with it): FUMEN_BUILD_KEY, or ~/.tauri/fumen-build.key on the maker's computer. It's never in
/// the repo; a Fumen built without it works, only not with the site's online features.
fn build_key() {
    println!("cargo:rerun-if-env-changed=FUMEN_BUILD_KEY");
    let from_env = std::env::var("FUMEN_BUILD_KEY").ok();
    let key = from_env.filter(|k| !k.trim().is_empty()).or_else(|| {
        let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
        let path = std::path::Path::new(&home).join(".tauri").join("fumen-build.key");
        // watched only while it's there (a missing file would rebuild everything every time)
        if path.exists() {
            println!("cargo:rerun-if-changed={}", path.display());
        }
        std::fs::read_to_string(path).ok()
    });
    if let Some(key) = key.map(|k| k.trim().to_string()).filter(|k| k.len() == 64 && k.bytes().all(|b| b.is_ascii_hexdigit())) {
        println!("cargo:rustc-env=FUMEN_BUILD_KEY={key}");
    }
}
