//! Bridge configuration contains only a reference to an OS-protected credential.
//! Never fall back to plaintext when the OS credential store is unavailable.
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use std::{fs, io::Write, path::Path, sync::Mutex};

const STORE_ERROR: &str =
    "Secure credential storage is unavailable. Unlock your system keychain and try again.";
const CONFIG_ERROR: &str = "Unable to read or save Bridge configuration.";
const CREDENTIAL_FORMAT: &str = "showpilot-bridge-v1";
static ACCESS: Mutex<()> = Mutex::new(());

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Credentials {
    key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    propresenter_password: Option<String>,
}

fn valid_key(key: &str) -> bool {
    key.starts_with("sp_") && key.len() <= 256
}

trait Vault {
    fn get(&self, reference: &str) -> Result<String, String>;
    fn set(&self, reference: &str, secret: &str) -> Result<(), String>;
    fn delete(&self, reference: &str) -> Result<(), String>;
}

struct SystemVault<'a>(&'a str);
impl SystemVault<'_> {
    fn entry(&self, reference: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(self.0, reference).map_err(|_| STORE_ERROR.into())
    }
}
impl Vault for SystemVault<'_> {
    fn get(&self, reference: &str) -> Result<String, String> {
        self.entry(reference)?
            .get_password()
            .map_err(|_| STORE_ERROR.into())
    }
    fn set(&self, reference: &str, secret: &str) -> Result<(), String> {
        self.entry(reference)?
            .set_password(secret)
            .map_err(|_| STORE_ERROR.into())
    }
    fn delete(&self, reference: &str) -> Result<(), String> {
        self.entry(reference)?
            .delete_credential()
            .map_err(|_| STORE_ERROR.into())
    }
}

fn read_json(path: &Path) -> Result<Option<Value>, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| CONFIG_ERROR.into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(CONFIG_ERROR.into()),
    }
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    let parent = path.parent().ok_or(CONFIG_ERROR)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|_| CONFIG_ERROR)?;
    let payload = serde_json::to_vec_pretty(value).map_err(|_| CONFIG_ERROR)?;
    // NamedTempFile creates a private file. Only sanitized configuration enters it.
    temporary.write_all(&payload).map_err(|_| CONFIG_ERROR)?;
    temporary.as_file().sync_all().map_err(|_| CONFIG_ERROR)?;
    temporary.persist(path).map_err(|_| CONFIG_ERROR)?;
    Ok(())
}

fn save_inner(path: &Path, mut value: Value, vault: &impl Vault) -> Result<(), String> {
    let object = value.as_object_mut().ok_or(CONFIG_ERROR)?;
    let secret = object
        .remove("key")
        .and_then(|key| key.as_str().map(str::to_owned))
        .filter(|key| valid_key(key))
        .ok_or("A valid Bridge installation key is required.")?;
    let password = match object.remove("propresenterPassword") {
        None | Some(Value::Null) => None,
        Some(Value::String(password)) => Some(password),
        Some(_) => return Err(CONFIG_ERROR.into()),
    };
    let secrets = serde_json::to_string(&Credentials {
        key: secret,
        propresenter_password: password,
    })
    .map_err(|_| CONFIG_ERROR)?;
    let old_reference = read_json(path)?
        .and_then(|old| old.get("credentialReference")?.as_str().map(str::to_owned));
    // A fresh entry keeps the previous configuration usable if saving the file fails.
    let reference = uuid::Uuid::new_v4().to_string();
    vault.set(&reference, &secrets)?;
    object.insert(
        "credentialFormat".into(),
        Value::String(CREDENTIAL_FORMAT.into()),
    );
    object.insert(
        "credentialReference".into(),
        Value::String(reference.clone()),
    );
    if let Err(error) = write_json(path, &value) {
        let _ = vault.delete(&reference);
        return Err(error);
    }
    if let Some(previous) = old_reference {
        // An orphaned encrypted entry is harmless. Never roll back a committed config.
        let _ = vault.delete(&previous);
    }
    Ok(())
}

fn load_inner(path: &Path, vault: &impl Vault) -> Result<Option<Value>, String> {
    let Some(mut value) = read_json(path)? else {
        return Ok(None);
    };
    if value.get("credentialFormat").is_some()
        && (value.get("key").is_some() || value.get("propresenterPassword").is_some())
    {
        return Err(CONFIG_ERROR.into());
    }
    if value
        .get("key")
        .and_then(Value::as_str)
        .is_some_and(|key| !key.is_empty())
    {
        // Legacy migration is repeatable. The plaintext file survives a failed vault write.
        save_inner(path, value.clone(), vault)?;
        return Ok(Some(value));
    }
    let reference = value
        .get("credentialReference")
        .and_then(Value::as_str)
        .ok_or(CONFIG_ERROR)?;
    let stored = vault.get(reference)?;
    let legacy = value.get("credentialFormat").is_none();
    let credentials = if legacy {
        Credentials {
            key: stored,
            propresenter_password: None,
        }
    } else {
        if value.get("credentialFormat").and_then(Value::as_str) != Some(CREDENTIAL_FORMAT) {
            return Err(CONFIG_ERROR.into());
        }
        serde_json::from_str::<Credentials>(&stored).map_err(|_| CONFIG_ERROR)?
    };
    if !valid_key(&credentials.key) {
        return Err(CONFIG_ERROR.into());
    }
    let object = value.as_object_mut().ok_or(CONFIG_ERROR)?;
    let had_plaintext_password = object.contains_key("propresenterPassword");
    // Modern files cannot override the vault password with a plaintext field.
    if !legacy && had_plaintext_password {
        return Err(CONFIG_ERROR.into());
    }
    object.insert("key".into(), Value::String(credentials.key));
    if let Some(password) = credentials.propresenter_password {
        object.insert("propresenterPassword".into(), Value::String(password));
    }
    if legacy {
        save_inner(path, value.clone(), vault)?;
    }
    Ok(Some(value))
}

/// Returns the secret to the native process only. Redact before returning through IPC.
pub fn load<T: DeserializeOwned>(path: &Path, service: &str) -> Result<Option<T>, String> {
    let _guard = ACCESS.lock().map_err(|_| STORE_ERROR)?;
    load_inner(path, &SystemVault(service))?
        .map(|value| serde_json::from_value(value).map_err(|_| CONFIG_ERROR.into()))
        .transpose()
}

pub fn save<T: Serialize>(path: &Path, service: &str, config: &T) -> Result<(), String> {
    let _guard = ACCESS.lock().map_err(|_| STORE_ERROR)?;
    let value = serde_json::to_value(config).map_err(|_| CONFIG_ERROR)?;
    save_inner(path, value, &SystemVault(service))
}

/// Blank input can reuse a saved key only for the same site and organization.
pub fn reuse_key(
    site: &str,
    org: &str,
    key: &mut String,
    saved: Option<(&str, &str, &str)>,
) -> Result<(), String> {
    if key.is_empty() {
        let (saved_site, saved_org, saved_key) =
            saved.ok_or("Create a Bridge installation key in Settings first.")?;
        if site.trim().trim_end_matches('/') != saved_site.trim().trim_end_matches('/')
            || org.trim() != saved_org.trim()
        {
            return Err("This site or organization needs its own Bridge installation key.".into());
        }
        *key = saved_key.to_owned();
    }
    Ok(())
}

pub fn redact(line: &str, key: &str) -> String {
    if key.is_empty() {
        line.to_owned()
    } else {
        line.replace(key, "[redacted]")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{cell::RefCell, collections::HashMap};

    #[derive(Default)]
    struct TestVault {
        entries: RefCell<HashMap<String, String>>,
        fail: bool,
    }
    impl Vault for TestVault {
        fn get(&self, reference: &str) -> Result<String, String> {
            self.entries
                .borrow()
                .get(reference)
                .cloned()
                .ok_or(STORE_ERROR.into())
        }
        fn set(&self, reference: &str, secret: &str) -> Result<(), String> {
            if self.fail {
                return Err(STORE_ERROR.into());
            }
            self.entries
                .borrow_mut()
                .insert(reference.into(), secret.into());
            Ok(())
        }
        fn delete(&self, reference: &str) -> Result<(), String> {
            self.entries.borrow_mut().remove(reference);
            Ok(())
        }
    }
    fn config(key: &str) -> Value {
        json!({"site":"https://app.example", "org":"venue", "key":key})
    }

    #[test]
    fn saves_without_plaintext_and_restores_after_restart() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.json");
        let vault = TestVault::default();
        let value = config("sp_test_secret");
        save_inner(&path, value.clone(), &vault).unwrap();
        let disk = fs::read_to_string(&path).unwrap();
        assert!(!disk.contains("sp_test_secret"));
        assert!(!disk.contains("\"key\""));
        let loaded = load_inner(&path, &vault).unwrap().unwrap();
        assert_eq!(loaded["key"], value["key"]);
        save_inner(&path, config("sp_rotated_secret"), &vault).unwrap();
        assert_eq!(vault.entries.borrow().len(), 1);
        assert_eq!(
            load_inner(&path, &vault).unwrap().unwrap()["key"],
            "sp_rotated_secret"
        );
    }

    #[test]
    fn migrates_legacy_plaintext_once_and_keeps_all_configuration() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.json");
        let vault = TestVault::default();
        let mut legacy = config("sp_legacy");
        legacy["midiInputName"] = json!("USB MIDI");
        fs::write(&path, legacy.to_string()).unwrap();
        assert_eq!(load_inner(&path, &vault).unwrap(), Some(legacy));
        assert!(!fs::read_to_string(&path).unwrap().contains("sp_legacy"));
        let migrated = fs::read(&path).unwrap();
        assert_eq!(
            load_inner(&path, &vault).unwrap().unwrap()["midiInputName"],
            "USB MIDI"
        );
        assert_eq!(fs::read(&path).unwrap(), migrated);
        assert_eq!(vault.entries.borrow().len(), 1);
    }

    #[test]
    fn failed_vault_write_preserves_original_and_never_falls_back() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.json");
        let legacy = config("sp_legacy").to_string();
        fs::write(&path, &legacy).unwrap();
        let vault = TestVault {
            fail: true,
            ..Default::default()
        };
        assert!(load_inner(&path, &vault).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), legacy);
        assert!(save_inner(&path, config("sp_new"), &vault).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), legacy);
    }

    #[test]
    fn failed_config_write_removes_only_the_new_vault_entry() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("missing/config.json");
        let vault = TestVault::default();
        vault.set("previous", "sp_previous").unwrap();
        assert!(save_inner(&path, config("sp_new"), &vault).is_err());
        assert_eq!(vault.entries.borrow().len(), 1);
        assert_eq!(vault.get("previous").unwrap(), "sp_previous");
    }

    #[test]
    fn unavailable_saved_credential_fails_closed() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.json");
        fs::write(&path, json!({"credentialReference":"missing"}).to_string()).unwrap();
        assert!(load_inner(&path, &TestVault::default()).is_err());
    }

    #[test]
    fn passwords_live_only_in_the_vault_and_can_be_replaced_or_cleared() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.json");
        let vault = TestVault::default();
        let mut value = config("sp_test_secret");
        for password in [
            Some("stage-秘密\nquoted\""),
            Some("replacement"),
            Some(""),
            None,
        ] {
            value
                .as_object_mut()
                .unwrap()
                .remove("propresenterPassword");
            if let Some(password) = password {
                value["propresenterPassword"] = json!(password);
            }
            save_inner(&path, value.clone(), &vault).unwrap();
            let disk = read_json(&path).unwrap().unwrap();
            assert!(disk.get("key").is_none());
            assert!(disk.get("propresenterPassword").is_none());
            assert_eq!(disk["credentialFormat"], CREDENTIAL_FORMAT);
            let loaded = load_inner(&path, &vault).unwrap().unwrap();
            assert_eq!(
                loaded.get("propresenterPassword"),
                value.get("propresenterPassword")
            );
            assert_eq!(loaded["key"], value["key"]);
            assert_eq!(vault.entries.borrow().len(), 1);
        }
    }

    #[test]
    fn migrates_key_only_vault_with_plaintext_password_exactly_once() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.json");
        let vault = TestVault::default();
        vault.set("old-key", "sp_old").unwrap();
        let original = json!({"credentialReference":"old-key", "propresenterPassword":"legacy-stage", "midiInputName":"USB"});
        fs::write(&path, original.to_string()).unwrap();
        let loaded = load_inner(&path, &vault).unwrap().unwrap();
        assert_eq!(loaded["key"], "sp_old");
        assert_eq!(loaded["propresenterPassword"], "legacy-stage");
        assert_eq!(loaded["midiInputName"], "USB");
        assert!(vault.get("old-key").is_err());
        let disk = fs::read_to_string(&path).unwrap();
        assert!(!disk.contains("legacy-stage"));
        assert_eq!(
            load_inner(&path, &vault).unwrap().unwrap()["propresenterPassword"],
            "legacy-stage"
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), disk);
        assert_eq!(vault.entries.borrow().len(), 1);
    }

    #[test]
    fn failed_key_only_migration_preserves_old_file_and_vault_entry() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.json");
        let mut vault = TestVault::default();
        vault.set("old-key", "sp_old").unwrap();
        vault.fail = true;
        let original =
            json!({"credentialReference":"old-key", "propresenterPassword":"legacy-stage"})
                .to_string();
        fs::write(&path, &original).unwrap();
        assert!(load_inner(&path, &vault).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
        assert_eq!(vault.get("old-key").unwrap(), "sp_old");
    }

    #[test]
    fn malformed_or_downgraded_vault_payload_never_becomes_a_bridge_key() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.json");
        let vault = TestVault::default();
        let disk = json!({"credentialReference":"entry", "credentialFormat":CREDENTIAL_FORMAT});
        fs::write(&path, disk.to_string()).unwrap();
        for payload in [
            "sp_legacy",
            "{bad",
            r#"{"key":"invalid"}"#,
            r#"{"key":"sp_valid","propresenterPassword":42}"#,
            r#"{"key":"sp_valid","extra":"unknown"}"#,
        ] {
            vault.set("entry", payload).unwrap();
            assert!(load_inner(&path, &vault).is_err());
            assert_eq!(read_json(&path).unwrap().unwrap(), disk);
        }
        vault
            .set(
                "entry",
                r#"{"key":"sp_valid","propresenterPassword":"protected"}"#,
            )
            .unwrap();
        let mut injected = disk;
        injected["propresenterPassword"] = json!("plaintext-override");
        fs::write(&path, injected.to_string()).unwrap();
        assert!(load_inner(&path, &vault).is_err());
    }

    #[test]
    fn blank_key_reuse_is_scoped_to_site_and_org() {
        let mut key = String::new();
        let saved = Some(("https://app.example/", "venue", "sp_saved"));
        assert!(reuse_key("https://other.example", "venue", &mut key, saved).is_err());
        assert!(reuse_key("https://app.example", "other", &mut key, saved).is_err());
        reuse_key("https://app.example", "venue", &mut key, saved).unwrap();
        assert_eq!(key, "sp_saved");
        assert_eq!(
            redact("key=sp_saved and sp_saved", &key),
            "key=[redacted] and [redacted]"
        );
    }
}
