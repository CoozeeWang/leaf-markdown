# Leaf 1.0.4

[简体中文](RELEASE-NOTES.zh-CN.md) · **繁體中文** · [English](RELEASE-NOTES.md)

本版改善日常編輯、大綱整理與文字選取，並修正提示區塊、富文字拖放及 Windows 重複安裝的問題。完整變更見[變更記錄](../CHANGELOG.md)。

## 主要變更

- 拖動大綱標題可調整整章順序與層級，保留子章節、正文和摺疊狀態，並可一次復原。
- 修正提示區塊游標高度及重複閃爍；標題 Enter 進入正文，尾端空白一般段落 Enter 離開區塊。新建區塊的預留提示不寫入文件。
- 修正連續 AI 編輯工作導致提示列累積鎖頭圖示的問題。
- 富文字貼上保留有效的 Ripple 來源連結；Mac 外部文字拖放依落點插入，並可一次復原。區塊內貼上使用相同轉換。
- 減少長文與巢狀內容的重複解析，改善編輯焦點及文字選取；一般預覽隱藏合法跳脫標記，原始碼與程式碼內容不變。
- 統一輕量懸浮提示；文件名稱選單置中。Mac 使用「在 Finder 中顯示」，Windows 保留檔案總管文案。
- 三擊整行的反白不再延伸到下一行的縮排空白；整行選取仍包含換行符號，正常跨行選字不變。
- Windows 重複安裝時保留原有檔案關聯的還原資訊。

Leaf 將富文字轉換為 Markdown，不保證重現來源軟體的完整排版。應用程式來源連結限於支援的 Ripple 協定；貼上、拖放及儲存不會啟動其他應用程式。在編輯檢視按住 Mac ⌘／Windows Ctrl 點擊，或在閱讀檢視點擊，才要求開啟連結。

## 下載與升級

從 [GitHub Release](https://github.com/CoozeeWang/leaf-markdown/releases/tag/v1.0.4) 下載：

- `Leaf-1.0.4-macOS-arm64.dmg`：Apple Silicon Mac。
- `Leaf-1.0.4-windows-x64-setup.exe`：Windows x64。

發布頁同時提供 SHA256 校驗值、Minisign 分離簽章與建置來源。先儲存文件並正常結束 Leaf，再覆蓋安裝；Windows 若出現解除安裝選項，不勾選「刪除應用程式資料」。不要清空設定或 MCP 設定。更新仍透過瀏覽器下載並手動安裝，不會自動結束或重新啟動應用程式。

Mac 使用 ad-hoc 簽章，沒有 Developer ID 簽章或公證；Windows 沒有 Authenticode 簽章。下載簽章不等於系統發行者簽章。系統需求與首次開啟提示見[安裝指南](INSTALL.zh-TW.md)。

## 驗證範圍

本輪編輯修正已通過本機單元測試與 Chromium／WebKit 回歸。Mac 日用版已安裝；Windows 自動檢查、最終套件來源與校驗結果以發布頁列出的建置記錄為準。Windows 使用者實機驗收仍待進行，自動檢查不代表完成該項；相關 Issue 保留驗收狀態。

[使用說明](INSTALL.zh-TW.md) · [AI / MCP 連線](AI_CONNECTIONS.zh-TW.md) · [支持 Leaf](SUPPORT.md)
