/// Model CRUD commands (OS Keychain integration).
use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::repository;

use super::shared::{with_db, ModelDto, NewModelInput};

#[tauri::command]
pub async fn get_models(db: State<'_, Db>) -> Result<Vec<ModelDto>, AppError> {
    with_db!(db, |conn: &rusqlite::Connection| repository::get_models(
        conn
    ))
}

#[tauri::command]
pub async fn add_model(db: State<'_, Db>, model: NewModelInput) -> Result<i64, AppError> {
    with_db!(db, |conn: &mut rusqlite::Connection| repository::add_model(
        conn, &model
    ))
}

#[tauri::command]
pub async fn delete_model(db: State<'_, Db>, id: i64) -> Result<(), AppError> {
    with_db!(db, |conn: &rusqlite::Connection| repository::delete_model(
        conn, id
    ))
}

#[tauri::command]
pub async fn get_default_model(db: State<'_, Db>) -> Result<Option<ModelDto>, AppError> {
    with_db!(db, |conn: &rusqlite::Connection| {
        if let Some(m) = repository::get_default_model(conn)? {
            return Ok(Some(m));
        }
        repository::get_first_model(conn)
    })
}

#[tauri::command]
pub async fn set_default_model(db: State<'_, Db>, id: i64) -> Result<(), AppError> {
    with_db!(db, |conn: &rusqlite::Connection| {
        repository::set_default_model(conn, id)
    })
}

#[tauri::command]
pub async fn update_model(
    db: State<'_, Db>,
    id: i64,
    name: String,
    base_url: String,
    model_name: String,
    api_key: String,
    is_default: bool,
) -> Result<(), AppError> {
    with_db!(db, |conn: &mut rusqlite::Connection| {
        repository::update_model(
            conn,
            id,
            &name,
            &base_url,
            &model_name,
            &api_key,
            is_default,
        )
    })
}

/// P2-3: 单独获取模型 API Key（编辑模型时使用，列表接口不再返回密钥）
#[tauri::command]
pub async fn get_model_api_key(id: i64) -> Result<String, AppError> {
    repository::get_model_api_key(id)
}
