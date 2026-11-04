use std::net::SocketAddr;
use std::sync::Arc;

#[tokio::main]
async fn main() {
    let cfg = atp_server::Config::from_env();
    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8080);
    let st = atp_server::AppState::new(cfg, Arc::new(|line: &str| eprintln!("{line}")));
    tokio::spawn(atp_server::pack::ensure(st.clone()));
    let app = atp_server::app(st);
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await.expect("bind");
    eprintln!("AI Town Planner web server on :{port}");
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .expect("server");
}
