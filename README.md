# NexMail

A Windows desktop email client for IMAP and SMTP. Manage multiple accounts, read and compose messages, and organize mail with folders, categories and rules.

## Get started

1. Download the Windows installer from [Releases](../../releases).
2. In NexMail, open account settings and add your first email account. Use your provider's IMAP and SMTP settings. Some providers require an app password.
3. Open Inbox to verify that messages load. Send a test message to an address you control.

NexMail keeps its account configuration and message state in your Windows profile. The desktop window authenticates to an in-process local service. Nex Remote is not required.

## Build

```powershell
npm ci
npm test
npm run dist
```

The installer is written to `dist/nex-mail-install.exe`.

## License

[MIT](LICENSE). Electron and other bundled components retain their own licenses.
