fn main() {
    println!("cargo:rerun-if-changed=native");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .cpp(true)
            .flag("-std=c++17")
            .flag("-fobjc-arc")
            .flag("-mmacosx-version-min=11.0")
            .file("native/confidence_output.mm")
            .include("native")
            .compile("showpilot_confidence_output");
        cc::Build::new()
            .cpp(true)
            .flag("-std=c++17")
            .flag("-mmacosx-version-min=11.0")
            .file("native/decklink-sdk/DeckLinkAPIDispatch.cpp")
            .compile("showpilot_decklink_dispatch");
        println!("cargo:rustc-link-arg=-Wl,-weak_framework,ScreenCaptureKit");
        for framework in [
            "AppKit",
            "Foundation",
            "CoreFoundation",
            "CoreGraphics",
            "CoreMedia",
            "CoreVideo",
        ] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
    }
    tauri_build::build()
}
