[简体中文](AI_CONNECTIONS.zh-CN.md) · [繁體中文](AI_CONNECTIONS.zh-TW.md) · **English**

# AI-assisted editing and MCP connections

Connect through MCP to let AI read, edit, and review documents in Leaf. This guide helps you set up the connection and use AI in your everyday writing.

Leaf currently supports **ChatGPT, Claude Desktop, and WorkBuddy** for AI-assisted editing and review through MCP. Set up the MCP connection for your chosen app before use.

## Let AI help you connect

**Use Leaf from the AI app you already know.** You do not need to configure a separate model API for Leaf or use coding tools such as Codex or Claude Code. Once connected, use your chosen AI app and account to request changes in conversation.

MCP connects Leaf to your AI app. You do not need to understand its technical details. You can give this guide to AI and ask it to help:

> I want to connect Leaf to my AI app. Using this guide, first confirm my operating system and AI app, then walk me through setup. Tell me where to sign in, grant access, or enter keys when needed. Finally, read a sample document I have open in Leaf to confirm the connection. Do not edit it yet.

AI can guide you through the steps. An AI with computer-use capabilities may also help with parts of setup. Sign in, grant permissions, and enter keys yourself in the relevant interface; do not send keys in the conversation.

Your AI app's account permissions, subscription, and usage limits still apply. Connecting ChatGPT also requires a tunnel key to establish the connection. This is separate from configuring a model API for Leaf.

## Choose a connection

Open the Leaf desktop app, go to **Settings → AI-Assisted Editing**, enable **Enable MCP connection**, and select your AI app. Keep Leaf and the documents you want to work on open while using the connection.

| AI app | Connection method |
| --- | --- |
| ChatGPT | Uses an OpenAI tunnel. Requires a tunnel ID, the tunnel client, and a connection key. |
| Claude Desktop | Add an extension from Leaf and confirm installation in Claude. |
| WorkBuddy | Add a connection from Leaf, then enable it in WorkBuddy. |

Follow only the steps for the app you use. Each client's configuration is saved separately. Selecting a different app in Settings does not clear the other connections.

### ChatGPT

Leaf uses an OpenAI secure tunnel to connect ChatGPT to Leaf running on your computer. For initial setup, ask AI to help you follow the [OpenAI tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).

1. **Prepare a tunnel.** Open OpenAI's tunnel settings using the link in Leaf. Create or select a dedicated tunnel for Leaf and enter its Tunnel ID in Leaf. Check that it is linked to your intended ChatGPT workspace and that you have permission to create and use tunnels.
2. **Select the tunnel client.** Follow Leaf's download link to get the complete official `tunnel-client` package for your operating system and processor, then extract it. Select the extracted program in Leaf; on Windows, this is `tunnel-client.exe`. Keep the entire extracted folder in a permanent location.
3. **Enter the connection key.** Enter the Runtime API key in Leaf's connection-key field and save the configuration. This key is for the tunnel connection. Do not include it in chats, screenshots, or issue reports. The field clears after saving. When changing settings later, leave it blank to keep the saved key.
4. **Add Leaf in ChatGPT.** Keep MCP enabled in Leaf. Once the local service is ready, add a custom MCP server on ChatGPT's web plugin page, choose Tunnel as the connection method, and select the same tunnel. Set Authentication to **No authentication** for this Tunnel connection only; organization and workspace access permissions still apply. Follow the prompts to create and install it. See [ChatGPT custom MCP connection instructions](https://developers.openai.com/api/docs/guides/custom-mcp-server) for the entry point.
5. **Check that it can read.** In a ChatGPT conversation, use `@` to select the installed Leaf plugin and ask it to read a sample document already open in Leaf.

If your account does not show the relevant options, or the tunnel is missing from the list, check account permissions and workspace links first. Refer to OpenAI's current documentation for the interface and availability.

### Claude Desktop

1. Select Claude Desktop in Leaf and click **Add to Claude**.
2. Confirm installation of Leaf in the Claude extension installer that opens.
3. Keep Leaf open with MCP enabled. Select Leaf in a Claude conversation and ask it to read a sample document.

The normal installation flow does not require manually editing configuration files or installing Node or Python separately.

### WorkBuddy

1. Select WorkBuddy in Leaf, click **Add to WorkBuddy**, and confirm the connection.
2. Enable Leaf under **专家·技能·连接器 → 连接器 → 自定义连接器** in WorkBuddy. If the connection does not appear, restart WorkBuddy and check again.
3. Keep Leaf open with MCP enabled. Ask WorkBuddy directly to read a sample document; you do not need to select Leaf from the “+” menu.

Leaf backs up the existing configuration and preserves other connections and settings.

### Confirm the connection

Create a sample document in Leaf with just a few sentences, then ask AI:

> Read the sample document I have open through the Leaf connection and summarize it. Do not make changes.

The connection is confirmed when AI can read the current document through it. A saved configuration or a ready local service means setup has progressed; an actual read is still needed to confirm it works.

## Start writing and reviewing

Once connected, AI can read and organize your document, polish or revise the body, organize properties, edit footnotes and tables, add review comments, or revise the text based on existing comments. Say what you want done and whether you want suggestions or direct edits. If several documents are open, include the filename. Changes appear in Leaf so you can check them and keep editing.

### What AI can access

With MCP and the relevant client enabled, AI can access **documents currently open in Leaf, including unsaved content**. Relevant text is sent to the AI service you use. Decide whether to enable the connection based on the document and your needs.

Leaf's MCP connection does not let AI scan folders, read the recent-files list, or open other files on your computer by itself. Closing a document ends access to it through the connection. Turning off MCP stops all connection access, but does not recall content already sent to the AI service.

## Stay in control of edits

### View and end editing

When AI starts editing, Leaf displays an editing notice. That document is temporarily read-only, but you can still browse, scroll, and search it, or edit other documents that are not in use. Only one AI editing task can work on a document at a time.

To stop a task, click **End editing** in the notice. **Ending editing keeps changes already made and restores manual editing. It does not automatically undo changes.**

### Check, undo, and save

After a task finishes, review its changes in Leaf. If you are not happy with them, a single undo reverses that AI task's changes. You can also make a more specific request.

Applied changes mean the document content has been updated; a saved status means it has been written to the file. Watch the save status. A new document without a save location still needs to be saved as a file. For the difference between autosave and draft recovery, see [Installation and usage guide](INSTALL.md#open-and-save-documents).

### Read beside the conversation

AI apps that support a live reading panel can display a Leaf document beside the conversation. Ask AI to open the document's live reading view to check the body, properties, footnotes, and comments together.

This view is for reading; manual editing still happens in Leaf. Panel availability depends on the AI app. Ordinary file attachments and static previews do not update automatically when you edit in Leaf.

## Connection troubleshooting

| Situation | What to try first |
| --- | --- |
| AI cannot find the document | Check that Leaf is running, MCP and the relevant client are enabled, and the document is open. Then ask AI to read the current document list again. |
| Settings are saved, but AI still cannot read | Check that Leaf is installed and enabled in the AI app. For ChatGPT, also check that you selected the same tunnel and that workspace links and permissions are correct. |
| AI editing stops or the document is temporarily read-only | Check Leaf's notice and click End editing if needed. Review changes already made, then ask AI to read the current document again before continuing. |
| Changes have not been saved | Check the save notice. Choose a location for a new document. If there is a file conflict, preserve the current content and follow the prompt or save a separate copy. |
| Do connections need setting up again after an update? | An in-place update preserves persistent settings and app data when you use the same OS user account and installation location, without uninstalling Leaf or clearing its data folders. This does not cover changing users, migrating data, or moving the tunnel client directory. Temporary connections must be re-established, and external AI apps, including ChatGPT, may ask you to authorize MCP access again. |

### Disable or clear a connection

When you do not need AI assistance, turn off **Enable MCP connection**. The saved configuration remains. Any active editing task ends, and changes already made are kept.

If you no longer use a client, clear its connection configuration in its settings. Check which app is selected first. Other clients' settings and your documents are not deleted. Manage the Leaf plugin in your AI app, and tunnels and keys on the OpenAI platform, separately in those services.

If the problem persists, report it through [GitHub Issues](https://github.com/CoozeeWang/leaf-markdown/issues). Include your operating system, Leaf and AI app versions, steps taken, and error messages. Remove private document content and keys from screenshots.
