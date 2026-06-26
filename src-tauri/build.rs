fn main() {
    // tauri_build::build() 会调用 Windows 资源编译器 (rc.exe) 将应用图标和 manifest
    // 嵌入最终可执行文件。在 Windows 上，embed-resource crate 通过 std::process
    // 调用 rc.exe 时，可能因管道竞态条件 panic（Os { code: 0, "操作成功完成"）——
    // rc.exe 实际执行成功，但 Rust 标准库在读取退出状态时误判为错误。
    //
    // RC 步骤仅对最终可执行文件有意义，单元测试不需要。这里用 catch_unwind 捕获
    // 该 panic，使 `cargo test` 能正常运行。若 panic 发生，打印告警并继续编译。
    if std::panic::catch_unwind(tauri_build::build).is_err() {
        println!(
            "cargo:warning=tauri_build::build() panicked (likely Windows RC compiler pipe race); \
             skipping resource compilation — tests will still run"
        );
    }
}
