//! Explicit opt-in probe of the real OS store. Uses only disposable credentials.
//! cargo test --manifest-path packages/native-credentials/Cargo.toml --test system_vault -- --ignored
use serde_json::{json, Value};
use std::{fs, path::Path};

struct FixtureEntries {
    service: String,
    references: Vec<String>,
}

impl FixtureEntries {
    fn remember(&mut self, path: &Path) -> String {
        let value: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        let reference = value["credentialReference"].as_str().unwrap().to_owned();
        self.references.push(reference.clone());
        reference
    }
}

impl Drop for FixtureEntries {
    fn drop(&mut self) {
        for reference in &self.references {
            if let Ok(entry) = keyring::Entry::new(&self.service, reference) {
                let _ = entry.delete_credential();
            }
        }
    }
}

#[test]
#[ignore = "Uses an unlocked OS credential store; creates and removes isolated fixture entries"]
fn real_vault_round_trip_rotation_and_legacy_migration() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("bridge.json");
    let mut entries = FixtureEntries {
        service: format!(
            "tech.showpilot.credentials.fixture.{}",
            uuid::Uuid::new_v4()
        ),
        references: Vec::new(),
    };
    let first_key = format!("sp_{}", uuid::Uuid::new_v4());
    let mut config =
        json!({ "server": "https://fixture.invalid", "org": "fixture", "key": first_key });
    showpilot_native_credentials::save(&path, &entries.service, &config).unwrap();
    let first_reference = entries.remember(&path);
    assert!(!fs::read_to_string(&path).unwrap().contains(&first_key));
    let loaded = showpilot_native_credentials::load::<Value>(&path, &entries.service)
        .unwrap()
        .unwrap();
    for field in ["key", "server", "org"] {
        assert_eq!(loaded[field], config[field]);
    }

    let second_key = format!("sp_{}", uuid::Uuid::new_v4());
    config["key"] = json!(second_key);
    showpilot_native_credentials::save(&path, &entries.service, &config).unwrap();
    let second_reference = entries.remember(&path);
    assert_ne!(first_reference, second_reference);
    assert!(matches!(
        keyring::Entry::new(&entries.service, &first_reference)
            .unwrap()
            .get_password(),
        Err(keyring::Error::NoEntry)
    ));
    assert!(!fs::read_to_string(&path).unwrap().contains(&second_key));
    let loaded = showpilot_native_credentials::load::<Value>(&path, &entries.service)
        .unwrap()
        .unwrap();
    assert_eq!(loaded["key"], second_key);

    let legacy_path = directory.path().join("legacy.json");
    fs::write(&legacy_path, serde_json::to_vec(&config).unwrap()).unwrap();
    let migrated = showpilot_native_credentials::load::<Value>(&legacy_path, &entries.service)
        .unwrap()
        .unwrap();
    let legacy_reference = entries.remember(&legacy_path);
    assert_eq!(migrated["key"], second_key);
    assert!(!fs::read_to_string(&legacy_path)
        .unwrap()
        .contains(&second_key));
    assert_ne!(legacy_reference, second_reference);
    assert_eq!(
        showpilot_native_credentials::load::<Value>(&legacy_path, &entries.service)
            .unwrap()
            .unwrap()["key"],
        second_key
    );
}
