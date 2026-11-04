# Leaf 1.0.5

[简体中文](RELEASE-NOTES.zh-CN.md) · **繁體中文** · [English](RELEASE-NOTES.md)

本修補版修正工具列換行遮擋提示，以及部分文案未隨介面語言切換的問題。詳見[變更記錄](../CHANGELOG.md)與 [Issue #125](https://github.com/CoozeeWang/leaf-markdown/issues/125)。

## 主要變更

- 文件標題與格式工具列換行時，狀態提示和關閉按鈕保持可見、可操作。
- 草稿復原與歷史版本視窗的標題、說明和主要按鈕隨介面語言切換，保留目前記錄選取、預覽及編輯狀態。
- AI 進階設定的代理輸入提示隨語言切換，保留輸入值與設定。

## 下載與升級

從 [GitHub Release](https://github.com/CoozeeWang/leaf-markdown/releases/tag/v1.0.5) 下載：

- `Leaf-1.0.5-macOS-arm64.dmg`：Apple Silicon Mac。
- `Leaf-1.0.5-windows-x64-setup.exe`：Windows x64。

發布頁同時提供 SHA256 校驗值、Minisign 分離簽章與建置來源。先儲存文件並正常結束 Leaf，再覆蓋安裝；Windows 若出現解除安裝選項，不勾選「刪除應用程式資料」。不要清空設定或 MCP 設定。更新仍透過瀏覽器下載並手動安裝，不會自動結束或重新啟動應用程式。

Mac 使用 ad-hoc 簽章，沒有 Developer ID 簽章或公證；Windows 沒有 Authenticode 簽章。下載簽章不等於系統發行者簽章。系統需求與首次開啟提示見[安裝指南](INSTALL.zh-TW.md)。

## 驗證範圍

維護者於2026年11月4日確認本批修正在 Mac 和 Windows 驗收通過；該次確認未逐項記錄 Windows 建置識別與語言組合。本機446項單元測試與9套定向瀏覽器回歸通過，主要版面和動態翻譯檢查涵蓋 Chromium／WebKit。最終安裝套件檢查與建置來源見發布頁；本批修正驗收不代表所有系統版本均已驗證。

[使用說明](INSTALL.zh-TW.md) · [AI / MCP 連線](AI_CONNECTIONS.zh-TW.md) · [支持 Leaf](SUPPORT.md)
