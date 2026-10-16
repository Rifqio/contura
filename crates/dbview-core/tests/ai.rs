use dbview_core::Error;
use dbview_core::ai::{
    AiError, AiProvider, AiProviderKind, AiRequest, AiService, AiSettings, KeyChange, Placeholder,
};
use dbview_core::model::ConnectionConfig;
use dbview_core::secrets::{MemorySecretStore, SecretStore};
use dbview_core::store::AppStore;
use std::sync::Arc;
use uuid::Uuid;

fn service() -> (tempfile::TempDir, Arc<MemorySecretStore>, AiService) {
    let dir = tempfile::tempdir().unwrap();
    let store = AppStore::open(&dir.path().join("app.sqlite")).unwrap();
    let secrets = Arc::new(MemorySecretStore::new());
    let svc = AiService::new(store, secrets.clone());
    (dir, secrets, svc)
}

fn groq() -> AiSettings {
    AiSettings {
        provider: Some(AiProviderKind::Groq),
        model: "llama-3.3-70b-versatile".into(),
        ..AiSettings::default()
    }
}

fn request() -> AiRequest {
    AiRequest {
        question: "why".into(),
        payload: String::new(),
    }
}

#[test]
fn settings_round_trip_with_defaults() {
    let (_dir, _secrets, svc) = service();
    let view = svc.settings(None).unwrap();
    assert_eq!(view.settings.provider, None);
    assert!(view.settings.inline_ask);
    assert!(view.settings.error_ask);
    assert!(!view.group_override);
    assert!(!view.key_saved);

    let mut saved = groq();
    saved.temperature = Some(0.2);
    saved.max_tokens = Some(1024);
    saved.inline_ask = false;
    svc.save_settings(None, saved.clone(), false, KeyChange::Keep)
        .unwrap();
    assert_eq!(svc.settings(None).unwrap().settings, saved);
}

#[test]
fn settings_view_never_returns_the_key() {
    let (_dir, _secrets, svc) = service();
    svc.save_settings(
        None,
        groq(),
        false,
        KeyChange::Set {
            value: "gsk_abcd1234wxyz".into(),
        },
    )
    .unwrap();
    let view = svc.settings(None).unwrap();
    assert!(view.key_saved);
    let json = serde_json::to_string(&view).unwrap();
    assert!(json.contains(r#""keyLast4":"wxyz""#), "{json}");
    assert!(!json.contains("gsk_abcd"), "{json}");
}

#[test]
fn key_keep_and_clear() {
    let (_dir, secrets, svc) = service();
    svc.save_settings(
        None,
        groq(),
        false,
        KeyChange::Set {
            value: "gsk_abcd1234wxyz".into(),
        },
    )
    .unwrap();
    assert_eq!(
        secrets.get_named("AI/groq").unwrap().as_deref(),
        Some("gsk_abcd1234wxyz")
    );
    svc.save_settings(None, groq(), false, KeyChange::Keep)
        .unwrap();
    assert_eq!(
        secrets.get_named("AI/groq").unwrap().as_deref(),
        Some("gsk_abcd1234wxyz")
    );
    svc.save_settings(None, groq(), false, KeyChange::Clear)
        .unwrap();
    assert_eq!(secrets.get_named("AI/groq").unwrap(), None);
    assert!(!svc.settings(None).unwrap().key_saved);
}

#[test]
fn key_needs_a_provider_and_text() {
    let (_dir, _secrets, svc) = service();
    let no_provider = svc.save_settings(
        None,
        AiSettings::default(),
        false,
        KeyChange::Set { value: "k".into() },
    );
    assert!(matches!(no_provider, Err(Error::InvalidInput(_))));
    let blank = svc.save_settings(None, groq(), false, KeyChange::Set { value: "  ".into() });
    assert!(matches!(blank, Err(Error::InvalidInput(_))));
}

#[test]
fn group_override_falls_back_to_global() {
    let (_dir, _secrets, svc) = service();
    let group = Uuid::new_v4();
    svc.save_settings(None, groq(), false, KeyChange::Keep)
        .unwrap();

    let view = svc.settings(Some(group)).unwrap();
    assert!(!view.group_override);
    assert_eq!(view.settings.provider, Some(AiProviderKind::Groq));

    let own = AiSettings {
        provider: Some(AiProviderKind::Anthropic),
        ..AiSettings::default()
    };
    svc.save_settings(Some(group), own, true, KeyChange::Keep)
        .unwrap();
    let view = svc.settings(Some(group)).unwrap();
    assert!(view.group_override);
    assert_eq!(view.settings.provider, Some(AiProviderKind::Anthropic));
    // The global settings and other Groups are untouched.
    assert_eq!(
        svc.settings(None).unwrap().settings.provider,
        Some(AiProviderKind::Groq)
    );
    assert!(!svc.settings(Some(Uuid::new_v4())).unwrap().group_override);

    svc.save_settings(Some(group), groq(), false, KeyChange::Keep)
        .unwrap();
    let view = svc.settings(Some(group)).unwrap();
    assert!(!view.group_override);
    assert_eq!(view.settings.provider, Some(AiProviderKind::Groq));
}

#[test]
fn placeholder_reports_its_state() {
    let none = Placeholder { configured: None };
    assert!(matches!(
        none.ask(&request()),
        Err(Error::Ai(AiError::NotConfigured))
    ));
    assert!(matches!(
        none.test(),
        Err(Error::Ai(AiError::NotConfigured))
    ));

    let set = Placeholder {
        configured: Some(AiProviderKind::Groq),
    };
    assert!(matches!(
        set.ask(&request()),
        Err(Error::Ai(AiError::NotAvailable {
            provider: AiProviderKind::Groq
        }))
    ));
    assert!(matches!(
        set.test(),
        Err(Error::Ai(AiError::NotAvailable {
            provider: AiProviderKind::Groq
        }))
    ));
}

#[test]
fn service_asks_through_the_placeholder_by_saved_state() {
    let (_dir, _secrets, svc) = service();
    assert!(matches!(
        svc.ask(None, &request()),
        Err(Error::Ai(AiError::NotConfigured))
    ));
    svc.save_settings(None, groq(), false, KeyChange::Keep)
        .unwrap();
    assert!(matches!(
        svc.test(None),
        Err(Error::Ai(AiError::NotAvailable {
            provider: AiProviderKind::Groq
        }))
    ));
}

#[test]
fn connections_default_to_schema_access() {
    let json = r#"{"id":"6f2c0b1e-7a7e-4c8e-9a4b-1f0d6e2a9c11","name":"old","dialect":"mysql",
        "host":"h","port":3306,"user":"u","database":null,"ssl":{"mode":"disable"},"groupId":null}"#;
    let c: ConnectionConfig = serde_json::from_str(json).unwrap();
    assert_eq!(c.ai_access, dbview_core::ai::AiAccess::Schema);
    let out = serde_json::to_value(&c).unwrap();
    assert_eq!(out["aiAccess"], "schema");
}
