use tauri::Manager;

#[tauri::command]
async fn get_cobalt_token() -> Result<String, String> {
    let client = reqwest::Client::new();

    let instance_res = client
        .get("https://cobalt-api.meowing.de/")
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let instance_data: serde_json::Value = instance_res
        .json()
        .await
        .map_err(|e| e.to_string())?;

    let sitekey = instance_data["cobalt"]["turnstileSitekey"]
        .as_str()
        .ok_or("No turnstileSitekey in Cobalt response")?
        .to_string();

    let session_res = client
        .post("https://cobalt-api.meowing.de/session")
        .header("Accept", "application/json")
        .header("cf-turnstile-response", &sitekey)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let session_data: serde_json::Value = session_res
        .json()
        .await
        .map_err(|e| e.to_string())?;

    session_data["token"]
        .as_str()
        .map(|t| t.to_string())
        .ok_or_else(|| "Cobalt session did not return a token".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![get_cobalt_token])
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
                #[cfg(dev)]
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
