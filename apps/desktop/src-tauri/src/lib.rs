use tauri_plugin_shell::ShellExt;

#[tauri::command]
fn select_local_directory() -> Option<String> {
    rfd::FileDialog::new()
        .pick_folder()
        .map(|path| path.to_string_lossy().into_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .invoke_handler(tauri::generate_handler![select_local_directory])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // Spawning the volume-engine sidecar process
      let shell = app.shell();
      match shell.sidecar("volume-engine") {
        Ok(sidecar) => {
          match sidecar.spawn() {
            Ok((mut rx, _child)) => {
              println!("Successfully spawned volume-engine sidecar process!");
              tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                  match event {
                    tauri_plugin_shell::process::CommandEvent::Stdout(line) => {
                      let log_str = String::from_utf8_lossy(&line);
                      println!("sidecar stdout: {}", log_str.trim());
                    }
                    tauri_plugin_shell::process::CommandEvent::Stderr(line) => {
                      let log_str = String::from_utf8_lossy(&line);
                      eprintln!("sidecar stderr: {}", log_str.trim());
                    }
                    _ => {}
                  }
                }
              });
            }
            Err(e) => {
              eprintln!("Failed to spawn volume-engine sidecar child process: {:?}", e);
            }
          }
        }
        Err(e) => {
          eprintln!("Failed to locate volume-engine sidecar binary: {:?}", e);
        }
      }

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
