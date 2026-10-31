fn main() {
    if std::env::args().any(|arg| arg == "--diagnose-decklink") {
        match showpilot_desktop_lib::diagnose_decklink() {
            Ok(inventory) => println!("{inventory}"),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        return;
    }
    showpilot_desktop_lib::run();
}
